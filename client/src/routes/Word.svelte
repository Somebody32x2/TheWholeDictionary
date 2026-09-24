<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  import * as corpus from '../lib/corpus';
  import * as progress from '../lib/progress';
  import * as sync from '../lib/sync';
  import { device } from '../lib/device';
  import { nextFrom, upcoming, type Order, type SequenceInput } from '../lib/sequence';
  import { prettyKey, resolveKey, slotsFor, SWIPE_MIN_PX } from '../lib/keys';
  import { ui, go } from '../lib/ui.svelte';
  import { SCALES, SCALE_SEEN, type ScaleName } from '@shared/scales.js';
  import Controls, { type ControlItem } from './Controls.svelte';

  /** Anything slower than this is not a response time, it is an interruption. */
  const CENSOR_AFTER_MS = 60_000;
  const FEEDBACK_MS = 80;
  const PREFETCH_AHEAD = 200;

  let entry = $state<corpus.WordEntry | null>(null);
  let position = $state(0);
  let exhausted = $state(false);
  let dip = $state(false);
  let revealed = $state(false);
  let showPercent = $state(false);
  let syncState = $state(sync.current());
  let pulseId = $state<string | null>(null);
  let pulseTick = $state(0);
  let starTick = $state(0);

  let unsubscribeSync: (() => void) | null = null;
  let shownAt = 0;
  /**
   * Time from the word appearing to the reveal, captured at the reveal.
   *
   * In the default reveal flow this *is* the response time: the recognition
   * decision happens while the headword stands alone, and everything after
   * the reveal is reading the definition, which says nothing about how well
   * the word was known.
   */
  let revealMs: number | null = null;
  /**
   * On a word reached by stepping back. It shows its definition straight away
   * and never auto-advances: the user came back on purpose, to look again or
   * to change the answer, and the timer would second-guess that.
   */
  let revisiting = false;
  /** Increments per word shown; guards a late frame from resetting a newer clock. */
  let showToken = 0;
  let advanceTimer: number | null = null;
  let dipTimer: number | null = null;
  let pointerStartX = 0;
  let pointerStartY = 0;

  const settings = $derived.by(() => {
    void ui.revision;
    return progress.snapshot().settings as {
      scale: ScaleName; order: Order; tierMax: number;
      skipAnswered: boolean; showDefinition: 'afterReveal' | 'always' | 'never'; randomSeed: number;
    };
  });

  const scale = $derived(settings.scale);
  const starred = $derived.by(() => {
    void ui.revision;
    return entry ? progress.isStarred(entry.word) : false;
  });
  const mode = $derived(settings.showDefinition);
  /** The word is up and its definition is not: the only input taken is "reveal". */
  const awaitingReveal = $derived(mode === 'afterReveal' && !revealed && entry !== null);

  let tiersArray = $state<Uint8Array>(new Uint8Array(0));

  const counts = $derived.by(() => {
    void ui.revision;
    const s = progress.snapshot();
    if (tiersArray.length !== s.wordCount) return { total: 0, answered: 0 };
    let total = 0;
    let answered = 0;
    for (let i = 0; i < s.wordCount; i++) {
      if (tiersArray[i] > settings.tierMax) continue;
      total++;
      if (s.rating[i] !== 0) answered++;
    }
    return { total, answered };
  });

  /**
   * The control strip. Rebuilt when the phase, scale or keymap changes; the
   * keymap lives in device settings, which only change behind the settings
   * overlay, so returning to this view is when it needs re-reading.
   */
  const controls = $derived.by((): ControlItem[] => {
    void ui.view;
    const { keymap, inputScheme } = device();
    const showKeys = inputScheme !== 'touch';
    const items: ControlItem[] = [];
    if (mode === 'afterReveal') {
      items.push({
        id: 'reveal',
        key: showKeys ? 'Space' : undefined,
        label: showKeys ? 'reveal' : 'tap to reveal',
        active: awaitingReveal,
      });
    }
    const slots = slotsFor(scale);
    SCALES[scale].levels.forEach((level, i) => {
      items.push({
        id: `level-${level.level}`,
        key: showKeys ? prettyKey(keymap[slots[i]][0] ?? '') : undefined,
        label: level.label,
        active: entry !== null && !awaitingReveal,
      });
    });
    return items;
  });

  function pulse(id: string) {
    pulseId = id;
    pulseTick++;
  }

  function input(): SequenceInput {
    const s = progress.snapshot();
    return {
      wordCount: s.wordCount,
      tiers: tiersArray,
      rating: s.rating,
      tierMax: settings.tierMax,
      skipAnswered: settings.skipAnswered,
      seed: settings.randomSeed,
    };
  }

  /**
   * Show the word at or after `from`.
   *
   * The clock starts synchronously and is then refined to the post-paint
   * timestamp once the frame actually lands. Starting it only inside
   * `requestAnimationFrame` was wrong: a browser that is not painting - a
   * backgrounded tab, a throttled one - never runs the callback, so the timer
   * was never armed and `shownAt` kept a stale value that the next answer
   * would then be measured against.
   *
   * The token guards the refinement: if the user has already moved on, a late
   * frame must not reset the clock for the word now on screen.
   */
  async function showFrom(from: number) {
    const found = nextFrom(input(), settings.order, from);
    if (!found) {
      exhausted = true;
      entry = null;
      return;
    }
    exhausted = false;
    position = found.position;
    revealed = mode === 'always';
    revealMs = null;
    revisiting = false;
    entry = await corpus.getWord(found.id);
    progress.setCursor(settings.order, position);
    corpus.prefetch(upcoming(input(), settings.order, position + 1, PREFETCH_AHEAD));

    const token = ++showToken;
    shownAt = performance.now();
    armAutoAdvance();
    requestAnimationFrame(() => {
      if (token === showToken) shownAt = performance.now();
    });
  }

  /** Runs only while a decision is pending: before the reveal, or for the whole word in the one-step modes. */
  function armAutoAdvance() {
    clearAdvance();
    if (revisiting) return;
    if (mode === 'afterReveal' && revealed) return;
    const ms = device().autoAdvanceMs;
    if (ms > 0) advanceTimer = self.setTimeout(timeout, ms);
  }

  function clearAdvance() {
    if (advanceTimer !== null) {
      self.clearTimeout(advanceTimer);
      advanceTimer = null;
    }
  }

  /**
   * The auto-advance timer expired with no input.
   *
   * Always recorded as `seen`, never as a level on the active scale: silence
   * is not a knowledge claim, and writing "know" or "don't know" here would
   * quietly manufacture the very data the app exists to measure.
   *
   * Refuses to fire behind an overlay. Reading the stats page is not the same
   * as declining to answer, and a timer left running there would chew through
   * the dictionary while nobody was looking at it.
   */
  function timeout() {
    if (!entry) return;
    if (ui.view !== 'word') { clearAdvance(); return; }
    commit(SCALE_SEEN, 1, device().autoAdvanceMs);
  }

  function reveal() {
    if (!awaitingReveal) return;
    revealMs = performance.now() - shownAt;
    revealed = true;
    clearAdvance();
    pulse('reveal');
  }

  function commit(scaleId: number, level: number, durOverride?: number) {
    if (!entry) return;
    clearAdvance();
    const elapsed = durOverride ?? revealMs ?? (performance.now() - shownAt);
    // "Peeked" means the definition was on screen while the timed decision was
    // being made - true only when it is shown alongside the word. In the reveal
    // flow the clock stops at the reveal, before the definition appears.
    progress.apply(entry.id, scaleId, level, elapsed > CENSOR_AFTER_MS ? 65535 : elapsed, mode === 'always', position);

    dip = true;
    if (dipTimer !== null) self.clearTimeout(dipTimer);
    dipTimer = self.setTimeout(() => { dip = false; }, FEEDBACK_MS);

    void showFrom(settings.skipAnswered ? position : position + 1);
  }

  /**
   * An answer input. Before the reveal it reveals instead of answering: the
   * rating is taken only once the definition is on screen, so the user can
   * check themselves against it.
   */
  function answer(level: number) {
    if (!entry) return;
    if (awaitingReveal) { reveal(); return; }
    pulse(`level-${level}`);
    commit(SCALES[scale].id, level);
  }

  /**
   * Put a specific word back on screen: the target of stepping back.
   *
   * It arrives revealed, with its original response time already captured,
   * so re-rating it keeps the time from the first viewing instead of billing
   * the user for the seconds spent deciding to go back.
   */
  async function showAt(id: number, at: number, durMs: number) {
    clearAdvance();
    exhausted = false;
    position = at;
    revisiting = true;
    revealed = mode !== 'never';
    revealMs = durMs;
    entry = await corpus.getWord(id);
    progress.setCursor(settings.order, position);
    shownAt = performance.now();
  }

  /** Left arrow / Backspace: return to the previous word, undoing its answer. */
  function stepBack() {
    const step = progress.undo();
    if (!step) return;
    void showAt(step.id, step.position, step.durMs);
  }

  /** Right arrow: replay the answer that was just undone, then move on. */
  function stepForward() {
    const step = progress.redo();
    if (!step) return;
    clearAdvance();
    dip = true;
    if (dipTimer !== null) self.clearTimeout(dipTimer);
    dipTimer = self.setTimeout(() => { dip = false; }, FEEDBACK_MS);
    void showFrom(settings.skipAnswered ? step.position : step.position + 1);
  }

  function onKeydown(event: KeyboardEvent) {
    if (ui.view !== 'word') return;
    if (event.target instanceof HTMLInputElement) return;
    const action = resolveKey(event, scale, device().keymap);
    if (!action) return;
    event.preventDefault();
    if (event.repeat) return;
    switch (action.kind) {
      case 'answer': answer(action.level); break;
      case 'undo': stepBack(); break;
      case 'redo': stepForward(); break;
      case 'reveal': reveal(); break;
      case 'star': toggleStar(); break;
      case 'lists': openPicker(); break;
      case 'settings': go('settings'); break;
      case 'stats': go('coverage'); break;
      case 'close': break;
    }
  }

  function toggleStar() {
    if (!entry) return;
    progress.toggleStar(entry.word);
    starTick++;
  }

  function openPicker() {
    if (!entry) return;
    ui.pickerWord = entry.word;
    go('picker');
  }

  function onPick(id: string) {
    if (id === 'reveal') reveal();
    else answer(Number(id.slice('level-'.length)));
  }

  function onPointerDown(event: PointerEvent) {
    pointerStartX = event.clientX;
    pointerStartY = event.clientY;
  }

  /**
   * A click or tap on the page itself.
   *
   * It reveals, and it answers only on the `seen` scale, where there is no
   * choice to make. Wherever a grade is required a stray click must not
   * record one - the answer comes from a key or a control box, both of which
   * say exactly what they will record.
   */
  function onPointerUp(event: PointerEvent) {
    if (!entry) return;
    const dx = event.clientX - pointerStartX;
    const dy = event.clientY - pointerStartY;
    const swipe = Math.abs(dx) > SWIPE_MIN_PX && Math.abs(dx) > Math.abs(dy) * 1.5;
    if (awaitingReveal) {
      if (!swipe) reveal();
      return;
    }
    // A deliberate horizontal swipe is still an answer on the two-level scale.
    if (swipe) {
      if (scale === 'binary') answer(dx > 0 ? 2 : 1);
      return;
    }
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12) return;
    if (scale === 'seen') answer(1);
  }

  onMount(async () => {
    tiersArray = await corpus.loadTiers();
    unsubscribeSync = sync.onChange((s) => { syncState = { ...s }; });
    addEventListener('keydown', onKeydown);
    progress.onReplaced(() => { void showFrom(progress.snapshot().cursor[settings.order]); });
    await showFrom(progress.snapshot().cursor[settings.order]);
  });

  onDestroy(() => {
    removeEventListener('keydown', onKeydown);
    clearAdvance();
    unsubscribeSync?.();
  });

  // Re-seat the run whenever the sequence or reveal settings change under it.
  let lastKey = '';
  $effect(() => {
    const key = `${settings.order}:${settings.tierMax}:${settings.skipAnswered}:${mode}`;
    if (!tiersArray.length || key === lastKey) return;
    const first = lastKey === '';
    lastKey = key;
    if (!first) void showFrom(progress.snapshot().cursor[settings.order]);
  });

  // Leaving the loop suspends the timer; coming back restarts the clock, so
  // time spent in settings is never billed to the word underneath.
  $effect(() => {
    if (ui.view !== 'word') {
      clearAdvance();
      return;
    }
    if (!entry || revisiting || !(awaitingReveal || mode !== 'afterReveal')) return;
    shownAt = performance.now();
    armAutoAdvance();
  });

  const syncColour = $derived({
    off: 'var(--dim)',
    pending: 'var(--warn)',
    synced: 'var(--ok)',
    error: 'var(--bad)',
  }[syncState.status]);
</script>

<main
  class="loop"
  onpointerdown={onPointerDown}
  onpointerup={onPointerUp}
>
  {#if exhausted}
    <p class="done muted">
      Nothing left inside this tier. Raise the tier ceiling or turn off
      “skip answered” in settings.
    </p>
  {:else if entry}
    <div class="word" class:dip>{entry.word}</div>
    <div class="defs" class:shown={revealed && mode !== 'never'} aria-live="polite">
      {#if revealed && mode !== 'never'}
        {#each entry.defs as def (def.pos)}
          <p><span class="pos">{def.pos}</span> {def.gloss}</p>
        {/each}
      {/if}
    </div>
  {/if}
</main>

{#if entry && !exhausted}
  <Controls items={controls} {pulseId} {pulseTick} onpick={onPick} />

  <!-- Right rail: keep the word. Outside <main> so a press never reads as a tap on the page. -->
  <div class="rail">
    <button
      class="rail-btn star"
      class:on={starred}
      aria-pressed={starred}
      onclick={toggleStar}
      title={starred ? 'Unstar (F)' : 'Star (F)'}
    >
      {#key starTick}<span class="glyph" class:pop={starTick > 0}>{starred ? '★' : '☆'}</span>{/key}
      <span class="cap">star</span>
    </button>
    <button class="rail-btn" onclick={openPicker} title="Add to a list (L)">
      <span class="glyph">+</span>
      <span class="cap">list</span>
    </button>
  </div>
{/if}

<button
  class="corner tl num"
  onclick={() => { showPercent = !showPercent; }}
  title="Words answered inside the current tier ceiling"
>
  {#if showPercent}
    {counts.total ? ((counts.answered / counts.total) * 100).toFixed(2) : '0.00'}%
  {:else}
    {counts.answered.toLocaleString()} / {counts.total.toLocaleString()}
  {/if}
</button>

<button class="corner tr" onclick={() => go('settings')} title="Settings (S)">settings</button>
<button class="corner bl" onclick={() => go('coverage')} title="Statistics (T)">stats</button>

<button
  class="corner br dot"
  onclick={() => go('account')}
  title={syncState.lastError ?? `sync: ${syncState.status}`}
>
  <span style:background={syncColour}></span>
</button>

<style>
  /*
   * Three rows with the headword in the middle one, so it sits at the exact
   * centre whether or not a definition is showing. Centring the whole stack
   * instead would shove the word upward on every reveal.
   */
  .loop {
    height: 100%;
    display: grid;
    grid-template-rows: 1fr auto 1fr;
    justify-items: center;
    /* Side padding clears the right rail, mirrored so the word stays centred. */
    padding: 4rem 4.2rem 6.5rem;
    text-align: center;
    touch-action: manipulation;
  }

  .word {
    grid-row: 2;
    font-family: var(--font-head);
    font-size: clamp(2rem, 9vw, 5.5rem);
    /* 400, not 300: a serif at display size has no thin cut in a system
       stack, and faking one with a lighter weight just picks a fallback. */
    font-weight: 400;
    letter-spacing: -0.005em;
    color: var(--fg);
    line-height: 1.05;
    transition: opacity 80ms linear;
    overflow-wrap: anywhere;
  }
  /* The entire response animation. Enough to register, too short to wait for. */
  .word.dip { opacity: 0.25; }

  .defs {
    grid-row: 3;
    align-self: start;
    margin-top: 1.4rem;
    font-family: var(--font-text);
    max-width: 34rem;
    color: var(--dim);
    font-size: 1.05rem;
    line-height: 1.55;
    text-align: left;
    opacity: 0;
    transform: translateY(-3px);
  }
  .defs.shown {
    opacity: 1;
    transform: none;
    transition: opacity 160ms ease, transform 160ms ease;
  }
  .defs p { margin: 0.5rem 0; }
  /* The part-of-speech tag is italic in every printed dictionary. */
  .pos {
    font-family: var(--font-label);
    font-style: italic;
    color: var(--dimmer);
    margin-right: 0.45rem;
  }

  .done { grid-row: 2; max-width: 26rem; }

  .rail {
    position: fixed;
    right: calc(env(safe-area-inset-right, 0px) + 0.9rem);
    top: 50%;
    transform: translateY(-50%);
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .rail-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.1rem;
    min-width: 2.6rem;
    padding: 0.35rem 0.3rem;
    color: var(--dim);
    opacity: var(--corner-rest);
    transition: opacity 120ms ease, color 120ms ease;
  }
  .rail-btn:hover, .rail-btn:focus-visible { opacity: 1; color: var(--fg); }
  .glyph {
    display: block;
    font-family: var(--font-head);
    font-size: 1.6rem;
    line-height: 1;
  }
  .cap {
    font-family: var(--font-label);
    font-variant-caps: all-small-caps;
    font-size: 0.9rem;
    letter-spacing: 0.06em;
  }
  /* A starred word is the one mark of colour on the screen. */
  .star.on { opacity: 1; color: var(--warn); }
  .glyph.pop { animation: pop 220ms ease-out; }
  @keyframes pop {
    0% { transform: scale(1.35); }
    100% { transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .glyph.pop { animation: none; }
  }

  .dot span {
    display: block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
</style>
