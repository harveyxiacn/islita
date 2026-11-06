<!--
  Window "pet" (route "/pet"). [FRONTEND]

  The detached desktop companion: a transparent, always-on-top window that the
  Rust platform layer sizes, places and lets wander (see window/pet.rs). This
  page draws the character and owns the personality:

  * `pet-motion` events (moving / dir / falling) switch the sprite between
    idle, walk, sleep and drag; facing is mirrored from the walk direction.
  * Dragging is done in JS with `pet_move_by`, so a click still registers as a
    pat. The platform stops the wander loop for the duration.
  * The same state machine and localStorage entry as the island's pet panel
    (`$lib/pet/pet`), so needs, level and skin follow the user's pet.
  * Speech uses the shared situation lines; ring crossings, provider failures
    and finished tasks arrive as `pet-event` from the sidebar window.

  The window is not focusable (by design: petting a companion must not steal
  focus from the user's work), so the context menu closes on pointer-leave,
  Escape or an outside click rather than on window blur.
-->
<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import {
    assetUrl,
    emitWindowEvent,
    listPetPacks,
    listen,
    onTaskCompleted,
    openDashboard,
    petMoveBy,
    petReady,
    petSetDragging,
    petSetRoaming,
    petWhere,
    type Unlisten,
  } from '$lib/api';
  import { t, tDyn } from '$lib/i18n/i18n.svelte';
  import {
    PET_PLUGIN_ID,
    advancePet,
    applyAction,
    createDefaultPet,
    hasRiceFeast,
    parsePetState,
    petStatus,
    type PetAction,
    type PetState,
    type PetStatus,
  } from '$lib/pet/pet';
  import DesktopFeast from '$lib/pet/DesktopFeast.svelte';
  import Mochi from '$lib/pet/Mochi.svelte';
  import PackSprite from '$lib/pet/PackSprite.svelte';
  import RiceFeastFilm from '$lib/pet/RiceFeastFilm.svelte';
  import {
    packFramePath,
    packIdlePose,
    parsePetPack,
    type PackMode,
    type PetPack,
  } from '$lib/pet/pack';
  import { resolvePetTheme } from '$lib/pet/themes';
  import {
    PET_POSITION_KEY,
    artForMode,
    desktopArt,
    facing,
    isPetAction,
    parsePetDesktopPosition,
    shouldSleep,
    type PetDesktopMode,
    type PetDesktopPosition,
    type PetMotion,
  } from '$lib/pet/desktop';
  import {
    petSituation,
    petVoice,
    sayKey,
    type PetSituation,
  } from '$lib/pet/speech';
  import { readPluginState, writePluginState } from '$lib/plugins/storage';
  import { settings } from '$lib/stores/settings.svelte';
  import { snapshot } from '$lib/stores/snapshot.svelte';
  import { applyTheme, markWindow } from '$lib/stores/theme.svelte';

  markWindow('pet');

  /** Actions reachable from the context menu, with the panel's little glyphs. */
  const ACTIONS: readonly { id: PetAction; label: 'plugin.pet.feed' | 'plugin.pet.play' | 'plugin.pet.rest' | 'plugin.pet.pat'; icon: string }[] = [
    { id: 'feed', label: 'plugin.pet.feed', icon: 'M2.5 7.5h11M3.5 7.5c0 3 1.8 5.5 4.5 5.5s4.5-2.5 4.5-5.5M5.2 7.5c.4-1.9 1.5-2.9 2.8-2.9s2.4 1 2.8 2.9' },
    { id: 'play', label: 'plugin.pet.play', icon: 'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM5.4 4.7c1.5 2 1.5 4.6 0 6.6M10.6 4.7c-1.5 2-1.5 4.6 0 6.6' },
    { id: 'rest', label: 'plugin.pet.rest', icon: 'M10.7 2.5a5.7 5.7 0 1 0 2.8 10.7 6.4 6.4 0 0 1-2.8-10.7Z' },
    { id: 'pat', label: 'plugin.pet.pat', icon: 'M8 13S2.5 9.7 2.5 6.3A2.8 2.8 0 0 1 8 4.8a2.8 2.8 0 0 1 5.5 1.5C13.5 9.7 8 13 8 13Z' },
  ];

  /** One loop of the H3 rice clip (5.17 s), rounded to the sprite loop. */
  const FEAST_MS = 5200;

  const NOTABLE = new Set<PetSituation>(['warn', 'critical', 'providerDown', 'paused']);
  const SPOKEN = new Set<PetSituation>([
    'warn', 'critical', 'reset', 'forecast', 'providerDown', 'paused', 'taskDone',
    'feed', 'play', 'rest', 'pat', 'offline',
  ]);

  const s = $derived(settings.value);
  let pet = $state<PetState>(createDefaultPet());
  let motion = $state<PetMotion>({ moving: false, dir: 0, falling: false, x: 0, y: 0 });
  let facingDir = $state<1 | -1>(1);
  let hovering = $state(false);
  let menuOpen = $state(false);
  let menuAt = $state({ x: 24, y: 24 });
  let menuEl = $state<HTMLDivElement>();
  let dragging = $state(false);
  let pressing = $state(false);
  let sleeping = $state(false);
  let pose = $state<'happy' | 'sleep' | null>(null);
  let feasting = $state(false);
  let bubbleKey = $state<string | null>(null);
  let packs = $state<PetPack[]>([]);
  let packsLoaded = $state(false);

  let lastActiveAt = Date.now();
  let lastActionAt = 0;
  let pressed = false;
  let pointerId = -1;
  let downX = 0;
  let downY = 0;
  let lastX = 0;
  let lastY = 0;
  let raf = 0;
  const pendingMove = { dx: 0, dy: 0 };

  let poseTimer: ReturnType<typeof setTimeout> | null = null;
  let feastTimer: ReturnType<typeof setTimeout> | null = null;
  let bubbleTimer: ReturnType<typeof setTimeout> | null = null;
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let sleepTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let greetTimer: ReturnType<typeof setTimeout> | null = null;
  let savedAt = 0;
  let disposed = false;

  const voice = $derived(petVoice(pet.skin, pet.deepseekForm));
  const situation = $derived(petSituation(snapshot.value, s, pet));
  const theme = $derived(resolvePetTheme(pet.skin, pet.theme));
  const selectedPack = $derived(packs.find((entry) => entry.id === pet.packId) ?? null);
  /** A restored pack id before the folder scan finishes: show neither art yet. */
  const packPending = $derived(!!pet.packId && !packsLoaded);
  const art = $derived(
    pet.sprite || selectedPack || packPending
      ? null
      : desktopArt(pet.skin, pet.deepseekForm)
  );
  const mode = $derived.by((): PetDesktopMode => {
    if (dragging) return 'drag';
    if (sleeping || pose === 'sleep') return 'sleep';
    if (pose === 'happy') return 'happy';
    if (motion.moving || motion.falling) return 'walk';
    return 'idle';
  });
  const packMode = $derived.by((): PackMode => {
    if (mode === 'drag') return 'drag';
    if (mode === 'sleep') return 'sleep';
    if (mode === 'walk') return 'walk';
    if (mode === 'happy') return 'pat';
    return 'idle';
  });
  const artUrl = $derived(artForMode(art, mode));
  const mochiStatus = $derived<PetStatus>(
    mode === 'sleep' ? 'tired' : mode === 'happy' ? 'happy' : petStatus(pet)
  );
  const bubbleText = $derived(bubbleKey ? tDyn(bubbleKey, { name: pet.name }) : null);
  const feastLabel = $derived(t('plugin.pet.rice.eating', { name: pet.name }));
  /** The bundled DeepSeek chibi can be replaced by the rice cutscene. */
  const feastable = $derived(hasRiceFeast(pet));

  function copyState(state: PetState): PetState {
    return { ...state, sprite: state.sprite ? { ...state.sprite } : null };
  }

  function persistNow(): void {
    writePluginState(PET_PLUGIN_ID, copyState(pet));
    savedAt = Date.now();
  }

  /** Adopt a state saved by another window; only strictly newer ones win. */
  function adopt(raw: unknown): boolean {
    const parsed = parsePetState(raw, Date.now());
    if (parsed.lastSeen <= pet.lastSeen) return false;
    const mealsBefore = pet.meals;
    pet = advancePet(parsed, Date.now()).state;
    savedAt = Date.now();
    // A feed from the island panel shows the same bowl on the desktop.
    if (pet.meals > mealsBefore) startFeast();
    return true;
  }

  async function loadPacks(): Promise<void> {
    try {
      packs = (await listPetPacks())
        .map(parsePetPack)
        .filter((entry): entry is PetPack => entry !== null)
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      // Browser preview has no pack backend; built-in art is the fallback.
    } finally {
      packsLoaded = true;
    }
  }

  /** The panel may import a pack while this window is open. */
  function ensurePack(id: string | null | undefined): void {
    if (!id || packs.some((entry) => entry.id === id)) return;
    void loadPacks();
  }

  function hideBubble(): void {
    if (bubbleTimer) {
      clearTimeout(bubbleTimer);
      bubbleTimer = null;
    }
    bubbleKey = null;
  }

  function speakSituation(next: PetSituation, holdMs = 7000): void {
    bubbleKey = sayKey(voice, next);
    if (bubbleTimer) clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      bubbleTimer = null;
      bubbleKey = null;
    }, holdMs);
  }

  /** Show the bowl briefly; a second feed restarts the full hold. */
  function startFeast(): void {
    feasting = true;
    if (feastTimer) clearTimeout(feastTimer);
    feastTimer = setTimeout(() => {
      feastTimer = null;
      feasting = false;
    }, FEAST_MS);
  }

  function stopFeast(): void {
    if (feastTimer) {
      clearTimeout(feastTimer);
      feastTimer = null;
    }
    feasting = false;
  }

  function setPose(next: 'happy' | 'sleep' | null, holdMs = 0): void {
    if (poseTimer) {
      clearTimeout(poseTimer);
      poseTimer = null;
    }
    pose = next;
    if (next && holdMs > 0) {
      poseTimer = setTimeout(() => {
        poseTimer = null;
        pose = null;
        checkSleep();
      }, holdMs);
    }
  }

  function checkSleep(): void {
    const busy = hovering || menuOpen || dragging || pressing;
    sleeping = shouldSleep(pet.energy, Date.now() - lastActiveAt, busy);
    if (sleeping) hideBubble();
  }

  function interact(action: PetAction): void {
    const now = Date.now();
    const cooldown = action === 'pat' ? 380 : 650;
    if (now - lastActionAt < cooldown) return;
    lastActionAt = now;
    lastActiveAt = now;
    const advanced = advancePet(pet, now).state;
    pet = applyAction(advanced, action, now).state;
    if (action === 'feed') startFeast();
    setPose(action === 'rest' ? 'sleep' : 'happy', action === 'rest' ? 1900 : 1200);
    speakSituation(action, 5200);
    checkSleep();
    persistNow();
    void emitWindowEvent('sidebar', 'pet-state', { state: copyState(pet), action });
  }

  function storedPosition(): PetDesktopPosition | null {
    try {
      return parsePetDesktopPosition(JSON.parse(localStorage.getItem(PET_POSITION_KEY) ?? 'null'));
    } catch {
      return null;
    }
  }

  async function rememberPosition(): Promise<void> {
    try {
      const pos = await petWhere();
      if (pos) localStorage.setItem(PET_POSITION_KEY, JSON.stringify({ x: pos[0], y: pos[1] }));
    } catch {
      // no platform layer (browser preview) or window gone
    }
  }

  function queueMove(dx: number, dy: number): void {
    pendingMove.dx += dx;
    pendingMove.dy += dy;
    if (raf !== 0) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const { dx: mx, dy: my } = pendingMove;
      pendingMove.dx = 0;
      pendingMove.dy = 0;
      if (mx !== 0 || my !== 0) void petMoveBy(mx, my);
    });
  }

  function flushMove(): void {
    if (raf !== 0) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    const { dx, dy } = pendingMove;
    pendingMove.dx = 0;
    pendingMove.dy = 0;
    if (dx !== 0 || dy !== 0) void petMoveBy(dx, dy);
  }

  function beginDrag(): void {
    if (dragging) return;
    dragging = true;
    pressing = false;
    menuOpen = false;
    hideBubble();
    // The bowl is anchored to the floor; carried away it would look detached.
    stopFeast();
    setPose(null);
    void petSetDragging(true);
  }

  function finishPointer(event: PointerEvent, allowPat: boolean): void {
    if (!pressed) return;
    pressed = false;
    pressing = false;
    const wasDragging = dragging;
    try {
      (event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(pointerId);
    } catch {
      // capture already released
    }
    if (wasDragging) {
      flushMove();
      dragging = false;
      void petSetDragging(false);
      void rememberPosition();
      lastActiveAt = Date.now();
      checkSleep();
    } else if (allowPat) {
      interact('pat');
    }
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    pressed = true;
    pressing = true;
    pointerId = event.pointerId;
    downX = lastX = event.screenX;
    downY = lastY = event.screenY;
    menuOpen = false;
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // capture unsupported: pointerup on the element still fires inside
    }
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent): void {
    if (!pressed || event.pointerId !== pointerId) return;
    if (!dragging) {
      if (Math.hypot(event.screenX - downX, event.screenY - downY) < 4) return;
      beginDrag();
    }
    const dx = event.screenX - lastX;
    const dy = event.screenY - lastY;
    if (dx !== 0 || dy !== 0) {
      lastX = event.screenX;
      lastY = event.screenY;
      queueMove(dx, dy);
    }
    event.preventDefault();
  }

  function onPointerUp(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    finishPointer(event, true);
  }

  function onPointerCancel(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    // A cancelled gesture must not count as a pat.
    if (!pressed) return;
    pressed = false;
    pressing = false;
    if (dragging) {
      flushMove();
      dragging = false;
      void petSetDragging(false);
      void rememberPosition();
    }
  }

  function onGlobalPointerUp(event: PointerEvent): void {
    if (event.pointerId !== pointerId || !pressed) return;
    finishPointer(event, false);
  }

  function onEnter(): void {
    hovering = true;
    lastActiveAt = Date.now();
    checkSleep();
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      if (hovering && !menuOpen && bubbleKey === null) speakSituation(situation, 5200);
    }, 650);
  }

  function onLeave(): void {
    hovering = false;
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    if (menuOpen) closeMenu();
    checkSleep();
  }

  async function openMenu(event: MouseEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    lastActiveAt = Date.now();
    setPose(null);
    hideBubble();
    menuOpen = true;
    await tick();
    const rect = menuEl?.getBoundingClientRect();
    const w = rect?.width ?? 176;
    const h = rect?.height ?? 210;
    const pad = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Open towards the centre of the window: above the pointer when it is low.
    const x = Math.min(Math.max(pad, event.clientX - w / 2), Math.max(pad, vw - w - pad));
    const y = event.clientY > h + 12
      ? Math.min(Math.max(pad, event.clientY - h - 8), Math.max(pad, vh - h - pad))
      : Math.min(Math.max(pad, event.clientY + 8), Math.max(pad, vh - h - pad));
    menuAt = { x, y };
  }

  function closeMenu(): void {
    menuOpen = false;
  }

  function choose(action: PetAction): void {
    closeMenu();
    interact(action);
  }

  function toggleRoam(): void {
    closeMenu();
    void settings.patch({ petRoam: !s.petRoam });
  }

  function openSettings(): void {
    closeMenu();
    void openDashboard('settings');
  }

  function hideFromDesktop(): void {
    closeMenu();
    void settings.patch({ petOnDesktop: false });
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      if (menuOpen) closeMenu();
      else hideBubble();
    }
  }

  function onStorage(event: StorageEvent): void {
    if (event.key !== `island.plugin.${PET_PLUGIN_ID}` || event.newValue === null) return;
    try {
      const parsed = JSON.parse(event.newValue) as { packId?: unknown } | null;
      if (adopt(parsed)) {
        ensurePack(typeof parsed?.packId === 'string' ? parsed.packId : null);
      }
    } catch {
      // corrupt write: keep the in-memory pet
    }
  }

  async function boot(): Promise<void> {
    await loadPacks();
    const pack = packs.find((entry) => entry.id === pet.packId) ?? null;
    const idle = pack
      ? assetUrl(packFramePath(pack, packIdlePose(pack).act.frames[0]))
      : artForMode(art, 'idle');
    if (idle) await decodeImage(idle);
    await tick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (disposed) return;
    const pos = storedPosition();
    // Ask the sidebar for its copy when the two windows do not share storage;
    // a strictly newer answer is adopted, an echo of our own state is not.
    void emitWindowEvent('sidebar', 'pet-state-request', null);
    try {
      await petReady(pos?.x ?? null, pos?.y ?? null);
    } catch {
      // browser preview has no window layer
    }
    greetTimer = setTimeout(() => {
      greetTimer = null;
      if (!disposed && !sleeping && !hovering && bubbleKey === null) speakSituation(situation, 6000);
    }, 1700);
  }

  function decodeImage(url: string): Promise<void> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve();
      img.onerror = () => resolve();
      img.src = url;
    });
  }

  let lastNotable: PetSituation | null = null;
  $effect(() => {
    const snap = snapshot.value;
    if (snap === null) return;
    const next = petSituation(snap, s, pet);
    untrack(() => {
      if (!NOTABLE.has(next)) {
        lastNotable = null;
        return;
      }
      if (next === lastNotable) return;
      lastNotable = next;
      speakSituation(next, 9000);
    });
  });

  $effect(() => {
    const allowed = !sleeping && !hovering && !menuOpen && !dragging && !pressing;
    void petSetRoaming(allowed);
  });

  $effect(() => applyTheme(settings.value));

  onMount(() => {
    const saved = readPluginState<unknown>(PET_PLUGIN_ID, null);
    const now = Date.now();
    pet = advancePet(parsePetState(saved, now), now).state;

    const disposers: Array<() => void> = [settings.init(), snapshot.init()];
    let unMotion: Unlisten | null = null;
    let unEvent: Unlisten | null = null;
    let unState: Unlisten | null = null;
    let unTask: Unlisten | null = null;

    void listen<PetMotion>('pet-motion', (next) => {
      motion = next;
      if (next.dir !== 0) facingDir = facing(next.dir);
    }).then((un) => (disposed ? un() : (unMotion = un)));

    void listen<PetSituation>('pet-event', (next) => {
      if (!SPOKEN.has(next)) return;
      lastNotable = NOTABLE.has(next) ? next : lastNotable;
      speakSituation(next, 9000);
    }).then((un) => (disposed ? un() : (unEvent = un)));

    void listen<{ state?: PetState; action?: string }>('pet-state', (payload) => {
      if (!payload || typeof payload !== 'object') return;
      adopt(payload.state);
      ensurePack(payload.state?.packId);
      if (payload.action && isPetAction(payload.action)) {
        // An interaction in the island panel plays out here too, so the two
        // windows show one pet rather than two independent copies.
        lastNotable = null;
        lastActiveAt = Date.now();
        setPose(payload.action === 'rest' ? 'sleep' : 'happy', payload.action === 'rest' ? 1900 : 1200);
        speakSituation(payload.action, 5200);
        checkSleep();
      }
    }).then((un) => (disposed ? un() : (unState = un)));

    // The task notification is backend-wide, so this window hears it directly.
    void onTaskCompleted(() => {
      lastActiveAt = Date.now();
      speakSituation('taskDone', 8000);
    }).then((un) => (disposed ? un() : (unTask = un)));

    window.addEventListener('storage', onStorage);
    window.addEventListener('pointerup', onGlobalPointerUp);
    window.addEventListener('keydown', onKeyDown);

    tickTimer = setInterval(() => {
      const now = Date.now();
      pet = advancePet(pet, now).state;
      checkSleep();
      if (now - savedAt > 60_000) persistNow();
    }, 30_000);
    sleepTimer = setInterval(checkSleep, 15_000);

    void boot();

    return () => {
      disposed = true;
      unMotion?.();
      unEvent?.();
      unState?.();
      unTask?.();
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pointerup', onGlobalPointerUp);
      window.removeEventListener('keydown', onKeyDown);
      if (poseTimer) clearTimeout(poseTimer);
      if (feastTimer) clearTimeout(feastTimer);
      if (bubbleTimer) clearTimeout(bubbleTimer);
      if (hoverTimer) clearTimeout(hoverTimer);
      if (greetTimer) clearTimeout(greetTimer);
      if (sleepTimer) clearInterval(sleepTimer);
      if (tickTimer) clearInterval(tickTimer);
      if (raf !== 0) cancelAnimationFrame(raf);
      disposers.forEach((dispose) => dispose());
    };
  });
</script>

<div
  class="stage"
  data-pet-theme={theme}
  role="presentation"
  onpointerenter={onEnter}
  onpointerleave={onLeave}
  oncontextmenu={openMenu}
>
  <div class="bubble" class:visible={bubbleText !== null} aria-live="polite" aria-atomic="true">
    {bubbleText ?? ''}
  </div>

  {#if menuOpen}
    <div class="menu-backdrop" role="presentation" onpointerdown={closeMenu}></div>
    <div
      class="menu"
      role="menu"
      aria-label={t('plugin.pet.desktop.menu')}
      style:left={`${menuAt.x}px`}
      style:top={`${menuAt.y}px`}
      bind:this={menuEl}
    >
      {#each ACTIONS as action (action.id)}
        <button class="menu-item" type="button" role="menuitem" onclick={() => choose(action.id)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d={action.icon} /></svg>
          <span>{t(action.label)}</span>
        </button>
      {/each}
      <div class="menu-sep" role="separator"></div>
      <button
        class="menu-item"
        type="button"
        role="menuitemcheckbox"
        aria-checked={s.petRoam}
        onclick={toggleRoam}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 12.5c2.2 0 2.9-2.2 4.2-2.2s1.8 1.4 3 1.4 2.3-1.4 3.8-1.4" />
          <circle cx="4" cy="6" r="1.4" />
          <circle cx="9.5" cy="4.5" r="1.4" />
        </svg>
        <span>{t('plugin.pet.desktop.wander')}</span>
        {#if s.petRoam}<span class="menu-check" aria-hidden="true">✓</span>{/if}
      </button>
      <button class="menu-item" type="button" role="menuitem" onclick={openSettings}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Z" />
          <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
        </svg>
        <span>{t('plugin.pet.desktop.settings')}</span>
      </button>
      <button class="menu-item" type="button" role="menuitem" onclick={hideFromDesktop}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2 8s2.1-3.6 6-3.6S14 8 14 8s-2.1 3.6-6 3.6S2 8 2 8Z" />
          <circle cx="8" cy="8" r="1.6" />
          <path d="m2.4 2.4 11.2 11.2" />
        </svg>
        <span>{t('plugin.pet.desktop.hide')}</span>
      </button>
    </div>
  {/if}

  <div class="pet-shadow" aria-hidden="true"></div>
  <!-- Bundled DeepSeek art brings its own bowl; every other skin gets one. -->
  {#if !(feasting && feastable)}
    <DesktopFeast active={feasting} label={feastLabel} />
  {/if}

  <button
    class="pet-button"
    class:dragging
    type="button"
    aria-label={`${t('plugin.pet.pat')}: ${pet.name}`}
    title={t('plugin.pet.desktop.hint')}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerCancel}
  >
    <span
      class="pet-wrap"
      style:transform={selectedPack ? 'none' : `scaleX(${facingDir})`}
    >
      <span
        class="pet-figure mode-{mode}"
        class:falling={motion.falling}
        class:chewing={feasting}
        class:filming={feasting && feastable}
      >
        {#if feasting && feastable}
          <span class="rice-figure">
            <RiceFeastFilm active label={feastLabel} />
          </span>
        {:else if pet.sprite}
          {#if pet.sprite.frames === 4}
            <span
              class="sprite-strip"
              style={`background-image: url("${pet.sprite.dataUrl}")`}
              aria-hidden="true"
            ></span>
          {:else}
            <img class="sprite" src={pet.sprite.dataUrl} alt="" draggable="false" />
          {/if}
        {:else if packPending}
          <span class="pack-placeholder" aria-hidden="true"></span>
        {:else if selectedPack}
          <span class="pack-art">
            <PackSprite
              pack={selectedPack}
              mode={packMode}
              fullness={pet.fullness}
              level={pet.level}
              direction={facingDir}
            />
          </span>
        {:else if artUrl}
          <img
            class="sprite"
            src={artUrl}
            alt=""
            draggable="false"
            data-skin={pet.skin}
            data-form={pet.skin === 'deepseek' ? pet.deepseekForm : undefined}
          />
        {:else}
          <span class="mochi"><Mochi status={mochiStatus} /></span>
        {/if}
      </span>
    </span>
  </button>
</div>

<style>
  .stage {
    position: fixed;
    inset: 0;
    overflow: hidden;
  }

  .bubble {
    position: absolute;
    top: 3%;
    left: 50%;
    z-index: 3;
    max-width: 92%;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--pet-bubble-border, rgb(255 255 255 / 0.16));
    border-radius: 0.75rem;
    background: var(--pet-bubble-bg, rgb(17 19 26 / 0.84));
    color: var(--pet-bubble-text, #f5f6fa);
    font-size: 0.6875rem;
    line-height: 1.4;
    text-align: center;
    overflow-wrap: anywhere;
    pointer-events: none;
    opacity: 0;
    transform: translate(-50%, 5px);
    transition:
      opacity 180ms var(--ease-out, ease-out),
      transform 180ms var(--ease-out, ease-out);
    backdrop-filter: blur(12px);
    box-shadow: 0 6px 18px rgb(0 0 0 / 0.28);
  }

  .bubble.visible {
    opacity: 1;
    transform: translate(-50%, 0);
  }

  .bubble::after {
    position: absolute;
    bottom: -4px;
    left: 50%;
    width: 8px;
    height: 8px;
    border-right: 1px solid var(--pet-bubble-border, rgb(255 255 255 / 0.16));
    border-bottom: 1px solid var(--pet-bubble-border, rgb(255 255 255 / 0.16));
    background: var(--pet-bubble-bg, rgb(17 19 26 / 0.84));
    transform: translateX(-50%) rotate(45deg);
    content: '';
  }

  :global(html[data-theme='light']) .bubble {
    border-color: var(--pet-bubble-border, rgb(0 0 0 / 0.12));
    background: var(--pet-bubble-bg, rgb(255 255 255 / 0.92));
    color: var(--pet-bubble-text, #1d2027);
  }

  :global(html[data-theme='light']) .bubble::after {
    border-color: var(--pet-bubble-border, rgb(0 0 0 / 0.12));
    background: var(--pet-bubble-bg, rgb(255 255 255 / 0.92));
  }

  .pet-shadow {
    position: absolute;
    bottom: 2.5%;
    left: 50%;
    z-index: 1;
    width: 8.5rem;
    max-width: 70vw;
    height: 0.75rem;
    border-radius: 50%;
    background: radial-gradient(ellipse at center, var(--pet-shadow, rgb(0 0 0 / 0.3)), transparent 70%);
    transform: translateX(-50%);
    pointer-events: none;
  }

  .pet-button {
    position: absolute;
    bottom: 2%;
    left: 50%;
    z-index: 2;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    width: 13rem;
    max-width: 94vw;
    height: 14rem;
    max-height: 76vh;
    padding: 0;
    border: 0;
    background: none;
    transform: translateX(-50%);
    cursor: grab;
    touch-action: none;
  }

  .pet-button.dragging {
    cursor: grabbing;
  }

  .pet-wrap {
    display: block;
    width: 100%;
    height: 100%;
    transform-origin: 50% 100%;
  }

  .pet-figure {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    width: 100%;
    height: 100%;
    transform-origin: 50% 100%;
    filter: drop-shadow(0 4px 10px rgb(0 0 0 / 0.22));
  }

  .pet-figure.mode-idle {
    animation: pet-idle 3.8s ease-in-out infinite;
  }

  .pet-figure.mode-walk {
    animation: pet-walk 0.46s ease-in-out infinite;
  }

  .pet-figure.mode-walk.falling {
    animation: pet-walk 0.3s ease-in-out infinite;
  }

  .pet-figure.mode-sleep {
    animation: pet-sleep 5s ease-in-out infinite;
  }

  .pet-figure.mode-happy {
    animation: pet-hop 0.55s var(--ease-out, ease-out) 2;
  }

  .pet-figure.mode-drag {
    animation: pet-dangle 1.9s ease-in-out infinite;
  }

  /* Overrides the idle/walk bob for the six seconds of the rice bowl. */
  .pet-figure.chewing {
    animation: pet-chew 0.62s ease-in-out infinite;
  }

  /* The generated film already carries its own bounce and chew. */
  .pet-figure.chewing.filming {
    animation: none;
  }

  /* The rice cutout replaces the full-body art for the cutscene; the square
     keeps the steam/grain percentages aligned with the artwork. */
  .rice-figure {
    display: block;
    width: 12.4rem;
    max-width: 96%;
    aspect-ratio: 1;
    margin-bottom: 0.1rem;
    pointer-events: none;
  }

  .sprite {
    display: block;
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
    object-fit: contain;
    pointer-events: none;
    user-select: none;
    -webkit-user-drag: none;
  }

  .sprite-strip {
    display: block;
    width: 100%;
    height: 100%;
    background-repeat: no-repeat;
    background-size: 400% 100%;
    background-position: 0% 50%;
    animation: pet-sprite-frames 1.15s step-end infinite;
    pointer-events: none;
  }

  .mochi {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    width: 88%;
    height: 88%;
    pointer-events: none;
  }

  .pack-art {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .pack-placeholder {
    width: 7rem;
    height: 7rem;
    margin-bottom: 0.6rem;
    border-radius: 50%;
    background: var(--surface-2, rgb(255 255 255 / 0.12));
    opacity: 0.35;
    pointer-events: none;
  }

  @keyframes pet-idle {
    0%,
    100% {
      transform: translateY(0);
    }
    50% {
      transform: translateY(-2px);
    }
  }

  @keyframes pet-walk {
    0%,
    100% {
      transform: translateY(0) rotate(-1.1deg);
    }
    50% {
      transform: translateY(-3px) rotate(1.1deg);
    }
  }

  @keyframes pet-sleep {
    0%,
    100% {
      transform: translateY(3px) scale(0.97);
    }
    50% {
      transform: translateY(4px) scale(0.96);
    }
  }

  @keyframes pet-hop {
    0% {
      transform: translateY(0) scale(1);
    }
    30% {
      transform: translateY(-12px) scale(1.025);
    }
    62% {
      transform: translateY(1px) scale(0.985);
    }
    100% {
      transform: translateY(0) scale(1);
    }
  }

  @keyframes pet-dangle {
    0%,
    100% {
      transform: rotate(-5deg);
    }
    50% {
      transform: rotate(-2deg);
    }
  }

  @keyframes pet-chew {
    0%,
    100% {
      transform: translateY(0) scale(1);
    }
    25% {
      transform: translateY(1px) scale(1.012, 0.988);
    }
    50% {
      transform: translateY(0) scale(0.994, 1.006);
    }
    75% {
      transform: translateY(1px) scale(1.008, 0.992);
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

  .menu-backdrop {
    position: absolute;
    inset: 0;
    z-index: 4;
  }

  .menu {
    position: absolute;
    z-index: 5;
    display: flex;
    flex-direction: column;
    width: 11rem;
    max-width: calc(100vw - 12px);
    padding: 0.2rem;
    border: 1px solid rgb(255 255 255 / 0.16);
    border-radius: 0.6rem;
    background: rgb(17 19 26 / 0.92);
    color: #f3f4f8;
    box-shadow: 0 12px 30px rgb(0 0 0 / 0.38);
    backdrop-filter: blur(16px);
    animation: menu-in 140ms var(--ease-out, ease-out);
  }

  :global(html[data-theme='light']) .menu {
    border-color: rgb(0 0 0 / 0.12);
    background: rgb(255 255 255 / 0.95);
    color: #1d2027;
  }

  .menu-item {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    padding: 0.3rem 0.4rem;
    border-radius: 0.4rem;
    color: inherit;
    font-size: 0.6875rem;
    line-height: 1.3;
    text-align: left;
  }

  .menu-item:hover {
    background: rgb(255 255 255 / 0.09);
  }

  :global(html[data-theme='light']) .menu-item:hover {
    background: rgb(0 0 0 / 0.06);
  }

  .menu-item svg {
    flex: none;
    width: 0.875rem;
    height: 0.875rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.82;
  }

  .menu-check {
    margin-left: auto;
    color: var(--focus);
    font-size: 0.75rem;
  }

  .menu-sep {
    height: 1px;
    margin: 0.15rem 0.25rem;
    background: rgb(255 255 255 / 0.14);
  }

  :global(html[data-theme='light']) .menu-sep {
    background: rgb(0 0 0 / 0.1);
  }

  @keyframes menu-in {
    from {
      opacity: 0;
      transform: scale(0.97);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .pet-figure.mode-idle,
    .pet-figure.mode-walk,
    .pet-figure.mode-sleep,
    .pet-figure.mode-happy,
    .pet-figure.mode-drag,
    .pet-figure.chewing,
    .sprite-strip,
    .menu {
      animation: none;
    }

    .bubble {
      transition: none;
    }
  }
</style>
