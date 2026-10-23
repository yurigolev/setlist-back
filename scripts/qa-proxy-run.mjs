import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const project = `setlist-proxy-qa-${randomBytes(5).toString('hex')}`;
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
const apiPort = await freePort();
let nginxPort;
do {
  nginxPort = await freePort();
} while (nginxPort === apiPort);
const env = {
  ...process.env,
  PROXY_QA_PROJECT: project,
  PROXY_QA_API_PORT: String(apiPort),
  PROXY_QA_NGINX_PORT: String(nginxPort),
};
const compose = [
  'compose',
  '--env-file',
  '/dev/null',
  '-p',
  project,
  '-f',
  'scripts/qa-proxy.compose.yml',
];
let activeCommand;
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    interrupted = true;
    activeCommand?.kill('SIGTERM');
  });
function run(args, capture = false) {
  return new Promise((ok, fail) => {
    const child = spawn('docker', [...compose, ...args], {
      env,
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
    });
    activeCommand = child;
    const chunks = [];
    child.stdout?.on('data', (chunk) => chunks.push(chunk));
    child.once('error', fail);
    child.once('exit', (code) => {
      if (activeCommand === child) activeCommand = undefined;
      code === 0
        ? ok(Buffer.concat(chunks).toString('utf8'))
        : fail(new Error(`Proxy QA Docker command failed (${code})`));
    });
  });
}
async function fromClient(client, path, headers = {}, count = 1) {
  const code = `const results=[]; for(let i=0;i<${count};i++){const r=await fetch(${JSON.stringify('http://caddy:8080' + path)}, {redirect:'manual',headers:${JSON.stringify(headers)}}); results.push({status:r.status,body:r.status===200?await r.json():null});} console.log(JSON.stringify(results));`;
  return JSON.parse(
    await run(['exec', '-T', client, 'node', '--input-type=module', '-e', code], true),
  );
}
let started = false;
try {
  console.log(`Disposable Caddy → Nginx → API proxy QA: ${project}`);
  started = true;
  await run(['up', '-d', '--wait']);
  const a = (await fromClient('client_a', '/qa/client-ip'))[0];
  const b = (await fromClient('client_b', '/qa/client-ip'))[0];
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.notEqual(
    a.body.ip,
    b.body.ip,
    'Separate clients must resolve to separate IPs through both proxies',
  );
  const forged = {
    'x-forwarded-for': '198.51.100.99, 172.18.0.5',
    'x-real-ip': '198.51.100.98',
    forwarded: 'for=198.51.100.97',
    'x-forwarded-host': 'attacker.invalid',
    'x-forwarded-proto': 'https',
  };
  const spoofed = (await fromClient('client_a', '/qa/client-ip', forged))[0];
  assert.deepEqual(spoofed.body, a.body, 'Public edge must discard forged forwarding metadata');
  for (const client of ['client_a', 'client_b']) {
    const responses = await fromClient(client, '/v1/auth/yandex/start', {}, 20);
    assert.ok(
      responses.every((r) => r.status === 302),
      `${client} must have its own 20-request limit`,
    );
    assert.equal(
      (await fromClient(client, '/v1/auth/yandex/start', forged))[0].status,
      429,
      'Forged metadata cannot bypass an exhausted client limit',
    );
  }
  // Bypassing the public edge cannot inject a client IP through Nginx or API.
  for (const port of [apiPort, nginxPort]) {
    const clean = await fetch(`http://127.0.0.1:${port}/qa/client-ip`).then((r) => r.json());
    const spoof = await fetch(`http://127.0.0.1:${port}/qa/client-ip`, { headers: forged }).then(
      (r) => r.json(),
    );
    assert.equal(spoof.ip, clean.ip);
    if (port === apiPort) {
      assert.equal(spoof.host, clean.host);
      assert.equal(spoof.protocol, clean.protocol);
    }
  }
  console.log(
    'Proxy QA passed: two client IPs/independent limits, forged headers rejected at Caddy, direct Nginx/API bypass rejected',
  );
  if (interrupted) throw new Error('Proxy QA interrupted');
} finally {
  if (started) await run(['down', '--remove-orphans']);
}
