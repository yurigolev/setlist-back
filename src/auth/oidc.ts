import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AuthConfig, TelegramOidc, VerifiedIdentity } from './types.js';

export const TELEGRAM_ISSUER = 'https://oauth.telegram.org';

const providerErrors = [
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'access_denied',
  'server_error',
  'temporarily_unavailable',
] as const;
const joseCodes = [
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_EXPIRED',
  'ERR_JWT_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWS_INVALID',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
  'ERR_JWKS_INVALID',
  'ERR_JWK_INVALID',
  'ERR_JWKS_TIMEOUT',
] as const;
const claims = ['iss', 'aud', 'sub', 'iat', 'exp', 'nbf', 'nonce', 'azp'] as const;
const transportCodes = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
] as const;
function allowed<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && values.includes(value as T) ? (value as T) : undefined;
}
function transportCode(error: unknown, depth = 0): (typeof transportCodes)[number] | undefined {
  if (!error || typeof error !== 'object' || depth > 3) return;
  const details = error as { code?: unknown; cause?: unknown; errors?: unknown };
  const code = allowed(transportCodes, details.code);
  if (code) return code;
  const cause = transportCode(details.cause, depth + 1);
  if (cause) return cause;
  if (Array.isArray(details.errors))
    for (const item of details.errors.slice(0, 10)) {
      const nested = transportCode(item, depth + 1);
      if (nested) return nested;
    }
}

export interface TelegramOidcDiagnostic {
  stage: 'token_exchange' | 'token_response' | 'id_token';
  reason:
    | 'network_timeout'
    | 'network_error'
    | 'http_error'
    | 'invalid_json'
    | 'missing_id_token'
    | 'jwt_error'
    | 'invalid_claims';
  httpStatus?: number;
  providerError?: (typeof providerErrors)[number];
  joseCode?: (typeof joseCodes)[number];
  claim?: (typeof claims)[number];
  transportCode?: (typeof transportCodes)[number] | 'UNKNOWN';
}

/** Only fixed diagnostic enums cross this boundary; provider bodies/causes are never retained. */
export class TelegramOidcError extends Error {
  readonly diagnostic: Readonly<TelegramOidcDiagnostic>;
  constructor(
    readonly category: 'invalid' | 'unavailable',
    diagnostic: TelegramOidcDiagnostic,
  ) {
    super('Telegram authentication failed');
    this.name = 'TelegramOidcError';
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

function networkError(error: unknown, stage: TelegramOidcDiagnostic['stage']) {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
  const code = transportCode(error) ?? 'UNKNOWN';
  return new TelegramOidcError('unavailable', {
    stage,
    reason:
      name === 'AbortError' || name === 'TimeoutError' || code === 'ETIMEDOUT'
        ? 'network_timeout'
        : 'network_error',
    transportCode: code,
  });
}

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
      let response: Response;
      try {
        response = await transport(`${TELEGRAM_ISSUER}/token`, {
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
      } catch (error) {
        throw networkError(error, 'token_exchange');
      }
      if (!response.ok) {
        const failure: unknown = await response.json().catch(() => undefined);
        const providerError = allowed(
          providerErrors,
          failure && typeof failure === 'object' && 'error' in failure ? failure.error : undefined,
        );
        throw new TelegramOidcError(
          response.status >= 500 ||
            response.status === 429 ||
            providerError === 'server_error' ||
            providerError === 'temporarily_unavailable'
            ? 'unavailable'
            : 'invalid',
          {
            stage: 'token_exchange',
            reason: 'http_error',
            httpStatus: response.status,
            ...(providerError ? { providerError } : {}),
          },
        );
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw networkError(error, 'token_response');
        throw new TelegramOidcError('unavailable', {
          stage: 'token_response',
          reason: 'invalid_json',
        });
      }
      if (
        !body ||
        typeof body !== 'object' ||
        !('id_token' in body) ||
        typeof body.id_token !== 'string'
      )
        throw new TelegramOidcError('unavailable', {
          stage: 'token_response',
          reason: 'missing_id_token',
        });
      let payload;
      try {
        ({ payload } = await jwtVerify(body.id_token, keys, {
          issuer: TELEGRAM_ISSUER,
          audience: config.clientId,
          algorithms: ['RS256'],
          requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
          maxTokenAge: '10 minutes',
          clockTolerance: 5,
        }));
      } catch (error) {
        const details =
          error && typeof error === 'object' ? (error as { code?: unknown; claim?: unknown }) : {};
        const joseCode = allowed(joseCodes, details.code);
        if (!joseCode) throw networkError(error, 'id_token');
        const claim = allowed(claims, details.claim);
        const keysUnavailable = [
          'ERR_JWKS_TIMEOUT',
          'ERR_JWKS_INVALID',
          'ERR_JWK_INVALID',
          'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
        ].includes(joseCode);
        throw new TelegramOidcError(keysUnavailable ? 'unavailable' : 'invalid', {
          stage: 'id_token',
          reason: joseCode === 'ERR_JWKS_TIMEOUT' ? 'network_timeout' : 'jwt_error',
          joseCode,
          ...(claim ? { claim } : {}),
        });
      }
      if (
        typeof payload.sub !== 'string' ||
        !payload.sub ||
        payload.nonce !== nonce ||
        (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId)
      )
        throw new TelegramOidcError('invalid', {
          stage: 'id_token',
          reason: 'invalid_claims',
          claim:
            typeof payload.sub !== 'string' || !payload.sub
              ? 'sub'
              : payload.nonce !== nonce
                ? 'nonce'
                : 'azp',
        });
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
