import { buildPool, poolHash, pickIps } from './picker.js';

export function createRotator({ repo, metaFetcher, providerFactory, config, logger = console }) {
  const inFlight = new Set();
  let metaTimer;
  let tickTimer;
  let lastMetaAttempt = 0;

  function preview(sections, families, count) {
    const meta = metaFetcher.current()?.json;
    if (!meta) throw new Error('GitHub meta not loaded yet');
    const pool = buildPool(meta, sections, families);
    const picked = pickIps(pool, count, families);
    return {
      poolSize: pool.length,
      poolV4: pool.filter((p) => p.family === 4).length,
      poolV6: pool.filter((p) => p.family === 6).length,
      ...picked,
    };
  }

  async function rotate(record) {
    if (inFlight.has(record.id)) return { skipped: true };
    inFlight.add(record.id);
    try {
      const meta = metaFetcher.current()?.json;
      if (!meta) throw new Error('GitHub meta not loaded yet');
      const target = repo.getTarget(record.targetId, true);
      if (!target) throw new Error('Target not found');
      const pool = buildPool(meta, record.sections, record.families);
      if (!pool.length) throw new Error('Selected sections have no CIDRs for the chosen IP family');
      const picked = pickIps(pool, record.count, record.families);
      await providerFactory(target).apply(record.name, { ...picked, ttl: record.ttl });
      const ips = [...picked.a, ...picked.aaaa];
      repo.markRotated(record.id, ips, poolHash(pool), record.intervalSec);
      repo.log(record.id, record.name, 'ok', ips, `pushed to ${target.type}:${target.name}`);
      logger.info?.(`[rotate] ${record.name} -> ${ips.join(', ')}`);
      return { ok: true, ips };
    } catch (e) {
      const fails = (record.failCount || 0) + 1;
      const retryMs = Math.min(record.intervalSec * 1000, 30_000 * 2 ** Math.min(fails - 1, 10));
      const msg = e?.message || String(e);
      repo.markFailed(record.id, msg, retryMs);
      repo.log(record.id, record.name, 'error', null, msg);
      logger.error?.(`[rotate] ${record.name} failed: ${msg}`);
      return { ok: false, error: msg };
    } finally {
      inFlight.delete(record.id);
    }
  }

  async function rotateById(id) {
    const r = repo.getRecord(id);
    if (!r) throw new Error('Record not found');
    return rotate(r);
  }

  /** Rotate records whose selected pool changed (e.g. GitHub removed a range). */
  function markPoolChanges() {
    const meta = metaFetcher.current()?.json;
    if (!meta) return 0;
    let n = 0;
    for (const r of repo.enabledRecords()) {
      if (r.poolHash && r.poolHash !== poolHash(buildPool(meta, r.sections, r.families))) {
        repo.forceDue(r.id);
        repo.log(r.id, r.name, 'info', null, 'GitHub meta pool changed; rotation scheduled');
        n++;
      }
    }
    return n;
  }

  async function refreshMeta() {
    lastMetaAttempt = Date.now();
    const res = await metaFetcher.refresh();
    if (res.changed) markPoolChanges();
    return res;
  }

  async function tick() {
    if (!metaFetcher.current() && Date.now() - lastMetaAttempt > 60_000) {
      await refreshMeta().catch((e) => logger.error?.(`[meta] ${e.message}`));
    }
    for (const r of repo.dueRecords()) await rotate(r);
  }

  function start() {
    refreshMeta()
      .catch((e) => logger.error?.(`[meta] ${e.message}`))
      .finally(() => tick());
    metaTimer = setInterval(() => refreshMeta().catch((e) => logger.error?.(`[meta] ${e.message}`)), config.metaRefreshSec * 1000);
    tickTimer = setInterval(() => tick().catch((e) => logger.error?.(`[tick] ${e.message}`)), config.schedulerTickSec * 1000);
  }

  function stop() {
    clearInterval(metaTimer);
    clearInterval(tickTimer);
  }

  return { preview, rotate, rotateById, refreshMeta, markPoolChanges, tick, start, stop };
}
