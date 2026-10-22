import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { ApiError } from '../errors.js';
import type { AuthConfig, AuthSession, AuthStore, TelegramOidc } from './types.js';

export const SESSION_COOKIE = 'setlist_session';
export const REFRESH_COOKIE = 'setlist_refresh';
export const LOGIN_COOKIE = 'setlist_login';
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');
const validToken = (token: unknown): token is string =>
  typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
const authError = () => new ApiError(401, 'AUTH_REQUIRED', 'Authentication required');

export async function requireSession(
  request: FastifyRequest,
  store: AuthStore,
): Promise<AuthSession> {
  const token = request.cookies[SESSION_COOKIE];
  if (!validToken(token)) throw authError();
  const session = await store.getSession(tokenHash(token));
  if (!session) throw authError();
  return session;
}
export function requireCsrf(request: FastifyRequest, session: AuthSession, origin: string) {
  const token = request.headers['x-csrf-token'];
  if (
    request.headers.origin !== origin ||
    !validToken(token) ||
    token.length !== session.csrfToken.length ||
    !timingSafeEqual(Buffer.from(token), Buffer.from(session.csrfToken))
  )
    throw new ApiError(403, 'CSRF_INVALID', 'Request origin or CSRF token invalid');
}
export function safeReturnTo(value: unknown): string {
  if (value === undefined) return '/';
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    // eslint-disable-next-line no-control-regex -- Reject control characters in redirects.
    /[\\\u0000-\u0020\u007f]/.test(value)
  )
    throw new ApiError(400, 'INVALID_RETURN_TO', 'returnTo must be a relative application path');
  return value;
}
export async function registerAuthRoutes(
  app: FastifyInstance,
  dependencies: { config: AuthConfig; store: AuthStore; oidc: TelegramOidc },
) {
  const { config, store, oidc } = dependencies;
  await app.register(cookie);
  await app.register(async (authRoutes) => {
    const options = {
      path: '/',
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: config.secureCookies,
    };
    const refreshOptions = { ...options, path: '/v1/auth' };
    const refreshTtl = config.refreshTtlSeconds ?? 7776000;
    const publicSession = (session: AuthSession) => {
      const { id, displayName, username, picture } = session.user;
      return {
        user: {
          id,
          displayName,
          ...(username ? { username } : {}),
          ...(picture ? { picture } : {}),
        },
        csrfToken: session.csrfToken,
        refreshEnabled: Boolean(session.familyId),
      };
    };
    const refreshSession = async (request: FastifyRequest) => {
      const token = request.cookies[REFRESH_COOKIE];
      return validToken(token) ? store.getRefresh(tokenHash(token)) : undefined;
    };
    const enabled = () => {
      if (!config.enabled)
        throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Telegram authentication is not configured');
    };
    // Covers errors as well as success responses, including failed callback attempts.
    authRoutes.addHook('onRequest', async (_request, reply) => {
      reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
    });
    const attemptsByIp = new Map<string, { count: number; resetAt: number }>();
    authRoutes.get('/v1/auth/telegram/start', async (request, reply) => {
      if (!config.enabled)
        return reply.redirect(new URL('/login?authError=unavailable', config.pwaOrigin).toString());
      const now = Date.now();
      for (const [ip, entry] of attemptsByIp) if (entry.resetAt <= now) attemptsByIp.delete(ip);
      const entry = attemptsByIp.get(request.ip);
      if ((entry && entry.count >= 20) || (!entry && attemptsByIp.size >= 10000))
        throw new ApiError(429, 'LOGIN_RATE_LIMITED', 'Too many login attempts; retry in a minute');
      attemptsByIp.set(request.ip, {
        count: (entry?.count ?? 0) + 1,
        resetAt: entry?.resetAt ?? now + 60_000,
      });
      const returnTo = safeReturnTo((request.query as Record<string, unknown>).returnTo);
      const state = randomToken(),
        browser = randomToken(),
        verifier = randomToken(),
        nonce = randomToken();
      await store.createLogin({
        stateHash: tokenHash(state),
        browserHash: tokenHash(browser),
        verifier,
        nonce,
        returnTo,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
      reply.setCookie(LOGIN_COOKIE, browser, { ...options, maxAge: 600 });
      return reply.redirect(oidc.authorizationUrl(state, verifier, nonce));
    });
    authRoutes.get('/v1/auth/telegram/callback', async (request, reply) => {
      try {
        enabled();
        const query = request.query as Record<string, unknown>;
        const browser = request.cookies[LOGIN_COOKIE];
        reply.clearCookie(LOGIN_COOKIE, options);
        if (!validToken(query.state) || !validToken(browser))
          throw new ApiError(400, 'AUTH_CALLBACK_INVALID', 'Login attempt invalid or expired');
        const attempt = await store.consumeLogin(tokenHash(query.state), tokenHash(browser));
        if (
          !attempt ||
          typeof query.code !== 'string' ||
          !query.code ||
          query.code.length > 4096 ||
          query.error !== undefined
        )
          throw new ApiError(400, 'AUTH_CALLBACK_INVALID', 'Login attempt invalid or expired');
        let identity;
        try {
          identity = await oidc.authenticate(query.code, attempt.verifier, attempt.nonce);
        } catch {
          throw new ApiError(401, 'TELEGRAM_AUTH_INVALID', 'Telegram authentication failed');
        }
        const token = randomToken(),
          csrfToken = randomToken(),
          refreshToken = randomToken();
        const previousToken = request.cookies[SESSION_COOKIE];
        await store.createSession(
          identity,
          tokenHash(token),
          csrfToken,
          new Date(Date.now() + config.sessionTtlSeconds * 1000),
          validToken(previousToken) ? tokenHash(previousToken) : undefined,
          { hash: tokenHash(refreshToken), expiresAt: new Date(Date.now() + refreshTtl * 1000) },
          validToken(request.cookies[REFRESH_COOKIE])
            ? tokenHash(request.cookies[REFRESH_COOKIE]!)
            : undefined,
        );
        reply.setCookie(SESSION_COOKIE, token, { ...options, maxAge: config.sessionTtlSeconds });
        reply.setCookie(REFRESH_COOKIE, refreshToken, { ...refreshOptions, maxAge: refreshTtl });
        return reply.redirect(new URL(attempt.returnTo, config.pwaOrigin).toString());
      } catch (error) {
        reply.clearCookie(LOGIN_COOKIE, options);
        const category =
          error instanceof ApiError && error.statusCode < 500 ? 'invalid' : 'unavailable';
        return reply.redirect(new URL(`/login?authError=${category}`, config.pwaOrigin).toString());
      }
    });
    authRoutes.get('/v1/auth/session', async (request) => {
      enabled();
      const session = await requireSession(request, store);
      return publicSession(session);
    });
    authRoutes.get('/v1/auth/refresh-context', async (request) => {
      enabled();
      const session = await refreshSession(request);
      if (!session) throw authError();
      return publicSession(session);
    });
    authRoutes.post('/v1/auth/refresh', async (request, reply) => {
      enabled();
      const refreshToken = request.cookies[REFRESH_COOKIE];
      const accessToken = request.cookies[SESSION_COOKIE];
      const refresh = await refreshSession(request);
      const session = refresh ?? (await requireSession(request, store));
      requireCsrf(request, session, config.pwaOrigin);
      // Missing refresh must never upgrade an access token already belonging to a family.
      if (!refresh && session.familyId) throw authError();
      const access = randomToken(),
        nextRefresh = randomToken();
      const pair = {
        accessHash: tokenHash(access),
        accessExpiresAt: new Date(Date.now() + config.sessionTtlSeconds * 1000),
        refreshHash: tokenHash(nextRefresh),
        refreshExpiresAt: new Date(Date.now() + refreshTtl * 1000),
      };
      const result =
        refresh && validToken(refreshToken)
          ? await store.rotateRefresh(tokenHash(refreshToken), pair)
          : await store.bootstrapSession(tokenHash(accessToken!), pair);
      if (result.status === 'conflict')
        throw new ApiError(409, 'REFRESH_CONFLICT', 'Session was updated by another request');
      if (result.status !== 'rotated') throw authError();
      reply.setCookie(SESSION_COOKIE, access, { ...options, maxAge: config.sessionTtlSeconds });
      reply.setCookie(REFRESH_COOKIE, nextRefresh, { ...refreshOptions, maxAge: refreshTtl });
      return publicSession(result.session);
    });
    authRoutes.post('/v1/auth/logout', async (request, reply) => {
      enabled();
      const refresh = await refreshSession(request);
      const session = refresh ?? (await requireSession(request, store));
      requireCsrf(request, session, config.pwaOrigin);
      if (refresh) await store.revokeRefresh(tokenHash(request.cookies[REFRESH_COOKIE]!));
      else await store.deleteSession(tokenHash(request.cookies[SESSION_COOKIE]!));
      reply
        .clearCookie(SESSION_COOKIE, options)
        .clearCookie(REFRESH_COOKIE, refreshOptions)
        .clearCookie(LOGIN_COOKIE, options);
      return reply.status(204).send();
    });
  });
}
