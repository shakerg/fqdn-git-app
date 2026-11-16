import { spawn } from 'node:child_process';
import { fqdn, assertSafeToken } from './util.js';

const ALGORITHMS = ['hmac-md5', 'hmac-sha1', 'hmac-sha224', 'hmac-sha256', 'hmac-sha384', 'hmac-sha512'];

export function validateBind9Config(c) {
  assertSafeToken('server', c.server, /^[A-Za-z0-9.:\-]+$/);
  const port = Number(c.port ?? 53);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  if (c.tsigKeyName || c.tsigSecret) {
    assertSafeToken('TSIG key name', c.tsigKeyName, /^[A-Za-z0-9._\-]+$/);
    assertSafeToken('TSIG secret', c.tsigSecret, /^[A-Za-z0-9+/=]+$/);
    if (!ALGORITHMS.includes(c.tsigAlgorithm || 'hmac-sha256')) throw new Error('Invalid TSIG algorithm');
  }
  const visibility = c.visibility || 'private';
  if (!['private', 'public'].includes(visibility)) throw new Error('visibility must be private or public');
  return {
    visibility,
    server: c.server,
    port,
    tsigKeyName: c.tsigKeyName || '',
    tsigAlgorithm: c.tsigAlgorithm || 'hmac-sha256',
    tsigSecret: c.tsigSecret || '',
    useTcp: !!c.useTcp,
  };
}

export function runNsupdate(script, { useTcp, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = useTcp ? ['-v'] : [];
    const child = spawn(process.env.NSUPDATE_BIN || 'nsupdate', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`nsupdate exited ${code}: ${out.trim() || 'no output'}`));
    });
    child.stdin.end(script);
  });
}

export function createBind9Provider(target, { run = runNsupdate } = {}) {
  const cfg = validateBind9Config(target.config);
  const zone = target.zone.replace(/\.$/, '');

  function header() {
    const lines = [`server ${cfg.server} ${cfg.port}`, `zone ${zone}.`];
    if (cfg.tsigKeyName) lines.push(`key ${cfg.tsigAlgorithm}:${cfg.tsigKeyName} ${cfg.tsigSecret}`);
    return lines;
  }

  function buildScript(name, { a = [], aaaa = [], ttl }) {
    const f = `${fqdn(name, zone)}.`;
    const lines = header();
    lines.push(`update delete ${f} A`, `update delete ${f} AAAA`);
    for (const ip of a) lines.push(`update add ${f} ${ttl} A ${ip}`);
    for (const ip of aaaa) lines.push(`update add ${f} ${ttl} AAAA ${ip}`);
    lines.push('send', '');
    return lines.join('\n');
  }

  return {
    buildScript,
    async apply(name, sets) {
      await run(buildScript(name, sets), cfg);
    },
    async remove(name) {
      await run(buildScript(name, { a: [], aaaa: [], ttl: 0 }), cfg);
    },
    async test() {
      const f = `_dnspool-test.${zone}.`;
      const script = [...header(), `update add ${f} 60 TXT "dnspool connectivity test"`, 'send', `update delete ${f} TXT`, 'send', ''].join('\n');
      await run(script, cfg);
      return `Dynamic update accepted by ${cfg.server}:${cfg.port} for zone ${zone}`;
    },
  };
}
