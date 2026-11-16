import crypto from 'node:crypto';
import { parseCidr, isCidr, hostRange, randomBigInt, formatIp } from './cidr.js';

/** Meta keys whose values are arrays of CIDR strings (e.g. web, api, git, actions). */
export function ipSections(meta) {
  if (!meta || typeof meta !== 'object') return [];
  return Object.entries(meta)
    .filter(([, v]) => Array.isArray(v) && v.length > 0 && v.every(isCidr))
    .map(([name, v]) => ({
      name,
      v4: v.filter((c) => !c.includes(':')).length,
      v6: v.filter((c) => c.includes(':')).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Deduplicated, sorted CIDR pool for the chosen sections/families. */
export function buildPool(meta, sections, families) {
  const wantV4 = families === 'v4' || families === 'both';
  const wantV6 = families === 'v6' || families === 'both';
  const seen = new Map();
  for (const s of sections) {
    const list = meta?.[s];
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      if (!isCidr(c)) continue;
      const p = parseCidr(c);
      if ((p.family === 4 && !wantV4) || (p.family === 6 && !wantV6)) continue;
      if (!seen.has(p.cidr)) seen.set(p.cidr, p);
    }
  }
  return [...seen.values()].sort((a, b) => (a.cidr < b.cidr ? -1 : a.cidr > b.cidr ? 1 : 0));
}

export function poolHash(pool) {
  return crypto.createHash('sha256').update(pool.map((p) => p.cidr).join(',')).digest('hex').slice(0, 16);
}

/**
 * Pick `count` distinct random host IPs from the pool.
 * Each CIDR is weighted by (host bits + 1) so large ranges (e.g. /12 in actions)
 * are favoured but don't completely drown out single-host entries.
 * When families is 'both' the count is split between v4 and v6 (v4 gets the odd one).
 */
export function pickIps(pool, count, families = 'both') {
  const byFamily = { 4: pool.filter((p) => p.family === 4), 6: pool.filter((p) => p.family === 6) };
  let quotas;
  if (families === 'v4') quotas = { 4: count, 6: 0 };
  else if (families === 'v6') quotas = { 4: 0, 6: count };
  else {
    const v4 = byFamily[4].length ? Math.ceil(count / 2) : 0;
    quotas = { 4: v4, 6: byFamily[6].length ? count - v4 : 0 };
    if (!byFamily[6].length) quotas[4] = count;
  }
  const out = { a: [], aaaa: [] };
  for (const fam of [4, 6]) {
    const list = byFamily[fam];
    const want = quotas[fam];
    if (!want || !list.length) continue;
    const weights = list.map((p) => BigInt(p.bits - p.prefix + 1));
    const total = weights.reduce((a, b) => a + b, 0n);
    const chosen = new Set();
    const capacity = list.reduce((acc, p) => acc + hostRange(p).count, 0n);
    const target = BigInt(want) > capacity ? Number(capacity) : want;
    let attempts = 0;
    while (chosen.size < target && attempts < want * 50) {
      attempts++;
      let r = randomBigInt(total);
      let idx = 0;
      while (r >= weights[idx]) {
        r -= weights[idx];
        idx++;
      }
      const { first, count: n } = hostRange(list[idx]);
      chosen.add(formatIp(first + randomBigInt(n), fam));
    }
    (fam === 4 ? out.a : out.aaaa).push(...[...chosen].sort());
  }
  return out;
}
