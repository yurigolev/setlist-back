import Fastify from 'fastify'
import { readFile } from 'node:fs/promises'
import cors from '@fastify/cors'
import { config } from './config.js'
import { registerErrors } from './errors.js'
import { registerSongRoutes } from './routes/songs.js'
import { ensureBucket, reconcileOrphans } from './storage.js'
import { registerAttachmentRoutes } from './routes/attachments.js'
import { db } from './db/client.js'
import { sql } from 'drizzle-orm'
import { storage } from './storage.js'
import { ApiError } from './errors.js'

export async function buildApp() {
  const app = Fastify({ logger: { redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'] }, requestIdHeader: 'x-request-id' })
  registerErrors(app)
  await app.register(cors, { origin: config.pwaOrigin })
  app.get('/health', async () => {
    try {
      await db.execute(sql`select 1`)
      if (!(await storage.bucketExists(config.bucket))) throw new Error('bucket unavailable')
      return { status: 'ok' }
    } catch {
      throw new ApiError(503, 'NOT_READY', 'Database or object storage unavailable')
    }
  })
  app.get('/openapi.yaml', async (_request, reply) => reply.type('application/yaml').send(await readFile(new URL('../openapi.yaml', import.meta.url), 'utf8')))
  registerSongRoutes(app)
  await registerAttachmentRoutes(app)
  await ensureBucket()
  await reconcileOrphans()
  return app
}
