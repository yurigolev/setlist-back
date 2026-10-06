import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { config } from '../config.js'
import { ensureBucket, storage } from '../storage.js'

type Entry = { key: string; checksum: string; size: number }
const [action, directory] = process.argv.slice(2)
if (!['backup', 'restore'].includes(action) || !directory) throw new Error('usage: objects.js backup|restore <directory>')

function safePath(key: string) {
  if (!/^attachments\/[0-9a-f-]+\/[0-9a-f-]+$/.test(key)) throw new Error(`Unsafe object key: ${key}`)
  const path = resolve(directory, key)
  if (!path.startsWith(resolve(directory) + '/')) throw new Error('Object path escapes backup directory')
  return path
}

async function digest(path: string) {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of createReadStream(path)) { const bytes = Buffer.from(chunk); hash.update(bytes); size += bytes.length }
  return { checksum: hash.digest('hex'), size }
}

await ensureBucket()
if (action === 'backup') {
  await mkdir(directory, { recursive: true })
  const entries: Entry[] = []
  for await (const object of storage.listObjectsV2(config.bucket, 'attachments/', true)) {
    if (!object.name) continue
    const path = safePath(object.name)
    await mkdir(resolve(path, '..'), { recursive: true })
    await storage.fGetObject(config.bucket, object.name, path)
    entries.push({ key: object.name, ...await digest(path) })
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(entries, null, 2))
  process.stdout.write(`Backed up ${entries.length} objects\n`)
} else {
  const entries = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Entry[]
  for (const entry of entries) {
    const path = safePath(entry.key)
    const actual = await digest(path)
    if (actual.checksum !== entry.checksum || actual.size !== entry.size) throw new Error(`Backup checksum mismatch: ${entry.key}`)
    await storage.fPutObject(config.bucket, entry.key, path)
  }
  process.stdout.write(`Restored ${entries.length} objects\n`)
}
