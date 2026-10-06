import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import YAML from 'yaml'

test('OpenAPI lists the implemented song, snapshot and attachment contract', async () => {
  const source = await readFile('./openapi.yaml', 'utf8')
  const contract = YAML.parse(source)
  assert.equal(contract.openapi, '3.1.0')
  for (const [path, method] of [
    ['/v1/songs', 'post'], ['/v1/songs/{id}', 'patch'], ['/v1/songs/{id}', 'delete'],
    ['/v1/library/snapshot', 'get'], ['/v1/songs/{songId}/attachments', 'post'],
    ['/v1/attachments/{id}', 'delete'], ['/v1/attachments/{id}/content', 'get'],
  ]) assert.ok(contract.paths[path][method], `${method} ${path}`)
  assert.equal(contract.components.schemas.SongInput.additionalProperties, false)
  assert.equal(contract.components.schemas.SongPatch.additionalProperties, false)
  assert.ok(contract.paths['/v1/songs/{songId}/attachments'].post.parameters.some((entry: any) => entry.name === 'X-Attachment-Id'))
  assert.ok(contract.components.schemas.Snapshot.required.includes('libraryRevision'))
  assert.ok(contract.components.schemas.Error.required.includes('requestId'))
  const response = await fetch(`${process.env.TEST_API_URL ?? 'http://127.0.0.1:3000'}/openapi.yaml`)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), source)
})
