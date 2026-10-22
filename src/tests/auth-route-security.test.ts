import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { registerErrors } from '../errors.js';
import { registerAuthRoutes, tokenHash } from '../auth/routes.js';
import { createProxyTrust } from '../proxy.js';
import type {
  AuthConfig,
  AuthSession,
  AuthStore,
  AuthUser,
  LoginAttempt,
  VerifiedIdentity,
  RefreshGrant,
  TokenPair,
  RotationResult,
} from '../auth/types.js';

class MemoryStore implements AuthStore {
  attempts = new Map<string, LoginAttempt>();
  sessions = new Map<string, AuthSession>();
  refreshes = new Map<string, { session: AuthSession; usedAt?: number }>();
  deletions = 0;
  async createLogin(attempt: LoginAttempt) {
    this.attempts.set(attempt.stateHash, attempt);
  }
  async consumeLogin(stateHash: string, browserHash: string) {
    const attempt = this.attempts.get(stateHash);
    if (!attempt || attempt.browserHash !== browserHash || attempt.expiresAt <= new Date())
      return undefined;
    this.attempts.delete(stateHash);
    return attempt;
  }
  async createSession(
    identity: VerifiedIdentity,
    hash: string,
    csrfToken: string,
    expiresAt: Date,
    previousHash?: string,
    refresh?: RefreshGrant,
  ) {
    const user: AuthUser = { id: '11111111-1111-4111-8111-111111111111', ...identity };
    if (previousHash) this.sessions.delete(previousHash);
    const session: AuthSession = {
      user,
      csrfToken,
      expiresAt,
      ...(refresh ? { familyId: hash } : {}),
    };
    this.sessions.set(hash, session);
    if (refresh)
      this.refreshes.set(refresh.hash, { session: { ...session, expiresAt: refresh.expiresAt } });
    return user;
  }
  async getSession(hash: string) {
    const session = this.sessions.get(hash);
    return session && session.expiresAt > new Date() ? session : undefined;
  }
  async deleteSession(hash: string) {
    this.deletions++;
    const family = this.sessions.get(hash)?.familyId;
    this.sessions.delete(hash);
    if (family) this.revokeFamily(family);
  }
  private revokeFamily(id: string) {
    for (const [hash, session] of this.sessions)
      if (session.familyId === id) this.sessions.delete(hash);
    for (const [hash, refresh] of this.refreshes)
      if (refresh.session.familyId === id) this.refreshes.delete(hash);
  }
  async getRefresh(hash: string) {
    const current = this.refreshes.get(hash);
    return current && current.session.expiresAt > new Date() ? current.session : undefined;
  }
  async rotateRefresh(hash: string, pair: TokenPair): Promise<RotationResult> {
    const current = this.refreshes.get(hash);
    if (!current || current.session.expiresAt <= new Date()) return { status: 'invalid' };
    if (current.usedAt) {
      if (Date.now() - current.usedAt < 10000) return { status: 'conflict' };
      this.revokeFamily(current.session.familyId!);
      return { status: 'invalid' };
    }
    current.usedAt = Date.now();
    const session = { ...current.session, expiresAt: pair.accessExpiresAt };
    this.sessions.set(pair.accessHash, session);
    this.refreshes.set(pair.refreshHash, {
      session: { ...session, expiresAt: pair.refreshExpiresAt },
    });
    return { status: 'rotated', session };
  }
  async bootstrapSession(hash: string, pair: TokenPair): Promise<RotationResult> {
    const current = await this.getSession(hash);
    if (!current) return { status: 'invalid' };
    if (current.familyId) return { status: 'conflict' };
    current.familyId = hash;
    const session = { ...current, expiresAt: pair.accessExpiresAt };
    this.sessions.set(pair.accessHash, session);
    this.refreshes.set(pair.refreshHash, {
      session: { ...session, expiresAt: pair.refreshExpiresAt },
    });
    return { status: 'rotated', session };
  }
  async revokeRefresh(hash: string) {
    const current = this.refreshes.get(hash);
    if (current) this.revokeFamily(current.session.familyId!);
  }
}
const config: AuthConfig = {
  enabled: true,
  clientId: 'qa-client',
  clientSecret: 'synthetic',
  redirectUri: 'http://127.0.0.1:46543/v1/auth/telegram/callback',
  pwaOrigin: 'http://127.0.0.1:46544',
  secureCookies: false,
  sessionTtlSeconds: 3600,
};
const proxyAddresses = {
  frontend: [
    { address: '172.18.0.5', family: 4 },
    { address: 'fd00::5', family: 6 },
  ],
  caddy: [
    { address: '172.18.0.6', family: 4 },
    { address: 'fd00::6', family: 6 },
  ],
};
function productionProxyTrust() {
  return createProxyTrust(['frontend', 'caddy'], {
    resolve: async (hostname) => proxyAddresses[hostname as keyof typeof proxyAddresses],
  });
}
async function fixture(enabled = true, proxies = createProxyTrust([])) {
  const store = new MemoryStore();
  const app = Fastify({ trustProxy: proxies.trustProxy });
  registerErrors(app);
  proxies.register(app);
  app.get('/qa/client-ip', (request) => ({
    ip: request.ip,
    ips: request.ips,
    host: request.host,
    protocol: request.protocol,
  }));
  let authenticated = 0;
  await registerAuthRoutes(app, {
    config: { ...config, enabled },
    store,
    oidc: {
      authorizationUrl(state, verifier, nonce) {
        return `https://oauth.telegram.org/auth?state=${state}&nonce=${nonce}&code_challenge=${verifier}`;
      },
      async authenticate() {
        authenticated++;
        return {
          issuer: 'https://oauth.telegram.org',
          subject: 'opaque-sub',
          displayName: 'QA User',
        };
      },
    },
  });
  await app.ready();
  async function start() {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/telegram/start?returnTo=/songs',
    });
    assert.equal(response.statusCode, 302);
    assert.match(String(response.headers['cache-control']), /no-store/);
    const state = new URL(String(response.headers.location)).searchParams.get('state')!;
    const binding = response.cookies.find((cookie) => cookie.name === 'setlist_login')!;
    return { state, cookie: `setlist_login=${binding.value}` };
  }
  async function callback(state: string, cookie: string) {
    return app.inject({
      method: 'GET',
      url: `/v1/auth/telegram/callback?code=qa-code&state=${state}`,
      headers: { cookie },
    });
  }
  return {
    app,
    store,
    start,
    callback,
    get authenticated() {
      return authenticated;
    },
  };
}

test('login grants reject wrong browser/state and expired grants without creating sessions', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const grant = await f.start();
  for (const [state, cookie] of [
    [grant.state, `setlist_login=${'B'.repeat(43)}`],
    ['A'.repeat(43), grant.cookie],
  ]) {
    const denied = await f.callback(state, cookie);
    assert.equal(denied.statusCode, 302);
    assert.equal(denied.headers.location, `${config.pwaOrigin}/login?authError=invalid`);
    assert.match(String(denied.headers['cache-control']), /no-store/);
    assert.equal(f.store.sessions.size, 0);
  }
  assert.equal(f.authenticated, 0);
  f.store.attempts.get(tokenHash(grant.state))!.expiresAt = new Date(Date.now() - 1000);
  const expired = await f.callback(grant.state, grant.cookie);
  assert.equal(expired.headers.location, `${config.pwaOrigin}/login?authError=invalid`);
  assert.equal(f.store.sessions.size, 0);
  assert.equal(f.authenticated, 0);
});

test('successful browser-bound grant is consumed once and replay cannot create another session', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const grant = await f.start();
  const success = await f.callback(grant.state, grant.cookie);
  assert.equal(success.statusCode, 302);
  assert.equal(success.headers.location, `${config.pwaOrigin}/songs`);
  const sessionCookie = success.cookies.find((cookie) => cookie.name === 'setlist_session')!;
  assert.ok(sessionCookie);
  assert.match(String(success.headers['set-cookie']), /HttpOnly/);
  assert.match(String(success.headers['set-cookie']), /SameSite=Lax/);
  assert.equal(f.store.attempts.size, 0);
  assert.equal(f.store.sessions.size, 1);
  const replay = await f.callback(grant.state, grant.cookie);
  assert.equal(replay.headers.location, `${config.pwaOrigin}/login?authError=invalid`);
  assert.equal(
    replay.cookies.some((cookie) => cookie.name === 'setlist_session'),
    false,
  );
  assert.equal(f.store.sessions.size, 1);
  assert.equal(f.authenticated, 1);
});

test('session expiry, Unicode CSRF, origin checks and logout revoke only an authorized session', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const grant = await f.start();
  const success = await f.callback(grant.state, grant.cookie);
  const token = success.cookies.find((cookie) => cookie.name === 'setlist_session')!.value;
  const cookie = `setlist_session=${token}`;
  const current = await f.app.inject({
    method: 'GET',
    url: '/v1/auth/session',
    headers: { cookie },
  });
  assert.equal(current.statusCode, 200);
  assert.deepEqual(current.json().user, {
    id: '11111111-1111-4111-8111-111111111111',
    displayName: 'QA User',
  });
  const csrfToken: string = current.json().csrfToken;
  const active = f.store.sessions.get(tokenHash(token))!;
  active.expiresAt = new Date(Date.now() - 1000);
  assert.equal(
    (await f.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } }))
      .statusCode,
    401,
  );
  active.expiresAt = new Date(Date.now() + 60_000);
  for (const [origin, csrf] of [
    ['https://outsider.invalid', csrfToken],
    [config.pwaOrigin, 'wrong-token'],
    [config.pwaOrigin, 'я'.repeat(43)],
  ]) {
    const denied = await f.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie, origin, 'x-csrf-token': csrf },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(f.store.deletions, 0);
    assert.match(String(denied.headers['cache-control']), /no-store/);
  }
  const logout = await f.app.inject({
    method: 'POST',
    url: '/v1/auth/logout',
    headers: { cookie, origin: config.pwaOrigin, 'x-csrf-token': csrfToken },
  });
  assert.equal(logout.statusCode, 204);
  assert.ok(logout.cookies.find((value) => value.name === 'setlist_session' && value.value === ''));
  assert.equal(f.store.sessions.size, 0);
  assert.equal(f.store.deletions, 1);
  assert.equal(
    (await f.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } }))
      .statusCode,
    401,
  );
});

test('missing configuration redirects login to a generic unavailable screen', async (t) => {
  const f = await fixture(false);
  t.after(() => f.app.close());
  const response = await f.app.inject({ method: 'GET', url: '/v1/auth/telegram/start' });
  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, `${config.pwaOrigin}/login?authError=unavailable`);
  assert.match(String(response.headers['cache-control']), /no-store/);
  assert.equal(f.store.attempts.size, 0);
});

test('refresh survives expired access, enforces CSRF/Origin, rotates once and detects replay', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const grant = await f.start();
  const login = await f.callback(grant.state, grant.cookie);
  const access = login.cookies.find((c) => c.name === 'setlist_session')!.value;
  const refresh = login.cookies.find((c) => c.name === 'setlist_refresh')!.value;
  assert.equal(login.cookies.find((c) => c.name === 'setlist_refresh')!.path, '/v1/auth');
  const old = f.store.refreshes.get(tokenHash(refresh))!;
  const csrf = old.session.csrfToken;
  f.store.sessions.get(tokenHash(access))!.expiresAt = new Date(0);
  const cookie = `setlist_refresh=${refresh}`;
  const context = await f.app.inject({
    method: 'GET',
    url: '/v1/auth/refresh-context',
    headers: { cookie },
  });
  assert.equal(context.statusCode, 200);
  assert.equal(context.json().csrfToken, csrf);
  assert.match(String(context.headers['cache-control']), /no-store/);
  assert.equal(
    (await f.app.inject({ method: 'GET', url: '/v1/auth/session', headers: { cookie } }))
      .statusCode,
    401,
  );
  for (const [origin, token] of [
    [config.pwaOrigin, 'wrong'],
    ['https://other.invalid', csrf],
    [config.pwaOrigin, 'я'.repeat(43)],
  ]) {
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/v1/auth/refresh',
          headers: { cookie, origin, 'x-csrf-token': token },
        })
      ).statusCode,
      403,
    );
  }
  const headers = { cookie, origin: config.pwaOrigin, 'x-csrf-token': csrf };
  const renewed = await f.app.inject({ method: 'POST', url: '/v1/auth/refresh', headers });
  assert.equal(renewed.statusCode, 200);
  assert.equal(renewed.json().refreshEnabled, true);
  const newAccess = renewed.cookies.find((c) => c.name === 'setlist_session')!.value;
  const newRefresh = renewed.cookies.find((c) => c.name === 'setlist_refresh')!.value;
  assert.notEqual(newRefresh, refresh);
  assert.notEqual(newAccess, access);
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/v1/auth/refresh', headers })).statusCode,
    409,
  );
  old.usedAt = Date.now() - 11000;
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/v1/auth/refresh', headers })).statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'GET',
        url: '/v1/auth/session',
        headers: { cookie: `setlist_session=${newAccess}` },
      })
    ).statusCode,
    401,
  );
});

test('logout via refresh revokes family when access has already expired', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const grant = await f.start();
  const login = await f.callback(grant.state, grant.cookie);
  const refresh = login.cookies.find((c) => c.name === 'setlist_refresh')!.value;
  const access = login.cookies.find((c) => c.name === 'setlist_session')!.value;
  const csrf = f.store.refreshes.get(tokenHash(refresh))!.session.csrfToken;
  f.store.sessions.get(tokenHash(access))!.expiresAt = new Date(0);
  const result = await f.app.inject({
    method: 'POST',
    url: '/v1/auth/logout',
    headers: {
      cookie: `setlist_refresh=${refresh}`,
      origin: config.pwaOrigin,
      'x-csrf-token': csrf,
    },
  });
  assert.equal(result.statusCode, 204);
  assert.equal(f.store.sessions.size, 0);
  assert.equal(f.store.refreshes.size, 0);
  assert.ok(
    result.cookies.some(
      (c) => c.name === 'setlist_refresh' && c.value === '' && c.path === '/v1/auth',
    ),
  );
});

test('legacy bootstrap requires valid access and cannot recreate refresh for an existing family', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const token = 'L'.repeat(43),
    csrf = 'C'.repeat(43);
  await f.store.createSession(
    { issuer: 'https://oauth.telegram.org', subject: 'legacy', displayName: 'Legacy' },
    tokenHash(token),
    csrf,
    new Date(Date.now() + 60000),
  );
  const headers = {
    cookie: `setlist_session=${token}`,
    origin: config.pwaOrigin,
    'x-csrf-token': csrf,
  };
  const result = await f.app.inject({ method: 'POST', url: '/v1/auth/refresh', headers });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().user.displayName, 'Legacy');
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/v1/auth/refresh', headers })).statusCode,
    401,
  );
  const expired = 'E'.repeat(43);
  await f.store.createSession(
    { issuer: 'https://oauth.telegram.org', subject: 'expired', displayName: 'Expired' },
    tokenHash(expired),
    csrf,
    new Date(0),
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { ...headers, cookie: `setlist_session=${expired}` },
      })
    ).statusCode,
    401,
  );
});

test('missing, malformed and expired refresh cannot renew or expose refresh context', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const grant = await f.start();
  const login = await f.callback(grant.state, grant.cookie);
  const access = login.cookies.find((cookie) => cookie.name === 'setlist_session')!.value;
  const refresh = login.cookies.find((cookie) => cookie.name === 'setlist_refresh')!.value;
  const family = f.store.refreshes.get(tokenHash(refresh))!;
  const csrf = family.session.csrfToken;
  family.session.expiresAt = new Date(0);
  f.store.sessions.get(tokenHash(access))!.expiresAt = new Date(0);
  for (const cookie of [
    '',
    'setlist_refresh=malformed',
    `setlist_refresh=${refresh}; setlist_session=${access}`,
  ]) {
    const context = await f.app.inject({
      method: 'GET',
      url: '/v1/auth/refresh-context',
      headers: { cookie },
    });
    assert.equal(context.statusCode, 401);
    assert.match(String(context.headers['cache-control']), /no-store/);
    const renewal = await f.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie, origin: config.pwaOrigin, 'x-csrf-token': csrf },
    });
    assert.equal(renewal.statusCode, 401);
    assert.equal(renewal.cookies.length, 0);
  }
  assert.equal(f.store.refreshes.size, 1);
  assert.equal(family.usedAt, undefined);
});

test('login limits are independent for clients behind the ordered production proxy chain', async (t) => {
  const f = await fixture(true, productionProxyTrust());
  t.after(() => f.app.close());
  const client = (ip: string, prefix = '') =>
    f.app.inject({
      method: 'GET',
      url: '/v1/auth/telegram/start',
      remoteAddress: '172.18.0.5',
      headers: { 'x-forwarded-for': `${prefix}${ip}, 172.18.0.6` },
    });
  for (let attempt = 0; attempt < 20; attempt++) {
    assert.equal((await client('203.0.113.1')).statusCode, 302);
    assert.equal((await client('203.0.113.2')).statusCode, 302);
  }
  assert.equal((await client('203.0.113.1')).statusCode, 429);
  assert.equal((await client('203.0.113.2')).statusCode, 429);
  assert.equal((await client('203.0.113.3')).statusCode, 302);
  // Client-controlled prefixes, including trusted proxy addresses, cannot reset A's bucket.
  assert.equal((await client('203.0.113.1', '198.51.100.99, 172.18.0.5, ')).statusCode, 429);
});

test('direct requests and an untrusted intermediate cannot spoof forwarded client metadata', async (t) => {
  const f = await fixture(true, productionProxyTrust());
  t.after(() => f.app.close());
  for (let attempt = 0; attempt < 21; attempt++) {
    const response = await f.app.inject({
      method: 'GET',
      url: '/v1/auth/telegram/start',
      remoteAddress: '203.0.113.8',
      headers: {
        'x-forwarded-for': `198.51.100.${attempt}, 172.18.0.6`,
        'x-real-ip': `192.0.2.${attempt}`,
        forwarded: `for=192.0.2.${attempt}`,
      },
    });
    assert.equal(response.statusCode, attempt < 20 ? 302 : 429);
  }
  const direct = await f.app.inject({
    method: 'GET',
    url: '/qa/client-ip',
    remoteAddress: '203.0.113.8',
    headers: {
      host: 'setlivo.ru',
      'x-forwarded-for': '192.0.2.9, 172.18.0.6',
      'x-forwarded-host': 'attacker.invalid',
      'x-forwarded-proto': 'https',
      'x-real-ip': '192.0.2.9',
      forwarded: 'for=192.0.2.9',
    },
  });
  assert.deepEqual(direct.json(), {
    ip: '203.0.113.8',
    ips: ['203.0.113.8'],
    host: 'setlivo.ru',
    protocol: 'http',
  });
  const intermediate = await f.app.inject({
    method: 'GET',
    url: '/qa/client-ip',
    remoteAddress: '172.18.0.5',
    headers: { 'x-forwarded-for': '198.51.100.99, 172.18.0.77' },
  });
  assert.equal(intermediate.json().ip, '172.18.0.77');
  // Merely being a trusted proxy at a different position is insufficient.
  const wrongOrder = await f.app.inject({
    method: 'GET',
    url: '/qa/client-ip',
    remoteAddress: '172.18.0.6',
    headers: { 'x-forwarded-for': '198.51.100.99, 172.18.0.5' },
  });
  assert.equal(wrongOrder.json().ip, '172.18.0.6');
});

test('IPv6 and IPv4-mapped proxy addresses stop at the actual client even if it has a proxy IP', async (t) => {
  const f = await fixture(true, productionProxyTrust());
  t.after(() => f.app.close());
  for (const [remoteAddress, chain, expected] of [
    ['::ffff:172.18.0.5', '203.0.113.8, ::ffff:172.18.0.6', '203.0.113.8'],
    ['fd00::5', '2001:db8::8, fd00::6', '2001:db8::8'],
    ['172.18.0.5', '198.51.100.99, 172.18.0.5, 172.18.0.6', '172.18.0.5'],
  ]) {
    const response = await f.app.inject({
      method: 'GET',
      url: '/qa/client-ip',
      remoteAddress,
      headers: { 'x-forwarded-for': chain },
    });
    assert.equal(response.json().ip, expected);
  }
});

test('an empty proxy configuration ignores forwarding headers', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const response = await f.app.inject({
    method: 'GET',
    url: '/qa/client-ip',
    remoteAddress: '172.18.0.5',
    headers: { 'x-forwarded-for': '198.51.100.99, 172.18.0.6' },
  });
  assert.equal(response.json().ip, '172.18.0.5');
});

test('proxy DNS refresh revokes old addresses and fails closed until resolution recovers', async () => {
  let time = 1;
  let address = '172.18.0.5';
  let failed = false;
  const proxies = createProxyTrust(['frontend'], {
    now: () => time,
    resolve: async () => {
      if (failed) throw new Error('DNS unavailable');
      return [{ address, family: 4 }];
    },
  });
  await proxies.refresh();
  assert.equal(proxies.trustProxy('172.18.0.5', 0), true);
  assert.equal(proxies.trustProxy('172.18.0.5', 1), false);
  time += 5001;
  address = '172.18.0.9';
  await proxies.refresh();
  assert.equal(proxies.trustProxy('172.18.0.5', 0), false);
  assert.equal(proxies.trustProxy('172.18.0.9', 0), true);
  time += 5001;
  failed = true;
  await assert.rejects(proxies.refresh(), { statusCode: 503, code: 'PROXY_UNAVAILABLE' });
  assert.equal(proxies.trustProxy('172.18.0.9', 0), false);
  await assert.rejects(proxies.refresh(), { statusCode: 503 });
  failed = false;
  time += 5001;
  await proxies.refresh();
  assert.equal(proxies.trustProxy('172.18.0.9', 0), true);
});
