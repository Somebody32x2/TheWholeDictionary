<script lang="ts">
  import * as progress from '../lib/progress';
  import * as sync from '../lib/sync';
  import { back, go, showToast, ui } from '../lib/ui.svelte';
  import Back from './Back.svelte';
  import { lastEdit, listWords, STARRED_ID, type WordList } from '@shared/lists.js';

  /** Words shown per list before "show all": enough to recognise it, not a wall. */
  const PREVIEW = 60;

  let newName = $state('');
  let renaming = $state<string | null>(null);
  let renameValue = $state('');
  let expanded = $state<Record<string, boolean>>({});
  let busy = $state<string | null>(null);
  let errors = $state<Record<string, string>>({});

  const lists = $derived.by(() => {
    void ui.revision;
    return progress.lists();
  });
  const signedIn = sync.current().key !== null;

  function create() {
    const name = newName.trim();
    if (!name) return;
    progress.createList(name);
    newName = '';
  }

  function startRename(list: WordList) {
    if (list.id === STARRED_ID) return;
    renaming = list.id;
    renameValue = list.name;
  }

  function finishRename() {
    if (renaming) progress.renameList(renaming, renameValue);
    renaming = null;
  }

  async function run(list: WordList, action: () => Promise<unknown>) {
    busy = list.id;
    errors = { ...errors, [list.id]: '' };
    try {
      await action();
    } catch (err) {
      errors = { ...errors, [list.id]: String((err as Error).message ?? err) };
    } finally {
      busy = null;
    }
  }

  async function publish(list: WordList) {
    await run(list, async () => {
      const code = await sync.publishList(list);
      await copyLink(code, 'Published. Link copied.');
    });
  }

  async function unpublish(list: WordList) {
    await run(list, () => sync.unpublishList(list));
  }

  async function copyLink(code: string, message = 'Link copied.') {
    try {
      await navigator.clipboard.writeText(sync.publishedUrl(code));
      showToast(message);
    } catch {
      showToast('Copy failed - select the link and copy it by hand.');
    }
  }

  function remove(list: WordList) {
    if (!confirm(`Delete “${list.name}”?${list.published ? ' It will also be unpublished.' : ''}`)) return;
    if (list.published && signedIn) void sync.unpublishList(list).catch(() => {});
    progress.deleteList(list.id);
  }

  function onKey(event: KeyboardEvent) {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === 'Escape' || event.key === 'ArrowLeft') back();
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="overlay" role="dialog" tabindex="-1" aria-label="Saved lists">
  <div class="sheet">
    <Back />
    <h1>Saved lists</h1>
    <p class="note">
      Star a word with <kbd>F</kbd> or add it to a list with <kbd>L</kbd>. Lists sync
      with your account. Publishing makes a read-only copy that anyone with the
      link can open; updating it keeps the same link.
    </p>

    <form class="new" onsubmit={(e) => { e.preventDefault(); create(); }}>
      <input type="text" maxlength="80" placeholder="new list name" bind:value={newName} autocomplete="off" />
      <button class="action" disabled={!newName.trim()}>create</button>
    </form>

    {#each lists as list (list.id)}
      {@const words = listWords(list)}
      {@const stale = list.published && lastEdit(list) > list.publishedAt}
      <section class="list">
        <header>
          {#if renaming === list.id}
            <input
              class="rename"
              type="text"
              maxlength="80"
              bind:value={renameValue}
              onkeydown={(e) => {
                if (e.key === 'Enter') finishRename();
                if (e.key === 'Escape') renaming = null;
              }}
              onblur={finishRename}
            />
          {:else}
            <button
              class="name"
              class:fixed={list.id === STARRED_ID}
              title={list.id === STARRED_ID ? '' : 'Rename'}
              onclick={() => startRename(list)}
            >{list.id === STARRED_ID ? '★ ' : ''}{list.name}</button>
          {/if}
          <span class="count num">{words.length} {words.length === 1 ? 'word' : 'words'}</span>
        </header>

        <div class="actions">
          {#if list.published}
            <span class="status">published</span>
            <button class="action" onclick={() => copyLink(list.published)}>copy link</button>
            {#if stale}
              <button class="action" disabled={busy === list.id} onclick={() => publish(list)}>update</button>
            {/if}
            <button class="action" disabled={busy === list.id} onclick={() => unpublish(list)}>unpublish</button>
          {:else}
            <button
              class="action"
              disabled={busy === list.id || words.length === 0}
              title={words.length === 0 ? 'Add a word first' : ''}
              onclick={() => publish(list)}
            >publish</button>
          {/if}
          {#if list.id !== STARRED_ID}
            <button class="action danger" onclick={() => remove(list)}>delete</button>
          {/if}
        </div>

        {#if list.published}
          <p class="url mono">{sync.publishedUrl(list.published)}</p>
        {/if}
        {#if errors[list.id]}
          <p class="note bad">
            {errors[list.id]}
            {#if !signedIn}<button class="inline" onclick={() => go('account')}>open account</button>{/if}
          </p>
        {/if}

        {#if words.length}
          <ul class="words">
            {#each expanded[list.id] ? words : words.slice(0, PREVIEW) as word (word)}
              <li>
                <span>{word}</span>
                <button
                  class="x"
                  title="Remove from {list.name}"
                  aria-label="Remove {word}"
                  onclick={() => progress.setInList(list.id, word, false)}
                >×</button>
              </li>
            {/each}
          </ul>
          {#if words.length > PREVIEW && !expanded[list.id]}
            <button class="inline" onclick={() => { expanded = { ...expanded, [list.id]: true }; }}>
              show all {words.length}
            </button>
          {/if}
        {:else}
          <p class="note">Empty.</p>
        {/if}
      </section>
    {/each}

    <button class="close" onclick={() => go('word')}>close</button>
  </div>
</div>

<style>
  .note { color: var(--dimmer); font-style: italic; font-size: 0.9rem; margin: 0 0 1rem; }
  .bad { color: var(--bad); font-style: normal; }

  kbd {
    font-family: var(--font-label);
    font-style: normal;
    font-size: 0.85rem;
    color: var(--dim);
    border: 1px solid var(--rule);
    border-radius: 3px;
    padding: 0 0.35rem;
  }

  .new { display: flex; align-items: baseline; gap: 0.8rem; margin: 0.5rem 0 1.5rem; }
  .new input { flex: 1; width: auto; }

  .list {
    padding: 1.1rem 0 1.2rem;
    border-top: 1px solid var(--rule);
  }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
  .name {
    font-family: var(--font-head);
    font-size: 1.35rem;
    text-align: left;
    color: var(--fg);
  }
  .name:not(.fixed):hover { text-decoration: underline; text-decoration-color: var(--rule); text-underline-offset: 0.2em; }
  .rename { font-family: var(--font-head); font-size: 1.2rem; width: 100%; max-width: 24rem; }
  .count { color: var(--dimmer); font-size: 0.9rem; white-space: nowrap; }

  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem 1rem;
    margin: 0.35rem 0 0.2rem;
    font-family: var(--font-label);
    font-variant-caps: all-small-caps;
    letter-spacing: 0.05em;
  }
  .status { color: var(--ok); }
  .action { color: var(--dim); }
  .action:hover:not(:disabled) { color: var(--fg); }
  .action:disabled { opacity: 0.4; cursor: default; }
  .danger { color: var(--bad); }

  .url { color: var(--dimmer); margin: 0.2rem 0 0; overflow-wrap: anywhere; }

  .words {
    list-style: none;
    margin: 0.8rem 0 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1.1rem;
  }
  .words li { display: inline-flex; align-items: baseline; gap: 0.2rem; color: var(--dim); }
  .x { color: transparent; font-size: 0.9rem; padding: 0 0.15rem; transition: color 120ms ease; }
  .words li:hover .x, .x:focus-visible { color: var(--dimmer); }
  .x:hover { color: var(--bad) !important; }

  .inline {
    color: var(--dim);
    text-decoration: underline;
    text-decoration-color: var(--rule);
    text-underline-offset: 0.2em;
    margin-top: 0.4rem;
  }

  .close {
    margin-top: 2.5rem;
    color: var(--dim);
    font-family: var(--font-label);
    font-variant-caps: all-small-caps;
    font-size: 1.1rem;
    letter-spacing: 0.06em;
  }
  .close:hover { color: var(--fg); }
</style>
