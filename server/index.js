import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import express from 'express';

import { config } from './config.js';
import { createRouter } from './routes.js';
import * as storage from './storage.js';
import { loadPepper } from './auth.js';

const app = express();
app.disable('x-powered-by');
// Numeric hop count or proxy list - never bare `true`, which would take the
// forgeable leftmost X-Forwarded-For value. See config.trustProxy.
if (config.trustProxy) app.set('trust proxy', config.trustProxy);

/**
 * Hand-written rather than helmet: there are eight headers here, all of them
 * chosen deliberately, and a dependency that changes its defaults between
 * minor versions is a worse deal than eight lines of code.
 */
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    // Svelte emits scoped <style> blocks; there is no inline script anywhere.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // Only where it cannot break a plain-http LAN origin: a request that already
  // arrived over TLS has nothing to lose by refusing to be downgraded.
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use('/api', createRouter());

/**
 * The corpus.
 *
 * Every file is served as opaque octet-stream with no `Content-Encoding`, so
 * the browser hands the client the gzip bytes untouched and the client
 * inflates them itself. That is deliberate: it keeps the Cache Storage copy
 * compressed, which is what makes the 128-shard cache ceiling ~4.5 MB instead
 * of ~15 MB, and it sidesteps the Cache API's habit of re-decoding a stored
 * response whose headers still claim an encoding.
 *
 * Names are matched against an exact pattern rather than joined from user
 * input, so there is no traversal to reason about.
 */
const CORPUS_FILE_RE = /^(manifest\.json|index\.txt\.gz|tiers\.bin\.gz|shard-\d{4}\.json\.gz|ATTRIBUTION\.txt)$/;

app.get(/^\/corpus\/(.*)$/, (req, res) => {
  const name = req.params[0];
  const file = path.join(config.corpusDir, name);
  // Anything unrecognised ends here with a 404 rather than falling through to
  // the SPA. The catch-all below answers 200 with index.html, so a mistyped
  // shard would otherwise hand the client - and the service worker's shard
  // cache - a page of HTML claiming to be a dictionary shard.
  if (!CORPUS_FILE_RE.test(name) || !fs.existsSync(file)) {
    return res.status(404).json({ error: 'No such corpus file' });
  }

  if (name === 'manifest.json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // The only mutable name in the corpus: it is how a client discovers that
    // corpusVersion changed, so it must never be served from a stale cache.
    res.setHeader('Cache-Control', 'no-cache');
  } else if (name === 'ATTRIBUTION.txt') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
  } else {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  res.sendFile(file);
});

if (fs.existsSync(config.publicDir)) {
  app.use(express.static(config.publicDir, {
    index: 'index.html',
    setHeaders(res, filePath) {
      if (/[\\/]assets[\\/]/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
      // A cached service worker would pin an old build indefinitely, so it must
      // always be revalidated, and it must be allowed to claim the whole scope.
      if (filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Service-Worker-Allowed', '/');
      }
    },
  }));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(config.publicDir, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.status(503).type('text/plain').send(
      'Client bundle not built yet.\n\n'
      + 'Development:  bun run dev        (Vite on :5173 proxies /api and /corpus here)\n'
      + 'Production:   bun run build && bun start\n',
    );
  });
}

// Express 5 forwards rejected async handlers here.
app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error('[error]', err);

  // body-parser aborts an oversized body before the route runs, so its own
  // error has to be translated into the same shape the route would have
  // produced. Otherwise a 3 MB upload and a 2.001 MB upload - both refused
  // for the same reason - answer with two different JSON bodies.
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Snapshot too large',
      maxBytes: config.maxSnapshotBytes,
      size: Number(err.length) || null,
    });
  }

  const body = { error: status >= 500 ? 'Internal server error' : err.message };
  for (const key of ['rev', 'corpusVersion', 'maxBytes', 'maxWords', 'limit', 'size', 'words', 'retryAfterSeconds']) {
    if (err[key] !== undefined) body[key] = err[key];
  }
  if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
  res.status(status).json(body);
});

const server = http.createServer(app);

/**
 * Serve correctly whether or not the reverse proxy strips the path prefix.
 *
 * A reverse proxy routing by path may forward "/dictionary/api/x" intact or
 * strip it to "/api/x", and which one you get depends on its configuration.
 * Rather than betting on it, the prefix is removed here - before Express sees
 * the request - so everything downstream is mounted at the root either way. If
 * the proxy already stripped it, this is a no-op.
 */
if (config.basePath) {
  const stripPrefix = (req) => {
    if (!req.url) return;
    if (req.url === config.basePath) req.url = '/';
    else if (req.url.startsWith(`${config.basePath}/`)) req.url = req.url.slice(config.basePath.length);
    else if (req.url.startsWith(`${config.basePath}?`)) req.url = `/${req.url.slice(config.basePath.length)}`;
  };
  server.prependListener('request', stripPrefix);
}

loadPepper();
const booted = await storage.init();

const sweeper = setInterval(() => {
  storage.sweep().catch((err) => console.error('[sweep]', err));
}, config.sweepIntervalMs);
sweeper.unref();

server.listen(config.port, config.host, () => {
  console.log(`The Whole Dictionary listening on http://${config.host}:${config.port}`);
  console.log(`  mounted at    ${config.basePath || '/'}`);
  console.log(`  data dir      ${config.dataDir}`);
  console.log(`  profiles      ${booted.profiles} (${booted.bytesOnDisk} bytes, ${booted.swept} swept)`);
  console.log(`  quota         ${config.quotaBytes} bytes, max snapshot ${config.maxSnapshotBytes}`);
  if (!fs.existsSync(path.join(config.corpusDir, 'manifest.json'))) {
    console.log('  corpus NOT built - run `bun run corpus`');
  }
  if (!fs.existsSync(config.publicDir)) console.log('  client bundle NOT built - run `bun run build`');
});

const shutdown = (signal) => {
  console.log(`\n${signal} received, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, server };
