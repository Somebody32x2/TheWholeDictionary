<script lang="ts">
  import * as corpus from '../lib/corpus';
  import * as progress from '../lib/progress';
  import { coverage, estimate } from '../lib/stats';
  import { ui, go, back } from '../lib/ui.svelte';
  import Back from './Back.svelte';
  import { BAND_COLOURS, BAND_LABELS, BANDS, SCALES } from '@shared/scales.js';

  let tiers = $state<Uint8Array>(new Uint8Array(0));

  const stats = $derived.by(() => {
    void ui.revision;
    const s = progress.snapshot();
    if (tiers.length !== s.wordCount) return null;
    return coverage(s.rating, tiers, s.settings.tierMax as number);
  });

  const strict = $derived(stats ? estimate(stats, false) : null);
  const generous = $derived(stats ? estimate(stats, true) : null);
  const tierMax = $derived(progress.snapshot().settings.tierMax as number);

  const pct = (n: number, total: number) => (total > 0 ? (n / total) * 100 : 0);
  const round = (n: number) => Math.round(n).toLocaleString();

  corpus.loadTiers().then((t) => { tiers = t; });
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' || (e.key === 'ArrowLeft' && !(e.target instanceof HTMLInputElement))) back(); }} />

<div class="overlay" role="dialog" tabindex="-1" aria-label="Dictionary coverage">
  <div class="sheet">
    <Back />
    <h1>Coverage</h1>

    {#if !stats}
      <p class="muted">loading…</p>
    {:else}
      <p class="muted small">
        {stats.total.toLocaleString()} words inside tier {tierMax}.
        {#if stats.outOfScopeAnswered > 0}
          {stats.outOfScopeAnswered.toLocaleString()} answers sit outside it and are kept but not counted.
        {/if}
      </p>

      <div class="bar" role="img" aria-label="Answer distribution">
        {#each BANDS as band (band)}
          {#if stats.bands[band] > 0}
            <span
              style:width="{pct(stats.bands[band], stats.total)}%"
              style:background={BAND_COLOURS[band]}
              title="{BAND_LABELS[band]}: {stats.bands[band].toLocaleString()}"
            ></span>
          {/if}
        {/each}
      </div>

      <table>
        <thead><tr><th>Band</th><th>Words</th><th>Share</th></tr></thead>
        <tbody>
          {#each BANDS as band (band)}
            <tr>
              <td><span class="swatch" style:background={BAND_COLOURS[band]}></span>{BAND_LABELS[band]}</td>
              <td>{stats.bands[band].toLocaleString()}</td>
              <td>{pct(stats.bands[band], stats.total).toFixed(2)}%</td>
            </tr>
          {/each}
        </tbody>
      </table>

      <h2>Vocabulary estimate</h2>
      <p class="muted small">
        Extrapolated from {strict!.rated.toLocaleString()} rated answers.
        “Seen” answers are excluded: they are not a claim to know anything.
      </p>
      {#if strict!.rated === 0}
        <p class="muted">Nothing rated yet.</p>
      {:else}
        <div class="figure">
          <span class="big num">{round(strict!.words)}</span>
          <span class="muted small">
            words known of {stats.total.toLocaleString()}
            &nbsp;·&nbsp; 95% CI {round(strict!.lowWords)}–{round(strict!.highWords)}
            &nbsp;·&nbsp; {(strict!.proportion * 100).toFixed(1)}% of those rated
          </span>
        </div>
        <div class="figure">
          <span class="big num">{round(generous!.words)}</span>
          <span class="muted small">
            counting “heard of” as known
            &nbsp;·&nbsp; 95% CI {round(generous!.lowWords)}–{round(generous!.highWords)}
          </span>
        </div>
      {/if}

      <h2>Where the answers came from</h2>
      <table>
        <thead><tr><th>Scale</th><th>Answers</th><th>Levels</th></tr></thead>
        <tbody>
          {#each Object.entries(stats.byScale) as [name, count] (name)}
            <tr>
              <td>{name}</td>
              <td>{count.toLocaleString()}</td>
              <td class="muted small">{SCALES[name as keyof typeof SCALES].levels.map((l) => l.label).join(' · ')}</td>
            </tr>
          {/each}
        </tbody>
      </table>

      <h2>Graded answers</h2>
      {#if stats.byScale.graded === 0}
        <p class="muted small">No answers were given on the graded scale.</p>
      {:else}
        <table>
          <thead><tr><th>Level</th><th>Answers</th><th>Share</th></tr></thead>
          <tbody>
            {#each SCALES.graded.levels as level, i (level.level)}
              <tr>
                <td>{level.level}. {level.label}</td>
                <td>{stats.gradedLevels[i].toLocaleString()}</td>
                <td>{pct(stats.gradedLevels[i], stats.byScale.graded).toFixed(1)}%</td>
              </tr>
            {/each}
          </tbody>
        </table>
        <p class="muted small">
          {stats.gradedExcluded.toLocaleString()} answers are excluded here because they
          were given on another scale.
        </p>
      {/if}

      <h2>By frequency tier</h2>
      <p class="muted small">
        SCOWL tiers: 35 is everyday English, 80 is the long tail. The shape of this
        curve is the most informative thing on the page.
      </p>
      <table>
        <thead>
          <tr><th>Tier</th><th>Words</th><th>Answered</th><th>Rated</th><th>Known</th><th>Known %</th></tr>
        </thead>
        <tbody>
          {#each stats.perTier as row (row.ceiling)}
            <tr>
              <td>≤{row.ceiling}</td>
              <td>{row.total.toLocaleString()}</td>
              <td>{row.answered.toLocaleString()}</td>
              <td>{row.rated.toLocaleString()}</td>
              <td>{row.known.toLocaleString()}</td>
              <td>{row.rated > 0 ? pct(row.known, row.rated).toFixed(1) + '%' : '—'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <div class="nav">
      <button class="link" onclick={() => go('timing')}>timing →</button>
      <button class="link" onclick={() => go('word')}>close</button>
    </div>
  </div>
</div>

<style>
  .small { font-size: 0.88rem; }
  .bar {
    display: flex;
    height: 10px;
    width: 100%;
    margin: 1.4rem 0;
    overflow: hidden;
  }
  .bar span { display: block; height: 100%; }

  .swatch {
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 0.5rem;
  }

  .figure { margin: 1.1rem 0; }
  .big {
    display: block;
    font-family: var(--font-head);
    font-size: 2.6rem;
    font-weight: 400;
    line-height: 1.1;
  }

  .nav {
    display: flex;
    justify-content: space-between;
    margin-top: 3rem;
  }
  .link { color: var(--accent); }
</style>
