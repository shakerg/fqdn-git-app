import crypto from 'node:crypto';
import { safeEqual } from './crypto.js';

const COOKIE = 'dnspool_sid';
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createAuth({ repo, config }) {
  const attempts = new Map();

  function cookie(value, maxAge) {
    return [
      `${COOKIE}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAge}`,
      config.cookieSecure ? 'Secure' : '',
    ]
      .filter(Boolean)
      .join('; ');
  }

  function login(req, res) {
    const ip = req.ip || 'unknown';
    const a = attempts.get(ip) || { n: 0, until: 0 };
    if (a.until > Date.now()) return res.status(429).json({ error: 'Too many attempts; try again later' });
    if (!safeEqual(req.body?.password ?? '', config.adminPassword)) {
      a.n++;
      if (a.n >= 5) {
        a.until = Date.now() + 5 * 60_000;
        a.n = 0;
      }
      attempts.set(ip, a);
      return res.status(401).json({ error: 'Invalid password' });
    }
    attempts.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    repo.createSession(hash(token), Date.now() + config.sessionTtlSec * 1000);
    res.setHeader('Set-Cookie', cookie(token, config.sessionTtlSec));
    res.json({ ok: true });
  }

  function logout(req, res) {
    const t = parseCookies(req.headers.cookie)[COOKIE];
    if (t) repo.deleteSession(hash(t));
    res.setHeader('Set-Cookie', cookie('', 0));
    res.json({ ok: true });
  }

  function require(req, res, next) {
    const t = parseCookies(req.headers.cookie)[COOKIE];
    if (t && repo.validSession(hash(t))) return next();
    res.status(401).json({ error: 'Authentication required' });
  }

  return { login, logout, require };
}
