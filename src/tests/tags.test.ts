import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { verifyDisposableApi, ownerTestHeaders } from './disposable-environment.js';

const base = verifyDisposableApi();
const owner = ownerTestHeaders();
async function json(
  path: string,
  method = 'GET',
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...owner,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

test('tags normalize names, isolate scopes, preserve song revisions and map copies', async () => {
  const source = await json('/v1/setlists', 'POST', { title: 'Tags QA source' });
  const target = await json('/v1/setlists', 'POST', { title: 'Tags QA target' });
  assert.equal(source.status, 201);
  assert.equal(target.status, 201);
  const sourceId = source.body.id;
  const targetId = target.body.id;
  const root = `/v1/setlists/${sourceId}`;
  const targetRoot = `/v1/setlists/${targetId}`;
  const snapshot = () => json(`${root}/snapshot`);
  const initial = await snapshot();
  assert.deepEqual(initial.body.tags, []);
  const created = await json(`${root}/tags`, 'POST', { name: '  ПЕ\u0308СНИ\t  вечера  ' });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'ПЁСНИ вечера');
  assert.deepEqual(Object.keys(created.body).sort(), ['color', 'id', 'name']);
  const tagId = created.body.id;
  const duplicate = await json(`${root}/tags`, 'POST', { name: 'пёсни вечера' });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, 'TAG_NAME_CONFLICT');
  for (const name of ['', '  \n\t', 'x'.repeat(41)])
    assert.equal((await json(`${root}/tags`, 'POST', { name })).status, 400);
  const tag2 = await json(`${root}/tags`, 'POST', { name: 'Second' });
  const other = await json(`${targetRoot}/tags`, 'POST', { name: 'пёсни вечера' });
  const otherId = other.body.id;
  assert.equal((await snapshot()).body.setlistRevision, initial.body.setlistRevision + 2);

  const key = randomUUID();
  const data = { title: 'Tagged', artist: 'QA', tagIds: [tag2.body.id, tagId, tagId] };
  const song = await json(`${root}/songs`, 'POST', data, { 'idempotency-key': key });
  assert.equal(song.status, 201);
  assert.deepEqual(song.body.tagIds, [tagId, tag2.body.id].sort());
  const songId = song.body.id;
  const replay = await json(
    `${root}/songs`,
    'POST',
    { ...data, tagIds: [tagId, tag2.body.id] },
    { 'idempotency-key': key },
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, songId);
  assert.equal(
    (await json(`${root}/songs`, 'POST', { ...data, tagIds: [] }, { 'idempotency-key': key }))
      .status,
    409,
  );
  assert.deepEqual((await json(`${root}/songs/${songId}`)).body.tagIds, song.body.tagIds);
  assert.deepEqual((await json(`${root}/songs`)).body.songs[0].tagIds, song.body.tagIds);
  const unchanged = await snapshot();
  for (const invalidId of [otherId, randomUUID()]) {
    const invalid = await json(
      `${root}/songs/${songId}`,
      'PATCH',
      { title: 'Must roll back', tagIds: [invalidId] },
      { 'if-match': '1' },
    );
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, 'INVALID_TAG_IDS');
    const createInvalid = await json(
      `${root}/songs`,
      'POST',
      { ...data, tagIds: [invalidId] },
      { 'idempotency-key': randomUUID() },
    );
    assert.equal(createInvalid.status, 400);
  }
  assert.deepEqual((await snapshot()).body, unchanged.body);
  const preserved = await json(
    `${root}/songs/${songId}`,
    'PATCH',
    { notes: 'Keep tags' },
    { 'if-match': '1' },
  );
  assert.equal(preserved.status, 200);
  assert.deepEqual(preserved.body.tagIds, song.body.tagIds);
  const beforeRename = await snapshot();
  assert.equal(
    (await json(`${root}/tags/${tagId}`, 'PATCH', { name: '  Renamed  tag ' })).status,
    200,
  );
  const afterRename = await snapshot();
  assert.equal(afterRename.body.setlistRevision, beforeRename.body.setlistRevision + 1);
  assert.equal(afterRename.body.songs[0].revision, 2);
  assert.equal((await json(`${root}/tags/${tagId}`, 'PATCH', { name: 'SECOND' })).status, 409);
  assert.equal(
    (await json(`${root}/tags/${tagId}`, 'PATCH', { name: 'ПЁСНИ вечера' })).status,
    200,
  );

  const copy = await json(`${root}/songs/${songId}/copy`, 'POST', { targetSetlistId: targetId });
  assert.equal(copy.status, 201);
  const copied = await json(`${targetRoot}/snapshot`);
  const mappedSecond = copied.body.tags.find((tag: any) => tag.name === 'Second');
  assert.ok(mappedSecond);
  assert.equal(copied.body.tags.length, 2);
  assert.deepEqual(copy.body.tagIds, [otherId, mappedSecond.id].sort());
  assert.ok(!copy.body.tagIds.includes(tagId));

  const beforeDelete = await snapshot();
  const deletion = await json(`${root}/tags/${tagId}`, 'DELETE');
  assert.equal(deletion.status, 200);
  assert.deepEqual(deletion.body, { id: tagId, deleted: true });
  const afterDelete = await snapshot();
  assert.equal(afterDelete.body.setlistRevision, beforeDelete.body.setlistRevision + 1);
  assert.equal(afterDelete.body.songs[0].revision, 3);
  assert.deepEqual(afterDelete.body.songs[0].tagIds, [tag2.body.id]);
  const stale = await json(`${root}/songs/${songId}`, 'PATCH', { tagIds: [] }, { 'if-match': '2' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.currentRevision, 3);
  const cleared = await json(
    `${root}/songs/${songId}`,
    'PATCH',
    { tagIds: [] },
    { 'if-match': '3' },
  );
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.tagIds, []);
  assert.equal(cleared.body.notes, 'Keep tags');
  assert.equal((await json(`${root}/tags/${tagId}`, 'DELETE')).status, 404);
  assert.equal((await json(`${root}/tags/${otherId}`, 'PATCH', { name: 'Other' })).status, 404);
  assert.equal((await json(`${targetRoot}/tags`)).body.tags.length, 2);

  const legacy = await json(
    '/v1/songs',
    'POST',
    { title: 'Legacy tag default', artist: 'QA' },
    { 'idempotency-key': randomUUID() },
  );
  assert.equal(legacy.status, 201);
  assert.deepEqual(legacy.body.tagIds, []);
  const legacySnapshot = await json('/v1/library/snapshot');
  assert.ok(Array.isArray(legacySnapshot.body.tags));
  assert.deepEqual(legacySnapshot.body.songs.find((s: any) => s.id === legacy.body.id).tagIds, []);
});

test('tag colors are optional, validated, preserved by PATCH and copied with new tags', async () => {
  const source = await json('/v1/setlists', 'POST', { title: 'Color QA source' });
  const target = await json('/v1/setlists', 'POST', { title: 'Color QA target' });
  const root = `/v1/setlists/${source.body.id}`;
  const targetRoot = `/v1/setlists/${target.body.id}`;
  const plain = await json(`${root}/tags`, 'POST', { name: 'Plain' });
  assert.equal(plain.body.color, null);
  const created = await json(`${root}/tags`, 'POST', { name: 'Colored', color: '#aBc123' });
  assert.equal(created.status, 201);
  assert.equal(created.body.color, '#ABC123');
  const id = created.body.id;
  const beforeInvalid = (await json(`${root}/snapshot`)).body;
  for (const color of ['red', '#abc', '#AABBCCDD', '#AABBCC\n', 'AABBCC', '', 123]) {
    assert.equal((await json(`${root}/tags`, 'POST', { name: 'Invalid', color })).status, 400);
    assert.equal((await json(`${root}/tags/${id}`, 'PATCH', { color })).status, 400);
  }
  assert.equal((await json(`${root}/tags/${id}`, 'PATCH', {})).status, 400);
  assert.deepEqual((await json(`${root}/snapshot`)).body, beforeInvalid);
  const renamed = await json(`${root}/tags/${id}`, 'PATCH', { name: 'Renamed' });
  assert.equal(renamed.body.color, '#ABC123');
  const song = await json(
    `${root}/songs`,
    'POST',
    { title: 'Color song', artist: 'QA', tagIds: [id, plain.body.id] },
    { 'idempotency-key': randomUUID() },
  );
  const beforeColor = (await json(`${root}/snapshot`)).body;
  const changed = await json(`${root}/tags/${id}`, 'PATCH', { color: '#123abc' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.name, 'Renamed');
  assert.equal(changed.body.color, '#123ABC');
  const afterColor = (await json(`${root}/snapshot`)).body;
  assert.equal(afterColor.setlistRevision, beforeColor.setlistRevision + 1);
  assert.equal(afterColor.songs[0].revision, song.body.revision);
  assert.equal(afterColor.tags.find((tag: any) => tag.id === id).color, '#123ABC');
  assert.equal(
    (await json(`${root}/tags`)).body.tags.find((tag: any) => tag.id === id).color,
    '#123ABC',
  );
  // Existing target tag keeps its color; a new target tag inherits the source color.
  const existing = await json(`${targetRoot}/tags`, 'POST', { name: 'Plain', color: '#FF0000' });
  const copy = await json(`${root}/songs/${song.body.id}/copy`, 'POST', {
    targetSetlistId: target.body.id,
  });
  assert.equal(copy.status, 201);
  const copiedTags = (await json(`${targetRoot}/tags`)).body.tags;
  assert.equal(copiedTags.find((tag: any) => tag.id === existing.body.id).color, '#FF0000');
  assert.equal(copiedTags.find((tag: any) => tag.name === 'Renamed').color, '#123ABC');
  const cleared = await json(`${root}/tags/${id}`, 'PATCH', { color: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.color, null);
  const withoutColor = await json(`${root}/tags`, 'POST', {
    name: 'Explicitly plain',
    color: null,
  });
  assert.equal(withoutColor.body.color, null);
});
