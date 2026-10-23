import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const env = {
  ...process.env,
  FRONTEND_IMAGE: 'example.invalid/frontend:test',
  BACKEND_IMAGE: 'example.invalid/backend:test',
  APP_DOMAIN: 'release.example.invalid',
  PWA_ORIGIN: 'https://release.example.invalid',
  POSTGRES_USER: 'qa',
  POSTGRES_PASSWORD: 'qa-not-a-real-password',
  POSTGRES_DB: 'qa',
  MINIO_ROOT_USER: 'qa',
  MINIO_ROOT_PASSWORD: 'qa-not-a-real-password',
  YANDEX_CLIENT_ID: 'qa-client',
  YANDEX_CLIENT_SECRET: 'qa-not-a-real-secret',
  YANDEX_REDIRECT_URI: 'https://release.example.invalid/v1/auth/yandex/callback',
  TRUSTED_PROXY_CHAIN: 'frontend,caddy',
};
const args = [
  'compose',
  '--env-file',
  '/dev/null',
  '-f',
  'docker-compose.prod.yml',
  'config',
  '--format',
  'json',
];

test('production Compose passes Yandex configuration, uses secure cookies and retains storage volumes', async () => {
  const { stdout } = await exec('docker', args, { env });
  const compose = JSON.parse(stdout);
  const api = compose.services.api.environment;
  for (const name of ['YANDEX_CLIENT_ID', 'YANDEX_CLIENT_SECRET', 'YANDEX_REDIRECT_URI'] as const)
    assert.equal(api[name], env[name]);
  assert.equal(api.AUTH_ALLOW_INSECURE_LOCAL_HTTP, 'false');
  assert.equal(api.NODE_ENV, 'production');
  assert.equal(api.TELEGRAM_CLIENT_ID, '');
  assert.equal(api.TELEGRAM_CLIENT_SECRET, '');
  assert.equal(api.TELEGRAM_REDIRECT_URI, '');
  assert.equal(api.HTTPS_PROXY, undefined);
  assert.equal(api.TRUSTED_PROXY_CHAIN, 'frontend,caddy');
  assert.equal(compose.services.postgres.volumes[0].source, 'pgdata');
  assert.equal(compose.services.minio.volumes[0].source, 'miniadata');
  const legacy = {
    TELEGRAM_CLIENT_ID: 'old-qa-client',
    TELEGRAM_CLIENT_SECRET: 'old-synthetic-secret',
    TELEGRAM_REDIRECT_URI: 'https://release.example.invalid/v1/auth/telegram/callback',
  };
  const bridged = JSON.parse((await exec('docker', args, { env: { ...env, ...legacy } })).stdout);
  for (const [name, value] of Object.entries(legacy))
    assert.equal(bridged.services.api.environment[name], value);
  assert.equal(bridged.services.api.environment.YANDEX_CLIENT_ID, env.YANDEX_CLIENT_ID);
  for (const name of ['YANDEX_CLIENT_ID', 'YANDEX_CLIENT_SECRET', 'YANDEX_REDIRECT_URI'] as const) {
    await assert.rejects(exec('docker', args, { env: { ...env, [name]: '' } }), (error) => {
      assert.match((error as { stderr: string }).stderr, new RegExp(name));
      return true;
    });
  }
});

test('production rejects missing proxy identities and broad trust specifications', async () => {
  const runtime = {
    ...env,
    NODE_ENV: 'production',
    DOTENV_PATH: '/dev/null',
    DOTENV_QUIET: 'true',
    DATABASE_URL: 'postgres://qa:qa@127.0.0.1:59999/qa',
    MINIO_ENDPOINT: '127.0.0.1',
    MINIO_ACCESS_KEY: 'qa',
    MINIO_SECRET_KEY: 'qa',
  };
  for (const chain of ['', '0.0.0.0/0', '*', 'frontend,,caddy']) {
    await assert.rejects(
      exec(process.execPath, ['--input-type=module', '-e', 'await import("./dist/config.js")'], {
        env: { ...runtime, TRUSTED_PROXY_CHAIN: chain },
      }),
    );
  }
});

test('production runtime rejects missing credentials and a callback on another origin or path before opening a database', async () => {
  const runtime = {
    ...env,
    NODE_ENV: 'production',
    DOTENV_PATH: '/dev/null',
    DOTENV_QUIET: 'true',
    DATABASE_URL: 'postgres://qa:qa@127.0.0.1:59999/qa',
    MINIO_ENDPOINT: '127.0.0.1',
    MINIO_ACCESS_KEY: 'qa',
    MINIO_SECRET_KEY: 'qa-not-a-real-password',
    AUTH_ALLOW_INSECURE_LOCAL_HTTP: 'false',
  };
  const command = ['--input-type=module', '-e', 'await import("./dist/config.js")'];
  await exec(process.execPath, command, { env: runtime });
  for (const override of [
    { YANDEX_CLIENT_SECRET: '' },
    { YANDEX_REDIRECT_URI: 'https://other.example.invalid/v1/auth/yandex/callback' },
    { YANDEX_REDIRECT_URI: 'https://release.example.invalid/wrong-callback' },
  ]) {
    await assert.rejects(
      exec(process.execPath, command, { env: { ...runtime, ...override } }),
      (error) => {
        assert.match(
          (error as { stderr: string }).stderr,
          /Production requires Yandex credentials/,
        );
        return true;
      },
    );
  }
});
