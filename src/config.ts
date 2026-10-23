import { z } from 'zod';
import 'dotenv/config';

const schema = z.object({
  NODE_ENV: z.string().optional(),
  TRUSTED_PROXY_CHAIN: z
    .string()
    .default('')
    .transform((value) => (value ? value.split(',').map((host) => host.trim()) : []))
    .pipe(
      z.array(z.string().regex(/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/)).max(8),
    ),
  YANDEX_CLIENT_ID: z.string().optional(),
  YANDEX_CLIENT_SECRET: z.string().optional(),
  YANDEX_REDIRECT_URI: z.string().url().optional(),
  AUTH_ALLOW_INSECURE_LOCAL_HTTP: z.enum(['true', 'false']).default('false'),
  AUTH_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(2592000).default(900),
  AUTH_REFRESH_TTL_SECONDS: z.coerce.number().int().min(60).max(31536000).default(7776000),
  LEGACY_OWNER_YANDEX_SUB: z.string().min(1).optional(),
  LEGACY_OWNER_YANDEX_ISSUER: z.literal('https://login.yandex.ru').optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  PWA_ORIGIN: z.string().url(),
  MINIO_ENDPOINT: z.string().min(1),
  MINIO_PORT: z.coerce.number().int().min(1).max(65535).default(9000),
  MINIO_USE_SSL: z.enum(['true', 'false']).default('false'),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET: z.string().min(3).default('setlist-files'),
  MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(10485760),
  MAX_MP3_BYTES: z.coerce.number().int().positive().default(52428800),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success)
  throw new Error(
    `Invalid environment: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
  );
const env = parsed.data;
if (env.NODE_ENV === 'production' && !env.TRUSTED_PROXY_CHAIN.length)
  throw new Error('Production requires an explicit TRUSTED_PROXY_CHAIN (nearest API first)');
const localHttp = (url: URL) =>
  url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
const pwaUrl = new URL(env.PWA_ORIGIN);
if (pwaUrl.origin !== env.PWA_ORIGIN) throw new Error('PWA_ORIGIN must be an exact origin');
const redirectUrl = env.YANDEX_REDIRECT_URI ? new URL(env.YANDEX_REDIRECT_URI) : undefined;
const insecureLocal =
  env.AUTH_ALLOW_INSECURE_LOCAL_HTTP === 'true' &&
  localHttp(pwaUrl) &&
  (!redirectUrl || localHttp(redirectUrl));
if (env.AUTH_ALLOW_INSECURE_LOCAL_HTTP === 'true' && !insecureLocal)
  throw new Error('Insecure auth cookies are restricted to explicit localhost HTTP origins');
const authEnabled = Boolean(env.YANDEX_CLIENT_ID && env.YANDEX_CLIENT_SECRET && redirectUrl);
if (
  env.NODE_ENV === 'production' &&
  (!authEnabled ||
    insecureLocal ||
    redirectUrl?.origin !== pwaUrl.origin ||
    redirectUrl?.pathname !== '/v1/auth/yandex/callback')
)
  throw new Error(
    'Production requires Yandex credentials and the exact same-origin HTTPS callback /v1/auth/yandex/callback',
  );
if (
  authEnabled &&
  ((!insecureLocal && (pwaUrl.protocol !== 'https:' || redirectUrl!.protocol !== 'https:')) ||
    redirectUrl!.username ||
    redirectUrl!.password ||
    redirectUrl!.hash ||
    redirectUrl!.search)
)
  throw new Error('Yandex auth requires HTTPS URLs, except explicitly allowed localhost HTTP');
if (Boolean(env.LEGACY_OWNER_YANDEX_ISSUER) !== Boolean(env.LEGACY_OWNER_YANDEX_SUB))
  throw new Error('Legacy owner requires both explicit issuer and subject');
export const config = {
  trustedProxyChain: env.TRUSTED_PROXY_CHAIN,
  auth: {
    enabled: authEnabled,
    clientId: env.YANDEX_CLIENT_ID ?? '',
    clientSecret: env.YANDEX_CLIENT_SECRET ?? '',
    redirectUri: env.YANDEX_REDIRECT_URI ?? '',
    pwaOrigin: env.PWA_ORIGIN,
    secureCookies: !insecureLocal,
    sessionTtlSeconds: env.AUTH_SESSION_TTL_SECONDS,
    refreshTtlSeconds: env.AUTH_REFRESH_TTL_SECONDS,
    legacyOwnerIssuer: env.LEGACY_OWNER_YANDEX_ISSUER,
    legacyOwnerSub: env.LEGACY_OWNER_YANDEX_SUB,
  },
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  pwaOrigin: env.PWA_ORIGIN,
  minio: {
    endPoint: env.MINIO_ENDPOINT,
    port: env.MINIO_PORT,
    useSSL: env.MINIO_USE_SSL === 'true',
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
  },
  bucket: env.MINIO_BUCKET,
  maxImageBytes: env.MAX_IMAGE_BYTES,
  maxMp3Bytes: env.MAX_MP3_BYTES,
};
