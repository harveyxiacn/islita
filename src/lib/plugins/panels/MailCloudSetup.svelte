<!--
  Island → Cloud mail setup. [FRONTEND]

  Three user-selectable routes: Gmail OAuth, Outlook OAuth or IMAP with an app
  password (Gmail/Outlook/other). The browser opens the provider's own consent
  page; the backend listens on a loopback port and stores tokens/passwords in
  the OS keychain. Nothing secret is written to settings or localStorage.
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    addCloudMailPassword,
    cancelCloudMailLogin,
    loginCloudMail,
    openExternal,
  } from '$lib/api';
  import { t, tDyn } from '$lib/i18n/i18n.svelte';
  import type { CloudMailAccount, CloudMailMode, CloudMailProvider } from '$lib/types';

  type Props = {
    provider: CloudMailProvider;
    method: CloudMailMode;
    onconnected: (account: CloudMailAccount) => void;
    oncancel: () => void;
  };

  let { provider, method, onconnected, oncancel }: Props = $props();

  const GMAIL_CONSOLE = 'https://console.cloud.google.com/apis/credentials';
  const MICROSOFT_APPS =
    'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade';
  const GOOGLE_APP_PASSWORDS = 'https://myaccount.google.com/apppasswords';
  const MICROSOFT_APP_PASSWORDS = 'https://account.live.com/proofs/AppPassword';

  let clientId = $state('');
  let clientSecret = $state('');
  let email = $state('');
  let password = $state('');
  let label = $state('');
  let server = $state('');
  let port = $state(993);
  let username = $state('');
  let starttls = $state(false);
  let busy = $state(false);
  let waiting = $state(false);
  let cancelling = $state(false);
  let error = $state<string | null>(null);

  const isOAuth = $derived(method === 'oauth');
  const providerName = $derived(tDyn(`plugin.mail.cloud.${provider}`));
  const title = $derived.by(() => {
    if (provider === 'imap') return t('plugin.mail.cloud.setup.imap');
    const key = `plugin.mail.cloud.setup.${provider}${method === 'oauth' ? 'Oauth' : 'Password'}`;
    return tDyn(key);
  });
  const subtitle = $derived(
    isOAuth ? t('plugin.mail.cloud.setup.oauthSubtitle') : t('plugin.mail.cloud.setup.passwordSubtitle')
  );

  function message(value: unknown): string {
    const text =
      typeof value === 'string' ? value : value instanceof Error ? value.message : String(value);
    return text.replace(/^Error:\s*/, '');
  }

  async function submitOAuth() {
    error = null;
    if (!clientId.trim()) {
      error = t('plugin.mail.cloud.error.clientId');
      return;
    }
    if (provider === 'gmail' && !clientSecret.trim()) {
      error = t('plugin.mail.cloud.error.clientSecret');
      return;
    }
    busy = true;
    waiting = true;
    cancelling = false;
    try {
      const account = await loginCloudMail(
        provider,
        clientId.trim(),
        provider === 'gmail' ? clientSecret.trim() : undefined
      );
      onconnected(account);
    } catch (value) {
      const text = message(value);
      // Closing the waiting view cancels on purpose; do not show that as a
      // failure after the user asked for it.
      error = /cancelled/i.test(text) ? null : text;
    } finally {
      busy = false;
      waiting = false;
      cancelling = false;
    }
  }

  async function submitPassword() {
    error = null;
    if (!email.trim()) {
      error = t('plugin.mail.cloud.error.email');
      return;
    }
    if (!password) {
      error = t('plugin.mail.cloud.error.password');
      return;
    }
    if (provider === 'imap') {
      if (!server.trim()) {
        error = t('plugin.mail.cloud.error.server');
        return;
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        error = t('plugin.mail.cloud.error.port');
        return;
      }
    }
    busy = true;
    try {
      const account = await addCloudMailPassword({
        provider,
        email: email.trim(),
        password,
        displayName: label.trim() || undefined,
        label: label.trim() || undefined,
        server: provider === 'imap' ? server.trim() : undefined,
        port: provider === 'imap' ? port : undefined,
        username: provider === 'imap' ? username.trim() || undefined : undefined,
        starttls: provider === 'imap' ? starttls : undefined,
      });
      onconnected(account);
    } catch (value) {
      error = message(value);
    } finally {
      busy = false;
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    if (isOAuth) await submitOAuth();
    else await submitPassword();
  }

  async function cancelWaiting() {
    if (!waiting || cancelling) return;
    cancelling = true;
    try {
      await cancelCloudMailLogin();
    } catch {
      // The login promise itself will settle; nothing else to do.
    }
  }

  onDestroy(() => {
    if (waiting) void cancelCloudMailLogin();
  });
</script>

<form class="setup" onsubmit={submit}>
  <header class="setup-head">
    <button type="button" class="back" onclick={oncancel} aria-label={t('plugin.mail.cloud.back')}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m15 18-6-6 6-6" />
      </svg>
    </button>
    <div class="titles">
      <strong>{title}</strong>
      <small>{subtitle}</small>
    </div>
    <span class="provider-badge" class:gmail={provider === 'gmail'} class:outlook={provider === 'outlook'}>
      {providerName}
    </span>
  </header>

  {#if isOAuth}
    <p class="help">
      {#if provider === 'gmail'}
        {t('plugin.mail.cloud.oauth.gmail.help')}
        <button type="button" class="link" onclick={() => void openExternal(GMAIL_CONSOLE)}>
          {t('plugin.mail.cloud.oauth.console')}
        </button>
      {:else}
        {t('plugin.mail.cloud.oauth.outlook.help')}
        <button type="button" class="link" onclick={() => void openExternal(MICROSOFT_APPS)}>
          {t('plugin.mail.cloud.oauth.microsoft')}
        </button>
      {/if}
    </p>

    <label class="field">
      <span>{t('plugin.mail.cloud.clientId')}</span>
      <input bind:value={clientId} type="text" autocomplete="off" spellcheck="false" placeholder="…apps.googleusercontent.com" />
    </label>
    {#if provider === 'gmail'}
      <label class="field">
        <span>{t('plugin.mail.cloud.clientSecret')}</span>
        <input bind:value={clientSecret} type="password" autocomplete="off" spellcheck="false" />
      </label>
      <p class="fine">{t('plugin.mail.cloud.clientSecret.hint')}</p>
    {/if}
  {:else}
    <label class="field">
      <span>{t('plugin.mail.cloud.email')}</span>
      <input bind:value={email} type="email" autocomplete="email" spellcheck="false" placeholder="you@example.com" />
    </label>
    <label class="field">
      <span>{t('plugin.mail.cloud.password')}</span>
      <input bind:value={password} type="password" autocomplete="off" spellcheck="false" />
    </label>
    <p class="fine">
      {#if provider === 'gmail'}
        {t('plugin.mail.cloud.password.hint.gmail')}
        <button type="button" class="link" onclick={() => void openExternal(GOOGLE_APP_PASSWORDS)}>
          {t('plugin.mail.cloud.appPassword.create')}
        </button>
      {:else if provider === 'outlook'}
        {t('plugin.mail.cloud.password.hint.outlook')}
        <button type="button" class="link" onclick={() => void openExternal(MICROSOFT_APP_PASSWORDS)}>
          {t('plugin.mail.cloud.appPassword.create')}
        </button>
      {:else}
        {t('plugin.mail.cloud.password.hint.imap')}
      {/if}
    </p>

    {#if provider === 'imap'}
      <div class="grid">
        <label class="field grow">
          <span>{t('plugin.mail.cloud.server')}</span>
          <input bind:value={server} type="text" autocomplete="off" spellcheck="false" placeholder="imap.example.com" />
        </label>
        <label class="field narrow">
          <span>{t('plugin.mail.cloud.port')}</span>
          <input bind:value={port} type="number" min="1" max="65535" />
        </label>
      </div>
      <label class="field">
        <span>{t('plugin.mail.cloud.username')}</span>
        <input bind:value={username} type="text" autocomplete="username" spellcheck="false" placeholder={email || t('plugin.mail.cloud.username.hint')} />
      </label>
      <label class="check">
        <input bind:checked={starttls} type="checkbox" />
        <span>{t('plugin.mail.cloud.starttls')}</span>
      </label>
    {/if}

    <label class="field">
      <span>{t('plugin.mail.cloud.name')}</span>
      <input bind:value={label} type="text" maxlength="60" autocomplete="off" placeholder={t('plugin.mail.cloud.name.hint')} />
    </label>
  {/if}

  {#if error}
    <p class="notice bad" role="alert">{error}</p>
  {/if}

  {#if waiting}
    <div class="waiting" aria-live="polite">
      <span class="spinner" aria-hidden="true"></span>
      <span>{t('plugin.mail.cloud.waiting')}</span>
      <button type="button" class="link quiet" onclick={() => void cancelWaiting()} disabled={cancelling}>
        {cancelling ? t('plugin.mail.cloud.cancelling') : t('plugin.mail.cloud.cancel')}
      </button>
    </div>
  {:else}
    <button class="primary" type="submit" disabled={busy}>
      {busy ? t('plugin.mail.cloud.connecting') : isOAuth ? t('plugin.mail.cloud.signIn') : t('plugin.mail.cloud.connect')}
    </button>
  {/if}

  <p class="privacy">{t('plugin.mail.cloud.privacy')}</p>
</form>

<style>
  .setup {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }

  .setup-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .back {
    display: grid;
    place-items: center;
    width: 1.35rem;
    height: 1.35rem;
    border-radius: 0.375rem;
    color: var(--muted);
    flex: none;
    transition: background var(--dur-ui) var(--ease-out), transform 180ms var(--ease-spring);
  }

  .back:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  .back:active {
    transform: scale(0.88);
  }

  .titles {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1 1 auto;
  }

  .titles strong {
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .titles small {
    font-size: 0.5938rem;
    color: var(--faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .provider-badge {
    flex: none;
    padding: 0.0625rem 0.375rem;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--faint);
    font-size: 0.5625rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .provider-badge.gmail {
    background: color-mix(in srgb, #ea4335 14%, transparent);
    color: color-mix(in srgb, #ea4335 72%, var(--text));
  }

  .provider-badge.outlook {
    background: color-mix(in srgb, #0078d4 16%, transparent);
    color: color-mix(in srgb, #0078d4 72%, var(--text));
  }

  .help,
  .fine,
  .privacy {
    margin: 0;
    font-size: 0.5938rem;
    line-height: 1.45;
    color: var(--faint);
  }

  .help {
    padding: 0.4rem 0.5rem;
    border-radius: 0.45rem;
    background: var(--surface-2);
    color: var(--muted);
  }

  .privacy {
    padding-top: 0.1rem;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }

  .field > span {
    font-size: 0.5938rem;
    color: var(--faint);
  }

  input:not([type='checkbox']) {
    width: 100%;
    box-sizing: border-box;
    padding: 0.38rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 0.45rem;
    background: var(--surface-2);
    color: var(--text);
    font: inherit;
    font-size: 0.6875rem;
    transition: border-color var(--dur-ui) var(--ease-out), box-shadow var(--dur-ui) var(--ease-out);
  }

  input:not([type='checkbox']):focus {
    outline: none;
    border-color: var(--focus);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 18%, transparent);
  }

  .grid {
    display: flex;
    gap: 0.4rem;
  }

  .grow {
    flex: 1 1 auto;
  }

  .narrow {
    width: 5rem;
    flex: none;
  }

  .check {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.6563rem;
    color: var(--muted);
    cursor: pointer;
  }

  .check input {
    accent-color: var(--focus);
    margin: 0;
  }

  .link {
    padding: 0;
    font-size: inherit;
    color: var(--focus);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .link.quiet {
    color: var(--faint);
  }

  .primary {
    width: 100%;
    padding: 0.48rem 0.75rem;
    border: 1px solid color-mix(in srgb, var(--focus) 55%, transparent);
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--focus) 18%, var(--surface-2));
    color: var(--text);
    font-size: 0.7188rem;
    font-weight: 600;
    transition: transform 180ms var(--ease-spring), background var(--dur-ui) var(--ease-out);
  }

  .primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--focus) 26%, var(--surface-2));
  }

  .primary:active:not(:disabled) {
    transform: scale(0.97);
  }

  .primary:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .notice.bad {
    margin: 0;
    font-size: 0.6563rem;
    line-height: 1.4;
    color: var(--critical);
  }

  .waiting {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.45rem 0.5rem;
    border-radius: 0.5rem;
    background: var(--surface-2);
    font-size: 0.6563rem;
    color: var(--muted);
  }

  .waiting .link {
    margin-left: auto;
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

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 2s;
    }
    .back,
    .primary {
      transition: none;
    }
  }
</style>
