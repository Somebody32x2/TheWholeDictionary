<script lang="ts">
  import * as corpus from '../lib/corpus';
  import * as progress from '../lib/progress';
  import { recentAnswers } from '../lib/device';
  import { remainingCount } from '../lib/sequence';
  import { paceByDay, projections, timing } from '../lib/stats';
  import { ui, go, back } from '../lib/ui.svelte';
  import Back from './Back.svelte';

  const PACE_DAYS = 14;

  let tiers = $state<Uint8Array>(new Uint8Array(0));
  let excludePeeked = $state(true);
  let slowestWord = $state('');

  const stats = $derived.by(() => {
    void ui.revision;
    const s = progress.snapshot();
    if (tiers.length !== s.wordCount) return null;
    return timing({
      rating: s.rating,
      durMs: s.durMs,
      flags: s.flags,
      tiers,
      tierMax: s.settings.tierMax as number,
      excludePeeked,
    });
  });

  const remaining = $derived.by(() => {
    void ui.revision;
    const s = progress.snapshot();
    if (tiers.length !== s.wordCount) return 0;
    return remainingCount({
      wordCount: s.wordCount,
      tiers,
      rating: s.rating,
      tierMax: s.settings.tierMax as number,
      skipAnswered: true,
      seed: s.settings.randomSeed as number,
    });
  });

  const days = $derived.by(() => {
    void ui.revision;
    return paceByDay(progress.snapshot().answeredAt, PACE_DAYS);
  });

  const recentMean = $derived.by(() => {
    void ui.revision;
    const entries = recentAnswers();
    if (entries.length === 0) return 0;
    let total = 0;
    for (const entry of entries) total += entry.durMs;
    return total / entries.length;
  });

  const forecasts = $derived.by(() => {
    if (!stats || stats.count === 0) return [];
    const observed = days.reduce((sum, d) => sum + d.count, 0) / PACE_DAYS;
    return projections({
      remaining,
      overallMeanMs: stats.mean,
      recentMeanMs: recentMean,
      dailyMinutes: progress.snapshot().settings.dailyMinutes as number,
      observedPerDay: observed,
    });
  });

  const maxBucket = $derived(stats ? Math.max(1, ...stats.buckets.map((b) => b.count)) : 1);
  const maxDay = $derived(Math.max(1, ...days.map((d) => d.count)));

  function ms(value: number): string {
    if (value >= 10_000) return `${(value / 1000).toFixed(1)} s`;
    if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
    return `${Math.round(value)} ms`;
  }

  function duration(total: number): string {
    const hours = total / 3_600_000;
    if (hours >= 24) return `${(hours / 24).toFixed(1)} days`;
    if (hours >= 1) return `${hours.toFixed(1)} hours`;
    return `${(total / 60_000).toFixed(1)} minutes`;
  }

  const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

  corpus.loadTiers().then((t) => { tiers = t; });

  // The slowest word lives in a shard that may not be resident; fetch it.
  $effect(() => {
    const id = stats?.slowestId ?? -1;
    if (id < 0) { slowestWord = ''; return; }
    let cancelled = false;
    corpus.getWord(id).then((entry) => { if (!cancelled) slowestWord = entry.word; }).catch(() => {});
    return () => { cancelled = true; };
  });
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' || (e.key === 'ArrowLeft' && !(e.target instanceof HTMLInputElement))) back(); }} />

<div class="overlay" role="dialog" tabindex="-1" aria-label="Timing analytics">
  <div class="sheet">
    <Back />
    <h1>Timing</h1>

    {#if !stats}
      <p class="muted">loading…</p>
    {:else if stats.count === 0}
      <p class="muted">No timed answers yet.</p>
    {:else}
      <div class="row">
        <span class="muted small">
          {stats.count.toLocaleString()} timed answers
          {#if stats.censored > 0}· {stats.censored.toLocaleString()} censored at 65 s{/if}
          {#if stats.peekedExcluded > 0}· {stats.peekedExcluded.toLocaleString()} peeked, excluded{/if}
        </span>
        <button class="link" onclick={() => { excludePeeked = !excludePeeked; }}>
          {excludePeeked ? 'include peeked' : 'exclude peeked'}
        </button>
      </div>

      <p class="muted small">
        Response time runs from the word appearing to the moment you reveal it, before
        the definition is shown. When definitions are shown with the word, or not at
        all, it runs to the answer instead; answers given with the definition visible
        count as peeked.
      </p>

      <table>
        <tbody>
          <tr><td>mean</td><td>{ms(stats.mean)}</td></tr>
          <tr><td>median</td><td>{ms(stats.median)}</td></tr>
          <tr><td>σ</td><td>{ms(stats.sd)}</td></tr>
          <tr><td>p10 – p90</td><td>{ms(stats.p10)} – {ms(stats.p90)}</td></tr>
          <tr><td>fastest</td><td>{ms(stats.min)}</td></tr>
          <tr>
            <td>slowest</td>
            <td>{ms(stats.max)}{#if slowestWord}&nbsp;<span class="muted">“{slowestWord}”</span>{/if}</td>
          </tr>
          <tr><td>total time</td><td>{duration(stats.totalMs)}</td></tr>
        </tbody>
      </table>

      <h2>Response time distribution</h2>
      <svg viewBox="0 0 {stats.buckets.length * 40} 120" class="chart" role="img" aria-label="Response time histogram">
        {#each stats.buckets as bucket, i (bucket.upto)}
          <rect
            x={i * 40 + 6} width="28"
            y={100 - (bucket.count / maxBucket) * 90}
            height={(bucket.count / maxBucket) * 90}
            fill="var(--dim)"
          />
          <text x={i * 40 + 20} y="114" text-anchor="middle" font-size="10" fill="var(--dim)" font-family="var(--font-label)">
            {bucket.upto >= 65535 ? '65s+' : bucket.upto >= 1000 ? `${bucket.upto / 1000}s` : `${bucket.upto}`}
          </text>
        {/each}
      </svg>

      <h2>Recent pace</h2>
      <svg viewBox="0 0 {days.length * 24} 90" class="chart" role="img" aria-label="Answers per day">
        {#each days as day, i (day.day)}
          <rect
            x={i * 24 + 4} width="16"
            y={70 - (day.count / maxDay) * 62}
            height={(day.count / maxDay) * 62}
            fill="var(--dim)"
          />
          <text x={i * 24 + 12} y="84" text-anchor="middle" font-size="9" fill="var(--dim)" font-family="var(--font-label)">
            {day.day.slice(8)}
          </text>
        {/each}
      </svg>
      <p class="muted small">
        {days.reduce((sum, d) => sum + d.count, 0).toLocaleString()} answers in the last {PACE_DAYS} days.
      </p>

      <h2>Projections</h2>
      <p class="muted small">
        {remaining.toLocaleString()} words left inside the current tier ceiling.
        Each row states the rate it assumes; they disagree, which is the point.
      </p>
      <table>
        <thead><tr><th>Assumption</th><th>Work left</th><th>Finishes</th></tr></thead>
        <tbody>
          {#each forecasts as forecast (forecast.label)}
            <tr>
              <td>
                {forecast.label}
                <div class="muted small">{forecast.note}</div>
              </td>
              <td>{forecast.msPerWord > 0 ? duration(forecast.totalMs) : '—'}</td>
              <td>{forecast.date ? dateFmt.format(forecast.date) : '—'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}

    <div class="nav">
      <button class="link" onclick={() => go('coverage')}>← coverage</button>
      <button class="link" onclick={() => go('word')}>close</button>
    </div>
  </div>
</div>

<style>
  .small { font-size: 0.88rem; }
  .chart { width: 100%; height: auto; margin: 1rem 0; }
  .nav { display: flex; justify-content: space-between; margin-top: 3rem; }
  .link { color: var(--accent); }
</style>
