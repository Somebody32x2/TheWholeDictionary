<script lang="ts">
  import { back } from '../lib/ui.svelte';
</script>

<!-- Shared by every overlay. Same action as Escape and the system back button. -->
<button class="back" onclick={back} title="Back (Esc)">
  <span aria-hidden="true">←</span> back
</button>

<style>
  .back {
    display: inline-flex;
    align-items: baseline;
    gap: 0.45rem;
    margin: 0 0 1.4rem;
    font-family: var(--font-label);
    font-variant-caps: all-small-caps;
    font-size: 1.05rem;
    letter-spacing: 0.06em;
    color: var(--dim);
    transition: color 120ms ease;
  }
  .back:hover, .back:focus-visible { color: var(--fg); }
  .back span { font-variant-caps: normal; transition: transform 120ms ease; }
  .back:hover span { transform: translateX(-3px); }
</style>
