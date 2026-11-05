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
  import { t, tDyn, hasKey, type MessageKey } from '$lib/i18n/i18n.svelte';
  import {
    OFFLINE_DECAY_CAP_MS,
    OFFLINE_NOTICE_MS,
    PET_NAME_MAX,
    PET_PLUGIN_ID,
    advancePet,
    applyAction,
    createDefaultPet,
    hasRiceFeast,
    parsePetState,
    petStatus,
    sanitizeName,
    xpForNextLevel,
    type DeepSeekForm,
    type PetAction,
    type PetReaction,
    type PetSkin,
    type PetState,
    type PetTheme,
  } from '$lib/pet/pet';
  import {
    ASSISTANT_QUESTION_LIMIT,
    answerPetQuestion,
    assistantSuggestion,
    buildAssistantContext,
    type AssistantContext,
    type AssistantPrevious,
    type AssistantSuggestionId,
    type AssistantTranslator,
  } from '$lib/pet/assistant';
  import {
    DEFAULT_LOCAL_AI,
    LOCAL_AI_STORAGE_ID,
    localAiReady,
    parseLocalAiConfig,
    selectLocalAiServer,
    serverSelectable,
    type LocalAiConfig,
    type LocalAiServer,
  } from '$lib/pet/local-ai';
  import { DEEPSEEK_FORM_OPTIONS, PET_SKIN_OPTIONS, skinImage } from '$lib/pet/skins';
  import {
    assetUrl,
    emitWindowEvent,
    importPetPack,
    isTauri,
    listPetPacks,
    localAiProbe,
    localAiStatus,
    petAiChat,
    pickPetPackFolder,
    removePetPack,
  } from '$lib/api';
  import Mochi from '$lib/pet/Mochi.svelte';
  import PackSprite from '$lib/pet/PackSprite.svelte';
  import PetScene from '$lib/pet/PetScene.svelte';
  import RiceFeast from '$lib/pet/RiceFeast.svelte';
  import ThemeGlyph from '$lib/pet/ThemeGlyph.svelte';
  import {
    moodPackMode,
    packIconPath,
    parsePetPack,
    type PackMode,
    type PetPack,
  } from '$lib/pet/pack';
  import { PET_THEME_OPTIONS, resolvePetTheme } from '$lib/pet/themes';
  import {
    parseStoredSprite,
    spriteFileError,
    validateSpriteFile,
    type PetSprite,
  } from '$lib/pet/sprite';
  import { petSituation, petVoice, sayKey, situationMood, type PetSituation } from '$lib/pet/speech';
  import { petSpeech } from '$lib/pet/speech.svelte';
  import { pluginStorageKey, readPluginState, removePluginState, writePluginState } from '$lib/plugins/storage';
  import { settings } from '$lib/stores/settings.svelte';
  import { snapshot } from '$lib/stores/snapshot.svelte';

  const ACTION_COOLDOWN_MS: Record<PetAction, number> = {
    feed: 2600,
    play: 2400,
    rest: 3200,
    pat: 1200,
  };
  /** How long the DeepSeek rice cutscene stays on screen. */
  const FEAST_MS = 6000;

  interface ChatMessage {
    id: number;
    role: 'user' | 'assistant';
    text: string;
    source: 'builtin' | 'local' | null;
    model: string | null;
  }

  const INITIAL_SUGGESTIONS: AssistantSuggestionId[] = [
    'quota',
    'reset',
    'pet',
    'feed',
    'play',
    'summary',
  ];
  const BUILTIN_ONLY_INTENTS = new Set([
    'action',
    'help',
    'greeting',
    'thanks',
  ]);

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
  /** The rice cutscene is showing; the action itself is already applied. */
  let feasting = $state(false);
  let feastTimer: ReturnType<typeof setTimeout> | null = null;
  let cooldowns = $state<Record<PetAction, boolean>>({
    feed: false,
    play: false,
    rest: false,
    pat: false,
  });

  let packs = $state<PetPack[]>([]);
  let packsLoading = $state(true);
  let packsLoaded = $state(false);
  let packBusy = $state(false);
  let packError = $state<string | null>(null);

  // Assistant chat lives only in this panel's memory; no history is persisted.
  let messages = $state<ChatMessage[]>([]);
  let questionDraft = $state('');
  let thinking = $state(false);
  let previous = $state<AssistantPrevious | null>(null);
  let suggestionIds = $state<AssistantSuggestionId[]>([...INITIAL_SUGGESTIONS]);
  let chatLog = $state<HTMLDivElement>();
  let modelNotice = $state<string | null>(null);
  let nextMessageId = 1;
  let chatToken = 0;

  // Optional local model: the config is persisted, the discovered list is not.
  let aiConfig = $state<LocalAiConfig>({ ...DEFAULT_LOCAL_AI });
  let servers = $state<LocalAiServer[]>([]);
  let serversLoaded = $state(false);
  let checkingServers = $state(false);
  let modelOpen = $state(false);
  let modelError = $state<string | null>(null);
  let customEndpoint = $state('');
  let probingCustom = $state(false);
  let customError = $state<string | null>(null);

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
  const theme = $derived(resolvePetTheme(pet.skin, pet.theme));
  const selectedPack = $derived(packs.find((entry) => entry.id === pet.packId) ?? null);
  const packIcon = $derived(selectedPack?.icon ? assetUrl(packIconPath(selectedPack)) : null);
  /** Reactions borrow the pack's pat/sleep act for a moment. */
  const packMode = $derived.by((): PackMode => {
    if (reacting) return reaction === 'rest' ? 'sleep' : 'pat';
    return moodPackMode(status);
  });
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
  /** Bundled DeepSeek chibi art only; a sprite or pack keeps its own look. */
  const feastable = $derived(hasRiceFeast(pet));
  const showFeast = $derived(feasting && feastable);
  const feastLabel = $derived(t('plugin.pet.rice.eating', { name: pet.name }));
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
  const assistantT: AssistantTranslator = (key, params) => tDyn(key, params);
  const selectedServer = $derived(
    servers.find((server) => server.baseUrl === aiConfig.baseUrl) ?? null
  );
  const modelOptions = $derived.by(() => {
    const list = selectedServer?.models ?? [];
    if (aiConfig.model && !list.includes(aiConfig.model)) return [aiConfig.model, ...list];
    return list;
  });
  const localActive = $derived(localAiReady(aiConfig) && isTauri());
  const assistantModel = $derived(localActive ? aiConfig.model : null);

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

  function persistNow(action?: PetAction) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    writePluginState(PET_PLUGIN_ID, copyState(pet));
    // The detached window may be open; it adopts the panel's newer state and
    // replays the same interaction (the rice cutscene included).
    void emitWindowEvent('pet', 'pet-state', {
      state: copyState(pet),
      action: action ?? null,
    });
  }

  /** Adopt a state another window (the detached pet) saved, if it is newer. */
  function adoptStoredState() {
    const stored = parsePetState(readPluginState<unknown>(PET_PLUGIN_ID, null), Date.now());
    if (stored.lastSeen <= pet.lastSeen) return;
    const mealsBefore = pet.meals;
    pet = advancePet(stored, Date.now()).state;
    // A feed in the desktop window plays the same cutscene here.
    if (pet.meals > mealsBefore) startFeast();
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
      }, 1000);
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

  /** Restart the six-second DeepSeek rice cutscene, if this pet can show it. */
  function startFeast() {
    if (!hasRiceFeast(pet)) return;
    feasting = true;
    if (feastTimer) clearTimeout(feastTimer);
    feastTimer = setTimeout(() => {
      feastTimer = null;
      feasting = false;
    }, FEAST_MS);
  }

  function stopFeast() {
    if (feastTimer) {
      clearTimeout(feastTimer);
      feastTimer = null;
    }
    feasting = false;
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
    if (action === 'feed') {
      // Feeding also runs in the detached window, so persist and announce it
      // immediately instead of waiting for the drag coalescer.
      startFeast();
      persistNow('feed');
      markSaved();
    } else {
      scheduleSave();
    }
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
    if (pet.skin === skin && pet.packId === null) return;
    const option = PET_SKIN_OPTIONS.find((entry) => entry.id === skin);
    const defaultNames = PET_SKIN_OPTIONS.map((entry) => t(entry.defaultName));
    // Follow the new character's name while the pet still uses a built-in one;
    // a name the user typed is never overwritten.
    const name = option && defaultNames.includes(pet.name) ? t(option.defaultName) : pet.name;
    const now = Date.now();
    // Choosing a bundled skin deliberately leaves an imported pack.
    pet = { ...advancePet(pet, now).state, skin, name, packId: null, lastSeen: now };
    stopFeast();
    clearReaction();
    error = null;
    packError = null;
    scheduleSave();
  }

  function chooseTheme(theme: PetTheme) {
    if (pet.theme === theme) return;
    const now = Date.now();
    pet = { ...advancePet(pet, now).state, theme, lastSeen: now };
    clearReaction();
    error = null;
    scheduleSave();
  }

  function chooseForm(form: DeepSeekForm) {
    if (pet.deepseekForm === form) return;
    const now = Date.now();
    pet = { ...advancePet(pet, now).state, deepseekForm: form, lastSeen: now };
    stopFeast();
    clearReaction();
    error = null;
    scheduleSave();
  }

  function messageOf(value: unknown): string {
    if (value instanceof Error) return value.message;
    if (typeof value === 'string') return value;
    return String(value);
  }

  function localAiErrorText(cause: unknown): string {
    const raw = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
    const key = `plugin.pet.assistant.error.${raw.trim().toLowerCase()}`;
    return raw && hasKey(key) ? tDyn(key) : t('plugin.pet.assistant.error.generic');
  }

  function serverName(server: LocalAiServer): string {
    const key = `plugin.pet.assistant.model.server.${server.id}`;
    return hasKey(key) ? tDyn(key) : server.name || server.id;
  }

  function issueText(issue: string | null): string {
    if (!issue) return '';
    const key = `plugin.pet.assistant.model.issue.${issue}`;
    return hasKey(key) ? tDyn(key) : issue;
  }

  function assistantContext(): AssistantContext {
    return {
      snapshot: snapshot.value,
      pet,
      settings: settings.value,
      t: assistantT,
      now: Date.now(),
      localModel: assistantModel,
      cooldowns,
      previous,
    };
  }

  function addChatMessage(message: Omit<ChatMessage, 'id'>) {
    messages = [...messages, { id: nextMessageId++, ...message }].slice(-16);
  }

  async function scrollChat() {
    await tick();
    if (chatLog) chatLog.scrollTop = chatLog.scrollHeight;
  }

  function seedChat() {
    const answer = answerPetQuestion('hello', assistantContext());
    messages = [
      { id: nextMessageId++, role: 'assistant', text: answer.text, source: 'builtin', model: null },
    ];
    suggestionIds = ['quota', 'reset', 'pet', 'summary'];
    previous = null;
  }

  function resetChat() {
    chatToken += 1;
    thinking = false;
    modelNotice = null;
    seedChat();
    void scrollChat();
  }

  function saveAiConfig(next: LocalAiConfig) {
    aiConfig = next;
    writePluginState(LOCAL_AI_STORAGE_ID, next);
  }

  function toggleModelSettings() {
    modelOpen = !modelOpen;
    if (modelOpen && !serversLoaded) void refreshLocalAi();
  }

  async function refreshLocalAi() {
    if (!isTauri() || checkingServers) return;
    checkingServers = true;
    modelError = null;
    try {
      let list = await localAiStatus();
      // A saved custom endpoint is not one of the three known ports; probe it
      // again so its model list and state are fresh when settings are opened.
      if (aiConfig.baseUrl && !list.some((server) => server.baseUrl === aiConfig.baseUrl)) {
        try {
          list = [...list, await localAiProbe(aiConfig.baseUrl)];
        } catch (cause) {
          modelError = localAiErrorText(cause);
        }
      }
      servers = list;
      if (!aiConfig.baseUrl) {
        const first = list.find(serverSelectable);
        if (first) saveAiConfig(selectLocalAiServer(aiConfig, first));
      }
    } catch (cause) {
      modelError = localAiErrorText(cause);
    } finally {
      checkingServers = false;
      serversLoaded = true;
    }
  }

  function chooseServer(server: LocalAiServer) {
    if (!serverSelectable(server)) return;
    saveAiConfig(selectLocalAiServer(aiConfig, server));
    modelError = null;
    customError = null;
  }

  function onModelPicked(event: Event) {
    const model = (event.currentTarget as HTMLSelectElement).value;
    if (!model) return;
    saveAiConfig({ ...aiConfig, model });
  }

  function setLocalAiEnabled(event: Event) {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    if (enabled && !localAiReady({ ...aiConfig, enabled: true })) return;
    saveAiConfig({ ...aiConfig, enabled });
  }

  async function probeCustomEndpoint() {
    if (!isTauri() || probingCustom) return;
    const base = customEndpoint.trim();
    if (!base) return;
    probingCustom = true;
    customError = null;
    try {
      const server = await localAiProbe(base);
      servers = [...servers.filter((entry) => entry.id !== 'custom'), server];
      serversLoaded = true;
      if (serverSelectable(server)) {
        saveAiConfig(selectLocalAiServer(aiConfig, server));
        customEndpoint = server.baseUrl;
      } else {
        customError = t('plugin.pet.assistant.model.customError', {
          message: issueText(server.issue) || t('plugin.pet.assistant.model.noSelection'),
        });
      }
    } catch (cause) {
      customError = t('plugin.pet.assistant.model.customError', {
        message: localAiErrorText(cause),
      });
    } finally {
      probingCustom = false;
    }
  }

  function useSuggestion(id: AssistantSuggestionId) {
    const suggestion = assistantSuggestion(id);
    void ask(suggestion.command, tDyn(suggestion.labelKey));
  }

  function submitChat(event: SubmitEvent) {
    event.preventDefault();
    void ask(questionDraft);
  }

  /**
   * Answer one question. The deterministic answer is always computed: it is
   * the reply itself when no model is connected, and the fallback when the
   * local model is busy or rejects the request. Actions run immediately.
   */
  async function ask(raw: string, display?: string) {
    if (thinking) return;
    const question = raw.trim().slice(0, ASSISTANT_QUESTION_LIMIT);
    if (!question) return;
    questionDraft = '';
    addChatMessage({
      role: 'user',
      text: (display?.trim() || question).slice(0, ASSISTANT_QUESTION_LIMIT),
      source: null,
      model: null,
    });
    const answer = answerPetQuestion(question, assistantContext());
    previous = { intent: answer.intent, provider: answer.provider };
    suggestionIds = [...answer.suggestions];
    if (answer.action) perform(answer.action);
    modelNotice = null;
    const token = ++chatToken;
    const useLocal = assistantModel !== null && !BUILTIN_ONLY_INTENTS.has(answer.intent);
    if (!useLocal) {
      addChatMessage({ role: 'assistant', text: answer.text, source: 'builtin', model: null });
      await scrollChat();
      return;
    }
    thinking = true;
    await scrollChat();
    try {
      const reply = await petAiChat({
        baseUrl: aiConfig.baseUrl,
        model: aiConfig.model,
        question,
        context: buildAssistantContext(snapshot.value, pet, settings.value),
        // Give the model the app's grounded answer so it can phrase it warmly
        // instead of re-deriving (and sometimes misreading) the figures.
        reference: answer.intent === 'unknown' ? '' : answer.text,
      });
      if (token !== chatToken) return;
      addChatMessage({
        role: 'assistant',
        text: reply.text,
        source: 'local',
        model: reply.model || aiConfig.model,
      });
    } catch (cause) {
      if (token !== chatToken) return;
      modelNotice = localAiErrorText(cause);
      addChatMessage({ role: 'assistant', text: answer.text, source: 'builtin', model: null });
    } finally {
      if (token === chatToken) thinking = false;
      await scrollChat();
    }
  }

  function sortPacks(list: PetPack[]): PetPack[] {
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Load the installed packs and reconcile a selection removed outside the app. */
  async function refreshPacks() {
    packsLoading = true;
    try {
      const loaded = (await listPetPacks())
        .map(parsePetPack)
        .filter((entry): entry is PetPack => entry !== null);
      packs = sortPacks(loaded);
      if (pet.packId && !packs.some((entry) => entry.id === pet.packId)) {
        const now = Date.now();
        pet = { ...advancePet(pet, now).state, packId: null, lastSeen: now };
        scheduleSave();
      }
      packError = null;
    } catch (cause) {
      packError = t('plugin.pet.pack.error', { message: messageOf(cause) });
    } finally {
      packsLoading = false;
      packsLoaded = true;
    }
  }

  function selectPack(id: string) {
    const pack = id ? packs.find((entry) => entry.id === id) ?? null : null;
    if (pack === null && id !== '') return;
    if ((pack?.id ?? null) === pet.packId) return;
    const now = Date.now();
    const advanced = advancePet(pet, now).state;
    const builtInNames = [
      ...PET_SKIN_OPTIONS.map((entry) => t(entry.defaultName)),
      ...packs.map((entry) => entry.name),
    ];
    // As with skins, only a name that still belongs to a bundled character or
    // another pack is replaced; a name the user typed is kept.
    const name =
      pack && builtInNames.includes(pet.name)
        ? sanitizeName(pack.name, pet.name)
        : pet.name;
    pet = { ...advanced, packId: pack?.id ?? null, name, lastSeen: now };
    stopFeast();
    clearReaction();
    error = null;
    packError = null;
    scheduleSave();
    if (pack) triggerReaction();
  }

  function onPackPicked(event: Event) {
    selectPack((event.currentTarget as HTMLSelectElement).value);
  }

  async function importPack() {
    if (packBusy || !isTauri()) return;
    packBusy = true;
    packError = null;
    try {
      const folder = await pickPetPackFolder();
      if (!folder) return;
      const pack = parsePetPack(await importPetPack(folder));
      if (!pack) {
        packError = t('plugin.pet.pack.error', { message: t('plugin.pet.pack.invalid') });
        return;
      }
      packs = sortPacks([...packs.filter((entry) => entry.id !== pack.id), pack]);
      selectPack(pack.id);
      markSaved();
    } catch (cause) {
      packError = t('plugin.pet.pack.error', { message: messageOf(cause) });
    } finally {
      packBusy = false;
    }
  }

  async function removeSelectedPack() {
    const pack = selectedPack;
    if (!pack || packBusy) return;
    if (!window.confirm(t('plugin.pet.pack.removeConfirm', { name: pack.name }))) return;
    packBusy = true;
    packError = null;
    try {
      await removePetPack(pack.id);
      packs = packs.filter((entry) => entry.id !== pack.id);
      if (pet.packId === pack.id) {
        const now = Date.now();
        pet = { ...advancePet(pet, now).state, packId: null, lastSeen: now };
        scheduleSave();
      }
      markSaved();
    } catch (cause) {
      packError = t('plugin.pet.pack.error', { message: messageOf(cause) });
    } finally {
      packBusy = false;
    }
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
    stopFeast();
    clearReaction();
    error = null;
    scheduleSave();
  }

  function resetPet() {
    if (!window.confirm(t('plugin.pet.resetConfirm'))) return;
    stopFeast();
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
    packError = null;
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

    aiConfig = parseLocalAiConfig(readPluginState(LOCAL_AI_STORAGE_ID, null));
    if (aiConfig.serverId === 'custom') customEndpoint = aiConfig.baseUrl;
    seedChat();
    // Re-check a previously enabled server in the background; chat itself
    // falls back to built-in answers if it has gone away.
    if (aiConfig.enabled) void refreshLocalAi();

    const tickTimer = setInterval(() => {
      pet = advancePet(pet, Date.now()).state;
    }, 30_000);

    // Imported packs live in app data, not localStorage: the panel asks the
    // backend once per open and drops a selection whose folder has gone away.
    void refreshPacks();

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
      chatToken += 1;
      thinking = false;
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
      if (feastTimer) {
        clearTimeout(feastTimer);
        feastTimer = null;
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

  <div class="scene" data-status={status} data-pet-theme={theme}>
    <PetScene theme={theme} />
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
      {:else if pet.packId && !packsLoaded}
        <span class="pack-placeholder" aria-hidden="true"></span>
      {:else if selectedPack}
        <span class="pack-art">
          <PackSprite
            pack={selectedPack}
            mode={packMode}
            fullness={pet.fullness}
            level={pet.level}
          />
        </span>
      {:else if showFeast}
        <span class="feast-art">
          <RiceFeast active label={feastLabel} />
        </span>
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
      {#if pet.meals > 0}
        <span
          class="meals-chip"
          role="img"
          aria-label={t('plugin.pet.meals', { count: pet.meals })}
          title={t('plugin.pet.meals.title')}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.2 7.4h11.6c0 3.4-2.6 5.6-5.8 5.6S2.2 10.8 2.2 7.4Z" />
            <path d="M5.3 5.8c0-1.2.9-1.5.9-2.5M8 5.8c0-1.2.9-1.5.9-2.5M10.7 5.8c0-1.2.9-1.5.9-2.5" />
          </svg>
          {pet.meals}
        </span>
      {/if}
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

  <section class="assistant" aria-labelledby="pet-assistant-title" aria-busy={thinking}>
    <header class="assistant-head">
      <div class="assistant-title">
        <svg class="assistant-icon" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 1.6 9.4 5l3.4 1.4L9.4 7.8 8 11.2 6.6 7.8 3.2 6.4 6.6 5 8 1.6ZM12.6 10l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7.7-1.7Z" />
        </svg>
        <div class="assistant-heading">
          <strong id="pet-assistant-title">{t('plugin.pet.assistant.title')}</strong>
          <span>{t('plugin.pet.assistant.subtitle')}</span>
        </div>
      </div>
      <div class="assistant-tools">
        <button class="link" type="button" onclick={resetChat}>
          {t('plugin.pet.assistant.clear')}
        </button>
        <button
          class="link"
          type="button"
          onclick={toggleModelSettings}
          aria-expanded={modelOpen}
          aria-controls="pet-model-settings"
        >
          {t('plugin.pet.assistant.model.configure')}
        </button>
      </div>
    </header>

    {#if modelOpen}
      <div class="model-settings" id="pet-model-settings">
        <p class="model-desc">{t('plugin.pet.assistant.model.desc')}</p>
        <p class="model-privacy">{t('plugin.pet.assistant.model.privacy')}</p>
        <p class="model-recommend">{t('plugin.pet.assistant.model.recommend')}</p>
        {#if !isTauri()}
          <p class="model-note">{t('plugin.pet.assistant.model.desktopOnly')}</p>
        {:else}
          <div class="model-actions">
            <button
              class="ghost model-check"
              type="button"
              onclick={refreshLocalAi}
              disabled={checkingServers}
              aria-busy={checkingServers}
            >
              {checkingServers
                ? t('plugin.pet.assistant.model.checking')
                : t('plugin.pet.assistant.model.check')}
            </button>
            <code class="model-hint">{t('plugin.pet.assistant.model.hint')}</code>
          </div>
          {#if modelError}
            <p class="model-error" role="status">{modelError}</p>
          {/if}
          {#if serversLoaded && servers.length === 0}
            <p class="model-note">{t('plugin.pet.assistant.model.none')}</p>
          {:else if servers.length > 0}
            <div class="server-list" role="group" aria-label={t('plugin.pet.assistant.model.title')}>
              {#each servers as server (server.id)}
                <div
                  class="server"
                  class:selected={server.baseUrl === aiConfig.baseUrl}
                  class:off={!serverSelectable(server)}
                >
                  <div class="server-info">
                    <strong>{serverName(server)}</strong>
                    <span title={server.models.join(', ')}>
                      {#if server.models.length > 0}
                        {t('plugin.pet.assistant.model.models', { count: server.models.length })}
                        · {server.models.slice(0, 2).join(', ')}{server.models.length > 2
                          ? '…'
                          : ''}
                      {:else}
                        {issueText(server.issue)}
                      {/if}
                    </span>
                  </div>
                  <button
                    class="mini server-use"
                    type="button"
                    onclick={() => chooseServer(server)}
                    disabled={!serverSelectable(server)}
                  >
                    {server.baseUrl === aiConfig.baseUrl
                      ? t('plugin.pet.assistant.model.selected')
                      : t('plugin.pet.assistant.model.use')}
                  </button>
                </div>
              {/each}
            </div>
          {/if}
          {#if modelOptions.length > 0}
            <label class="model-field">
              <span>{t('plugin.pet.assistant.model.model')}</span>
              <select value={aiConfig.model} onchange={onModelPicked}>
                {#each modelOptions as model (model)}
                  <option value={model}>{model}</option>
                {/each}
              </select>
            </label>
          {/if}
          <label class="model-enable">
            <input
              type="checkbox"
              checked={aiConfig.enabled}
              disabled={!aiConfig.baseUrl || !aiConfig.model}
              onchange={setLocalAiEnabled}
            />
            <span>{t('plugin.pet.assistant.model.enable')}</span>
          </label>
          <p class="model-note">
            {aiConfig.enabled
              ? t('plugin.pet.assistant.model.enabledHint')
              : aiConfig.baseUrl && aiConfig.model
                ? t('plugin.pet.assistant.model.disabledHint')
                : t('plugin.pet.assistant.model.noSelection')}
          </p>
          <div class="custom-endpoint">
            <label class="model-field">
              <span>{t('plugin.pet.assistant.model.custom')}</span>
              <input
                type="url"
                bind:value={customEndpoint}
                maxlength={300}
                placeholder={t('plugin.pet.assistant.model.customPlaceholder')}
                spellcheck="false"
                autocomplete="off"
              />
            </label>
            <button
              class="ghost"
              type="button"
              onclick={probeCustomEndpoint}
              disabled={probingCustom || !customEndpoint.trim()}
              aria-busy={probingCustom}
            >
              {probingCustom
                ? t('plugin.pet.assistant.model.probing')
                : t('plugin.pet.assistant.model.probe')}
            </button>
          </div>
          {#if customError}
            <p class="model-error" role="status">{customError}</p>
          {/if}
        {/if}
      </div>
    {/if}

    <div
      class="assistant-log"
      bind:this={chatLog}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
    >
      {#each messages as message (message.id)}
        <div class="chat-message" data-role={message.role}>
          <span class="chat-who">
            {message.role === 'user' ? t('plugin.pet.assistant.you') : pet.name}
          </span>
          <div class="chat-bubble">
            <p>{message.text}</p>
            {#if message.role === 'assistant'}
              <span class="chat-source">
                {message.source === 'local'
                  ? t('plugin.pet.assistant.local', { model: message.model ?? '' })
                  : t('plugin.pet.assistant.builtin')}
              </span>
            {/if}
          </div>
        </div>
      {/each}
      {#if thinking}
        <div class="chat-message" data-role="assistant">
          <span class="chat-who">{pet.name}</span>
          <div class="chat-bubble chat-thinking">
            <span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>
            {t('plugin.pet.assistant.thinking', { name: pet.name })}
          </div>
        </div>
      {/if}
    </div>

    {#if modelNotice}
      <p class="assistant-notice" role="status">{modelNotice}</p>
    {/if}

    <div
      class="assistant-suggestions"
      role="group"
      aria-label={t('plugin.pet.assistant.title')}
    >
      {#each suggestionIds as id (id)}
        <button
          class="assistant-chip"
          type="button"
          onclick={() => useSuggestion(id)}
          disabled={thinking}
        >
          {tDyn(assistantSuggestion(id).labelKey)}
        </button>
      {/each}
    </div>

    <form class="assistant-form" onsubmit={submitChat}>
      <input
        class="assistant-input"
        bind:value={questionDraft}
        type="text"
        maxlength={ASSISTANT_QUESTION_LIMIT}
        placeholder={t('plugin.pet.assistant.placeholder')}
        aria-label={t('plugin.pet.assistant.placeholder')}
        autocomplete="off"
      />
      <button
        class="assistant-send"
        type="submit"
        disabled={thinking || !questionDraft.trim()}
      >
        {t('plugin.pet.assistant.send')}
      </button>
    </form>
  </section>

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

  <div class="themes" role="group" aria-label={t('plugin.pet.theme')}>
    <span class="skins-label" aria-hidden="true">{t('plugin.pet.theme')}</span>
    <div class="theme-options">
      {#each PET_THEME_OPTIONS as option (option.id)}
        <button
          class="theme-option"
          type="button"
          aria-pressed={pet.theme === option.id}
          title={t(option.hint)}
          onclick={() => chooseTheme(option.id)}
        >
          <span class="theme-swatch" data-pet-theme={option.id}>
            <ThemeGlyph theme={option.id} />
          </span>
          <span class="theme-name">{t(option.label)}</span>
        </button>
      {/each}
    </div>
  </div>

  <div class="packs" role="group" aria-label={t('plugin.pet.pack')}>
    <div class="packs-head">
      <span class="skins-label" aria-hidden="true">{t('plugin.pet.pack')}</span>
      <div class="pack-tools">
        <button
          class="ghost pack-import"
          type="button"
          onclick={importPack}
          disabled={packBusy || !isTauri()}
          aria-busy={packBusy}
          title={isTauri() ? t('plugin.pet.pack.empty') : t('plugin.pet.pack.desktopOnly')}
        >
          {packBusy ? t('plugin.pet.pack.importing') : t('plugin.pet.pack.import')}
        </button>
        <button
          class="link pack-remove"
          type="button"
          onclick={removeSelectedPack}
          disabled={!selectedPack || packBusy}
        >
          {t('plugin.pet.pack.remove')}
        </button>
      </div>
    </div>
    <div class="pack-row">
      <select
        class="pack-select"
        value={pet.packId ?? ''}
        onchange={onPackPicked}
        aria-label={t('plugin.pet.pack')}
        disabled={packsLoading || packBusy}
      >
        <option value="">{t('plugin.pet.pack.bundled')}</option>
        {#each packs as pack (pack.id)}
          <option value={pack.id}>{pack.name}{pack.author ? ` — ${pack.author}` : ''}</option>
        {/each}
      </select>
      {#if packIcon}
        <img class="pack-icon" src={packIcon} alt="" draggable="false" />
      {/if}
    </div>
    <p class="pack-note" class:error={!!packError} aria-live="polite">
      {#if packError}
        {packError}
      {:else if !isTauri()}
        {t('plugin.pet.pack.desktopOnly')}
      {:else if packsLoaded && packs.length === 0}
        {t('plugin.pet.pack.empty')}
      {:else}
        {t('plugin.pet.pack.hint')}
      {/if}
    </p>
  </div>

  {#if sprite}
    <p class="skin-note">{t('plugin.pet.skin.overridden')}</p>
    {#if selectedPack}
      <p class="skin-note">{t('plugin.pet.pack.overridden')}</p>
    {/if}
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
    border: 1px solid var(--pet-scene-border, var(--border));
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
    border: 1px solid var(--pet-bubble-border, var(--border));
    border-radius: 0.5rem;
    background: var(--pet-bubble-bg, var(--surface-3, var(--surface-2)));
    color: var(--pet-bubble-text, var(--muted));
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

  /* The cutout is square and transparent, so it floats over the scene instead
     of sitting in a white sticker card like the static moods. */
  .feast-art {
    display: block;
    width: 5.6rem;
    height: 5.6rem;
    margin-bottom: 0.1rem;
  }

  .pack-art {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    width: 5.9rem;
    height: 5.5rem;
  }

  .pack-placeholder {
    width: 4rem;
    height: 4rem;
    margin-bottom: 0.2rem;
    border-radius: 50%;
    background: var(--surface-2);
    opacity: 0.45;
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

  .meals-chip {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 0.1875rem;
    padding: 0.0625rem 0.375rem;
    border: 1px solid color-mix(in srgb, var(--warn) 26%, var(--border));
    border-radius: 999px;
    background: color-mix(in srgb, var(--warn) 9%, var(--surface-2));
    color: var(--muted);
    font-size: 0.5938rem;
    line-height: 1.35;
    font-variant-numeric: tabular-nums;
  }

  .meals-chip svg {
    width: 0.625rem;
    height: 0.625rem;
    fill: none;
    stroke: var(--warn);
    stroke-width: 1.25;
    stroke-linecap: round;
    stroke-linejoin: round;
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

  .assistant {
    display: flex;
    flex-direction: column;
    gap: 0.4375rem;
    padding: 0.5rem;
    border: 1px solid var(--border);
    border-radius: 0.625rem;
    background: var(--surface-2);
  }

  .assistant-head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.3125rem;
  }

  .assistant-title {
    display: flex;
    flex: 1 1 9rem;
    gap: 0.375rem;
    min-width: 0;
  }

  .assistant-icon {
    flex: none;
    width: 0.9375rem;
    height: 0.9375rem;
    margin-top: 0.0625rem;
    fill: var(--focus);
  }

  .assistant-heading {
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
    min-width: 0;
  }

  .assistant-heading strong {
    color: var(--text);
    font-size: 0.75rem;
    font-weight: 600;
    line-height: 1.25;
  }

  .assistant-heading span {
    color: var(--faint);
    font-size: 0.5625rem;
    line-height: 1.3;
  }

  .assistant-tools {
    display: flex;
    flex: none;
    align-items: center;
    gap: 0.4375rem;
  }

  .assistant-tools .link {
    font-size: 0.625rem;
  }

  .model-settings {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.4375rem;
    border: 1px solid var(--border);
    border-radius: 0.4375rem;
    background: var(--surface-3, var(--surface-2));
  }

  .model-desc,
  .model-privacy,
  .model-recommend,
  .model-note,
  .model-error {
    margin: 0;
    font-size: 0.5938rem;
    line-height: 1.4;
  }

  .model-desc {
    color: var(--muted);
  }

  .model-privacy,
  .model-recommend,
  .model-note {
    color: var(--faint);
  }

  .model-error {
    color: var(--critical);
  }

  .model-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
  }

  .model-check {
    font-size: 0.625rem;
  }

  .model-hint {
    display: block;
    max-width: 100%;
    padding: 0.125rem 0.3125rem;
    border-radius: 0.3125rem;
    background: var(--surface-2);
    color: var(--muted);
    font-size: 0.5625rem;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .server-list {
    display: flex;
    flex-direction: column;
    gap: 0.1875rem;
  }

  .server {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.3125rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--surface-2);
  }

  .server.selected {
    border-color: color-mix(in srgb, var(--focus) 45%, var(--border));
    background: color-mix(in srgb, var(--focus) 8%, var(--surface-2));
  }

  .server.off {
    opacity: 0.68;
  }

  .server-info {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 0.0625rem;
    min-width: 0;
  }

  .server-info strong {
    color: var(--text);
    font-size: 0.625rem;
    font-weight: 600;
    line-height: 1.25;
  }

  .server-info span {
    color: var(--faint);
    font-size: 0.5625rem;
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .server-use {
    flex: none;
    padding: 0.0625rem 0.3125rem;
    font-size: 0.5625rem;
  }

  .model-field {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
    color: var(--muted);
    font-size: 0.5938rem;
  }

  .model-field > span {
    flex: none;
    min-width: 5rem;
  }

  .model-field select,
  .model-field input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0.25rem 0.3125rem;
    border: 1px solid var(--border);
    border-radius: 0.375rem;
    background: var(--surface-2);
    color: var(--text);
    font-size: 0.625rem;
  }

  .model-field select:focus-visible,
  .model-field input:focus-visible,
  .assistant-input:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--focus) 65%, transparent);
    outline-offset: 1px;
  }

  .model-enable {
    display: flex;
    align-items: center;
    gap: 0.3125rem;
    color: var(--text);
    font-size: 0.625rem;
  }

  .model-enable input {
    accent-color: var(--focus);
  }

  .custom-endpoint {
    display: flex;
    align-items: flex-end;
    gap: 0.25rem;
  }

  .custom-endpoint .model-field {
    flex: 1 1 auto;
  }

  .assistant-log {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    max-height: 13.5rem;
    padding-right: 0.125rem;
    overflow-y: auto;
    scrollbar-width: thin;
  }

  .chat-message {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    max-width: 92%;
    min-width: 0;
  }

  .chat-message[data-role='user'] {
    align-self: flex-end;
    align-items: flex-end;
  }

  .chat-who {
    color: var(--faint);
    font-size: 0.5625rem;
    line-height: 1.2;
  }

  .chat-bubble {
    min-width: 0;
    padding: 0.3125rem 0.4375rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--surface-3, var(--surface-2));
  }

  .chat-message[data-role='user'] .chat-bubble {
    border-color: color-mix(in srgb, var(--focus) 35%, var(--border));
    background: color-mix(in srgb, var(--focus) 12%, var(--surface-2));
  }

  .chat-bubble p {
    margin: 0;
    color: var(--text);
    font-size: 0.6875rem;
    line-height: 1.45;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .chat-source {
    display: block;
    margin-top: 0.1875rem;
    color: var(--faint);
    font-size: 0.5625rem;
    line-height: 1.25;
  }

  .chat-thinking {
    display: flex;
    align-items: center;
    gap: 0.3125rem;
    color: var(--muted);
    font-size: 0.6875rem;
    line-height: 1.3;
  }

  .typing {
    display: inline-flex;
    flex: none;
    gap: 2px;
  }

  .typing i {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: currentColor;
    animation: pet-typing 1s ease-in-out infinite;
  }

  .typing i:nth-child(2) {
    animation-delay: 0.15s;
  }

  .typing i:nth-child(3) {
    animation-delay: 0.3s;
  }

  @keyframes pet-typing {
    0%,
    60%,
    100% {
      opacity: 0.25;
      transform: translateY(0);
    }
    30% {
      opacity: 1;
      transform: translateY(-2px);
    }
  }

  .assistant-notice {
    margin: 0;
    padding: 0.25rem 0.375rem;
    border-radius: 0.375rem;
    background: color-mix(in srgb, var(--critical) 10%, transparent);
    color: var(--critical);
    font-size: 0.5938rem;
    line-height: 1.35;
  }

  .assistant-suggestions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .assistant-chip {
    padding: 0.1875rem 0.4375rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--muted);
    font-size: 0.5938rem;
    line-height: 1.3;
    transition:
      border-color var(--dur-ui) var(--ease-out),
      color var(--dur-ui) var(--ease-out);
  }

  .assistant-chip:hover:not(:disabled) {
    border-color: var(--border-strong, var(--border));
    color: var(--text);
  }

  .assistant-chip:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .assistant-form {
    display: flex;
    gap: 0.25rem;
  }

  .assistant-input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0.3125rem 0.4375rem;
    border: 1px solid var(--border);
    border-radius: 0.4375rem;
    background: var(--surface);
    color: var(--text);
    font-size: 0.6875rem;
    line-height: 1.3;
  }

  .assistant-input::placeholder {
    color: var(--faint);
  }

  .assistant-send {
    flex: none;
    padding: 0.3125rem 0.5625rem;
    border-radius: 0.4375rem;
    background: var(--focus);
    color: #fff;
    font-size: 0.6875rem;
    font-weight: 600;
    line-height: 1.3;
  }

  .assistant-send:disabled {
    opacity: 0.45;
    cursor: default;
  }

  @media (prefers-reduced-motion: reduce) {
    .typing i {
      animation: none;
    }
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

  .themes {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .theme-options {
    display: grid;
    flex: 1 1 auto;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.1875rem;
    min-width: 0;
    padding: 0.125rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--surface-2);
  }

  .theme-option {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
    padding: 0.2rem 0.35rem;
    border: 0;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--muted);
    font-size: 0.5938rem;
    line-height: 1.3;
    text-align: left;
  }

  .theme-option:hover {
    color: var(--text);
  }

  .theme-option[aria-pressed='true'] {
    background: var(--surface-3, var(--surface-2));
    color: var(--text);
    box-shadow: inset 0 0 0 1px var(--border);
  }

  .theme-swatch {
    display: grid;
    flex: none;
    place-items: center;
    width: 1.1rem;
    height: 1.1rem;
    border-radius: 0.3rem;
    background: var(--pet-swatch, linear-gradient(135deg, #fbf7ea, #c9eef6));
    color: var(--pet-scene-text, #fff);
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.12);
  }

  .theme-swatch[data-pet-theme='auto'] {
    background: conic-gradient(from 210deg, #fbf7ea, #8fae7a, #0a2233, #3fd8e6, #fbf7ea);
    color: #fff;
  }

  .theme-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .packs {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .packs-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .pack-tools {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .pack-import {
    max-width: 11rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pack-remove {
    font-size: 0.625rem;
  }

  .pack-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .pack-select {
    flex: 1 1 auto;
    min-width: 0;
    height: 1.55rem;
    padding: 0 0.4rem;
    border: 1px solid var(--border);
    border-radius: 0.4375rem;
    background: var(--surface-2);
    color: var(--text);
    font-size: 0.625rem;
    outline: none;
  }

  .pack-select:focus-visible {
    border-color: var(--focus);
  }

  .pack-select:disabled {
    opacity: 0.6;
  }

  .pack-icon {
    flex: none;
    width: 1.6rem;
    height: 1.6rem;
    border-radius: 0.35rem;
    background: var(--surface-2);
    object-fit: cover;
    box-shadow: 0 0 0 1px var(--border);
  }

  .pack-note {
    margin: 0;
    color: var(--faint);
    font-size: 0.5625rem;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }

  .pack-note.error {
    color: var(--critical);
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
