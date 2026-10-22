import type { Client } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';

/** Legacy mutation tests must never inherit the normal application environment. */
function prerequisite(message: string): never {
  throw new Error(
    `Disposable test environment required: ${message}. Start the isolated auth QA project; do not target an existing library.`,
  );
}
function port(name: string) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1024 || value > 65535)
    prerequisite(`${name} must be an explicit nonprivileged port`);
  return value;
}
export function verifyDisposableDatabase() {
  const project = process.env.AUTH_QA_PROJECT_NAME;
  const databaseName = process.env.AUTH_QA_DATABASE_NAME;
  if (!project || !/^setlist-auth-qa-[a-z0-9-]+$/.test(project))
    prerequisite('AUTH_QA_PROJECT_NAME must begin setlist-auth-qa-');
  if (!databaseName || !/^setlist_auth_qa_[a-z0-9_]+$/.test(databaseName))
    prerequisite('AUTH_QA_DATABASE_NAME must begin setlist_auth_qa_');
  const pgPort = port('AUTH_QA_PG_PORT');
  if (pgPort === 5432) prerequisite('AUTH_QA_PG_PORT must differ from the standard database port');
  let database: URL;
  try {
    database = new URL(process.env.DATABASE_URL ?? '');
  } catch {
    prerequisite('DATABASE_URL must explicitly target the disposable QA database');
  }
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(database!.hostname) ||
    Number(database!.port) !== pgPort ||
    database!.pathname !== `/${databaseName}`
  )
    prerequisite('DATABASE_URL must match the loopback QA port and database name');
}
export function verifyDisposableApi() {
  verifyDisposableDatabase();
  const apiPort = port('AUTH_QA_API_PORT');
  if ([3000, 3300].includes(apiPort))
    prerequisite('AUTH_QA_API_PORT must differ from existing application ports');
  let api: URL;
  try {
    api = new URL(process.env.TEST_API_URL ?? '');
  } catch {
    prerequisite('TEST_API_URL must explicitly target the disposable QA API');
  }
  if (
    api!.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(api!.hostname) ||
    Number(api!.port) !== apiPort ||
    api!.pathname !== '/' ||
    api!.search ||
    api!.hash ||
    api!.username ||
    api!.password
  )
    prerequisite('TEST_API_URL must match the loopback QA API port');
  const minioPort = port('AUTH_QA_MINIO_PORT');
  if (
    minioPort === 9000 ||
    Number(process.env.MINIO_PORT) !== minioPort ||
    !['127.0.0.1', 'localhost', '::1'].includes(process.env.MINIO_ENDPOINT ?? '')
  )
    prerequisite('MINIO_ENDPOINT and MINIO_PORT must explicitly target isolated QA storage');
  return api!.origin;
}
export function ownerTestHeaders() {
  const cookie = process.env.TEST_SESSION_COOKIE,
    csrfToken = process.env.TEST_CSRF_TOKEN,
    origin = process.env.TEST_ORIGIN;
  if (
    !cookie ||
    !/^setlist_session=[A-Za-z0-9_-]{43}$/.test(cookie) ||
    !csrfToken ||
    !/^[A-Za-z0-9_-]{43}$/.test(csrfToken) ||
    !origin ||
    origin !== process.env.PWA_ORIGIN
  )
    prerequisite(
      'TEST_SESSION_COOKIE, TEST_CSRF_TOKEN and TEST_ORIGIN must come from a valid owner QA login',
    );
  return { cookie, 'x-csrf-token': csrfToken, origin };
}

/** pg-pool.end() may resolve before PostgreSQL has processed socket shutdown. */
export async function dropVerificationDatabase(admin: Client, name: string): Promise<void> {
  if (!/^setlist_verify_[a-f0-9]{32}$/.test(name))
    throw new Error('Only this test-created verification database may be dropped');
  const deadline = Date.now() + 5000;
  while (true) {
    const { rows } = await admin.query(
      'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1',
      [name],
    );
    if (rows[0].count === 0) break;
    if (Date.now() >= deadline)
      throw new Error('Verification database connections did not close before cleanup');
    await delay(10);
  }
  // Never terminate clients: FORCE can turn graceful pool shutdown into an unhandled error.
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
}
