import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/** "/dictionary/" or "dictionary" -> "/dictionary/"; blank -> "/". */
function baseFromEnv(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === '/') return '/';
  return `${trimmed.startsWith('/') ? trimmed : `/${trimmed}`}/`;
}

export default defineConfig({
  root: path.join(root, 'client'),
  base: baseFromEnv(process.env.BASE_PATH),
  publicDir: path.join(root, 'client', 'public'),
  resolve: {
    alias: {
      '@shared': path.join(root, 'shared'),
      '@lib': path.join(root, 'client', 'src', 'lib'),
    },
  },
  plugins: [svelte()],
  build: {
    outDir: path.join(root, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      // The dev server owns the app; the API and the committed corpus come from
      // the Express process, so a dev session behaves exactly like production.
      '/api': 'http://127.0.0.1:8080',
      '/corpus': 'http://127.0.0.1:8080',
    },
  },
});
