<!--
  Island → Cloud mail accounts. [FRONTEND]

  Opt-in alternative to the local folder reader: Gmail OAuth, Outlook OAuth or
  IMAP with an app password. The account list is metadata only; the backend
  keeps tokens/passwords in the OS keychain. This panel polls only while it is
  open, and only the selected account.
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    cancelCloudMailLogin,
    listCloudMailAccounts,
    reconnectCloudMail,
    removeCloudMail,
    scanCloudMail,
  } from '$lib/api';
  import { formatAgo } from '$lib/format';
  import { t, tDyn } from '$lib/i18n/i18n.svelte';
  import {
    readPluginState,
    removePluginState,
    writePluginState,
  } from '$lib/plugins/storage';
  import type {
    CloudMailAccount,
    CloudMailMode,
    CloudMailProvider,
    CloudMailScan,
  } from '$lib/types';
  import MailCloudSetup from './MailCloudSetup.svelte';
  import MailMessageList from './MailMessageList.svelte';

  const STORE = 'mail.cloud.account';
  const LIMIT = 6;
  const POLL_MS = 60_000;

  type SetupTarget = { provider: CloudMailProvider; method: CloudMailMode };

  const PROVIDERS: { id: CloudMailProvider; oauth: boolean }[] = [
    { id: 'gmail', oauth: true },
    { id: 'outlook', oauth: true },
    { id: 'imap', oauth: false },
  ];

  let accounts = $state<CloudMailAccount[]>([]);
  let selectedId = $state<string | null>(null);
  let scan = $state<CloudMailScan | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let reconnecting = $state(false);
  let error = $state<string | null>(null);
  let setup = $state<SetupTarget | null>(null);
  let picking = $state(false);
  let confirmRemove = $state(false);
  let now = $state(Date.now());
  let request = 0;

  const selected = $derived(accounts.find((account) => account.id === selectedId) ?? null);
  const checked = $derived(
    scan ? formatAgo(new Date(scan.checkedAtMs).toISOString(), now) : ''
  );
  const displayLabel = $derived(
    selected ? selected.label || selected.displayName || selected.email : ''
  );

  function message(value: unknown): string {
    const text =
      typeof value === 'string' ? value : value instanceof Error ? value.message : String(value);
    return text.replace(/^Error:\s*/, '');
  }

  async function scanAccount(id: string, quiet = false) {
    const current = ++request;
    if (!quiet) busy = true;
    try {
      const result = await scanCloudMail(id, LIMIT);
      if (current !== request) return;
      scan = result;
      error = null;
      accounts = accounts.map((account) =>
        account.id === id ? result.account : account
      );
    } catch (value) {
      if (current !== request) return;
      error = message(value);
      try {
        accounts = await listCloudMailAccounts();
      } catch {
        // Keep the rows that were already on screen.
      }
    } finally {
      if (current === request) busy = false;
    }
  }

  async function loadAccounts(preferred?: string) {
    loading = true;
    try {
      const list = await listCloudMailAccounts();
      accounts = list;
      const saved = preferred ?? readPluginState<string | null>(STORE, null);
      const wanted = typeof saved === 'string' ? saved : null;
      const account = list.find((candidate) => candidate.id === wanted) ?? list[0] ?? null;
      if (!account) {
        selectedId = null;
        scan = null;
        picking = true;
        return;
      }
      selectedId = account.id;
      picking = false;
      writePluginState(STORE, account.id);
      await scanAccount(account.id);
    } catch (value) {
      error = message(value);
    } finally {
      loading = false;
    }
  }

  function select(id: string) {
    if (id === selectedId) return;
    selectedId = id;
    writePluginState(STORE, id);
    scan = null;
    error = null;
    confirmRemove = false;
    void scanAccount(id);
  }

  function openSetup(provider: CloudMailProvider, method: CloudMailMode) {
    error = null;
    setup = { provider, method };
  }

  async function connected(account: CloudMailAccount) {
    setup = null;
    picking = false;
    selectedId = account.id;
    writePluginState(STORE, account.id);
    scan = null;
    error = null;
    try {
      accounts = await listCloudMailAccounts();
    } catch {
      accounts = [...accounts.filter((existing) => existing.id !== account.id), account];
    }
    await scanAccount(account.id);
  }

  async function reconnect() {
    if (!selected || reconnecting) return;
    reconnecting = true;
    error = null;
    try {
      const account = await reconnectCloudMail(selected.id);
      accounts = accounts.map((existing) =>
        existing.id === account.id ? account : existing
      );
      await scanAccount(account.id);
    } catch (value) {
      const text = message(value);
      error = /cancelled/i.test(text) ? null : text;
    } finally {
      reconnecting = false;
    }
  }

  async function removeSelected() {
    const account = selected;
    if (!account) return;
    busy = true;
    try {
      await removeCloudMail(account.id);
      confirmRemove = false;
      scan = null;
      error = null;
      accounts = accounts.filter((existing) => existing.id !== account.id);
      if (accounts.length === 0) {
        selectedId = null;
        removePluginState(STORE);
        picking = true;
      } else {
        const next = accounts[0];
        selectedId = next.id;
        writePluginState(STORE, next.id);
        await scanAccount(next.id);
      }
    } catch (value) {
      error = message(value);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void loadAccounts();
    const poll = setInterval(() => {
      if (!setup && !picking && selectedId) void scanAccount(selectedId, true);
    }, POLL_MS);
    const clock = setInterval(() => (now = Date.now()), 30_000);
    return () => {
      request++;
      clearInterval(poll);
      clearInterval(clock);
    };
  });

  onDestroy(() => {
    if (reconnecting) void cancelCloudMailLogin();
  });
</script>

<div class="cloud">
  {#if loading && accounts.length === 0}
    <p class="empty">{t('common.loading')}</p>
  {:else if setup}
    <MailCloudSetup
      provider={setup.provider}
      method={setup.method}
      onconnected={connected}
      oncancel={() => {
        setup = null;
        picking = true;
      }}
    />
  {:else if picking || accounts.length === 0}
    <div class="picker">
      <p class="lead">{t('plugin.mail.cloud.pick')}</p>
      {#each PROVIDERS as provider (provider.id)}
        <div class="provider-card">
          <div class="provider-head">
            <span class="provider-icon" class:gmail={provider.id === 'gmail'} class:outlook={provider.id === 'outlook'}>
              {provider.id === 'gmail' ? 'G' : provider.id === 'outlook' ? 'O' : '@'}
            </span>
            <span class="provider-copy">
              <strong>{tDyn(`plugin.mail.cloud.${provider.id}`)}</strong>
              <small>{tDyn(`plugin.mail.cloud.${provider.id}.hint`)}</small>
            </span>
          </div>
          <div class="provider-actions">
            {#if provider.oauth}
              <button type="button" class="mini" onclick={() => openSetup(provider.id, 'oauth')}>
                {t('plugin.mail.cloud.signIn')}
              </button>
            {/if}
            <button type="button" class="link" onclick={() => openSetup(provider.id, 'password')}>
              {provider.id === 'imap'
                ? t('plugin.mail.cloud.connect')
                : t('plugin.mail.cloud.usePassword')}
            </button>
          </div>
        </div>
      {/each}
      {#if accounts.length > 0}
        <button type="button" class="link quiet" onclick={() => (picking = false)}>
          {t('plugin.mail.cloud.back')}
        </button>
      {/if}
      <p class="privacy">{t('plugin.mail.cloud.privacy')}</p>
    </div>
  {:else if selected}
    <div class="account-view">
      {#if accounts.length > 1}
        <div class="chips" role="tablist" aria-label={t('plugin.mail.cloud.accounts')}>
          {#each accounts as account (account.id)}
            <button
              type="button"
              class="chip"
              class:active={account.id === selectedId}
              role="tab"
              aria-selected={account.id === selectedId}
              onclick={() => select(account.id)}
              title={account.email}
            >
              <span class="chip-dot" class:gmail={account.provider === 'gmail'} class:outlook={account.provider === 'outlook'} aria-hidden="true"></span>
              <span class="chip-label">{account.label || account.email}</span>
              {#if account.lastError}<span class="chip-alert" aria-hidden="true">!</span>{/if}
            </button>
          {/each}
          <button type="button" class="chip add" onclick={() => (picking = true)} aria-label={t('plugin.mail.cloud.add')}>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      {/if}

      <div class="account-head">
        <div class="account-id">
          <span class="provider-icon" class:gmail={selected.provider === 'gmail'} class:outlook={selected.provider === 'outlook'}>
            {selected.provider === 'gmail' ? 'G' : selected.provider === 'outlook' ? 'O' : '@'}
          </span>
          <span class="account-copy">
            <strong>{displayLabel}</strong>
            <small title={selected.email}>{selected.email}</small>
          </span>
        </div>
        <div class="account-actions">
          <button
            type="button"
            class="icon"
            onclick={() => void scanAccount(selected.id)}
            disabled={busy || reconnecting}
            aria-label={t('plugin.mail.refresh')}
            title={t('plugin.mail.refresh')}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />
            </svg>
          </button>
          <button
            type="button"
            class="icon quiet"
            onclick={() => (confirmRemove = !confirmRemove)}
            disabled={busy || reconnecting}
            aria-label={t('plugin.mail.cloud.remove')}
            title={t('plugin.mail.cloud.remove')}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v5M14 11v5" />
            </svg>
          </button>
        </div>
      </div>

      {#if confirmRemove}
        <div class="confirm" role="alert">
          <p>{t('plugin.mail.cloud.remove.confirm', { email: selected.email })}</p>
          <div class="confirm-actions">
            <button type="button" class="danger" onclick={() => void removeSelected()} disabled={busy}>
              {t('plugin.mail.cloud.remove.yes')}
            </button>
            <button type="button" class="link quiet" onclick={() => (confirmRemove = false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      {/if}

      {#if error}
        <p class="notice bad" role="alert">{error}</p>
        {#if selected.mode === 'oauth'}
          <button type="button" class="link reconnect" onclick={() => void reconnect()} disabled={reconnecting}>
            {reconnecting ? t('plugin.mail.cloud.waiting') : t('plugin.mail.cloud.reconnect')}
          </button>
        {:else}
          <p class="help">{t('plugin.mail.cloud.password.retry')}</p>
        {/if}
      {:else if !scan || (busy && !scan)}
        <div class="loading-line" aria-live="polite">
          <span class="spinner" aria-hidden="true"></span>
          <span>{t('common.loading')}</span>
        </div>
      {:else}
        <div class="summary">
          <span class="unread" class:hot={scan.unread > 0}>
            <span class="dot" aria-hidden="true"></span>
            {t('plugin.mail.cloud.unread', { count: scan.unread })}
          </span>
          <span class="checked">{t('plugin.mail.cloud.checked', { time: checked })}</span>
          <button
            type="button"
            class="icon refresh"
            onclick={() => void scanAccount(selected.id)}
            disabled={busy}
            aria-label={t('plugin.mail.refresh')}
            title={t('plugin.mail.refresh')}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
              <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />
            </svg>
          </button>
        </div>

        <MailMessageList
          messages={scan.messages}
          {now}
          empty={t('plugin.mail.cloud.empty')}
        />

        {#if scan.truncated}
          <p class="help">{t('plugin.mail.cloud.truncated', { count: scan.total })}</p>
        {/if}
      {/if}

      {#if accounts.length === 1}
        <button type="button" class="link add-account" onclick={() => (picking = true)}>
          {t('plugin.mail.cloud.addAnother')}
        </button>
      {/if}
      <p class="privacy">{t('plugin.mail.cloud.privacy')}</p>
    </div>
  {/if}
</div>

<style>
  .cloud {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .picker {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    animation: cloud-view-in 320ms cubic-bezier(0.2, 1.3, 0.35, 1) both;
  }

  .lead {
    margin: 0;
    padding: 0 0.125rem;
    font-size: 0.625rem;
    color: var(--faint);
  }

  .provider-card {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.55rem;
    border: 1px solid var(--border);
    border-radius: 0.65rem;
    background: var(--surface-2);
    transition: border-color var(--dur-ui) var(--ease-out), transform 220ms var(--ease-spring);
    animation: cloud-card-in 320ms cubic-bezier(0.2, 1.35, 0.35, 1) both;
  }

  .provider-card:nth-child(2) {
    animation-delay: 40ms;
  }

  .provider-card:nth-child(3) {
    animation-delay: 80ms;
  }

  .provider-card:nth-child(4) {
    animation-delay: 120ms;
  }

  .provider-card:hover {
    border-color: var(--border-strong);
    transform: translateY(-1px);
  }

  .provider-head {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }

  .provider-icon {
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 0.55rem;
    background: color-mix(in srgb, var(--focus) 12%, var(--surface));
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 700;
    line-height: 1;
    flex: none;
  }

  .provider-icon.gmail {
    background: color-mix(in srgb, #ea4335 14%, var(--surface));
    color: #ea4335;
  }

  .provider-icon.outlook {
    background: color-mix(in srgb, #0078d4 16%, var(--surface));
    color: #0078d4;
  }

  .provider-copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1 1 auto;
  }

  .provider-copy strong {
    font-size: 0.7188rem;
    font-weight: 600;
  }

  .provider-copy small {
    font-size: 0.5938rem;
    line-height: 1.35;
    color: var(--faint);
  }

  .provider-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-left: 2.2rem;
  }

  .mini {
    padding: 0.28rem 0.55rem;
    border: 1px solid color-mix(in srgb, var(--focus) 45%, transparent);
    border-radius: 0.4rem;
    background: color-mix(in srgb, var(--focus) 14%, var(--surface));
    color: var(--text);
    font-size: 0.6563rem;
    font-weight: 600;
    transition: transform 180ms var(--ease-spring), background var(--dur-ui) var(--ease-out);
  }

  .mini:hover {
    background: color-mix(in srgb, var(--focus) 22%, var(--surface));
  }

  .mini:active {
    transform: scale(0.94);
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
    text-underline-offset: 2px;
  }

  .account-view {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    animation: cloud-view-in 300ms cubic-bezier(0.2, 1.25, 0.35, 1) both;
  }

  .chips {
    display: flex;
    gap: 0.3rem;
    overflow-x: auto;
    padding-bottom: 0.1rem;
    scrollbar-width: none;
  }

  .chips::-webkit-scrollbar {
    display: none;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.22rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: transparent;
    color: var(--faint);
    font-size: 0.625rem;
    white-space: nowrap;
    flex: none;
    transition: color var(--dur-ui) var(--ease-out), border-color var(--dur-ui) var(--ease-out),
      background var(--dur-ui) var(--ease-out), transform 200ms var(--ease-spring);
  }

  .chip:hover {
    color: var(--text);
  }

  .chip:active {
    transform: scale(0.95);
  }

  .chip.active {
    border-color: color-mix(in srgb, var(--focus) 45%, var(--border));
    background: color-mix(in srgb, var(--focus) 12%, transparent);
    color: var(--text);
  }

  .chip.add {
    padding-inline: 0.4rem;
  }

  .chip-dot {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 999px;
    background: var(--muted);
    flex: none;
  }

  .chip-dot.gmail {
    background: #ea4335;
  }

  .chip-dot.outlook {
    background: #0078d4;
  }

  .chip-alert {
    display: grid;
    place-items: center;
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--critical) 18%, transparent);
    color: var(--critical);
    font-size: 0.5rem;
    font-weight: 700;
  }

  .account-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .account-id {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
  }

  .account-copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .account-copy strong {
    font-size: 0.75rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .account-copy small {
    overflow: hidden;
    max-width: 11rem;
    font-size: 0.5938rem;
    color: var(--faint);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .account-actions {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    flex: none;
  }

  .icon {
    display: grid;
    place-items: center;
    width: 1.35rem;
    height: 1.35rem;
    border-radius: 0.375rem;
    color: var(--faint);
    transition: background var(--dur-ui) var(--ease-out), color var(--dur-ui) var(--ease-out),
      transform 180ms var(--ease-spring);
  }

  .icon:hover:not(:disabled) {
    background: var(--surface-2);
    color: var(--text);
  }

  .icon:active:not(:disabled) {
    transform: scale(0.9);
  }

  .icon:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .icon.quiet:hover:not(:disabled) {
    color: var(--critical);
  }

  .confirm {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.45rem 0.5rem;
    border: 1px solid color-mix(in srgb, var(--critical) 28%, var(--border));
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--critical) 7%, transparent);
    animation: cloud-card-in 220ms var(--ease-out) both;
  }

  .confirm p {
    margin: 0;
    font-size: 0.625rem;
    line-height: 1.4;
    color: var(--muted);
  }

  .confirm-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .danger {
    padding: 0.24rem 0.5rem;
    border-radius: 0.35rem;
    background: color-mix(in srgb, var(--critical) 18%, transparent);
    color: var(--critical);
    font-size: 0.625rem;
    font-weight: 600;
  }

  .danger:disabled {
    opacity: 0.5;
  }

  .summary {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.2rem 0.125rem;
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

  .checked {
    overflow: hidden;
    font-size: 0.5625rem;
    color: var(--faint);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .refresh {
    margin-left: auto;
  }

  .loading-line {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 0.125rem;
    font-size: 0.6563rem;
    color: var(--muted);
  }

  .spinner {
    width: 0.75rem;
    height: 0.75rem;
    border: 1.5px solid color-mix(in srgb, var(--focus) 30%, transparent);
    border-top-color: var(--focus);
    border-radius: 999px;
    animation: spin 800ms linear infinite;
    flex: none;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .notice.bad {
    margin: 0;
    font-size: 0.6563rem;
    line-height: 1.4;
    color: var(--critical);
  }

  .reconnect {
    align-self: flex-start;
  }

  .help,
  .privacy {
    margin: 0;
    font-size: 0.5938rem;
    line-height: 1.4;
    color: var(--faint);
  }

  .add-account {
    align-self: flex-start;
  }

  .empty {
    margin: 0;
    padding: 0.5rem 0;
    font-size: 0.6875rem;
    color: var(--muted);
  }

  @keyframes cloud-view-in {
    from {
      opacity: 0;
      transform: translateY(-3px) scale(0.985);
    }
  }

  @keyframes cloud-card-in {
    from {
      opacity: 0;
      transform: translateY(-2px) scale(0.98);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .picker,
    .provider-card,
    .account-view,
    .confirm,
    .spinner,
    .unread.hot .dot {
      animation: none;
    }
    .provider-card,
    .mini,
    .chip,
    .icon {
      transition: none;
    }
  }
</style>
