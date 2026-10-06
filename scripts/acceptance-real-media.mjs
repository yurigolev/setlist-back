import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const directory = process.argv[2]
if (!directory) throw new Error('Usage: API_URL=http://localhost:3000 node scripts/acceptance-real-media.mjs <media-directory>')
const base = process.env.API_URL ?? 'http://127.0.0.1:3000'
const cases = [['sample.png', 'image/png'], ['sample.jpg', 'image/jpeg'], ['sample.webp', 'image/webp'], ['sample.mp3', 'audio/mpeg']]
const created = await fetch(`${base}/v1/songs`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ title: 'Media acceptance', artist: 'Test' }) })
assert.equal(created.status, 201)
const song = await created.json()
let revision = song.revision
try {
  for (const [filename, mime] of cases) {
    const bytes = await readFile(join(directory, filename))
    const form = new FormData()
    form.set('file', new Blob([bytes], { type: mime }), filename)
    const response = await fetch(`${base}/v1/songs/${song.id}/attachments`, { method: 'POST', headers: { 'if-match': `"${revision}"`, 'x-attachment-id': randomUUID() }, body: form })
    if (response.status !== 201) throw new Error(`${filename}: ${response.status} ${await response.text()}`)
    const attachment = await response.json()
    assert.equal(attachment.mimeType, mime)
    assert.equal(attachment.byteSize, bytes.length)
    assert.equal(attachment.checksum, createHash('sha256').update(bytes).digest('hex'))
    const content = await fetch(`${base}${attachment.contentUrl}`)
    assert.equal(content.status, 200)
    assert.equal(content.headers.get('content-type'), mime)
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes)
    revision++
  }
  const snapshot = await (await fetch(`${base}/v1/library/snapshot`)).json()
  const saved = snapshot.songs.find(item => item.id === song.id)
  assert.equal(saved.attachments.length, 4)
  assert.equal(saved.revision, revision)
  const oversized = Buffer.concat([await readFile(join(directory, 'sample.png')), Buffer.alloc(10 * 1024 * 1024)])
  const form = new FormData()
  form.set('file', new Blob([oversized], { type: 'image/png' }), 'oversized.png')
  const tooLarge = await fetch(`${base}/v1/songs/${song.id}/attachments`, { method: 'POST', headers: { 'if-match': `"${revision}"`, 'x-attachment-id': randomUUID() }, body: form })
  assert.equal(tooLarge.status, 413)
  const rejectedOrigin = await fetch(`${base}/v1/library/snapshot`, { headers: { origin: 'https://untrusted.example' } })
  assert.notEqual(rejectedOrigin.headers.get('access-control-allow-origin'), 'https://untrusted.example')
  process.stdout.write('Real PNG, JPEG, WebP and MP3 upload/download, limit and CORS checks passed\n')
} finally {
  const current = await (await fetch(`${base}/v1/library/snapshot`)).json()
  const active = current.songs.find(item => item.id === song.id)
  if (active) await fetch(`${base}/v1/songs/${song.id}`, { method: 'DELETE', headers: { 'if-match': `"${active.revision}"` } })
}
