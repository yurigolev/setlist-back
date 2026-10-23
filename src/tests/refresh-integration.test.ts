import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { PgAuthStore } from '../auth/store.js';
import { tokenHash } from '../auth/routes.js';
import { verifyDisposableDatabase, dropVerificationDatabase } from './disposable-environment.js';
import type { TokenPair } from '../auth/types.js';

verifyDisposableDatabase();
const token = () => randomBytes(32).toString('base64url');
const pair = (): TokenPair => ({
  accessHash: tokenHash(token()),
  refreshHash: tokenHash(token()),
  accessExpiresAt: new Date(Date.now() + 900000),
  refreshExpiresAt: new Date(Date.now() + 7776000000),
});

test('PostgreSQL refresh: upgrade existing sessions, concurrent rotation, sliding expiry and replay revoke', async () => {
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const name = `setlist_verify_${randomUUID().replaceAll('-', '')}`;
  let pool: pg.Pool | undefined;
  let phase = 'migration';
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.href });
    for (const migration of [
      '0000_bent_valkyrie',
      '0001_modern_lila_cheney',
      '0002_massive_blockbuster',
      '0003_telegram_auth',
      '0004_bouncy_vertigo',
      '0005_smart_wrecker',
      '0006_indefinite_invites',
    ]) {
      const source = await readFile(`drizzle/${migration}.sql`, 'utf8');
      for (const statement of source.split(/-->\s*statement-breakpoint/g).filter((s) => s.trim()))
        await pool.query(statement);
    }
    const userId = randomUUID(),
      legacy = token(),
      csrf = token(),
      expiry = new Date(Date.now() + 60000);
    await pool.query(
      'INSERT INTO auth_users (id,issuer,subject,display_name) VALUES ($1,$2,$3,$4)',
      [userId, 'https://login.yandex.ru', 'legacy', 'Legacy'],
    );
    await pool.query(
      'INSERT INTO auth_sessions (token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,$3,$4)',
      [tokenHash(legacy), userId, csrf, expiry],
    );
    for (const statement of (await readFile('drizzle/0007_refresh_sessions.sql', 'utf8'))
      .split(/-->\s*statement-breakpoint/g)
      .filter((s) => s.trim()))
      await pool.query(statement);
    phase = 'legacy bootstrap';
    const store = new PgAuthStore(pool);
    const old = await store.getSession(tokenHash(legacy));
    assert.equal(old?.familyId, undefined);
    assert.equal(old?.expiresAt.getTime(), expiry.getTime());
    const candidates = [pair(), pair()];
    const bootstraps = await Promise.all([
      store.bootstrapSession(tokenHash(legacy), candidates[0]),
      store.bootstrapSession(tokenHash(legacy), candidates[1]),
    ]);
    assert.deepEqual(bootstraps.map((r) => r.status).sort(), ['conflict', 'rotated']);
    const initial = candidates[bootstraps.findIndex((result) => result.status === 'rotated')];
    const family = (await store.getRefresh(initial.refreshHash))!.familyId!;
    assert.equal(
      (await store.getSession(tokenHash(legacy)))!.expiresAt.getTime(),
      expiry.getTime(),
    );
    // Expired access does not invalidate the refresh family.
    await pool.query(
      "UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE family_id=$1",
      [family],
    );
    assert.equal(await store.getSession(initial.accessHash), undefined);
    await pool.query(
      "UPDATE auth_refresh_families SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",
      [family],
    );
    phase = 'concurrent rotation';
    const next = pair(),
      competitor = pair();
    const results = await Promise.all([
      store.rotateRefresh(initial.refreshHash, next),
      store.rotateRefresh(initial.refreshHash, competitor),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['conflict', 'rotated']);
    const winner = results[0].status === 'rotated' ? next : competitor;
    assert.ok(await store.getSession(winner.accessHash));
    assert.ok(await store.getRefresh(winner.refreshHash));
    const hashes = await pool.query(
      'SELECT token_hash FROM auth_refresh_tokens WHERE family_id=$1',
      [family],
    );
    assert.equal(hashes.rows.length, 2);
    assert.ok(hashes.rows.every((r) => /^[a-f0-9]{64}$/.test(r.token_hash)));
    const renewedExpiry = (
      await pool.query('SELECT expires_at FROM auth_refresh_families WHERE id=$1', [family])
    ).rows[0].expires_at;
    assert.equal(renewedExpiry.getTime(), winner.refreshExpiresAt.getTime());
    await pool.query(
      "UPDATE auth_refresh_tokens SET used_at=clock_timestamp()-interval '11 seconds' WHERE token_hash=$1",
      [initial.refreshHash],
    );
    assert.equal((await store.rotateRefresh(initial.refreshHash, pair())).status, 'invalid');
    assert.equal(await store.getSession(winner.accessHash), undefined);
    assert.equal(await store.getRefresh(winner.refreshHash), undefined);
    assert.ok(
      (await pool.query('SELECT revoked_at FROM auth_refresh_families WHERE id=$1', [family]))
        .rows[0].revoked_at,
    );
    phase = 'logout race';
    // Logout races with rotation on the same family lock and always wins eventually.
    const access = token(),
      refresh = token();
    await store.createSession(
      { issuer: 'https://login.yandex.ru', subject: 'second', displayName: 'Second' },
      tokenHash(access),
      csrf,
      new Date(Date.now() + 60000),
      undefined,
      { hash: tokenHash(refresh), expiresAt: new Date(Date.now() + 7776000000) },
    );
    const rotated = pair();
    await Promise.all([
      store.rotateRefresh(tokenHash(refresh), rotated),
      store.revokeRefresh(tokenHash(refresh)),
    ]);
    assert.equal(await store.getSession(rotated.accessHash), undefined);
    assert.equal(await store.getRefresh(rotated.refreshHash), undefined);
    phase = 'expiry lock wait';
    // Expiry after waiting for the family lock is checked against wall-clock time.
    const third = token(),
      thirdRefresh = token();
    await store.createSession(
      { issuer: 'https://login.yandex.ru', subject: 'third', displayName: 'Third' },
      tokenHash(third),
      csrf,
      new Date(Date.now() + 60000),
      undefined,
      { hash: tokenHash(thirdRefresh), expiresAt: new Date(Date.now() + 7776000000) },
    );
    const thirdFamily = (await store.getRefresh(tokenHash(thirdRefresh)))!.familyId!;
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM auth_refresh_families WHERE id=$1 FOR UPDATE', [
        thirdFamily,
      ]);
      const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const blocked = store.rotateRefresh(tokenHash(thirdRefresh), pair());
      // Observe the real lock wait rather than assume query scheduling order.
      let waiting = false;
      const deadline = Date.now() + 5000;
      while (!waiting && Date.now() < deadline) {
        waiting = (
          await pool.query(
            'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting',
            [blockerPid],
          )
        ).rows[0].waiting;
        if (!waiting) await delay(10);
      }
      if (!waiting) {
        await blocker.query('ROLLBACK');
        await blocked;
        assert.fail('rotation did not wait for the family lock');
      }
      await blocker.query(
        "UPDATE auth_refresh_families SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [thirdFamily],
      );
      await blocker.query('COMMIT');
      assert.equal((await blocked).status, 'invalid');
    } finally {
      blocker.release();
    }
  } catch (error) {
    throw new Error(`PostgreSQL refresh phase: ${phase}`, { cause: error });
  } finally {
    await pool?.end();
    await dropVerificationDatabase(admin, name);
    await admin.end();
  }
});
