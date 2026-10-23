import Fastify from 'fastify';
import { registerAuthRoutes } from '../dist/auth/routes.js';
import { registerErrors } from '../dist/errors.js';
import { createProxyTrust } from '../dist/proxy.js';

if (
  process.env.NODE_ENV !== 'test' ||
  !/^setlist-proxy-qa-[a-f0-9]+$/.test(process.env.PROXY_QA_PROJECT ?? '')
)
  throw new Error('Proxy fixture requires its explicit disposable QA project');
const proxies = createProxyTrust(['frontend', 'caddy']);
const app = Fastify({ trustProxy: proxies.trustProxy, logger: false });
registerErrors(app);
proxies.register(app);
app.get('/qa/client-ip', (request) => ({
  ip: request.ip,
  host: request.host,
  protocol: request.protocol,
}));
await registerAuthRoutes(app, {
  config: {
    enabled: true,
    clientId: 'proxy-qa',
    clientSecret: 'synthetic-proxy-qa',
    redirectUri: 'https://setlivo.example.invalid/v1/auth/yandex/callback',
    pwaOrigin: 'https://setlivo.example.invalid',
    secureCookies: true,
    sessionTtlSeconds: 900,
  },
  store: { async createLogin() {} },
  provider: { authorizationUrl: () => 'https://yandex.example.invalid/auth' },
});
// Only start/inspection are used. No Yandex, DB, MinIO, credentials or fake-login endpoint.
await app.listen({ host: '0.0.0.0', port: 3000 });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void app.close());
