<!--
  Island → Calendar reminders. [FRONTEND]

  Local-first on purpose: the user exports or downloads an `.ics` file from
  Google Calendar, Outlook, Apple Calendar or any CalDAV client and imports
  it here. Parsing and recurrence expansion happen in `ics.ts`; events are
  cached in localStorage. No account, token, network request or CalDAV write.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { intlLocale, t } from '$lib/i18n/i18n.svelte';
  import { nextEvents, parseIcs, startsSoon, type CalendarEvent, type CalendarImport } from '$lib/plugins/ics';
  import { readPluginState, removePluginState, writePluginState } from '$lib/plugins/storage';

  const PLUGIN = 'calendar';
  const MAX_NAME = 80;

  let fileInput: HTMLInputElement;
  let data = $state<CalendarImport | null>(null);
  let now = $state(Date.now());
  let error = $state<string | null>(null);
  let imported = $state(false);
  let dragging = $state(false);

  const upcoming = $derived(nextEvents(data?.events ?? [], now, 5));
  const next = $derived(upcoming[0] ?? null);
  const rest = $derived(upcoming.slice(1));

  onMount(() => {
    const saved = readPluginState<CalendarImport | null>(PLUGIN, null);
    if (saved && Array.isArray(saved.events)) {
      data = {
        name: typeof saved.name === 'string' ? saved.name.slice(0, MAX_NAME) : '',
        importedAt: Number.isFinite(saved.importedAt) ? saved.importedAt : Date.now(),
        events: saved.events.filter((event) => Number.isFinite(event.startMs) && Number.isFinite(event.endMs)),
      };
    }
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });

  function pickFile() {
    fileInput?.click();
  }

  async function importFile(file: File) {
    error = null;
    imported = false;
    try {
      const text = await file.text();
      const events = parseIcs(text, Date.now());
      if (events.length === 0) {
        error = t('plugin.calendar.emptyFile');
        return;
      }
      data = { name: file.name.slice(0, MAX_NAME), importedAt: Date.now(), events };
      writePluginState(PLUGIN, data);
      now = Date.now();
      imported = true;
      setTimeout(() => (imported = false), 3000);
    } catch {
      error = t('plugin.calendar.unreadable');
    }
  }

  function onPicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void importFile(file);
    input.value = '';
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    const file = event.dataTransfer?.files?.[0];
    if (file) void importFile(file);
  }

  function clear() {
    data = null;
    error = null;
    removePluginState(PLUGIN);
  }

  // ---- formatting -------------------------------------------------------

  function dayKey(ms: number): string {
    const date = new Date(ms);
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  }

  function dayLabel(ms: number): string {
    const date = new Date(ms);
    const today = new Date(now);
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (dayKey(ms) === dayKey(today.getTime())) return t('plugin.calendar.today');
    if (dayKey(ms) === dayKey(tomorrow.getTime())) return t('plugin.calendar.tomorrow');
    return date.toLocaleDateString(intlLocale(), { month: 'short', day: 'numeric' });
  }

  function timeLabel(event: CalendarEvent): string {
    if (event.allDay) return t('plugin.calendar.allDay');
    return new Date(event.startMs).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' });
  }

  function countdown(event: CalendarEvent): string {
    const diff = event.startMs - now;
    if (diff <= 0) {
      if (event.endMs > now) return t('plugin.calendar.now');
      return '';
    }
    const minutes = Math.round(diff / 60_000);
    if (minutes < 60) return t('plugin.calendar.inMin', { count: Math.max(1, minutes) });
    if (minutes < 48 * 60) {
      const hours = Math.floor(minutes / 60);
      return t('plugin.calendar.inHour', { count: hours });
    }
    return t('plugin.calendar.inDay', { count: Math.round(minutes / (24 * 60)) });
  }

  function locationShort(value: string): string {
    return value.length > 42 ? `${value.slice(0, 41)}…` : value;
  }
</script>

<div class="panel">
  <header class="panel-head">
    <div class="heading">
      <strong>{t('plugin.calendar')}</strong>
      {#if data}<span class="source" title={data.name}>{data.name || t('plugin.calendar.local')}</span>{/if}
    </div>
    <div class="head-actions">
      {#if data}
        <button class="link" onclick={pickFile}>{t('plugin.calendar.replace')}</button>
        <button class="link quiet" onclick={clear}>{t('plugin.calendar.clear')}</button>
      {:else}
        <button class="link" onclick={pickFile}>{t('plugin.calendar.import')}</button>
      {/if}
    </div>
  </header>

  {#if !data}
    <button
      class="dropzone"
      class:dragging
      onclick={pickFile}
      ondragover={(e) => {
        e.preventDefault();
        dragging = true;
      }}
      ondragleave={() => (dragging = false)}
      ondrop={onDrop}
    >
      <svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
        <path d="M7 3v3M17 3v3M4 8h16M5 5h14a1 1 0 0 1 1 1v14H4V6a1 1 0 0 1 1-1ZM8 12h3M8 16h3M14 12h2" />
      </svg>
      <span>{t('plugin.calendar.choose')}</span>
      <small>{t('plugin.calendar.choose.hint')}</small>
    </button>
    <p class="privacy">{t('plugin.calendar.privacy')}</p>
  {:else if upcoming.length === 0}
    <p class="empty">{t('plugin.calendar.noUpcoming')}</p>
  {:else}
    {#if next}
      {@const soon = startsSoon(next, now)}
      <div class="hero" class:soon>
        <div class="hero-when">
          <span class="day">{dayLabel(next.startMs)}</span>
          <span class="clock">{timeLabel(next)}</span>
        </div>
        <div class="hero-body">
          <span class="hero-title">{next.title || t('plugin.calendar.untitled')}</span>
          {#if next.location}<span class="hero-loc" title={next.location}>{locationShort(next.location)}</span>{/if}
        </div>
        <span class="countdown" class:urgent={soon}>{soon ? t('plugin.calendar.soon') : countdown(next)}</span>
      </div>
    {/if}

    {#if rest.length > 0}
      <ul class="agenda">
        {#each rest as event (event.id)}
          <li class:soon={startsSoon(event, now)}>
            <span class="when">
              <span class="day">{dayLabel(event.startMs)}</span>
              <span class="clock">{timeLabel(event)}</span>
            </span>
            <span class="body">
              <span class="title">{event.title || t('plugin.calendar.untitled')}</span>
              {#if event.location}<span class="loc" title={event.location}>{locationShort(event.location)}</span>{/if}
            </span>
            <span class="in">{countdown(event)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  {#if imported}
    <p class="note ok" role="status">{t('plugin.calendar.imported', { count: data?.events.length ?? 0 })}</p>
  {:else if error}
    <p class="note bad" role="alert">{error}</p>
  {/if}

  <input class="hidden" type="file" accept=".ics,text/calendar" bind:this={fileInput} onchange={onPicked} />
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
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
    max-width: 8rem;
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

  .dropzone:hover,
  .dropzone.dragging {
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

  .privacy {
    margin: 0;
    font-size: 0.5938rem;
    line-height: 1.4;
    color: var(--faint);
    text-align: center;
  }

  .hero {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.55rem 0.625rem;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: linear-gradient(135deg, var(--surface-2), transparent 130%);
    transition: border-color var(--dur-ui) var(--ease-out);
  }

  .hero.soon {
    border-color: var(--warn);
  }

  .hero-when,
  .when {
    display: flex;
    flex-direction: column;
    flex: none;
    width: 4rem;
  }

  .day {
    font-size: 0.625rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .clock {
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }

  .hero-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1 1 auto;
  }

  .hero-title {
    overflow: hidden;
    font-size: 0.7813rem;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hero-loc {
    overflow: hidden;
    font-size: 0.625rem;
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .countdown {
    flex: none;
    padding: 0.125rem 0.375rem;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--muted);
    font-size: 0.5938rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .countdown.urgent {
    background: color-mix(in srgb, var(--warn) 18%, transparent);
    color: var(--warn);
  }

  .agenda {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .agenda li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.125rem;
    border-radius: 0.5rem;
  }

  .agenda li + li {
    border-top: 1px solid var(--border);
  }

  .agenda li.soon .title {
    color: var(--warn);
  }

  .agenda .when {
    width: 3.75rem;
  }

  .body {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
  }

  .title {
    overflow: hidden;
    font-size: 0.7188rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .loc {
    overflow: hidden;
    font-size: 0.5938rem;
    color: var(--faint);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .in {
    flex: none;
    color: var(--faint);
    font-size: 0.5938rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .empty {
    margin: 0;
    padding: 0.5rem 0;
    font-size: 0.6875rem;
    color: var(--muted);
  }

  .note {
    margin: 0;
    font-size: 0.625rem;
  }

  .note.ok {
    color: var(--ok);
  }

  .note.bad {
    color: var(--critical);
  }

  .hidden {
    display: none;
  }
</style>
