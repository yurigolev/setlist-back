import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AuthConfig, TelegramOidc, VerifiedIdentity } from './types.js';

export const TELEGRAM_ISSUER = 'https://oauth.telegram.org';

/** Dependencies are injected only by trusted application code, never request or environment data. */
export function createTelegramOidc(
  config: AuthConfig,
  dependencies: { fetch?: typeof fetch; keys?: JWTVerifyGetKey } = {},
): TelegramOidc {
  const transport = dependencies.fetch ?? fetch;
  const keys =
    dependencies.keys ??
    createRemoteJWKSet(new URL(`${TELEGRAM_ISSUER}/.well-known/jwks.json`), {
      timeoutDuration: 5000,
    });
  return {
    authorizationUrl(state, verifier, nonce) {
      const url = new URL(`${TELEGRAM_ISSUER}/auth`);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        scope: 'openid profile',
        state,
        nonce,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString();
      return url.toString();
    },
    async authenticate(code, verifier, nonce): Promise<VerifiedIdentity> {
      const response = await transport(`${TELEGRAM_ISSUER}/token`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: config.redirectUri,
          client_id: config.clientId,
          code_verifier: verifier,
        }),
      });
      if (!response.ok) throw new Error('Telegram token exchange failed');
      const body: unknown = await response.json();
      if (
        !body ||
        typeof body !== 'object' ||
        !('id_token' in body) ||
        typeof body.id_token !== 'string'
      )
        throw new Error('Telegram ID token missing');
      const { payload } = await jwtVerify(body.id_token, keys, {
        issuer: TELEGRAM_ISSUER,
        audience: config.clientId,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
        maxTokenAge: '10 minutes',
        clockTolerance: 5,
      });
      if (
        typeof payload.sub !== 'string' ||
        !payload.sub ||
        payload.nonce !== nonce ||
        (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId)
      )
        throw new Error('Telegram identity claims invalid');
      const displayName =
        typeof payload.name === 'string' && payload.name.trim()
          ? payload.name.slice(0, 200)
          : 'Telegram user';
      const username =
        typeof payload.preferred_username === 'string'
          ? payload.preferred_username.slice(0, 200)
          : undefined;
      const picture =
        typeof payload.picture === 'string' && payload.picture.startsWith('https://')
          ? payload.picture.slice(0, 2048)
          : undefined;
      return {
        issuer: TELEGRAM_ISSUER,
        subject: payload.sub,
        displayName,
        ...(username ? { username } : {}),
        ...(picture ? { picture } : {}),
      };
    },
  };
}
