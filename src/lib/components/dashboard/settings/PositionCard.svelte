<!-- Settings → Position: edge, alignment, offset, monitor. [FRONTEND] -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Field from '../Field.svelte';
  import Toggle from '../Toggle.svelte';
  import SettingsCard from './SettingsCard.svelte';
  import ProviderLogo from '$lib/components/ProviderLogo.svelte';
  import { getMonitors } from '$lib/api';
  import { t, tDyn } from '$lib/i18n/i18n.svelte';
  import { enabledPlugins } from '$lib/plugins/enabled';
  import { ISLAND_PLUGINS } from '$lib/plugins/registry';
  import { settings } from '$lib/stores/settings.svelte';
  import { rings } from '$lib/stores/rings.svelte';
  import type { Edge, MonitorInfo, ProviderId, VerticalAlign } from '$lib/types';

  const s = $derived(settings.value);

  let monitors = $state<MonitorInfo[]>([]);
  let error = $state<string | null>(null);

  onMount(() => {
    void getMonitors().then((m) => (monitors = m)).catch((e) => (error = String(e)));
  });

  const EDGES: Edge[] = ['left', 'right', 'top', 'bottom'];
  const ALIGNS: VerticalAlign[] = ['top', 'center', 'bottom'];
  /**
   * `verticalAlign`/`verticalOffset` describe the position *along* the docked
   * edge, so on a top/bottom edge they are horizontal. The wire values stay
   * `top|center|bottom`; only the labels follow the orientation (top → left,
   * bottom → right).
   */
  const alongIsHorizontal = $derived(s.edge === 'top' || s.edge === 'bottom');
  const ALIGN_LABELS: Record<VerticalAlign, string> = { top: 'left', center: 'center', bottom: 'right' };
  const alignLabel = (v: VerticalAlign) =>
    alongIsHorizontal ? `settings.horizontalAlign.${ALIGN_LABELS[v]}` : `settings.verticalAlign.${v}`;
  const num = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);

  /** At most one ring per quota key, in the bar's own order. */
  const idleProviderOptions = $derived.by(() => {
    const seen = new Set<string>();
    const options = rings.items
      .filter((item) => {
        if (seen.has(item.quotaKey)) return false;
        seen.add(item.quotaKey);
        return true;
      })
      .map((item) => ({ key: item.quotaKey, provider: item.provider, name: item.quota.displayName }));
    // A chosen extra account can disappear from the bar (provider switched
    // off). Keep it visible so it can be removed instead of silently using
    // one of the six slots.
    for (const key of s.islandIdle.providers) {
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ key, provider: key.split('@')[0] as ProviderId, name: key });
    }
    return options;
  });

  function toggleIdleProvider(key: string) {
    const current = s.islandIdle.providers;
    const providers = current.includes(key)
      ? current.filter((id) => id !== key)
      : [...current, key].slice(0, 6);
    if (current.includes(key) || current.length < 6) {
      void settings.patch({ islandIdle: { providers } });
    }
  }

  /**
   * Only switched-on modules can be picked for the idle capsule. A selection
   * that points at a disabled plugin stays saved (so it returns when the
   * module is switched back on) but does not consume one of the six slots.
   */
  const idlePluginOptions = $derived(enabledPlugins(ISLAND_PLUGINS, s.disabledPlugins));
  const idlePluginIds = $derived(new Set(idlePluginOptions.map((plugin) => plugin.id)));
  const visibleIdlePlugins = $derived(
    s.islandIdle.plugins.filter((id) => idlePluginIds.has(id))
  );

  function toggleIdlePlugin(id: string) {
    const current = visibleIdlePlugins;
    if (!current.includes(id) && current.length >= 6) return;
    const plugins = current.includes(id)
      ? current.filter((value) => value !== id)
      : [...current, id];
    void settings.patch({ islandIdle: { plugins } });
  }
</script>

<SettingsCard id="position" title={t('settings.position')} reset="position">
  {#if error}<p class="err" role="alert">{t('common.error', { message: error })}</p>{/if}

  <Field label={t('settings.island')} hint={t('settings.island.hint')}>
    <Toggle
      checked={s.island}
      label={t('settings.island')}
      onchange={(v) => void settings.patch({ island: v })}
    />
  </Field>

  {#if s.island}
    <Field label={t('settings.islandMargin')}>
      <input
        class="field num"
        type="number"
        min="0"
        max="64"
        step="1"
        value={s.islandMargin}
        onchange={(e) => void settings.patch({ islandMargin: Math.round(num(e)) })}
        aria-label={t('settings.islandMargin')}
      />
    </Field>

    <Field label={t('settings.islandAutoHide')} hint={t('settings.islandAutoHide.hint')}>
      <Toggle
        checked={s.islandAutoHide}
        label={t('settings.islandAutoHide')}
        onchange={(v) => void settings.patch({ islandAutoHide: v })}
      />
    </Field>

    <Field label={t('settings.islandIdleProviders')} hint={t('settings.islandIdleProviders.hint')} wide>
      {#if idleProviderOptions.length > 0}
        <div class="picks" role="group" aria-label={t('settings.islandIdleProviders')}>
          {#each idleProviderOptions as option (option.key)}
            {@const picked = s.islandIdle.providers.includes(option.key)}
            <button
              type="button"
              class="pick"
              class:on={picked}
              aria-pressed={picked}
              disabled={!picked && s.islandIdle.providers.length >= 6}
              onclick={() => toggleIdleProvider(option.key)}
            >
              <ProviderLogo provider={option.provider} size={16} />
              <span>{option.name}</span>
            </button>
          {/each}
        </div>
      {:else}
        <p class="note">{t('settings.islandIdleProviders.empty')}</p>
      {/if}
    </Field>

    <Field label={t('settings.islandIdlePlugins')} hint={t('settings.islandIdlePlugins.hint')} wide>
      {#if idlePluginOptions.length > 0}
        <div class="picks" role="group" aria-label={t('settings.islandIdlePlugins')}>
          {#each idlePluginOptions as plugin (plugin.id)}
            {@const picked = s.islandIdle.plugins.includes(plugin.id)}
            <button
              type="button"
              class="pick"
              class:on={picked}
              aria-pressed={picked}
              disabled={!picked && visibleIdlePlugins.length >= 6}
              onclick={() => toggleIdlePlugin(plugin.id)}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d={plugin.icon}></path>
              </svg>
              <span>{tDyn(plugin.label)}</span>
            </button>
          {/each}
        </div>
      {:else}
        <p class="note">{t('settings.islandIdlePlugins.none')}</p>
      {/if}
    </Field>
  {/if}

  <Field label={t('settings.edge')}>
    <select aria-label={t('settings.edge')} class="field" value={s.edge} disabled={s.island} onchange={(e) => void settings.patch({ edge: e.currentTarget.value as Edge })}>
      {#each EDGES as v (v)}<option value={v}>{tDyn(`settings.edge.${v}`)}</option>{/each}
    </select>
  </Field>

  <Field label={tDyn(alongIsHorizontal ? 'settings.horizontalAlign' : 'settings.verticalAlign')}>
    <select aria-label={tDyn(alongIsHorizontal ? 'settings.horizontalAlign' : 'settings.verticalAlign')} class="field" value={s.verticalAlign} disabled={s.island} onchange={(e) => void settings.patch({ verticalAlign: e.currentTarget.value as VerticalAlign })}>
      {#each ALIGNS as v (v)}<option value={v}>{tDyn(alignLabel(v))}</option>{/each}
    </select>
  </Field>

  <Field label={tDyn(alongIsHorizontal ? 'settings.horizontalOffset' : 'settings.verticalOffset')}>
    <input
      class="field num"
      type="number"
      step="1"
      disabled={s.island}
      value={s.verticalOffset}
      onchange={(e) => void settings.patch({ verticalOffset: Math.round(num(e)) })}
      aria-label={tDyn(alongIsHorizontal ? 'settings.horizontalOffset' : 'settings.verticalOffset')}
    />
  </Field>

  <Field label={t('settings.monitor')}>
    <select aria-label={t('settings.monitor')}
      class="field"
      value={s.monitor ?? ''}
      onchange={(e) => void settings.patch({ monitor: e.currentTarget.value || null })}
    >
      <option value="">{t('settings.monitor.primary')}</option>
      {#each monitors as m (m.name)}
        <option value={m.name}>{m.name} — {m.width}×{m.height}{m.isPrimary ? ' ★' : ''}</option>
      {/each}
    </select>
  </Field>

  <Field label={t('settings.alwaysOnTop')}>
    <Toggle
      checked={s.alwaysOnTop}
      label={t('settings.alwaysOnTop')}
      onchange={(v) => void settings.patch({ alwaysOnTop: v })}
    />
  </Field>
</SettingsCard>

<style>
  .picks {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .pick {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.2rem 0.55rem 0.2rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--muted);
    font-size: 0.7rem;
    line-height: 1.5;
    transition:
      background var(--dur-ui) var(--ease-out),
      border-color var(--dur-ui) var(--ease-out),
      color var(--dur-ui) var(--ease-out);
  }

  .pick:hover:not(:disabled) {
    border-color: var(--border-strong);
    color: var(--text);
  }

  .pick.on {
    border-color: var(--focus);
    background: color-mix(in srgb, var(--focus) 16%, transparent);
    color: var(--text);
  }

  .pick:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
