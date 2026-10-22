import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { Client as MinioClient } from 'minio';
import { spawn } from 'node:child_process';
import { verifyDisposableApi } from '../dist/tests/disposable-environment.js';

const verifiedApiOrigin = verifyDisposableApi();

const apiBase = process.env.TEST_API_URL;
const origin = process.env.TEST_ORIGIN;
const minioPort = Number(process.env.AUTH_QA_MINIO_PORT);
const bucket = process.env.MINIO_BUCKET;
const apiUrl = new URL(apiBase ?? '');
assert.equal(
  apiUrl.origin,
  verifiedApiOrigin,
  'QA API must match the verified disposable environment',
);
assert.ok(
  origin && origin === process.env.PWA_ORIGIN && bucket?.startsWith('setlist-qa-'),
  'QA origin and bucket must be disposable',
);

let passed = 0;
function pass(label) {
  passed++;
  console.log(`PASS: ${label}`);
}
function expectStatus(response, status, label) {
  assert.equal(response.status, status, label);
}
async function bodyJson(response) {
  const type = response.headers.get('content-type') ?? '';
  return type.includes('application/json') ? response.json() : undefined;
}
async function anonymous(path, init = {}) {
  return fetch(new URL(path, apiBase), { redirect: 'manual', ...init });
}

async function login(code) {
  const start = await anonymous('/v1/auth/telegram/start?returnTo=%2F');
  expectStatus(start, 302, 'mock login start');
  const loginCookie = start.headers
    .getSetCookie()
    .find((value) => value.startsWith('setlist_login='))
    ?.split(';')[0];
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  assert.ok(loginCookie && state, 'mock login binding must be present');
  const callback = await anonymous(
    `/v1/auth/telegram/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    { headers: { cookie: loginCookie } },
  );
  expectStatus(callback, 302, 'mock login callback');
  const cookie = callback.headers
    .getSetCookie()
    .find((value) => value.startsWith('setlist_session='))
    ?.split(';')[0];
  assert.ok(cookie, 'mock callback must issue session');
  const sessionResponse = await anonymous('/v1/auth/session', { headers: { cookie } });
  expectStatus(sessionResponse, 200, 'mock session bootstrap');
  const session = await bodyJson(sessionResponse);
  assert.ok(session?.csrfToken, 'mock session must provide CSRF token');
  return { cookie, csrf: session.csrfToken };
}

async function api(session, path, options = {}) {
  const headers = new Headers(options.headers);
  if (session) {
    headers.set('cookie', session.cookie);
    headers.set('origin', origin);
    headers.set('x-csrf-token', session.csrf);
  }
  let body = options.body;
  if (
    body !== undefined &&
    !(body instanceof FormData) &&
    !(body instanceof ReadableStream) &&
    typeof body !== 'string' &&
    !Buffer.isBuffer(body)
  ) {
    body = JSON.stringify(body);
    headers.set('content-type', 'application/json');
  }
  // Cookies are supplied explicitly. Suppress Undici's HTTP-auth retry on 401:
  // a streaming upload has no replayable body source after session revocation.
  return fetch(new URL(path, apiBase), {
    redirect: 'manual',
    credentials: 'omit',
    ...options,
    headers,
    body,
  });
}

async function json(session, path, options = {}) {
  const response = await api(session, path, options);
  const value = await bodyJson(response);
  return { response, value };
}

async function createSetlist(session, title) {
  const { response, value } = await json(session, '/v1/setlists', {
    method: 'POST',
    body: { title },
  });
  expectStatus(response, 201, 'create setlist');
  assert.ok(
    value?.id &&
      value.role === 'owner' &&
      value.deletedAt === null &&
      Number.isInteger(value.revision),
    'setlist DTO contract',
  );
  return value;
}

async function invite(session, setlistId, role, expiresInHours = 24) {
  const { response, value } = await json(session, `/v1/setlists/${setlistId}/invitations`, {
    method: 'POST',
    body: { role, expiresInHours },
  });
  expectStatus(response, 201, 'create invitation');
  assert.equal(value.invitation.role, role);
  assert.equal(typeof value.token, 'string');
  return value;
}

async function accept(session, token) {
  return json(session, '/v1/invitations/accept', { method: 'POST', body: { token } });
}

async function createSong(session, setlistId, title, idempotencyKey = randomUUID()) {
  const { response, value } = await json(session, `/v1/setlists/${setlistId}/songs`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: { title, artist: 'QA Artist', notes: 'Disposable test fixture' },
  });
  return { response, song: value, idempotencyKey };
}

async function uploadImage(
  session,
  setlistId,
  song,
  bytes = Buffer.from([0xff, 0xd8, 0xff, 0x10, 0x20, 0x30]),
  attachmentId = randomUUID(),
) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'qa.jpg');
  const response = await api(session, `/v1/setlists/${setlistId}/songs/${song.id}/attachments`, {
    method: 'POST',
    headers: { 'x-attachment-id': attachmentId, 'if-match': String(song.revision) },
    body: form,
  });
  return { response, attachment: await bodyJson(response), bytes, attachmentId };
}

async function ownerCount(session, setlistId) {
  const { response, value } = await json(session, `/v1/setlists/${setlistId}/members`);
  expectStatus(response, 200, 'read memberships');
  return value.members.filter((member) => member.role === 'owner').length;
}

function minio() {
  return new MinioClient({
    endPoint: '127.0.0.1',
    port: minioPort,
    useSSL: false,
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY,
  });
}

async function countObjects(prefix) {
  const client = minio();
  let count = 0;
  for await (const _item of client.listObjects(bucket, prefix, true)) count++;
  return count;
}

async function mutateBody(session, setlistId, song, title) {
  const { response, value } = await json(session, `/v1/setlists/${setlistId}/songs/${song.id}`, {
    method: 'PATCH',
    headers: { 'if-match': String(song.revision) },
    body: { title },
  });
  expectStatus(response, 200, 'update song');
  return value;
}

const owner = { cookie: process.env.TEST_SESSION_COOKIE, csrf: process.env.TEST_CSRF_TOKEN };
assert.ok(owner.cookie && owner.csrf, 'QA owner session must be present');
const outsider = await login('qa-outsider');
const inviteeA = await login('qa-invitee-a');
const inviteeB = await login('qa-invitee-b');

const { response: listResponse, value: initialList } = await json(owner, '/v1/setlists');
expectStatus(listResponse, 200, 'list setlists');
assert.ok(Array.isArray(initialList.setlists), 'GET setlists wrapper contract');
const legacy = initialList.setlists.find((row) => row.role === 'owner');
assert.ok(legacy?.id, 'explicitly adopted legacy setlist must exist');
const { response: legacySnapshotResponse, value: legacySnapshot } = await json(
  owner,
  `/v1/setlists/${legacy.id}/snapshot`,
);
expectStatus(legacySnapshotResponse, 200, 'legacy snapshot');
assert.equal(legacySnapshot.setlistId, legacy.id);
assert.equal(legacySnapshot.role, 'owner');
assert.ok(
  Number.isInteger(legacySnapshot.setlistRevision) && Array.isArray(legacySnapshot.songs),
  'snapshot contract',
);
pass('list, DTO, and snapshot contracts');

const source = await createSetlist(owner, 'QA source');
const target = await createSetlist(owner, 'QA target');
const roleScope = await createSetlist(owner, 'QA role matrix');
const ownerDto = (await json(owner, `/v1/setlists/${source.id}/snapshot`)).value;
assert.equal(ownerDto.role, 'owner');
const noRevision = await api(owner, `/v1/setlists/${source.id}`, {
  method: 'PATCH',
  body: { title: 'Missing revision' },
});
expectStatus(noRevision, 428, 'missing setlist If-Match');
const malformedRevision = await api(owner, `/v1/setlists/${source.id}`, {
  method: 'PATCH',
  headers: { 'if-match': 'invalid' },
  body: { title: 'Malformed revision' },
});
expectStatus(malformedRevision, 428, 'malformed setlist If-Match');
const staleRevision = await api(owner, `/v1/setlists/${source.id}`, {
  method: 'PATCH',
  headers: { 'if-match': '99' },
  body: { title: 'Stale revision' },
});
expectStatus(staleRevision, 409, 'stale setlist If-Match');
const staleDetails = await bodyJson(staleRevision);
assert.ok(
  staleDetails?.currentRevision !== undefined,
  'revision conflict must return currentRevision',
);
const renamed = await json(owner, `/v1/setlists/${source.id}`, {
  method: 'PATCH',
  headers: { 'if-match': String(source.revision) },
  body: { title: 'QA renamed source' },
});
expectStatus(renamed.response, 200, 'rename with current setlist revision');
assert.equal(renamed.value.title, 'QA renamed source');
assert.equal(
  renamed.value.revision,
  source.revision + 1,
  'rename increments setlist revision once',
);
const renamedSnapshot = await json(owner, `/v1/setlists/${source.id}/snapshot`);
expectStatus(renamedSnapshot.response, 200, 'snapshot after rename');
assert.equal(
  renamedSnapshot.value.setlistRevision,
  renamed.value.revision,
  'rename revision is persisted',
);
pass('setlist revision preconditions');

const viewerInvitation = await invite(owner, roleScope.id, 'viewer');
const acceptedViewer = await accept(outsider, viewerInvitation.token);
expectStatus(acceptedViewer.response, 200, 'viewer invitation accept');
assert.equal(acceptedViewer.value.setlist.role, 'viewer');
const editorInvitation = await invite(owner, roleScope.id, 'editor');
const acceptedEditor = await accept(inviteeA, editorInvitation.token);
expectStatus(acceptedEditor.response, 200, 'editor invitation accept');
assert.equal(acceptedEditor.value.setlist.role, 'editor');
const editorSongResult = await createSong(inviteeA, roleScope.id, 'Editor-created song');
expectStatus(editorSongResult.response, 201, 'editor creates song');
const editorSongUpdated = await mutateBody(
  inviteeA,
  roleScope.id,
  editorSongResult.song,
  'Editor-updated song',
);
const editorMedia = await uploadImage(inviteeA, roleScope.id, editorSongUpdated);
expectStatus(editorMedia.response, 201, 'editor uploads media');
const viewerMedia = await api(outsider, editorMedia.attachment.contentUrl);
expectStatus(viewerMedia, 200, 'viewer downloads media');
assert.deepEqual(Buffer.from(await viewerMedia.arrayBuffer()), editorMedia.bytes);
const viewerUpload = await uploadImage(outsider, roleScope.id, editorSongUpdated);
expectStatus(viewerUpload.response, 403, 'viewer cannot upload media');
const currentEditorSong = await json(
  inviteeA,
  `/v1/setlists/${roleScope.id}/songs/${editorSongResult.song.id}`,
);
expectStatus(currentEditorSong.response, 200, 'editor reads own song');
const editorMediaDelete = await api(
  inviteeA,
  `/v1/setlists/${roleScope.id}/attachments/${editorMedia.attachment.id}`,
  { method: 'DELETE', headers: { 'if-match': String(currentEditorSong.value.revision) } },
);
expectStatus(editorMediaDelete, 200, 'editor deletes media');
const afterMediaDelete = await json(
  inviteeA,
  `/v1/setlists/${roleScope.id}/songs/${editorSongResult.song.id}`,
);
const editorSongDelete = await api(
  inviteeA,
  `/v1/setlists/${roleScope.id}/songs/${editorSongResult.song.id}`,
  { method: 'DELETE', headers: { 'if-match': String(afterMediaDelete.value.revision) } },
);
expectStatus(editorSongDelete, 200, 'editor deletes song');
const viewerSongResult = await createSong(outsider, roleScope.id, 'Viewer-denied song');
expectStatus(viewerSongResult.response, 403, 'viewer cannot create song');
const viewerSnapshot = await json(outsider, `/v1/setlists/${roleScope.id}/snapshot`);
expectStatus(viewerSnapshot.response, 200, 'viewer reads snapshot');
const viewerInvitations = await api(outsider, `/v1/setlists/${roleScope.id}/invitations`);
expectStatus(viewerInvitations, 403, 'viewer cannot list invitations');
const viewerMembers = await api(outsider, `/v1/setlists/${roleScope.id}/members`);
expectStatus(viewerMembers, 200, 'viewer reads members');
const editorInvitations = await api(inviteeA, `/v1/setlists/${roleScope.id}/invitations`);
expectStatus(editorInvitations, 403, 'editor cannot administer invitations');
const editorDeleteSetlist = await api(inviteeA, `/v1/setlists/${roleScope.id}`, {
  method: 'DELETE',
  headers: { 'if-match': String(roleScope.revision) },
});
expectStatus(editorDeleteSetlist, 403, 'editor cannot delete setlist');
const memberResult = await json(owner, `/v1/setlists/${roleScope.id}/members`);
expectStatus(memberResult.response, 200, 'owner reads members');
assert.ok(
  memberResult.value.members.some((member) => member.role === 'viewer') &&
    memberResult.value.members.some((member) => member.role === 'editor'),
  'member DTO roles',
);
pass('owner/editor/viewer permissions and member contract');

const sharedIdempotencyKey = randomUUID();
const scopedFirst = await createSong(
  owner,
  source.id,
  'Source idempotency body',
  sharedIdempotencyKey,
);
expectStatus(scopedFirst.response, 201, 'first scoped idempotent write');
const scopedSecond = await createSong(
  owner,
  target.id,
  'Target idempotency body',
  sharedIdempotencyKey,
);
expectStatus(scopedSecond.response, 201, 'same key in other setlist');
assert.notEqual(scopedFirst.song.id, scopedSecond.song.id);
assert.equal(scopedFirst.song.setlistId, source.id);
assert.equal(scopedSecond.song.setlistId, target.id);
const sourceSong = await createSong(owner, source.id, 'Song to copy');
expectStatus(sourceSong.response, 201, 'source song create');
const sourceMedia = await uploadImage(owner, source.id, sourceSong.song);
expectStatus(sourceMedia.response, 201, 'source media upload');
for (const setlist of [source, target]) {
  const membershipInvite = await invite(owner, setlist.id, 'editor');
  const membership = await accept(inviteeA, membershipInvite.token);
  expectStatus(membership.response, 200, 'copy editor membership');
}
const editorCopy = await json(
  inviteeA,
  `/v1/setlists/${source.id}/songs/${sourceSong.song.id}/copy`,
  { method: 'POST', body: { targetSetlistId: target.id } },
);
expectStatus(editorCopy.response, 201, 'member reads source and writes target copy');
const viewerTargetInvite = await invite(owner, target.id, 'viewer');
const viewerSourceInvite = await invite(owner, source.id, 'viewer');
const viewerSourceMembership = await accept(outsider, viewerSourceInvite.token);
const viewerTargetMembership = await accept(outsider, viewerTargetInvite.token);
expectStatus(viewerSourceMembership.response, 200, 'copy viewer source membership');
expectStatus(viewerTargetMembership.response, 200, 'copy target viewer membership');
const copyViewerDenied = await api(
  outsider,
  `/v1/setlists/${source.id}/songs/${sourceSong.song.id}/copy`,
  { method: 'POST', body: { targetSetlistId: target.id } },
);
expectStatus(copyViewerDenied, 403, 'viewer cannot copy to target');
const copyResult = await json(owner, `/v1/setlists/${source.id}/songs/${sourceSong.song.id}/copy`, {
  method: 'POST',
  body: { targetSetlistId: target.id },
});
expectStatus(copyResult.response, 201, 'copy song');
const copiedSong = copyResult.value;
assert.notEqual(copiedSong.id, sourceSong.song.id);
assert.equal(copiedSong.setlistId, target.id);
assert.equal(copiedSong.attachments.length, 1);
const copiedMedia = copiedSong.attachments[0];
assert.notEqual(copiedMedia.id, sourceMedia.attachment.id);
assert.equal(copiedMedia.setlistId, target.id);
assert.equal(
  copiedMedia.contentUrl,
  `/v1/setlists/${target.id}/attachments/${copiedMedia.id}/content`,
);
assert.equal(
  await countObjects(`attachments/${copiedMedia.id}/`),
  1,
  'copy must allocate an independent object key',
);
const sourceContent = await api(owner, sourceMedia.attachment.contentUrl);
expectStatus(sourceContent, 200, 'source media fetch');
assert.deepEqual(Buffer.from(await sourceContent.arrayBuffer()), sourceMedia.bytes);
const copyContent = await api(owner, copiedMedia.contentUrl);
expectStatus(copyContent, 200, 'copied media fetch');
assert.deepEqual(Buffer.from(await copyContent.arrayBuffer()), sourceMedia.bytes);
const foreignSongRead = await api(owner, `/v1/setlists/${target.id}/songs/${sourceSong.song.id}`);
expectStatus(foreignSongRead, 404, 'foreign song ID under target scope');
const foreignSongDelete = await api(
  owner,
  `/v1/setlists/${target.id}/songs/${sourceSong.song.id}`,
  { method: 'DELETE', headers: { 'if-match': '1' } },
);
expectStatus(foreignSongDelete, 404, 'foreign song delete under target scope');
const foreignMediaRead = await api(
  owner,
  `/v1/setlists/${target.id}/attachments/${sourceMedia.attachment.id}/content`,
);
expectStatus(foreignMediaRead, 404, 'foreign media ID under target scope');
const foreignMediaDelete = await api(
  owner,
  `/v1/setlists/${target.id}/attachments/${sourceMedia.attachment.id}`,
  { method: 'DELETE', headers: { 'if-match': '2' } },
);
expectStatus(foreignMediaDelete, 404, 'foreign media delete under target scope');
const currentSource = await json(owner, `/v1/setlists/${source.id}/songs/${sourceSong.song.id}`);
expectStatus(currentSource.response, 200, 'read source before edit');
const updatedSource = await mutateBody(owner, source.id, currentSource.value, 'Edited source');
const stillCopied = await api(owner, copiedMedia.contentUrl);
expectStatus(stillCopied, 200, 'copy survives source edit');
assert.deepEqual(Buffer.from(await stillCopied.arrayBuffer()), sourceMedia.bytes);
const deleteSource = await api(owner, `/v1/setlists/${source.id}/songs/${sourceSong.song.id}`, {
  method: 'DELETE',
  headers: { 'if-match': String(updatedSource.revision) },
});
expectStatus(deleteSource, 200, 'source delete');
const afterSourceDelete = await api(owner, copiedMedia.contentUrl);
expectStatus(afterSourceDelete, 200, 'copy survives source delete');
assert.deepEqual(Buffer.from(await afterSourceDelete.arrayBuffer()), sourceMedia.bytes);
const deleteCopy = await api(owner, `/v1/setlists/${target.id}/songs/${copiedSong.id}`, {
  method: 'DELETE',
  headers: { 'if-match': String(copiedSong.revision) },
});
expectStatus(deleteCopy, 200, 'copy delete');
const afterCopyDelete = await api(owner, copiedMedia.contentUrl);
expectStatus(afterCopyDelete, 404, 'copy media removed with copied song');
pass('single-scope content, IDOR boundaries, idempotency, and independent media copy');

const outsiderScopeResponse = await api(inviteeB, `/v1/setlists/${source.id}/snapshot`);
assert.ok(
  [403, 404].includes(outsiderScopeResponse.status),
  'non-member cannot read another setlist',
);
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  const storedInvitation = await db.query(
    'SELECT to_jsonb(i) AS invitation FROM setlist_invitations i WHERE id = $1',
    [viewerInvitation.invitation.id],
  );
  assert.equal(storedInvitation.rows.length, 1, 'invitation persisted');
  assert.equal(
    storedInvitation.rows[0].invitation.token_hash,
    tokenHash(viewerInvitation.token),
    'only SHA-256 token hash is stored',
  );
  assert.equal(
    JSON.stringify(storedInvitation.rows[0].invitation).includes(viewerInvitation.token),
    false,
    'no plaintext invitation token is stored',
  );
  const invitationList = await json(owner, `/v1/setlists/${roleScope.id}/invitations`);
  expectStatus(invitationList.response, 200, 'invitation metadata list');
  assert.equal(
    JSON.stringify(invitationList.value).includes(viewerInvitation.token),
    false,
    'invitation list does not expose token',
  );
  assert.equal(
    JSON.stringify(invitationList.value).includes(tokenHash(viewerInvitation.token)),
    false,
    'invitation list does not expose token hash',
  );
  pass('invitation persistence stores hash only and lists expose metadata only');
  const expiring = await invite(owner, roleScope.id, 'viewer');
  await db.query(
    "UPDATE setlist_invitations SET expires_at = now() - interval '1 second' WHERE token_hash = $1",
    [tokenHash(expiring.token)],
  );
  const expiredAcceptance = await accept(inviteeB, expiring.token);
  expectStatus(expiredAcceptance.response, 200, 'indefinite invitation ignores legacy expiry');
  const revoked = await invite(owner, roleScope.id, 'viewer');
  const revokeResponse = await api(
    owner,
    `/v1/setlists/${roleScope.id}/invitations/${revoked.invitation.id}`,
    { method: 'DELETE' },
  );
  expectStatus(revokeResponse, 200, 'revoke invitation');
  const revokedAcceptance = await accept(inviteeB, revoked.token);
  expectStatus(revokedAcceptance.response, 409, 'revoked invitation');
  const badLifetime = await json(owner, `/v1/setlists/${roleScope.id}/invitations`, {
    method: 'POST',
    body: { role: 'viewer', expiresInHours: 0 },
  });
  expectStatus(badLifetime.response, 400, 'invitation lifetime lower bound');
  const excessiveLifetime = await json(owner, `/v1/setlists/${roleScope.id}/invitations`, {
    method: 'POST',
    body: { role: 'viewer', expiresInHours: 169 },
  });
  expectStatus(excessiveLifetime.response, 400, 'invitation lifetime upper bound');
} finally {
  await db.end();
}
pass('indefinite invitations, revoked invitation rejection and legacy TTL input bounds');

const lockExpiryScope = await createSetlist(owner, 'QA invitation lock expiry');
const lockExpiryInvite = await invite(owner, lockExpiryScope.id, 'viewer');
const expiryDb = new pg.Client({ connectionString: process.env.DATABASE_URL });
const lockDb = new pg.Client({ connectionString: process.env.DATABASE_URL });
await Promise.all([expiryDb.connect(), lockDb.connect()]);
try {
  await expiryDb.query(
    "UPDATE setlist_invitations SET expires_at = clock_timestamp() + interval '350 milliseconds' WHERE token_hash = $1",
    [tokenHash(lockExpiryInvite.token)],
  );
  await lockDb.query('BEGIN');
  await lockDb.query('SELECT id FROM libraries WHERE id = $1 FOR UPDATE', [lockExpiryScope.id]);
  const delayedAcceptance = accept(inviteeB, lockExpiryInvite.token);
  await delay(600);
  await lockDb.query('COMMIT');
  const delayedResult = await delayedAcceptance;
  expectStatus(delayedResult.response, 200, 'indefinite invitation survives lock wait');
} finally {
  await lockDb.query('ROLLBACK').catch(() => undefined);
  await Promise.all([expiryDb.end(), lockDb.end()]);
}
pass('indefinite invitation survives legacy expiry after lock wait');

const raceScope = await createSetlist(owner, 'QA invitation race');
const raceInvite = await invite(owner, raceScope.id, 'viewer');
const accepts = await Promise.all([
  accept(inviteeA, raceInvite.token),
  accept(inviteeB, raceInvite.token),
]);
const acceptStatuses = accepts.map((result) => result.response.status).sort((a, b) => a - b);
assert.deepEqual(acceptStatuses, [200, 409], 'one invitation can be accepted by only one identity');
const raceMembers = await json(owner, `/v1/setlists/${raceScope.id}/members`);
expectStatus(raceMembers.response, 200, 'race membership list');
assert.equal(raceMembers.value.members.length, 2, 'exactly one invitee is added');
pass('concurrent invitation acceptance is atomic');

const raceOwners = await createSetlist(owner, 'QA owner race');
const secondOwnerInvite = await invite(owner, raceOwners.id, 'editor');
const secondOwnerAcceptance = await accept(inviteeA, secondOwnerInvite.token);
expectStatus(secondOwnerAcceptance.response, 200, 'second owner fixture membership');
const memberRows = await json(owner, `/v1/setlists/${raceOwners.id}/members`);
const inviteeUser = memberRows.value.members.find(
  (member) => member.user.username === 'qa-invitee-a',
);
assert.ok(inviteeUser, 'second owner fixture must appear in member list');
const promoteResult = await api(
  owner,
  `/v1/setlists/${raceOwners.id}/members/${inviteeUser.user.id}`,
  { method: 'PATCH', body: { role: 'owner' } },
);
expectStatus(promoteResult, 200, 'promote second owner');
const raceMemberRows = await json(owner, `/v1/setlists/${raceOwners.id}/members`);
const ownerIds = raceMemberRows.value.members
  .filter((member) => member.role === 'owner')
  .map((member) => member.user.id);
assert.equal(ownerIds.length, 2);
const ownerIdsResolved = raceMemberRows.value.members
  .filter((member) => member.role === 'owner')
  .map((member) => member.user.id);
const demotions = await Promise.all(
  ownerIdsResolved.map((userId) =>
    api(owner, `/v1/setlists/${raceOwners.id}/members/${userId}`, {
      method: 'PATCH',
      body: { role: 'viewer' },
    }),
  ),
);
assert.ok(
  demotions.some((response) => response.status === 200) &&
    demotions.some((response) => [403, 409].includes(response.status)),
  'concurrent demotions preserve at least one owner',
);
let retainedOwnerCount = await ownerCount(owner, raceOwners.id);
if (retainedOwnerCount === 0) retainedOwnerCount = await ownerCount(inviteeA, raceOwners.id);
assert.ok(retainedOwnerCount >= 1, 'setlist must retain an owner after race');
pass('concurrent last-owner demotions preserve an owner');

const deletedScope = await createSetlist(owner, 'QA deleted setlist');
const pendingInvite = await invite(owner, deletedScope.id, 'viewer');
const deletedSong = await createSong(owner, deletedScope.id, 'Deleted scope media');
expectStatus(deletedSong.response, 201, 'deleted scope song');
const deletedMedia = await uploadImage(owner, deletedScope.id, deletedSong.song);
expectStatus(deletedMedia.response, 201, 'deleted scope media');
const currentDeletedScope = (await json(owner, '/v1/setlists')).value.setlists.find(
  (item) => item.id === deletedScope.id,
);
assert.ok(currentDeletedScope, 'deleted setlist remains accessible before deletion');
const deleteScope = await api(owner, `/v1/setlists/${deletedScope.id}`, {
  method: 'DELETE',
  headers: { 'if-match': String(currentDeletedScope.revision) },
});
expectStatus(deleteScope, 200, 'soft delete setlist');
const deletedSnapshot = await api(owner, `/v1/setlists/${deletedScope.id}/snapshot`);
expectStatus(deletedSnapshot, 404, 'deleted scope snapshot');
const deletedMediaFetch = await api(owner, deletedMedia.attachment.contentUrl);
expectStatus(deletedMediaFetch, 404, 'deleted scope media');
const deletedInvites = await api(owner, `/v1/setlists/${deletedScope.id}/invitations`);
expectStatus(deletedInvites, 404, 'deleted scope invitations');
const deletedAcceptance = await accept(inviteeB, pendingInvite.token);
expectStatus(deletedAcceptance.response, 409, 'deleted scope invitation acceptance');
const deletedCreate = await createSong(owner, deletedScope.id, 'Denied after setlist deletion');
expectStatus(deletedCreate.response, 404, 'deleted scope song creation');
for (const method of ['PATCH', 'DELETE']) {
  const deniedSong = await api(
    owner,
    `/v1/setlists/${deletedScope.id}/songs/${deletedSong.song.id}`,
    {
      method,
      headers: { 'if-match': '2' },
      ...(method === 'PATCH' ? { body: { title: 'Denied edit' } } : {}),
    },
  );
  expectStatus(deniedSong, 404, `deleted scope song ${method}`);
}
const deletedUpload = await uploadImage(owner, deletedScope.id, {
  ...deletedSong.song,
  revision: 2,
});
expectStatus(deletedUpload.response, 404, 'deleted scope media upload');
const deletedMediaDelete = await api(
  owner,
  `/v1/setlists/${deletedScope.id}/attachments/${deletedMedia.attachment.id}`,
  { method: 'DELETE', headers: { 'if-match': '2' } },
);
expectStatus(deletedMediaDelete, 404, 'deleted scope media deletion');
const deletedInviteCreate = await api(owner, `/v1/setlists/${deletedScope.id}/invitations`, {
  method: 'POST',
  body: { role: 'viewer', expiresInHours: 24 },
});
expectStatus(deletedInviteCreate, 404, 'deleted scope invitation creation');
const copyDeletedSource = await api(
  owner,
  `/v1/setlists/${deletedScope.id}/songs/${deletedSong.song.id}/copy`,
  { method: 'POST', body: { targetSetlistId: target.id } },
);
expectStatus(copyDeletedSource, 404, 'copy from deleted scope');
const copyDeletedTarget = await api(
  owner,
  `/v1/setlists/${source.id}/songs/${scopedFirst.song.id}/copy`,
  { method: 'POST', body: { targetSetlistId: deletedScope.id } },
);
expectStatus(copyDeletedTarget, 404, 'copy into deleted scope');
pass('deleted setlist blocks snapshots, media, invitations, nested writes and copies');

const uploadScope = await createSetlist(owner, 'QA upload revocation');
const uploadInvite = await invite(owner, uploadScope.id, 'editor');
const uploadMember = await accept(inviteeB, uploadInvite.token);
expectStatus(uploadMember.response, 200, 'upload editor invitation');
const uploadSongResult = await createSong(inviteeB, uploadScope.id, 'Upload to revoke');
expectStatus(uploadSongResult.response, 201, 'upload editor creates song');
const uploadSong = uploadSongResult.song;
const attachmentId = randomUUID();
const boundary = `qa-${randomUUID()}`;
const fileBytes = Buffer.alloc(6 * 1024 * 1024, 0x41);
fileBytes.set([0xff, 0xd8, 0xff]);
const multipartStart = Buffer.from(
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="qa-slow.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
);
const multipartEnd = Buffer.from(`\r\n--${boundary}--\r\n`);
let firstChunkSent;
const firstChunk = new Promise((resolve) => {
  firstChunkSent = resolve;
});
const slowBody = new ReadableStream({
  async start(controller) {
    controller.enqueue(multipartStart);
    for (let offset = 0; offset < fileBytes.length; offset += 64 * 1024) {
      controller.enqueue(
        fileBytes.subarray(offset, Math.min(offset + 64 * 1024, fileBytes.length)),
      );
      if (offset === 0) firstChunkSent();
      await delay(25);
    }
    controller.enqueue(multipartEnd);
    controller.close();
  },
});
const slowUpload = api(
  inviteeB,
  `/v1/setlists/${uploadScope.id}/songs/${uploadSong.id}/attachments`,
  {
    method: 'POST',
    headers: {
      'x-attachment-id': attachmentId,
      'if-match': String(uploadSong.revision),
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    body: slowBody,
    duplex: 'half',
  },
);
await firstChunk;
await delay(150);
const uploadMembers = await json(owner, `/v1/setlists/${uploadScope.id}/members`);
expectStatus(uploadMembers.response, 200, 'upload membership list');
const uploadUser = uploadMembers.value.members.find(
  (member) => member.user.username === 'qa-invitee-b',
);
assert.ok(uploadUser, 'upload member fixture exists');
const revokedUploadMember = await api(
  owner,
  `/v1/setlists/${uploadScope.id}/members/${uploadUser.user.id}`,
  { method: 'DELETE' },
);
expectStatus(revokedUploadMember, 200, 'revoke membership during upload');
const uploadResponse = await slowUpload;
assert.equal(uploadResponse.status, 403, 'revoked membership must fail before upload finalization');
assert.equal(
  await countObjects(`attachments/${attachmentId}/`),
  0,
  'revoked upload object must be cleaned up',
);
pass('membership revocation during slow upload blocks finalization');

const sessionScope = await createSetlist(owner, 'QA session upload revocation');
const sessionInvite = await invite(owner, sessionScope.id, 'editor');
expectStatus(
  (await accept(inviteeA, sessionInvite.token)).response,
  200,
  'session upload editor invitation',
);
const sessionSongResult = await createSong(inviteeA, sessionScope.id, 'Upload after logout');
expectStatus(sessionSongResult.response, 201, 'session upload editor creates song');
const sessionAttachmentId = randomUUID();
const sessionBoundary = `qa-${randomUUID()}`;
const sessionBytes = Buffer.alloc(2 * 1024 * 1024, 0x42);
sessionBytes.set([0xff, 0xd8, 0xff]);
const sessionStart = Buffer.from(
  `--${sessionBoundary}\r\nContent-Disposition: form-data; name="file"; filename="qa-session.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
);
const sessionEnd = Buffer.from(`\r\n--${sessionBoundary}--\r\n`);
let sessionChunkSent;
const sessionFirstChunk = new Promise((resolve) => {
  sessionChunkSent = resolve;
});
const sessionBody = new ReadableStream({
  async start(controller) {
    controller.enqueue(sessionStart);
    for (let offset = 0; offset < sessionBytes.length; offset += 64 * 1024) {
      controller.enqueue(
        sessionBytes.subarray(offset, Math.min(offset + 64 * 1024, sessionBytes.length)),
      );
      if (offset === 0) sessionChunkSent();
      await delay(25);
    }
    controller.enqueue(sessionEnd);
    controller.close();
  },
});
const sessionUpload = api(
  inviteeA,
  `/v1/setlists/${sessionScope.id}/songs/${sessionSongResult.song.id}/attachments`,
  {
    method: 'POST',
    headers: {
      'x-attachment-id': sessionAttachmentId,
      'if-match': String(sessionSongResult.song.revision),
      'content-type': `multipart/form-data; boundary=${sessionBoundary}`,
    },
    body: sessionBody,
    duplex: 'half',
  },
);
await sessionFirstChunk;
await delay(100);
const logoutDuringUpload = await api(inviteeA, '/v1/auth/logout', { method: 'POST' });
expectStatus(logoutDuringUpload, 204, 'logout while upload is streaming');
const sessionUploadResponse = await sessionUpload;
assert.equal(
  sessionUploadResponse.status,
  401,
  'revoked session must fail before upload finalization',
);
assert.equal(
  await countObjects(`attachments/${sessionAttachmentId}/`),
  0,
  'logged-out upload object must be cleaned up',
);
pass('logout during slow upload blocks finalization');

const inviteeAFresh = await login('qa-invitee-a');
const legacyInvite = await invite(owner, legacy.id, 'editor');
const legacyInviteAccepted = await accept(inviteeAFresh, legacyInvite.token);
expectStatus(legacyInviteAccepted.response, 200, 'legacy second owner invitation');
const legacyMembers = await json(owner, `/v1/setlists/${legacy.id}/members`);
expectStatus(legacyMembers.response, 200, 'legacy memberships');
const oldOwnerUser = (await (await api(owner, '/v1/auth/session')).json()).user;
const oldOwnerMember = legacyMembers.value.members.find(
  (member) => member.user.id === oldOwnerUser.id,
);
assert.ok(oldOwnerMember?.role === 'owner', 'bootstrap owner must remain owner before demotion');
const newLegacyOwner = legacyMembers.value.members.find(
  (member) => member.user.username === 'qa-invitee-a',
);
assert.ok(newLegacyOwner, 'replacement owner fixture exists');
const promoteLegacy = await api(
  owner,
  `/v1/setlists/${legacy.id}/members/${newLegacyOwner.user.id}`,
  { method: 'PATCH', body: { role: 'owner' } },
);
expectStatus(promoteLegacy, 200, 'promote legacy second owner');
const removeBootstrapOwner = await api(
  owner,
  `/v1/setlists/${legacy.id}/members/${oldOwnerMember.user.id}`,
  { method: 'DELETE' },
);
expectStatus(removeBootstrapOwner, 200, 'remove adopted bootstrap owner');
const bootstrap = spawn('npm', ['run', 'db:bootstrap-legacy'], {
  env: process.env,
  stdio: 'ignore',
});
const bootstrapExit = await new Promise((resolve, reject) => {
  bootstrap.once('error', reject);
  bootstrap.once('exit', resolve);
});
assert.equal(bootstrapExit, 0, 'bootstrap replay must be idempotent after intentional removal');
const bootstrapDenied = await api(owner, `/v1/setlists/${legacy.id}/snapshot`);
assert.ok(
  [403, 404].includes(bootstrapDenied.status),
  'bootstrap replay must not restore removed owner membership',
);
const otherLegacyOwner = await api(inviteeAFresh, `/v1/setlists/${legacy.id}/snapshot`);
expectStatus(
  otherLegacyOwner,
  200,
  'remaining database owner still works without environment bootstrap',
);
pass('legacy adoption replay never restores a deliberately removed owner');

console.log(`Setlist API QA passed ${passed} scenario groups`);
