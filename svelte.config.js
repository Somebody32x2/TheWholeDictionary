import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Exists so `svelte-check` can find the preprocessor. The Vite build reads the
 * plugin from vite.config.ts; svelte-check does not, and without this file it
 * reports every `lang="ts"` block as a syntax error.
 */
export default {
  preprocess: vitePreprocess(),
};
