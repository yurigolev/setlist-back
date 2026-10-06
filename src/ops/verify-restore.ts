import { and, eq, isNull } from 'drizzle-orm'
import { db, pool } from '../db/client.js'
import { attachments, LIBRARY_ID, libraries, songs } from '../db/schema.js'
import { config } from '../config.js'
import { storage } from '../storage.js'
import { createHash } from 'node:crypto'

try {
  const [library] = await db.select().from(libraries).where(eq(libraries.id, LIBRARY_ID))
  if (!library) throw new Error('Library missing')
  const activeSongs = await db.select().from(songs).where(and(eq(songs.libraryId, LIBRARY_ID), isNull(songs.deletedAt)))
  const files = await db.select({ file: attachments, song: songs }).from(attachments).innerJoin(songs, eq(attachments.songId, songs.id)).where(and(isNull(attachments.deletedAt), isNull(songs.deletedAt)))
  for (const { file } of files) {
    const stat = await storage.statObject(config.bucket, file.objectKey)
    if (stat.size !== file.byteSize) throw new Error(`Size mismatch for ${file.id}`)
    const hash = createHash('sha256')
    for await (const chunk of await storage.getObject(config.bucket, file.objectKey)) hash.update(chunk)
    if (hash.digest('hex') !== file.checksum) throw new Error(`Checksum mismatch for ${file.id}`)
  }
  process.stdout.write(`Verified library revision ${library.revision}, ${activeSongs.length} songs, ${files.length} attachments\n`)
} finally { await pool.end() }
