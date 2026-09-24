import net from 'node:net';

import { config } from './config.js';
import { edgeBlockList, inEdge } from './edges.js';

const trustedEdges = config.clientIpHeader ? edgeBlockList(config.clientIpHeaderFrom) : null;

/**
 * Work out who is actually talking to us, counting proxy hops from the right.
 *
 * `X-Forwarded-For` is client-supplied at its left edge and cannot be trusted
 * there: anyone may send `X-Forwarded-For: 1.2.3.4` and, if we read the
 * leftmost value, become a fresh identity on every request. What a client
 * *cannot* forge is the right edge, because each proxy appends the address it
 * genuinely saw. So with N trusted proxies the client is N entries from the end.
 *
 * With one proxy and an honest client the header is `[client]` and we take it.
 * With one proxy and a client that prepended a lie it is `[lie, client]`, and
 * we still take the client. That is the whole point.
 */
export function resolveIp(remoteAddress, forwardedFor) {
  const direct = remoteAddress ?? 'unknown';
  const trust = config.trustProxy;
  if (!trust) return direct;

  const chain = String(forwardedFor ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  if (!chain.length) return direct;

  if (Array.isArray(trust)) {
    // Walk left past every address we recognise as our own infrastructure.
    let i = chain.length - 1;
    while (i >= 0 && trust.includes(chain[i])) i -= 1;
    return chain[i] ?? chain[0];
  }
  // Numeric: the nearest proxy is the socket peer and is not in the header, so
  // `trust` hops back from the end lands on the client.
  return chain[chain.length - trust] ?? chain[0];
}

export function clientIp(req) {
  const edge = resolveIp(req.socket?.remoteAddress, req.headers?.['x-forwarded-for']);
  if (trustedEdges && inEdge(trustedEdges, edge)) {
    const claimed = String(req.headers?.[config.clientIpHeader] ?? '').split(',')[0].trim();
    if (net.isIP(claimed)) return claimed;
  }
  return edge;
}

/** True for a request that reached this process without crossing a network. */
export function isLoopback(req) {
  const addr = String(req.socket?.remoteAddress ?? '');
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * Sliding-window counter, in memory. Single-process only; behind multiple
 * instances this needs a shared store.
 */
export class RateLimiter {
  #hits = new Map();

  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** @returns {{allowed: boolean, retryAfterMs: number}} */
  check(key) {
    const now = Date.now();
    const times = (this.#hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (times.length >= this.limit) {
      const retryAfterMs = this.windowMs - (now - times[0]);
      this.#hits.set(key, times);
      return { allowed: false, retryAfterMs };
    }
    times.push(now);
    this.#hits.set(key, times);
    return { allowed: true, retryAfterMs: 0 };
  }

  reset(key) {
    this.#hits.delete(key);
  }

  /**
   * Give back the most recent attempt.
   *
   * The point of these limiters is to make *enumeration* expensive, not to
   * punish someone syncing often. A request that authenticated is not a guess,
   * so it is refunded and only failures accumulate.
   */
  pardon(key) {
    const times = this.#hits.get(key);
    if (!times?.length) return;
    times.pop();
    if (times.length === 0) this.#hits.delete(key);
  }

  /** Drop stale keys so the map cannot grow without bound. */
  sweep() {
    const now = Date.now();
    for (const [key, times] of this.#hits) {
      const live = times.filter((t) => now - t < this.windowMs);
      if (live.length === 0) this.#hits.delete(key);
      else this.#hits.set(key, live);
    }
  }
}

export function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
