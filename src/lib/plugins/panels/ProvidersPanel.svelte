<!--
  Island → Providers. One compact row per provider: track (poll) and show on
  the bar. Turning "Track" off removes the provider from the bar, the popover
  and the overview, which is exactly the "only show what I monitor"
  behaviour. [FRONTEND]
-->
<script lang="ts">
  import Toggle from '$lib/components/dashboard/Toggle.svelte';
  import ProviderLogo from '$lib/components/ProviderLogo.svelte';
  import { openDashboard } from '$lib/api';
  import { formatPercent } from '$lib/format';
  import { t } from '$lib/i18n/i18n.svelte';
  import { providerDisplayName } from '$lib/providers';
  import { settings } from '$lib/stores/settings.svelte';
  import { snapshot } from '$lib/stores/snapshot.svelte';
  import type { ProviderId } from '$lib/types';

  const s = $derived(settings.value);

  /** Every provider the settings know about, in display order. */
  const rows = $derived.by(() => {
    const ids = new Set<ProviderId>(Object.keys(s.providers));
    for (const quota of snapshot.value?.providers ?? []) ids.add(quota.provider);
    return [...ids].sort((a, b) => (s.providers[a]?.order ?? 0) - (s.providers[b]?.order ?? 0));
  });

  const quotaOf = (id: ProviderId) => snapshot.value?.providers.find((q) => q.provider === id) ?? null;
  const nameOf = (id: ProviderId) => quotaOf(id)?.displayName ?? providerDisplayName(id);

  /** The provider's primary window, for the one-glance percentage. */
  function percentOf(id: ProviderId): string | null {
    const q = quotaOf(id);
    if (!q) return null;
    const w = q.windows.find((window) => window.isPrimary) ?? q.windows[0];
    return w ? formatPercent(w.usedPercent, s.percentMode) : null;
  }

  function severityOf(id: ProviderId): string {
    const q = quotaOf(id);
    if (!q) return 'normal';
    let peak = -1;
    for (const w of q.windows) peak = Math.max(peak, w.usedPercent);
    if (peak >= s.thresholds.critical) return 'critical';
    if (peak >= s.thresholds.warn) return 'warn';
    return 'normal';
  }
</script>

<div class="panel">
  <header class="panel-head">
    <div>
      <strong>{t('plugin.providers')}</strong>
      <p>{t('plugin.providers.hint')}</p>
    </div>
    <button class="link" onclick={() => void openDashboard('settings')}>{t('plugin.providers.manage')}</button>
  </header>

  <ul class="providers">
    {#each rows as id (id)}
      {@const enabled = s.providers[id]?.enabled ?? true}
      {@const onBar = s.providers[id]?.showInSidebar ?? true}
      {@const percent = percentOf(id)}
      <li class:off={!enabled}>
        <span class="logo" style:color={`var(--accent-${id}, var(--accent-fallback))`}>
          <ProviderLogo provider={id} size={18} />
        </span>
        <span class="who">
          <span class="name">{nameOf(id)}</span>
          <span class="state">
            {#if enabled}
              <span class="dot" data-severity={severityOf(id)} aria-hidden="true"></span>
              <span>{percent ?? t('plugin.providers.waiting')}</span>
            {:else}
              <span>{t('plugin.providers.off')}</span>
            {/if}
          </span>
        </span>
        <span class="switch">
          <span class="cap">{t('settings.providerEnabled.short')}</span>
          <Toggle
            checked={enabled}
            label={`${nameOf(id)} — ${t('settings.providerEnabled')}`}
            onchange={(v) => void settings.patchProvider(id, { enabled: v })}
          />
        </span>
        <span class="switch" class:dim={!enabled}>
          <span class="cap">{t('settings.sidebarItems.provider.short')}</span>
          <Toggle
            checked={onBar}
            disabled={!enabled}
            label={`${nameOf(id)} — ${t('settings.sidebarItems.provider')}`}
            onchange={(v) => void settings.patchProvider(id, { showInSidebar: v })}
          />
        </span>
      </li>
    {/each}
  </ul>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: 22rem;
    max-width: calc(100vw - 2rem);
    user-select: none;
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

  .providers {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3125rem 0;
    border-top: 1px solid var(--border);
  }

  li:first-child {
    border-top: none;
  }

  li.off {
    opacity: 0.62;
  }

  .logo {
    display: grid;
    place-items: center;
    flex: none;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 999px;
    background: var(--surface-2);
  }

  .who {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
  }

  .name {
    overflow: hidden;
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .state {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.625rem;
    color: var(--muted);
  }

  .dot {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 999px;
    background: var(--ok, #30d158);
  }

  .dot[data-severity='warn'] {
    background: var(--warn);
  }

  .dot[data-severity='critical'] {
    background: var(--critical);
  }

  .switch {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.0625rem;
    flex: none;
  }

  .switch.dim {
    opacity: 0.5;
  }

  .cap {
    font-size: 0.5625rem;
    line-height: 1;
    color: var(--faint);
    white-space: nowrap;
  }

  /* keep the panel visually dense: the dashboard switch is 2.25rem wide */
  .switch :global(.switch) {
    transform: scale(0.78);
    transform-origin: center;
    margin: -0.125rem 0;
  }
</style>
