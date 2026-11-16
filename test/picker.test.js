import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCidr, formatIp, containsIp, hostRange } from '../src/cidr.js';
import { ipSections, buildPool, pickIps, poolHash } from '../src/picker.js';

const META = {
  verifiable_password_authentication: false,
  ssh_keys: ['ssh-ed25519 AAAA'],
  web: ['192.30.252.0/22', '140.82.112.3/32', '2a0a:a440::/29'],
  api: ['140.82.112.3/32', '20.201.28.148/32', '2606:50c0::/32'],
  git: ['140.82.112.0/30'],
  domains: { website: ['github.com'] },
};

test('parseCidr normalises IPv4 and IPv6', () => {
  const v4 = parseCidr('192.30.253.7/22');
  assert.equal(v4.cidr, '192.30.252.0/22');
  assert.equal(v4.size, 1024n);
  const v6 = parseCidr('2a0a:a440:0:0::1/29');
  assert.equal(v6.cidr, '2a0a:a440::/29');
  assert.equal(parseCidr('1.2.3.4').prefix, 32);
  assert.throws(() => parseCidr('nope/3'));
  assert.throws(() => parseCidr('1.2.3.4/33'));
});

test('formatIp compresses IPv6', () => {
  assert.equal(formatIp(parseCidr('2606:50c0:0:0:0:0:0:1/128').network, 6), '2606:50c0::1');
  assert.equal(formatIp(parseCidr('::/128').network, 6), '::');
  assert.equal(formatIp(parseCidr('1:0:0:2:0:0:0:3/128').network, 6), '1:0:0:2::3');
});

test('hostRange skips network/broadcast', () => {
  const r = hostRange(parseCidr('10.0.0.0/30'));
  assert.equal(r.count, 2n);
  assert.equal(formatIp(r.first, 4), '10.0.0.1');
  assert.equal(hostRange(parseCidr('10.0.0.5/32')).count, 1n);
});

test('ipSections lists only CIDR arrays', () => {
  const s = ipSections(META);
  assert.deepEqual(s.map((x) => x.name), ['api', 'git', 'web']);
  assert.deepEqual(s.find((x) => x.name === 'web'), { name: 'web', v4: 2, v6: 1 });
});

test('buildPool dedupes and filters by family', () => {
  const pool = buildPool(META, ['web', 'api'], 'v4');
  assert.equal(pool.length, 3);
  assert.ok(pool.every((p) => p.family === 4));
  assert.equal(buildPool(META, ['web', 'api'], 'both').length, 5);
  assert.equal(poolHash(buildPool(META, ['web', 'api'], 'v4')), poolHash(buildPool(META, ['api', 'web'], 'v4')));
});

test('pickIps returns distinct hosts within the pool', () => {
  const pool = buildPool(META, ['web', 'api', 'git'], 'both');
  for (let i = 0; i < 200; i++) {
    const { a, aaaa } = pickIps(pool, 5, 'both');
    assert.equal(a.length, 3);
    assert.equal(aaaa.length, 2);
    assert.equal(new Set(a).size, a.length);
    for (const ip of [...a, ...aaaa]) assert.ok(pool.some((p) => containsIp(p, ip)), `${ip} not in pool`);
    for (const ip of a) assert.ok(!['192.30.252.0', '192.30.255.255', '140.82.112.0'].includes(ip), `${ip} is network/broadcast`);
  }
});

test('pickIps caps at pool capacity', () => {
  const pool = buildPool({ x: ['10.0.0.0/30'] }, ['x'], 'v4');
  const { a } = pickIps(pool, 10, 'v4');
  assert.deepEqual(a, ['10.0.0.1', '10.0.0.2']);
});

test('pickIps with both falls back to v4 when no v6', () => {
  const pool = buildPool({ x: ['10.0.0.0/24'] }, ['x'], 'both');
  const { a, aaaa } = pickIps(pool, 3, 'both');
  assert.equal(a.length, 3);
  assert.equal(aaaa.length, 0);
});
