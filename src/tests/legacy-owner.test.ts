import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { LIBRARY_ID } from '../db/schema.js';
import { applyLegacyOwner, prepareLegacyOwner } from '../ops/legacy-owner-plan.js';
import { dropVerificationDatabase, verifyDisposableDatabase } from './disposable-environment.js';

verifyDisposableDatabase();

test('reviewed legacy adoption is explicit, atomic, database-bound and safe to replay', async () => {
  const name = `setlist_verify_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  let pool: pg.Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${name}`;
    const databaseUrl = url.toString();
    pool = new pg.Pool({ connectionString: databaseUrl });
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
    const ownerId = randomUUID(),
      otherId = randomUUID();
    await pool.query(
      'INSERT INTO auth_users (id,issuer,subject,display_name) VALUES ($1,$2,$3,$4),($5,$2,$6,$7)',
      [
        ownerId,
        'https://login.yandex.ru',
        'verified-owner',
        'Owner',
        otherId,
        'verified-other',
        'Other',
      ],
    );
    const telegramId = randomUUID();
    await pool.query(
      'INSERT INTO auth_users (id,issuer,subject,display_name) VALUES ($1,$2,$3,$4)',
      [telegramId, 'https://oauth.telegram.org', 'verified-owner', 'Owner'],
    );
    await assert.rejects(
      prepareLegacyOwner(pool, databaseUrl, telegramId),
      /https:\/\/login.yandex.ru/,
    );
    assert.equal(
      (
        await pool.query('SELECT count(*)::int AS n FROM auth_users WHERE subject=$1', [
          'verified-owner',
        ])
      ).rows[0].n,
      2,
      'same subject across providers remains distinct',
    );
    await assert.rejects(
      prepareLegacyOwner(pool, databaseUrl, randomUUID()),
      /verified authentication/,
    );
    const plan = await prepareLegacyOwner(pool, databaseUrl, ownerId);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM setlist_memberships')).rows[0].n,
      0,
      'planning cannot grant access',
    );
    await assert.rejects(
      applyLegacyOwner(pool, databaseUrl.replace('127.0.0.1', 'localhost'), plan),
      /another database/,
    );
    await assert.rejects(applyLegacyOwner(pool, databaseUrl, { ...plan, version: 2 }));
    await pool.query('UPDATE libraries SET revision=revision+1 WHERE id=$1', [LIBRARY_ID]);
    await assert.rejects(applyLegacyOwner(pool, databaseUrl, plan), /state changed/);
    const current = await prepareLegacyOwner(pool, databaseUrl, ownerId);
    await pool.query(
      'ALTER TABLE legacy_adoptions ADD CONSTRAINT qa_reject_adoption CHECK (false)',
    );
    await assert.rejects(applyLegacyOwner(pool, databaseUrl, current), { code: '23514' });
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM setlist_memberships')).rows[0].n,
      0,
      'failed marker insert must roll back membership',
    );
    await pool.query('ALTER TABLE legacy_adoptions DROP CONSTRAINT qa_reject_adoption');
    const otherPlan = await prepareLegacyOwner(pool, databaseUrl, otherId);
    const concurrent = await Promise.allSettled([
      applyLegacyOwner(pool, databaseUrl, current),
      applyLegacyOwner(pool, databaseUrl, otherPlan),
    ]);
    assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
    const adoptedId = (await pool.query('SELECT user_id FROM legacy_adoptions')).rows[0].user_id;
    const winningPlan = adoptedId === ownerId ? current : otherPlan;
    const losingId = adoptedId === ownerId ? otherId : ownerId;
    await assert.rejects(prepareLegacyOwner(pool, databaseUrl, losingId), /another identity/);
    await pool.query("UPDATE setlist_memberships SET role='viewer' WHERE user_id=$1", [adoptedId]);
    assert.equal(await applyLegacyOwner(pool, databaseUrl, winningPlan), 'already-adopted');
    assert.equal(
      (await pool.query('SELECT role FROM setlist_memberships WHERE user_id=$1', [adoptedId]))
        .rows[0].role,
      'viewer',
    );
    await pool.query('DELETE FROM setlist_memberships WHERE user_id=$1', [adoptedId]);
    assert.equal(await applyLegacyOwner(pool, databaseUrl, winningPlan), 'already-adopted');
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM setlist_memberships')).rows[0].n,
      0,
    );
    await pool.query('DELETE FROM legacy_adoptions');
    await pool.query(
      "INSERT INTO setlist_memberships (setlist_id,user_id,role) VALUES ($1,$2,'owner')",
      [LIBRARY_ID, ownerId],
    );
    await assert.rejects(prepareLegacyOwner(pool, databaseUrl, ownerId), /manual review/);
    assert.equal(
      (await pool.query('SELECT revision::text FROM libraries WHERE id=$1', [LIBRARY_ID])).rows[0]
        .revision,
      '1',
    );
  } finally {
    await pool?.end();
    await dropVerificationDatabase(admin, name);
    await admin.end();
  }
});
