import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const [action = 'up', destination] = process.argv.slice(2);
const compose = [
  'compose',
  '--env-file',
  '.env.telegram.compose.local',
  '-f',
  'docker-compose.telegram.yml',
];
function run(args, options = {}) {
  const result = spawnSync('docker', args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker command failed (exit ${result.status})`);
  return result;
}
if (action === 'up') {
  const env = parse(readFileSync('.env.telegram.runtime.local'));
  const database = new URL(env.DATABASE_URL);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname) ||
    database.port !== '46641' ||
    env.MINIO_ENDPOINT !== '127.0.0.1' ||
    env.MINIO_PORT !== '46642' ||
    env.PORT !== '46543' ||
    env.PWA_ORIGIN !== 'http://127.0.0.1:46544' ||
    env.TELEGRAM_REDIRECT_URI !== 'http://127.0.0.1:46544/v1/auth/telegram/callback'
  ) {
    throw new Error(
      'Local stack requires API 46543, PWA/callback 127.0.0.1:46544, PostgreSQL 46641, MinIO 46642',
    );
  }
  Object.assign(env, {
    POSTGRES_USER: decodeURIComponent(database.username),
    POSTGRES_PASSWORD: decodeURIComponent(database.password),
    POSTGRES_DB: database.pathname.slice(1),
  });
  database.hostname = 'postgres';
  database.port = '5432';
  env.COMPOSE_DATABASE_URL = database.toString();
  writeFileSync(
    '.env.telegram.compose.local',
    Object.entries(env)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  chmodSync('.env.telegram.compose.local', 0o600);
  for (const volume of ['setlist-telegram-pgdata', 'setlist-telegram-miniadata'])
    run(['volume', 'create', volume]);
  run([...compose, 'up', '-d', '--build', '--wait', '--wait-timeout', '180']);
  console.log('Open http://127.0.0.1:46544 (Telegram callback origin).');
} else if (action === 'stop') {
  run([...compose, 'stop']);
} else if (action === 'backup') {
  if (!destination) throw new Error('Usage: npm run local:backup -- /absolute/path/to/new-backup');
  const output = resolve(destination);
  if (existsSync(output)) throw new Error('Backup destination must be a new directory');
  // Keep DB and object snapshot consistent by pausing the only writer.
  run([...compose, 'stop', 'api']);
  try {
    mkdirSync(output, { mode: 0o700, recursive: true });
    const dump = run(
      [
        ...compose,
        'exec',
        '-T',
        'postgres',
        'sh',
        '-c',
        'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
      ],
      { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 256 * 1024 * 1024 },
    );
    writeFileSync(resolve(output, 'postgres.dump'), dump.stdout, { mode: 0o600 });
    run([
      ...compose,
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '-v',
      `${output}:/backup`,
      'api',
      'node',
      'dist/ops/objects.js',
      'backup',
      '/backup/objects',
    ]);
    writeFileSync(resolve(output, 'COMPLETE'), new Date().toISOString() + '\n', { mode: 0o600 });
    console.log(`Backup saved: ${output}`);
  } finally {
    run([...compose, 'start', 'api']);
  }
} else {
  throw new Error('Usage: local-telegram-stack.mjs up|stop|backup [new-backup-directory]');
}
