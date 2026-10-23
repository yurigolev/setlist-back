import { createHash } from 'node:crypto';
import type { AuthConfig, YandexOAuth, VerifiedIdentity } from './types.js';

export const YANDEX_ISSUER = 'https://login.yandex.ru';
const AUTHORIZATION_ENDPOINT = 'https://oauth.yandex.ru/authorize';
const TOKEN_ENDPOINT = 'https://oauth.yandex.ru/token';
const PROFILE_ENDPOINT = `${YANDEX_ISSUER}/info?format=json`;

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

export interface YandexOAuthDiagnostic {
  stage: 'token_exchange' | 'token_response' | 'profile_request' | 'profile_response';
  reason:
    | 'network_timeout'
    | 'network_error'
    | 'http_error'
    | 'invalid_json'
    | 'invalid_token'
    | 'invalid_profile';
  httpStatus?: number;
  providerError?: (typeof providerErrors)[number];
  transportCode?: (typeof transportCodes)[number] | 'UNKNOWN';
}

/** Only fixed diagnostic enums cross this boundary; provider bodies/causes are never retained. */
export class YandexOAuthError extends Error {
  readonly diagnostic: Readonly<YandexOAuthDiagnostic>;
  constructor(
    readonly category: 'invalid' | 'unavailable',
    diagnostic: YandexOAuthDiagnostic,
  ) {
    super('Yandex authentication failed');
    this.name = 'YandexOAuthError';
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}
function networkError(error: unknown, stage: YandexOAuthDiagnostic['stage']) {
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
  const code = transportCode(error) ?? 'UNKNOWN';
  return new YandexOAuthError('unavailable', {
    stage,
    reason:
      name === 'AbortError' || name === 'TimeoutError' || code === 'ETIMEDOUT'
        ? 'network_timeout'
        : 'network_error',
    transportCode: code,
  });
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
async function json(response: Response, stage: YandexOAuthDiagnostic['stage']): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw networkError(error, stage);
    throw new YandexOAuthError('unavailable', { stage, reason: 'invalid_json' });
  }
}
/** Dependencies are injected only by trusted application code, never request or environment data. */
export function createYandexOAuth(
  config: AuthConfig,
  dependencies: { fetch?: typeof fetch } = {},
): YandexOAuth {
  const transport = dependencies.fetch ?? fetch;
  const request = async (
    url: string,
    init: RequestInit,
    stage: 'token_exchange' | 'profile_request',
  ) => {
    let response: Response;
    try {
      response = await transport(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw networkError(error, stage);
    }
    if (!response.ok) {
      const failure: unknown = await response.json().catch(() => undefined);
      const providerError = allowed(providerErrors, record(failure) ? failure.error : undefined);
      throw new YandexOAuthError(
        response.status >= 500 ||
          response.status === 429 ||
          providerError === 'server_error' ||
          providerError === 'temporarily_unavailable'
          ? 'unavailable'
          : 'invalid',
        {
          stage,
          reason: 'http_error',
          httpStatus: response.status,
          ...(providerError ? { providerError } : {}),
        },
      );
    }
    return response;
  };
  return {
    authorizationUrl(state, verifier) {
      const url = new URL(AUTHORIZATION_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        scope: 'login:info',
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString();
      return url.toString();
    },
    async authenticate(code, verifier): Promise<VerifiedIdentity> {
      const response = await request(
        TOKEN_ENDPOINT,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: config.redirectUri,
            code_verifier: verifier,
          }),
        },
        'token_exchange',
      );
      const token = await json(response, 'token_response');
      if (
        !record(token) ||
        typeof token.access_token !== 'string' ||
        !token.access_token ||
        token.access_token.length > 16384 ||
        // eslint-disable-next-line no-control-regex -- Tokens must be safe in an HTTP header.
        /[\s\u0000-\u001f\u007f]/.test(token.access_token) ||
        typeof token.token_type !== 'string' ||
        token.token_type.toLowerCase() !== 'bearer'
      )
        throw new YandexOAuthError('unavailable', {
          stage: 'token_response',
          reason: 'invalid_token',
        });
      // A server-to-server TLS response binds the profile to this token and client.
      // Never send the token in URLs or retain the provider refresh token.
      const profile = await json(
        await request(
          PROFILE_ENDPOINT,
          {
            method: 'GET',
            headers: { authorization: `OAuth ${token.access_token}` },
          },
          'profile_request',
        ),
        'profile_response',
      );
      if (
        !record(profile) ||
        profile.client_id !== config.clientId ||
        typeof profile.id !== 'string' ||
        !profile.id.trim() ||
        profile.id.length > 255 ||
        // eslint-disable-next-line no-control-regex -- An opaque identity cannot contain whitespace/control bytes.
        /[\s\u0000-\u001f\u007f]/.test(profile.id)
      )
        throw new YandexOAuthError('invalid', {
          stage: 'profile_response',
          reason: 'invalid_profile',
        });
      const text = (value: unknown) =>
        typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : undefined;
      const username = text(profile.login);
      return {
        issuer: YANDEX_ISSUER,
        subject: profile.id,
        displayName:
          text(profile.display_name) ?? text(profile.real_name) ?? username ?? 'Yandex user',
        ...(username ? { username } : {}),
      };
    },
  };
}
