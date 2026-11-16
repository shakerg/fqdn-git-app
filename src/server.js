import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createCipher } from './crypto.js';
import { openDb, createRepo } from './db.js';
import { createMetaFetcher } from './meta.js';
import { createProviderFactory } from './providers/index.js';
import { createRotator } from './rotator.js';
import { createAuth } from './auth.js';
import { createApiRouter } from './api.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ config, fetchImpl, providerOverrides, logger = console } = {}) {
  const db = openDb(config.dataDir);
  const repo = createRepo(db, createCipher(config.appSecretKey));
  const metaFetcher = createMetaFetcher({ repo, url: config.metaUrl, token: config.githubToken, fetchImpl, logger });
  const providerFactory = createProviderFactory(providerOverrides);
  const rotator = createRotator({ repo, metaFetcher, providerFactory, config, logger });
  const auth = createAuth({ repo, config });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === 'true');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
    );
    next();
  });
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/api', express.json({ limit: '64kb' }), createApiRouter({ repo, rotator, providerFactory, auth, config }));
  app.use(express.static(path.join(here, '..', 'public')));
  return { app, db, repo, rotator };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const { app, rotator, db } = createApp({ config });
  const server = app.listen(config.port, () => console.log(`github-meta-dns-pool listening on :${config.port}`));
  rotator.start();
  const shutdown = () => {
    rotator.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
