import { verifyDisposableDatabase, dropVerificationDatabase } from './disposable-environment.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { LIBRARY_ID } from '../db/schema.js';

verifyDisposableDatabase();
const { config } = await import('../config.js');

test('migrations seed a clean database and enforce integrity', async () => {
  const name = `setlist_verify_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: config.databaseUrl });
  await admin.connect();
  let pool: pg.Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(config.databaseUrl);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
    const seeded = await pool.query('SELECT id, revision FROM libraries');
    assert.deepEqual(seeded.rows, [{ id: LIBRARY_ID, revision: '0' }]);
    await assert.rejects(pool.query('UPDATE libraries SET revision = -1'), { code: '23514' });
    await assert.rejects(
      pool.query(
        'INSERT INTO songs (id,library_id,title,artist,create_key,create_hash) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), randomUUID(), 'a', 'b', 'x', '0'.repeat(64)],
      ),
      { code: '23503' },
    );
    const songId = randomUUID();
    await pool.query(
      'INSERT INTO songs (id,library_id,title,artist,create_key,create_hash) VALUES ($1,$2,$3,$4,$5,$6)',
      [songId, LIBRARY_ID, 'a', 'b', 'x', '0'.repeat(64)],
    );
    await assert.rejects(
      pool.query(
        'INSERT INTO songs (id,library_id,title,artist,create_key,create_hash) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), LIBRARY_ID, 'a', 'b', 'x', '0'.repeat(64)],
      ),
      { code: '23505' },
    );
    const foreignLibrary = randomUUID(),
      foreignSong = randomUUID(),
      tagId = randomUUID(),
      foreignTag = randomUUID();
    await pool.query('INSERT INTO libraries (id) VALUES ($1)', [foreignLibrary]);
    await pool.query(
      'INSERT INTO songs (id,library_id,title,artist,create_key,create_hash) VALUES ($1,$2,$3,$4,$5,$6)',
      [foreignSong, foreignLibrary, 'a', 'b', 'foreign', '0'.repeat(64)],
    );
    await pool.query(
      'INSERT INTO tags (id,library_id,name,normalized_name) VALUES ($1,$2,$3,$4),($5,$6,$3,$4)',
      [tagId, LIBRARY_ID, 'Tag', 'tag', foreignTag, foreignLibrary],
    );
    await assert.rejects(
      pool.query('INSERT INTO tags (id,library_id,name,normalized_name) VALUES ($1,$2,$3,$4)', [
        randomUUID(),
        LIBRARY_ID,
        'TAG',
        'tag',
      ]),
      { code: '23505' },
    );
    for (const [scope, song, tag] of [
      [LIBRARY_ID, songId, foreignTag],
      [LIBRARY_ID, foreignSong, tagId],
      [foreignLibrary, songId, foreignTag],
    ]) {
      await assert.rejects(
        pool.query('INSERT INTO song_tags (library_id,song_id,tag_id) VALUES ($1,$2,$3)', [
          scope,
          song,
          tag,
        ]),
        { code: '23503' },
      );
    }
    assert.equal(
      (await pool.query('SELECT color FROM tags WHERE id=$1', [tagId])).rows[0].color,
      null,
    );
    await pool.query('UPDATE tags SET color=$1 WHERE id=$2', ['#82A5ED', tagId]);
    for (const color of ['#abc', '#82a5ed', '#82A5EDFF', 'red', '']) {
      await assert.rejects(pool.query('UPDATE tags SET color=$1 WHERE id=$2', [color, tagId]));
    }
    await pool.query('INSERT INTO song_tags (library_id,song_id,tag_id) VALUES ($1,$2,$3)', [
      LIBRARY_ID,
      songId,
      tagId,
    ]);
    await pool.query('DELETE FROM tags WHERE id=$1', [tagId]);
    assert.equal((await pool.query('SELECT * FROM song_tags')).rowCount, 0);
    assert.deepEqual(
      (
        await pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='tags' ORDER BY ordinal_position",
        )
      ).rows.map((row) => row.column_name),
      ['id', 'library_id', 'name', 'normalized_name', 'color'],
    );
    const file = [LIBRARY_ID, songId, 'audio', 'audio/mpeg', 'test.mp3', 3, '0'.repeat(64)];
    await pool.query(
      'INSERT INTO attachments (id,library_id,song_id,kind,mime_type,filename,byte_size,checksum,object_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [randomUUID(), ...file, 'first'],
    );
    await assert.rejects(
      pool.query(
        'INSERT INTO attachments (id,library_id,song_id,kind,mime_type,filename,byte_size,checksum,object_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [randomUUID(), ...file, 'second'],
      ),
      { code: '23505' },
    );
  } finally {
    if (pool) await pool.end();
    await dropVerificationDatabase(admin, name);
    await admin.end();
  }
});
