import assert from 'node:assert/strict';
import test from 'node:test';
import { createYandexOAuth, YandexOAuthError, YANDEX_ISSUER } from '../auth/yandex.js';
import type { AuthConfig } from '../auth/types.js';

const config: AuthConfig = {
  enabled: true,
  clientId: 'synthetic-client',
  clientSecret: 'synthetic-private-secret',
  redirectUri: 'https://app.example.test/v1/auth/yandex/callback',
  pwaOrigin: 'https://app.example.test',
  secureCookies: true,
  sessionTtlSeconds: 900,
};
const profile = {
  id: 'opaque-user-id',
  client_id: config.clientId,
  display_name: 'Display',
  real_name: 'Real',
  login: 'login',
};
const token = {
  access_token: 'synthetic-private-access',
  token_type: 'bearer',
  expires_in: 3600,
  refresh_token: 'synthetic-private-refresh',
};
function service(
  body: unknown = profile,
  tokenBody: unknown = token,
  inspect?: (input: Parameters<typeof fetch>[0], init?: RequestInit) => void,
) {
  let count = 0;
  return createYandexOAuth(config, {
    fetch: async (input, init) => {
      inspect?.(input, init);
      return Response.json(count++ === 0 ? tokenBody : body);
    },
  });
}

test('Yandex authorization uses code, exact callback, state and S256; token stays in server headers', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const provider = service(profile, token, (input, init) => {
    calls.push({ url: String(input), init: init! });
  });
  const url = new URL(
    provider.authorizationUrl('random-state', 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
  );
  assert.equal(url.origin, 'https://oauth.yandex.ru');
  assert.equal(url.pathname, '/authorize');
  assert.equal(url.searchParams.get('client_id'), config.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'login:info');
  assert.equal(url.searchParams.get('state'), 'random-state');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    url.searchParams.get('code_challenge'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
  assert.ok(!url.toString().includes(config.clientSecret));
  assert.equal(url.searchParams.has('nonce'), false);
  const identity = await provider.authenticate('one-use-code', 'verifier');
  assert.deepEqual(identity, {
    issuer: YANDEX_ISSUER,
    subject: profile.id,
    displayName: 'Display',
    username: 'login',
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, 'https://oauth.yandex.ru/token');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(
    new Headers(calls[0]!.init.headers).get('authorization'),
    `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
  );
  const form = calls[0]!.init.body as URLSearchParams;
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'one-use-code');
  assert.equal(form.get('code_verifier'), 'verifier');
  assert.equal(form.get('redirect_uri'), config.redirectUri);
  assert.equal(calls[1]!.url, 'https://login.yandex.ru/info?format=json');
  assert.equal(
    new Headers(calls[1]!.init.headers).get('authorization'),
    `OAuth ${token.access_token}`,
  );
  assert.ok(!calls[1]!.url.includes(token.access_token));
  for (const call of calls) {
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.init.signal instanceof AbortSignal);
  }
  assert.ok(!JSON.stringify(identity).includes(token.access_token));
  assert.ok(!JSON.stringify(identity).includes(token.refresh_token));
});

test('Yandex profile binds exact client and opaque string ID; names and email never determine identity', async () => {
  for (const invalid of [
    null,
    [],
    {},
    { ...profile, client_id: 'another-client' },
    { ...profile, client_id: undefined },
    { ...profile, id: undefined },
    { ...profile, id: 100001 },
    { ...profile, id: '' },
    { ...profile, id: ' ' },
    { ...profile, id: 'user\n' },
  ]) {
    await assert.rejects(service(invalid).authenticate('code', 'verifier'), (error: unknown) => {
      assert.ok(error instanceof YandexOAuthError);
      assert.equal(error.category, 'invalid');
      assert.deepEqual(error.diagnostic, { stage: 'profile_response', reason: 'invalid_profile' });
      return true;
    });
  }
  for (const [fields, name] of [
    [{ display_name: ' ', real_name: 'Real' }, 'Real'],
    [{ display_name: null, real_name: undefined }, 'login'],
    [
      {
        display_name: null,
        real_name: undefined,
        login: undefined,
        default_email: 'someone@example.test',
      },
      'Yandex user',
    ],
  ] as const) {
    const identity = await service({ ...profile, ...fields }).authenticate('code', 'verifier');
    assert.equal(identity.displayName, name);
    assert.equal(identity.subject, profile.id);
    assert.equal(identity.issuer, YANDEX_ISSUER);
    assert.equal('email' in identity, false);
  }
});

test('Yandex refuses malformed or unsafe tokens before requesting a profile', async () => {
  for (const body of [
    null,
    [],
    {},
    { ...token, access_token: '' },
    { ...token, access_token: 12 },
    { ...token, access_token: 'bad\r\nheader' },
    { ...token, token_type: undefined },
    { ...token, token_type: 'basic' },
  ]) {
    let count = 0;
    await assert.rejects(
      service(profile, body, () => {
        count++;
      }).authenticate('code', 'verifier'),
      (error: unknown) => {
        assert.ok(error instanceof YandexOAuthError);
        assert.equal(error.category, 'unavailable');
        assert.deepEqual(error.diagnostic, { stage: 'token_response', reason: 'invalid_token' });
        return true;
      },
    );
    assert.equal(count, 1);
  }
});

test('Yandex HTTP failure categories and diagnostics are safe at both endpoints', async () => {
  for (const profileFailure of [false, true])
    for (const status of [400, 401, 403, 429, 500, 503]) {
      let count = 0;
      const provider = createYandexOAuth(config, {
        fetch: async () => {
          if (profileFailure && count++ === 0) return Response.json(token);
          return Response.json(
            {
              error: 'invalid_grant',
              error_description: config.clientSecret,
              private: token.access_token,
            },
            { status },
          );
        },
      });
      await assert.rejects(
        provider.authenticate('private-code', 'private-verifier'),
        (error: unknown) => {
          assert.ok(error instanceof YandexOAuthError);
          assert.equal(error.category, status >= 500 || status === 429 ? 'unavailable' : 'invalid');
          assert.deepEqual(error.diagnostic, {
            stage: profileFailure ? 'profile_request' : 'token_exchange',
            reason: 'http_error',
            httpStatus: status,
            providerError: 'invalid_grant',
          });
          for (const secret of [
            config.clientSecret,
            token.access_token,
            'private-code',
            'private-verifier',
          ])
            assert.ok(!JSON.stringify(error).includes(secret));
          return true;
        },
      );
    }
  const provider = createYandexOAuth(config, {
    fetch: async () => Response.json({ error: token.access_token }, { status: 400 }),
  });
  await assert.rejects(provider.authenticate('code', 'verifier'), (error: unknown) => {
    assert.ok(error instanceof YandexOAuthError);
    assert.equal(error.diagnostic.providerError, undefined);
    return true;
  });
});

test('Yandex transport timeouts and malformed JSON are unavailable with no cause/body leakage', async () => {
  for (const profileFailure of [false, true])
    for (const failure of [
      new DOMException(config.clientSecret, 'TimeoutError'),
      new TypeError(config.clientSecret, {
        cause: new AggregateError([
          Object.assign(new Error(token.access_token), { code: 'ETIMEDOUT' }),
        ]),
      }),
    ]) {
      let count = 0;
      const provider = createYandexOAuth(config, {
        fetch: async () => {
          if (profileFailure && count++ === 0) return Response.json(token);
          throw failure;
        },
      });
      await assert.rejects(provider.authenticate('code', 'verifier'), (error: unknown) => {
        assert.ok(error instanceof YandexOAuthError);
        assert.equal(error.category, 'unavailable');
        assert.equal(error.diagnostic.stage, profileFailure ? 'profile_request' : 'token_exchange');
        assert.equal(error.diagnostic.reason, 'network_timeout');
        assert.equal(error.cause, undefined);
        assert.ok(!JSON.stringify(error).includes(config.clientSecret));
        assert.ok(!JSON.stringify(error).includes(token.access_token));
        return true;
      });
    }
  for (const profileFailure of [false, true]) {
    let count = 0;
    const provider = createYandexOAuth(config, {
      fetch: async () =>
        profileFailure && count++ === 0
          ? Response.json(token)
          : new Response('not JSON with private secret'),
    });
    await assert.rejects(provider.authenticate('code', 'verifier'), (error: unknown) => {
      assert.ok(error instanceof YandexOAuthError);
      assert.equal(error.category, 'unavailable');
      assert.deepEqual(error.diagnostic, {
        stage: profileFailure ? 'profile_response' : 'token_response',
        reason: 'invalid_json',
      });
      return true;
    });
  }
});
