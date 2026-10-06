import { Client } from 'minio'
import { eq } from 'drizzle-orm'
import { config } from './config.js'
import { db } from './db/client.js'
import { attachments } from './db/schema.js'

export const storage = new Client(config.minio)

export async function ensureBucket() {
  if (!(await storage.bucketExists(config.bucket))) await storage.makeBucket(config.bucket)
  try {
    const policy = await storage.getBucketPolicy(config.bucket)
    if (policy) throw new Error('Configured bucket must not have a public policy')
  } catch (error) {
    if ((error as { code?: string }).code !== 'NoSuchBucketPolicy') throw error
  }
}

export async function removeObject(key: string) {
  await storage.removeObject(config.bucket, key)
}

export async function reconcileOrphans() {
  for await (const item of storage.listObjectsV2(config.bucket, 'attachments/', true)) {
    if (!item.name) continue
    const found = await db.select({ id: attachments.id }).from(attachments).where(eq(attachments.objectKey, item.name)).limit(1)
    if (found.length === 0 || (await db.select({ deletedAt: attachments.deletedAt }).from(attachments).where(eq(attachments.objectKey, item.name)).limit(1))[0]?.deletedAt) await removeObject(item.name)
  }
}
