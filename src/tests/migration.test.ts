import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { config } from '../config.js'
import { LIBRARY_ID } from '../db/schema.js'

test('migrations seed a clean database and enforce integrity', async () => {
  const name = `setlist_verify_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Client({ connectionString: config.databaseUrl })
  await admin.connect()
  let pool: pg.Pool | undefined
  try {
    await admin.query(`CREATE DATABASE ${name}`)
    const url = new URL(config.databaseUrl)
    url.pathname = `/${name}`
    pool = new pg.Pool({ connectionString: url.toString() })
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' })
    const seeded = await pool.query('SELECT id, revision FROM libraries')
    assert.deepEqual(seeded.rows, [{ id: LIBRARY_ID, revision: '0' }])
    await assert.rejects(pool.query('UPDATE libraries SET revision = -1'), { code: '23514' })
    await assert.rejects(pool.query('INSERT INTO songs (id,library_id,title,artist,create_key,create_hash) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), randomUUID(), 'a', 'b', 'x', '0'.repeat(64)]), { code: '23503' })
    const songId = randomUUID()
    await pool.query('INSERT INTO songs (id,library_id,title,artist,create_key,create_hash) VALUES ($1,$2,$3,$4,$5,$6)', [songId, LIBRARY_ID, 'a', 'b', 'x', '0'.repeat(64)])
    await assert.rejects(pool.query('INSERT INTO songs (id,library_id,title,artist,create_key,create_hash) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), LIBRARY_ID, 'a', 'b', 'x', '0'.repeat(64)]), { code: '23505' })
    const file = [LIBRARY_ID, songId, 'audio', 'audio/mpeg', 'test.mp3', 3, '0'.repeat(64)]
    await pool.query('INSERT INTO attachments (id,library_id,song_id,kind,mime_type,filename,byte_size,checksum,object_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [randomUUID(), ...file, 'first'])
    await assert.rejects(pool.query('INSERT INTO attachments (id,library_id,song_id,kind,mime_type,filename,byte_size,checksum,object_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [randomUUID(), ...file, 'second']), { code: '23505' })
  } finally {
    if (pool) await pool.end()
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await admin.end()
  }
})
