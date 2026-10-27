import { verifyDisposableApi } from './disposable-environment.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';

const base = verifyDisposableApi();

test('OpenAPI lists the implemented song, snapshot and attachment contract', async () => {
  const source = await readFile('./openapi.yaml', 'utf8');
  const contract = YAML.parse(source);
  assert.equal(contract.openapi, '3.1.0');
  for (const [path, method] of [
    ['/v1/songs', 'post'],
    ['/v1/songs/{id}', 'patch'],
    ['/v1/songs/{id}', 'delete'],
    ['/v1/library/snapshot', 'get'],
    ['/v1/songs/{songId}/attachments', 'post'],
    ['/v1/attachments/{id}', 'delete'],
    ['/v1/attachments/{id}/content', 'get'],
    ['/v1/setlists/{setlistId}/tags', 'get'],
    ['/v1/setlists/{setlistId}/tags', 'post'],
    ['/v1/setlists/{setlistId}/tags/{id}', 'patch'],
    ['/v1/setlists/{setlistId}/tags/{id}', 'delete'],
    ['/v1/setlists', 'get'],
    ['/v1/setlists', 'post'],
    ['/v1/setlists/{setlistId}', 'patch'],
    ['/v1/setlists/{setlistId}', 'delete'],
    ['/v1/setlists/{setlistId}/snapshot', 'get'],
    ['/v1/setlists/{setlistId}/songs', 'post'],
    ['/v1/setlists/{setlistId}/songs/{id}', 'patch'],
    ['/v1/setlists/{setlistId}/songs/{id}', 'delete'],
    ['/v1/setlists/{setlistId}/songs/{songId}/copy', 'post'],
    ['/v1/setlists/{setlistId}/members', 'get'],
    ['/v1/setlists/{setlistId}/members/{userId}', 'patch'],
    ['/v1/setlists/{setlistId}/members/{userId}', 'delete'],
    ['/v1/setlists/{setlistId}/invitations', 'post'],
    ['/v1/invitations/accept', 'post'],
  ])
    assert.ok(contract.paths[path][method], `${method} ${path}`);
  assert.ok(contract.components.schemas.Song.required.includes('tagIds'));
  assert.ok(contract.components.schemas.Snapshot.required.includes('tags'));
  assert.ok(contract.components.schemas.SetlistSnapshot.required.includes('tags'));
  assert.equal(contract.components.schemas.SongInput.properties.tagIds.items.format, 'uuid');
  assert.equal(contract.components.schemas.SongInput.additionalProperties, false);
  assert.equal(contract.components.schemas.SongPatch.additionalProperties, false);
  assert.ok(
    contract.paths['/v1/songs/{songId}/attachments'].post.parameters.some(
      (entry: any) => entry.name === 'X-Attachment-Id',
    ),
  );
  assert.ok(contract.components.schemas.Snapshot.required.includes('libraryRevision'));
  assert.ok(contract.components.schemas.SetlistSnapshot.required.includes('role'));
  assert.ok(contract.components.schemas.Song.required.includes('setlistId'));
  assert.ok(contract.components.schemas.Attachment.required.includes('setlistId'));
  assert.equal(
    contract.paths['/v1/setlists/{setlistId}/songs/{songId}/copy'].post.requestBody.content[
      'application/json'
    ].schema.additionalProperties,
    false,
  );
  assert.ok(contract.components.schemas.Error.required.includes('requestId'));
  const response = await fetch(`${base}/openapi.yaml`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), source);
});
