import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { attachments, libraries, songs } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { scopeId } from '../auth/permissions.js';
import { removeObject } from '../storage.js';
import { tagIdsInput, songTagIds, replaceSongTags, listTags, librarySongTagIds } from './tags.js';

const songInput = z.strictObject({
  title: z.string().trim().min(1).max(200),
  artist: z.string().trim().min(1).max(200),
  notes: z.string().max(10000).default(''),
  tagIds: tagIdsInput.optional(),
});
const patchInput = songInput
  .partial()
  .extend({ notes: z.string().max(10000).optional() })
  .refine((value) => Object.keys(value).length > 0);
const idParams = z.object({ id: z.string().uuid() });

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(
      400,
      'INVALID_REQUEST',
      result.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', '),
    );
  return result.data;
}

export function revision(request: FastifyRequest): number {
  const header = request.headers['if-match'];
  const raw = Array.isArray(header) ? undefined : header;
  const match = raw?.match(/^(?:"(\d+)"|(\d+))$/);
  if (!match)
    throw new ApiError(428, 'REVISION_REQUIRED', 'If-Match with a song revision is required');
  const value = Number(match[1] ?? match[2]);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new ApiError(400, 'INVALID_REVISION', 'Invalid song revision');
  return value;
}

export function songDto(song: typeof songs.$inferSelect, tagIds: string[] = []) {
  return {
    id: song.id,
    setlistId: song.libraryId,
    title: song.title,
    artist: song.artist,
    notes: song.notes,
    tagIds,
    revision: song.revision,
    createdAt: song.createdAt.toISOString(),
    updatedAt: song.updatedAt.toISOString(),
  };
}

export function registerSongRoutes(
  app: FastifyInstance,
  scoped = false,
  authorize?: (
    request: FastifyRequest,
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  ) => Promise<unknown>,
) {
  if (scoped) {
    app.get('/v1/setlists/:setlistId/songs', async (request) =>
      db.transaction(async (tx) => {
        await authorize?.(request, tx);
        const tagIds = await librarySongTagIds(tx, scopeId(request));
        const rows = await tx
          .select()
          .from(songs)
          .where(and(eq(songs.libraryId, scopeId(request)), isNull(songs.deletedAt)));
        return { songs: rows.map((song) => songDto(song, tagIds.get(song.id) ?? [])) };
      }),
    );
    app.get('/v1/setlists/:setlistId/songs/:id', async (request) =>
      db.transaction(async (tx) => {
        await authorize?.(request, tx);
        const { id } = parse(idParams, request.params);
        const [song] = await tx
          .select()
          .from(songs)
          .where(
            and(eq(songs.id, id), eq(songs.libraryId, scopeId(request)), isNull(songs.deletedAt)),
          );
        if (!song) throw new ApiError(404, 'SONG_NOT_FOUND', 'Song not found');
        return songDto(song, await songTagIds(tx, scopeId(request), song.id));
      }),
    );
  }
  app.post(scoped ? '/v1/setlists/:setlistId/songs' : '/v1/songs', async (request, reply) => {
    const body = parse(songInput, request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 1 || key.length > 200)
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
    // Empty tags preserve hashes written before tags existed. Nonempty IDs are canonical.
    const { tagIds = [], ...fields } = body;
    const hash = createHash('sha256')
      .update(JSON.stringify(tagIds.length ? { ...fields, tagIds } : fields))
      .digest('hex');
    const result = await db.transaction(async (tx) => {
      await authorize?.(request, tx);
      await tx.execute(sql`SELECT id FROM libraries WHERE id = ${scopeId(request)} FOR UPDATE`);
      const [existing] = await tx
        .select()
        .from(songs)
        .where(and(eq(songs.libraryId, scopeId(request)), eq(songs.createKey, key)))
        .limit(1);
      if (existing) {
        if (existing.createHash !== hash)
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Key already used with different data');
        return {
          song: existing,
          tagIds: await songTagIds(tx, scopeId(request), existing.id),
          replay: true,
        };
      }
      const [song] = await tx
        .insert(songs)
        .values({
          id: randomUUID(),
          libraryId: scopeId(request),
          ...fields,
          createKey: key,
          createHash: hash,
        })
        .returning();
      await tx
        .update(libraries)
        .set({ revision: sql`${libraries.revision} + 1`, updatedAt: new Date() })
        .where(eq(libraries.id, scopeId(request)));
      await replaceSongTags(tx, scopeId(request), song.id, tagIds);
      return { song, tagIds, replay: false };
    });
    reply.status(result.replay ? 200 : 201);
    return songDto(result.song, result.tagIds);
  });

  app.patch(scoped ? '/v1/setlists/:setlistId/songs/:id' : '/v1/songs/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const body = parse(patchInput, request.body);
    const { tagIds, ...fields } = body;
    const expected = revision(request);
    return db.transaction(async (tx) => {
      await authorize?.(request, tx);
      await tx.execute(sql`SELECT id FROM libraries WHERE id = ${scopeId(request)} FOR UPDATE`);
      const [current] = await tx
        .select()
        .from(songs)
        .where(
          and(eq(songs.id, id), eq(songs.libraryId, scopeId(request)), isNull(songs.deletedAt)),
        )
        .limit(1);
      if (!current) throw new ApiError(404, 'SONG_NOT_FOUND', 'Song not found');
      if (current.revision !== expected)
        throw new ApiError(409, 'REVISION_CONFLICT', 'Song revision changed', current.revision);
      const [updated] = await tx
        .update(songs)
        .set({ ...fields, revision: current.revision + 1, updatedAt: new Date() })
        .where(eq(songs.id, id))
        .returning();
      await tx
        .update(libraries)
        .set({ revision: sql`${libraries.revision} + 1`, updatedAt: new Date() })
        .where(eq(libraries.id, scopeId(request)));
      if (tagIds !== undefined) await replaceSongTags(tx, scopeId(request), id, tagIds);
      return songDto(updated, await songTagIds(tx, scopeId(request), id));
    });
  });

  app.delete(scoped ? '/v1/setlists/:setlistId/songs/:id' : '/v1/songs/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const expected = revision(request);
    const result = await db.transaction(async (tx) => {
      await authorize?.(request, tx);
      await tx.execute(sql`SELECT id FROM libraries WHERE id = ${scopeId(request)} FOR UPDATE`);
      const [current] = await tx
        .select()
        .from(songs)
        .where(
          and(eq(songs.id, id), eq(songs.libraryId, scopeId(request)), isNull(songs.deletedAt)),
        )
        .limit(1);
      if (!current) throw new ApiError(404, 'SONG_NOT_FOUND', 'Song not found');
      if (current.revision !== expected)
        throw new ApiError(409, 'REVISION_CONFLICT', 'Song revision changed', current.revision);
      const files = await tx
        .select({ objectKey: attachments.objectKey })
        .from(attachments)
        .where(and(eq(attachments.songId, id), isNull(attachments.deletedAt)));
      await tx
        .update(attachments)
        .set({ deletedAt: new Date() })
        .where(and(eq(attachments.songId, id), isNull(attachments.deletedAt)));
      await tx
        .update(songs)
        .set({ deletedAt: new Date(), revision: current.revision + 1, updatedAt: new Date() })
        .where(eq(songs.id, id));
      await tx
        .update(libraries)
        .set({ revision: sql`${libraries.revision} + 1`, updatedAt: new Date() })
        .where(eq(libraries.id, scopeId(request)));
      return files;
    });
    for (const file of result)
      await removeObject(file.objectKey).catch((error) =>
        app.log.error({ err: error }, 'object cleanup failed'),
      );
    return { id, deleted: true };
  });

  app.get(scoped ? '/v1/setlists/:setlistId/snapshot' : '/v1/library/snapshot', async (request) =>
    db.transaction(async (tx) => {
      const permission = await authorize?.(request, tx);
      const [library] = await tx
        .select()
        .from(libraries)
        .where(eq(libraries.id, scopeId(request)));
      const rows = await tx
        .select()
        .from(songs)
        .where(and(eq(songs.libraryId, scopeId(request)), isNull(songs.deletedAt)))
        .orderBy(songs.createdAt, songs.id);
      const files = await tx
        .select({ attachment: attachments, song: songs })
        .from(attachments)
        .innerJoin(songs, eq(attachments.songId, songs.id))
        .where(
          and(
            eq(attachments.libraryId, scopeId(request)),
            isNull(songs.deletedAt),
            isNull(attachments.deletedAt),
          ),
        )
        .orderBy(attachments.createdAt, attachments.id);
      const tagIds = await librarySongTagIds(tx, scopeId(request));
      return {
        ...(scoped
          ? {
              setlistId: scopeId(request),
              setlistRevision: library.revision,
              role: (permission as any)?.role,
            }
          : { libraryId: scopeId(request), libraryRevision: library.revision }),
        tags: await listTags(tx, scopeId(request)),
        songs: rows.map((song) => ({
          ...songDto(song, tagIds.get(song.id) ?? []),
          attachments: files
            .filter((row) => row.attachment.songId === song.id)
            .map(({ attachment }) => ({
              id: attachment.id,
              setlistId: attachment.libraryId,
              songId: attachment.songId,
              kind: attachment.kind,
              mimeType: attachment.mimeType,
              filename: attachment.filename,
              byteSize: attachment.byteSize,
              checksum: attachment.checksum,
              createdAt: attachment.createdAt.toISOString(),
              contentUrl: `/v1/setlists/${attachment.libraryId}/attachments/${attachment.id}/content`,
            })),
        })),
      };
    }),
  );
}
