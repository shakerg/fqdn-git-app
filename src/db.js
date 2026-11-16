import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at INTEGER NOT NULL,
  etag TEXT,
  json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('bind9','cloudflare','azure')),
  name TEXT NOT NULL UNIQUE,
  zone TEXT NOT NULL,
  config_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE RESTRICT,
  sections_json TEXT NOT NULL,
  families TEXT NOT NULL CHECK (families IN ('v4','v6','both')),
  count INTEGER NOT NULL,
  ttl INTEGER NOT NULL,
  interval_sec INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_rotated_at INTEGER,
  next_rotation_at INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  pool_hash TEXT,
  UNIQUE (name, target_id)
);
CREATE TABLE IF NOT EXISTS record_state (
  record_id INTEGER PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
  ips_json TEXT NOT NULL,
  pushed_at INTEGER,
  status TEXT NOT NULL,
  error TEXT
);
CREATE TABLE IF NOT EXISTS rotation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER,
  record_name TEXT,
  at INTEGER NOT NULL,
  ips_json TEXT,
  result TEXT NOT NULL,
  message TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
`;

export function openDb(dataDir) {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, 'dnspool.sqlite');
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function createRepo(db, cipher) {
  const now = () => Date.now();
  const rowToRecord = (r) =>
    r && {
      id: r.id,
      name: r.name,
      targetId: r.target_id,
      sections: JSON.parse(r.sections_json),
      families: r.families,
      count: r.count,
      ttl: r.ttl,
      intervalSec: r.interval_sec,
      enabled: !!r.enabled,
      lastRotatedAt: r.last_rotated_at,
      nextRotationAt: r.next_rotation_at,
      failCount: r.fail_count,
      poolHash: r.pool_hash,
    };
  const rowToTarget = (r, withSecrets = false) =>
    r && {
      id: r.id,
      type: r.type,
      name: r.name,
      zone: r.zone,
      createdAt: r.created_at,
      ...(withSecrets ? { config: cipher.decrypt(r.config_enc) } : {}),
    };

  return {
    saveMeta(json, etag) {
      db.prepare('INSERT INTO meta_snapshot (fetched_at, etag, json) VALUES (?,?,?)').run(now(), etag || null, JSON.stringify(json));
      db.prepare('DELETE FROM meta_snapshot WHERE id NOT IN (SELECT id FROM meta_snapshot ORDER BY id DESC LIMIT 5)').run();
    },
    touchMeta() {
      db.prepare('UPDATE meta_snapshot SET fetched_at = ? WHERE id = (SELECT MAX(id) FROM meta_snapshot)').run(now());
    },
    latestMeta() {
      const r = db.prepare('SELECT * FROM meta_snapshot ORDER BY id DESC LIMIT 1').get();
      return r ? { fetchedAt: r.fetched_at, etag: r.etag, json: JSON.parse(r.json) } : null;
    },

    listTargets() {
      return db.prepare('SELECT * FROM targets ORDER BY name').all().map((r) => rowToTarget(r));
    },
    getTarget(id, withSecrets = false) {
      return rowToTarget(db.prepare('SELECT * FROM targets WHERE id = ?').get(id), withSecrets);
    },
    createTarget({ type, name, zone, config }) {
      const info = db
        .prepare('INSERT INTO targets (type, name, zone, config_enc, created_at) VALUES (?,?,?,?,?)')
        .run(type, name, zone, cipher.encrypt(config), now());
      return this.getTarget(info.lastInsertRowid);
    },
    updateTarget(id, { name, zone, config }) {
      db.prepare('UPDATE targets SET name = ?, zone = ?, config_enc = ? WHERE id = ?').run(name, zone, cipher.encrypt(config), id);
      db.prepare('UPDATE records SET next_rotation_at = 0, pool_hash = NULL WHERE target_id = ?').run(id);
      return this.getTarget(id);
    },
    deleteTarget(id) {
      return db.prepare('DELETE FROM targets WHERE id = ?').run(id).changes;
    },
    countRecordsForTarget(id) {
      return db.prepare('SELECT COUNT(*) AS n FROM records WHERE target_id = ?').get(id).n;
    },

    listRecords() {
      return db
        .prepare(
          `SELECT r.*, s.ips_json, s.pushed_at, s.status, s.error, t.name AS target_name, t.zone AS target_zone, t.type AS target_type
           FROM records r JOIN targets t ON t.id = r.target_id LEFT JOIN record_state s ON s.record_id = r.id ORDER BY r.name`
        )
        .all()
        .map((r) => ({
          ...rowToRecord(r),
          target: { name: r.target_name, zone: r.target_zone, type: r.target_type },
          state: r.status ? { ips: JSON.parse(r.ips_json), pushedAt: r.pushed_at, status: r.status, error: r.error } : null,
        }));
    },
    getRecord(id) {
      return rowToRecord(db.prepare('SELECT * FROM records WHERE id = ?').get(id));
    },
    getRecordState(id) {
      const r = db.prepare('SELECT * FROM record_state WHERE record_id = ?').get(id);
      return r ? { ips: JSON.parse(r.ips_json), pushedAt: r.pushed_at, status: r.status, error: r.error } : null;
    },
    createRecord(r) {
      const info = db
        .prepare(
          `INSERT INTO records (name, target_id, sections_json, families, count, ttl, interval_sec, enabled, next_rotation_at)
           VALUES (?,?,?,?,?,?,?,?,0)`
        )
        .run(r.name, r.targetId, JSON.stringify(r.sections), r.families, r.count, r.ttl, r.intervalSec, r.enabled ? 1 : 0);
      return this.getRecord(info.lastInsertRowid);
    },
    updateRecord(id, r) {
      db.prepare(
        `UPDATE records SET name=?, target_id=?, sections_json=?, families=?, count=?, ttl=?, interval_sec=?, enabled=?,
         next_rotation_at=0, pool_hash=NULL WHERE id=?`
      ).run(r.name, r.targetId, JSON.stringify(r.sections), r.families, r.count, r.ttl, r.intervalSec, r.enabled ? 1 : 0, id);
      return this.getRecord(id);
    },
    deleteRecord(id) {
      return db.prepare('DELETE FROM records WHERE id = ?').run(id).changes;
    },
    dueRecords(at = now()) {
      return db.prepare('SELECT * FROM records WHERE enabled = 1 AND next_rotation_at <= ?').all(at).map(rowToRecord);
    },
    enabledRecords() {
      return db.prepare('SELECT * FROM records WHERE enabled = 1').all().map(rowToRecord);
    },
    markRotated(id, ips, poolHash, intervalSec) {
      const t = now();
      db.transaction(() => {
        db.prepare('UPDATE records SET last_rotated_at=?, next_rotation_at=?, fail_count=0, pool_hash=? WHERE id=?').run(
          t,
          t + intervalSec * 1000,
          poolHash,
          id
        );
        db.prepare(
          `INSERT INTO record_state (record_id, ips_json, pushed_at, status, error) VALUES (?,?,?,'ok',NULL)
           ON CONFLICT(record_id) DO UPDATE SET ips_json=excluded.ips_json, pushed_at=excluded.pushed_at, status='ok', error=NULL`
        ).run(id, JSON.stringify(ips), t);
      })();
    },
    markFailed(id, error, retryInMs) {
      db.transaction(() => {
        db.prepare('UPDATE records SET next_rotation_at=?, fail_count=fail_count+1 WHERE id=?').run(now() + retryInMs, id);
        db.prepare(
          `INSERT INTO record_state (record_id, ips_json, pushed_at, status, error) VALUES (?,'[]',NULL,'error',?)
           ON CONFLICT(record_id) DO UPDATE SET status='error', error=excluded.error`
        ).run(id, error);
      })();
    },
    forceDue(id) {
      db.prepare('UPDATE records SET next_rotation_at=0 WHERE id=?').run(id);
    },

    log(recordId, recordName, result, ips, message) {
      db.prepare('INSERT INTO rotation_log (record_id, record_name, at, ips_json, result, message) VALUES (?,?,?,?,?,?)').run(
        recordId,
        recordName,
        now(),
        ips ? JSON.stringify(ips) : null,
        result,
        message || null
      );
      db.prepare('DELETE FROM rotation_log WHERE id NOT IN (SELECT id FROM rotation_log ORDER BY id DESC LIMIT 1000)').run();
    },
    listLogs(limit = 100) {
      return db
        .prepare('SELECT * FROM rotation_log ORDER BY id DESC LIMIT ?')
        .all(limit)
        .map((r) => ({
          id: r.id,
          recordId: r.record_id,
          recordName: r.record_name,
          at: r.at,
          ips: r.ips_json ? JSON.parse(r.ips_json) : null,
          result: r.result,
          message: r.message,
        }));
    },

    createSession(tokenHash, expiresAt) {
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
      db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?,?)').run(tokenHash, expiresAt);
    },
    validSession(tokenHash) {
      return !!db.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash, now());
    },
    deleteSession(tokenHash) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    },
  };
}
