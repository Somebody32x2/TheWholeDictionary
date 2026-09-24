<script lang="ts">
  /**
   * The public page for a published list, opened from a shared link
   * (`?list=<code>`). Works without an account. Definitions are fetched a page
   * at a time: a long list can span most of the dictionary's shards, and
   * pulling all of them just to render the first screen would be a
   * multi-megabyte download.
   */
  import { onMount, untrack } from 'svelte';
  import * as corpus from '../lib/corpus';
  import * as progress from '../lib/progress';
  import * as sync from '../lib/sync';
  import { back, go, showToast, ui } from '../lib/ui.svelte';
  import Back from './Back.svelte';

  const PAGE = 50;

  let list = $state<sync.PublishedList | null>(null);
  let error = $state('');
  let shown = $state(PAGE);
  let glosses = $state<Record<string, { pos: string; gloss: string } | null>>({});
  let saved = $state(false);
  let ids: Map<string, number> | null = null;

  async function loadGlosses(words: string[]) {
    if (!ids) {
      await corpus.ensureIndexCached();
      const index = await corpus.indexWords();
      ids = new Map((index ?? []).map((w, i) => [w, i]));
    }
    const next = { ...glosses };
    let added = 0;
    await Promise.all(words.map(async (word) => {
      if (word in next) return;
      added++;
      const id = ids!.get(word);
      if (id === undefined) { next[word] = null; return; }
      const entry = await corpus.getWord(id).catch(() => null);
      next[word] = entry?.defs[0] ?? null;
    }));
    if (added) glosses = { ...glosses, ...next };
  }

  // Depends on the list and the page size only. The loader reads and writes
  // `glosses`; tracking that would make every batch re-trigger the effect.
  $effect(() => {
    if (!list) return;
    const words = list.words.slice(0, shown);
    untrack(() => void loadGlosses(words));
  });

  function saveCopy() {
    if (!list) return;
    const copy = progress.createList(list.name);
    for (const word of list.words) progress.setInList(copy.id, word, true);
    saved = true;
    showToast(`Saved “${list.name}” to your lists.`);
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === 'Escape' || event.key === 'ArrowLeft') back();
  }

  onMount(async () => {
    try {
      list = await sync.fetchPublished(ui.publishedCode);
    } catch (err) {
      error = String((err as Error).message ?? err);
    }
  });

  const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
</script>

<svelte:window onkeydown={onKey} />

<div class="overlay" role="dialog" tabindex="-1" aria-label="Published list">
  <div class="sheet">
    <Back />
    {#if error}
      <h1>List unavailable</h1>
      <p class="muted">{error}</p>
    {:else if !list}
      <p class="muted">loading…</p>
    {:else}
      <h1>{list.name}</h1>
      <p class="meta">
        <span class="num">{list.count.toLocaleString()}</span> {list.count === 1 ? 'word' : 'words'}
        · shared {dateFmt.format(new Date(list.publishedAt))}
        {#if list.updatedAt > list.publishedAt + 60_000}
          · updated {dateFmt.format(new Date(list.updatedAt))}
        {/if}
      </p>
      <div class="actions">
        <button class="action" disabled={saved} onclick={saveCopy}>{saved ? 'saved to your lists' : 'save a copy'}</button>
        <button class="action" onclick={() => go('word')}>start the dictionary</button>
      </div>

      <dl>
        {#each list.words.slice(0, shown) as word (word)}
          <div class="entry">
            <dt>{word}</dt>
            <dd>
              {#if glosses[word]}
                <span class="pos">{glosses[word]!.pos}</span> {glosses[word]!.gloss}
              {:else if word in glosses}
                <span class="muted">—</span>
              {:else}
                <span class="muted">…</span>
              {/if}
            </dd>
          </div>
        {/each}
      </dl>
      {#if shown < list.words.length}
        <button class="action more" onclick={() => { shown += PAGE; }}>
          show {Math.min(PAGE, list.words.length - shown)} more
        </button>
      {/if}
    {/if}
  </div>
</div>

<style>
  .meta { color: var(--dimmer); font-style: italic; margin: -1.2rem 0 1rem; }
  .actions {
    display: flex;
    gap: 1.2rem;
    margin-bottom: 1.8rem;
    font-family: var(--font-label);
    font-variant-caps: all-small-caps;
    letter-spacing: 0.05em;
    font-size: 1.05rem;
  }
  .action { color: var(--dim); }
  .action:hover:not(:disabled) { color: var(--fg); }
  .action:disabled { color: var(--ok); cursor: default; }

  dl { margin: 0; }
  .entry {
    display: grid;
    grid-template-columns: minmax(8rem, 12rem) 1fr;
    gap: 0.2rem 1.2rem;
    padding: 0.55rem 0;
    border-top: 1px solid var(--rule);
  }
  dt { font-family: var(--font-head); font-size: 1.2rem; color: var(--fg); overflow-wrap: anywhere; }
  dd { margin: 0; color: var(--dim); line-height: 1.5; }
  .pos { font-family: var(--font-label); font-style: italic; color: var(--dimmer); margin-right: 0.35rem; }
  @media (max-width: 34rem) {
    .entry { grid-template-columns: 1fr; }
  }
  .more { margin-top: 1.2rem; }
</style>
