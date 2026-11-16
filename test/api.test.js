import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

const META = {
  web: ['192.30.252.0/22', '2a0a:a440::/29'],
  api: ['140.82.112.0/20'],
  actions: ['4.148.0.0/16', '13.64.0.0/11'],
  ssh_keys: ['ssh-ed25519 AAAA'],
};

const config = {
  port: 0,
  dataDir: ':memory:',
  adminPassword: 'correct-horse',
  appSecretKey: 'test-secret-key-123456',
  cookieSecure: false,
  sessionTtlSec: 3600,
  metaUrl: 'http://meta.test/meta',
  metaRefreshSec: 3600,
  githubToken: '',
  schedulerTickSec: 15,
  limits: { maxCount: 16, minTtl: 60, maxTtl: 86400, minInterval: 60, maxInterval: 604800 },
};

const applied = [];
const removed = [];
let server;
let base;
let cookie = '';
let ctx;

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth && cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

before(async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, headers: new Headers({ etag: '"abc"' }), json: async () => META });
  const fake = (target) => ({
    apply: async (name, sets) => applied.push({ target: target.name, name, sets, secret: target.config.tsigSecret }),
    remove: async (name) => removed.push(name),
    test: async () => 'fake ok',
  });
  ctx = createApp({ config, fetchImpl, providerOverrides: { bind9: fake }, logger: {} });
  await ctx.rotator.refreshMeta();
  await new Promise((r) => (server = ctx.app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

test('requires auth', async () => {
  assert.equal((await call('/records', { auth: false })).status, 401);
  assert.equal((await call('/login', { method: 'POST', body: { password: 'wrong' }, auth: false })).status, 401);
  const ok = await call('/login', { method: 'POST', body: { password: 'correct-horse' }, auth: false });
  assert.equal(ok.status, 200);
  const sc = ok.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  cookie = sc.split(';')[0];
});

test('meta sections exposed', async () => {
  const r = await call('/meta');
  assert.deepEqual(r.json.sections.map((s) => s.name), ['actions', 'api', 'web']);
});

let targetId;
test('target secrets are write-only and preserved on update', async () => {
  const r = await call('/targets', {
    method: 'POST',
    body: { type: 'bind9', name: 'lab', zone: 'Internal.Example.', config: { server: '10.0.0.53', tsigKeyName: 'k', tsigSecret: 'c2VjcmV0' } },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.zone, 'internal.example');
  assert.equal(r.json.config.tsigSecret, undefined);
  assert.equal(r.json.config.tsigSecretSet, true);
  targetId = r.json.id;
  const u = await call(`/targets/${targetId}`, { method: 'PUT', body: { name: 'lab2', zone: 'internal.example', config: { server: '10.0.0.54', tsigKeyName: 'k', tsigSecret: '' } } });
  assert.equal(u.status, 200);
  assert.equal(ctx.repo.getTarget(targetId, true).config.tsigSecret, 'c2VjcmV0');
  assert.equal((await call(`/targets/${targetId}/test`, { method: 'POST' })).json.message, 'fake ok');
  assert.equal((await call('/targets', { method: 'POST', body: { type: 'bind9', name: 'x', zone: 'z', config: { server: 'a b' } } })).status, 400);
});

let recordId;
test('create record publishes random IPs from selected sections', async () => {
  const r = await call('/records', {
    method: 'POST',
    body: { name: 'github-web', targetId, sections: ['web', 'api'], families: 'v4', count: 3, ttl: 120, intervalSec: 600 },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.result.ok, true);
  recordId = r.json.record.id;
  const last = applied.at(-1);
  assert.equal(last.name, 'github-web');
  assert.equal(last.sets.a.length, 3);
  assert.equal(last.sets.aaaa.length, 0);
  assert.equal(last.sets.ttl, 120);
  assert.equal(last.secret, 'c2VjcmV0');
  for (const ip of last.sets.a) assert.match(ip, /^(192\.30\.25[2-5]|140\.82\.(11[2-9]|12[0-7]))\./);
  const list = await call('/records');
  assert.equal(list.json[0].state.status, 'ok');
  assert.ok(list.json[0].nextRotationAt > Date.now());
});

test('validation rejects bad input', async () => {
  const bad = { name: 'x', targetId, sections: ['web'], families: 'v4', count: 3, ttl: 120, intervalSec: 600 };
  assert.equal((await call('/records', { method: 'POST', body: { ...bad, sections: ['nope'] } })).status, 400);
  assert.equal((await call('/records', { method: 'POST', body: { ...bad, count: 999 } })).status, 400);
  assert.equal((await call('/records', { method: 'POST', body: { ...bad, ttl: 5 } })).status, 400);
  assert.equal((await call('/records', { method: 'POST', body: { ...bad, name: 'bad name' } })).status, 400);
  assert.equal((await call('/records', { method: 'POST', body: { ...bad, name: 'github-web' } })).status, 409);
});

test('rotate now and preview', async () => {
  const n = applied.length;
  const r = await call(`/records/${recordId}/rotate`, { method: 'POST' });
  assert.equal(r.json.ok, true);
  assert.equal(applied.length, n + 1);
  const p = await call('/preview', { method: 'POST', body: { sections: ['web'], families: 'both', count: 4 } });
  assert.equal(p.json.poolSize, 2);
  assert.equal(p.json.a.length + p.json.aaaa.length, 4);
});

test('pool change forces rotation', async () => {
  const rec = ctx.repo.getRecord(recordId);
  assert.ok(rec.nextRotationAt > Date.now());
  ctx.repo.saveMeta({ ...META, api: ['140.82.112.0/21'] }, '"def"');
  assert.equal(ctx.rotator.markPoolChanges(), 1);
  assert.equal(ctx.repo.dueRecords().length, 1);
  const n = applied.length;
  await ctx.rotator.tick();
  assert.equal(applied.length, n + 1);
  assert.equal(ctx.repo.dueRecords().length, 0);
});

test('export current records as zone file and JSON', async () => {
  const t = (await call('/targets')).json.find((x) => x.id === targetId);
  assert.equal(t.visibility, 'private');
  assert.equal(t.config.visibility, 'private');
  const res = await fetch(`${base}/targets/${targetId}/export`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="?internal\.example-\d{4}-\d\d-\d\d\.zone/);
  const zone = await res.text();
  assert.match(zone, /^\$ORIGIN internal\.example\.$/m);
  assert.match(zone, /private zone/);
  const lines = zone.split('\n').filter((l) => /\sIN\s/.test(l));
  assert.equal(lines.length, 3);
  for (const l of lines) assert.match(l, /^github-web\s+120 IN A\s+\d+\.\d+\.\d+\.\d+$/);
  const j = await call(`/targets/${targetId}/export?format=json`);
  assert.equal(j.json.target.visibility, 'private');
  assert.equal(j.json.records[0].fqdn, 'github-web.internal.example');
  assert.equal(j.json.records[0].a.length, 3);
  assert.equal((await call(`/targets/${targetId}/export?format=csv`)).status, 400);
  assert.equal((await fetch(`${base}/targets/${targetId}/export`)).status, 401);
});

test('target with records cannot be deleted; deleting record removes DNS', async () => {
  assert.equal((await call(`/targets/${targetId}`, { method: 'DELETE' })).status, 409);
  assert.equal((await call(`/records/${recordId}`, { method: 'DELETE' })).status, 204);
  assert.deepEqual(removed, ['github-web']);
  assert.equal((await call(`/targets/${targetId}`, { method: 'DELETE' })).status, 204);
  const logs = await call('/logs');
  assert.ok(logs.json.some((l) => l.result === 'ok'));
});

test('failed push records error and backs off', async () => {
  const t = await call('/targets', { method: 'POST', body: { type: 'cloudflare', name: 'cf', zone: 'example.com', config: { apiToken: 'tok', zoneId: 'c'.repeat(32) } } });
  ctx.repo.createRecord({ name: 'cfrec', targetId: t.json.id, sections: ['web'], families: 'v4', count: 1, ttl: 60, intervalSec: 3600, enabled: true });
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ success: false, errors: [{ code: 1, message: 'denied' }] }) });
  try {
    await ctx.rotator.tick();
  } finally {
    globalThis.fetch = orig;
  }
  const rec = ctx.repo.listRecords().find((r) => r.name === 'cfrec');
  assert.equal(rec.state.status, 'error');
  assert.match(rec.state.error, /denied/);
  assert.equal(rec.failCount, 1);
  assert.ok(rec.nextRotationAt > Date.now() + 20_000);
});
