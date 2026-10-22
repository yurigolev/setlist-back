import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createTelegramOidc, TELEGRAM_ISSUER } from '../auth/oidc.js';
import { safeReturnTo } from '../auth/routes.js';
import type { AuthConfig } from '../auth/types.js';

const config: AuthConfig = {
  enabled: true,
  clientId: 'test-client',
  clientSecret: 'test-secret',
  redirectUri: 'https://api.example.test/v1/auth/telegram/callback',
  pwaOrigin: 'https://app.example.test',
  secureCookies: true,
  sessionTtlSeconds: 3600,
};
const pair = await generateKeyPair('RS256');
const publicJwk = await exportJWK(pair.publicKey);
const keys = createLocalJWKSet({ keys: [{ ...publicJwk, kid: 'test', alg: 'RS256' }] });
const now = Math.floor(Date.now() / 1000);
async function idToken(claims: Record<string, unknown> = {}, key = pair.privateKey) {
  return new SignJWT({
    iss: TELEGRAM_ISSUER,
    aud: config.clientId,
    sub: 'opaque-subject',
    iat: now,
    exp: now + 300,
    nonce: 'expected-nonce',
    name: 'Test User',
    preferred_username: 'testuser',
    id: 987654321,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .sign(key);
}
function service(token: string, check?: (input: RequestInfo | URL, init?: RequestInit) => void) {
  return createTelegramOidc(config, {
    keys,
    fetch: (async (input, init) => {
      check?.(input, init);
      return new Response(JSON.stringify({ id_token: token }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
}

test('Telegram authorization uses code, S256 and nonce; exchange authenticates server and binds verifier', async () => {
  const oidc = service(await idToken(), (input, init) => {
    assert.equal(input, `${TELEGRAM_ISSUER}/token`);
    assert.equal(init?.redirect, 'error');
    assert.equal(
      (init?.headers as Record<string, string>).authorization,
      `Basic ${Buffer.from('test-client:test-secret').toString('base64')}`,
    );
    const form = init?.body as URLSearchParams;
    assert.equal(form.get('code_verifier'), 'verifier');
    assert.equal(form.get('code'), 'code');
    assert.equal(form.get('redirect_uri'), config.redirectUri);
  });
  const url = new URL(oidc.authorizationUrl('state', 'verifier', 'nonce'));
  assert.equal(url.origin, TELEGRAM_ISSUER);
  assert.equal(url.searchParams.get('scope'), 'openid profile');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('nonce'), 'nonce');
  assert.equal(url.searchParams.get('response_type'), 'code');
  const rfc7636 = new URL(
    oidc.authorizationUrl('state', 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'nonce'),
  );
  assert.equal(
    rfc7636.searchParams.get('code_challenge'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
  assert.equal(url.searchParams.has('client_secret'), false);
  const identity = await oidc.authenticate('code', 'verifier', 'expected-nonce');
  assert.equal(identity.subject, 'opaque-subject');
  assert.equal(identity.issuer, TELEGRAM_ISSUER);
  assert.equal(identity.displayName, 'Test User');
});

test('Telegram ID token rejects wrong claims, expiry, nonce and signature', async () => {
  for (const claims of [
    { iss: 'https://attacker.invalid' },
    { aud: 'other-client' },
    { exp: now - 60 },
    { nonce: 'other-nonce' },
    { sub: '' },
    { iat: now + 600 },
    { aud: ['test-client', 'other-client'] },
    { nonce: undefined },
    { exp: undefined },
  ]) {
    await assert.rejects(
      service(await idToken(claims)).authenticate('code', 'verifier', 'expected-nonce'),
    );
  }
  const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: TELEGRAM_ISSUER, aud: config.clientId, sub: 'opaque-subject', iat: now, exp: now + 300, nonce: 'expected-nonce' })).toString('base64url')}.`;
  await assert.rejects(service(unsigned).authenticate('code', 'verifier', 'expected-nonce'));
  const attacker = await generateKeyPair('RS256');
  await assert.rejects(
    service(await idToken({}, attacker.privateKey)).authenticate(
      'code',
      'verifier',
      'expected-nonce',
    ),
  );
});

test('Telegram transport refuses missing token and HTTP failure', async () => {
  for (const response of [
    new Response('{}', { status: 200 }),
    new Response('{}', { status: 401 }),
  ]) {
    const oidc = createTelegramOidc(config, {
      keys,
      fetch: (async () => response) as typeof fetch,
    });
    await assert.rejects(oidc.authenticate('code', 'verifier', 'nonce'));
  }
});

test('return path rejects external, protocol-relative and ambiguous redirects', () => {
  for (const path of [
    'https://evil.test',
    '//evil.test',
    '/\\evil.test',
    '/\nother',
    ['/', '/other'],
  ])
    assert.throws(() => safeReturnTo(path));
  assert.equal(
    safeReturnTo('/setlists/one?view=songs#selected'),
    '/setlists/one?view=songs#selected',
  );
  assert.equal(safeReturnTo(undefined), '/');
});
