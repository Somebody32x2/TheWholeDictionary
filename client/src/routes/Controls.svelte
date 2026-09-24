<script module lang="ts">
  export interface ControlItem {
    id: string;
    /** Key legend, e.g. "1" or "Space". Omitted on touch layouts. */
    key?: string;
    label: string;
    active: boolean;
  }
</script>

<script lang="ts">
  /**
   * The control strip under the word: one quiet box per action.
   *
   * Every box for the current scale stays mounted for the whole run; the
   * phase only changes which ones are `active`. That matters for the pulse -
   * a rating box flashes on the same frame the next word arrives, and if the
   * phase change unmounted it the flash would be cut off before it was seen.
   * It also means the strip never shifts under the user's eye between words.
   */

  const { items, pulseId, pulseTick, onpick }: {
    items: ControlItem[];
    pulseId: string | null;
    pulseTick: number;
    onpick: (id: string) => void;
  } = $props();
</script>

<div class="controls" role="group" aria-label="Controls">
  {#each items as item (item.id)}
    <button
      class="box"
      class:active={item.active}
      tabindex="-1"
      onclick={(e) => { e.stopPropagation(); onpick(item.id); }}
      onpointerdown={(e) => e.stopPropagation()}
      onpointerup={(e) => e.stopPropagation()}
    >
      {#if item.key}<span class="key">{item.key}</span>{/if}
      <span class="label">{item.label}</span>
      {#if pulseId === item.id}
        <!-- Re-keyed per trigger so pressing the same key twice replays it. -->
        {#key pulseTick}<span class="pulse" aria-hidden="true"></span>{/key}
      {/if}
    </button>
  {/each}
</div>

<style>
  .controls {
    position: fixed;
    left: 50%;
    bottom: calc(env(safe-area-inset-bottom, 0px) + 3.2rem);
    transform: translateX(-50%);
    z-index: 5;
    display: flex;
    gap: 0.5rem;
    max-width: calc(100vw - 2rem);
    flex-wrap: wrap;
    justify-content: center;
  }

  .box {
    position: relative;
    overflow: hidden;
    display: inline-flex;
    align-items: baseline;
    gap: 0.45rem;
    padding: 0.28rem 0.7rem 0.34rem;
    border: 1px solid var(--rule);
    border-radius: 4px;
    font-family: var(--font-label);
    font-variant-caps: all-small-caps;
    font-size: 1rem;
    letter-spacing: 0.05em;
    color: var(--dim);
    /* Inactive boxes recede rather than disappear: the next phase's
       controls are always visible, just quiet. */
    opacity: 0.32;
    transform: scale(0.97);
    transition: opacity 160ms ease, transform 160ms ease, color 160ms ease, border-color 160ms ease;
  }
  .box.active {
    opacity: 0.8;
    transform: none;
    color: var(--fg);
    border-color: color-mix(in srgb, var(--fg) 22%, transparent);
  }
  .box:hover { opacity: 1; }

  .key {
    font-variant-caps: normal;
    font-variant-numeric: lining-nums;
    color: var(--dimmer);
    font-size: 0.9em;
  }
  .box.active .key { color: var(--dim); }

  /* The trigger: a brief fill and a press, gone in a quarter second. */
  .pulse {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--fg);
    pointer-events: none;
    animation: pulse 260ms ease-out forwards;
  }
  @keyframes pulse {
    0% { opacity: 0.28; }
    100% { opacity: 0; }
  }
  .box:has(.pulse) { animation: press 200ms ease-out; }
  @keyframes press {
    0% { transform: scale(0.94); }
    100% { transform: none; }
  }

  /* On touch the boxes are the only way to grade, so they get real targets. */
  @media (pointer: coarse) {
    .controls { gap: 0.6rem; bottom: calc(env(safe-area-inset-bottom, 0px) + 3.6rem); }
    .box { padding: 0.6rem 1rem 0.66rem; font-size: 1.1rem; min-height: 2.75rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .pulse, .box:has(.pulse) { animation-duration: 1ms; }
  }
</style>
