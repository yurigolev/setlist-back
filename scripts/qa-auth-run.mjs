import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

const serve = process.argv.slice(2).includes('--serve');
if (process.argv.slice(2).some((argument) => argument !== '--serve'))
  throw new Error('Only --serve is supported');
const suffix = randomBytes(5).toString('hex');
const project = `setlist-auth-qa-${suffix}`;
const database = `setlist_auth_qa_${suffix}`;
const migrationDatabase = `setlist_auth_qa_migration_${suffix}`;
const ports = await findPorts();
const password = randomBytes(24).toString('hex');
const minioPassword = randomBytes(24).toString('hex');
const databaseUrl = `postgres://qa:${password}@127.0.0.1:${ports.pg}/${database}`;
const origin = `http://127.0.0.1:${ports.pwa}`;
const api = `http://127.0.0.1:${ports.api}`;
const env = {
  ...process.env,
  DOTENV_CONFIG_PATH: '/dev/null',
  NODE_ENV: 'test',
  AUTH_QA_PROJECT_NAME: project,
  AUTH_QA_DATABASE_NAME: database,
  AUTH_QA_POSTGRES_USER: 'qa',
  AUTH_QA_POSTGRES_PASSWORD: password,
  AUTH_QA_BROWSER_LOGIN: serve ? 'true' : 'false',
  AUTH_QA_PG_PORT: String(ports.pg),
  AUTH_QA_MINIO_PORT: String(ports.minio),
  AUTH_QA_API_PORT: String(ports.api),
  AUTH_QA_PWA_ORIGIN: origin,
  AUTH_QA_MINIO_USER: 'qa_minio',
  AUTH_QA_MINIO_PASSWORD: minioPassword,
  AUTH_QA_BUCKET: `setlist-qa-migration-${suffix}`,
  AUTH_QA_DATABASE_URL: `postgres://qa:${password}@127.0.0.1:${ports.pg}/${migrationDatabase}`,
  DATABASE_URL: databaseUrl,
  PWA_ORIGIN: origin,
  PORT: String(ports.api),
  MINIO_ENDPOINT: '127.0.0.1',
  MINIO_PORT: String(ports.minio),
  MINIO_USE_SSL: 'false',
  MINIO_ACCESS_KEY: 'qa_minio',
  MINIO_SECRET_KEY: minioPassword,
  MINIO_BUCKET: `setlist-qa-${suffix}`,
  TELEGRAM_CLIENT_ID: 'qa-client',
  TELEGRAM_CLIENT_SECRET: randomBytes(24).toString('hex'),
  TELEGRAM_REDIRECT_URI: `${serve ? origin : api}/v1/auth/telegram/callback`,
  AUTH_ALLOW_INSECURE_LOCAL_HTTP: 'true',
  AUTH_SESSION_TTL_SECONDS: '3600',
  LEGACY_OWNER_TELEGRAM_ISSUER: 'https://oauth.telegram.org',
  LEGACY_OWNER_TELEGRAM_SUB: 'qa-owner-subject',
  TEST_API_URL: api,
  TEST_ORIGIN: origin,
};
const compose = [
  'compose',
  '--env-file',
  '/dev/null',
  '--project-name',
  project,
  '--file',
  'scripts/qa-auth.compose.yml',
];
let apiProcess;
let activeCommand;
let cleanupPromise;
let composeStarted = false;
async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit' });
    activeCommand = child;
    child.once('error', reject);
    child.once('exit', (code) => {
      if (activeCommand === child) activeCommand = undefined;
      code === 0 ? resolve() : reject(new Error(`${command} ${args[0]} exited ${code}`));
    });
  });
}
async function checkPort(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}
async function findPorts() {
  const configuredBase = process.env.AUTH_QA_PORT_BASE;
  if (configuredBase !== undefined) {
    const base = Number(configuredBase);
    if (!Number.isInteger(base) || base < 1024 || base > 65532)
      throw new Error('AUTH_QA_PORT_BASE must be an integer from 1024 through 65532');
    try {
      for (const port of [base, base + 1, base + 2, base + 3]) await checkPort(port);
    } catch {
      throw new Error(
        'The configured AUTH_QA_PORT_BASE group contains a busy port; no existing service was changed',
      );
    }
    return { pg: base, minio: base + 1, api: base + 2, pwa: base + 3 };
  }
  // Pick one contiguous group only after confirming that every port is unused.
  // This keeps the disposable stack away from both shared local services and
  // other QA runs, including runs started concurrently.
  const first = 46500;
  const last = 60000;
  const candidates = [];
  for (let base = first; base <= last - 3; base += 4) candidates.push(base);
  for (let index = candidates.length - 1; index > 0; index--) {
    const swap = randomBytes(4).readUInt32BE() % (index + 1);
    [candidates[index], candidates[swap]] = [candidates[swap], candidates[index]];
  }
  for (const base of candidates) {
    try {
      for (const port of [base, base + 1, base + 2, base + 3]) await checkPort(port);
      return { pg: base, minio: base + 1, api: base + 2, pwa: base + 3 };
    } catch {
      // Try another complete group. No service is stopped or modified.
    }
  }
  throw new Error(`No free four-port group found between ${first} and ${last}`);
}
function cleanup() {
  return (cleanupPromise ??= performCleanup());
}
async function performCleanup() {
  if (apiProcess && apiProcess.exitCode === null) {
    const closed = new Promise((resolve) => apiProcess.once('exit', resolve));
    apiProcess.kill('SIGTERM');
    await Promise.race([closed, delay(5000)]);
    if (apiProcess.exitCode === null) {
      apiProcess.kill('SIGKILL');
      await closed;
    }
  }
  if (composeStarted) await run('docker', [...compose, 'down', '--remove-orphans']);
}
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.once(signal, () => {
    activeCommand?.kill('SIGTERM');
    void cleanup()
      .catch((error) => console.error(`QA cleanup failed for ${project}: ${error.message}`))
      .finally(() => process.exit(code));
  });
}
try {
  for (const port of Object.values(ports)) await checkPort(port);
  console.log(
    `Disposable QA project ${project}; ports PG ${ports.pg}, MinIO ${ports.minio}, API ${ports.api}, PWA origin ${ports.pwa}`,
  );
  await run('npm', ['run', 'typecheck']);
  await run('npm', ['run', 'build']);
  await run('npm', ['run', 'db:check']);
  composeStarted = true;
  await run('docker', [...compose, 'up', '-d', '--wait']);
  const admin = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${migrationDatabase}`);
  } finally {
    await admin.end();
  }
  await run('node', ['dist/db/migrate.js']);
  apiProcess = spawn(process.execPath, ['--import', 'tsx', 'scripts/qa-auth-server.ts'], {
    env,
    stdio: 'inherit',
  });
  apiProcess.once('error', (error) => console.error(error.message));
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (apiProcess.exitCode !== null) throw new Error('QA API exited before readiness');
    try {
      ready = (await fetch(`${api}/health`)).ok;
    } catch {
      // The API may not yet be listening during startup.
    }
    if (ready) break;
    await delay(200);
  }
  if (!ready) throw new Error('QA API readiness timed out');
  const start = await fetch(`${api}/v1/auth/telegram/start?returnTo=/`, { redirect: 'manual' });
  const authorization = new URL(start.headers.get('location') ?? '');
  const loginCookie = start.headers
    .getSetCookie()
    .find((value) => value.startsWith('setlist_login='))
    ?.split(';')[0];
  if (start.status !== 302 || !loginCookie || !authorization.searchParams.get('state'))
    throw new Error('QA login start failed');
  const callback = await fetch(
    `${api}/v1/auth/telegram/callback?code=qa-owner&state=${encodeURIComponent(authorization.searchParams.get('state'))}`,
    { redirect: 'manual', headers: { cookie: loginCookie } },
  );
  const sessionCookie = callback.headers
    .getSetCookie()
    .find((value) => value.startsWith('setlist_session='))
    ?.split(';')[0];
  if (
    callback.status !== 302 ||
    !sessionCookie ||
    callback.headers.get('location') !== `${origin}/`
  )
    throw new Error('Signed QA owner login failed');
  const sessionResponse = await fetch(`${api}/v1/auth/session`, {
    headers: { cookie: sessionCookie },
  });
  const session = await sessionResponse.json();
  if (!sessionResponse.ok || typeof session.csrfToken !== 'string')
    throw new Error('QA session bootstrap failed');
  env.TEST_SESSION_COOKIE = sessionCookie;
  env.TEST_CSRF_TOKEN = session.csrfToken;
  // Legacy access is adopted only after the QA owner has completed the real
  // mock-issuer callback, which creates the verified auth_users identity.
  await run('npm', ['run', 'db:bootstrap-legacy']);
  await run('npm', ['test']);
  await run(process.execPath, ['scripts/qa-setlists-run.mjs']);
  if (serve) {
    console.log(
      `QA API stays at ${api}; start the frontend preview at ${origin} with /v1 proxy to ${api}. Press Ctrl-C to remove this QA project.`,
    );
    await new Promise(() => {});
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch (error) {
    console.error(`QA cleanup failed for ${project}: ${error.message}`);
    process.exitCode = 1;
  }
}
