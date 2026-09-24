<script lang="ts">
  /**
   * "Add this word to a list": a small panel beside the right rail rather
   * than a full page, because it is a two-second action taken in the middle
   * of a run. Number keys toggle the first nine lists; N starts a new one.
   */
  import { onMount } from 'svelte';
  import * as progress from '../lib/progress';
  import { back, go, ui } from '../lib/ui.svelte';
  import { hasWord, listWords } from '@shared/lists.js';

  const word = ui.pickerWord;
  let name = $state('');
  let input: HTMLInputElement;
  let flash = $state<string | null>(null);

  const lists = $derived.by(() => {
    void ui.revision;
    return progress.lists();
  });

  function toggle(id: string) {
    const list = progress.getList(id);
    if (!list) return;
    progress.setInList(id, word, !hasWord(list, word));
    flash = id;
  }

  function create() {
    const clean = name.trim();
    if (!clean) return;
    const list = progress.createList(clean);
    progress.setInList(list.id, word, true);
    flash = list.id;
    name = '';
    input.blur();
  }

  function onKey(event: KeyboardEvent) {
    if (event.target instanceof HTMLInputElement) {
      if (event.key === 'Escape') { input.blur(); event.preventDefault(); }
      return;
    }
    if (event.key === 'Escape' || event.key === 'ArrowLeft') { back(); return; }
    if (event.key === 'n' || event.key === 'N') { event.preventDefault(); input.focus(); return; }
    const n = Number(event.key);
    if (Number.isInteger(n) && n >= 1 && n <= 9 && lists[n - 1]) toggle(lists[n - 1].id);
  }

  onMount(() => {
    if (!word) back();
  });
</script>

<svelte:window onkeydown={onKey} />

<!-- Transparent catch area: a click outside the panel closes it. No scrim. -->
<button class="catch" aria-label="Close" onclick={back}></button>

<div class="panel" role="dialog" aria-label="Add to a list">
  <p class="title">Add <em>{word}</em> to…</p>

  <ul>
    {#each lists as list, i (list.id)}
      {@const on = hasWord(list, word)}
      <li>
        <button class="row" class:on aria-pressed={on} onclick={() => toggle(list.id)}>
          <span class="check" aria-hidden="true">{on ? '✓' : ''}</span>
          <span class="name">{list.name}</span>
          <span class="count num">{listWords(list).length}</span>
          {#if i < 9}<kbd>{i + 1}</kbd>{/if}
          {#if flash === list.id}
            {#key ui.revision}<span class="pulse" aria-hidden="true"></span>{/key}
          {/if}
        </button>
      </li>
    {/each}
  </ul>

  <form class="new" onsubmit={(e) => { e.preventDefault(); create(); }}>
    <input
      bind:this={input}
      bind:value={name}
      type="text"
      maxlength="80"
      placeholder="new list…"
      autocomplete="off"
      spellcheck="false"
    />
    <kbd>N</kbd>
  </form>

  <div class="foot">
    <button class="link" onclick={() => go('lists')}>manage lists</button>
    <button class="link" onclick={back}>done</button>
  </div>
</div>

<style>
  .catch {
    position: fixed;
    inset: 0;
    z-index: 19;
    cursor: default;
  }

  .panel {
    position: fixed;
    z-index: 20;
    right: calc(env(safe-area-inset-right, 0px) + 4.4rem);
    top: 50%;
    transform: translateY(-50%);
    width: min(21rem, calc(100vw - 2rem));
    max-height: 80vh;
    overflow-y: auto;
    padding: 1rem 1.1rem 0.8rem;
    background: var(--bg);
    border: 1px solid var(--rule);
    border-radius: 6px;
    animation: enter 140ms ease-out;
  }
  @keyframes enter {
    from { opacity: 0; transform: translate(6px, -50%); }
    to { opacity: 1; transform: translateY(-50%); }
  }
  @media (max-width: 34rem) {
    .panel { right: 1rem; left: 1rem; width: auto; }
  }

  .title { margin: 0 0 0.6rem; color: var(--dim); }
  .title em { font-family: var(--font-head); color: var(--fg); font-size: 1.15em; }

  ul { list-style: none; margin: 0; padding: 0; }

  .row {
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    width: 100%;
    padding: 0.4rem 0.45rem;
    border-radius: 4px;
    text-align: left;
    color: var(--dim);
    transition: color 120ms ease, background-color 120ms ease;
  }
  .row:hover { color: var(--fg); background: color-mix(in srgb, var(--fg) 5%, transparent); }
  .row.on { color: var(--fg); }
  .check { width: 1em; text-align: center; }
  .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .count { color: var(--dimmer); font-size: 0.88rem; }

  .pulse {
    position: absolute;
    inset: 0;
    background: var(--fg);
    pointer-events: none;
    animation: pulse 260ms ease-out forwards;
  }
  @keyframes pulse {
    from { opacity: 0.18; }
    to { opacity: 0; }
  }

  .new {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    margin-top: 0.6rem;
    padding: 0 0.45rem;
  }
  .new input { flex: 1; width: auto; }

  kbd {
    font-family: var(--font-label);
    font-size: 0.8rem;
    color: var(--dimmer);
    border: 1px solid var(--rule);
    border-radius: 3px;
    padding: 0 0.35rem;
  }

  .foot {
    display: flex;
    justify-content: space-between;
    margin-top: 0.9rem;
    padding: 0 0.45rem;
    font-family: var(--font-label);
    font-variant-caps: all-small-caps;
    letter-spacing: 0.05em;
  }
  .link { color: var(--dim); }
  .link:hover { color: var(--fg); }

  @media (prefers-reduced-motion: reduce) {
    .panel, .pulse { animation-duration: 1ms; }
  }
</style>
