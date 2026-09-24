import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';

const app = mount(App, { target: document.getElementById('app')! });

/**
 * Registered after mount so a broken or stale worker can never stop the app
 * from starting. The corpus and the profile both live in IndexedDB, so the
 * page is already offline-capable before the worker exists; the worker only
 * caches the shell and the shards.
 */
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
      scope: import.meta.env.BASE_URL,
    }).catch((err) => console.warn('[sw] registration failed', err));
  });
}

export default app;
