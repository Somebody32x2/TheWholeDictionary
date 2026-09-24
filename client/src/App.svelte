<script lang="ts">
  import { onMount } from 'svelte';

  import * as corpus from './lib/corpus';
  import * as progress from './lib/progress';
  import * as sync from './lib/sync';
  import { loadDevice, device } from './lib/device';
  import { migrateIfNeeded } from './lib/migration';
  import { ui, go, showToast } from './lib/ui.svelte';

  import Word from './routes/Word.svelte';
  import Settings from './routes/Settings.svelte';
  import StatsCoverage from './routes/StatsCoverage.svelte';
  import StatsTiming from './routes/StatsTiming.svelte';
  import Account from './routes/Account.svelte';
  import ListPicker from './routes/ListPicker.svelte';
  import Lists from './routes/Lists.svelte';
  import PublishedList from './routes/PublishedList.svelte';

  let bootFailure = $state<'missing' | 'unreachable' | 'other'>('other');

  /** '1 word', '3 words' - with a thousands separator. */
  function count(n: number, noun: string) {
    return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;
  }

  function applyTheme(theme: string) {
    const dark = theme === 'dark'
      || (theme === 'system' && !matchMedia('(prefers-color-scheme: light)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }

  onMount(async () => {
    try {
      await loadDevice();
      applyTheme(device().theme);

      const manifest = await corpus.loadManifest();
      await progress.load(manifest.corpusVersion, manifest.wordCount);

      const migration = await migrateIfNeeded();
      if (migration) {
        showToast(migration.lost
          ? `Dictionary updated; ${count(migration.dropped, 'answer')} could not be carried over.`
          : `Dictionary updated: ${count(migration.remapped, 'answer')} kept, ${count(migration.dropped, 'word')} retired.`, 9000);
      }

      await corpus.loadTiers();
      progress.subscribe(() => { ui.revision++; });
      progress.installLifecycleHooks();

      // The index is only needed by a future migration, so it must not hold
      // up the first word - but it must be on disk before the corpus changes.
      corpus.ensureIndexCached().catch((err) => console.warn('[corpus] index cache failed', err));

      sync.onCorpusMismatch(async () => {
        corpus.resetCache();
        await corpus.loadManifest();
        const result = await migrateIfNeeded();
        if (result) showToast(`Dictionary updated: ${count(result.remapped, 'answer')} kept.`, 9000);
        return true;
      });
      await sync.init();

      ui.ready = true;

      // A shared link: open the published list on top of the app. The query
      // string is dropped from the address first, so leaving the list lands on
      // a clean URL and a reload does not reopen it.
      const shared = new URLSearchParams(location.search).get('list');
      if (shared && /^[a-z0-9]{10}$/.test(shared)) {
        history.replaceState(null, '', import.meta.env.BASE_URL);
        ui.publishedCode = shared;
        go('published');
      }
    } catch (err) {
      ui.bootError = String((err as Error)?.message ?? err);
      bootFailure = err instanceof corpus.ManifestError ? err.kind : 'other';
      console.error('[boot]', err);
    }
  });
</script>

{#if ui.bootError}
  <main class="boot">
    <p>The dictionary could not be loaded.</p>
    <p class="muted mono">{ui.bootError}</p>
    {#if bootFailure === 'missing'}
      <p class="muted">
        The server has no corpus. Build it once with
        <span class="mono">bun run corpus</span>.
      </p>
    {:else if bootFailure === 'unreachable'}
      <p class="muted">
        The server is not reachable. In development, <span class="mono">bun run dev</span>
        starts both the app and the API server; otherwise start it with
        <span class="mono">bun start</span>. The corpus does not need rebuilding.
      </p>
    {/if}
  </main>
{:else if !ui.ready}
  <main class="boot"><p class="muted">loading the dictionary…</p></main>
{:else}
  <Word />
  {#if ui.view === 'settings'}<Settings onTheme={applyTheme} />{/if}
  {#if ui.view === 'coverage'}<StatsCoverage />{/if}
  {#if ui.view === 'timing'}<StatsTiming />{/if}
  {#if ui.view === 'account'}<Account />{/if}
  {#if ui.view === 'picker'}<ListPicker />{/if}
  {#if ui.view === 'lists'}<Lists />{/if}
  {#if ui.view === 'published'}<PublishedList />{/if}
{/if}

{#if ui.toast}<div class="toast">{ui.toast}</div>{/if}

<style>
  .boot {
    display: grid;
    place-content: center;
    height: 100%;
    text-align: center;
    padding: 2rem;
    gap: 0.6rem;
  }
</style>
