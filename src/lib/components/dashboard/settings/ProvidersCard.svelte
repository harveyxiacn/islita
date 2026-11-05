<!-- Settings → Providers: track / show on the bar / order. [FRONTEND] -->
<script lang="ts">
  import { onMount } from 'svelte';
  import Toggle from '../Toggle.svelte';
  import Field from '../Field.svelte';
  import SettingsBlock from './SettingsBlock.svelte';
  import SettingsCard from './SettingsCard.svelte';
  import ProviderLogo from '$lib/components/ProviderLogo.svelte';
  import { getProviders, opencodeClearKey, opencodeKeyStatus, opencodeSetKey } from '$lib/api';
  import { t } from '$lib/i18n/i18n.svelte';
  import { providerDisplayName } from '$lib/providers';
  import { settings } from '$lib/stores/settings.svelte';
  import { snapshot } from '$lib/stores/snapshot.svelte';
  import type { OpenCodeKeyStatus, ProviderId, ProviderInfo } from '$lib/types';

  const s = $derived(settings.value);

  let providerInfos = $state<ProviderInfo[]>([]);
  let error = $state<string | null>(null);

  // OpenCode's API key lives in the OS keychain, not in settings: the card
  // only ever sees whether one is saved and where it came from.
  let opencodeKey = $state('');
  let opencodeStatus = $state<OpenCodeKeyStatus>({ saved: false, fromEnv: false });
  let opencodeBusy = $state(false);
  let opencodeError = $state<string | null>(null);

  onMount(() => {
    void getProviders().then((p) => (providerInfos = p)).catch((e) => (error = String(e)));
    void opencodeKeyStatus()
      .then((status) => (opencodeStatus = status))
      .catch(() => {});
  });

  const opencodeKeyState = $derived(
    opencodeStatus.saved
      ? t('settings.opencodeKey.saved')
      : opencodeStatus.fromEnv
        ? t('settings.opencodeKey.fromEnv')
        : t('settings.opencodeKey.empty')
  );

  async function saveOpenCodeKey() {
    const key = opencodeKey.trim();
    if (!key || opencodeBusy) return;
    opencodeBusy = true;
    opencodeError = null;
    try {
      await opencodeSetKey(key);
      opencodeKey = '';
      opencodeStatus = await opencodeKeyStatus();
      // A saved key is useless while the provider is not tracked; turn it on
      // the first time so “paste a key and see the windows” is one step.
      if (!s.providers.opencode?.enabled) {
        await settings.patchProvider('opencode', { enabled: true });
      }
      void snapshot.refresh('opencode');
    } catch (e) {
      opencodeError = String(e);
    } finally {
      opencodeBusy = false;
    }
  }

  async function clearOpenCodeKey() {
    if (opencodeBusy) return;
    opencodeBusy = true;
    opencodeError = null;
    try {
      await opencodeClearKey();
      opencodeStatus = await opencodeKeyStatus();
      void snapshot.refresh('opencode');
    } catch (e) {
      opencodeError = String(e);
    } finally {
      opencodeBusy = false;
    }
  }

  /** Provider rows: every provider the backend reports, ordered by settings. */
  const providerRows = $derived.by(() => {
    const ids = new Set<ProviderId>((snapshot.value?.providers ?? []).map((p) => p.provider));
    for (const info of providerInfos) ids.add(info.id);
    for (const id of Object.keys(s.providers)) ids.add(id as ProviderId);
    return [...ids].sort((a, b) => (s.providers[a]?.order ?? 0) - (s.providers[b]?.order ?? 0));
  });

  /** `get_providers` is the authority on which providers exist and their state. */
  const providerInfoOf = (id: ProviderId) => providerInfos.find((p) => p.id === id) ?? null;

  const providerName = (id: ProviderId) =>
    snapshot.value?.providers.find((p) => p.provider === id)?.displayName ??
    providerInfos.find((p) => p.id === id)?.displayName ??
    providerDisplayName(id);

  /** Swap the `order` of two adjacent providers. */
  async function move(id: ProviderId, delta: -1 | 1) {
    const list = providerRows;
    const i = list.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    const order = [...list];
    [order[i], order[j]] = [order[j], order[i]];
    await settings.patch({ providers: Object.fromEntries(order.map((provider, index) => [provider, { order: index }])) });
  }

  const searchText = $derived(
    [...providerRows.map(providerName), t('settings.providers.hint'), t('settings.providerEnabled'), t('settings.sidebarItems.provider'), t('settings.openrouterKeyEnv'), t('settings.openrouterKeyEnv.hint'), t('settings.opencodeKey'), t('settings.opencodeKey.hint'), t('settings.opencodeWorkspaceId'), t('settings.opencodeWorkspaceId.hint')].join(' ')
  );
</script>

<SettingsCard id="providers" title={t('settings.providers')} reset="providers">
  {#if error}<p class="err" role="alert">{t('common.error', { message: error })}</p>{/if}
  <SettingsBlock text={searchText}>
    {#each providerRows as id, i (id)}
      {@const info = providerInfoOf(id)}
      <div class="prow">
        <span class="plogo"><ProviderLogo provider={id} size={20} /></span>
        <span class="pname">{providerName(id)}</span>
        {#if info?.experimental}
          <span class="badge" title={t('settings.provider.experimental.hint')}>
            {t('settings.provider.experimental')}
          </span>
        {/if}
        <button class="btn icon" disabled={i === 0} onclick={() => void move(id, -1)} aria-label={t('common.up')}>↑</button>
        <button class="btn icon" disabled={i === providerRows.length - 1} onclick={() => void move(id, 1)} aria-label={t('common.down')}>↓</button>
        <span class="pcol" title={t('settings.providerEnabled')}>
          <span class="pcap">{t('settings.providerEnabled.short')}</span>
          <Toggle
            checked={s.providers[id]?.enabled ?? true}
            label={`${providerName(id)} — ${t('settings.providerEnabled')}`}
            onchange={(v) => void settings.patchProvider(id, { enabled: v })}
          />
        </span>
        <span class="pcol" title={t('settings.sidebarItems.provider')}>
          <span class="pcap">{t('settings.sidebarItems.provider.short')}</span>
          <Toggle
            checked={s.providers[id]?.showInSidebar ?? true}
            label={`${providerName(id)} — ${t('settings.sidebarItems.provider')}`}
            disabled={!(s.providers[id]?.enabled ?? true)}
            onchange={(v) => void settings.patchProvider(id, { showInSidebar: v })}
          />
        </span>
      </div>
    {/each}
    <p class="note">{t('settings.providers.hint')}</p>
    {#if s.providers.openrouter}
      <Field label={t('settings.openrouterKeyEnv')} hint={t('settings.openrouterKeyEnv.hint')}>
        <input
          class="field"
          type="text"
          spellcheck="false"
          autocomplete="off"
          maxlength="100"
          value={s.openrouterKeyEnv}
          aria-label={t('settings.openrouterKeyEnv')}
          onchange={(e) => void settings.patch({ openrouterKeyEnv: e.currentTarget.value.trim() })}
        />
      </Field>
    {/if}
    {#if s.providers.opencode}
      <Field label={t('settings.opencodeKey')} hint={t('settings.opencodeKey.hint')} wide>
        <div class="keyrow">
          <input
            class="field"
            type="password"
            spellcheck="false"
            autocomplete="off"
            maxlength="512"
            placeholder={t('settings.opencodeKey.placeholder')}
            aria-label={t('settings.opencodeKey')}
            bind:value={opencodeKey}
          />
          <button
            class="btn primary"
            disabled={opencodeBusy || !opencodeKey.trim()}
            onclick={() => void saveOpenCodeKey()}
          >
            {opencodeBusy ? t('common.saving') : t('common.save')}
          </button>
          <button
            class="btn danger"
            disabled={opencodeBusy || !opencodeStatus.saved}
            onclick={() => void clearOpenCodeKey()}
          >
            {t('common.remove')}
          </button>
        </div>
        <p class="keystate">{opencodeKeyState}</p>
        {#if opencodeError}
          <p class="err" role="alert">{t('common.error', { message: opencodeError })}</p>
        {/if}
      </Field>
      <Field label={t('settings.opencodeWorkspaceId')} hint={t('settings.opencodeWorkspaceId.hint')}>
        <input
          class="field"
          type="text"
          spellcheck="false"
          autocomplete="off"
          maxlength="200"
          placeholder={t('settings.opencodeWorkspaceId.placeholder')}
          aria-label={t('settings.opencodeWorkspaceId')}
          value={s.opencodeWorkspaceId}
          onchange={(e) => void settings.patch({ opencodeWorkspaceId: e.currentTarget.value.trim() })}
        />
      </Field>
    {/if}
  </SettingsBlock>
</SettingsCard>

<style>
  .prow {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4375rem 0;
    border-bottom: 1px solid var(--border);
  }

  .prow:last-of-type {
    border-bottom: none;
  }

  .plogo {
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 999px;
    background: var(--surface-2);
    flex: none;
  }

  .pname {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* "experimental": the provider's quota source could not be verified against
     a live account, so the row says so rather than the README alone */
  .badge {
    flex: none;
    padding: 0.0625rem 0.375rem;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    font-size: 0.625rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--warn);
    white-space: nowrap;
  }

  /* the two provider switches need a caption each to be told apart */
  .pcol {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.125rem;
    flex: none;
  }

  .pcap {
    font-size: 0.625rem;
    line-height: 1;
    color: var(--muted);
    white-space: nowrap;
  }

  /* OpenCode: the key and its two actions share one line, and wrap on a
     narrow settings pane instead of overflowing it. */
  .keyrow {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    width: 100%;
  }

  .keyrow .field {
    flex: 1 1 14rem;
    min-width: 10rem;
  }

  .keystate {
    margin: 0.375rem 0 0;
    font-size: 0.75rem;
    color: var(--muted);
  }
</style>
