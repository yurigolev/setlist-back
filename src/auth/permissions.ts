import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { LIBRARY_ID } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { requireCsrf, requireSession, SESSION_COOKIE, tokenHash } from './routes.js';
import type { AuthConfig, AuthStore } from './types.js';
export type Role = 'owner' | 'editor' | 'viewer';
export type Transaction = { execute(query: SQL): Promise<{ rows: Record<string, any>[] }> };
export function scopeId(request: FastifyRequest): string {
  const value = (request.params as { setlistId?: string }).setlistId ?? LIBRARY_ID;
  if (!z.string().uuid().safeParse(value).success)
    throw new ApiError(400, 'INVALID_REQUEST', 'Invalid setlist id');
  return value;
}
export function registerPrivateAuthorization(
  app: FastifyInstance,
  store: AuthStore,
  config: AuthConfig,
) {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'private, no-store').header('pragma', 'no-cache');
    const session = await requireSession(request, store);
    if (!config.enabled)
      throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Authentication unavailable');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method))
      requireCsrf(request, session, config.pwaOrigin);
  });
}
export async function transactionUser(
  request: FastifyRequest,
  tx: Transaction,
  config: AuthConfig,
): Promise<string> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  const { rows } = await tx.execute(
    sql`SELECT s.user_id,s.csrf_token FROM auth_sessions s WHERE s.token_hash=${tokenHash(token)} AND s.expires_at>clock_timestamp() AND (s.family_id IS NULL OR EXISTS (SELECT 1 FROM auth_refresh_families f WHERE f.id=s.family_id AND f.revoked_at IS NULL AND f.expires_at>clock_timestamp())) FOR SHARE OF s`,
  );
  if (!rows[0]) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method))
    requireCsrf(request, { csrfToken: rows[0].csrf_token } as any, config.pwaOrigin);
  return rows[0].user_id;
}
export async function authorizeScope(
  request: FastifyRequest,
  tx: Transaction,
  config: AuthConfig,
  mode: 'read' | 'write' | 'owner' = ['GET', 'HEAD'].includes(request.method) ? 'read' : 'write',
  id = scopeId(request),
) {
  const userId = await transactionUser(request, tx, config);
  // Session first, then scope: consistent order with logout and multi-scope copies.
  const { rows: scopes } = await tx.execute(
    sql`SELECT id FROM libraries WHERE id=${id} AND deleted_at IS NULL FOR UPDATE`,
  );
  if (!scopes[0]) throw new ApiError(404, 'SETLIST_NOT_FOUND', 'Setlist not found');
  await transactionUser(request, tx, config); // TTL may expire while waiting for the scope lock.
  const { rows } = await tx.execute(
    sql`SELECT role FROM setlist_memberships WHERE setlist_id=${id} AND user_id=${userId}`,
  );
  const role = rows[0]?.role as Role | undefined;
  if (!role) throw new ApiError(403, 'SETLIST_ACCESS_DENIED', 'Setlist membership required');
  if ((mode === 'owner' && role !== 'owner') || (mode === 'write' && role === 'viewer'))
    throw new ApiError(403, 'SETLIST_ROLE_REQUIRED', 'Setlist role does not allow this action');
  return { userId, role };
}
