import Fastify from 'fastify';
import { readFile } from 'node:fs/promises';
import cors from '@fastify/cors';
import { config } from './config.js';
import { registerErrors } from './errors.js';
import { registerSongRoutes } from './routes/songs.js';
import { ensureBucket, reconcileOrphans } from './storage.js';
import { registerAttachmentRoutes } from './routes/attachments.js';
import { db, pool } from './db/client.js';
import { registerAuthRoutes } from './auth/routes.js';
import { PgAuthStore } from './auth/store.js';
import { createYandexOAuth } from './auth/yandex.js';
import type { AuthConfig, AuthStore, YandexOAuth } from './auth/types.js';
import { authorizeScope, registerPrivateAuthorization } from './auth/permissions.js';
import { registerSetlistRoutes } from './routes/setlists.js';
import { sql } from 'drizzle-orm';
import { storage } from './storage.js';
import { ApiError } from './errors.js';
import { createProxyTrust } from './proxy.js';

export async function buildApp(
  dependencies: {
    auth?: { config: AuthConfig; store: AuthStore; provider: YandexOAuth };
    initializeStorage?: boolean;
  } = {},
) {
  const proxies = createProxyTrust(config.trustedProxyChain);
  const app = Fastify({
    trustProxy: proxies.trustProxy,
    logger: {
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
      ],
      serializers: {
        req: (req) => ({ method: req.method, url: req.url?.split('?')[0], id: req.id }),
      },
    },
    requestIdHeader: 'x-request-id',
  });
  registerErrors(app);
  proxies.register(app);
  await app.register(cors, {
    origin: config.pwaOrigin,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  const auth = dependencies.auth ?? {
    config: config.auth,
    store: new PgAuthStore(pool),
    provider: createYandexOAuth(config.auth),
  };
  await registerAuthRoutes(app, auth);
  app.get('/health', async () => {
    try {
      await db.execute(sql`select 1`);
      if (!(await storage.bucketExists(config.bucket))) throw new Error('bucket unavailable');
      return { status: 'ok' };
    } catch {
      throw new ApiError(503, 'NOT_READY', 'Database or object storage unavailable');
    }
  });
  app.get('/openapi.yaml', async (_request, reply) =>
    reply
      .type('application/yaml')
      .send(await readFile(new URL('../openapi.yaml', import.meta.url), 'utf8')),
  );
  await app.register(async (protectedRoutes) => {
    registerPrivateAuthorization(protectedRoutes, auth.store, auth.config);
    registerSetlistRoutes(protectedRoutes, auth.config);
    const authorize = (
      request: import('fastify').FastifyRequest,
      tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    ) => authorizeScope(request, tx, auth.config);
    registerSongRoutes(protectedRoutes, false, authorize);
    await registerAttachmentRoutes(protectedRoutes, false, authorize);
    await protectedRoutes.register(async (scoped) => {
      registerSongRoutes(scoped, true, authorize);
      await registerAttachmentRoutes(scoped, true, authorize);
    });
  });
  if (dependencies.initializeStorage !== false) {
    await ensureBucket();
    await reconcileOrphans();
  }
  return app;
}
