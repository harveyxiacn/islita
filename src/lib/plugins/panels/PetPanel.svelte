<!--
  Island → Desktop pet. [FRONTEND]

  A small, local-only companion: the original inline SVG mascot plus two
  bundled sticker-card skins made from artwork supplied by the project owner,
  needs that drift with elapsed time, four interactions, levels, and an
  optional user-supplied sprite stored as a data URL in this plugin's
  localStorage entry. The simulation lives in `$lib/pet/pet.ts`, bundled skins
  in `$lib/pet/skins.ts`, and sprite validation in `$lib/pet/sprite.ts`. No
  network, audio, ambient animation outside this panel, or sourced character
  art beyond the bundled, owner-supplied cards.

  Sprite contract: one image = portrait; an image within 5% of 4:1 = four equal
  square idle frames, left to right. PNG, WebP and GIF are accepted up to 2 MB.
  A custom sprite takes precedence over the selected skin.
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { t, tDyn, type MessageKey } from '$lib/i18n/i18n.svelte';
  import {
    OFFLINE_DECAY_CAP_MS,
    OFFLINE_NOTICE_MS,
    PET_NAME_MAX,
    PET_PLUGIN_ID,
    advancePet,
    applyAction,
    createDefaultPet,
    parsePetState,
    petStatus,
    sanitizeName,
    xpForNextLevel,
    type DeepSeekForm,
    type PetAction,
    type PetReaction,
    type PetSkin,
    type PetState,
  } from '$lib/pet/pet';
  import { DEEPSEEK_FORM_OPTIONS, PET_SKIN_OPTIONS, skinImage } from '$lib/pet/skins';
  import Mochi from '$lib/pet/Mochi.svelte';
  import {
    parseStoredSprite,
    spriteFileError,
    validateSpriteFile,
    type PetSprite,
  } from '$lib/pet/sprite';
  import { petSituation, petVoice, sayKey, situationMood, type PetSituation } from '$lib/pet/speech';
  import { petSpeech } from '$lib/pet/speech.svelte';
  import { pluginStorageKey, readPluginState, removePluginState, writePluginState } from '$lib/plugins/storage';
  import { emitWindowEvent } from '$lib/api';
  import { settings } from '$lib/stores/settings.svelte';
  import { snapshot } from '$lib/stores/snapshot.svelte';

  const ACTION_COOLDOWN_MS: Record<PetAction, number> = {
    feed: 2600,
    play: 2400,
    rest: 3200,
    pat: 1200,
  };

  const ACTIONS: readonly { id: PetAction; label: MessageKey; icon: string }[] = [
    {
      id: 'feed',
      label: 'plugin.pet.feed',
      icon: 'M2.5 7.5h11M3.5 7.5c0 3 1.8 5.5 4.5 5.5s4.5-2.5 4.5-5.5M5.2 7.5c.4-1.9 1.5-2.9 2.8-2.9s2.4 1 2.8 2.9',
    },
    {
      id: 'play',
      label: 'plugin.pet.play',
      icon: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM5.4 4.7c1.5 2 1.5 4.6 0 6.6M10.6 4.7c-1.5 2-1.5 4.6 0 6.6',
    },
    {
      id: 'rest',
      label: 'plugin.pet.rest',
      icon: 'M10.7 2.5a5.7 5.7 0 1 0 2.8 10.7 6.4 6.4 0 0 1-2.8-10.7Z',
    },
    {
      id: 'pat',
      label: 'plugin.pet.pat',
      icon: 'M8 13S2.5 9.7 2.5 6.3A2.8 2.8 0 0 1 8 4.8a2.8 2.8 0 0 1 5.5 1.5C13.5 9.7 8 13 8 13Z',
    },
  ];

  let pet = $state<PetState>(createDefaultPet());
  let reaction = $state<PetReaction | null>(null);
  let error = $state<string | null>(null);
  let saved = $state(false);
  let renaming = $state(false);
  let draftName = $state('');
  let busy = $state(false);
  let reacting = $state(false);
  let cooldowns = $state<Record<PetAction, boolean>>({
    feed: false,
    play: false,
    rest: false,
    pat: false,
  });

  let fileInput = $state<HTMLInputElement>();
  let nameInput = $state<HTMLInputElement>();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let savedTimer: ReturnType<typeof setTimeout> | null = null;
  let reactionTimer: ReturnType<typeof setTimeout> | null = null;
  let reactionClearTimer: ReturnType<typeof setTimeout> | null = null;
  let reactionFrame: number | null = null;
  let importToken = 0;
  const cooldownTimers: Partial<Record<PetAction, ReturnType<typeof setTimeout>>> = {};

  const status = $derived(petStatus(pet));
  const statusLabel = $derived(tDyn(`plugin.pet.status.${status}`));
  const voice = $derived(petVoice(pet.skin, pet.deepseekForm));
  const onDesktop = $derived(settings.value.petOnDesktop);
  const roam = $derived(settings.value.petRoam);
  /** a fresh island event, still inside its display window */
  const event = $derived(petSpeech.current());
  /** A fresh island event wins; otherwise comment on the current quota/needs. */
  const situation = $derived.by((): PetSituation =>
    event ?? petSituation(snapshot.value, settings.value, pet)
  );
  const speechText = $derived(tDyn(sayKey(voice, situation), { name: pet.name }));
  const nextXp = $derived(xpForNextLevel(pet.level));
  const sprite = $derived(pet.sprite);
  const bundledImage = $derived(
    sprite
      ? null
      : skinImage(pet.skin, pet.deepseekForm, reaction ?? (event ? situationMood(event) : status))
  );
  const xpPercent = $derived(nextXp > 0 ? Math.min(100, (pet.xp / nextXp) * 100) : 0);
  const mascotLabel = $derived(`${t('plugin.pet.pat')}: ${pet.name}`);
  const reactionText = $derived(
    reaction ? tDyn(sayKey(voice, reaction), { name: pet.name }) : speechText
  );
  const stats = $derived.by(() => [
    { id: 'fullness' as const, label: t('plugin.pet.hunger'), value: pet.fullness },
    { id: 'mood' as const, label: t('plugin.pet.mood'), value: pet.mood },
    { id: 'energy' as const, label: t('plugin.pet.energy'), value: pet.energy },
  ]);

  function copyState(state: PetState): PetState {
    return { ...state, sprite: state.sprite ? { ...state.sprite } : null };
  }

  function markSaved() {
    saved = true;
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      saved = false;
      savedTimer = null;
    }, 2200);
  }

  function persistNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    writePluginState(PET_PLUGIN_ID, copyState(pet));
    // The detached window may be open; it adopts the panel's newer state.
    void emitWindowEvent('pet', 'pet-state', { state: copyState(pet) });
  }

  /** Adopt a state another window (the detached pet) saved, if it is newer. */
  function adoptStoredState() {
    const stored = parsePetState(readPluginState<unknown>(PET_PLUGIN_ID, null), Date.now());
    if (stored.lastSeen <= pet.lastSeen) return;
    pet = advancePet(stored, Date.now()).state;
    clearReaction();
  }

  function setDesktop(on: boolean) {
    void settings.patch({ petOnDesktop: on });
  }

  function setRoam(on: boolean) {
    void settings.patch({ petRoam: on });
  }

  /** Coalesce drags/actions rather than writing a sprite-sized blob per frame. */
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistNow();
      markSaved();
    }, 350);
  }

  function triggerReaction() {
    if (reactionFrame !== null) cancelAnimationFrame(reactionFrame);
    if (reactionTimer) clearTimeout(reactionTimer);
    reacting = false;
    reactionFrame = requestAnimationFrame(() => {
      reactionFrame = null;
      reacting = true;
      reactionTimer = setTimeout(() => {
        reacting = false;
        reactionTimer = null;
      }, 520);
    });
  }

  /** Show an action/offline line, then fall back to the live situation line. */
  function setReaction(kind: PetReaction, holdMs = 6000) {
    reaction = kind;
    if (reactionClearTimer) clearTimeout(reactionClearTimer);
    reactionClearTimer = setTimeout(() => {
      reaction = null;
      reactionClearTimer = null;
    }, holdMs);
  }

  function clearReaction() {
    reaction = null;
    if (reactionClearTimer) {
      clearTimeout(reactionClearTimer);
      reactionClearTimer = null;
    }
  }

  function setCooldown(action: PetAction) {
    cooldowns = { ...cooldowns, [action]: true };
    cooldownTimers[action] = setTimeout(() => {
      cooldowns = { ...cooldowns, [action]: false };
      delete cooldownTimers[action];
    }, ACTION_COOLDOWN_MS[action]);
  }

  function perform(action: PetAction) {
    if (cooldowns[action]) return;
    const now = Date.now();
    const advanced = advancePet(pet, now).state;
    const result = applyAction(advanced, action, now);
    pet = result.state;
    setReaction(action);
    error = null;
    setCooldown(action);
    triggerReaction();
    scheduleSave();
  }

  function startRename() {
    if (renaming) return;
    draftName = pet.name;
    renaming = true;
    void tick().then(() => {
      nameInput?.focus();
      nameInput?.select();
    });
  }

  function chooseSkin(skin: PetSkin) {
    if (pet.skin === skin) return;
    const option = PET_SKIN_OPTIONS.find((entry) => entry.id === skin);
    const defaultNames = PET_SKIN_OPTIONS.map((entry) => t(entry.defaultName));
    // Follow the new character's name while the pet still uses a built-in one;
    // a name the user typed is never overwritten.
    const name = option && defaultNames.includes(pet.name) ? t(option.defaultName) : pet.name;
    const now = Date.now();
    pet = { ...advancePet(pet, now).state, skin, name, lastSeen: now };
    clearReaction();
    error = null;
    scheduleSave();
  }

  function chooseForm(form: DeepSeekForm) {
    if (pet.deepseekForm === form) return;
    const now = Date.now();
    pet = { ...advancePet(pet, now).state, deepseekForm: form, lastSeen: now };
    clearReaction();
    error = null;
    scheduleSave();
  }

  function cancelRename() {
    renaming = false;
    draftName = pet.name;
  }

  function saveName(event?: SubmitEvent) {
    event?.preventDefault();
    if (!draftName.trim()) {
      cancelRename();
      return;
    }
    const now = Date.now();
    const advanced = advancePet(pet, now).state;
    pet = {
      ...advanced,
      name: sanitizeName(draftName, advanced.name),
      lastSeen: now,
    };
    renaming = false;
    scheduleSave();
  }

  function pickFile() {
    if (!busy) fileInput?.click();
  }

  function importFailure() {
    error = t('plugin.pet.import.error', { message: t('plugin.pet.import.hint') });
    saved = false;
  }

  function resetSprite() {
    if (!pet.sprite) return;
    const now = Date.now();
    pet = { ...advancePet(pet, now).state, sprite: null, lastSeen: now };
    clearReaction();
    error = null;
    scheduleSave();
  }

  function resetPet() {
    if (!window.confirm(t('plugin.pet.resetConfirm'))) return;
    importToken += 1;
    busy = false;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (savedTimer) {
      clearTimeout(savedTimer);
      savedTimer = null;
    }
    if (reactionTimer) {
      clearTimeout(reactionTimer);
      reactionTimer = null;
    }
    if (reactionClearTimer) {
      clearTimeout(reactionClearTimer);
      reactionClearTimer = null;
    }
    if (reactionFrame !== null) {
      cancelAnimationFrame(reactionFrame);
      reactionFrame = null;
    }
    for (const action of ACTIONS) {
      const timer = cooldownTimers[action.id];
      if (timer) clearTimeout(timer);
      delete cooldownTimers[action.id];
    }
    cooldowns = { feed: false, play: false, rest: false, pat: false };
    pet = createDefaultPet(Date.now());
    clearReaction();
    error = null;
    renaming = false;
    saved = false;
    reacting = false;
    removePluginState(PET_PLUGIN_ID);
  }

  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') resolve(reader.result);
        else reject(new Error('unreadable image'));
      };
      reader.onerror = () => reject(reader.error ?? new Error('unreadable image'));
      reader.onabort = () => reject(new Error('aborted image read'));
      reader.readAsDataURL(file);
    });
  }

  async function imageDimensions(file: File): Promise<{ width: number; height: number } | null> {
    if (typeof createImageBitmap === 'function') {
      let bitmap: ImageBitmap | null = null;
      try {
        bitmap = await createImageBitmap(file);
        return { width: bitmap.width, height: bitmap.height };
      } catch {
        // Older webviews may not decode every format in createImageBitmap.
      } finally {
        bitmap?.close();
      }
    }
    let url: string | null = null;
    try {
      url = URL.createObjectURL(file);
      const image = new Image();
      image.src = url;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight };
    } catch {
      return null;
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }

  async function importSprite(file: File) {
    if (busy) return;
    const token = ++importToken;
    busy = true;
    error = null;
    saved = false;
    try {
      if (spriteFileError(file)) {
        importFailure();
        return;
      }
      const dimensions = await imageDimensions(file);
      if (token !== importToken) return;
      if (!dimensions) {
        importFailure();
        return;
      }
      const check = validateSpriteFile({
        name: file.name,
        type: file.type,
        size: file.size,
        width: dimensions.width,
        height: dimensions.height,
      });
      if (!check.ok) {
        importFailure();
        return;
      }
      const dataUrl = await readFileAsDataUrl(file);
      if (token !== importToken) return;
      const nextSprite: PetSprite | null = parseStoredSprite({
        dataUrl,
        width: dimensions.width,
        height: dimensions.height,
        frames: check.frames,
        fileName: file.name,
      });
      if (!nextSprite) {
        importFailure();
        return;
      }

      const previous = copyState(pet);
      const now = Date.now();
      const advanced = advancePet(pet, now).state;
      pet = { ...advanced, sprite: nextSprite, lastSeen: now };
      // Verify the write: writePluginState deliberately swallows quota errors.
      persistNow();
      const stored = parsePetState(
        readPluginState<unknown>(PET_PLUGIN_ID, null),
        Date.now()
      ).sprite;
      if (!stored || stored.dataUrl !== nextSprite.dataUrl) {
        pet = previous;
        importFailure();
        return;
      }
      clearReaction();
      triggerReaction();
      markSaved();
    } catch {
      if (token === importToken) importFailure();
    } finally {
      if (token === importToken) busy = false;
    }
  }

  function onFilePicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void importSprite(file);
  }

  /** The panel is on screen: the rail's new-speech dot can be cleared. */
  $effect(() => {
    void petSpeech.latest;
    petSpeech.seen();
  });

  onMount(() => {
    const now = Date.now();
    const raw = readPluginState<unknown>(PET_PLUGIN_ID, null);
    const hadSavedState = raw !== null && typeof raw === 'object' && !Array.isArray(raw);
    const restored = parsePetState(raw, now);
    const advanced = advancePet(restored, now);
    pet = advanced.state;
    if (hadSavedState && advanced.elapsedMs >= OFFLINE_NOTICE_MS) setReaction('offline', 8000);

    const tickTimer = setInterval(() => {
      pet = advancePet(pet, Date.now()).state;
    }, 30_000);

    // The detached pet window shares the same localStorage entry. Its writes
    // arrive here as a same-origin `storage` event (or the shell's custom
    // announcement when the sidebridge wrote through this window).
    const onPluginState = (event: Event) => {
      if ((event as CustomEvent<string>).detail === PET_PLUGIN_ID) adoptStoredState();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === pluginStorageKey(PET_PLUGIN_ID)) adoptStoredState();
    };
    window.addEventListener('island-plugin-state', onPluginState);
    window.addEventListener('storage', onStorage);

    return () => {
      window.removeEventListener('island-plugin-state', onPluginState);
      window.removeEventListener('storage', onStorage);
      importToken += 1;
      clearInterval(tickTimer);
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (savedTimer) {
        clearTimeout(savedTimer);
        savedTimer = null;
      }
      if (reactionTimer) {
        clearTimeout(reactionTimer);
        reactionTimer = null;
      }
      if (reactionClearTimer) {
        clearTimeout(reactionClearTimer);
        reactionClearTimer = null;
      }
      if (reactionFrame !== null) {
        cancelAnimationFrame(reactionFrame);
        reactionFrame = null;
      }
      for (const action of ACTIONS) {
        const timer = cooldownTimers[action.id];
        if (timer) clearTimeout(timer);
        delete cooldownTimers[action.id];
      }
      // The panel can be unmounted for hours; persist the elapsed state so the
      // next open decays once, not twice.
      const final = advancePet(pet, Date.now(), OFFLINE_DECAY_CAP_MS).state;
      writePluginState(PET_PLUGIN_ID, copyState(final));
    };
  });
</script>

<div class="panel">
  <header class="panel-head">
    <div class="heading">
      <strong>{t('plugin.pet')}</strong>
      <span class="status-chip" data-status={status}>
        <span class="status-dot" aria-hidden="true"></span>
        {statusLabel}
      </span>
    </div>
    <button class="link reset-link" type="button" onclick={resetPet}>
      {t('plugin.pet.reset')}
    </button>
  </header>

  <div class="scene" data-status={status}>
    <p
      class="reaction"
      data-situation={reaction ?? situation}
      aria-live="polite"
      aria-atomic="true"
      title={reactionText}
    >
      {reactionText}
    </p>
    <button
      class="mascot-button"
      class:reacting
      type="button"
      onclick={() => perform('pat')}
      disabled={cooldowns.pat}
      aria-label={mascotLabel}
      title={mascotLabel}
    >
      {#if sprite}
        {#if sprite.frames === 4}
          <span
            class="sprite-strip"
            style={`background-image: url("${sprite.dataUrl}")`}
            aria-hidden="true"
          ></span>
        {:else}
          <img class="sprite-portrait" src={sprite.dataUrl} alt="" draggable="false" />
        {/if}
      {:else if bundledImage}
        <img
          class="skin-card"
          src={bundledImage}
          alt=""
          draggable="false"
          data-skin={pet.skin}
          data-form={pet.skin === 'deepseek' ? pet.deepseekForm : undefined}
        />
      {:else}
        <span class="mochi-art"><Mochi status={status} /></span>
      {/if}
    </button>
  </div>

  <div class="identity">
    {#if renaming}
      <form class="rename" onsubmit={saveName}>
        <input
          bind:this={nameInput}
          bind:value={draftName}
          class="name-input"
          type="text"
          maxlength={PET_NAME_MAX}
          aria-label={t('plugin.pet.name')}
          onkeydown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelRename();
            }
          }}
        />
        <button class="mini primary" type="submit" disabled={!draftName.trim()}>
          {t('plugin.pet.save')}
        </button>
        <button class="mini" type="button" onclick={cancelRename}>
          {t('plugin.pet.cancel')}
        </button>
      </form>
    {:else}
      <button
        class="name-button"
        type="button"
        onclick={startRename}
        aria-label={`${t('plugin.pet.rename')}: ${pet.name}`}
        title={t('plugin.pet.rename')}
      >
        <span class="name-text">{pet.name}</span>
        <svg class="pencil" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m10.8 2.6 2.6 2.6M3 13l.8-3 7.7-7.7a1 1 0 0 1 1.4 0l.8.8a1 1 0 0 1 0 1.4L6 12.2l-3 .8Z" />
        </svg>
      </button>
      <span class="level-chip">{t('plugin.pet.level', { level: pet.level })}</span>
    {/if}
  </div>

  <div class="xp-row">
    <div
      class="xp-track"
      role="progressbar"
      aria-label={t('plugin.pet.xp', { current: pet.xp, next: nextXp })}
      aria-valuemin="0"
      aria-valuemax={nextXp}
      aria-valuenow={pet.xp}
    >
      <span style:width={`${xpPercent}%`}></span>
    </div>
    <span class="xp-value">{t('plugin.pet.xp', { current: pet.xp, next: nextXp })}</span>
  </div>

  <div class="stats">
    {#each stats as stat (stat.id)}
      <div class="stat" data-kind={stat.id}>
        <div class="stat-head">
          <span>{stat.label}</span>
          <span class="stat-value" class:low={stat.value < 30}>{Math.round(stat.value)}</span>
        </div>
        <div
          class="stat-track"
          role="meter"
          aria-label={stat.label}
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={Math.round(stat.value)}
        >
          <span style:width={`${Math.max(0, Math.min(100, stat.value))}%`}></span>
        </div>
      </div>
    {/each}
  </div>

  <div class="actions" role="group" aria-label={t('plugin.pet.actions')}>
    {#each ACTIONS as action (action.id)}
      <button
        class="action"
        type="button"
        onclick={() => perform(action.id)}
        disabled={cooldowns[action.id]}
        aria-label={t(action.label)}
        title={t(action.label)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d={action.icon} />
        </svg>
        <span>{t(action.label)}</span>
      </button>
    {/each}
  </div>

  <div class="skins" role="group" aria-label={t('plugin.pet.skin')}>
    <span class="skins-label" aria-hidden="true">{t('plugin.pet.skin')}</span>
    <div class="skin-options">
      {#each PET_SKIN_OPTIONS as option (option.id)}
        <button
          class="skin-option"
          type="button"
          aria-pressed={pet.skin === option.id}
          title={t(option.label)}
          onclick={() => chooseSkin(option.id)}
        >
          {t(option.label)}
        </button>
      {/each}
    </div>
  </div>

  {#if pet.skin === 'deepseek'}
    <div class="skins" role="group" aria-label={t('plugin.pet.form')}>
      <span class="skins-label" aria-hidden="true">{t('plugin.pet.form')}</span>
      <div class="skin-options">
        {#each DEEPSEEK_FORM_OPTIONS as option (option.id)}
          <button
            class="skin-option"
            type="button"
            aria-pressed={pet.deepseekForm === option.id}
            title={t(option.label)}
            onclick={() => chooseForm(option.id)}
          >
            {t(option.label)}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  {#if sprite}
    <p class="skin-note">{t('plugin.pet.skin.overridden')}</p>
  {/if}

  <div class="desktop" role="group" aria-label={t('plugin.pet.desktop.title')}>
    <label class="desktop-option">
      <input
        type="checkbox"
        checked={onDesktop}
        onchange={(event) => setDesktop(event.currentTarget.checked)}
      />
      <span>{t('plugin.pet.desktop.show')}</span>
    </label>
    {#if onDesktop}
      <label class="desktop-option">
        <input
          type="checkbox"
          checked={roam}
          onchange={(event) => setRoam(event.currentTarget.checked)}
        />
        <span>{t('plugin.pet.desktop.roam')}</span>
      </label>
    {/if}
  </div>

  <footer class="sprite-bar">
    <div class="sprite-actions">
      <button
        class="ghost"
        type="button"
        onclick={pickFile}
        disabled={busy}
        aria-busy={busy}
        title={t('plugin.pet.import.hint')}
      >
        {t('plugin.pet.import')}
      </button>
      <button
        class="link sprite-reset"
        type="button"
        onclick={resetSprite}
        disabled={!pet.sprite || busy}
        title={t('plugin.pet.resetSprite')}
      >
        {t('plugin.pet.resetSprite')}
      </button>
    </div>
    <p class="footnote" class:error aria-live="polite">
      {#if error}
        {error}
      {:else if saved}
        {t('plugin.pet.saved')}
      {:else}
        {t('plugin.pet.import.hint')} {t('plugin.pet.spriteHint')}
      {/if}
    </p>
    <input
      hidden
      bind:this={fileInput}
      type="file"
      accept=".png,.webp,.gif,image/png,image/webp,image/gif"
      onchange={onFilePicked}
    />
  </footer>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.4375rem;
    width: 22rem;
    max-width: calc(100vw - 2rem);
    font-size: 0.75rem;
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
    gap: 0.5rem;
    min-width: 0;
  }

  .heading strong {
    font-size: 0.8125rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .status-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    min-width: 0;
    padding: 0.125rem 0.4375rem;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--muted);
    font-size: 0.625rem;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .status-dot {
    flex: none;
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 50%;
    background: var(--ok);
  }

  .status-chip[data-status='hungry'] .status-dot {
    background: #e9a04a;
  }

  .status-chip[data-status='tired'] .status-dot {
    background: #9d8bd8;
  }

  .status-chip[data-status='bored'] .status-dot {
    background: var(--faint);
  }

  .status-chip[data-status='ok'] .status-dot {
    background: var(--focus);
  }

  .link {
    flex: none;
    padding: 0;
    color: var(--focus);
    font-size: 0.6875rem;
    white-space: nowrap;
  }

  .link:hover:not(:disabled) {
    text-decoration: underline;
  }

  .link:disabled {
    color: var(--faint);
    cursor: default;
    text-decoration: none;
  }

  .reset-link {
    color: var(--muted);
    font-size: 0.625rem;
  }

  .scene {
    position: relative;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    height: 8rem;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background:
      radial-gradient(ellipse at 50% 82%, rgb(240 163 94 / 0.14), transparent 62%),
      var(--surface-2);
    overflow: hidden;
  }

  .reaction {
    position: absolute;
    top: 0.5rem;
    left: 0.55rem;
    right: 0.55rem;
    z-index: 1;
    min-height: 1.35rem;
    margin: 0;
    padding: 0.1875rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--surface-3, var(--surface-2));
    color: var(--muted);
    font-size: 0.6875rem;
    line-height: 1.3;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mascot-button {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    width: 5.9rem;
    height: 5.5rem;
    margin-bottom: 0.15rem;
    padding: 0;
    border-radius: 45%;
    transform-origin: 50% 88%;
  }

  .mascot-button:hover {
    filter: brightness(1.035);
  }

  .mascot-button:disabled {
    cursor: default;
    filter: none;
  }

  .mascot-button.reacting {
    animation: pet-bounce 520ms var(--ease-out);
  }

  .skin-card,
  .sprite-portrait,
  .sprite-strip {
    display: block;
    width: 5.5rem;
    height: 5.5rem;
  }

  .mochi-art {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    width: 5.5rem;
    height: 5.5rem;
  }

  .skin-card {
    border-radius: 0.7rem;
    object-fit: cover;
    box-shadow:
      0 0.3rem 0.8rem rgb(0 0 0 / 0.22),
      0 0 0 1px rgb(255 255 255 / 0.14) inset;
  }

  .sprite-portrait {
    object-fit: contain;
  }

  .sprite-strip {
    border-radius: 0.5rem;
    background-repeat: no-repeat;
    background-size: 400% 100%;
    background-position: 0% 50%;
    animation: pet-sprite-frames 1.15s step-end infinite;
  }

  @keyframes pet-bounce {
    0% {
      transform: translateY(0) scale(1);
    }
    32% {
      transform: translateY(-0.42rem) scale(1.025);
    }
    62% {
      transform: translateY(0.06rem) scale(0.99);
    }
    100% {
      transform: translateY(0) scale(1);
    }
  }

  @keyframes pet-sprite-frames {
    0%,
    24.99% {
      background-position: 0% 50%;
    }
    25%,
    49.99% {
      background-position: 33.333% 50%;
    }
    50%,
    74.99% {
      background-position: 66.667% 50%;
    }
    75%,
    100% {
      background-position: 100% 50%;
    }
  }

  .identity {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 1.45rem;
  }

  .name-button {
    display: inline-flex;
    align-items: baseline;
    gap: 0.3rem;
    min-width: 0;
    max-width: 15rem;
    padding: 0;
    color: var(--text);
    font-size: 0.8125rem;
    font-weight: 600;
    line-height: 1.3;
  }

  .name-button:hover .name-text {
    text-decoration: underline;
    text-decoration-color: var(--faint);
    text-underline-offset: 2px;
  }

  .name-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pencil {
    flex: none;
    width: 0.6875rem;
    height: 0.6875rem;
    fill: none;
    stroke: var(--faint);
    stroke-width: 1.3;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .level-chip {
    flex: none;
    padding: 0.0625rem 0.375rem;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--muted);
    font-size: 0.5938rem;
    line-height: 1.35;
    font-variant-numeric: tabular-nums;
  }

  .rename {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    width: 100%;
    min-height: 1.45rem;
  }

  .name-input {
    flex: 1 1 auto;
    min-width: 0;
    height: 1.45rem;
    padding: 0 0.375rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--surface-2);
    color: var(--text);
    font-size: 0.75rem;
    outline: none;
    user-select: text;
    -webkit-user-select: text;
  }

  .name-input:focus-visible {
    border-color: var(--focus);
  }

  .mini {
    flex: none;
    padding: 0.125rem 0.375rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--surface-2);
    color: var(--muted);
    font-size: 0.625rem;
    line-height: 1.35;
  }

  .mini:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--border-strong, var(--border));
  }

  .mini.primary {
    border-color: transparent;
    background: var(--focus);
    color: #fff;
  }

  .mini:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .xp-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 0.9rem;
    margin-top: -0.125rem;
  }

  .xp-track {
    flex: 1 1 auto;
    height: 0.25rem;
    border-radius: 999px;
    background: var(--surface-3, var(--surface-2));
    overflow: hidden;
  }

  .xp-track span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--focus);
    transition: width 280ms var(--ease-out);
  }

  .xp-value {
    flex: none;
    color: var(--faint);
    font-size: 0.5938rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.5rem;
  }

  .stat {
    --metric: #e9a04a;
    min-width: 0;
  }

  .stat[data-kind='mood'] {
    --metric: #df8fa7;
  }

  .stat[data-kind='energy'] {
    --metric: #5fb2a4;
  }

  .stat-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.25rem;
    color: var(--muted);
    font-size: 0.625rem;
    line-height: 1.35;
  }

  .stat-head > span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stat-value {
    color: var(--faint);
    font-variant-numeric: tabular-nums;
  }

  .stat-value.low {
    color: var(--warn);
  }

  .stat-track {
    height: 0.25rem;
    margin-top: 0.15rem;
    border-radius: 999px;
    background: var(--surface-3, var(--surface-2));
    overflow: hidden;
  }

  .stat-track span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--metric);
    transition: width 280ms var(--ease-out);
  }

  .actions {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.3125rem;
  }

  .action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    min-width: 0;
    padding: 0.3125rem 0.25rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--surface-2);
    color: var(--muted);
    font-size: 0.6875rem;
    line-height: 1.25;
    transition:
      background var(--dur-ui) var(--ease-out),
      border-color var(--dur-ui) var(--ease-out),
      color var(--dur-ui) var(--ease-out);
  }

  .action:hover:not(:disabled) {
    border-color: var(--border-strong, var(--border));
    background: var(--surface-3, var(--surface-2));
    color: var(--text);
  }

  .action:active:not(:disabled) {
    transform: translateY(1px);
  }

  .action:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .action svg {
    flex: none;
    width: 0.75rem;
    height: 0.75rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .action span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .skins {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .skins-label {
    flex: none;
    color: var(--faint);
    font-size: 0.5938rem;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .skin-options {
    display: flex;
    flex: 1 1 auto;
    gap: 0.1875rem;
    min-width: 0;
    padding: 0.125rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--surface-2);
  }

  .skin-option {
    flex: 1 1 0;
    min-width: 0;
    padding: 0.1875rem 0.25rem;
    border: 0;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--muted);
    font-size: 0.5938rem;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition:
      background var(--dur-ui) var(--ease-out),
      color var(--dur-ui) var(--ease-out);
  }

  .skin-option:hover {
    color: var(--text);
  }

  .skin-option[aria-pressed='true'] {
    background: var(--surface-3, var(--surface-2));
    color: var(--text);
    box-shadow: inset 0 0 0 1px var(--border);
  }

  .skin-note {
    margin: -0.1875rem 0 0;
    color: var(--faint);
    font-size: 0.5625rem;
    line-height: 1.35;
  }

  .desktop {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem 0.75rem;
    padding: 0.3125rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--surface-2);
  }

  .desktop-option {
    display: inline-flex;
    align-items: center;
    gap: 0.3125rem;
    color: var(--muted);
    font-size: 0.625rem;
    line-height: 1.3;
    cursor: pointer;
  }

  .desktop-option input {
    flex: none;
    width: 0.75rem;
    height: 0.75rem;
    margin: 0;
    accent-color: var(--focus);
    cursor: pointer;
  }

  .sprite-bar {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding-top: 0.3125rem;
    border-top: 1px solid var(--border);
  }

  .sprite-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .ghost {
    flex: none;
    padding: 0.1875rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 0.4375rem;
    background: var(--surface-2);
    color: var(--text);
    font-size: 0.625rem;
    line-height: 1.35;
  }

  .ghost:hover:not(:disabled) {
    border-color: var(--border-strong, var(--border));
    background: var(--surface-3, var(--surface-2));
  }

  .ghost:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .sprite-reset {
    font-size: 0.625rem;
  }

  .footnote {
    min-height: 2.2em;
    margin: 0;
    color: var(--faint);
    font-size: 0.5938rem;
    line-height: 1.4;
  }

  .footnote.error {
    color: var(--critical);
  }

  @media (prefers-reduced-motion: reduce) {
    .sprite-strip,
    .mascot-button.reacting {
      animation: none !important;
    }

    .xp-track span,
    .stat-track span,
    .skin-option,
    .action {
      transition: none;
    }
  }
</style>
