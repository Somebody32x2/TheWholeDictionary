<script lang="ts">
  import { onMount } from 'svelte';
  import * as progress from '../lib/progress';
  import * as corpus from '../lib/corpus';
  import * as db from '../lib/db';
  import { device, saveDevice, DEFAULT_KEYMAP, type DeviceSettings, type Keymap, type Theme } from '../lib/device';
  import { prettyKey, slotsFor } from '../lib/keys';
  import { gzip, gunzip } from '../lib/gzip';
  import { ui, go, showToast, back } from '../lib/ui.svelte';
  import Back from './Back.svelte';
  import { decodeSnapshot, encodeSnapshot } from '@shared/container.js';
  import { mergeSnapshots } from '@shared/merge.js';
  import { BAND_COLOURS, SCALES, SCALE_NAMES, type ScaleName } from '@shared/scales.js';
  import { TIER_CEILINGS } from '../lib/stats';

  const { onTheme }: { onTheme: (theme: string) => void } = $props();

  const settings = $derived.by(() => {
    void ui.revision;
    return progress.snapshot().settings as Record<string, unknown>;
  });

  let dev = $state(device());
  let capturing = $state<keyof Keymap | null>(null);
  let captureError = $state('');
  let fileInput: HTMLInputElement;

  function set(key: string, value: unknown) {
    progress.setSetting(key, value);
  }

  async function setDevice(patch: Partial<DeviceSettings>) {
    dev = await saveDevice(patch);
    if (patch.theme) onTheme(patch.theme);
  }

  /**
   * Capture the next keypress for a keymap row.
   *
   * Conflicts are refused rather than silently stolen: two actions on one key
   * in the core loop means an answer the user did not intend, recorded
   * permanently, and there is no way to notice it happened.
   */
  function onCapture(event: KeyboardEvent) {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') { capturing = null; captureError = ''; return; }

    const key = event.key === ' ' ? ' ' : event.key;
    const normalised = key.length === 1 ? key.toLowerCase() : key;
    if (['Backspace', 'ArrowLeft', 'ArrowRight', '/', '?'].includes(normalised)) {
      captureError = `${prettyKey(normalised)} is reserved for back, forward and reveal.`;
      return;
    }
    // Only the active scale's slots can collide: the same number legitimately
    // means level 1 on every scale, and only one scale is live at a time.
    for (const slot of slotsFor(settings.scale as ScaleName)) {
      if (slot !== capturing && dev.keymap[slot].includes(normalised)) {
        captureError = `${prettyKey(normalised)} is already bound on this scale.`;
        return;
      }
    }
    captureError = '';
    const slot = capturing;
    capturing = null;
    void setDevice({ keymap: { ...dev.keymap, [slot]: [normalised] } });
  }

  async function exportSnapshot() {
    const state = progress.snapshot();
    const bytes = await gzip(encodeSnapshot(state));
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/gzip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `thewholedictionary-${state.corpusVersion}-${stamp}.twd`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Import merges rather than replaces.
   *
   * Importing another device's export is exactly the same operation as
   * syncing with it, so it uses exactly the same join - there is no path in
   * this app where loading a file can destroy answers.
   */
  async function importSnapshot(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      const incoming = decodeSnapshot(await gunzip(new Uint8Array(await file.arrayBuffer())));
      const local = progress.snapshot();
      if (incoming.corpusVersion !== local.corpusVersion) {
        showToast(`That file is for dictionary ${incoming.corpusVersion}; this device has ${local.corpusVersion}.`, 8000);
        return;
      }
      const merged = mergeSnapshots(local, incoming);
      await progress.replace(merged.state);
      ui.revision++;
      showToast(`Imported: ${merged.changedFromA.toLocaleString()} words updated.`);
    } catch (err) {
      showToast(`Import failed: ${(err as Error).message}`, 8000);
    } finally {
      (event.target as HTMLInputElement).value = '';
    }
  }

  async function resetEverything() {
    if (!confirm('Erase every answer on this device? This cannot be undone.')) return;
    await db.clearAll();
    location.reload();
  }

  function onWindowKey(event: KeyboardEvent) {
    if (capturing) return onCapture(event);
    if (event.key === 'Escape') back();
    else if (event.key === 'ArrowLeft' && !(event.target instanceof HTMLInputElement)) back();
  }

  const manifest = corpus.currentManifest();

  /**
   * What each ceiling means, in words. SCOWL's own descriptions are
   * spell-checker jargon ("size 70"), which is useless for deciding how far
   * into the dictionary you want to go.
   */
  const TIER_INFO: Record<number, string> = {
    35: 'everyday words nearly everyone knows',
    50: 'common in books and newspapers',
    60: 'found in any standard desk dictionary',
    70: 'large-dictionary words: literary, specialist',
    80: 'the long tail: rare, technical, regional, archaic',
  };

  /** Words available at each ceiling, cumulative, from the manifest. */
  const tierTotals = TIER_CEILINGS.map((ceiling) => Object.entries(manifest.tierCounts)
    .filter(([tier]) => Number(tier) <= ceiling)
    .reduce((sum, [, count]) => sum + count, 0));

  /**
   * A few real words from each band, so the choice is concrete. Picked at even
   * spacing through the band's alphabetical run for variety, and restricted to
   * plain 5-10 letter words so an example is never an abbreviation fragment.
   * Absent until the cached headword index is available.
   */
  let examples = $state<Record<number, string[]>>({});

  onMount(async () => {
    const [tiers, words] = await Promise.all([corpus.loadTiers(), corpus.indexWords()]);
    if (!words) return;
    const picked: Record<number, string[]> = {};
    let lower = 0;
    for (const ceiling of TIER_CEILINGS) {
      const band: string[] = [];
      for (let i = 0; i < tiers.length; i++) {
        if (tiers[i] > lower && tiers[i] <= ceiling && /^[a-z]{5,10}$/.test(words[i])) band.push(words[i]);
      }
      picked[ceiling] = band.length
        ? [0, 1, 2, 3].map((k) => band[Math.floor(((k + 0.5) / 4) * band.length)])
        : [];
      lower = ceiling;
    }
    examples = picked;
  });
</script>

<div class="overlay" role="dialog" tabindex="-1" aria-label="Settings">
  <div class="sheet">
    <Back />
    <h1>Settings</h1>

    <h2>Rating</h2>
    <p class="note">
      The scale is recorded with every answer, so changing it never reinterprets
      what you already rated.
    </p>
    {#each SCALE_NAMES as name (name)}
      <button
        class="scale"
        aria-pressed={settings.scale === name}
        onclick={() => set('scale', name)}
      >
        <span class="scale-name">{name}</span>
        <span class="ladder">
          {#each SCALES[name as ScaleName].levels as level, i (level.level)}
            <span class="level" style:--band={BAND_COLOURS[level.band]}>
              <kbd>{prettyKey(dev.keymap[slotsFor(name as ScaleName)[i]][0])}</kbd>{level.label}
            </span>
          {/each}
        </span>
      </button>
    {/each}

    <h2>Input</h2>
    <div class="row">
      <span>Scheme</span>
      <span class="choice">
        {#each ['keys', 'touch', 'auto'] as scheme (scheme)}
          <button
            aria-pressed={dev.inputScheme === scheme}
            onclick={() => setDevice({ inputScheme: scheme as 'keys' | 'touch' | 'auto' })}
          >{scheme}</button>
        {/each}
      </span>
    </div>
    <div class="row">
      <span>
        Auto-advance
        <span class="note">milliseconds, 0 is off; a timeout records “seen”, never a level</span>
      </span>
      <input
        type="number" min="0" max="20000" step="100"
        value={dev.autoAdvanceMs}
        onchange={(e) => setDevice({ autoAdvanceMs: Number((e.target as HTMLInputElement).value) })}
      />
    </div>

    <table>
      <thead><tr><th>Answer</th><th>Keys</th><th></th></tr></thead>
      <tbody>
        {#each slotsFor(settings.scale as ScaleName) as slot, i (slot)}
          <tr>
            <td>{SCALES[settings.scale as ScaleName].levels[i].label}</td>
            <td>{#each dev.keymap[slot] as key (key)}<kbd>{prettyKey(key)}</kbd>{/each}</td>
            <td>
              <button
                class="link"
                onclick={() => { capturing = slot; captureError = ''; }}
              >{capturing === slot ? 'press a key…' : 'change'}</button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
    <p class="note">
      <kbd>Space</kbd> reveals the definition. <kbd>←</kbd> goes back to the previous
      word, <kbd>→</kbd> restores what was undone. <kbd>F</kbd> stars the word,
      <kbd>L</kbd> adds it to a list.
    </p>
    {#if captureError}<p class="note warn">{captureError}</p>{/if}
    <button class="link" onclick={() => setDevice({ keymap: structuredClone(DEFAULT_KEYMAP) })}>
      reset keys
    </button>

    <h2>Sequence</h2>
    <div class="row">
      <span>Order</span>
      <span class="choice">
        {#each ['alphabetical', 'random'] as order (order)}
          <button aria-pressed={settings.order === order} onclick={() => set('order', order)}>{order}</button>
        {/each}
      </span>
    </div>
    <div class="row">
      <span>Skip answered</span>
      <span class="choice">
        <button aria-pressed={settings.skipAnswered === true} onclick={() => set('skipAnswered', true)}>on</button>
        <button aria-pressed={settings.skipAnswered === false} onclick={() => set('skipAnswered', false)}>off</button>
      </span>
    </div>

    <h3>How deep to go</h3>
    <p class="note">
      Every headword carries a frequency tier from SCOWL, the word lists behind
      most English spell-checkers. Low tiers are words you meet constantly; each
      step up adds rarer ones. The ceiling decides how far down that list your
      run goes, and what the coverage figures are measured against. Raising or
      lowering it never deletes an answer - words above the ceiling are simply
      set aside until you include them again.
    </p>
    <table class="tiers">
      <thead><tr><th>Ceiling</th><th>What it adds</th><th>Words</th></tr></thead>
      <tbody>
        {#each TIER_CEILINGS as ceiling, i (ceiling)}
          <tr
            class:current={settings.tierMax === ceiling}
            onclick={() => set('tierMax', ceiling)}
          >
            <td>
              <button class="tier-pick" aria-pressed={settings.tierMax === ceiling}>
                <span class="num">{ceiling}</span>
              </button>
            </td>
            <td>
              {TIER_INFO[ceiling]}
              {#if examples[ceiling]?.length}
                <span class="examples">{examples[ceiling].join(', ')}</span>
              {/if}
            </td>
            <td class="num">{tierTotals[i].toLocaleString()}</td>
          </tr>
        {/each}
      </tbody>
    </table>

    <h2>Display</h2>
    <div class="row">
      <span>Theme</span>
      <span class="choice">
        {#each ['system', 'dark', 'light'] as theme (theme)}
          <button aria-pressed={dev.theme === theme} onclick={() => setDevice({ theme: theme as Theme })}>
            {theme}
          </button>
        {/each}
      </span>
    </div>
    <div class="row">
      <span>
        Definitions
        <span class="note">“after reveal” shows the word alone, then its definition, then asks</span>
      </span>
      <span class="choice">
        {#each [['afterReveal', 'after reveal'], ['always', 'with the word'], ['never', 'never']] as [mode, label] (mode)}
          <button aria-pressed={settings.showDefinition === mode} onclick={() => set('showDefinition', mode)}>
            {label}
          </button>
        {/each}
      </span>
    </div>

    <h2>Projection</h2>
    <div class="row">
      <span>Minutes per day <span class="note">used for completion dates</span></span>
      <input
        type="number" min="1" max="600"
        value={settings.dailyMinutes}
        onchange={(e) => set('dailyMinutes', Number((e.target as HTMLInputElement).value))}
      />
    </div>

    <h2>Account</h2>
    <div class="row">
      <span>Sync across devices</span>
      <button class="link" onclick={() => go('account')}>open account</button>
    </div>
    <div class="row">
      <span>Starred words and saved lists <span class="note">publish a list to share it by link</span></span>
      <button class="link" onclick={() => go('lists')}>open lists</button>
    </div>

    <h2>Data</h2>
    <div class="row">
      <span>Snapshot file <span class="note">importing merges, it never overwrites</span></span>
      <span class="choice">
        <button onclick={exportSnapshot}>export</button>
        <button onclick={() => fileInput.click()}>import</button>
      </span>
    </div>
    <input
      class="hidden" type="file" accept=".twd,application/gzip"
      bind:this={fileInput} onchange={importSnapshot}
    />
    <div class="row">
      <span>Erase everything on this device</span>
      <button class="link danger" onclick={resetEverything}>reset</button>
    </div>

    <h2>Data sources</h2>
    <p class="note">
      <span class="num">{manifest.wordCount.toLocaleString()}</span> headwords, dictionary
      <span class="mono">{manifest.corpusVersion}</span>, built {manifest.builtAt.slice(0, 10)}.
      Definitions from
      <a href="https://en.wiktionary.org/" target="_blank" rel="noreferrer">Wiktionary</a>
      under
      <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">CC BY-SA 4.0</a>;
      headwords and frequency tiers from
      <a href="http://wordlist.aspell.net/" target="_blank" rel="noreferrer">SCOWL 2020.12.07</a>.
      Passphrase words from the
      <a href="https://www.eff.org/dice" target="_blank" rel="noreferrer">EFF Long Wordlist</a>
      (CC BY 3.0 US). Full notices in
      <a href="{import.meta.env.BASE_URL}corpus/ATTRIBUTION.txt" target="_blank" rel="noreferrer">ATTRIBUTION.txt</a>.
    </p>

    <button class="close" onclick={() => go('word')}>close</button>
  </div>
</div>

<svelte:window onkeydown={onWindowKey} />

<style>
  .hidden { display: none; }

  /* Section heads with a faint hairline: structure without colour. */
  h2 {
    display: flex;
    align-items: center;
    gap: 0.8rem;
  }
  h2::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--rule);
  }
  h3 {
    font-family: var(--font-head);
    font-weight: 400;
    font-size: 1.1rem;
    margin: 1.6rem 0 0.4rem;
  }

  .note {
    display: block;
    color: var(--dimmer);
    font-size: 0.88rem;
    font-style: italic;
    line-height: 1.5;
    margin: 0.15rem 0 0.4rem;
  }
  p.note { margin: 0.2rem 0 0.8rem; }
  .warn { color: var(--bad); font-style: normal; }

  .scale {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.4rem 1rem;
    width: 100%;
    text-align: left;
    padding: 0.65rem 0.8rem;
    margin: 0.2rem 0;
    border-left: 1px solid var(--rule);
    color: var(--dim);
    transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
  }
  .scale:hover { color: var(--fg); }
  .scale[aria-pressed='true'] {
    color: var(--fg);
    border-left-color: var(--fg);
    background: color-mix(in srgb, var(--fg) 5%, transparent);
  }
  .scale-name {
    font-family: var(--font-head);
    font-size: 1.2rem;
    width: 5.5rem;
  }
  .ladder { display: flex; flex-wrap: wrap; gap: 0.35rem 1rem; }

  /* The only colour on the page: a small dot in the level's reporting band,
     the same one the coverage bar uses, so a level is recognisable there. */
  .level {
    display: inline-flex;
    align-items: baseline;
    gap: 0.35rem;
    font-style: italic;
  }
  .level::after {
    content: '';
    align-self: center;
    width: 0.4em;
    height: 0.4em;
    border-radius: 50%;
    background: var(--band);
    opacity: 0.85;
  }

  kbd {
    display: inline-block;
    min-width: 1.6em;
    margin: 0 0.3rem 0 0;
    padding: 0 0.4rem 0.08rem;
    border: 1px solid var(--rule);
    border-radius: 3px;
    font-family: var(--font-label);
    font-style: normal;
    font-size: 0.85rem;
    text-align: center;
    color: var(--dim);
  }

  .tiers tr { cursor: pointer; }
  .tiers td { vertical-align: baseline; color: var(--dim); transition: color 120ms ease; }
  .tiers td:nth-child(2), .tiers th:nth-child(2) { text-align: left; padding-left: 0.8rem; }
  .tiers tr:hover td, .tiers tr.current td { color: var(--fg); }
  .tier-pick {
    min-width: 2.6rem;
    padding: 0.15rem 0.5rem;
    border: 1px solid var(--rule);
    border-radius: 3px;
    color: inherit;
  }
  .tier-pick[aria-pressed='true'] {
    border-color: var(--fg);
    background: color-mix(in srgb, var(--fg) 7%, transparent);
  }
  .examples {
    display: block;
    color: var(--dimmer);
    font-style: italic;
    font-size: 0.88rem;
  }

  .link {
    color: var(--fg);
    text-decoration: underline;
    text-decoration-color: var(--rule);
    text-underline-offset: 0.2em;
  }
  .link:hover { text-decoration-color: var(--fg); }
  .danger { color: var(--bad); }

  .close {
    margin-top: 3.5rem;
    color: var(--dim);
    font-family: var(--font-label);
    font-variant-caps: all-small-caps;
    font-size: 1.1rem;
    letter-spacing: 0.06em;
  }
  .close:hover { color: var(--fg); }
</style>
