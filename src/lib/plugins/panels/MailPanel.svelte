<!--
  Island → Mail reminders. [FRONTEND]

  Two user-selectable sources share one panel:
  * Local folder — headers from `.eml` files or a Maildir (`new/`, `cur/`), no
    account, password or network request.
  * Cloud account — opt-in Gmail/Outlook OAuth or IMAP app password, with
    secrets in the OS keychain (see MailCloudPanel).
  Only the chosen path is persisted for local mail, in this webview's
  localStorage.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { pickMailFolder, scanMailFolder } from '$lib/api';
  import { t } from '$lib/i18n/i18n.svelte';
  import { readPluginState, removePluginState, writePluginState } from '$lib/plugins/storage';
  import type { MailScan } from '$lib/types';
  import MailCloudPanel from './MailCloudPanel.svelte';
  import MailMessageList from './MailMessageList.svelte';

  const PLUGIN = 'mail.folder';
  const LIMIT = 6;

  let mode = $state<'local' | 'cloud'>('local');
  let folder = $state<string | null>(null);
  let scan = $state<MailScan | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let now = $state(Date.now());
  let request = 0;

  const label = $derived(folder ? basename(folder) : '');

  function basename(path: string): string {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? path;
  }

  async function refresh() {
    if (!folder) return;
    const id = ++request;
    loading = true;
    try {
      const result = await scanMailFolder(folder, LIMIT);
      if (id !== request) return;
      scan = result;
      error = null;
    } catch (e) {
      if (id === request) error = String(e);
    } finally {
      if (id === request) loading = false;
    }
  }

  async function choose() {
    try {
      const picked = await pickMailFolder();
      if (!picked) return;
      folder = picked;
      writePluginState(PLUGIN, picked);
      scan = null;
      error = null;
      await refresh();
    } catch (e) {
      error = String(e);
    }
  }

  function forget() {
    folder = null;
    scan = null;
    error = null;
    request++;
    removePluginState(PLUGIN);
  }

  onMount(() => {
    const saved = readPluginState<string | null>(PLUGIN, null);
    if (typeof saved === 'string' && saved.trim()) {
      folder = saved;
      void refresh();
    }
    const clock = setInterval(() => (now = Date.now()), 30_000);
    const poll = setInterval(() => {
      if (mode === 'local') void refresh();
    }, 60_000);
    return () => {
      request++;
      clearInterval(clock);
      clearInterval(poll);
    };
  });
</script>

<div class="panel">
  <header class="panel-head">
    <div class="heading">
      <strong>{t('plugin.mail')}</strong>
      {#if mode === 'local' && folder}<span class="source" title={folder}>{label}</span>{/if}
    </div>
    {#if mode === 'local'}
      <div class="head-actions">
        {#if folder}
          <button class="link" onclick={() => void choose()}>{t('plugin.mail.change')}</button>
          <button class="link quiet" onclick={forget}>{t('plugin.mail.forget')}</button>
        {:else}
          <button class="link" onclick={() => void choose()}>{t('plugin.mail.chooseAction')}</button>
        {/if}
      </div>
    {/if}
  </header>

  <div class="modes" class:cloud={mode === 'cloud'} role="tablist" aria-label={t('plugin.mail.sources')}>
    <button
      type="button"
      role="tab"
      aria-selected={mode === 'local'}
      class:active={mode === 'local'}
      onclick={() => (mode = 'local')}
    >
      {t('plugin.mail.localTab')}
    </button>
    <button
      type="button"
      role="tab"
      aria-selected={mode === 'cloud'}
      class:active={mode === 'cloud'}
      onclick={() => (mode = 'cloud')}
    >
      {t('plugin.mail.cloudTab')}
    </button>
  </div>

  {#if mode === 'cloud'}
    <MailCloudPanel />
  {:else if !folder}
    <button class="dropzone" onclick={() => void choose()}>
      <svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
        <path d="M3 6h18v12H3zM3 7l9 6 9-6" />
      </svg>
      <span>{t('plugin.mail.choose')}</span>
      <small>{t('plugin.mail.choose.hint')}</small>
    </button>
    <p class="privacy">{t('plugin.mail.privacy')}</p>
  {:else if error}
    <p class="notice bad" role="alert">
      {t('plugin.mail.error')}
      <button class="inline" onclick={() => void choose()}>{t('plugin.mail.change')}</button>
    </p>
    <p class="privacy">{t('plugin.mail.privacy')}</p>
  {:else if !scan || (loading && scan.messages.length === 0)}
    <p class="empty">{t('common.loading')}</p>
  {:else}
    <div class="summary">
      <span class="unread" class:hot={scan.unread > 0}>
        <span class="dot" aria-hidden="true"></span>
        {t('plugin.mail.unread', { count: scan.unread })}
      </span>
      <span class="total">{t('plugin.mail.total', { count: scan.total })}</span>
      <button class="refresh" onclick={() => void refresh()} disabled={loading} aria-label={t('plugin.mail.refresh')} title={t('plugin.mail.refresh')}>
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />
        </svg>
      </button>
    </div>

    <MailMessageList messages={scan.messages} {now} empty={t('plugin.mail.empty')} />

    {#if scan.truncated}
      <p class="hint">{t('plugin.mail.truncated', { count: scan.total })}</p>
    {/if}
    <p class="privacy">{t('plugin.mail.privacy')}</p>
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    width: 22rem;
    max-width: calc(100vw - 2rem);
  }

  .panel-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .heading {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    min-width: 0;
  }

  .panel-head strong {
    font-size: 0.8125rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .source {
    overflow: hidden;
    max-width: 9rem;
    font-size: 0.625rem;
    color: var(--faint);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .head-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: none;
  }

  .modes {
    position: relative;
    display: grid;
    grid-template-columns: 1fr 1fr;
    padding: 0.125rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-2);
  }

  .modes::before {
    content: '';
    position: absolute;
    top: 0.125rem;
    bottom: 0.125rem;
    left: 0.125rem;
    right: 50%;
    border-radius: 999px;
    background: var(--surface);
    box-shadow: 0 1px 3px color-mix(in srgb, black 16%, transparent);
    transition: transform 340ms cubic-bezier(0.22, 1.35, 0.36, 1);
  }

  .modes.cloud::before {
    transform: translateX(100%);
  }

  .modes button {
    position: relative;
    z-index: 1;
    padding: 0.22rem 0;
    border-radius: 999px;
    color: var(--faint);
    font-size: 0.625rem;
    transition: color var(--dur-ui) var(--ease-out), transform 200ms var(--ease-spring);
  }

  .modes button:active {
    transform: scale(0.96);
  }

  .modes button.active {
    color: var(--text);
    font-weight: 600;
  }

  .link {
    padding: 0;
    font-size: 0.6563rem;
    color: var(--focus);
    white-space: nowrap;
  }

  .link.quiet {
    color: var(--faint);
  }

  .link:hover {
    text-decoration: underline;
  }

  .inline {
    padding: 0;
    color: var(--focus);
    text-decoration: underline;
  }

  .dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 1.15rem 0.75rem;
    border: 1px dashed var(--border-strong);
    border-radius: 0.75rem;
    background: transparent;
    color: var(--muted);
    transition: border-color var(--dur-ui) var(--ease-out), background var(--dur-ui) var(--ease-out), color var(--dur-ui) var(--ease-out);
  }

  .dropzone:hover {
    border-color: var(--focus);
    background: var(--surface-2);
    color: var(--text);
  }

  .dropzone span {
    font-size: 0.75rem;
    font-weight: 500;
  }

  .dropzone small {
    font-size: 0.625rem;
    color: var(--faint);
  }

  .summary {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.125rem;
  }

  .unread {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--muted);
  }

  .unread.hot {
    color: var(--text);
  }

  .dot {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 999px;
    background: var(--border-strong);
  }

  .unread.hot .dot {
    background: var(--focus);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--focus) 45%, transparent);
    animation: mail-pulse 2.4s var(--ease-out) infinite;
  }

  @keyframes mail-pulse {
    50% {
      box-shadow: 0 0 0 4px transparent;
    }
  }

  .total {
    font-size: 0.625rem;
    color: var(--faint);
  }

  .refresh {
    display: grid;
    place-items: center;
    width: 1.35rem;
    height: 1.35rem;
    margin-left: auto;
    border-radius: 0.375rem;
    color: var(--faint);
  }

  .refresh:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  .refresh:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .hint,
  .privacy {
    margin: 0;
    font-size: 0.5938rem;
    line-height: 1.4;
    color: var(--faint);
  }

  .hint {
    color: var(--muted);
  }

  .empty {
    margin: 0;
    padding: 0.5rem 0;
    font-size: 0.6875rem;
    color: var(--muted);
  }

  .notice.bad {
    margin: 0;
    font-size: 0.6563rem;
    color: var(--critical);
  }

  @media (prefers-reduced-motion: reduce) {
    .modes::before {
      transition: none;
    }
    .unread.hot .dot {
      animation: none;
    }
  }
</style>
