import { songTags, tags } from '../db/schema.js';
import { songTagIds } from './tags.js';
import { CopyConditions } from 'minio';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  attachments,
  authUsers,
  invitations,
  libraries,
  memberships,
  songs,
} from '../db/schema.js';
import { authorizeScope, scopeId, transactionUser } from '../auth/permissions.js';
import { tokenHash } from '../auth/routes.js';
import type { AuthConfig } from '../auth/types.js';
import { ApiError } from '../errors.js';
import { parse, songDto } from './songs.js';
import { config } from '../config.js';
import { removeObject, storage } from '../storage.js';
const titleInput = z.strictObject({ title: z.string().trim().min(1).max(200) });
const roleInput = z.strictObject({ role: z.enum(['owner', 'editor', 'viewer']) });
function expected(request: FastifyRequest) {
  const raw = request.headers['if-match'];
  const match = typeof raw === 'string' && raw.match(/^(?:"(\d+)"|(\d+))$/);
  if (!match)
    throw new ApiError(428, 'REVISION_REQUIRED', 'If-Match with a setlist revision is required');
  const n = Number(match[1] ?? match[2]);
  if (!Number.isSafeInteger(n)) throw new ApiError(400, 'INVALID_REVISION', 'Invalid revision');
  return n;
}
export function setlistDto(row: typeof libraries.$inferSelect, role: string) {
  return {
    id: row.id,
    title: row.title,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
    role,
  };
}
function inviteDto(row: typeof invitations.$inferSelect) {
  return {
    id: row.id,
    role: row.role,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    usedAt: row.usedAt?.toISOString() ?? null,
  };
}
export function registerSetlistRoutes(app: FastifyInstance, auth: AuthConfig) {
  app.get('/v1/setlists', async (request) =>
    db.transaction(async (tx) => {
      const userId = await transactionUser(request, tx, auth);
      const rows = await tx
        .select({ setlist: libraries, role: memberships.role })
        .from(memberships)
        .innerJoin(libraries, eq(libraries.id, memberships.setlistId))
        .where(and(eq(memberships.userId, userId), isNull(libraries.deletedAt)))
        .orderBy(libraries.createdAt, libraries.id);
      return { setlists: rows.map((row) => setlistDto(row.setlist, row.role)) };
    }),
  );
  app.post('/v1/setlists', async (request, reply) => {
    const body = parse(titleInput, request.body);
    const result = await db.transaction(async (tx) => {
      const userId = await transactionUser(request, tx, auth);
      const [row] = await tx
        .insert(libraries)
        .values({ id: randomUUID(), title: body.title })
        .returning();
      await tx.insert(memberships).values({ setlistId: row.id, userId, role: 'owner' });
      return setlistDto(row, 'owner');
    });
    reply.code(201);
    return result;
  });
  app.patch('/v1/setlists/:setlistId', async (request) => {
    const body = parse(titleInput, request.body),
      revision = expected(request);
    return db.transaction(async (tx) => {
      await authorizeScope(request, tx, auth, 'owner');
      const [row] = await tx
        .select()
        .from(libraries)
        .where(eq(libraries.id, scopeId(request)));
      if (row.revision !== revision)
        throw new ApiError(409, 'REVISION_CONFLICT', 'Setlist revision changed', row.revision);
      const [updated] = await tx
        .update(libraries)
        .set({ title: body.title, revision: row.revision + 1, updatedAt: new Date() })
        .where(eq(libraries.id, row.id))
        .returning();
      return setlistDto(updated, 'owner');
    });
  });
  app.delete('/v1/setlists/:setlistId', async (request) => {
    const revision = expected(request);
    return db.transaction(async (tx) => {
      await authorizeScope(request, tx, auth, 'owner');
      const [row] = await tx
        .select()
        .from(libraries)
        .where(eq(libraries.id, scopeId(request)));
      if (row.revision !== revision)
        throw new ApiError(409, 'REVISION_CONFLICT', 'Setlist revision changed', row.revision);
      await tx
        .update(libraries)
        .set({ deletedAt: new Date(), updatedAt: new Date(), revision: row.revision + 1 })
        .where(eq(libraries.id, row.id));
      return { id: row.id, deleted: true };
    });
  });
  app.get('/v1/setlists/:setlistId/members', async (request) =>
    db.transaction(async (tx) => {
      await authorizeScope(request, tx, auth, 'read');
      const rows = await tx
        .select({ user: authUsers, role: memberships.role, createdAt: memberships.createdAt })
        .from(memberships)
        .innerJoin(authUsers, eq(authUsers.id, memberships.userId))
        .where(eq(memberships.setlistId, scopeId(request)));
      return {
        members: rows.map(({ user, role, createdAt }) => ({
          user: {
            id: user.id,
            displayName: user.displayName,
            ...(user.username ? { username: user.username } : {}),
            ...(user.picture ? { picture: user.picture } : {}),
          },
          role,
          createdAt: createdAt.toISOString(),
        })),
      };
    }),
  );
  for (const method of ['patch', 'delete'] as const)
    app[method]('/v1/setlists/:setlistId/members/:userId', async (request) => {
      const userId = parse(z.string().uuid(), (request.params as any).userId);
      const role = method === 'patch' ? parse(roleInput, request.body).role : undefined;
      return db.transaction(async (tx) => {
        await authorizeScope(request, tx, auth, 'owner');
        const id = scopeId(request);
        const [member] = await tx
          .select()
          .from(memberships)
          .where(and(eq(memberships.setlistId, id), eq(memberships.userId, userId)));
        if (!member) throw new ApiError(404, 'MEMBER_NOT_FOUND', 'Member not found');
        if (member.role === 'owner' && role !== 'owner') {
          const owners = await tx
            .select()
            .from(memberships)
            .where(and(eq(memberships.setlistId, id), eq(memberships.role, 'owner')));
          if (owners.length === 1)
            throw new ApiError(409, 'LAST_OWNER_REQUIRED', 'Cannot remove the last owner');
        }
        if (role)
          await tx
            .update(memberships)
            .set({ role })
            .where(and(eq(memberships.setlistId, id), eq(memberships.userId, userId)));
        else
          await tx
            .delete(memberships)
            .where(and(eq(memberships.setlistId, id), eq(memberships.userId, userId)));
        return { userId, ...(role ? { role } : { deleted: true }) };
      });
    });
  app.get('/v1/setlists/:setlistId/invitations', async (request) =>
    db.transaction(async (tx) => {
      await authorizeScope(request, tx, auth, 'owner');
      return {
        invitations: (
          await tx
            .select()
            .from(invitations)
            .where(eq(invitations.setlistId, scopeId(request)))
        ).map(inviteDto),
      };
    }),
  );
  app.post('/v1/setlists/:setlistId/invitations', async (request, reply) => {
    const body = parse(
      z.strictObject({
        role: z.enum(['editor', 'viewer']),
        expiresInHours: z.number().int().min(1).max(168).optional(),
      }),
      request.body,
    );
    const token = randomBytes(32).toString('base64url');
    const row = await db.transaction(async (tx) => {
      await authorizeScope(request, tx, auth, 'owner');
      const [row] = await tx
        .insert(invitations)
        .values({
          id: randomUUID(),
          setlistId: scopeId(request),
          role: body.role,
          tokenHash: tokenHash(token),
          expiresAt: null,
        })
        .returning();
      return row;
    });
    reply.code(201);
    return { invitation: inviteDto(row), token };
  });
  app.delete('/v1/setlists/:setlistId/invitations/:id', async (request) =>
    db.transaction(async (tx) => {
      const id = parse(z.string().uuid(), (request.params as any).id);
      await authorizeScope(request, tx, auth, 'owner');
      const [row] = await tx
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(and(eq(invitations.id, id), eq(invitations.setlistId, scopeId(request))))
        .returning();
      if (!row) throw new ApiError(404, 'INVITATION_NOT_FOUND', 'Invitation not found');
      return { id, revoked: true };
    }),
  );
  app.post('/v1/invitations/accept', async (request) => {
    const { token } = parse(
      z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
      request.body,
    );
    return db.transaction(async (tx) => {
      const userId = await transactionUser(request, tx, auth);
      const [candidate] = await tx
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, tokenHash(token)));
      if (!candidate)
        throw new ApiError(409, 'INVITATION_INVALID', 'Invitation invalid or unavailable');
      const locked = await tx.execute(
        sql`SELECT * FROM libraries WHERE id=${candidate.setlistId} AND deleted_at IS NULL FOR UPDATE`,
      );
      if (!locked.rows[0])
        throw new ApiError(409, 'INVITATION_INVALID', 'Invitation invalid or unavailable');
      await transactionUser(request, tx, auth); // Session can expire while waiting for the scope.
      const consumed = await tx.execute(
        sql`UPDATE setlist_invitations SET used_at=clock_timestamp() WHERE id=${candidate.id} AND used_at IS NULL AND revoked_at IS NULL RETURNING role`,
      );
      if (!consumed.rows[0])
        throw new ApiError(409, 'INVITATION_INVALID', 'Invitation invalid or unavailable');
      // Existing membership is retained; invitations never downgrade (or overwrite) authority.
      await tx
        .insert(memberships)
        .values({ setlistId: candidate.setlistId, userId, role: candidate.role })
        .onConflictDoNothing();
      const [member] = await tx
        .select()
        .from(memberships)
        .where(and(eq(memberships.setlistId, candidate.setlistId), eq(memberships.userId, userId)));
      const [row] = await tx.select().from(libraries).where(eq(libraries.id, candidate.setlistId));
      return { setlist: setlistDto(row, member.role) };
    });
  });
  app.post('/v1/setlists/:setlistId/songs/:songId/copy', async (request, reply) => {
    const { targetSetlistId } = parse(
      z.strictObject({ targetSetlistId: z.string().uuid() }),
      request.body,
    );
    const songId = parse(z.string().uuid(), (request.params as any).songId),
      sourceId = scopeId(request);
    const copiedKeys: string[] = [];
    try {
      const result = await db.transaction(async (tx) => {
        await transactionUser(request, tx, auth);
        // Deterministic lock order avoids two opposite-direction copies deadlocking.
        for (const id of [...new Set([sourceId, targetSetlistId])].sort())
          await tx.execute(sql`SELECT id FROM libraries WHERE id=${id} FOR UPDATE`);
        await authorizeScope(request, tx, auth, 'read', sourceId);
        await authorizeScope(request, tx, auth, 'write', targetSetlistId);
        const [source] = await tx
          .select()
          .from(songs)
          .where(and(eq(songs.id, songId), eq(songs.libraryId, sourceId), isNull(songs.deletedAt)));
        if (!source) throw new ApiError(404, 'SONG_NOT_FOUND', 'Song not found');
        const id = randomUUID();
        const [song] = await tx
          .insert(songs)
          .values({
            id,
            libraryId: targetSetlistId,
            title: source.title,
            artist: source.artist,
            notes: source.notes,
            createKey: `copy:${id}`,
            createHash: tokenHash(id),
          })
          .returning();
        const sourceTags = await tx
          .select({ tag: tags })
          .from(songTags)
          .innerJoin(tags, and(eq(tags.id, songTags.tagId), eq(tags.libraryId, songTags.libraryId)))
          .where(and(eq(songTags.libraryId, sourceId), eq(songTags.songId, songId)));
        for (const { tag } of sourceTags) {
          const [existingTag] = await tx
            .select()
            .from(tags)
            .where(
              and(eq(tags.libraryId, targetSetlistId), eq(tags.normalizedName, tag.normalizedName)),
            );
          const targetTagId = existingTag?.id ?? randomUUID();
          if (!existingTag)
            await tx.insert(tags).values({
              id: targetTagId,
              libraryId: targetSetlistId,
              name: tag.name,
              normalizedName: tag.normalizedName,
              color: tag.color,
            });
          await tx
            .insert(songTags)
            .values({ libraryId: targetSetlistId, songId: id, tagId: targetTagId });
        }
        const files = await tx
          .select()
          .from(attachments)
          .where(
            and(
              eq(attachments.songId, songId),
              eq(attachments.libraryId, sourceId),
              isNull(attachments.deletedAt),
            ),
          );
        for (const file of files) {
          const fileId = randomUUID(),
            objectKey = `attachments/${fileId}/${randomUUID()}`;
          copiedKeys.push(objectKey);
          await storage.copyObject(
            config.bucket,
            objectKey,
            `/${config.bucket}/${file.objectKey}`,
            new CopyConditions(),
          );
          await tx.insert(attachments).values({
            ...file,
            id: fileId,
            songId: id,
            libraryId: targetSetlistId,
            objectKey,
            createdAt: new Date(),
            deletedAt: null,
          });
        }
        // Recheck TTL, source membership and target membership before publication.
        await authorizeScope(request, tx, auth, 'read', sourceId);
        await authorizeScope(request, tx, auth, 'write', targetSetlistId);
        await tx
          .update(libraries)
          .set({ revision: sql`${libraries.revision}+1`, updatedAt: new Date() })
          .where(eq(libraries.id, targetSetlistId));
        return {
          ...songDto(song, await songTagIds(tx, targetSetlistId, id)),
          attachments: (await tx.select().from(attachments).where(eq(attachments.songId, id))).map(
            (file) => ({
              id: file.id,
              setlistId: file.libraryId,
              songId: file.songId,
              kind: file.kind,
              mimeType: file.mimeType,
              filename: file.filename,
              byteSize: file.byteSize,
              checksum: file.checksum,
              createdAt: file.createdAt.toISOString(),
              contentUrl: `/v1/setlists/${targetSetlistId}/attachments/${file.id}/content`,
            }),
          ),
        };
      });
      reply.code(201);
      return result;
    } catch (error) {
      for (const key of copiedKeys) await removeObject(key).catch(() => {});
      throw error;
    }
  });
}
