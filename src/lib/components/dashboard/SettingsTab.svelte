<!--
  Dashboard → Settings. Every control applies immediately through
  `settings.patch()` (which persists via `update_settings` and, for the
  window-related keys, calls `apply_window_settings`). [FRONTEND]

  This file is only the frame: a sticky section index on the left (a select on
  narrow windows), the search box, "Reset all", and the cards in
  `./settings/`, which own their controls, their "Reset to defaults" and their
  data. A card hides itself when the search matches none of its controls.
-->
<script lang="ts">
  import { onMount, type Component } from 'svelte';
  import AboutCard from './settings/AboutCard.svelte';
  import AccountsCard from './settings/AccountsCard.svelte';
  import AppearanceCard from './settings/AppearanceCard.svelte';
  import BackupCard from './settings/BackupCard.svelte';
  import BehaviourCard from './settings/BehaviourCard.svelte';
  import DataCard from './settings/DataCard.svelte';
  import IntegrationsPanel from './settings/IntegrationsPanel.svelte';
  import NotificationsCard from './settings/NotificationsCard.svelte';
  import PluginsCard from './settings/PluginsCard.svelte';
  import PositionCard from './settings/PositionCard.svelte';
  import PresetsCard from './settings/PresetsCard.svelte';
  import PrivacyCard from './settings/PrivacyCard.svelte';
  import ProvidersCard from './settings/ProvidersCard.svelte';
  import ShortcutsCard from './settings/ShortcutsCard.svelte';
  import SizeColourCard from './settings/SizeColourCard.svelte';
  import SidebarItemsCard from './settings/SidebarItemsCard.svelte';
  import UpdatesCard from './settings/UpdatesCard.svelte';
  import { t } from '$lib/i18n/i18n.svelte';
  import { resetAllPatch } from '$lib/settings-cards';
  import { SECTIONS, SETTINGS_GROUPS, type SectionId, type SettingsGroup } from '$lib/settings-sections';
  import { SettingsSearch, provideSettingsSearch } from '$lib/settings-scope.svelte';
  import { defaultSettings, settings } from '$lib/stores/settings.svelte';

  /** One component per section id; TypeScript fails if a section is missed. */
  const CARDS: Record<SectionId, Component> = {
    appearance: AppearanceCard,
    sidebarItems: SidebarItemsCard,
    presets: PresetsCard,
    sizeColour: SizeColourCard,
    position: PositionCard,
    behaviour: BehaviourCard,
    plugins: PluginsCard,
    shortcuts: ShortcutsCard,
    providers: ProvidersCard,
    data: DataCard,
    accounts: AccountsCard,
    notifications: NotificationsCard,
    integrations: IntegrationsPanel,
    updates: UpdatesCard,
    privacy: PrivacyCard,
    about: AboutCard,
    backup: BackupCard,
  };

  const search = new SettingsSearch();
  provideSettingsSearch(search);

  const shown = $derived(SECTIONS.filter((section) => !search.active || search.cards.get(section.id) !== false));
  const shownIds = $derived(new Set<string>(shown.map((section) => section.id)));
  const groupShown = (group: SettingsGroup) => group.sections.some((section) => shownIds.has(section.id));

  let root = $state<HTMLElement | null>(null);
  let current = $state<string>(SECTIONS[0].id);

  /** The element that scrolls the page (the dashboard's <main>). */
  function scrollParent(el: HTMLElement): HTMLElement | null {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') return node;
    }
    return null;
  }

  function jump(id: string) {
    const target = root?.querySelector<HTMLElement>(`#${id}`);
    if (!target) return;
    current = id;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
  }

  /** Highlight the last visible section whose top has reached the top of the page. */
  function spy(container: HTMLElement) {
    const line = container.getBoundingClientRect().top + 96;
    let found: string | null = null;
    for (const section of shown) {
      const el = root?.querySelector<HTMLElement>(`#${section.id}`);
      if (el && el.getBoundingClientRect().top <= line) found = section.id;
    }
    current = found ?? shown[0]?.id ?? current;
  }

  onMount(() => {
    if (!root) return;
    const container = scrollParent(root);
    if (!container) return;
    const onScroll = () => spy(container);
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  });

  function resetAll() {
    if (!window.confirm(t('settings.resetAll.confirm'))) return;
    void settings.patch(resetAllPatch(defaultSettings));
  }

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && search.query !== '') {
      e.preventDefault();
      search.query = '';
    }
  }
</script>

<div class="settings" bind:this={root}>
  <aside class="rail">
    <div class="search">
      <input
        class="field"
        type="search"
        bind:value={search.query}
        onkeydown={onSearchKey}
        placeholder={t('settings.search.placeholder')}
        aria-label={t('settings.search')}
        spellcheck="false"
      />
      {#if search.query !== ''}
        <button class="btn clear" aria-label={t('settings.search.clear')} onclick={() => (search.query = '')}>×</button>
      {/if}
    </div>

    <nav aria-label={t('settings.nav')}>
      <ul class="index">
        {#each SETTINGS_GROUPS as group (group.id)}
          {@const sections = group.sections.filter((section) => shownIds.has(section.id))}
          {#if sections.length > 0}
            <li class="nav-group">{t(group.title)}</li>
            {#each sections as section (section.id)}
              <li>
                <a
                  href={`#${section.id}`}
                  class:current={current === section.id}
                  aria-current={current === section.id ? 'location' : undefined}
                  onclick={(e) => { e.preventDefault(); jump(section.id); }}
                >{t(section.title)}</a>
              </li>
            {/each}
          {/if}
        {/each}
      </ul>
      <select
        class="field jump"
        aria-label={t('settings.nav.jump')}
        value={current}
        onchange={(e) => jump(e.currentTarget.value)}
      >
        {#each SETTINGS_GROUPS as group (group.id)}
          {@const sections = group.sections.filter((section) => shownIds.has(section.id))}
          {#if sections.length > 0}
            <optgroup label={t(group.title)}>
              {#each sections as section (section.id)}<option value={section.id}>{t(section.title)}</option>{/each}
            </optgroup>
          {/if}
        {/each}
      </select>
    </nav>

    <button class="btn reset-all" onclick={resetAll}>{t('settings.resetAll')}</button>
  </aside>

  <section class="cards">
    {#if settings.error}
      <p class="err" role="alert">{t('common.error', { message: settings.error })}</p>
    {/if}
    {#if settings.saving}
      <p class="save-state muted" role="status">{t('common.saving')}</p>
    {/if}
    {#if !search.anyVisible}
      <p class="empty muted" role="status">{t('settings.search.none', { query: search.query.trim() })}</p>
    {/if}

    {#each SETTINGS_GROUPS as group (group.id)}
      <section
        class="group-block"
        data-settings-group={group.id}
        hidden={!groupShown(group)}
        aria-labelledby={`settings-group-${group.id}`}
      >
        <h2 class="group-title" id={`settings-group-${group.id}`}>{t(group.title)}</h2>
        <div class="group-grid">
          {#each group.sections as section (section.id)}
            {@const Card = CARDS[section.id]}
            <Card />
          {/each}
        </div>
      </section>
    {/each}

    <!-- on a narrow window the rail is only the search box and the select -->
    <button class="btn reset-all-end" onclick={resetAll}>{t('settings.resetAll')}</button>
  </section>
</div>

<style>
  .settings {
    display: grid;
    grid-template-columns: 12.5rem minmax(0, 1fr);
    align-items: start;
    gap: 1.25rem;
  }

  .rail {
    position: sticky;
    top: 0;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    max-height: calc(100vh - 6rem);
    overflow-y: auto;
  }

  .search {
    position: relative;
    display: flex;
  }

  .search .field {
    flex: 1 1 auto;
    min-width: 0;
    padding-right: 1.75rem;
  }

  .clear {
    position: absolute;
    right: 0.125rem;
    top: 50%;
    transform: translateY(-50%);
    padding: 0 0.4375rem;
    border: none;
    background: none;
    color: var(--muted);
  }

  .index {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
  }

  .nav-group {
    margin: 0.5rem 0 0.0625rem;
    padding: 0 0.625rem;
    font-size: 0.625rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--faint);
  }

  .nav-group:first-child {
    margin-top: 0;
  }

  .index a {
    display: block;
    padding: 0.3125rem 0.625rem;
    border-radius: var(--r-control);
    border-left: 2px solid transparent;
    color: var(--muted);
    text-decoration: none;
    font-size: 0.8125rem;
    transition: color var(--dur-ui) var(--ease-out), background var(--dur-ui) var(--ease-out);
  }

  .index a:hover {
    color: var(--text);
    background: var(--hover);
  }

  .index a.current {
    color: var(--text);
    background: var(--surface-2);
    border-left-color: var(--focus);
    font-weight: 500;
  }

  .jump {
    display: none;
    width: 100%;
  }

  .reset-all {
    align-self: flex-start;
    color: var(--critical);
  }

  .reset-all-end {
    display: none;
    justify-self: start;
    color: var(--critical);
  }

  .cards {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    min-width: 0;
    /* the group grids collapse by their own width, not the viewport's, so UI
       scale and the rail width cannot leave them too narrow */
    container-type: inline-size;
  }

  .group-block {
    min-width: 0;
  }

  .group-block[hidden] {
    display: none;
  }

  .group-title {
    margin: 0 0 0.5rem;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .group-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: start;
    gap: 1rem;
    min-width: 0;
  }

  @container (max-width: 52rem) {
    .group-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .cards > .save-state,
  .cards > .empty {
    margin: 0;
  }

  .err {
    color: var(--critical);
    font-size: 0.8125rem;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .empty {
    padding: 1.5rem 0;
    text-align: center;
  }

  /* narrow: the index becomes a select that stays on screen above the cards */
  @media (max-width: 760px) {
    .settings {
      grid-template-columns: minmax(0, 1fr);
      gap: 0.75rem;
    }

    .rail {
      z-index: 1;
      max-height: none;
      overflow: visible;
      padding: 0.25rem 0 0.5rem;
      background: var(--bg);
    }

    .index {
      display: none;
    }

    .jump {
      display: block;
    }

    .reset-all {
      display: none;
    }

    .reset-all-end {
      display: inline-flex;
    }
  }
</style>
