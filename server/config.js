import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

export const config = {
  port: int(process.env.PORT, 8080),
  host: process.env.HOST ?? '0.0.0.0',
  root,
  publicDir: path.join(root, 'dist'),
  corpusDir: path.join(root, 'corpus'),
  dataDir: process.env.DATA_DIR ?? path.join(root, 'data'),

  /**
   * A full profile at ~200k words is four arrays totalling 1.6 MB raw, and
   * gzips to well under 300 KB even when every word is answered. 2 MB is
   * therefore generous for real data and still small enough that the whole
   * body can be held in memory while it is validated.
   */
  maxSnapshotBytes: int(process.env.MAX_SNAPSHOT_BYTES, 2 * MIB),
  /** Total bytes at rest before new profiles and growth are refused. */
  quotaBytes: int(process.env.QUOTA_BYTES, 2 * GIB),
  /** Profiles untouched this long are swept. A phrase cannot be recovered anyway. */
  profileTtlDays: int(process.env.PROFILE_TTL_DAYS, 730),
  sweepIntervalMs: int(process.env.SWEEP_INTERVAL_MS, 6 * 60 * 60 * 1000),

  /**
   * Auth failure throttle. This slows guessing down; it never locks anyone out.
   * A correct phrase always works, however many failures preceded it, because
   * one IP is an entire NAT or a whole Cloudflare egress range and a hard
   * lockout would let one person's typo shut out everybody behind it.
   */
  authFailSoft: int(process.env.AUTH_FAIL_SOFT, 10),
  authFailHard: int(process.env.AUTH_FAIL_HARD, 200),
  authFailWindowMs: int(process.env.AUTH_FAIL_WINDOW_MS, 15 * 60_000),

  accountCreateMax: int(process.env.ACCOUNT_CREATE_MAX, 10),
  accountCreateWindowMs: int(process.env.ACCOUNT_CREATE_WINDOW_MS, 60 * 60_000),
  snapshotWriteMax: int(process.env.SNAPSHOT_WRITE_MAX, 120),
  snapshotWriteWindowMs: int(process.env.SNAPSHOT_WRITE_WINDOW_MS, 10 * 60_000),
  snapshotReadMax: int(process.env.SNAPSHOT_READ_MAX, 240),
  snapshotReadWindowMs: int(process.env.SNAPSHOT_READ_WINDOW_MS, 10 * 60_000),
  snapshotDeleteMax: int(process.env.SNAPSHOT_DELETE_MAX, 5),
  snapshotDeleteWindowMs: int(process.env.SNAPSHOT_DELETE_WINDOW_MS, 60 * 60_000),

  /**
   * Published lists are public, so they are bounded harder than private
   * state: a cap on size, a cap per account, and a rate. Words are also
   * checked against the corpus, which is what keeps a publication from being
   * usable as free-form public text hosting.
   */
  publishMaxWords: int(process.env.PUBLISH_MAX_WORDS, 5000),
  publishMaxPerOwner: int(process.env.PUBLISH_MAX_PER_OWNER, 100),
  publishRateMax: int(process.env.PUBLISH_RATE_MAX, 30),
  publishRateWindowMs: int(process.env.PUBLISH_RATE_WINDOW_MS, 10 * 60_000),

  /**
   * How far to trust `X-Forwarded-For`.
   *
   * A number is a count of proxies between the internet and this process, and
   * the client address is read that many hops from the *right* of the chain -
   * the only part a client cannot forge, since each proxy appends the address
   * it actually saw. A comma-separated list of proxy addresses is also
   * accepted. Empty or "0" means the header is ignored entirely.
   *
   * Taking the leftmost value instead would let any client name its own
   * address and walk straight through every rate limit here.
   */
  trustProxy: trustProxySetting(process.env.TRUST_PROXY),

  /**
   * Behind a CDN whose forwarded headers the reverse proxy discards, read the
   * visitor's address from the CDN's own header instead - e.g.
   * CLIENT_IP_HEADER=cf-connecting-ip with CLIENT_IP_HEADER_FROM=cloudflare.
   * The header is believed only when the edge address (resolved through
   * TRUST_PROXY as usual) is inside CLIENT_IP_HEADER_FROM, so a request that
   * bypasses the CDN cannot choose its own identity. See server/edges.js.
   */
  clientIpHeader: (process.env.CLIENT_IP_HEADER ?? '').trim().toLowerCase(),
  clientIpHeaderFrom: process.env.CLIENT_IP_HEADER_FROM ?? '',
  isProduction: process.env.NODE_ENV === 'production',

  /**
   * Origins allowed to call the API, comma separated. Empty means same-origin
   * only. There is no CORS middleware: nothing here is meant to be embedded.
   */
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim().replace(/\/+$/, ''))
    .filter(Boolean),

  /**
   * Mount point, e.g. "/dictionary". Must match the BASE_PATH the client was
   * built with. Empty means the origin root.
   */
  basePath: normalisePath(process.env.BASE_PATH),

  /** Overrides the generated pepper. Losing the pepper orphans every profile. */
  syncPepper: process.env.SYNC_PEPPER ?? '',
};

/**
 * "1" -> 1 hop, "2" -> 2 hops, "10.0.0.1,10.0.0.2" -> that proxy list,
 * blank/"0"/"false" -> do not read the header at all.
 *
 * "true" is accepted for compatibility and means one hop, which is what a
 * single reverse proxy in front of this process actually is. It deliberately
 * does not mean "believe whatever the header says".
 */
function trustProxySetting(raw) {
  const value = (raw ?? '').trim();
  if (!value || value === '0' || value.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  if (value.toLowerCase() === 'true') return 1;
  const list = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  return list.length ? list : false;
}

/** "/dictionary/" or "dictionary" -> "/dictionary"; blank -> "". */
function normalisePath(value) {
  const trimmed = (value ?? '').trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === '/') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
