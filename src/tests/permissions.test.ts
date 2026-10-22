import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyRequest } from 'fastify';
import { authorizeScope, scopeId, transactionUser, type Transaction } from '../auth/permissions.js';
import { ApiError } from '../errors.js';
import type { AuthConfig } from '../auth/types.js';
const config: AuthConfig = {
  enabled: true,
  clientId: 'test',
  clientSecret: 'synthetic',
  redirectUri: 'http://localhost/callback',
  pwaOrigin: 'http://localhost',
  secureCookies: false,
  sessionTtlSeconds: 60,
};
const csrf = 'C'.repeat(43),
  userId = '11111111-1111-4111-8111-111111111111';
const request = (method = 'GET') =>
  ({
    method,
    params: { setlistId: '22222222-2222-4222-8222-222222222222' },
    cookies: { setlist_session: 'S'.repeat(43) },
    headers: { origin: config.pwaOrigin, 'x-csrf-token': csrf },
  }) as unknown as FastifyRequest;
function transaction(role?: string, scope = true, session = true) {
  const calls: unknown[] = [];
  const results = [
    { rows: session ? [{ user_id: userId, csrf_token: csrf }] : [] },
    { rows: scope ? [{ id: 'scope' }] : [] },
    { rows: session ? [{ user_id: userId, csrf_token: csrf }] : [] },
    { rows: role ? [{ role }] : [] },
  ];
  const tx: Transaction = {
    async execute(query) {
      calls.push(query);
      return results.shift()!;
    },
  };
  return { tx, calls };
}
test('scope authorizes owner/editor/viewer for exact action; unauthorized actions fail closed', async () => {
  for (const role of ['owner', 'editor', 'viewer'])
    for (const mode of ['read', 'write', 'owner'] as const) {
      const f = transaction(role);
      const allowed =
        mode === 'read' || (mode === 'write' && role !== 'viewer') || role === 'owner';
      if (allowed)
        assert.deepEqual(await authorizeScope(request(), f.tx, config, mode), { userId, role });
      else
        await assert.rejects(
          authorizeScope(request(), f.tx, config, mode),
          (e: any) => e instanceof ApiError && e.statusCode === 403,
        );
      assert.equal(f.calls.length, 4);
    }
});
test('deleted scope, missing membership, revoked session and malformed scope deny', async () => {
  await assert.rejects(
    authorizeScope(request(), transaction(undefined, false).tx, config),
    (e: any) => e.statusCode === 404,
  );
  await assert.rejects(
    authorizeScope(request(), transaction().tx, config),
    (e: any) => e.statusCode === 403,
  );
  await assert.rejects(
    authorizeScope(request(), transaction('owner', true, false).tx, config),
    (e: any) => e.statusCode === 401,
  );
  assert.throws(
    () => scopeId({ ...request(), params: { setlistId: 'wrong' } } as any),
    (e: any) => e.statusCode === 400,
  );
});
test('final transaction rejects changed CSRF and missing session cookie', async () => {
  const req = request('POST');
  req.headers['x-csrf-token'] = 'B'.repeat(43);
  await assert.rejects(
    authorizeScope(req, transaction('owner').tx, config),
    (e: any) => e.statusCode === 403 && e.code === 'CSRF_INVALID',
  );
  await assert.rejects(
    transactionUser({ ...request(), cookies: {} } as any, transaction().tx, config),
    (e: any) => e.statusCode === 401,
  );
});
test('session expiry after scope lock wait prevents membership read or mutation', async () => {
  const responses = [
    { rows: [{ user_id: userId, csrf_token: csrf }] },
    { rows: [{ id: 'scope' }] },
    { rows: [] },
  ];
  let count = 0;
  const tx: Transaction = {
    async execute() {
      count++;
      return responses.shift()!;
    },
  };
  await assert.rejects(
    authorizeScope(request('POST'), tx, config, 'write'),
    (e: any) => e.statusCode === 401 && e.code === 'AUTH_REQUIRED',
  );
  assert.equal(count, 3);
});
test('role refusal is distinguishable from missing membership', async () => {
  await assert.rejects(
    authorizeScope(request('POST'), transaction('viewer').tx, config, 'write'),
    (e: any) => e.code === 'SETLIST_ROLE_REQUIRED',
  );
  await assert.rejects(
    authorizeScope(request(), transaction().tx, config, 'read'),
    (e: any) => e.code === 'SETLIST_ACCESS_DENIED',
  );
});
