import { fqdn, assertSafeToken } from './util.js';

const API = 'https://api.cloudflare.com/client/v4';

export function validateCloudflareConfig(c) {
  assertSafeToken('API token', c.apiToken, /^[A-Za-z0-9_\-]+$/);
  assertSafeToken('zone ID', c.zoneId, /^[a-f0-9]{32}$/i);
  return { apiToken: c.apiToken, zoneId: c.zoneId };
}

export function createCloudflareProvider(target, { fetchImpl = globalThis.fetch, apiBase = API } = {}) {
  const cfg = validateCloudflareConfig(target.config);
  const zone = target.zone.replace(/\.$/, '');

  async function call(method, path, body) {
    const res = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.apiToken}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      const msg = json.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`;
      throw new Error(`Cloudflare ${method} ${path} failed: ${msg}`);
    }
    return json.result;
  }

  async function reconcile(name, type, ips, ttl) {
    const host = fqdn(name, zone);
    const existing = await call('GET', `/zones/${cfg.zoneId}/dns_records?type=${type}&name=${encodeURIComponent(host)}&per_page=100`);
    const want = new Set(ips);
    for (const rec of existing) {
      if (!want.has(rec.content)) await call('DELETE', `/zones/${cfg.zoneId}/dns_records/${rec.id}`);
      else {
        want.delete(rec.content);
        if (rec.ttl !== ttl) await call('PATCH', `/zones/${cfg.zoneId}/dns_records/${rec.id}`, { ttl });
      }
    }
    for (const ip of want) {
      await call('POST', `/zones/${cfg.zoneId}/dns_records`, {
        type,
        name: host,
        content: ip,
        ttl,
        proxied: false,
        comment: 'managed by github-meta-dns-pool',
      });
    }
  }

  return {
    async apply(name, { a = [], aaaa = [], ttl }) {
      await reconcile(name, 'A', a, ttl);
      await reconcile(name, 'AAAA', aaaa, ttl);
    },
    async remove(name) {
      await reconcile(name, 'A', [], 60);
      await reconcile(name, 'AAAA', [], 60);
    },
    async test() {
      const z = await call('GET', `/zones/${cfg.zoneId}`);
      return `Connected to Cloudflare zone ${z?.name ?? cfg.zoneId}`;
    },
  };
}
