import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Client as MinioClient } from 'minio';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const [input, reportFile, ...extra] = process.argv.slice(2);
if (!input || !reportFile || extra.length)
  throw new Error(
    'Usage: npm run release:rehearse -- <complete-backup-directory> <new-report.json>',
  );
const backup = resolve(input);
await access(resolve(backup, 'COMPLETE'));
await access(resolve(backup, 'postgres.dump'));
const manifest = JSON.parse(await readFile(resolve(backup, 'objects/manifest.json'), 'utf8'));
assert.ok(Array.isArray(manifest), 'Object manifest must be an array');
const keys = new Set();
for (const entry of manifest) {
  assert.match(entry.key, /^attachments\/[0-9a-f-]+\/[0-9a-f-]+$/);
  assert.match(entry.checksum, /^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(entry.size) && entry.size > 0 && !keys.has(entry.key));
  keys.add(entry.key);
}
// Reserve the report path before starting anything; never overwrite a prior result.
await writeFile(reportFile, JSON.stringify({ status: 'running' }) + '\n', {
  flag: 'wx',
  mode: 0o600,
});
const suffix = randomBytes(5).toString('hex');
const project = `setlist-auth-qa-release-${suffix}`;
const database = `setlist_auth_qa_release_${suffix}`;
async function freePort() {
  const server = createServer();
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ok);
  });
  const port = server.address().port;
  await new Promise((ok) => server.close(ok));
  return port;
}
const ports = [];
while (ports.length < 3) {
  const port = await freePort();
  if (![3000, 3300, 5432, 9000].includes(port) && !ports.includes(port)) ports.push(port);
}
const [pgPort, minioPort, apiPort] = ports;
const password = randomBytes(24).toString('hex');
const minioPassword = randomBytes(24).toString('hex');
const databaseUrl = `postgres://qa:${password}@127.0.0.1:${pgPort}/${database}`;
const origin = `http://127.0.0.1:${apiPort}`;
const env = {
  ...process.env,
  DOTENV_CONFIG_PATH: '/dev/null',
  DOTENV_CONFIG_QUIET: 'true',
  DOTENV_PATH: '/dev/null',
  DOTENV_QUIET: 'true',
  NODE_ENV: 'test',
  AUTH_QA_PROJECT_NAME: project,
  AUTH_QA_DATABASE_NAME: database,
  AUTH_QA_POSTGRES_USER: 'qa',
  AUTH_QA_POSTGRES_PASSWORD: password,
  AUTH_QA_PG_PORT: String(pgPort),
  AUTH_QA_API_PORT: String(apiPort),
  AUTH_QA_MINIO_PORT: String(minioPort),
  AUTH_QA_MINIO_USER: 'qa_minio',
  AUTH_QA_MINIO_PASSWORD: minioPassword,
  DATABASE_URL: databaseUrl,
  PWA_ORIGIN: origin,
  TEST_API_URL: origin,
  PORT: String(apiPort),
  MINIO_ENDPOINT: '127.0.0.1',
  MINIO_PORT: String(minioPort),
  MINIO_USE_SSL: 'false',
  MINIO_ACCESS_KEY: 'qa_minio',
  MINIO_SECRET_KEY: minioPassword,
  MINIO_BUCKET: `setlist-qa-release-${suffix}`,
  YANDEX_CLIENT_ID: 'release-rehearsal',
  YANDEX_CLIENT_SECRET: randomBytes(24).toString('hex'),
  YANDEX_REDIRECT_URI: `${origin}/v1/auth/yandex/callback`,
  AUTH_ALLOW_INSECURE_LOCAL_HTTP: 'true',
};
delete env.LEGACY_OWNER_YANDEX_ISSUER;
delete env.LEGACY_OWNER_YANDEX_SUB;
const compose = [
  'compose',
  '--env-file',
  '/dev/null',
  '-p',
  project,
  '-f',
  'scripts/qa-auth.compose.yml',
];
let activeChild;
function run(command, args, { capture = false, stdin } = {}) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, {
      env,
      stdio: [stdin ? 'pipe' : 'ignore', capture ? 'pipe' : 'inherit', 'inherit'],
    });
    activeChild = child;
    const chunks = [];
    child.stdout?.on('data', (chunk) => chunks.push(chunk));
    if (stdin) {
      stdin.on('error', (error) => {
        child.kill('SIGTERM');
        fail(error);
      });
      stdin.pipe(child.stdin);
      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') fail(error);
      });
    }
    child.once('error', fail);
    child.once('exit', (code) => {
      activeChild = undefined;
      code === 0
        ? ok(Buffer.concat(chunks).toString('utf8'))
        : fail(new Error(`${command} ${args[0]} failed (${code})`));
    });
  });
}
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
const digest = (value) => createHash('sha256').update(value).digest('hex');
async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
const pool = new pg.Pool({ connectionString: databaseUrl });
let started = false;
const report = {
  status: 'running',
  project,
  startedAt: new Date().toISOString(),
  dumpSha256: await fileDigest(resolve(backup, 'postgres.dump')),
  manifestSha256: await fileDigest(resolve(backup, 'objects/manifest.json')),
};
let signal;
for (const name of ['SIGINT', 'SIGTERM'])
  process.once(name, () => {
    signal = name;
    activeChild?.kill('SIGTERM');
  });
try {
  console.log(`Rehearsal uses only fresh disposable project ${project}`);
  await run('npm', ['run', 'build']);
  if (signal) throw new Error(`Interrupted: ${signal}`);
  started = true;
  await run('docker', [...compose, 'up', '-d', '--wait']);
  // Restore into an empty DB before running any current application or migrations.
  await run(
    'docker',
    [
      ...compose,
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
      '--single-transaction',
      '-U',
      'qa',
      '-d',
      database,
    ],
    { stdin: createReadStream(resolve(backup, 'postgres.dump')) },
  );
  const history = (
    await pool.query('SELECT hash,created_at::text FROM drizzle.__drizzle_migrations ORDER BY id')
  ).rows;
  const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8')).entries;
  assert.ok(history.length <= journal.length, 'Backup contains unknown future migrations');
  for (let i = 0; i < history.length; i++) {
    assert.equal(
      history[i].hash,
      digest(await readFile(`drizzle/${journal[i].tag}.sql`)),
      'Applied migration SQL must match this release',
    );
    assert.equal(
      history[i].created_at,
      String(journal[i].when),
      'Applied migration order must match this release',
    );
  }
  const columns = (
    await pool.query(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position",
    )
  ).rows;
  const tables = new Map();
  for (const row of columns) {
    if (!tables.has(row.table_name)) tables.set(row.table_name, []);
    tables.get(row.table_name).push(row.column_name);
  }
  async function snapshot(table, names, expectedMigration = false) {
    const rows = (
      await pool.query(`SELECT ${names.map(quote).join(',')} FROM public.${quote(table)}`)
    ).rows;
    if (expectedMigration && table === 'setlist_invitations')
      for (const row of rows) row.expires_at = null;
    return {
      rows: rows.length,
      sha256: digest(JSON.stringify(rows.map((row) => JSON.stringify(row)).sort())),
    };
  }
  const before = {};
  for (const [table, names] of tables)
    before[table] = await snapshot(table, names, history.length <= 6);
  report.sourceMigrations = history.length;
  report.invitationExpiryReset =
    tables.has('setlist_invitations') && history.length <= 6
      ? (
          await pool.query(
            'SELECT count(*)::int AS count FROM setlist_invitations WHERE expires_at IS NOT NULL',
          )
        ).rows[0].count
      : 0;
  const libraries = (await pool.query('SELECT id,revision::text FROM libraries ORDER BY id')).rows;
  await run(process.execPath, ['dist/db/migrate.js']);
  report.tables = {};
  for (const [table, names] of tables) {
    const after = await snapshot(table, names);
    assert.deepEqual(after, before[table], `Existing rows/columns changed unexpectedly: ${table}`);
    report.tables[table] = after;
  }
  report.libraries = libraries;
  report.targetMigrations = (
    await pool.query('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations')
  ).rows[0].count;
  assert.equal(report.targetMigrations, journal.length);
  // Running the migrator again must leave rows and history intact.
  await run(process.execPath, ['dist/db/migrate.js']);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations')).rows[0]
      .count,
    journal.length,
  );
  for (const [table, names] of tables)
    assert.deepEqual(await snapshot(table, names), before[table]);
  await run(process.execPath, ['dist/ops/objects.js', 'restore', resolve(backup, 'objects')]);
  const storage = new MinioClient({
    endPoint: '127.0.0.1',
    port: minioPort,
    useSSL: false,
    accessKey: 'qa_minio',
    secretKey: minioPassword,
  });
  for (const entry of manifest) {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of await storage.getObject(env.MINIO_BUCKET, entry.key)) {
      hash.update(chunk);
      size += chunk.length;
    }
    assert.equal(hash.digest('hex'), entry.checksum, 'Restored object checksum');
    assert.equal(size, entry.size, 'Restored object size');
  }
  report.objects = {
    count: manifest.length,
    bytes: manifest.reduce((sum, entry) => sum + entry.size, 0),
    sha256Verified: true,
  };
  report.access = JSON.parse(
    await run(process.execPath, ['dist/ops/rehearse-access.js'], { capture: true }),
  );
  // Owner adoption and API reads must leave original content/revisions untouched.
  for (const table of ['libraries', 'songs', 'attachments'])
    assert.deepEqual(await snapshot(table, tables.get(table)), before[table]);
  if (signal) throw new Error(`Interrupted: ${signal}`);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await pool.end();
  if (started) {
    try {
      await run('docker', [...compose, 'down', '--remove-orphans']);
      report.cleanedUp = true;
    } catch {
      report.cleanedUp = false;
      report.status = 'failed';
      process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`Rehearsal ${report.status}: ${reportFile}`);
  if (report.error) console.error(report.error);
}
