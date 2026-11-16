function int(name, def, env) {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer`);
  return n;
}

export function loadConfig(env = process.env) {
  const cfg = {
    port: int('PORT', 8080, env),
    dataDir: env.DATA_DIR || './data',
    adminPassword: env.ADMIN_PASSWORD || '',
    appSecretKey: env.APP_SECRET_KEY || '',
    cookieSecure: env.COOKIE_SECURE === 'true',
    sessionTtlSec: int('SESSION_TTL_SEC', 12 * 3600, env),
    metaUrl: env.META_URL || 'https://api.github.com/meta',
    metaRefreshSec: int('META_REFRESH_SEC', 3600, env),
    githubToken: env.GITHUB_TOKEN || '',
    schedulerTickSec: int('SCHEDULER_TICK_SEC', 15, env),
    limits: {
      maxCount: int('MAX_IPS_PER_RECORD', 16, env),
      minTtl: int('MIN_TTL', 60, env),
      maxTtl: 86400,
      minInterval: int('MIN_INTERVAL_SEC', 60, env),
      maxInterval: 7 * 86400,
    },
  };
  if (cfg.adminPassword.length < 8) throw new Error('ADMIN_PASSWORD must be set (min 8 chars)');
  if (cfg.appSecretKey.length < 16) throw new Error('APP_SECRET_KEY must be set (min 16 chars)');
  return cfg;
}
