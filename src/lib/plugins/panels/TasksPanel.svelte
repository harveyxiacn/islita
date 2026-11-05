<!--
  Island → Completed tasks. The finished Claude Code / Codex turns detected in
  the local session index. This is the read-only, local half of the
  task-completion feature; the backend sends the same completion to the OS
  notification channel when `notifications` and `taskNotifications` are on.
  It never renders prompt or response text. [FRONTEND]
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import ProviderLogo from '$lib/components/ProviderLogo.svelte';
  import { listTaskCompletions, onTaskCompleted, openDashboard } from '$lib/api';
  import { formatAgo } from '$lib/format';
  import { t } from '$lib/i18n/i18n.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import type { TaskCompletion } from '$lib/session-types';
  import type { ProviderId } from '$lib/types';

  const s = $derived(settings.value);
  const PLUGIN_WINDOW_MS = 24 * 3_600_000;
  const LIMIT = 5;

  let rows = $state<TaskCompletion[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let now = $state(Date.now());
  let request = 0;

  function providerEnabled(provider: string): boolean {
    return s.providers[provider as ProviderId]?.enabled ?? true;
  }

  function onePerSession(tasks: TaskCompletion[]): TaskCompletion[] {
    const seen = new Set<string>();
    const out: TaskCompletion[] = [];
    for (const task of tasks) {
      const key = `${task.provider}\0${task.sessionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(task);
    }
    return out.slice(0, LIMIT);
  }

  /** Reacts to provider switches without waiting for the next refresh. */
  const visible = $derived(onePerSession(rows.filter((task) => providerEnabled(task.provider))));

  async function load() {
    if (!s.ingestEnabled) {
      loading = false;
      rows = [];
      return;
    }
    const id = ++request;
    loading = true;
    try {
      const result = await listTaskCompletions({ sinceMs: Date.now() - PLUGIN_WINDOW_MS, limit: LIMIT * 2 });
      if (id !== request) return;
      rows = result;
      error = null;
    } catch (e) {
      if (id === request) error = String(e);
    } finally {
      if (id === request) loading = false;
    }
  }

  onMount(() => {
    let disposed = false;
    let unlisten: () => void = () => {};
    void load();
    const clock = setInterval(() => (now = Date.now()), 15_000);
    const refresh = setInterval(() => void load(), 60_000);
    void onTaskCompleted((task) => {
      if (!providerEnabled(task.provider)) return;
      // A live completion is newer than anything an in-flight list can return.
      request++;
      loading = false;
      rows = [
        task,
        ...rows.filter((row) => row.provider !== task.provider || row.sessionId !== task.sessionId),
      ].slice(0, LIMIT * 4);
      now = Date.now();
    }).then((un) => {
      if (disposed) un();
      else unlisten = un;
    });
    return () => {
      disposed = true;
      request++;
      unlisten();
      clearInterval(clock);
      clearInterval(refresh);
    };
  });

  function titleOf(task: TaskCompletion): string {
    return task.title?.trim() || projectOf(task) || t('plugin.tasks.untitled');
  }

  function projectOf(task: TaskCompletion): string {
    return (
      task.project
        .split(/[\\/]/)
        .filter((part) => part && part !== '.' && part !== '..')
        .pop() ?? ''
    );
  }
</script>

<div class="panel">
  <header class="panel-head">
    <div>
      <strong>{t('plugin.tasks')}</strong>
      <p>{t('plugin.tasks.hint')}</p>
    </div>
    <button class="link" onclick={() => void openDashboard('sessions')}>{t('plugin.tasks.open')}</button>
  </header>

  {#if !s.ingestEnabled}
    <p class="empty">{t('plugin.tasks.disabled')}</p>
  {:else if error}
    <p class="empty bad" role="alert">{t('common.error', { message: error })}</p>
  {:else if loading && visible.length === 0}
    <p class="empty">{t('common.loading')}</p>
  {:else if visible.length === 0}
    <p class="empty">{t('plugin.tasks.empty')}</p>
  {:else}
    <ul class="rows">
      {#each visible as task (task.provider + task.sessionId)}
        <li>
          <button class="row" onclick={() => void openDashboard('sessions')}>
            <span class="logo" style:color={`var(--accent-${task.provider}, var(--accent-fallback))`}>
              <ProviderLogo provider={task.provider} size={16} />
            </span>
            <span class="who">
              <span class="title">{titleOf(task)}</span>
              <span class="meta">
                <span class="done" aria-hidden="true"></span>
                <span>{projectOf(task) || t('plugin.tasks.local')}</span>
                <span>·</span>
                <span>{formatAgo(new Date(task.finishedAt).toISOString(), now)}</span>
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
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .panel-head strong {
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .panel-head p {
    margin: 0.125rem 0 0;
    font-size: 0.6875rem;
    line-height: 1.35;
    color: var(--muted);
  }

  .link {
    flex: none;
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
    line-height: 1.4;
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
    flex: 1 1 auto;
    min-width: 0;
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

  .meta > span:nth-child(2) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .done {
    flex: none;
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 999px;
    background: var(--ok, #30d158);
  }
</style>
