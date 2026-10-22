import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';

// This launcher serves the production auth implementation against the explicitly
// configured local stack. It neither migrates data nor creates memberships.
Object.assign(process.env, parse(readFileSync('.env.telegram.runtime.local')));
process.env.DOTENV_CONFIG_PATH = '/dev/null';

let database;
try {
  database = new URL(process.env.DATABASE_URL);
} catch {
  throw new Error('Configure the local DATABASE_URL before starting Telegram');
}
const local = (hostname) => ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
if (!local(database.hostname) || !database.port || database.port === '5432') {
  throw new Error('Local Telegram requires a separate loopback database port');
}
if (
  !local(process.env.MINIO_ENDPOINT) ||
  !process.env.MINIO_PORT ||
  process.env.MINIO_PORT === '9000'
) {
  throw new Error('Local Telegram requires separate loopback object storage');
}

const { buildApp } = await import('../dist/app.js');
const { config } = await import('../dist/config.js');
const { pool } = await import('../dist/db/client.js');
const app = await buildApp();
await app.listen({ host: '127.0.0.1', port: config.port });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => pool.end())
      .finally(() => process.exit(0));
  });
}
