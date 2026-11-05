<!--
  Settings → Plugins: one switch per registered island module. [FRONTEND]

  The list comes from `src/lib/plugins/registry.ts`, so a new plugin gets its
  switch without another edit. `disabledPlugins` is an opt-out list: switching
  a module back on only removes its id, and a plugin added by a later release
  is enabled automatically.
-->
<script lang="ts">
  import Toggle from '../Toggle.svelte';
  import SettingsBlock from './SettingsBlock.svelte';
  import SettingsCard from './SettingsCard.svelte';
  import { t, tDyn } from '$lib/i18n/i18n.svelte';
  import { enabledPlugins, withPluginEnabled } from '$lib/plugins/enabled';
  import { ISLAND_PLUGINS } from '$lib/plugins/registry';
  import { settings } from '$lib/stores/settings.svelte';

  const s = $derived(settings.value);
  /** `Set` for O(1) row checks; the settings list is tiny either way. */
  const off = $derived(new Set(s.disabledPlugins));
  const shown = $derived(enabledPlugins(ISLAND_PLUGINS, s.disabledPlugins));
  const searchText = $derived(
    ISLAND_PLUGINS.map((plugin) =>
      [tDyn(plugin.label), plugin.hint ? tDyn(plugin.hint) : ''].filter(Boolean).join(' ')
    ).join(' ')
  );

  function setEnabled(id: string, enabled: boolean) {
    void settings.patch({ disabledPlugins: withPluginEnabled(s.disabledPlugins, id, enabled) });
  }

  function enableAll() {
    void settings.patch({ disabledPlugins: [] });
  }
</script>

<SettingsCard id="plugins" title={t('settings.plugins')} reset="plugins" wide>
  <p class="intro">{t('settings.plugins.hint')}</p>

  <SettingsBlock text={searchText}>
    <div class="plist">
      {#each ISLAND_PLUGINS as plugin (plugin.id)}
        {@const on = !off.has(plugin.id)}
        <div class="prow" class:off={!on}>
          <span class="picon" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d={plugin.icon}></path>
            </svg>
          </span>
          <span class="ptext">
            <span class="pname">{tDyn(plugin.label)}</span>
            {#if plugin.hint}<span class="phint">{tDyn(plugin.hint)}</span>{/if}
          </span>
          <Toggle
            checked={on}
            label={`${tDyn(plugin.label)} — ${t('settings.plugins.show')}`}
            onchange={(value) => setEnabled(plugin.id, value)}
          />
        </div>
      {/each}
    </div>

    <div class="status">
      <span class="note" role="status">
        {t('settings.plugins.count', { on: shown.length, total: ISLAND_PLUGINS.length })}
      </span>
      {#if s.disabledPlugins.length > 0}
        <button class="btn" onclick={enableAll}>{t('settings.plugins.enableAll')}</button>
      {/if}
    </div>
  </SettingsBlock>
</SettingsCard>

<style>
  .intro {
    margin: 0.5rem 0 0.25rem;
    font-size: 0.8125rem;
    color: var(--muted);
  }

  .plist {
    display: flex;
    flex-direction: column;
  }

  .prow {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
  }

  .prow:last-child {
    border-bottom: none;
  }

  .picon {
    display: grid;
    place-items: center;
    width: 1.875rem;
    height: 1.875rem;
    border-radius: 0.5rem;
    background: var(--surface-2);
    flex: none;
    color: var(--text);
  }

  .ptext {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    flex: 1 1 auto;
    min-width: 0;
  }

  .pname {
    color: var(--text);
  }

  .phint {
    font-size: 0.75rem;
    line-height: 1.35;
    color: var(--muted);
  }

  /* A hidden module stays readable, just visibly quieter than a live one. */
  .off .picon,
  .off .ptext {
    opacity: 0.55;
  }

  .status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
    padding-top: 0.5rem;
  }

  .status .note {
    margin: 0;
  }
</style>
