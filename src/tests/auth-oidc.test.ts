import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalJWKSet, errors, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createTelegramOidc, TelegramOidcError, TELEGRAM_ISSUER } from '../auth/oidc.js';
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

test('Telegram exchange exposes only fixed HTTP diagnostics and allowlisted provider errors', async () => {
  const privateValue = 'private-provider-body-token-and-identity';
  for (const [status, provider, category] of [
    [400, 'invalid_grant', 'invalid'],
    [401, 'invalid_client', 'invalid'],
    [429, 'temporarily_unavailable', 'unavailable'],
    [503, 'server_error', 'unavailable'],
    [400, privateValue, 'invalid'],
  ] as const) {
    const oidc = createTelegramOidc(config, {
      keys,
      fetch: (async () =>
        new Response(
          JSON.stringify({
            error: provider,
            error_description: privateValue,
            id_token: privateValue,
          }),
          { status },
        )) as typeof fetch,
    });
    await assert.rejects(
      oidc.authenticate(privateValue, privateValue, privateValue),
      (error: unknown) => {
        assert.ok(error instanceof TelegramOidcError);
        assert.equal(error.category, category);
        assert.deepEqual(error.diagnostic, {
          stage: 'token_exchange',
          reason: 'http_error',
          httpStatus: status,
          ...(provider === privateValue ? {} : { providerError: provider }),
        });
        assert.equal('cause' in error, false);
        assert.equal(JSON.stringify(error).includes(privateValue), false);
        assert.equal(error.message.includes(privateValue), false);
        return true;
      },
    );
  }
});

test('Telegram network failures classify timeout and nested transport codes without leaking causes', async () => {
  const privateValue = 'private-network-message-or-request';
  const failures = [
    {
      error: new DOMException(privateValue, 'TimeoutError'),
      reason: 'network_timeout',
      code: 'UNKNOWN',
    },
    {
      error: new TypeError(privateValue, { cause: { code: 'ECONNRESET', message: privateValue } }),
      reason: 'network_error',
      code: 'ECONNRESET',
    },
    {
      error: new TypeError(privateValue, {
        cause: new AggregateError(
          [Object.assign(new Error(privateValue), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })],
          privateValue,
        ),
      }),
      reason: 'network_error',
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    },
    {
      error: new TypeError(privateValue, { cause: { code: privateValue } }),
      reason: 'network_error',
      code: 'UNKNOWN',
    },
    {
      error: new TypeError(privateValue, { cause: { code: 'ETIMEDOUT' } }),
      reason: 'network_timeout',
      code: 'ETIMEDOUT',
    },
  ];
  for (const failure of failures) {
    const oidc = createTelegramOidc(config, {
      keys,
      fetch: (async () => {
        throw failure.error;
      }) as typeof fetch,
    });
    await assert.rejects(oidc.authenticate('code', 'verifier', 'nonce'), (error: unknown) => {
      assert.ok(error instanceof TelegramOidcError);
      assert.equal(error.category, 'unavailable');
      assert.deepEqual(error.diagnostic, {
        stage: 'token_exchange',
        reason: failure.reason,
        transportCode: failure.code,
      });
      assert.equal('cause' in error, false);
      assert.equal(JSON.stringify(error).includes(privateValue), false);
      return true;
    });
  }
});

test('Telegram JWT diagnostics retain code and claim names, never token or claim values', async () => {
  const privateValue = 'private-claim-value';
  const token = await idToken({ nonce: privateValue });
  for (const [oidc, diagnostic] of [
    [service(token), { stage: 'id_token', reason: 'invalid_claims', claim: 'nonce' }],
    [
      service(await idToken({ aud: privateValue })),
      {
        stage: 'id_token',
        reason: 'jwt_error',
        joseCode: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
        claim: 'aud',
      },
    ],
    [
      service(await idToken({ nonce: undefined })),
      {
        stage: 'id_token',
        reason: 'jwt_error',
        joseCode: 'ERR_JWT_CLAIM_VALIDATION_FAILED',
        claim: 'nonce',
      },
    ],
  ] as const) {
    await assert.rejects(
      oidc.authenticate('code', 'verifier', 'expected-nonce'),
      (error: unknown) => {
        assert.ok(error instanceof TelegramOidcError);
        assert.equal(error.category, 'invalid');
        assert.deepEqual(error.diagnostic, diagnostic);
        assert.equal('cause' in error, false);
        assert.equal(JSON.stringify(error).includes(privateValue), false);
        assert.equal(JSON.stringify(error).includes(token), false);
        return true;
      },
    );
  }
});

test('Telegram malformed responses and JWKS outages remain unavailable with sanitized diagnostics', async () => {
  for (const [body, reason] of [
    ['not JSON', 'invalid_json'],
    ['{}', 'missing_id_token'],
  ] as const) {
    const oidc = createTelegramOidc(config, {
      keys,
      fetch: (async () => new Response(body, { status: 200 })) as typeof fetch,
    });
    await assert.rejects(oidc.authenticate('code', 'verifier', 'nonce'), (error: unknown) => {
      assert.ok(error instanceof TelegramOidcError);
      assert.equal(error.category, 'unavailable');
      assert.deepEqual(error.diagnostic, { stage: 'token_response', reason });
      return true;
    });
  }
  const token = await idToken();
  const oidc = createTelegramOidc(config, {
    keys: async () => {
      throw new errors.JWKSTimeout('private-JWKS-message');
    },
    fetch: (async () =>
      new Response(JSON.stringify({ id_token: token }), { status: 200 })) as typeof fetch,
  });
  await assert.rejects(oidc.authenticate('code', 'verifier', 'nonce'), (error: unknown) => {
    assert.ok(error instanceof TelegramOidcError);
    assert.equal(error.category, 'unavailable');
    assert.deepEqual(error.diagnostic, {
      stage: 'id_token',
      reason: 'network_timeout',
      joseCode: 'ERR_JWKS_TIMEOUT',
    });
    assert.equal(JSON.stringify(error).includes('private-JWKS-message'), false);
    return true;
  });
  for (const code of ['ERR_JWKS_INVALID', 'ERR_JWK_INVALID', 'ERR_JWKS_MULTIPLE_MATCHING_KEYS']) {
    const invalidKeys = createTelegramOidc(config, {
      keys: async () => {
        throw Object.assign(new Error('private-key-provider-response'), { code });
      },
      fetch: (async () =>
        new Response(JSON.stringify({ id_token: token }), { status: 200 })) as typeof fetch,
    });
    await assert.rejects(
      invalidKeys.authenticate('code', 'verifier', 'nonce'),
      (error: unknown) => {
        assert.ok(error instanceof TelegramOidcError);
        assert.equal(error.category, 'unavailable');
        assert.equal(error.diagnostic.joseCode, code);
        assert.equal(JSON.stringify(error).includes('private-key-provider-response'), false);
        return true;
      },
    );
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
