#!/usr/bin/env bun
/**
 * One command for development: the API server and the Vite dev server.
 *
 * Vite proxies /api and /corpus to :8080, so running it alone gives a page
 * that cannot load its dictionary (ECONNREFUSED on /corpus/manifest.json).
 * Starting both here means `bun run dev` just works, and stopping either one
 * stops the other, so a crashed server never leaves a proxy failing silently.
 */

const children = [
  Bun.spawn(['bun', '--watch', 'server/index.js'], { stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' }),
  Bun.spawn(['bun', '--bun', 'vite'], { stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exit(code);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

const first = await Promise.race(children.map((child) => child.exited));
stop(first ?? 1);
