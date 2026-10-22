import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/client.js';
import { PgAuthStore } from '../src/auth/store.js';
import { createTelegramOidc, TELEGRAM_ISSUER } from '../src/auth/oidc.js';
import type { TelegramOidc } from '../src/auth/types.js';

const port = Number(process.env.AUTH_QA_API_PORT);
const databaseUrl = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : undefined;
const pwaUrl = process.env.PWA_ORIGIN ? new URL(process.env.PWA_ORIGIN) : undefined;
const redirectUrl = process.env.TELEGRAM_REDIRECT_URI
  ? new URL(process.env.TELEGRAM_REDIRECT_URI)
  : undefined;
const qaProject = process.env.AUTH_QA_PROJECT_NAME ?? '';
const qaDatabaseName = process.env.AUTH_QA_DATABASE_NAME ?? '';
const qaDatabasePort = Number(process.env.AUTH_QA_PG_PORT);
const qaMinioPort = Number(process.env.AUTH_QA_MINIO_PORT);
const isLocal = (url: URL | undefined) =>
  Boolean(url && ['127.0.0.1', 'localhost'].includes(url.hostname));
if (process.env.NODE_ENV !== 'test') throw new Error('QA auth server requires NODE_ENV=test');
if (!qaProject.startsWith('setlist-auth-qa-'))
  throw new Error('AUTH_QA_PROJECT_NAME must use the isolated setlist-auth-qa-* namespace');
if (
  !/^setlist_auth_qa_[a-z0-9_]+$/.test(qaDatabaseName) ||
  databaseUrl?.pathname !== `/${qaDatabaseName}` ||
  !isLocal(databaseUrl) ||
  Number(databaseUrl?.port) !== qaDatabasePort ||
  qaDatabasePort === 5432
)
  throw new Error(
    'DATABASE_URL must target the explicit local QA-only PostgreSQL port and database',
  );
if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  port === 3300 ||
  Number(process.env.PORT) !== port
)
  throw new Error('AUTH_QA_API_PORT and PORT must be the same explicit non-shared TCP port');
if (!isLocal(pwaUrl) || Number(pwaUrl?.port) === 4173 || pwaUrl?.origin !== process.env.PWA_ORIGIN)
  throw new Error('PWA_ORIGIN must be an explicit exact localhost QA origin');
const apiCallback = Number(redirectUrl?.port) === port;
const sameOriginPwaCallback = redirectUrl?.origin === pwaUrl?.origin;
if (
  !isLocal(redirectUrl) ||
  (!apiCallback && !sameOriginPwaCallback) ||
  redirectUrl?.pathname !== '/v1/auth/telegram/callback' ||
  redirectUrl?.search ||
  redirectUrl?.hash
)
  throw new Error('TELEGRAM_REDIRECT_URI must use the explicit QA API or same-origin PWA callback');
if (
  !isLocal(
    process.env.MINIO_ENDPOINT ? new URL(`http://${process.env.MINIO_ENDPOINT}`) : undefined,
  ) ||
  Number(process.env.MINIO_PORT) !== qaMinioPort ||
  qaMinioPort === 9000 ||
  !(process.env.MINIO_BUCKET ?? '').startsWith('setlist-qa-')
)
  throw new Error('MinIO must use the explicit isolated QA endpoint, port, and bucket');

const { publicKey, privateKey } = await generateKeyPair('RS256');
const publicJwk = await exportJWK(publicKey);
const keys = createLocalJWKSet({
  keys: [{ ...publicJwk, kid: 'qa-local-key', alg: 'RS256', use: 'sig' }],
});
const grants = new Map<string, { verifier: string; nonce: string }>();
const qaUsers = {
  'qa-owner': { subject: config.auth.legacyOwnerSub ?? '', displayName: 'QA Owner' },
  'qa-outsider': { subject: 'qa-outsider-subject', displayName: 'QA Outsider' },
  'qa-invitee-a': { subject: 'qa-invitee-a-subject', displayName: 'QA Invitee A' },
  'qa-invitee-b': { subject: 'qa-invitee-b-subject', displayName: 'QA Invitee B' },
};
const codes = Object.keys(qaUsers);

const realOidc = createTelegramOidc(config.auth, {
  keys,
  fetch: async (input, init) => {
    if (String(input) !== `${TELEGRAM_ISSUER}/token` || init?.method !== 'POST')
      return new Response('Not found', { status: 404 });
    const body = new URLSearchParams(String(init.body ?? ''));
    const code = body.get('code') ?? '';
    const grant = grants.get(code);
    if (!grant || body.get('code_verifier') !== grant.verifier)
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    grants.delete(code);
    const user = qaUsers[code as keyof typeof qaUsers];
    if (!user?.subject)
      return Response.json({ error: 'QA identity fixture missing' }, { status: 500 });
    const id_token = await new SignJWT({
      nonce: grant.nonce,
      name: user.displayName,
      preferred_username: code,
      picture: 'https://example.invalid/qa-avatar.png',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'qa-local-key' })
      .setIssuer(TELEGRAM_ISSUER)
      .setSubject(user.subject)
      .setAudience(config.auth.clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    return Response.json({ id_token });
  },
});

// This mock records the verifier/nonce a provider binds to each authorization code.
// The production createTelegramOidc implementation still performs token exchange
// and RS256 issuer/audience/time/nonce/signature verification.
const oidc: TelegramOidc = {
  authorizationUrl(state, verifier, nonce) {
    for (const code of codes) grants.set(code, { verifier, nonce });
    const authorization = realOidc.authorizationUrl(state, verifier, nonce);
    if (process.env.AUTH_QA_BROWSER_LOGIN !== 'true') return authorization;
    const local = new URL('/v1/auth/qa/authorize', pwaUrl);
    local.search = new URL(authorization).search;
    return local.href;
  },
  authenticate: (code, verifier, nonce) => realOidc.authenticate(code, verifier, nonce),
};

const app = await buildApp({
  auth: { config: config.auth, store: new PgAuthStore(pool), oidc },
  initializeStorage: true,
});

if (process.env.AUTH_QA_BROWSER_LOGIN === 'true') {
  app.get<{ Querystring: { state?: string; redirect_uri?: string } }>(
    '/v1/auth/qa/authorize',
    async (request, reply) => {
      const { state, redirect_uri } = request.query;
      if (!state || redirect_uri !== config.auth.redirectUri)
        return reply.code(400).send({ error: 'Invalid QA authorization request' });
      const escape = (value: string) =>
        value
          .replaceAll('&', '&amp;')
          .replaceAll('"', '&quot;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;');
      const link = (code: string) => {
        const callback = new URL(redirect_uri);
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', state);
        return escape(callback.href);
      };
      const options = codes
        .map(
          (code) =>
            `<a href="${link(code)}">${escape(qaUsers[code as keyof typeof qaUsers].displayName)}</a>`,
        )
        .join('');
      return reply
        .header('Cache-Control', 'no-store')
        .header(
          'Content-Security-Policy',
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        )
        .type('text/html')
        .send(
          `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Локальный тестовый вход</title><style>body{background:#171d26;color:#fff;font:18px system-ui;max-width:480px;margin:12vh auto;padding:24px}a{display:block;padding:20px;margin:16px 0;background:#334155;color:#fff;border-radius:12px;text-decoration:none}p{color:#cbd5e1}</style><h1>Тестовый вход</h1><p>Локальная QA-среда. Настоящий Telegram не используется.</p>${options}</html>`,
        );
    },
  );
}

await app.listen({ host: '127.0.0.1', port });
process.stdout.write(`QA auth API listening on 127.0.0.1:${port}\n`);

async function close() {
  await app.close();
  await pool.end();
}
process.once('SIGINT', () => {
  void close().finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void close().finally(() => process.exit(0));
});
