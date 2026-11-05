<!--
  Island → Recent sessions. The newest Claude Code / Codex activity from the
  local session index: title, provider, age, tokens and whether the session is
  still warm. This is the read-only foundation for task-completion notices;
  it never shows prompt or response text. [FRONTEND]
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import ProviderLogo from '$lib/components/ProviderLogo.svelte';
  import { listSessions, openDashboard } from '$lib/api';
  import { formatAgo, formatTokens } from '$lib/format';
  import { t } from '$lib/i18n/i18n.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import type { SessionSummary } from '$lib/session-types';

  const s = $derived(settings.value);
  const PLUGIN_WINDOW_MS = 24 * 3_600_000;
  const ACTIVE_WINDOW_MS = 5 * 60_000;
  const LIMIT = 5;

  let rows = $state<SessionSummary[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let now = $state(Date.now());
  let request = 0;

  async function load() {
    if (!s.ingestEnabled) {
      loading = false;
      rows = [];
      return;
    }
    const id = ++request;
    loading = true;
    try {
      const to = new Date();
      const from = new Date(to.getTime() - PLUGIN_WINDOW_MS);
      const result = await listSessions({
        from: from.toISOString(),
        to: to.toISOString(),
        provider: null,
        sort: 'recent',
        limit: LIMIT,
      });
      if (id !== request) return;
      rows = result.rows;
      error = null;
    } catch (e) {
      if (id === request) error = String(e);
    } finally {
      if (id === request) loading = false;
    }
  }

  onMount(() => {
    void load();
    const clock = setInterval(() => (now = Date.now()), 15_000);
    const refresh = setInterval(() => void load(), 30_000);
    return () => {
      request++;
      clearInterval(clock);
      clearInterval(refresh);
    };
  });

  function isActive(row: SessionSummary): boolean {
    const ts = Date.parse(row.lastTs);
    return Number.isFinite(ts) && now >= ts && now - ts < ACTIVE_WINDOW_MS;
  }

  function titleOf(row: SessionSummary): string {
    return row.title?.trim() || row.project || row.sessionId.slice(0, 10) || t('plugin.sessions.untitled');
  }
</script>

<div class="panel">
  <header class="panel-head">
    <strong>{t('plugin.sessions')}</strong>
    <button class="link" onclick={() => void openDashboard('sessions')}>{t('plugin.sessions.open')}</button>
  </header>

  {#if !s.ingestEnabled}
    <p class="empty">{t('plugin.sessions.disabled')}</p>
  {:else if error}
    <p class="empty bad" role="alert">{t('common.error', { message: error })}</p>
  {:else if loading && rows.length === 0}
    <p class="empty">{t('common.loading')}</p>
  {:else if rows.length === 0}
    <p class="empty">{t('plugin.sessions.empty')}</p>
  {:else}
    <ul class="rows">
      {#each rows as row (row.provider + row.sessionId)}
        <li>
          <button class="row" onclick={() => void openDashboard('sessions')}>
            <span class="logo" style:color={`var(--accent-${row.provider}, var(--accent-fallback))`}>
              <ProviderLogo provider={row.provider} size={16} />
            </span>
            <span class="who">
              <span class="title">{titleOf(row)}</span>
              <span class="meta">
                {#if isActive(row)}<span class="live" aria-label={t('plugin.sessions.active')}></span>{/if}
                <span>{formatAgo(row.lastTs, now)}</span>
                <span>·</span>
                <span>{t('plugin.sessions.tokens', { tokens: formatTokens(row.totalTokens) })}</span>
              </span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
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
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .panel-head strong {
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .link {
    padding: 0;
    font-size: 0.6875rem;
    color: var(--focus);
    white-space: nowrap;
  }

  .link:hover {
    text-decoration: underline;
  }

  .empty {
    margin: 0;
    padding: 0.375rem 0;
    font-size: 0.6875rem;
    color: var(--muted);
  }

  .empty.bad {
    color: var(--critical, #ff3b30);
  }

  .rows {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li + li {
    border-top: 1px solid var(--border);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.3125rem 0;
    text-align: left;
  }

  .row:hover .title {
    color: var(--focus);
  }

  .logo {
    display: grid;
    place-items: center;
    flex: none;
    width: 1.4rem;
    height: 1.4rem;
    border-radius: 999px;
    background: var(--surface-2);
  }

  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1 1 auto;
  }

  .title {
    overflow: hidden;
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: color var(--dur-ui) var(--ease-out);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.625rem;
    color: var(--muted);
  }

  .live {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 999px;
    background: var(--ok, #30d158);
  }
</style>
