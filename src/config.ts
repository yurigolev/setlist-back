import { z } from 'zod'
import 'dotenv/config'

const schema = z.object({
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
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`)
const env = parsed.data
export const config = {
  port: env.PORT,
  databaseUrl: env.DATABASE_URL,
  pwaOrigin: env.PWA_ORIGIN,
  minio: { endPoint: env.MINIO_ENDPOINT, port: env.MINIO_PORT, useSSL: env.MINIO_USE_SSL === 'true', accessKey: env.MINIO_ACCESS_KEY, secretKey: env.MINIO_SECRET_KEY },
  bucket: env.MINIO_BUCKET,
  maxImageBytes: env.MAX_IMAGE_BYTES,
  maxMp3Bytes: env.MAX_MP3_BYTES,
}
