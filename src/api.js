import express from 'express';
import { ipSections } from './picker.js';
import { VALIDATORS, SECRET_FIELDS, redactConfig, targetVisibility } from './providers/index.js';
import { toZoneFile, toExportJson } from './export.js';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const LABEL = '[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?';
const NAME_RE = new RegExp(`^(?:@|${LABEL}(?:\\.${LABEL})*)$`);
const ZONE_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*\\.?$`);

const intIn = (v, min, max, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${label} must be an integer between ${min} and ${max}`);
  return n;
};
const id = (req) => intIn(req.params.id, 1, Number.MAX_SAFE_INTEGER, 'id');

export function createApiRouter({ repo, rotator, providerFactory, auth, config }) {
  const r = express.Router();
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  r.post('/login', auth.login);
  r.post('/logout', auth.logout);
  r.get('/session', auth.require, (req, res) => res.json({ ok: true, limits: config.limits }));
  r.use(auth.require);

  // ----- meta
  r.get('/meta', (req, res) => {
    const m = repo.latestMeta();
    res.json({ fetchedAt: m?.fetchedAt ?? null, sections: m ? ipSections(m.json) : [] });
  });
  r.post(
    '/meta/refresh',
    wrap(async (req, res) => {
      const out = await rotator.refreshMeta();
      res.json({ changed: out.changed, sections: ipSections(out.meta) });
    })
  );

  // ----- targets
  function parseTarget(body, existing) {
    const type = existing?.type ?? body.type;
    if (!VALIDATORS[type]) throw new HttpError(400, 'type must be bind9, cloudflare or azure');
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 64) throw new HttpError(400, 'name is required (max 64 chars)');
    const zone = String(body.zone ?? '').trim().toLowerCase().replace(/\.$/, '');
    if (!ZONE_RE.test(zone)) throw new HttpError(400, 'zone must be a valid DNS zone name');
    const incoming = { ...(body.config || {}) };
    for (const k of SECRET_FIELDS[type]) {
      if ((incoming[k] === undefined || incoming[k] === '') && existing?.config?.[k]) incoming[k] = existing.config[k];
    }
    let cfg;
    try {
      cfg = VALIDATORS[type](incoming);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    return { type, name, zone, config: cfg };
  }
  const publicTarget = (t) =>
    t && { ...t, visibility: targetVisibility(t.type, t.config), config: t.config ? redactConfig(t.type, t.config) : undefined };

  r.get('/targets', (req, res) => {
    res.json(repo.listTargets().map((t) => publicTarget(repo.getTarget(t.id, true))));
  });
  r.post('/targets', (req, res) => {
    const t = repo.createTarget(parseTarget(req.body));
    res.status(201).json(publicTarget(repo.getTarget(t.id, true)));
  });
  r.put('/targets/:id', (req, res) => {
    const existing = repo.getTarget(id(req), true);
    if (!existing) throw new HttpError(404, 'Target not found');
    repo.updateTarget(existing.id, parseTarget(req.body, existing));
    res.json(publicTarget(repo.getTarget(existing.id, true)));
  });
  r.delete('/targets/:id', (req, res) => {
    const tid = id(req);
    if (repo.countRecordsForTarget(tid) > 0) throw new HttpError(409, 'Delete the records using this target first');
    if (!repo.deleteTarget(tid)) throw new HttpError(404, 'Target not found');
    res.status(204).end();
  });
  r.post(
    '/targets/:id/test',
    wrap(async (req, res) => {
      const t = repo.getTarget(id(req), true);
      if (!t) throw new HttpError(404, 'Target not found');
      try {
        res.json({ ok: true, message: await providerFactory(t).test() });
      } catch (e) {
        res.json({ ok: false, message: e.message });
      }
    })
  );
  r.get('/targets/:id/export', (req, res) => {
    const t = repo.getTarget(id(req), true);
    if (!t) throw new HttpError(404, 'Target not found');
    const format = req.query.format || 'zone';
    if (!['zone', 'json'].includes(format)) throw new HttpError(400, 'format must be zone or json');
    const records = repo.listRecords().filter((rec) => rec.targetId === t.id);
    const opts = { visibility: targetVisibility(t.type, t.config) };
    const base = `${t.zone}-${new Date().toISOString().slice(0, 10)}`;
    res.set('Cache-Control', 'no-store');
    if (format === 'json') {
      res.attachment(`${base}.json`).json(toExportJson(t, records, opts));
    } else {
      res.attachment(`${base}.zone`).type('text/plain').send(toZoneFile(t, records, opts));
    }
  });

  // ----- records
  function parseRecord(body) {
    const L = config.limits;
    const name = String(body.name ?? '').trim().toLowerCase();
    if (!NAME_RE.test(name)) throw new HttpError(400, 'name must be a relative DNS name (e.g. "github-web") or "@"');
    const targetId = intIn(body.targetId, 1, Number.MAX_SAFE_INTEGER, 'targetId');
    if (!repo.getTarget(targetId)) throw new HttpError(400, 'Unknown target');
    const sections = Array.isArray(body.sections) ? [...new Set(body.sections.map(String))] : [];
    const meta = repo.latestMeta();
    const known = new Set(meta ? ipSections(meta.json).map((s) => s.name) : []);
    if (!sections.length) throw new HttpError(400, 'Select at least one section');
    const unknown = sections.filter((s) => !known.has(s));
    if (unknown.length) throw new HttpError(400, `Unknown sections: ${unknown.join(', ')}`);
    const families = body.families;
    if (!['v4', 'v6', 'both'].includes(families)) throw new HttpError(400, 'families must be v4, v6 or both');
    return {
      name,
      targetId,
      sections,
      families,
      count: intIn(body.count, 1, L.maxCount, 'count'),
      ttl: intIn(body.ttl, L.minTtl, L.maxTtl, 'ttl'),
      intervalSec: intIn(body.intervalSec, L.minInterval, L.maxInterval, 'intervalSec'),
      enabled: body.enabled !== false,
    };
  }

  async function removeFromDns(record) {
    try {
      const t = repo.getTarget(record.targetId, true);
      if (t) await providerFactory(t).remove(record.name);
      repo.log(record.id, record.name, 'info', null, `removed from ${t?.type}:${t?.name}`);
    } catch (e) {
      repo.log(record.id, record.name, 'error', null, `cleanup failed: ${e.message}`);
    }
  }

  const uniqueGuard = (fn) => {
    try {
      return fn();
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'A record with this name already exists on that target');
      throw e;
    }
  };

  r.get('/records', (req, res) => res.json(repo.listRecords()));
  r.post(
    '/records',
    wrap(async (req, res) => {
      const rec = uniqueGuard(() => repo.createRecord(parseRecord(req.body)));
      const result = rec.enabled ? await rotator.rotate(rec) : null;
      res.status(201).json({ record: repo.getRecord(rec.id), result });
    })
  );
  r.put(
    '/records/:id',
    wrap(async (req, res) => {
      const old = repo.getRecord(id(req));
      if (!old) throw new HttpError(404, 'Record not found');
      const next = parseRecord(req.body);
      const moved = old.name !== next.name || old.targetId !== next.targetId;
      const rec = uniqueGuard(() => repo.updateRecord(old.id, next));
      if (moved) await removeFromDns(old);
      const result = rec.enabled ? await rotator.rotate(rec) : null;
      res.json({ record: repo.getRecord(rec.id), result });
    })
  );
  r.delete(
    '/records/:id',
    wrap(async (req, res) => {
      const rec = repo.getRecord(id(req));
      if (!rec) throw new HttpError(404, 'Record not found');
      if (req.query.keepDns !== 'true') await removeFromDns(rec);
      repo.deleteRecord(rec.id);
      res.status(204).end();
    })
  );
  r.post(
    '/records/:id/rotate',
    wrap(async (req, res) => {
      if (!repo.getRecord(id(req))) throw new HttpError(404, 'Record not found');
      res.json(await rotator.rotateById(id(req)));
    })
  );
  r.post('/preview', (req, res) => {
    const L = config.limits;
    const families = ['v4', 'v6', 'both'].includes(req.body.families) ? req.body.families : 'both';
    const sections = Array.isArray(req.body.sections) ? req.body.sections.map(String) : [];
    try {
      res.json(rotator.preview(sections, families, intIn(req.body.count ?? 1, 1, L.maxCount, 'count')));
    } catch (e) {
      throw e instanceof HttpError ? e : new HttpError(400, e.message);
    }
  });

  r.get('/logs', (req, res) => res.json(repo.listLogs(Math.min(Number(req.query.limit) || 100, 500))));

  r.use((err, req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
  });
  return r;
}
