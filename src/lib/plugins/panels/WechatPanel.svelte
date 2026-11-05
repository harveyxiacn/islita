<!--
  Island → WeChat conversation mirror. [FRONTEND]

  Windows only. The backend reads the visible conversation list through UI
  Automation (`mmui::ChatSessionCell`) — no chat database, keystrokes or
  network. This panel polls only while it is open, so message text is never
  read in the background, and it keeps nothing in localStorage.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { readWechatSessions } from '$lib/api';
  import { formatAgo } from '$lib/format';
  import { t } from '$lib/i18n/i18n.svelte';
  import type { WechatScan, WechatState } from '$lib/types';

  const LIMIT = 8;
  const POLL_MS = 5_000;

  let scan = $state<WechatScan | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let now = $state(Date.now());
  let fresh = $state<Set<string>>(new Set());
  let request = 0;
  let previous = new Map<string, string>();
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  const updated = $derived(
    scan && scan.state === 'ok' ? formatAgo(new Date(scan.readAtMs).toISOString(), now) : ''
  );

  const stateCopy = $derived.by((): { title: string; hint: string } => {
    const state: WechatState = scan?.state ?? 'not_running';
    switch (state) {
      case 'not_running':
        return { title: t('plugin.wechat.notRunning'), hint: t('plugin.wechat.notRunning.hint') };
      case 'no_sessions':
        return { title: t('plugin.wechat.noSessions'), hint: t('plugin.wechat.noSessions.hint') };
      case 'blocked':
        return { title: t('plugin.wechat.blocked'), hint: t('plugin.wechat.blocked.hint') };
      case 'unsupported':
        return { title: t('plugin.wechat.unsupported'), hint: t('plugin.wechat.unsupported.hint') };
      default:
        return { title: '', hint: '' };
    }
  });

  function markFresh(sessions: WechatScan['sessions']) {
    const next = new Set<string>();
    for (const session of sessions) {
      const before = previous.get(session.id);
      if (before !== undefined && before !== session.preview) next.add(session.id);
    }
    previous = new Map(sessions.map((session) => [session.id, session.preview]));
    if (flashTimer) clearTimeout(flashTimer);
    fresh = next;
    if (next.size > 0) {
      flashTimer = setTimeout(() => (fresh = new Set()), 1_600);
    }
  }

  async function refresh(quiet = false) {
    const id = ++request;
    if (!quiet && !scan) loading = true;
    try {
      const result = await readWechatSessions(LIMIT);
      if (id !== request) return;
      markFresh(result.sessions);
      scan = result;
      error = null;
    } catch {
      if (id === request) error = t('plugin.wechat.error');
    } finally {
      if (id === request) loading = false;
    }
  }

  function initial(contact: string): string {
    return [...contact.trim()][0] ?? '?';
  }

  /** Stable hue per contact, so the same chat keeps its avatar colour. */
  function hue(contact: string): number {
    let value = 0;
    for (const char of contact) {
      value = (value * 31 + (char.codePointAt(0) ?? 0)) % 360;
    }
    return value;
  }

  onMount(() => {
    void refresh();
    const poll = setInterval(() => void refresh(true), POLL_MS);
    const clock = setInterval(() => (now = Date.now()), 5_000);
    return () => {
      request++;
      clearInterval(poll);
      clearInterval(clock);
      if (flashTimer) clearTimeout(flashTimer);
    };
  });
</script>

<div class="panel">
  <header class="panel-head">
    <div class="heading">
      <span class="brand" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.8 9.8 0 0 1-3-.5L3 21l1.6-4.4A8.4 8.4 0 1 1 21 11.5Z" />
          <path d="M8 11h.01M12 11h.01M16 11h.01" />
        </svg>
      </span>
      <strong>{t('plugin.wechat')}</strong>
      {#if scan?.state === 'ok'}
        <span class="live">
          <span class="live-dot" aria-hidden="true"></span>
          {t('plugin.wechat.live')}
        </span>
      {/if}
    </div>
    <button
      class="refresh"
      onclick={() => void refresh()}
      disabled={loading}
      aria-label={t('plugin.wechat.refresh')}
      title={t('plugin.wechat.refresh')}
    >
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />
      </svg>
    </button>
  </header>

  {#if error}
    <p class="notice bad" role="alert">{error}</p>
  {:else if !scan || (loading && !scan)}
    <p class="empty">{t('common.loading')}</p>
  {:else if scan.state !== 'ok'}
    <div class="state" aria-live="polite">
      <span class="state-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.8 9.8 0 0 1-3-.5L3 21l1.6-4.4A8.4 8.4 0 1 1 21 11.5Z" />
          <path d="M9 12h6" />
        </svg>
      </span>
      <strong>{stateCopy.title}</strong>
      <p>{stateCopy.hint}</p>
    </div>
  {:else}
    <p class="summary">
      <span>{t('plugin.wechat.count', { count: scan.total })}</span>
      <span aria-hidden="true">·</span>
      <span>{t('plugin.wechat.readonly')}</span>
    </p>

    <ul class="sessions" aria-live="off">
      {#each scan.sessions as session (session.id)}
        <li class:fresh={fresh.has(session.id)}>
          <span class="avatar" style={`--h:${hue(session.contact)}`}>{initial(session.contact)}</span>
          <span class="body">
            <span class="top">
              <span class="contact" title={session.contact}>{session.contact}</span>
              {#if session.time}<span class="time">{session.time}</span>{/if}
            </span>
            <span class="preview" class:empty={!session.preview}>
              {session.preview || t('plugin.wechat.noMessage')}
            </span>
          </span>
        </li>
      {/each}
    </ul>

    <footer class="foot">
      <p class="privacy">{t('plugin.wechat.privacy')}</p>
      <span class="updated">{t('plugin.wechat.updated', { time: updated })}</span>
    </footer>
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
    gap: 0.5rem;
  }

  .heading {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
  }

  .brand {
    display: grid;
    place-items: center;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 0.375rem;
    background: color-mix(in srgb, #07c160 16%, var(--surface-2));
    color: #07c160;
    flex: none;
  }

  .panel-head strong {
    font-size: 0.8125rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .live {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.0625rem 0.375rem;
    border-radius: 999px;
    background: color-mix(in srgb, #07c160 12%, transparent);
    color: color-mix(in srgb, #07c160 78%, var(--text));
    font-size: 0.5625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .live-dot {
    width: 0.3125rem;
    height: 0.3125rem;
    border-radius: 999px;
    background: #07c160;
    animation: live-pulse 2.2s var(--ease-out) infinite;
  }

  .refresh {
    display: grid;
    place-items: center;
    width: 1.35rem;
    height: 1.35rem;
    border-radius: 0.375rem;
    color: var(--faint);
    flex: none;
  }

  .refresh:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  .refresh:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .summary {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    margin: 0;
    padding: 0.125rem 0.125rem 0;
    font-size: 0.625rem;
    color: var(--faint);
  }

  .sessions {
    display: flex;
    flex-direction: column;
    max-height: 15rem;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    list-style: none;
  }

  .sessions li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.25rem;
    border-top: 1px solid var(--border);
    border-radius: 0.375rem;
    transition: background var(--dur-ui) var(--ease-out);
    animation: row-in 240ms var(--ease-out) both;
  }

  .sessions li:hover {
    background: var(--surface-2);
  }

  .sessions li.fresh {
    animation: row-flash 1.5s var(--ease-out);
  }

  .avatar {
    display: grid;
    place-items: center;
    width: 1.9rem;
    height: 1.9rem;
    border: 1px solid hsl(var(--h) 58% 50% / 0.3);
    border-radius: 0.625rem;
    background: hsl(var(--h) 58% 50% / 0.14);
    color: var(--text);
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1;
    flex: none;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
    min-width: 0;
    flex: 1 1 auto;
  }

  .top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    min-width: 0;
  }

  .contact {
    overflow: hidden;
    font-size: 0.7188rem;
    font-weight: 600;
    color: var(--text);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .time {
    flex: none;
    font-size: 0.5625rem;
    color: var(--faint);
    font-variant-numeric: tabular-nums;
  }

  .preview {
    overflow: hidden;
    font-size: 0.6563rem;
    line-height: 1.35;
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preview.empty {
    color: var(--faint);
    font-style: italic;
  }

  .foot {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding-top: 0.1rem;
  }

  .privacy {
    margin: 0;
    font-size: 0.5938rem;
    line-height: 1.4;
    color: var(--faint);
  }

  .updated {
    font-size: 0.5625rem;
    color: var(--faint);
  }

  .state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.3rem;
    padding: 0.85rem 0.75rem 0.6rem;
    text-align: center;
  }

  .state-icon {
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 0.75rem;
    background: var(--surface-2);
    color: var(--faint);
  }

  .state strong {
    font-size: 0.75rem;
    font-weight: 600;
  }

  .state p {
    max-width: 18rem;
    margin: 0;
    font-size: 0.625rem;
    line-height: 1.45;
    color: var(--faint);
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

  @keyframes live-pulse {
    0%,
    100% {
      box-shadow: 0 0 0 0 color-mix(in srgb, #07c160 45%, transparent);
    }
    50% {
      box-shadow: 0 0 0 3px transparent;
    }
  }

  @keyframes row-in {
    from {
      opacity: 0;
      transform: translateY(-2px);
    }
  }

  @keyframes row-flash {
    0% {
      background: color-mix(in srgb, #07c160 16%, transparent);
    }
    100% {
      background: transparent;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .live-dot,
    .sessions li,
    .sessions li.fresh {
      animation: none;
    }
  }
</style>
