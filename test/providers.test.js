import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBind9Provider, validateBind9Config } from '../src/providers/bind9.js';
import { createCloudflareProvider } from '../src/providers/cloudflare.js';
import { createAzureProvider } from '../src/providers/azure.js';

test('bind9 builds an nsupdate script with TSIG', async () => {
  let script;
  const p = createBind9Provider(
    { zone: 'internal.example.', config: { server: '10.0.0.53', tsigKeyName: 'k1', tsigSecret: 'c2VjcmV0', tsigAlgorithm: 'hmac-sha256' } },
    { run: async (s) => (script = s) }
  );
  await p.apply('gh', { a: ['1.2.3.4', '5.6.7.8'], aaaa: ['2001:db8::1'], ttl: 120 });
  assert.equal(
    script,
    [
      'server 10.0.0.53 53',
      'zone internal.example.',
      'key hmac-sha256:k1 c2VjcmV0',
      'update delete gh.internal.example. A',
      'update delete gh.internal.example. AAAA',
      'update add gh.internal.example. 120 A 1.2.3.4',
      'update add gh.internal.example. 120 A 5.6.7.8',
      'update add gh.internal.example. 120 AAAA 2001:db8::1',
      'send',
      '',
    ].join('\n')
  );
});

test('bind9 rejects injection in config', () => {
  assert.throws(() => createBind9Provider({ zone: 'z', config: { server: '1.2.3.4\nupdate delete z' } }));
  assert.throws(() => createBind9Provider({ zone: 'z', config: { server: '1.2.3.4', tsigKeyName: 'k', tsigSecret: 'a b' } }));
});

function cfFetch(existing) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ method: opts.method, url, body: opts.body ? JSON.parse(opts.body) : undefined });
    let result = {};
    if (opts.method === 'GET') {
      const type = new URL(url).searchParams.get('type');
      result = existing.filter((r) => r.type === type);
    }
    return { ok: true, status: 200, json: async () => ({ success: true, result }) };
  };
  return { calls, fetchImpl };
}

test('cloudflare reconciles: deletes stale, keeps current, creates new', async () => {
  const { calls, fetchImpl } = cfFetch([
    { id: 'r1', type: 'A', content: '1.1.1.1', ttl: 300 },
    { id: 'r2', type: 'A', content: '2.2.2.2', ttl: 120 },
    { id: 'r3', type: 'AAAA', content: '2001:db8::9', ttl: 300 },
  ]);
  const zoneId = 'a'.repeat(32);
  const p = createCloudflareProvider({ zone: 'example.com', config: { apiToken: 'tok_123', zoneId } }, { fetchImpl });
  await p.apply('gh', { a: ['2.2.2.2', '3.3.3.3'], aaaa: [], ttl: 300 });
  const summary = calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url.split('/dns_records')[1] || ''} ${c.body?.content ?? c.body?.ttl ?? ''}`.trim());
  assert.deepEqual(summary, ['DELETE /r1', 'PATCH /r2 300', 'POST  3.3.3.3', 'DELETE /r3']);
  assert.ok(calls[0].url.includes('name=gh.example.com'));
  assert.equal(calls.find((c) => c.method === 'POST').body.proxied, false);
});

test('cloudflare surfaces API errors', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ success: false, errors: [{ code: 9109, message: 'Invalid access token' }] }) });
  const p = createCloudflareProvider({ zone: 'example.com', config: { apiToken: 'x', zoneId: 'b'.repeat(32) } }, { fetchImpl });
  await assert.rejects(p.test(), /9109: Invalid access token/);
});

test('azure writes A record set and deletes empty AAAA', async () => {
  const calls = [];
  const client = {
    recordSets: {
      createOrUpdate: async (...a) => calls.push(['put', ...a]),
      delete: async (...a) => {
        calls.push(['delete', ...a]);
        const e = new Error('not found');
        e.statusCode = 404;
        throw e;
      },
    },
    privateZones: { get: async () => ({ name: 'priv.example' }) },
  };
  const p = createAzureProvider(
    { zone: 'priv.example', config: { subscriptionId: '00000000-0000-0000-0000-000000000000', resourceGroup: 'rg-dns' } },
    { clientFactory: async () => client }
  );
  await p.apply('gh', { a: ['1.2.3.4'], aaaa: [], ttl: 60 });
  assert.deepEqual(calls[0].slice(0, 5), ['put', 'rg-dns', 'priv.example', 'A', 'gh']);
  assert.deepEqual(calls[0][5].aRecords, [{ ipv4Address: '1.2.3.4' }]);
  assert.equal(calls[0][5].ttl, 60);
  assert.deepEqual(calls[1], ['delete', 'rg-dns', 'priv.example', 'AAAA', 'gh']);
  assert.match(await p.test(), /priv\.example/);
});

test('azure public zones use the public DNS argument order', async () => {
  const calls = [];
  const client = {
    recordSets: { createOrUpdate: async (...a) => calls.push(['put', ...a]), delete: async (...a) => calls.push(['delete', ...a]) },
    zones: { get: async () => ({ name: 'pub.example' }) },
  };
  const p = createAzureProvider(
    { zone: 'pub.example', config: { zoneType: 'public', subscriptionId: '00000000-0000-0000-0000-000000000000', resourceGroup: 'rg' } },
    { clientFactory: async () => client }
  );
  await p.apply('gh', { a: [], aaaa: ['2001:db8::1'], ttl: 60 });
  assert.deepEqual(calls[0], ['delete', 'rg', 'pub.example', 'gh', 'A']);
  assert.deepEqual(calls[1].slice(0, 5), ['put', 'rg', 'pub.example', 'gh', 'AAAA']);
  assert.match(await p.test(), /public DNS zone pub\.example/);
  assert.throws(() => createAzureProvider({ zone: 'z', config: { zoneType: 'other', subscriptionId: '00000000-0000-0000-0000-000000000000', resourceGroup: 'rg' } }), /zoneType/);
});

test('bind9 defaults to a private zone', () => {
  assert.equal(validateBind9Config({ server: 'ns1' }).visibility, 'private');
  assert.equal(validateBind9Config({ server: 'ns1', visibility: 'public' }).visibility, 'public');
  assert.throws(() => validateBind9Config({ server: 'ns1', visibility: 'x' }), /visibility/);
});
