import net from 'node:net';
import crypto from 'node:crypto';

function parseV4(s) {
  return s.split('.').reduce((acc, o) => (acc << 8n) | BigInt(Number(o)), 0n);
}

function parseV6(s) {
  let str = s;
  const v4tail = str.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4tail) {
    const n = parseV4(v4tail[1]);
    str = str.slice(0, -v4tail[1].length) + ((n >> 16n) & 0xffffn).toString(16) + ':' + (n & 0xffffn).toString(16);
  }
  const [head, tail] = str.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const groups = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (groups.length !== 8) throw new Error(`Invalid IPv6 address: ${s}`);
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

export function formatIp(n, family) {
  if (family === 4) {
    return [24n, 16n, 8n, 0n].map((sh) => ((n >> sh) & 0xffn).toString()).join('.');
  }
  const groups = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((n >> BigInt(i * 16)) & 0xffffn));
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hex.join(':');
  return hex.slice(0, bestStart).join(':') + '::' + hex.slice(bestStart + bestLen).join(':');
}

export function parseCidr(cidr) {
  const [addr, lenStr] = String(cidr).trim().split('/');
  const family = net.isIP(addr);
  if (!family) throw new Error(`Invalid CIDR: ${cidr}`);
  const bits = family === 4 ? 32 : 128;
  const prefix = lenStr === undefined ? bits : Number(lenStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) throw new Error(`Invalid prefix: ${cidr}`);
  const ip = family === 4 ? parseV4(addr) : parseV6(addr);
  const hostBits = BigInt(bits - prefix);
  const mask = ((1n << BigInt(bits)) - 1n) ^ ((1n << hostBits) - 1n);
  const network = ip & mask;
  return { cidr: `${formatIp(network, family)}/${prefix}`, family, prefix, bits, network, size: 1n << hostBits };
}

export function isCidr(s) {
  if (typeof s !== 'string') return false;
  try {
    parseCidr(s);
    return true;
  } catch {
    return false;
  }
}

export function containsIp(parsed, ip) {
  const family = net.isIP(ip);
  if (family !== parsed.family) return false;
  const n = family === 4 ? parseV4(ip) : parseV6(ip);
  return n >= parsed.network && n < parsed.network + parsed.size;
}

/** Usable host range: skip network/broadcast for IPv4 (prefix <= 30) and subnet-router anycast for IPv6 (prefix <= 126). */
export function hostRange(p) {
  if (p.family === 4 && p.prefix <= 30) return { first: p.network + 1n, count: p.size - 2n };
  if (p.family === 6 && p.prefix <= 126) return { first: p.network + 1n, count: p.size - 1n };
  return { first: p.network, count: p.size };
}

export function randomBigInt(maxExclusive, rand = crypto.randomBytes) {
  if (maxExclusive <= 0n) throw new Error('range must be positive');
  if (maxExclusive <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return BigInt(crypto.randomInt(0, Number(maxExclusive)));
  }
  const bytes = Math.ceil(maxExclusive.toString(2).length / 8) + 8;
  const n = BigInt('0x' + rand(bytes).toString('hex'));
  return n % maxExclusive;
}
