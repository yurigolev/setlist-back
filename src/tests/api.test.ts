import { verifyDisposableApi, ownerTestHeaders } from './disposable-environment.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { request as httpRequest } from 'node:http';

const base = verifyDisposableApi();
const ownerHeaders = ownerTestHeaders();
const { config } = await import('../config.js');
const { storage } = await import('../storage.js');

function authenticatedFetch(url: string, init: RequestInit = {}) {
  const headers = new Headers(ownerHeaders);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  return fetch(url, { ...init, headers });
}
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=',
  'base64',
);
const mp3 = Buffer.concat([
  Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000'),
  Buffer.alloc(128),
]);

async function json(path: string, init?: RequestInit) {
  const response = await authenticatedFetch(`${base}${path}`, init);
  return { response, body: (await response.json()) as Record<string, any> };
}

test('song, snapshot and attachment API preserve revisions and idempotency', async () => {
  const key = randomUUID();
  const payload = JSON.stringify({ title: 'Test song', artist: 'Test artist', notes: 'one' });
  const headers = { 'content-type': 'application/json', 'idempotency-key': key };
  const created = await json('/v1/songs', { method: 'POST', headers, body: payload });
  assert.equal(created.response.status, 201);
  const songId = created.body.id;
  const replay = await json('/v1/songs', { method: 'POST', headers, body: payload });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.id, songId);
  const attachmentField = await json(`/v1/songs/${songId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'if-match': '"1"' },
    body: JSON.stringify({ attachments: [] }),
  });
  assert.equal(attachmentField.response.status, 400);
  const edits = await Promise.all([
    json(`/v1/songs/${songId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': '"1"' },
      body: JSON.stringify({ notes: 'two' }),
    }),
    json(`/v1/songs/${songId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'if-match': '"1"' },
      body: JSON.stringify({ notes: 'three' }),
    }),
  ]);
  assert.deepEqual(edits.map((x) => x.response.status).sort(), [200, 409]);
  assert.equal(edits.find((x) => x.response.status === 409)?.body.currentRevision, 2);
  const first = await json('/v1/library/snapshot');
  const second = await json('/v1/library/snapshot');
  assert.deepEqual(first.body, second.body);
  assert.equal(first.body.songs.find((s: any) => s.id === songId).revision, 2);

  async function upload(id: string, bytes: Buffer, mime: string, revision: number) {
    const form = new FormData();
    form.set(
      'file',
      new Blob([new Uint8Array(bytes)], { type: mime }),
      mime === 'audio/mpeg' ? 'test.mp3' : 'test.png',
    );
    return json(`/v1/songs/${songId}/attachments`, {
      method: 'POST',
      headers: { 'x-attachment-id': id, 'if-match': `"${revision}"` },
      body: form,
    });
  }
  const imageId = randomUUID();
  const image = await upload(imageId, png, 'image/png', 2);
  assert.equal(image.response.status, 201);
  assert.equal(image.body.checksum, createHash('sha256').update(png).digest('hex'));
  const imageReplay = await upload(imageId, png, 'image/png', 2);
  assert.equal(imageReplay.response.status, 200);
  assert.equal(imageReplay.body.id, imageId);
  const content = await authenticatedFetch(`${base}${image.body.contentUrl}`);
  assert.equal(content.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), png);
  const audioId = randomUUID();
  const audio = await upload(audioId, mp3, 'audio/mpeg', 3);
  assert.equal(audio.response.status, 201);
  assert.equal(
    (
      await json(`/v1/songs/${songId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': '"4"' },
        body: JSON.stringify({ attachments: [] }),
      })
    ).response.status,
    400,
  );
  assert.equal((await upload(randomUUID(), mp3, 'audio/mpeg', 4)).response.status, 409);
  assert.equal(
    (await upload(randomUUID(), Buffer.from('bad'), 'image/png', 4)).response.status,
    415,
  );
  assert.equal((await upload(randomUUID(), png, 'image/png', 3)).response.status, 409);
  const afterFiles = await json('/v1/library/snapshot');
  assert.equal(afterFiles.body.songs.find((s: any) => s.id === songId).attachments.length, 2);
  assert.equal(afterFiles.body.libraryRevision, first.body.libraryRevision + 2);
  assert.equal(
    (await json(`/v1/attachments/${audioId}`, { method: 'DELETE' })).response.status,
    200,
  );
  assert.equal((await authenticatedFetch(`${base}/v1/attachments/${audioId}/content`)).status, 404);
  assert.equal((await upload(randomUUID(), mp3, 'audio/mpeg', 5)).response.status, 201);
  assert.equal(
    (await json(`/v1/songs/${songId}`, { method: 'DELETE', headers: { 'if-match': '"5"' } }))
      .response.status,
    409,
  );
  const current = await json('/v1/library/snapshot');
  const revision = current.body.songs.find((s: any) => s.id === songId).revision;
  assert.equal(
    (
      await json(`/v1/songs/${songId}`, {
        method: 'DELETE',
        headers: { 'if-match': `"${revision}"` },
      })
    ).response.status,
    200,
  );
  assert.equal(
    (
      await json(`/v1/songs/${songId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': `"${revision}"` },
        body: JSON.stringify({ title: 'revive' }),
      })
    ).response.status,
    404,
  );
  assert.equal((await authenticatedFetch(`${base}${image.body.contentUrl}`)).status, 404);
  const afterDelete = await json('/v1/library/snapshot');
  assert.equal(
    afterDelete.body.songs.some((s: any) => s.id === songId),
    false,
  );
});

async function objectCount(id: string) {
  let count = 0;
  for await (const object of storage.listObjectsV2(config.bucket, `attachments/${id}/`, true))
    if (object.name) count++;
  return count;
}

function pendingUpload(songId: string, attachmentId: string, sessionHeaders = ownerHeaders) {
  const boundary = `setlist-${randomUUID()}`;
  const url = new URL(base);
  const req = httpRequest({
    hostname: url.hostname,
    port: Number(url.port),
    path: `/v1/songs/${songId}/attachments`,
    method: 'POST',
    headers: {
      ...sessionHeaders,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-attachment-id': attachmentId,
      'if-match': '"1"',
    },
  });
  req.write(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slow.png"\r\nContent-Type: image/png\r\n\r\n`,
  );
  req.write(png.subarray(0, 16));
  const done = new Promise<number>((resolve, reject) => {
    req.on('response', (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    req.on('error', reject);
  });
  return {
    req,
    done,
    finish: () => {
      req.write(png.subarray(16));
      req.end(`\r\n--${boundary}--\r\n`);
    },
  };
}

test('cancelled and conflicting uploads leave no published or orphaned object', async () => {
  const create = await json('/v1/songs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ title: 'Race', artist: 'Test' }),
  });
  const id = create.body.id;
  const cancelledId = randomUUID();
  const cancelled = pendingUpload(id, cancelledId);
  cancelled.done.catch(() => undefined);
  cancelled.req.destroy();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await objectCount(cancelledId), 0);
  const slowId = randomUUID();
  const slow = pendingUpload(id, slowId);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const deleted = await json(`/v1/songs/${id}`, {
    method: 'DELETE',
    headers: { 'if-match': '"1"' },
  });
  assert.equal(deleted.response.status, 200);
  slow.finish();
  assert.equal(await slow.done, 404);
  assert.equal(await objectCount(slowId), 0);
  const snapshot = await json('/v1/library/snapshot');
  assert.equal(
    snapshot.body.songs.some((song: any) => song.id === id),
    false,
  );
});

test('metadata conflict after object write removes the temporary object', async () => {
  const create = await json('/v1/songs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ title: 'Conflict', artist: 'Test' }),
  });
  const id = create.body.id;
  await json(`/v1/songs/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'if-match': '"1"' },
    body: JSON.stringify({ notes: 'changed' }),
  });
  const attachmentId = randomUUID();
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'test.png');
  const response = await json(`/v1/songs/${id}/attachments`, {
    method: 'POST',
    headers: { 'x-attachment-id': attachmentId, 'if-match': '"1"' },
    body: form,
  });
  assert.equal(response.response.status, 409);
  assert.equal(response.body.currentRevision, 2);
  assert.equal(await objectCount(attachmentId), 0);
  const snapshot = await json('/v1/library/snapshot');
  const saved = snapshot.body.songs.find((song: any) => song.id === id);
  assert.equal(saved.notes, 'changed');
  assert.equal(saved.attachments.length, 0);
});

test('credentialed browser preflight permits scoped PATCH and DELETE from the configured origin', async () => {
  for (const method of ['PATCH', 'DELETE']) {
    const response = await fetch(`${base}/v1/setlists/00000000-0000-4000-8000-000000000001`, {
      method: 'OPTIONS',
      headers: {
        origin: ownerHeaders.origin,
        'access-control-request-method': method,
        'access-control-request-headers': 'content-type,if-match,x-csrf-token',
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), ownerHeaders.origin);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    assert.ok(
      response.headers
        .get('access-control-allow-methods')
        ?.split(',')
        .map((value) => value.trim())
        .includes(method),
    );
    const headers = response.headers
      .get('access-control-allow-headers')
      ?.toLowerCase()
      .split(',')
      .map((value) => value.trim());
    assert.ok(headers?.includes('if-match') && headers.includes('x-csrf-token'));
  }
});

test('private errors do not disclose storage credentials and CORS rejects other origins', async () => {
  const invalid = await authenticatedFetch(`${base}/v1/songs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://untrusted.example' },
    body: '{bad',
  });
  assert.equal(invalid.status, 403);
  assert.notEqual(invalid.headers.get('access-control-allow-origin'), 'https://untrusted.example');
  const text = await invalid.text();
  assert.equal(text.includes(config.minio.secretKey), false);
  assert.equal(text.includes(config.databaseUrl), false);
  assert.equal(text.includes('stack'), false);
  const error = JSON.parse(text);
  assert.equal(typeof error.requestId, 'string');
  assert.equal(typeof error.code, 'string');
});

test(
  'logout during upload prevents final publication and removes the temporary object',
  { timeout: 10000 },
  async () => {
    // A second real signed mock-provider login leaves the suite's owner session intact.
    const start = await fetch(`${base}/v1/auth/telegram/start?returnTo=/`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const authorization = new URL(start.headers.get('location')!);
    const loginCookie = start.headers
      .getSetCookie()
      .find((value) => value.startsWith('setlist_login='))!
      .split(';')[0];
    const callback = await fetch(
      `${base}/v1/auth/telegram/callback?code=qa-owner&state=${encodeURIComponent(authorization.searchParams.get('state')!)}`,
      { redirect: 'manual', headers: { cookie: loginCookie } },
    );
    assert.equal(callback.status, 302);
    const cookie = callback.headers
      .getSetCookie()
      .find((value) => value.startsWith('setlist_session='))!
      .split(';')[0];
    const sessionResponse = await fetch(`${base}/v1/auth/session`, { headers: { cookie } });
    assert.equal(sessionResponse.status, 200);
    const session = (await sessionResponse.json()) as { csrfToken: string };
    const sessionHeaders = {
      cookie,
      origin: ownerHeaders.origin,
      'x-csrf-token': session.csrfToken,
    };
    const created = await json('/v1/songs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ title: 'Revoked upload', artist: 'Test' }),
    });
    assert.equal(created.response.status, 201);
    const songId = created.body.id;
    const attachmentId = randomUUID();
    let slow: ReturnType<typeof pendingUpload> | undefined;
    try {
      slow = pendingUpload(songId, attachmentId, sessionHeaders);
      slow.done.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const logout = await fetch(`${base}/v1/auth/logout`, {
        method: 'POST',
        headers: sessionHeaders,
      });
      assert.equal(logout.status, 204);
      slow.finish();
      assert.equal(await slow.done, 401);
      assert.equal(await objectCount(attachmentId), 0);
      const snapshot = await json('/v1/library/snapshot');
      assert.equal(snapshot.response.status, 200);
      assert.equal(
        snapshot.body.songs.find((song: any) => song.id === songId).attachments.length,
        0,
      );
    } finally {
      slow?.req.destroy();
      await json(`/v1/songs/${songId}`, { method: 'DELETE', headers: { 'if-match': '"1"' } });
    }
  },
);
