import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { libraries, songs, songTags, tags } from '../db/schema.js';
import { scopeId } from '../auth/permissions.js';
import { ApiError } from '../errors.js';

export type TagTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const tagColorInput = z
  .string()
  .length(7)
  .regex(/^#[0-9a-f]{6}$/i)
  .transform((color) => color.toUpperCase())
  .nullable();
const createTagInput = z.strictObject({ name: z.string(), color: tagColorInput.optional() });
const updateTagInput = createTagInput.partial().refine((input) => Object.keys(input).length > 0);
export const tagIdsInput = z
  .array(
    z
      .string()
      .uuid()
      .transform((id) => id.toLowerCase()),
  )
  .transform((ids) => [...new Set(ids)].sort());
export function normalizeTagName(value: string) {
  const name = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if ([...name].length < 1 || [...name].length > 40)
    throw new ApiError(400, 'INVALID_REQUEST', 'Tag name must contain 1–40 characters');
  return { name, normalizedName: name.toLocaleLowerCase('ru-RU') };
}
export async function songTagIds(tx: TagTransaction, libraryId: string, songId: string) {
  return (
    await tx
      .select({ id: songTags.tagId })
      .from(songTags)
      .where(and(eq(songTags.libraryId, libraryId), eq(songTags.songId, songId)))
      .orderBy(songTags.tagId)
  ).map((row) => row.id);
}
export async function librarySongTagIds(tx: TagTransaction, libraryId: string) {
  const rows = await tx
    .select({ songId: songTags.songId, tagId: songTags.tagId })
    .from(songTags)
    .where(eq(songTags.libraryId, libraryId))
    .orderBy(songTags.tagId);
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const ids = result.get(row.songId) ?? [];
    ids.push(row.tagId);
    result.set(row.songId, ids);
  }
  return result;
}
export async function replaceSongTags(
  tx: TagTransaction,
  libraryId: string,
  songId: string,
  ids: string[],
) {
  if (ids.length) {
    const found = await tx
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.libraryId, libraryId), inArray(tags.id, ids)));
    if (found.length !== ids.length)
      throw new ApiError(400, 'INVALID_TAG_IDS', 'Tags must belong to this setlist');
  }
  await tx
    .delete(songTags)
    .where(and(eq(songTags.libraryId, libraryId), eq(songTags.songId, songId)));
  if (ids.length)
    await tx.insert(songTags).values(ids.map((tagId) => ({ libraryId, songId, tagId })));
}
export async function listTags(tx: TagTransaction, libraryId: string) {
  return tx
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(tags)
    .where(eq(tags.libraryId, libraryId))
    .orderBy(tags.normalizedName, tags.id);
}
function parseTagBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(400, 'INVALID_REQUEST', 'Expected tag name or #RRGGBB color');
  return result.data;
}
function tagId(request: FastifyRequest): string {
  const result = z.object({ id: z.string().uuid() }).safeParse(request.params);
  if (!result.success) throw new ApiError(400, 'INVALID_REQUEST', 'Invalid tag id');
  return result.data.id.toLowerCase();
}
async function requireTag(tx: TagTransaction, libraryId: string, id: string): Promise<void> {
  const [current] = await tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.id, id), eq(tags.libraryId, libraryId)));
  if (!current) throw new ApiError(404, 'TAG_NOT_FOUND', 'Tag not found');
}
async function ensureTagNameAvailable(
  tx: TagTransaction,
  libraryId: string,
  normalizedName: string,
  currentId?: string,
): Promise<void> {
  const [duplicate] = await tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.libraryId, libraryId), eq(tags.normalizedName, normalizedName)));
  if (duplicate && duplicate.id !== currentId)
    throw new ApiError(409, 'TAG_NAME_CONFLICT', 'Tag name already exists');
}
async function advanceLibraryRevision(tx: TagTransaction, libraryId: string): Promise<void> {
  await tx
    .update(libraries)
    .set({ revision: sql`${libraries.revision}+1`, updatedAt: new Date() })
    .where(eq(libraries.id, libraryId));
}
export function registerTagRoutes(
  app: FastifyInstance,
  authorize: (request: FastifyRequest, tx: TagTransaction) => Promise<unknown>,
) {
  const root = '/v1/setlists/:setlistId/tags';
  // authorize holds the library row lock for the entire transaction.
  app.get(root, async (request) =>
    db.transaction(async (tx) => {
      await authorize(request, tx);
      return { tags: await listTags(tx, scopeId(request)) };
    }),
  );
  app.post(root, async (request, reply) => {
    const input = parseTagBody(createTagInput, request.body);
    const name = normalizeTagName(input.name);
    const result = await db.transaction(async (tx) => {
      await authorize(request, tx);
      const libraryId = scopeId(request);
      await ensureTagNameAvailable(tx, libraryId, name.normalizedName);
      const [saved] = await tx
        .insert(tags)
        .values({ id: randomUUID(), libraryId, ...name, color: input.color })
        .returning({ id: tags.id, name: tags.name, color: tags.color });
      await advanceLibraryRevision(tx, libraryId);
      return saved;
    });
    reply.code(201);
    return result;
  });
  app.patch(`${root}/:id`, async (request) => {
    const input = parseTagBody(updateTagInput, request.body);
    const name = input.name === undefined ? undefined : normalizeTagName(input.name);
    const id = tagId(request);
    return db.transaction(async (tx) => {
      await authorize(request, tx);
      const libraryId = scopeId(request);
      await requireTag(tx, libraryId, id);
      if (name) await ensureTagNameAvailable(tx, libraryId, name.normalizedName, id);
      const [saved] = await tx
        .update(tags)
        .set({ ...name, ...(input.color !== undefined ? { color: input.color } : {}) })
        .where(and(eq(tags.libraryId, libraryId), eq(tags.id, id)))
        .returning({ id: tags.id, name: tags.name, color: tags.color });
      await advanceLibraryRevision(tx, libraryId);
      return saved;
    });
  });
  app.delete(`${root}/:id`, async (request) => {
    const id = tagId(request);
    return db.transaction(async (tx) => {
      await authorize(request, tx);
      const libraryId = scopeId(request);
      await requireTag(tx, libraryId, id);
      const linked = await tx
        .select({ id: songTags.songId })
        .from(songTags)
        .where(and(eq(songTags.libraryId, libraryId), eq(songTags.tagId, id)));
      if (linked.length)
        await tx
          .update(songs)
          .set({ revision: sql`${songs.revision}+1`, updatedAt: new Date() })
          .where(
            and(
              eq(songs.libraryId, libraryId),
              inArray(
                songs.id,
                linked.map((row) => row.id),
              ),
              isNull(songs.deletedAt),
            ),
          );
      await tx.delete(tags).where(and(eq(tags.libraryId, libraryId), eq(tags.id, id)));
      await advanceLibraryRevision(tx, libraryId);
      return { id, deleted: true };
    });
  });
}
