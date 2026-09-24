<script lang="ts">
  import * as sync from '../lib/sync';
  import { onDestroy } from 'svelte';
  import { go, showToast, back } from '../lib/ui.svelte';
  import Back from './Back.svelte';

  let account = $state(sync.current());
  let created = $state('');
  let entry = $state('');
  let busy = $state(false);
  let error = $state('');

  const unsubscribe = sync.onChange((s) => { account = { ...s }; });
  onDestroy(unsubscribe);

  async function create() {
    busy = true;
    error = '';
    try {
      created = await sync.createAccount();
    } catch (err) {
      error = String((err as Error).message ?? err);
    } finally {
      busy = false;
    }
  }

  async function signIn() {
    busy = true;
    error = '';
    try {
      await sync.signIn(entry);
      entry = '';
      showToast('Signed in. Merging…');
    } catch (err) {
      error = String((err as Error).message ?? err);
    } finally {
      busy = false;
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(created || account.key || '');
      showToast('Copied.');
    } catch {
      showToast('Copy failed - select the words and copy them by hand.');
    }
  }

  async function forget() {
    if (!confirm('Sign out on this device? Your answers stay here; the phrase is the only way back to the server copy.')) return;
    await sync.signOut();
    created = '';
  }

  async function destroy() {
    if (!confirm('Delete the server copy? Answers on this device are untouched, but no other device will be able to reach them again.')) return;
    busy = true;
    try {
      await sync.deleteRemote();
      created = '';
      showToast('Server copy deleted.');
    } catch (err) {
      error = String((err as Error).message ?? err);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' || (e.key === 'ArrowLeft' && !(e.target instanceof HTMLInputElement))) back(); }} />

<div class="overlay" role="dialog" tabindex="-1" aria-label="Account">
  <div class="sheet">
    <Back />
    <h1>Account</h1>

    <p class="muted small">
      Syncing is optional. Everything works offline with no account at all; an
      account only lets a second device join the same progress. There is no
      email, no password and no recovery: four words are the whole credential.
    </p>

    {#if created}
      <h2>Your phrase</h2>
      <p class="phrase">{created}</p>
      <p class="muted small">
        Write this down now. It is shown once, it is the only credential, and it
        cannot be recovered - the server stores a one-way hash of it and has no
        other way to identify you.
      </p>
      <button class="link" onclick={copy}>copy</button>
    {:else if account.key}
      <h2>Signed in</h2>
      <p class="phrase">{account.key}</p>
      <div class="row">
        <span class="muted small">
          status: {account.status}
          {#if account.rev}· revision {account.rev}{/if}
          {#if account.lastSyncedAt}· last synced {new Date(account.lastSyncedAt).toLocaleTimeString()}{/if}
        </span>
        <span class="choice">
          <button onclick={() => sync.checkRemote(true)}>sync now</button>
          <button onclick={copy}>copy</button>
        </span>
      </div>
      {#if account.lastError}<p class="muted small bad">{account.lastError}</p>{/if}
      <div class="row">
        <span>Stop syncing on this device</span>
        <button class="link" onclick={forget}>sign out</button>
      </div>
      <div class="row">
        <span>Delete the server copy</span>
        <button class="link bad" onclick={destroy}>delete</button>
      </div>
    {:else}
      <h2>Create an account</h2>
      <p class="muted small">The server generates the phrase; you cannot choose it.</p>
      <button class="link" disabled={busy} onclick={create}>create account</button>

      <h2>Or sign in</h2>
      <input
        type="text" placeholder="four words" autocomplete="off"
        autocapitalize="none" spellcheck="false"
        bind:value={entry}
        onkeydown={(e) => { if (e.key === 'Enter') signIn(); }}
      />
      <button class="link" disabled={busy || !entry.trim()} onclick={signIn}>sign in</button>
    {/if}

    {#if error}<p class="bad small">{error}</p>{/if}

    <button class="close" onclick={() => go('word')}>close</button>
  </div>
</div>

<style>
  .small { font-size: 0.88rem; }
  .bad { color: var(--bad); }
  .phrase {
    font-family: var(--font-head);
    font-style: italic;
    font-size: 1.9rem;
    color: var(--fg);
    letter-spacing: 0.01em;
    margin: 0.8rem 0;
    overflow-wrap: anywhere;
  }
  .link { color: var(--accent); }
  .close { margin-top: 3rem; color: var(--dim); }
</style>
