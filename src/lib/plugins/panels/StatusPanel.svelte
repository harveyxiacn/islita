<!--
  Island → Service status. The official Claude and OpenAI Statuspage summaries:
  indicator, human-readable description, last update and up to three recent
  incidents. The backend caches the combined report for 60 s; this panel
  refreshes it every 5 minutes while it stays mounted and offers an explicit
  refresh/retry. [FRONTEND]
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { openExternal, serviceStatus } from '$lib/api';
  import { formatAgo } from '$lib/format';
  import { intlLocale, t, tDyn } from '$lib/i18n/i18n.svelte';
  import {
    impactKey,
    indicatorKey,
    indicatorTone,
    normalizeImpact,
    stateKey,
    type ServiceStatus,
    type ServiceStatusReport,
  } from '$lib/plugins/status';

  const AUTO_REFRESH_MS = 5 * 60_000;
  const CLOCK_MS = 30_000;

  let report = $state<ServiceStatusReport | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let now = $state(Date.now());

  /** Monotonic id so a slow response cannot overwrite a newer one. */
  let request = 0;

  async function refresh(force = false) {
    const id = ++request;
    if (!report) loading = true;
    busy = true;
    try {
      const next = await serviceStatus(force);
      if (id !== request) return;
      report = next;
      error = null;
      now = Date.now();
    } catch (cause) {
      if (id !== request) return;
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (id === request) {
        busy = false;
        loading = false;
      }
    }
  }

  onMount(() => {
    void refresh();
    const auto = setInterval(() => void refresh(false), AUTO_REFRESH_MS);
    const clock = setInterval(() => (now = Date.now()), CLOCK_MS);
    return () => {
      request += 1;
      clearInterval(auto);
      clearInterval(clock);
    };
  });

  function serviceLabel(service: ServiceStatus): string {
    switch (service.id) {
      case 'claude':
        return t('plugin.status.claude');
      case 'openai':
        return t('plugin.status.openai');
      default:
        return service.name.trim() || service.id;
    }
  }

  function incidentState(state: string): string {
    const key = stateKey(state);
    return key ? tDyn(key) : state;
  }

  function absoluteDate(iso: string): string {
    const time = Date.parse(iso);
    return Number.isFinite(time) ? new Date(time).toLocaleString(intlLocale()) : iso;
  }

  function openLink(event: MouseEvent, url: string) {
    event.preventDefault();
    if (url) void openExternal(url);
  }
</script>

<div class="panel" aria-busy={busy}>
  <header class="panel-head">
    <div class="heading">
      <strong>{t('plugin.status')}</strong>
      <span class="auto">{t('plugin.status.auto')}</span>
    </div>
    <button
      class="refresh"
      onclick={() => void refresh(true)}
      disabled={busy}
      aria-label={t('plugin.status.refresh')}
      title={t('plugin.status.refresh')}
    >
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />
      </svg>
      <span>{t('plugin.status.refresh')}</span>
    </button>
  </header>

  {#if loading && !report}
    <p class="loading" role="status">{t('plugin.status.loading')}</p>
  {:else}
    {#if error && report}
      <p class="panel-error" role="alert">{t('plugin.status.error', { message: error })}</p>
    {/if}

    {#if report}
      <ul class="services">
        {#each report.services as service (service.id)}
          {@const tone = service.error ? 'unknown' : indicatorTone(service.indicator)}
          <li class="service" data-service={service.id} aria-label={serviceLabel(service)}>
            <div class="service-head">
              <span class="dot" data-tone={tone} aria-hidden="true"></span>
              <span class="name">{serviceLabel(service)}</span>
              <span class="indicator" data-tone={tone}>
                {service.error ? t('plugin.status.indicator.unknown') : tDyn(indicatorKey(service.indicator))}
              </span>
            </div>

            {#if service.error}
              <div class="service-error" role="alert">
                <p>{t('plugin.status.error', { message: service.error })}</p>
                <button class="link" onclick={() => void refresh(true)} disabled={busy}>
                  {t('plugin.status.retry')}
                </button>
              </div>
            {:else}
              {#if service.description}
                <p class="description">{service.description}</p>
              {/if}

              <div class="meta">
                {#if service.updatedAt}
                  <span class="updated" title={absoluteDate(service.updatedAt)}>
                    {t('plugin.status.updated', { time: formatAgo(service.updatedAt, now) })}
                  </span>
                {:else}
                  <span></span>
                {/if}
                <a
                  class="link"
                  href={service.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  onclick={(event) => openLink(event, service.url)}
                >
                  {t('plugin.status.open')}
                </a>
              </div>

              <div class="incidents">
                <span class="section-label">{t('plugin.status.incidents')}</span>
                {#if service.incidents.length === 0}
                  <p class="empty">{t('plugin.status.noIncidents')}</p>
                {:else}
                  <ul>
                    {#each service.incidents as incident (incident.name + (incident.createdAt ?? ''))}
                      <li class="incident">
                        <div class="badges">
                          <span class="badge impact" data-impact={normalizeImpact(incident.impact)}>
                            {tDyn(impactKey(incident.impact))}
                          </span>
                          <span class="badge state">{incidentState(incident.status)}</span>
                          <span class="incident-time">
                            {formatAgo(incident.updatedAt ?? incident.createdAt, now)}
                          </span>
                        </div>
                        {#if incident.shortlink}
                          <a
                            class="incident-link"
                            href={incident.shortlink}
                            target="_blank"
                            rel="noreferrer noopener"
                            title={incident.shortlink}
                            onclick={(event) => openLink(event, incident.shortlink)}
                          >
                            {incident.name}
                          </a>
                        {:else}
                          <span class="incident-name">{incident.name}</span>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {:else if error}
      <div class="panel-error" role="alert">
        <p>{t('plugin.status.error', { message: error })}</p>
        <button class="retry" onclick={() => void refresh(true)} disabled={busy}>
          {t('plugin.status.retry')}
        </button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 20rem;
    max-width: calc(100vw - 2rem);
  }

  .panel-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .heading {
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
    min-width: 0;
  }

  .heading strong {
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .auto {
    font-size: 0.5938rem;
    color: var(--faint);
  }

  .refresh {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    flex: none;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--muted);
    font-size: 0.625rem;
  }

  .refresh:hover:not(:disabled) {
    border-color: var(--border-strong, var(--border));
    color: var(--text);
  }

  .refresh:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .loading {
    margin: 0;
    padding: 0.35rem 0;
    font-size: 0.6875rem;
    color: var(--muted);
  }

  .services {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .service {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.5rem 0.55rem;
    border: 1px solid var(--border);
    border-radius: 0.6rem;
    background: var(--surface-2);
  }

  .service-head {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
  }

  .dot {
    flex: none;
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 50%;
    background: var(--faint);
  }

  .dot[data-tone='ok'] {
    background: var(--ok);
  }

  .dot[data-tone='warn'] {
    background: var(--warn);
  }

  .dot[data-tone='critical'] {
    background: var(--critical);
  }

  .dot[data-tone='info'] {
    background: var(--focus);
  }

  .dot[data-tone='unknown'] {
    background: var(--faint);
  }

  .name {
    font-size: 0.75rem;
    font-weight: 600;
  }

  .indicator {
    margin-left: auto;
    overflow: hidden;
    font-size: 0.625rem;
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .indicator[data-tone='warn'] {
    color: var(--warn);
  }

  .indicator[data-tone='critical'] {
    color: var(--critical);
  }

  .description {
    margin: 0;
    font-size: 0.6875rem;
    line-height: 1.4;
    color: var(--text);
  }

  .meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.625rem;
    color: var(--faint);
  }

  .link {
    flex: none;
    padding: 0;
    border: 0;
    border-radius: 0.2rem;
    background: none;
    color: var(--focus);
    font-size: 0.625rem;
    text-decoration: none;
  }

  .link:hover {
    text-decoration: underline;
  }

  .link:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .incidents {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding-top: 0.15rem;
    border-top: 1px solid var(--border);
  }

  .section-label {
    font-size: 0.5625rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--faint);
  }

  .empty {
    margin: 0;
    font-size: 0.625rem;
    color: var(--muted);
  }

  .incidents ul {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin: 0.1rem 0 0;
    padding: 0;
    list-style: none;
  }

  .incident {
    display: flex;
    flex-direction: column;
    gap: 0.12rem;
    padding: 0.28rem 0.35rem;
    border-radius: 0.4rem;
    background: color-mix(in srgb, var(--text) 5%, transparent);
  }

  .badges {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
  }

  .badge {
    flex: none;
    padding: 0 0.28rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--muted);
    font-size: 0.5625rem;
    line-height: 1.4;
  }

  .badge.impact[data-impact='minor'] {
    border-color: color-mix(in srgb, var(--warn) 45%, var(--border));
    color: var(--warn);
  }

  .badge.impact[data-impact='major'] {
    border-color: color-mix(in srgb, var(--critical) 45%, var(--border));
    color: var(--critical);
  }

  .badge.impact[data-impact='critical'] {
    border-color: var(--critical);
    color: var(--critical);
  }

  .incident-time {
    margin-left: auto;
    font-size: 0.5625rem;
    color: var(--faint);
  }

  .incident-link,
  .incident-name {
    overflow: hidden;
    font-size: 0.6563rem;
    line-height: 1.35;
    text-overflow: ellipsis;
  }

  .incident-link {
    color: var(--text);
    text-decoration: none;
  }

  .incident-link:hover {
    text-decoration: underline;
  }

  .panel-error,
  .service-error {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.3rem;
    padding: 0.4rem 0.5rem;
    border: 1px solid color-mix(in srgb, var(--critical) 40%, var(--border));
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--critical) 8%, var(--surface-2));
  }

  .panel-error p,
  .service-error p {
    margin: 0;
    font-size: 0.6563rem;
    line-height: 1.4;
    color: var(--critical);
  }

  .retry {
    padding: 0.15rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text);
    font-size: 0.625rem;
  }

  .retry:hover:not(:disabled) {
    border-color: var(--border-strong, var(--border));
  }

  .retry:disabled {
    opacity: 0.55;
    cursor: default;
  }

  @media (prefers-reduced-motion: reduce) {
    .refresh,
    .retry,
    .link,
    .dot {
      transition: none;
      animation: none;
    }
  }
</style>
