<!--
  Island → Focus timer. A small 25/5 countdown for the "one more turn" loop.
  It is deliberately local: no backend, no notification permission, no account.
  A deadline is persisted so the countdown survives an app restart. [FRONTEND]
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n/i18n.svelte';
  import { readPluginState, writePluginState } from '$lib/plugins/storage';

  type Mode = 'focus' | 'break';

  interface TimerState {
    mode: Mode;
    durationSec: number;
    remainingSec: number;
    endsAt: number | null;
    done: boolean;
  }

  const PLUGIN = 'timer';
  const DURATIONS: Record<Mode, number> = { focus: 25 * 60, break: 5 * 60 };

  let mode = $state<Mode>('focus');
  let durationSec = $state(DURATIONS.focus);
  let remainingSec = $state(DURATIONS.focus);
  let endsAt = $state<number | null>(null);
  let done = $state(false);
  let now = $state(Date.now());

  const running = $derived(endsAt !== null);

  function snapshot(): TimerState {
    return { mode, durationSec, remainingSec, endsAt, done };
  }

  function persist() {
    writePluginState(PLUGIN, snapshot());
  }

  function tick() {
    if (endsAt === null) return;
    now = Date.now();
    remainingSec = Math.max(0, Math.ceil((endsAt - now) / 1000));
    if (remainingSec === 0) {
      endsAt = null;
      done = true;
      persist();
    }
  }

  $effect(() => {
    if (endsAt === null) return;
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  });

  onMount(() => {
    const state = readPluginState<TimerState | null>(PLUGIN, null);
    if (!state || (state.mode !== 'focus' && state.mode !== 'break')) return;
    mode = state.mode;
    durationSec = Number.isFinite(state.durationSec) && state.durationSec > 0 ? state.durationSec : DURATIONS[mode];
    done = Boolean(state.done);
    if (typeof state.endsAt === 'number' && state.endsAt > Date.now()) {
      endsAt = state.endsAt;
      remainingSec = Math.max(1, Math.ceil((endsAt - Date.now()) / 1000));
    } else if (state.endsAt !== null && state.endsAt !== undefined) {
      // the app was closed while a countdown ran: it finished in the meantime
      remainingSec = 0;
      endsAt = null;
      done = true;
    } else {
      remainingSec = Math.max(0, Math.min(durationSec, state.remainingSec ?? durationSec));
    }
    now = Date.now();
  });

  function start() {
    if (remainingSec <= 0) remainingSec = durationSec;
    endsAt = Date.now() + remainingSec * 1000;
    done = false;
    now = Date.now();
    persist();
  }

  function pause() {
    if (endsAt === null) return;
    remainingSec = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    endsAt = null;
    persist();
  }

  function reset() {
    endsAt = null;
    done = false;
    remainingSec = durationSec;
    now = Date.now();
    persist();
  }

  function setMode(next: Mode) {
    mode = next;
    durationSec = DURATIONS[next];
    endsAt = null;
    done = false;
    remainingSec = durationSec;
    now = Date.now();
    persist();
  }

  const clock = $derived.by(() => {
    const total = Math.max(0, remainingSec);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  });

  const progress = $derived(durationSec > 0 ? Math.min(1, Math.max(0, 1 - remainingSec / durationSec)) : 0);
</script>

<div class="panel">
  <header class="panel-head">
    <strong>{t('plugin.timer')}</strong>
    <span class="modes" role="group" aria-label={t('plugin.timer.mode')}>
      <button class:active={mode === 'focus'} aria-pressed={mode === 'focus'} onclick={() => setMode('focus')}>
        {t('plugin.timer.focus')}
      </button>
      <button class:active={mode === 'break'} aria-pressed={mode === 'break'} onclick={() => setMode('break')}>
        {t('plugin.timer.break')}
      </button>
    </span>
  </header>

  <div class="clock-row">
    <span class="clock" class:done role="timer" aria-live="off">{clock}</span>
    <div class="actions">
      {#if running}
        <button class="btn primary" onclick={pause}>{t('plugin.timer.pause')}</button>
      {:else}
        <button class="btn primary" onclick={start}>{done ? t('plugin.timer.again') : t('plugin.timer.start')}</button>
      {/if}
      <button class="btn" onclick={reset}>{t('plugin.timer.reset')}</button>
    </div>
  </div>

  <div class="track" aria-hidden="true"><span style:width={`${Math.round(progress * 100)}%`}></span></div>

  <p class="hint" aria-live="polite">
    {done ? t('plugin.timer.done') : running ? t('plugin.timer.running', {
      mode: mode === 'focus' ? t('plugin.timer.focus') : t('plugin.timer.break')
    }) : t('plugin.timer.tip')}
  </p>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
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

  .modes {
    display: inline-flex;
    padding: 0.125rem;
    border-radius: 999px;
    background: var(--surface-2);
    border: 1px solid var(--border);
  }

  .modes button {
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    font-size: 0.625rem;
    color: var(--muted);
  }

  .modes button.active {
    background: var(--surface-3, var(--surface-2));
    color: var(--text);
  }

  .clock-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .clock {
    font-variant-numeric: tabular-nums;
    font-size: 1.75rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    line-height: 1;
  }

  .clock.done {
    color: var(--warn);
    animation: timer-done 600ms var(--ease-out) 2;
  }

  @keyframes timer-done {
    50% {
      opacity: 0.45;
    }
  }

  .actions {
    display: flex;
    gap: 0.375rem;
  }

  .btn {
    padding: 0.25rem 0.625rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-2);
    font-size: 0.6875rem;
  }

  .btn:hover {
    border-color: var(--border-strong, var(--border));
  }

  .btn.primary {
    background: var(--focus);
    border-color: transparent;
    color: #fff;
  }

  .track {
    height: 0.25rem;
    border-radius: 999px;
    background: var(--surface-3, var(--surface-2));
    overflow: hidden;
  }

  .track span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--focus);
    transition: width 300ms linear;
  }

  .hint {
    margin: 0;
    font-size: 0.625rem;
    color: var(--muted);
  }
</style>
