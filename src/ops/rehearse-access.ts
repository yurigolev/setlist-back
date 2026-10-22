import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { verifyDisposableApi } from '../tests/disposable-environment.js';

// This utility may manufacture an identity only inside the explicitly isolated copy.
verifyDisposableApi();
if (process.env.NODE_ENV !== 'test')
  throw new Error('Rehearsal access checks require NODE_ENV=test');
const { config } = await import('../config.js');
const { pool } = await import('../db/client.js');
const { LIBRARY_ID } = await import('../db/schema.js');
const { buildApp } = await import('../app.js');
const { prepareLegacyOwner, applyLegacyOwner } = await import('./legacy-owner-plan.js');
const token = randomBytes(32).toString('base64url');
const csrf = randomBytes(32).toString('base64url');
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
try {
  const existingOwner = (
    await pool.query(
      "SELECT user_id FROM setlist_memberships WHERE setlist_id=$1 AND role='owner' ORDER BY user_id LIMIT 1",
      [LIBRARY_ID],
    )
  ).rows[0]?.user_id;
  const userId = existingOwner ?? randomUUID();
  if (!existingOwner)
    await pool.query(
      'INSERT INTO auth_users (id,issuer,subject,display_name) VALUES ($1,$2,$3,$4)',
      [
        userId,
        'https://oauth.telegram.org',
        `release-qa-${randomUUID()}`,
        'Synthetic release QA owner',
      ],
    );
  await pool.query(
    "INSERT INTO auth_sessions (token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,$3,now()+interval '10 minutes')",
    [createHash('sha256').update(token).digest('hex'), userId, csrf],
  );
  app = await buildApp({ initializeStorage: false });
  app.log.level = 'silent';
  const headers = { cookie: `setlist_session=${token}` };
  const path = `/v1/setlists/${LIBRARY_ID}/snapshot`;
  assert.equal((await app.inject({ method: 'GET', url: path })).statusCode, 401);
  if (!existingOwner) {
    assert.equal((await app.inject({ method: 'GET', url: path, headers })).statusCode, 403);
    const plan = await prepareLegacyOwner(pool, config.databaseUrl, userId);
    assert.equal(await applyLegacyOwner(pool, config.databaseUrl, plan), 'adopted');
    assert.equal(await applyLegacyOwner(pool, config.databaseUrl, plan), 'already-adopted');
  }
  const response = await app.inject({ method: 'GET', url: path, headers });
  assert.equal(response.statusCode, 200);
  const snapshot = response.json();
  assert.equal(snapshot.role, 'owner');
  const activeSongs = (
    await pool.query(
      'SELECT count(*)::int AS count FROM songs WHERE library_id=$1 AND deleted_at IS NULL',
      [LIBRARY_ID],
    )
  ).rows[0].count;
  assert.equal(snapshot.songs.length, activeSongs);
  const files = (
    await pool.query(
      'SELECT a.id,a.library_id,a.byte_size::text,a.checksum FROM attachments a JOIN songs s ON s.id=a.song_id WHERE a.deleted_at IS NULL AND s.deleted_at IS NULL AND a.library_id=$1',
      [LIBRARY_ID],
    )
  ).rows;
  for (const file of files) {
    const downloaded: { statusCode: number; rawPayload: Buffer } = await app.inject({
      method: 'GET',
      url: `/v1/setlists/${file.library_id}/attachments/${file.id}/content`,
      headers,
    });
    assert.equal(downloaded.statusCode, 200);
    assert.equal(downloaded.rawPayload.length, Number(file.byte_size));
    assert.equal(createHash('sha256').update(downloaded.rawPayload).digest('hex'), file.checksum);
  }
  const outsiderId = randomUUID();
  const outsiderToken = randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO auth_users (id,issuer,subject,display_name) VALUES ($1,$2,$3,$4)', [
    outsiderId,
    'https://oauth.telegram.org',
    `release-qa-${randomUUID()}`,
    'Synthetic release QA outsider',
  ]);
  await pool.query(
    "INSERT INTO auth_sessions (token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,$3,now()+interval '10 minutes')",
    [createHash('sha256').update(outsiderToken).digest('hex'), outsiderId, csrf],
  );
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: path,
        headers: { cookie: `setlist_session=${outsiderToken}` },
      })
    ).statusCode,
    403,
  );
  await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1', [
    createHash('sha256').update(token).digest('hex'),
  ]);
  assert.equal((await app.inject({ method: 'GET', url: path, headers })).statusCode, 401);
  console.log(
    JSON.stringify({
      owner: existingOwner ? 'existing-owner-in-copy' : 'synthetic-owner-in-copy',
      songs: activeSongs,
      downloadedAttachments: files.length,
      anonymousDenied: true,
      outsiderDenied: true,
      revokedSessionDenied: true,
    }),
  );
} finally {
  await app?.close();
  await pool.end();
}
