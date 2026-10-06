import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import multipart from '@fastify/multipart'
import type { FastifyInstance } from 'fastify'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { attachments, LIBRARY_ID, libraries, songs } from '../db/schema.js'
import { ApiError } from '../errors.js'
import { removeObject, storage } from '../storage.js'

const uuid = z.string().uuid()
const media = {
  'image/png': { kind: 'image', signature: 8, test: (b: Buffer) => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  'image/jpeg': { kind: 'image', signature: 3, test: (b: Buffer) => b[0] === 255 && b[1] === 216 && b[2] === 255 },
  'image/webp': { kind: 'image', signature: 12, test: (b: Buffer) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' },
  'audio/mpeg': { kind: 'audio', signature: 3, test: (b: Buffer) => b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 255 && (b[1] & 0xe0) === 0xe0) },
} as const

function attachmentDto(row: typeof attachments.$inferSelect) {
  return { id: row.id, songId: row.songId, kind: row.kind, mimeType: row.mimeType, filename: row.filename, byteSize: row.byteSize, checksum: row.checksum, createdAt: row.createdAt.toISOString(), contentUrl: `/v1/attachments/${row.id}/content` }
}

function expectedRevision(header: unknown): number {
  const match = typeof header === 'string' ? header.match(/^(?:"(\d+)"|(\d+))$/) : null
  const value = Number(match?.[1] ?? match?.[2])
  if (!match || !Number.isSafeInteger(value) || value < 1) throw new ApiError(428, 'REVISION_REQUIRED', 'If-Match with the song revision is required')
  return value
}

export async function registerAttachmentRoutes(app: FastifyInstance) {
  await app.register(multipart, { limits: { files: 1, fileSize: Math.max(config.maxImageBytes, config.maxMp3Bytes) + 1, fields: 0 } })

  app.post('/v1/songs/:songId/attachments', async (request, reply) => {
    const songId = uuid.safeParse((request.params as { songId?: string }).songId)
    const attachmentId = uuid.safeParse(request.headers['x-attachment-id'])
    if (!songId.success || !attachmentId.success) throw new ApiError(400, 'INVALID_REQUEST', 'Valid songId and X-Attachment-Id are required')
    const revision = expectedRevision(request.headers['if-match'])
    const part = await request.file()
    if (!part) throw new ApiError(400, 'FILE_REQUIRED', 'A file is required')
    const format = media[part.mimetype as keyof typeof media]
    if (!format) throw new ApiError(415, 'UNSUPPORTED_FILE', 'PNG, JPEG, WebP or MP3 required')
    const limit = format.kind === 'audio' ? config.maxMp3Bytes : config.maxImageBytes
    const hash = createHash('sha256')
    let count = 0
    let prefix = Buffer.alloc(0)
    let checked = false
    const tempDir = await mkdtemp(join(tmpdir(), 'setlist-upload-'))
    const tempFile = join(tempDir, 'file')
    const validator = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      try {
        const bytes = Buffer.from(chunk)
        count += bytes.length
        if (count > limit) throw new ApiError(413, 'FILE_TOO_LARGE', `File exceeds ${limit} bytes`)
        hash.update(bytes)
        if (!checked) {
          prefix = Buffer.concat([prefix, bytes]).subarray(0, format.signature)
          if (prefix.length === format.signature) {
            if (!format.test(prefix)) throw new ApiError(415, 'INVALID_SIGNATURE', 'File signature does not match MIME type')
            checked = true
          }
        }
        callback(null, bytes)
      } catch (error) { callback(error as Error) }
    } })
    const objectKey = `attachments/${attachmentId.data}/${randomUUID()}`
    let committed = false
    try {
      await pipeline(part.file, validator, createWriteStream(tempFile))
      if (part.file.truncated) throw new ApiError(413, 'FILE_TOO_LARGE', `File exceeds ${limit} bytes`)
      if (request.raw.aborted) throw new ApiError(499, 'UPLOAD_ABORTED', 'Upload was interrupted')
      if (!checked) throw new ApiError(415, 'INVALID_SIGNATURE', 'File signature is incomplete')
      await storage.putObject(config.bucket, objectKey, createReadStream(tempFile), count, { 'Content-Type': part.mimetype })
      const checksum = hash.digest('hex')
      const result = await db.transaction(async tx => {
        await tx.execute(sql`SELECT id FROM libraries WHERE id = ${LIBRARY_ID} FOR UPDATE`)
        const [song] = await tx.select().from(songs).where(and(eq(songs.id, songId.data), eq(songs.libraryId, LIBRARY_ID), isNull(songs.deletedAt))).limit(1)
        if (!song) throw new ApiError(404, 'SONG_NOT_FOUND', 'Song was deleted or not found')
        const [existing] = await tx.select().from(attachments).where(eq(attachments.id, attachmentId.data)).limit(1)
        if (existing) {
          if (existing.deletedAt || existing.songId !== song.id || existing.checksum !== checksum || existing.byteSize !== count || existing.mimeType !== part.mimetype) throw new ApiError(409, 'ATTACHMENT_CONFLICT', 'Attachment id has different content')
          return { row: existing, replay: true }
        }
        if (song.revision !== revision) throw new ApiError(409, 'REVISION_CONFLICT', 'Song revision changed', song.revision)
        if (format.kind === 'audio') {
          const [audio] = await tx.select({ id: attachments.id }).from(attachments).where(and(eq(attachments.songId, song.id), eq(attachments.kind, 'audio'), isNull(attachments.deletedAt))).limit(1)
          if (audio) throw new ApiError(409, 'AUDIO_EXISTS', 'Delete the existing MP3 before uploading another')
        }
        const [row] = await tx.insert(attachments).values({ id: attachmentId.data, libraryId: LIBRARY_ID, songId: song.id, kind: format.kind, mimeType: part.mimetype, filename: part.filename.slice(0, 255), byteSize: count, checksum, objectKey }).returning()
        await tx.update(songs).set({ revision: song.revision + 1, updatedAt: new Date() }).where(eq(songs.id, song.id))
        await tx.update(libraries).set({ revision: sql`${libraries.revision} + 1` }).where(eq(libraries.id, LIBRARY_ID))
        return { row, replay: false }
      })
      committed = !result.replay
      reply.status(result.replay ? 200 : 201)
      return attachmentDto(result.row)
    } finally {
      if (!committed) await removeObject(objectKey).catch(error => request.log.error({ err: error, objectKey }, 'orphan cleanup failed'))
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  app.get('/v1/attachments/:id/content', async (request, reply) => {
    const id = uuid.safeParse((request.params as { id?: string }).id)
    if (!id.success) throw new ApiError(400, 'INVALID_REQUEST', 'Invalid attachment id')
    const [row] = await db.select({ attachment: attachments }).from(attachments).innerJoin(songs, eq(attachments.songId, songs.id)).where(and(eq(attachments.id, id.data), isNull(attachments.deletedAt), isNull(songs.deletedAt))).limit(1)
    if (!row) throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found')
    const stream = await storage.getObject(config.bucket, row.attachment.objectKey)
    reply.type(row.attachment.mimeType).header('content-length', row.attachment.byteSize).header('cache-control', 'private, no-store')
    return reply.send(stream)
  })

  app.delete('/v1/attachments/:id', async request => {
    const id = uuid.safeParse((request.params as { id?: string }).id)
    if (!id.success) throw new ApiError(400, 'INVALID_REQUEST', 'Invalid attachment id')
    const row = await db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM libraries WHERE id = ${LIBRARY_ID} FOR UPDATE`)
      const [file] = await tx.select().from(attachments).where(and(eq(attachments.id, id.data), isNull(attachments.deletedAt))).limit(1)
      if (!file) throw new ApiError(404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found')
      const [song] = await tx.select().from(songs).where(and(eq(songs.id, file.songId), isNull(songs.deletedAt))).limit(1)
      if (!song) throw new ApiError(404, 'SONG_NOT_FOUND', 'Song not found')
      await tx.update(attachments).set({ deletedAt: new Date() }).where(eq(attachments.id, file.id))
      await tx.update(songs).set({ revision: song.revision + 1, updatedAt: new Date() }).where(eq(songs.id, song.id))
      await tx.update(libraries).set({ revision: sql`${libraries.revision} + 1` }).where(eq(libraries.id, LIBRARY_ID))
      return file
    })
    await removeObject(row.objectKey).catch(error => request.log.error({ err: error, objectKey: row.objectKey }, 'object cleanup failed'))
    return { id: row.id, deleted: true }
  })
}
