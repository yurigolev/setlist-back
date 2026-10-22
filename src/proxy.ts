import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { ApiError } from './errors.js';

type Address = { address: string; family: number };
type Options = {
  resolve?: (hostname: string) => Promise<Address[]>;
  now?: () => number;
};

/** Ordered proxy identities, nearest API first. Never trust a whole Docker subnet. */
export function createProxyTrust(hostnames: string[], options: Options = {}) {
  const resolve = options.resolve ?? ((hostname) => lookup(hostname, { all: true }));
  const now = options.now ?? Date.now;
  let proxies: BlockList[] = [];
  let validUntil = 0;
  let available = hostnames.length === 0;
  let pending: Promise<void> | undefined;
  const unavailable = () =>
    new ApiError(503, 'PROXY_UNAVAILABLE', 'Trusted proxy resolution unavailable');

  async function refresh(): Promise<void> {
    if (!hostnames.length) return;
    if (now() < validUntil) {
      if (!available) throw unavailable();
      return;
    }
    if (!pending)
      pending = (async () => {
        try {
          const next = await Promise.all(
            hostnames.map(async (hostname) => {
              const addresses = await resolve(hostname);
              if (!addresses.length) throw unavailable();
              const allowed = new BlockList();
              for (const { address, family } of addresses) {
                if (family !== 4 && family !== 6) throw unavailable();
                allowed.addAddress(address, family === 4 ? 'ipv4' : 'ipv6');
              }
              return allowed;
            }),
          );
          proxies = next;
          available = true;
        } catch {
          proxies = [];
          available = false;
          throw unavailable();
        } finally {
          validUntil = now() + 5000;
        }
      })();
    const task = pending;
    try {
      await task;
    } finally {
      if (pending === task) pending = undefined;
    }
  }

  function trustProxy(address: string, hop: number): boolean {
    const family = isIP(address);
    return Boolean(
      available &&
      proxies[hop] &&
      family &&
      proxies[hop].check(address, family === 4 ? 'ipv4' : 'ipv6'),
    );
  }

  function register(app: FastifyInstance): void {
    app.addHook('onRequest', async (request) => {
      // Direct healthchecks/startup need no proxy DNS. Proxied requests fail closed
      // on resolution errors rather than trusting stale/reassigned container IPs.
      if (request.headers['x-forwarded-for'] !== undefined) await refresh();
    });
  }
  return { trustProxy, register, refresh };
}
