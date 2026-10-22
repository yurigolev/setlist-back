import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { PgAuthStore } from '../auth/store.js';
import { SESSION_COOKIE, tokenHash } from '../auth/routes.js';
import type { AuthConfig, TelegramOidc } from '../auth/types.js';
import { LIBRARY_ID } from '../db/schema.js';

const databaseUrl = process.env.AUTH_QA_DATABASE_URL;
const minioPort = Number(process.env.AUTH_QA_MINIO_PORT);
const minioBucket = process.env.AUTH_QA_BUCKET ?? 'setlist-qa-files';
const issuer = 'https://oauth.telegram.org';
const headerText = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value.join(' ') : (value ?? '');

test(
  'isolated pre-auth migration preserves legacy IDs/object keys and buildApp protects legacy API/media',
  { skip: !databaseUrl || !process.env.AUTH_QA_MINIO_PORT },
  async (t) => {
    const adminUrl = new URL(databaseUrl!);
    const expectedPort = Number(process.env.AUTH_QA_PG_PORT);
    const projectName = process.env.AUTH_QA_PROJECT_NAME ?? '';
    const adminName = adminUrl.pathname.slice(1);
    assert.ok(
      projectName.startsWith('setlist-auth-qa-'),
      'QA Compose project must use its own namespace',
    );
    assert.ok(['127.0.0.1', 'localhost'].includes(adminUrl.hostname), 'QA database must be local');
    assert.equal(Number(adminUrl.port), expectedPort, 'database URL must use the explicit QA port');
    assert.notEqual(expectedPort, 5432, 'refuse the shared/default PostgreSQL port');
    assert.match(
      adminName,
      /^setlist_auth_qa_[a-z0-9_]+$/,
      'database URL must target a dedicated QA database',
    );
    assert.ok(
      ['127.0.0.1', 'localhost'].includes(process.env.AUTH_QA_MINIO_ENDPOINT ?? '127.0.0.1'),
    );
    assert.notEqual(minioPort, 9000, 'refuse the shared/default MinIO port');
    assert.ok(minioBucket.startsWith('setlist-qa-'), 'MinIO bucket must be isolated for QA');

    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    const testDatabase = `setlist_auth_qa_it_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE "${testDatabase}"`);
    const testDatabaseUrl = new URL(databaseUrl!);
    testDatabaseUrl.pathname = `/${testDatabase}`;
    const pool = new pg.Pool({ connectionString: testDatabaseUrl.toString() });
    let app: FastifyInstance | undefined;
    let appPool: pg.Pool | undefined;
    t.after(async () => {
      if (app) await app.close();
      if (appPool) await appPool.end();
      await pool.end();
      await admin.end();
    });

    const dbInfo = await pool.query<{ name: string }>('SELECT current_database() AS name');
    assert.equal(dbInfo.rows[0]?.name, testDatabase);

    // Build the exact pre-auth schema first, then place legacy rows and media before
    // applying the additive auth migration.
    for (const migration of [
      '0000_bent_valkyrie.sql',
      '0001_modern_lila_cheney.sql',
      '0002_massive_blockbuster.sql',
    ]) {
      const sql = await readFile(`./drizzle/${migration}`, 'utf8');
      for (const statement of sql
        .split(/-->\s*statement-breakpoint/g)
        .map((part) => part.trim())
        .filter(Boolean))
        await pool.query(statement);
    }

    const { Client: MinioClient } = await import('minio');
    const minio = new MinioClient({
      endPoint: process.env.AUTH_QA_MINIO_ENDPOINT ?? '127.0.0.1',
      port: minioPort,
      useSSL: false,
      accessKey: process.env.AUTH_QA_MINIO_USER ?? 'qa_minio',
      secretKey: process.env.AUTH_QA_MINIO_PASSWORD ?? 'qa_minio_ephemeral_only',
    });
    if (!(await minio.bucketExists(minioBucket))) await minio.makeBucket(minioBucket);

    const songId = '22222222-2222-4222-8222-222222222222';
    const attachmentId = '33333333-3333-4333-8333-333333333333';
    const objectKey = 'attachments/legacy/keep-this-key.mp3';
    const audio = Buffer.from('legacy attachment bytes survive auth migration', 'utf8');
    const checksum = createHash('sha256').update(audio).digest('hex');
    await pool.query('UPDATE libraries SET revision=7 WHERE id=$1', [LIBRARY_ID]);
    assert.equal(
      (await pool.query('SELECT id FROM libraries WHERE id=$1', [LIBRARY_ID])).rowCount,
      1,
    );
    await pool.query(
      'INSERT INTO songs (id,library_id,title,artist,notes,revision,create_key,create_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        songId,
        LIBRARY_ID,
        'Legacy QA Song',
        'Preserved Artist',
        'before auth migration',
        3,
        randomUUID(),
        'a'.repeat(64),
      ],
    );
    await pool.query(
      'INSERT INTO attachments (id,library_id,song_id,kind,mime_type,filename,byte_size,checksum,object_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        attachmentId,
        LIBRARY_ID,
        songId,
        'audio',
        'audio/mpeg',
        'legacy.mp3',
        audio.byteLength,
        checksum,
        objectKey,
      ],
    );
    await minio.putObject(minioBucket, objectKey, audio, audio.byteLength, {
      'Content-Type': 'audio/mpeg',
    });
    const before = await pool.query(
      'SELECT s.id AS song_id, s.title, a.id AS attachment_id, a.object_key, a.checksum FROM songs s JOIN attachments a ON a.song_id=s.id WHERE s.id=$1',
      [songId],
    );

    for (const migration of [
      '0003_telegram_auth.sql',
      '0004_bouncy_vertigo.sql',
      '0005_smart_wrecker.sql',
      '0006_indefinite_invites.sql',
      '0007_refresh_sessions.sql',
    ]) {
      const source = await readFile(`./drizzle/${migration}`, 'utf8');
      for (const statement of source
        .split(/-->\s*statement-breakpoint/g)
        .map((part) => part.trim())
        .filter(Boolean))
        await pool.query(statement);
    }
    assert.equal(
      (await pool.query('SELECT revision FROM libraries WHERE id=$1', [LIBRARY_ID])).rows[0]
        .revision,
      '7',
    );
    assert.equal((await pool.query('SELECT * FROM setlist_memberships')).rowCount, 0);
    const after = await pool.query(
      'SELECT s.id AS song_id, s.title, a.id AS attachment_id, a.object_key, a.checksum FROM songs s JOIN attachments a ON a.song_id=s.id WHERE s.id=$1',
      [songId],
    );
    assert.deepEqual(after.rows, before.rows);
    assert.equal(after.rows[0].song_id, songId);
    assert.equal(after.rows[0].attachment_id, attachmentId);
    assert.equal(after.rows[0].object_key, objectKey);
    assert.deepEqual(
      await minio.getObject(minioBucket, objectKey).then(
        (stream) =>
          new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            stream.on('error', reject);
            stream.on('end', () => resolve(Buffer.concat(chunks)));
          }),
      ),
      audio,
    );

    const qaApiPort = Number(process.env.AUTH_QA_API_PORT ?? 46533);
    const qaPwaOrigin = process.env.AUTH_QA_PWA_ORIGIN ?? 'http://127.0.0.1:46534';
    const databaseName = dbInfo.rows[0].name;
    process.env.DOTENV_CONFIG_PATH = '/dev/null';
    process.env.DATABASE_URL = testDatabaseUrl.toString();
    process.env.PWA_ORIGIN = qaPwaOrigin;
    process.env.PORT = String(qaApiPort);
    process.env.AUTH_ALLOW_INSECURE_LOCAL_HTTP = 'true';
    process.env.TELEGRAM_CLIENT_ID = 'qa-integration-client';
    process.env.TELEGRAM_CLIENT_SECRET = 'qa-unused-here';
    process.env.TELEGRAM_REDIRECT_URI = `http://127.0.0.1:${qaApiPort}/v1/auth/telegram/callback`;
    process.env.LEGACY_OWNER_TELEGRAM_ISSUER = issuer;
    process.env.LEGACY_OWNER_TELEGRAM_SUB = 'legacy-owner-subject';
    process.env.MINIO_ENDPOINT = '127.0.0.1';
    process.env.MINIO_PORT = String(minioPort);
    process.env.MINIO_USE_SSL = 'false';
    process.env.MINIO_ACCESS_KEY = process.env.AUTH_QA_MINIO_USER ?? 'qa_minio';
    process.env.MINIO_SECRET_KEY = process.env.AUTH_QA_MINIO_PASSWORD ?? 'qa_minio_ephemeral_only';
    process.env.MINIO_BUCKET = minioBucket;
    assert.ok(databaseName.startsWith('setlist_auth_qa_'));

    const authConfig: AuthConfig = {
      enabled: true,
      clientId: 'qa-integration-client',
      clientSecret: 'qa-unused-here',
      redirectUri: `http://127.0.0.1:${qaApiPort}/v1/auth/telegram/callback`,
      pwaOrigin: qaPwaOrigin,
      secureCookies: false,
      sessionTtlSeconds: 60,
      legacyOwnerIssuer: issuer,
      legacyOwnerSub: 'legacy-owner-subject',
    };
    const { pool: actualAppPool } = await import('../db/client.js');
    appPool = actualAppPool;
    const store = new PgAuthStore(actualAppPool);
    const oidc: TelegramOidc = {
      authorizationUrl: (state) =>
        `https://oidc.qa.invalid/authorize?state=${encodeURIComponent(state)}`,
      async authenticate() {
        return { issuer, subject: 'legacy-owner-subject', displayName: 'Legacy Owner' };
      },
    };
    const { buildApp } = await import('../app.js');
    const instance = await buildApp({
      auth: { config: authConfig, store, oidc },
      initializeStorage: false,
    });
    app = instance;

    const ownerToken = randomBytes(32).toString('base64url');
    const ownerCsrf = randomBytes(32).toString('base64url');
    await store.createSession(
      { issuer, subject: 'legacy-owner-subject', displayName: 'Legacy Owner' },
      tokenHash(ownerToken),
      ownerCsrf,
      new Date(Date.now() + 60_000),
    );
    const ownerCookie = `${SESSION_COOKIE}=${ownerToken}`;

    const unauthenticated = await instance.inject({ method: 'GET', url: '/v1/library/snapshot' });
    assert.equal(unauthenticated.statusCode, 401);
    assert.match(headerText(unauthenticated.headers['cache-control']), /private.*no-store/);
    assert.match(headerText(unauthenticated.headers.pragma), /no-cache/);

    // Login alone cannot adopt legacy data, even with configured issuer/sub.
    assert.equal(
      (
        await instance.inject({
          method: 'GET',
          url: '/v1/library/snapshot',
          headers: { cookie: ownerCookie },
        })
      ).statusCode,
      403,
    );
    await promisify(execFile)(process.execPath, ['dist/ops/bootstrap-legacy.js'], {
      env: { ...process.env },
    });
    assert.equal((await pool.query('SELECT * FROM legacy_adoptions')).rowCount, 1);
    await promisify(execFile)(process.execPath, ['dist/ops/bootstrap-legacy.js'], {
      env: { ...process.env },
    });
    assert.equal((await pool.query('SELECT * FROM setlist_memberships')).rowCount, 1);
    const snapshot = await instance.inject({
      method: 'GET',
      url: '/v1/library/snapshot',
      headers: { cookie: ownerCookie },
    });
    assert.equal(snapshot.statusCode, 200);
    assert.match(headerText(snapshot.headers['cache-control']), /private.*no-store/);
    assert.match(headerText(snapshot.headers.pragma), /no-cache/);
    assert.equal(snapshot.json().libraryId, LIBRARY_ID);
    assert.equal(snapshot.json().libraryRevision, 7);
    const song = snapshot.json().songs.find((item: { id: string }) => item.id === songId);
    assert.equal(song?.title, 'Legacy QA Song');
    assert.equal(song?.revision, 3);
    assert.equal(song?.attachments?.[0]?.id, attachmentId);
    assert.equal(
      song?.attachments?.[0]?.contentUrl,
      `/v1/setlists/${LIBRARY_ID}/attachments/${attachmentId}/content`,
    );

    const media = await instance.inject({
      method: 'GET',
      url: `/v1/attachments/${attachmentId}/content`,
      headers: { cookie: ownerCookie },
    });
    assert.equal(media.statusCode, 200);
    assert.equal(media.headers['content-type'], 'audio/mpeg');
    assert.deepEqual(Buffer.from(media.rawPayload), audio);
    assert.match(headerText(media.headers['cache-control']), /private.*no-store/);

    const outsiderToken = randomBytes(32).toString('base64url');
    const outsiderCsrf = randomBytes(32).toString('base64url');
    await store.createSession(
      { issuer, subject: 'unrelated-telegram-subject', displayName: 'Outsider' },
      tokenHash(outsiderToken),
      outsiderCsrf,
      new Date(Date.now() + 60_000),
    );
    const outsiderCookie = `${SESSION_COOKIE}=${outsiderToken}`;
    const outsiderSnapshot = await instance.inject({
      method: 'GET',
      url: '/v1/library/snapshot',
      headers: { cookie: outsiderCookie },
    });
    assert.equal(outsiderSnapshot.statusCode, 403);
    assert.match(headerText(outsiderSnapshot.headers['cache-control']), /private.*no-store/);
    const outsiderMedia = await instance.inject({
      method: 'GET',
      url: `/v1/attachments/${attachmentId}/content`,
      headers: { cookie: outsiderCookie },
    });
    assert.equal(outsiderMedia.statusCode, 403);
    assert.match(headerText(outsiderMedia.headers['cache-control']), /private.*no-store/);
    const outsiderWrite = await instance.inject({
      method: 'POST',
      url: '/v1/songs',
      headers: {
        cookie: outsiderCookie,
        origin: qaPwaOrigin,
        'x-csrf-token': outsiderCsrf,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      payload: { title: 'Outsider write', artist: 'Denied' },
    });
    assert.equal(outsiderWrite.statusCode, 403);
    assert.equal(
      (await pool.query('SELECT id FROM songs WHERE title=$1', ['Outsider write'])).rowCount,
      0,
    );

    const write = await instance.inject({
      method: 'POST',
      url: '/v1/songs',
      headers: {
        cookie: ownerCookie,
        origin: qaPwaOrigin,
        'x-csrf-token': ownerCsrf,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      payload: { title: 'Owner write', artist: 'Authorized' },
    });
    assert.equal(write.statusCode, 201);

    const logout = await instance.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: ownerCookie, origin: qaPwaOrigin, 'x-csrf-token': ownerCsrf },
    });
    assert.equal(logout.statusCode, 204);
    const afterLogout = await instance.inject({
      method: 'GET',
      url: '/v1/library/snapshot',
      headers: { cookie: ownerCookie },
    });
    assert.equal(afterLogout.statusCode, 401);
  },
);
