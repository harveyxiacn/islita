<!--
  Window "sidebar" (route "/"). [FRONTEND]

  A transparent, frameless window that contains exactly one painted element:
  the near-black pill hugging the screen edge (or, when auto-hide collapsed the
  bar, a thin coloured handle).

  Window protocol
  ---------------
  * `observeSize` measures the painted element and reports its CSS px size to
    `sidebar_relayout` (debounced 50 ms) — the Rust side resizes the window to
    exactly that and re-anchors it to the configured edge. Edge bars are
    `width: max-content` / auto height so the measured size never depends on
    the window size (no resize feedback loop). The island is the one exception:
    its stage has an explicit size covering the whole idle↔open morph, and the
    capsule animates inside that fixed box.
  * Hovering the bar reports `hover_report('bar', true|false)`; Rust owns the
    expand/collapse + popover-hide timers.
  * Dragging the pill (past a 5px threshold) streams `sidebar_drag`; Rust moves
    the window and snaps it to the nearest edge of the drop monitor on release.
  * Hovering a ring asks for the popover with the ring's centre in CSS px
    relative to *this* window — which is the viewport, so
    `rect.top + rect.height / 2` (and `rect.left + rect.width / 2`) is already
    the right number. Both are sent; Rust picks the one along the bar's axis.

  Orientation
  -----------
  `settings.edge` decides it: `left`/`right` stack the rings in a column (the
  original pill), `top`/`bottom` lay them out in a row. Only the stage's
  `data-edge` attribute drives the CSS — the flush side loses its border and
  its two corners there, and the "⋯" button moves next to the rings.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import MiniBar from '$lib/components/MiniBar.svelte';
  import Ring from '$lib/components/Ring.svelte';
  import ProviderLogo from '$lib/components/ProviderLogo.svelte';
  import { dragHandle, HEARTBEAT_MS, measureSize, observeSize, throttle, type DragPhase, type SizeReport } from '$lib/actions';
  import {
    emitWindowEvent,
    hoverReport,
    listen,
    onSidebarState,
    openDashboard,
    onTaskCompleted,
    popoverHide,
    popoverSetPinned,
    popoverShow,
    sidebarDrag,
    sidebarRelayout,
    type Unlisten,
  } from '$lib/api';
  import { formatForecast, formatPercent, formatReset, severityOf, shortPercent, windowLabel } from '$lib/format';
  import { compactReset, nextTickDelay } from '$lib/countdown';
  import { forecastTickPercent } from '$lib/forecast';
  import { quotaKey } from '$lib/providers';
  import { detectRingEvents, levelsOf, windowKey, type RingEvent, type RingEventKind, type WindowLevel } from '$lib/ring-events';
  import { handlePeak, handleSegments, labelLayout, type LabelLayout } from '$lib/sidebar-visuals';
  import { t, tDyn } from '$lib/i18n/i18n.svelte';
  import {
    PET_PLUGIN_ID,
    advancePet,
    parsePetState,
    petStatus,
    type PetAction,
    type PetState,
    type PetStatus,
  } from '$lib/pet/pet';
  import { isPetAction } from '$lib/pet/desktop';
  import { petVoice, quotaSituation, sayKey, speechAvatar, type PetVoice } from '$lib/pet/speech';
  import { petSpeech } from '$lib/pet/speech.svelte';
  import { attention } from '$lib/plugins/attention.svelte';
  import { enabledPlugins } from '$lib/plugins/enabled';
  import { pluginById, ISLAND_PLUGINS } from '$lib/plugins/registry';
  import type { IslandPlugin } from '$lib/plugins/types';
  import { pluginStorageKey, readPluginState, writePluginState } from '$lib/plugins/storage';
  import { handleColorOf, rings, type RingItem } from '$lib/stores/rings.svelte';
  import { settings } from '$lib/stores/settings.svelte';
  import { snapshot } from '$lib/stores/snapshot.svelte';
  import { applyTheme, markWindow } from '$lib/stores/theme.svelte';

  // stamped before the first applyTheme() effect so the theme store knows
  // which window it is (the custom text colour is widget-only)
  markWindow('sidebar');

  const s = $derived(settings.value);
  const items = $derived(rings.items);
  const loading = $derived(snapshot.value === null || !settings.loaded);
  /**
   * Placeholder rings while the first snapshot is on its way: as many as the
   * settings say will be drawn, so the bar does not jump in size when the real
   * rings replace them.
   */
  const placeholders = $derived(
    Array.from(
      { length: Math.max(1, Object.values(s.providers).filter((p) => p.enabled && p.showInSidebar).length) },
      (_, i) => i
    )
  );

  /**
   * The pet saves itself outside Svelte (localStorage), so nothing re-renders
   * on its own. Either window's write bumps this counter and the rail's badge
   * and tooltip re-read the pet.
   */
  let petRevision = $state(0);
  /** Current needs for the rail dot; null until the user has used the pet. */
  const petGlance = $derived.by((): { mood: PetStatus; meals: number } | null => {
    // Read (do not use) the counter: it is the only invalidation signal.
    petRevision;
    const pet = savedPet();
    if (!pet) return null;
    const current = advancePet(pet, Date.now()).state;
    return { mood: petStatus(current), meals: current.meals };
  });

  /** platform-owned expand/collapse state; only meaningful when autoHide is on */
  let expanded = $state(true);
  let expandedSize = $state<SizeReport>({ width: 76, height: 160 });
  /** ring key of the pinned popover, null when nothing is pinned */
  let pinnedKey = $state<string | null>(null);

  /**
   * The dynamic island is its own surface: top centre, no collapsed edge
   * handle (it shrinks to a one-ring summary instead, in the frontend), and a
   * CSS-orientation that always reads as a horizontal bar.
   */
  const island = $derived(s.island);
  const collapsed = $derived(!island && s.autoHide && !expanded);
  /** compact mode: slim progress bars instead of rings */
  const compact = $derived(s.ringStyle === 'bar');
  /** top/bottom edges: the bar is a horizontal strip, rings laid out in a row */
  const horizontal = $derived(island || s.edge === 'top' || s.edge === 'bottom');

  /**
   * Island-only state. Idle shows the user's chosen providers/plugins (or a
   * busiest-provider summary) and grows into the full two-row board on
   * hover/focus; a plugin panel keeps it open until it is closed. None of this
   * touches the Rust hover state machine, which still owns auto-hide for edge
   * bars.
   */
  let islandExpanded = $state(false);
  let stageHovered = $state(false);
  let activePluginId = $state<string | null>(null);
  let closingPlugin = $state(false);
  let islandCollapseTimer: ReturnType<typeof setTimeout> | undefined;
  let panelCloseTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Idle and open are laid out at the same time (the hidden one is measured,
   * never displayed), which lets the capsule morph between two known sizes
   * without measuring mid-animation. The window keeps the larger of the two
   * until the collapse has finished.
   */
  let idleW = $state(0);
  let idleH = $state(0);
  let openW = $state(0);
  let openH = $state(0);
  let panelW = $state(0);
  let panelH = $state(0);
  let islandReady = $state(false);
  let islandHold = $state(false);
  let islandHoldTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Auto-hide: the idle capsule collapses into a thin handle on the top edge.
   * Pointing at the handle reveals the capsule, resting on it expands the
   * board, and leaving hides it again after `autoHideDelayMs`.
   */
  let islandHidden = $state(false);
  let islandDwellTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The pointer landed on the idle capsule: the first movement expands it.
   * Ring hover/click is ignored for that beat so a popover is never anchored
   * to the summary ring's pre-expansion position.
   */
  let suppressRingHover = false;
  let suppressRingTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Whether the element that currently has focus inside the island got it from
   * the keyboard. `matches(':focus-visible')` is evaluated at focus time on
   * purpose: after a later Escape a mouse-focused button would match it too,
   * which would keep the island open forever.
   */
  let stageKeyboardFocus = false;
  const activePlugin = $derived(pluginById(activePluginId ?? ''));
  const islandIdle = $derived(island && !islandExpanded);
  /** Which provider rings the collapsed island shows; empty = busiest. */
  const idleProviderItems = $derived.by(() => {
    const wanted = new Set(s.islandIdle.providers);
    if (wanted.size === 0) return [] as RingItem[];
    const seen = new Set<string>();
    const chosen: RingItem[] = [];
    for (const item of items) {
      if (!wanted.has(item.quotaKey) || seen.has(item.quotaKey)) continue;
      seen.add(item.quotaKey);
      chosen.push(item);
    }
    return chosen;
  });
  /** Modules the user has not switched off in Settings → Plugins. */
  const enabledIslandPlugins = $derived(enabledPlugins(ISLAND_PLUGINS, s.disabledPlugins));
  const idlePlugins = $derived(
    enabledIslandPlugins.filter((plugin) => s.islandIdle.plugins.includes(plugin.id))
  );
  const idleShowsSummary = $derived(idleProviderItems.length === 0);

  /** Border of the capsule; it is the only padding the pill itself keeps. */
  const ISLAND_BORDER = 2;
  /** Same value as .island-shell's row gap (px, scale-independent). */
  const PANEL_GAP = 7;
  /** Long enough for the 420 ms width/height spring to settle. */
  const ISLAND_MORPH_MS = 440;
  /** Hold the native window at the open box until the delayed close lands. */
  const ISLAND_HOLD_MS = ISLAND_MORPH_MS + 250;
  /** The hidden island: a small hit box with a thin visible handle. */
  const PEEK_W = 96;
  const PEEK_H = 24;
  /** Resting on the revealed capsule this long expands the board. */
  const ISLAND_DWELL_MS = 280;
  const autoHideIsland = $derived(island && s.islandAutoHide);

  /** The box the capsule morphs to; the stage reserves the larger box. */
  const pillTargetW = $derived((islandIdle ? idleW : openW) + ISLAND_BORDER);
  const pillTargetH = $derived((islandIdle ? idleH : openH) + ISLAND_BORDER);
  const stageExpanded = $derived(island && (islandExpanded || islandHold));
  const stageW = $derived.by(() => {
    if (!island) return 0;
    if (islandHidden) return PEEK_W;
    const pill = (stageExpanded ? Math.max(openW, idleW) : idleW) + ISLAND_BORDER;
    const panel = activePlugin ? panelW + ISLAND_BORDER : 0;
    return Math.max(pill, panel, 72);
  });
  const stageH = $derived.by(() => {
    if (!island) return 0;
    if (islandHidden) return PEEK_H;
    const pill = (stageExpanded ? Math.max(openH, idleH) : idleH) + ISLAND_BORDER;
    const panel = activePlugin ? panelH + ISLAND_BORDER + PANEL_GAP : 0;
    return Math.max(pill + panel, 40);
  });

  // Both layers are in the DOM from the first paint; latch the ready flag once
  // they have real sizes so the initial measurement does not animate from 0.
  $effect(() => {
    if (!islandReady && island && idleW > 0 && idleH > 0 && openW > 0 && openH > 0) {
      islandReady = true;
    }
  });

  // Auto-hide: schedule the collapse once the island is idle, measured and
  // unoccupied. Every dependency restarts the timer, so leaving midway, opening
  // a panel or the collapse animation itself simply postpones it.
  $effect(() => {
    if (
      !autoHideIsland ||
      !islandReady ||
      islandHidden ||
      stageHovered ||
      activePluginId !== null ||
      islandExpanded ||
      islandHold
    ) {
      return;
    }
    const delay = Math.max(300, s.autoHideDelayMs);
    const timer = setTimeout(() => {
      if (stageHovered || activePluginId !== null || islandExpanded || islandHold) return;
      islandHidden = true;
      pinnedKey = null;
      void popoverHide();
    }, delay);
    return () => clearTimeout(timer);
  });

  // Turning the option off (or leaving island mode) brings the capsule back.
  $effect(() => {
    if (!s.islandAutoHide && islandHidden) islandHidden = false;
  });

  /** Busiest provider, used as the idle island's single ring. */
  const islandSummary = $derived.by(() => {
    let best: RingItem | null = null;
    for (const item of items) {
      const used = item.labelWindow?.usedPercent ?? -1;
      const bestUsed = best?.labelWindow?.usedPercent ?? -1;
      if (best === null || used > bestUsed) best = item;
    }
    return best;
  });

  function reportSize(size: SizeReport) {
    // The peek is not the bar's content: keep the expanded box to restore.
    if (!collapsed && !islandHidden) expandedSize = size;
    // A collapsed handle must not overwrite the size to restore on hover.
    void sidebarRelayout(expandedSize.width, expandedSize.height);
  }

  function onIdleSize(size: SizeReport) {
    idleW = size.width;
    idleH = size.height;
  }

  function onOpenSize(size: SizeReport) {
    openW = size.width;
    openH = size.height;
  }

  function onPanelSize(size: SizeReport) {
    panelW = size.width;
    panelH = size.height;
  }

  /**
   * Colour of the collapsed handle: the worst threshold reached by any window,
   * in the accent of the provider closest to its limit, so the sliver still
   * says *who* is busy. Computed from the snapshot, not from `items`: a window
   * the user removed from the bar must still be able to raise the alarm.
   */
  const handleColor = $derived(handleColorOf(snapshot.value, s));
  /** one segment per polled provider, each in its own severity colour */
  const segments = $derived(handleSegments(snapshot.value, s));
  /** the handle's tooltip / accessible name: the app and the busiest provider */
  const handleTitle = $derived.by(() => {
    const peak = handlePeak(snapshot.value, s);
    if (!peak) return t('app.name');
    const name = snapshot.value?.providers.find((p) => quotaKey(p) === peak.key)?.displayName ?? peak.provider;
    return t('sidebar.handleTitle', { app: t('app.name'), provider: name, percent: formatPercent(peak.used, s.percentMode) });
  });

  /**
   * Wall clock for the countdown labels and the aria text. Re-armed after every
   * tick for the next minute boundary of any reset moment on screen (the same
   * rule the popover uses), so nothing repaints more often than it changes.
   */
  let now = $state(Date.now());
  $effect(() => {
    const anchors = (snapshot.value?.providers ?? []).flatMap((p) => p.windows.map((w) => Date.parse(w.resetsAt ?? '')));
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(() => {
        now = Date.now();
        arm();
      }, nextTickDelay(Date.now(), anchors));
    };
    now = Date.now();
    arm();
    return () => clearTimeout(timer);
  });

  /**
   * One-shot micro-animations. `fx` maps a window to the event that just hit it;
   * `fxSeq` is bumped per event so a repeat replays the CSS animation. The very
   * first snapshot, and the first one after the thresholds changed (a settings
   * edit is not a quota event), only seed the baseline.
   */
  let fx = $state<Record<string, { kind: RingEventKind; id: number }>>({});
  let fxSeq = 0;
  let fxTimer: ReturnType<typeof setTimeout> | undefined;
  let prevLevels: Map<string, WindowLevel> | null = null;
  let prevThresholds = '';
  $effect(() => {
    const snap = snapshot.value;
    const th = s.thresholds;
    const animate = s.sidebarAnimations;
    if (snap === null) return;
    untrack(() => {
      const thKey = `${th.warn}/${th.critical}`;
      const next = levelsOf(snap, th);
      const events: RingEvent[] = thKey === prevThresholds ? detectRingEvents(prevLevels, next) : [];
      prevLevels = next;
      prevThresholds = thKey;
      if (events.length === 0) return;
      // The pet reacts even when the ring animations are switched off; the
      // animation itself still follows `sidebarAnimations`.
      if (savedPetVoice()) {
        for (const event of events) petSpeech.note(event.kind);
      }
      if (s.petOnDesktop) {
        for (const event of events) void emitWindowEvent('pet', 'pet-event', event.kind);
      }
      if (!animate) return;
      for (const e of events) fx[e.key] = { kind: e.kind, id: ++fxSeq };
      clearTimeout(fxTimer);
      fxTimer = setTimeout(() => (fx = {}), 1000);
    });
  });

  /**
   * A provider that stops being reachable gets a pet line and a rail dot. Only
   * the transition into a bad state is announced, so a long outage does not
   * keep replacing the latest message.
   */
  let prevStatuses: Map<string, string> | null = null;
  $effect(() => {
    const snap = snapshot.value;
    if (snap === null) return;
    untrack(() => {
      const next = new Map(snap.providers.map((quota) => [quotaKey(quota), quota.status]));
      if (prevStatuses && savedPetVoice()) {
        for (const [key, status] of next) {
          const before = prevStatuses!.get(key);
          if (before === 'ok' && status !== 'ok' && status !== 'disabled') {
            petSpeech.note('providerDown');
            break;
          }
        }
      }
      if (prevStatuses && s.petOnDesktop) {
        for (const [key, status] of next) {
          const before = prevStatuses!.get(key);
          if (before === 'ok' && status !== 'ok' && status !== 'disabled') {
            void emitWindowEvent('pet', 'pet-event', 'providerDown');
            break;
          }
        }
      }
      prevStatuses = next;
    });
  });

  onMount(() => {
    const disposers: Array<() => void> = [settings.init(), snapshot.init()];
    let un: Unlisten | null = null;
    let unTask: Unlisten | null = null;
    let disposed = false;
    void onSidebarState((state) => {
      expanded = state.expanded;
      if (!state.pinned) pinnedKey = null;
    }).then((u) => (disposed ? u() : (un = u)));
    // The pet reacts only once the user has actually used the pet panel; a
    // custom imported sprite still speaks in its selected skin's voice.
    void onTaskCompleted(() => {
      if (savedPetVoice()) petSpeech.note('taskDone');
      if (s.petOnDesktop) void emitWindowEvent('pet', 'pet-event', 'taskDone');
    }).then((u) => (disposed ? u() : (unTask = u)));

    // The detached pet window owns the same localStorage entry. It sends every
    // action here so the island can speak and a mounted panel can adopt the
    // newer state; `lastSeen` makes the two directions idempotent.
    let unPetState: Unlisten | null = null;
    let unPetRequest: Unlisten | null = null;
    void listen<{ state?: PetState; action?: PetAction }>('pet-state', (payload) => {
      if (!payload || typeof payload !== 'object' || !payload.state) return;
      const incoming = parsePetState(payload.state, Date.now());
      const current = savedPet();
      if (current && incoming.lastSeen <= current.lastSeen) return;
      writePluginState(PET_PLUGIN_ID, incoming);
      petRevision += 1;
      if (isPetAction(payload.action)) petSpeech.note(payload.action);
    }).then((u) => (disposed ? u() : (unPetState = u)));
    void listen<null>('pet-state-request', () => {
      const raw = readPluginState<unknown>(PET_PLUGIN_ID, null);
      if (raw === null) return;
      void emitWindowEvent('pet', 'pet-state', { state: parsePetState(raw, Date.now()) });
    }).then((u) => (disposed ? u() : (unPetRequest = u)));

    // The pet saves itself outside Svelte. A write in this window announces
    // itself with a custom event; a write in the detached window arrives as a
    // storage event (when the webviews share storage at all).
    const onPluginState = (event: Event) => {
      if ((event as CustomEvent<unknown>).detail === PET_PLUGIN_ID) petRevision += 1;
    };
    const onPetStorage = (event: StorageEvent) => {
      if (event.key === pluginStorageKey(PET_PLUGIN_ID)) petRevision += 1;
    };
    window.addEventListener('island-plugin-state', onPluginState);
    window.addEventListener('storage', onPetStorage);

    return () => {
      disposed = true;
      un?.();
      unTask?.();
      unPetState?.();
      unPetRequest?.();
      window.removeEventListener('island-plugin-state', onPluginState);
      window.removeEventListener('storage', onPetStorage);
      clearTimeout(fxTimer);
      clearTimeout(islandCollapseTimer);
      clearTimeout(panelCloseTimer);
      clearTimeout(suppressRingTimer);
      disposers.forEach((d) => d());
    };
  });

  // theme / scale / opacity / language follow the settings rune
  $effect(() => applyTheme(settings.value));

  // A module switched off in Settings neither scans nor draws a badge.
  $effect(() => {
    attention.configure(
      !s.disabledPlugins.includes('mail'),
      !s.disabledPlugins.includes('calendar')
    );
  });

  // A module switched off while its panel is open closes that panel at once.
  $effect(() => {
    if (activePluginId !== null && s.disabledPlugins.includes(activePluginId)) closePlugin();
  });

  // Mail unread / calendar-soon badges are only useful in island mode.
  $effect(() => {
    if (!s.island) return;
    attention.start();
    return () => attention.stop();
  });

  /** true while the user is carrying the bar to another edge / height */
  let dragging = $state(false);

  function onDrag(phase: DragPhase, dx: number, dy: number) {
    dragging = phase === 'start' || phase === 'move';
    if (phase === 'start') pinnedKey = null; // the platform force-hides the popover
    void sidebarDrag(phase, dx, dy);
  }

  function reportHover(hovered: boolean) {
    // The window trails the pointer during a drag; a stray leave must not
    // start the auto-hide timer under the user's hand.
    if (dragging && !hovered) return;
    void hoverReport('bar', hovered);
  }

  /** Grow the island; called on pointer enter and on keyboard focus. */
  function expandIsland() {
    if (!island) return;
    clearTimeout(islandCollapseTimer);
    clearTimeout(islandDwellTimer);
    if (islandExpanded) return;
    // Cancel a pending collapse hold: this is a re-entry, not a new opening.
    clearTimeout(islandHoldTimer);
    islandHold = false;
    // Give the native window the open box before the CSS morph starts. The
    // stage's ResizeObserver would report the same size a frame later; doing
    // it now keeps the first half of the spring from being clipped.
    if (islandReady) {
      const w = Math.max(openW, idleW) + ISLAND_BORDER;
      const h = Math.max(openH, idleH) + ISLAND_BORDER;
      void sidebarRelayout(w, h);
    }
    islandExpanded = true;
  }

  /** Swap the top-edge handle for the idle capsule. */
  function revealIsland() {
    if (!islandHidden) return;
    // Resize the native window first: it is only 24 px tall while hidden, so
    // rendering the capsule before the resize lands would clip it.
    if (idleW > 0 && idleH > 0) {
      void sidebarRelayout(idleW + ISLAND_BORDER, idleH + ISLAND_BORDER);
    }
    islandHidden = false;
  }

  /** Rest on the revealed capsule before opening the board (auto-hide only). */
  function scheduleIslandExpand() {
    clearTimeout(islandDwellTimer);
    if (!autoHideIsland) {
      expandIsland();
      return;
    }
    islandDwellTimer = setTimeout(() => {
      if (stageHovered) expandIsland();
    }, ISLAND_DWELL_MS);
  }

  /**
   * Shrink back to the summary after a short grace period, unless a plugin
   * panel is open or the pointer/focus is still somewhere in the stage.
   * The delay keeps moving between the capsule and the panel from flickering.
   */
  function scheduleIslandCollapse(delay = 360) {
    if (!island) return;
    clearTimeout(islandCollapseTimer);
    islandCollapseTimer = setTimeout(() => {
      if (stageHovered || activePluginId !== null) return;
      // Keyboard focus keeps the island open, but a button that merely kept
      // focus after a mouse click must not stop it from collapsing.
      const active = document.activeElement;
      if (
        stageKeyboardFocus &&
        active instanceof HTMLElement &&
        document.querySelector('.stage')?.contains(active)
      ) {
        return;
      }
      islandExpanded = false;
      // The capsule is shrinking inside a stage that still has the open size;
      // keep the native window there until the morph has landed, then shrink
      // it around the already-small pill (shrinking first would clip it).
      islandHold = true;
      clearTimeout(islandHoldTimer);
      islandHoldTimer = setTimeout(
        () => {
          islandHold = false;
          if (island && idleW > 0 && idleH > 0) {
            void sidebarRelayout(idleW + ISLAND_BORDER, idleH + ISLAND_BORDER);
          }
        },
        prefersReducedMotion() ? 80 : ISLAND_HOLD_MS
      );
      // The ring the bubble points at is about to disappear (the idle island
      // only shows the summary), so a pinned bubble must not be left floating.
      pinnedKey = null;
      void popoverHide();
    }, delay);
  }

  function onStageEnter() {
    stageHovered = true;
    revealIsland();
    if (island && islandIdle) {
      suppressRingHover = true;
      clearTimeout(suppressRingTimer);
      suppressRingTimer = setTimeout(() => (suppressRingHover = false), 500);
    }
    scheduleIslandExpand();
    reportHover(true);
  }

  /** The hidden handle is the only focusable part of the island. */
  function onStageKeydown(ev: KeyboardEvent) {
    if (!islandHidden) return;
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      revealIsland();
      expandIsland();
    }
  }

  function onStageLeave() {
    stageHovered = false;
    clearTimeout(islandDwellTimer);
    scheduleIslandCollapse();
    reportHover(false);
  }

  function onStageFocusIn(ev: FocusEvent) {
    const target = ev.target;
    stageKeyboardFocus = target instanceof HTMLElement && target.matches(':focus-visible');
    revealIsland();
    if (island && islandIdle) {
      suppressRingHover = true;
      clearTimeout(suppressRingTimer);
      suppressRingTimer = setTimeout(() => (suppressRingHover = false), 500);
    }
    // Keyboard focus must not have to wait out the hover dwell.
    expandIsland();
  }

  function onStageFocusOut(ev: FocusEvent) {
    const next = ev.relatedTarget as Node | null;
    if (next && (ev.currentTarget as HTMLElement).contains(next)) return;
    stageKeyboardFocus = false;
    scheduleIslandCollapse();
  }

  function togglePlugin(id: string) {
    expandIsland();
    clearTimeout(panelCloseTimer);
    closingPlugin = false;
    if (activePluginId === id) {
      closePlugin();
      return;
    }
    activePluginId = id;
    // A panel and a detail bubble would overlap at the top of the screen.
    pinnedKey = null;
    void popoverHide();
  }

  function prefersReducedMotion(): boolean {
    return (
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
    );
  }

  function closePlugin() {
    if (activePluginId === null) return;
    if (prefersReducedMotion()) {
      activePluginId = null;
      closingPlugin = false;
      scheduleIslandCollapse();
      return;
    }
    if (closingPlugin) return;
    // Keep the panel mounted for one short exit beat so it leaves with the
    // same jelly language it arrived with. The guard above makes a second
    // click or Escape harmless.
    closingPlugin = true;
    clearTimeout(panelCloseTimer);
    panelCloseTimer = setTimeout(() => {
      activePluginId = null;
      closingPlugin = false;
      scheduleIslandCollapse();
    }, 170);
  }

  function onWindowKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Escape' && activePluginId !== null) {
      ev.preventDefault();
      closePlugin();
    }
  }

  /** Ring centre in CSS px relative to this window (= the viewport). */
  /** "still here" while the pointer moves over the bar, see HEARTBEAT_MS */
  const heartbeat = throttle(() => void hoverReport('bar', true), HEARTBEAT_MS);

  function anchorOf(el: HTMLElement): { x: number; y: number } {
    // aim at the ring itself, not at the text that may sit beside it
    const target = el.querySelector<HTMLElement>('.ring, .mini') ?? el;
    const r = target.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }

  /** The saved pet, or null until the user has used the pet panel. */
  function savedPet(): PetState | null {
    const raw = readPluginState<unknown>(PET_PLUGIN_ID, null);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return parsePetState(raw, Date.now());
  }

  /** The saved pet's voice, or null until the user has used the pet panel. */
  function savedPetVoice(): PetVoice | null {
    const pet = savedPet();
    return pet ? petVoice(pet.skin, pet.deepseekForm) : null;
  }

  /**
   * The rail tooltip carries the pet's current need, so a hungry or sleepy pet
   * is visible without opening the panel. Other modules keep their plain name.
   */
  function pluginTooltip(plugin: IslandPlugin, active: boolean): string {
    const label = tDyn(plugin.label);
    if (active) return `${label} — ${t('island.closePanel')}`;
    if (plugin.id !== 'pet' || !petGlance) return label;
    const status = t(`plugin.pet.status.${petGlance.mood}`);
    if (petGlance.meals <= 0) return `${label} — ${status}`;
    return `${label} — ${status} · ${t('plugin.pet.meals', { count: petGlance.meals })}`;
  }

  function requestPopover(item: RingItem, el: HTMLElement) {
    const anchor = anchorOf(el);
    const pet = savedPet();
    const voice = pet ? petVoice(pet.skin, pet.deepseekForm) : null;
    const situation = voice ? quotaSituation(item.quota, s) : null;
    void popoverShow({
      provider: item.quotaKey,
      ringIndex: item.index,
      // Both axes travel; the platform layer uses the one along the bar.
      anchorY: anchor.y,
      anchorX: anchor.x,
      windowKind: item.labelWindow?.kind ?? null,
      petLine: voice && situation ? tDyn(sayKey(voice, situation)) : null,
      // An imported custom sprite lives in localStorage and cannot travel
      // with the event; the line still speaks, only the bundled face is shown
      // when the user is on the bundled art.
      petAvatar:
        pet && voice && situation && !pet.sprite ? speechAvatar(voice, situation) : null,
    });
  }

  function onRingEnter(item: RingItem, ev: MouseEvent) {
    if (dragging || suppressRingHover) return;
    requestPopover(item, ev.currentTarget as HTMLElement);
  }

  /**
   * Click or Enter/Space pins the ring's popover. A double-click is two clicks
   * plus a dblclick: only the first click counts, otherwise the second one
   * would un-pin (and hide) the popover that the first had just opened.
   * The popover window never takes focus, so a keyboard user cannot be moved
   * into it; pinning keeps it open, and its Esc / close button need a pointer.
   */
  function onRingClick(item: RingItem, ev: MouseEvent) {
    if (ev.detail > 1) return;
    if (suppressRingHover) {
      expandIsland();
      return;
    }
    const el = ev.currentTarget as HTMLElement;
    const nextPinned = pinnedKey !== item.key;
    pinnedKey = nextPinned ? item.key : null;
    // re-target so a click on a *different* ring moves the pinned popover;
    // a second click on the pinned ring dismisses the popover right away
    // (hovering the ring again brings it back)
    if (nextPinned) {
      void popoverSetPinned(true);
      requestPopover(item, el);
    } else {
      void popoverHide();
    }
  }

  /**
   * Screen-reader label: provider, then its status when it is not "ok", then
   * every arc outer → inner with percent, severity and reset time.
   */
  function ringLabel(item: RingItem): string {
    const head = [item.quota.displayName];
    if (item.quota.status !== 'ok') head.push(tDyn(`status.${item.quota.status}`));
    const parts = item.arcs.map((a) => {
      const sev = severityOf(a.window.usedPercent, s.thresholds);
      const level = sev === 'normal' ? '' : ` (${t(`a11y.severity.${sev}`)})`;
      // the forecast is only spoken when the ring draws it (same trust rule)
      const fc = forecastTickPercent(a.window) == null ? null : formatForecast(a.window, s.percentMode, now);
      const outlook = fc ? `, ${t('a11y.forecast', { text: fc.text })}` : '';
      return `${windowLabel(a.window, 'bar')} ${formatPercent(a.window.usedPercent, s.percentMode)}${level}, ${formatReset(a.window.resetsAt, now)}${outlook}`;
    });
    const name = head.join(' · ');
    return parts.length === 0 ? name : `${name}: ${parts.join('; ')}`;
  }

  /** arcs as the ring / mini-bar draw them, with their one-shot animation */
  function arcViews(item: RingItem) {
    return item.arcs.map((a) => {
      const e = fx[windowKey(item.quotaKey, a.window)];
      return {
        percent: a.window.usedPercent,
        accent: a.accent,
        projectedPercent: forecastTickPercent(a.window),
        fx: e?.kind ?? null,
        fxId: e?.id ?? 0,
      };
    });
  }

  /** what the label says and where, see `labelLayout` */
  function layoutOf(item: RingItem): LabelLayout {
    if (!s.sidebarItems.percentLabel) return { center: null, main: null, sub: null };
    const w = item.labelWindow;
    return labelLayout({
      content: s.labelContent,
      position: s.percentPosition,
      horizontal,
      percent: shortPercent(w?.usedPercent ?? null, s.percentMode),
      reset: compactReset(w?.resetsAt, now),
    });
  }

  /** polite live region: only changes when a provider's status does */
  const statusAnnouncement = $derived(
    items
      .filter((i) => i.quota.status !== 'ok')
      .map((i) => t('a11y.statusChanged', { provider: i.quota.displayName, status: tDyn(`status.${i.quota.status}`) }))
      .join('. ')
  );
</script>

<svelte:head><title>{t('app.name')}</title></svelte:head>

<svelte:window onkeydown={onWindowKeydown} />

{#snippet ringView(item: RingItem)}
  <div
    class="slot"
    class:pinned={pinnedKey === item.key}
    role="button"
    tabindex="0"
    aria-label={ringLabel(item)}
    aria-pressed={pinnedKey === item.key}
    onmouseenter={(e) => onRingEnter(item, e)}
    onclick={(e) => onRingClick(item, e)}
    ondblclick={(e) => e.stopPropagation()}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onRingClick(item, e as unknown as MouseEvent);
      }
    }}
  >
    {#if compact}
      <MiniBar
        segments={arcViews(item)}
        thresholds={s.thresholds}
        percentMode={s.percentMode}
        layout={layoutOf(item)}
        {horizontal}
        status={item.quota.status}
      >
        {#snippet logo(logoSize)}
          {#if s.sidebarItems.logo}<ProviderLogo provider={item.provider} size={logoSize} />{/if}
        {/snippet}
      </MiniBar>
    {:else}
      <Ring
        arcs={arcViews(item)}
        labelPercent={item.labelWindow?.usedPercent ?? null}
        thresholds={s.thresholds}
        showPercentLabel={s.sidebarItems.percentLabel}
        percentMode={s.percentMode}
        percentPosition={s.percentPosition}
        layout={layoutOf(item)}
        inline={horizontal}
        status={item.quota.status}
        interactive
      >
        {#snippet logo(logoSize)}
          {#if s.sidebarItems.logo}<ProviderLogo provider={item.provider} size={logoSize} />{/if}
        {/snippet}
      </Ring>
    {/if}
  </div>
{/snippet}

{#snippet barActions()}
  {#if s.sidebarItems.settingsButton || s.sidebarItems.moreButton}
    <div class="bar-actions">
      {#if s.sidebarItems.settingsButton}
        <button
          class="chrome gear"
          onclick={() => void openDashboard('settings')}
          ondblclick={(e) => e.stopPropagation()}
          aria-label={t('sidebar.settings')}
          title={t('sidebar.settings')}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3.1"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c0 .66.4 1.26 1 1.51H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"></path>
          </svg>
        </button>
      {/if}
      {#if s.sidebarItems.moreButton}
        <button class="chrome dots" onclick={() => void openDashboard('overview')} ondblclick={(e) => e.stopPropagation()} aria-label={t('sidebar.more')} title={t('sidebar.more')}>⋯</button>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet barContent()}
  {#if loading}
    {#each placeholders as i (i)}
      <div class="slot">
        {#if compact}
          <MiniBar segments={[]} thresholds={s.thresholds} {horizontal} loading />
        {:else}
          <Ring arcs={[]} thresholds={s.thresholds} loading showPercentLabel={s.sidebarItems.percentLabel} percentPosition={s.percentPosition} />
        {/if}
      </div>
    {/each}
  {:else if items.length === 0}
    <div class="slot empty" title={t('overview.noProviders')}>
      <button class="dots" onclick={() => void openDashboard('settings')} ondblclick={(e) => e.stopPropagation()} aria-label={t('sidebar.more')}>⋯</button>
    </div>
  {:else}
    {#each items as item (item.key)}
      {@render ringView(item)}
    {/each}
    {@render barActions()}
  {/if}
{/snippet}

{#snippet pluginBadge(id: string)}
  {#if id === 'mail' && attention.mailUnread > 0}
    <span class="tool-badge" aria-hidden="true">{attention.mailUnread > 9 ? '9+' : attention.mailUnread}</span>
  {:else if id === 'calendar' && attention.calendarSoon}
    <span class="tool-dot" aria-hidden="true"></span>
  {:else if id === 'pet' && petSpeech.unread}
    <span class="tool-dot" aria-hidden="true"></span>
  {:else if id === 'pet' && (petGlance?.mood === 'hungry' || petGlance?.mood === 'tired')}
    <!-- A quiet nudge, not an alarm: the pet needs food or rest. -->
    <span class="tool-dot need" aria-hidden="true"></span>
  {/if}
{/snippet}

{#snippet idleContent()}
  <div class="idle-row">
    {#if loading}
      <div class="slot">
        {#if compact}
          <MiniBar segments={[]} thresholds={s.thresholds} {horizontal} loading />
        {:else}
          <Ring arcs={[]} thresholds={s.thresholds} loading showPercentLabel={s.sidebarItems.percentLabel} percentPosition={s.percentPosition} />
        {/if}
      </div>
    {:else if idleShowsSummary && islandSummary}
      <!-- Nothing chosen: the busiest provider plus a count, the original
           glanceable summary. -->
      <div class="summary" aria-label={t('island.summary')}>
        {@render ringView(islandSummary)}
        {#if items.length > 1}
          <span class="more-count" aria-label={t('island.providerCount', { count: items.length - 1 })}>
            +{items.length - 1}
          </span>
        {/if}
      </div>
    {:else}
      {#each idleProviderItems as item (item.key)}
        {@render ringView(item)}
      {/each}
    {/if}

    {#if !loading && idlePlugins.length > 0}
      <!-- Informational, not buttons: entering the stage expands the island
           before a click could land, so these icons only report status. The
           same plugin is one click away in the expanded rail. -->
      <div class="idle-plugins" role="group" aria-label={t('island.pluginRail')}>
        {#each idlePlugins as plugin (plugin.id)}
          <span class="tool idle-tool" role="img" aria-label={tDyn(plugin.label)} title={pluginTooltip(plugin, false)}>
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d={plugin.icon}></path>
            </svg>
            {@render pluginBadge(plugin.id)}
          </span>
        {/each}
      </div>
    {/if}

    {#if !loading && !islandSummary && idleProviderItems.length === 0 && idlePlugins.length === 0}
      <!-- Keep a non-zero, hoverable box when everything is hidden. -->
      <div class="slot empty" title={t('overview.noProviders')}>
        <button class="dots" onclick={() => void openDashboard('settings')} ondblclick={(e) => e.stopPropagation()} aria-label={t('sidebar.more')}>⋯</button>
      </div>
    {/if}
  </div>
{/snippet}

{#snippet openContent()}
  <div class="island-providers">
    {#if loading}
      {#each placeholders as i (i)}
        <div class="slot">
          {#if compact}
            <MiniBar segments={[]} thresholds={s.thresholds} {horizontal} loading />
          {:else}
            <Ring arcs={[]} thresholds={s.thresholds} loading showPercentLabel={s.sidebarItems.percentLabel} percentPosition={s.percentPosition} />
          {/if}
        </div>
      {/each}
    {:else if items.length === 0}
      <!-- Nothing to draw (no provider enabled, or everything hidden from the
           bar): the grip is rendered whatever `moreButton` says, so the pill
           keeps a non-zero box and stays hoverable, draggable and clickable. -->
      <div class="slot empty" title={t('overview.noProviders')}>
        <button class="dots" onclick={() => void openDashboard('settings')} ondblclick={(e) => e.stopPropagation()} aria-label={t('sidebar.more')}>⋯</button>
      </div>
    {:else}
      {#each items as item (item.key)}
        {@render ringView(item)}
      {/each}
      {@render barActions()}
    {/if}
  </div>

  {#if !loading}
    <div class="island-tools" role="toolbar" aria-label={t('island.pluginRail')}>
      {#each enabledIslandPlugins as plugin, i (plugin.id)}
        {@const active = activePluginId === plugin.id}
        <button
          type="button"
          class="tool"
          class:active
          style={`--i:${i}`}
          aria-pressed={active}
          aria-label={tDyn(plugin.label)}
          title={pluginTooltip(plugin, active)}
          onclick={(e) => {
            e.stopPropagation();
            togglePlugin(plugin.id);
          }}
          ondblclick={(e) => e.stopPropagation()}
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d={plugin.icon}></path>
          </svg>
          {@render pluginBadge(plugin.id)}
        </button>
      {/each}
      {#if enabledIslandPlugins.length === 0}
        <!-- Do not leave the rail as a dead end: open Settings → Plugins. -->
        <button
          type="button"
          class="tool tool-off"
          aria-label={t('island.pluginsOff')}
          title={t('island.pluginsOff')}
          onclick={(e) => {
            e.stopPropagation();
            void openDashboard('settings');
          }}
          ondblclick={(e) => e.stopPropagation()}
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6"></path>
          </svg>
        </button>
      {/if}
    </div>
  {/if}
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_tabindex (role="button" only while the island is hidden) -->
<div
  class="stage"
  data-edge={island ? 'top' : s.edge}
  data-island={island ? 'true' : undefined}
  style:width={island && islandReady ? `${stageW}px` : undefined}
  style:height={island && islandReady ? `${stageH}px` : undefined}
  use:observeSize={reportSize}
  oncontextmenu={(e) => e.preventDefault()}
  onmouseenter={onStageEnter}
  onmouseleave={onStageLeave}
  onfocusin={onStageFocusIn}
  onfocusout={onStageFocusOut}
  onmousemove={heartbeat}
  onkeydown={onStageKeydown}
  tabindex={islandHidden ? 0 : undefined}
  role={islandHidden ? 'button' : 'presentation'}
  aria-label={islandHidden ? t('island.reveal') : undefined}
>
  <div class="sr-only" role="status" aria-live="polite">{statusAnnouncement}</div>
  {#if collapsed}
    <!-- auto-hidden: only a thin coloured sliver is left on the screen edge -->
    <!-- `collapsedWidth` is the sliver's thickness: its width on a left/right
         edge, its height on a top/bottom one -->
    <div
      class="handle"
      class:horizontal
      style:width={horizontal ? `${expandedSize.width}px` : `${Math.max(2, s.collapsedWidth)}px`}
      style:height={horizontal ? `${Math.max(2, s.collapsedWidth)}px` : `${expandedSize.height}px`}
      onmouseenter={() => void hoverReport('bar', true)}
      role="img"
      aria-label={handleTitle}
      title={handleTitle}
    >
      {#each segments as g (g.key)}
        <span class="seg" style:background={g.accent}></span>
      {:else}
        <span class="seg" style:background={handleColor}></span>
      {/each}
    </div>
  {:else if island}
    {#if islandHidden}
      <!-- auto-hide: only a thin handle remains on the top edge; the whole
           stage is its 96 × 24 hit area and keyboard target -->
      <div class="island-peek" aria-hidden="true"></div>
    {:else}
    <!-- the island is never dragged: a drop would fight the top-centre
         placement watchdog, so the whole capsule is a normal surface. The
         panel is a sibling surface, not a flex child of the capsule: its
         intrinsic width would otherwise stretch the capsule. -->
    <div class="island-shell">
      <div
        class="pill surface island"
        class:compact
        class:island-idle={islandIdle}
        class:island-open={!islandIdle}
        class:island-ready={islandReady}
        style:width={islandReady ? `${pillTargetW}px` : undefined}
        style:height={islandReady ? `${pillTargetH}px` : undefined}
        ondblclick={() => void openDashboard('overview')}
        role="presentation"
      >
        <!-- Idle and open are both mounted and measured, so the capsule can
             morph between two known boxes. Only one is interactive at a time. -->
        <div
          class="island-layer idle-layer"
          use:measureSize={onIdleSize}
          inert={!islandIdle || undefined}
          aria-hidden={!islandIdle}
        >
          {@render idleContent()}
        </div>
        <div
          class="island-layer open-layer"
          use:measureSize={onOpenSize}
          inert={islandIdle || undefined}
          aria-hidden={islandIdle}
        >
          {@render openContent()}
        </div>
      </div>
      {#if activePlugin && !islandIdle && !loading}
        {@const PluginPanel = activePlugin.component}
        <section
          class="island-panel surface"
          class:closing={closingPlugin}
          aria-label={tDyn(activePlugin.label)}
          use:measureSize={onPanelSize}
        >
          <PluginPanel close={closePlugin} />
        </section>
      {/if}
    </div>
    {/if}
  {:else}
    <div class="pill surface" class:compact use:dragHandle={onDrag} ondblclick={() => void openDashboard('overview')} role="presentation">
      {@render barContent()}
    </div>
  {/if}
</div>

<style>
  /* The stage is exactly as big as the painted element — that measurement is
     what sidebar_relayout sizes the window to. */
  .stage {
    width: max-content;
    height: max-content;
  }

  /* The window is resized and re-centred by Rust a beat after the content
     changes, so during the transition it can still be wider (collapsing) or
     narrower (expanding) than the island. Centring the stage inside that
     transient viewport keeps both edges symmetric: the capsule grows out of
     and shrinks back into the middle instead of hugging the old window's left
     edge and then jumping to the centre when the resize lands. */
  .stage[data-island] {
    position: fixed;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  /* The hidden island: a 96 × 24 transparent hit box with a 4 px handle in the
     middle, so pointing near the top edge is forgiving. */
  .island-peek {
    width: 3.5rem;
    height: 0.25rem;
    margin-top: 0.625rem;
    border-radius: 999px;
    background: var(--muted);
    opacity: 0.45;
    transition:
      width 220ms var(--ease-out),
      opacity var(--dur-ui) var(--ease-out),
      background var(--dur-ui) var(--ease-out);
  }

  .stage[data-island]:hover .island-peek,
  .stage[data-island]:focus-visible .island-peek {
    width: 4.25rem;
    background: var(--focus);
    opacity: 0.95;
  }

  .stage[data-island]:focus-visible {
    outline: none;
  }

  .stage[data-island]:focus-visible .island-peek {
    box-shadow: 0 0 0 2px var(--focus);
  }

  .pill {
    display: flex;
    flex-direction: column;
    align-items: center;
    /* Geometry comes from Settings.sizes (applied to <html> by applyTheme).
       At the defaults this is the original ~76px pill: 56px ring + 2 × 10px
       side padding, 14px top/bottom, 18px between groups. max-content (not a
       fixed width) so removing the edge-side border below can never squeeze
       the ring out of the content box. */
    width: max-content;
    min-width: calc(var(--ring-size) + 2 * var(--bar-padding));
    /* vertical padding tracks the horizontal one but stays 4px roomier, which
       reproduces the 14/10 of the reference design at the default size */
    padding: calc(var(--bar-padding) + 0.25rem) var(--bar-padding);
    gap: var(--bar-gap);
    /* background / border / shadow / glass layers come from the global
       `.surface` material in base.css so the popover bubble matches exactly */
    border-radius: var(--r-pill);
  }

  .pill:global([data-dragging]) {
    cursor: grabbing;
  }

  /* A top/bottom bar is the same pill turned 90°: the rings run in a row and
     the 4px-roomier padding follows to the horizontal axis. */
  .stage[data-edge='top'] .pill,
  .stage[data-edge='bottom'] .pill {
    flex-direction: row;
    min-width: 0;
    min-height: calc(var(--ring-size) + 2 * var(--bar-padding));
    padding: var(--bar-padding) calc(var(--bar-padding) + 0.25rem);
  }

  /* Compact bars: the footprint is the bars', not a ring's. Declared after the
     edge rules above so it wins at equal specificity. */
  .stage .pill.compact {
    min-width: 0;
    min-height: 0;
    gap: 0.75rem;
    padding: 0.625rem 0.5rem;
  }

  .stage[data-edge='top'] .pill.compact,
  .stage[data-edge='bottom'] .pill.compact {
    gap: 1rem;
    padding: 0.5rem 0.75rem;
  }

  /* The docked side is flush with the screen: no rounding, no border there. */
  .stage[data-edge='right'] .pill {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
    border-right: none;
  }

  .stage[data-edge='left'] .pill {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    border-left: none;
  }

  .stage[data-edge='top'] .pill {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
    border-top: none;
  }

  .stage[data-edge='bottom'] .pill {
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    border-bottom: none;
  }

  .slot {
    display: block;
    line-height: 0;
    border-radius: 0.75rem;
  }

  .slot.empty {
    display: grid;
    place-items: center;
    min-height: 3.5rem;
  }

  .stage[data-edge='top'] .slot.empty,
  .stage[data-edge='bottom'] .slot.empty {
    min-width: 3.5rem;
    min-height: 0;
  }

  .slot.pinned :global(.ring) {
    /* pinned popover: keep the ring visually "held open" */
    transform: scale(1.06);
  }

  /* Chrome under the rings: the gear (settings) and the "⋯" (dashboard).
     Both are compact icons in one row, so the pill grows by one icon row at
     most and the column footprint stays inside the ring's width. */
  .bar-actions {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.0625rem;
    margin-top: -0.375rem;
  }

  .chrome {
    position: relative;
    display: grid;
    place-items: center;
    flex: none;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 0.25rem;
    color: var(--faint);
    transition:
      color var(--dur-ui) var(--ease-out),
      background var(--dur-ui) var(--ease-out);
  }

  .chrome:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  /* The glyphs are ~10px; an invisible box keeps the target at least 24px
     without moving anything. */
  .chrome::before {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    width: max(100%, 1.5rem);
    height: max(100%, 1.5rem);
    transform: translate(-50%, -50%);
  }

  .dots {
    padding: 0;
    font-size: 1rem;
    line-height: 1;
    letter-spacing: 0.1em;
  }

  /* The empty state renders a lone "⋯" as the grip; it must stay clickable
     even when every other item is hidden. */
  .slot.empty .dots {
    width: 1.5rem;
    height: 1.5rem;
    margin: 0;
    border-radius: 0.25rem;
  }

  /* In a row the buttons sit beside the last ring instead of under it. */
  .stage[data-edge='top'] .bar-actions,
  .stage[data-edge='bottom'] .bar-actions {
    margin-top: 0;
    margin-left: -0.375rem;
  }

  /* ---- dynamic island -------------------------------------------------
     The capsule has two fixed-size content layers (idle and open) measured
     at the same time. Animating the pill's own width/height — rather than
     swapping a max-content row — keeps both edges moving symmetrically and
     lets the stage reserve the larger box until the morph has landed. */
  .stage[data-island] .pill.island {
    position: relative;
    display: block;
    flex: none;
    width: 5.5rem;
    height: calc(var(--ring-size) + 1.5 * var(--bar-padding));
    min-width: 0;
    min-height: 0;
    padding: 0;
    gap: 0;
    overflow: hidden;
    border: 1px solid var(--bar-border);
    border-radius: 999px;
    box-shadow: var(--bar-shadow), 0 18px 46px -20px rgb(0 0 0 / 0.55);
    transform-origin: 50% 0;
    /* Closing: hold the box for one beat while the open board fades out
       (70 ms), then shrink around the already-idle content. Opening overrides
       this below and starts immediately. */
    transition:
      width 440ms cubic-bezier(0.16, 1, 0.3, 1) 220ms,
      height 440ms cubic-bezier(0.16, 1, 0.3, 1) 220ms,
      border-radius 300ms var(--ease-out),
      box-shadow 220ms var(--ease-out);
  }

  /* The first measurement sizes the capsule; do not animate that one. */
  .stage[data-island] .pill.island:not(.island-ready) {
    transition: none;
  }

  .stage[data-island] .pill.island.island-open {
    transition:
      width 440ms cubic-bezier(0.16, 1, 0.3, 1),
      height 440ms cubic-bezier(0.16, 1, 0.3, 1),
      border-radius 300ms var(--ease-out),
      box-shadow 220ms var(--ease-out);
  }

  /* A spring that overshoots would be clipped by the window (which is only
     as large as the capsule), so the bounce lives in the layers' scale
     instead. Idle and open cross-fade while the box grows from its centre. */
  .pill.island.island-open {
    border-radius: 1.75rem;
  }

  .pill.island.island-idle {
    border-radius: 999px;
  }

  .pill.island .island-layer {
    position: absolute;
    top: 50%;
    left: 50%;
    z-index: 1;
    width: max-content;
    height: max-content;
    transform: translate(-50%, -50%);
    transform-origin: center;
  }

  .pill.island .idle-layer {
    opacity: 1;
    pointer-events: auto;
    transform: translate(-50%, -50%) scale(1);
    /* closing: fade in at once so the capsule is never empty while the
       board leaves; the delayed width/height shrink follows the swap */
    transition:
      opacity 100ms var(--ease-out),
      transform 220ms cubic-bezier(0.2, 0.9, 0.3, 1);
  }

  /* The outgoing layer leaves while the box is still growing, and the
     incoming one only fades in once the box is nearly at its target size.
     Cross-fading the two boards earlier made the wider board hang over the
     capsule and get clipped by `overflow: hidden` for a few frames — the
     visible "flash" on expand/collapse. */
  .pill.island.island-open .idle-layer {
    opacity: 0;
    pointer-events: none;
    transform: translate(-50%, -50%) scale(0.97);
    transition:
      opacity 60ms linear 180ms,
      transform 180ms var(--ease-out) 160ms;
  }

  .pill.island .open-layer {
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transform: translate(-50%, -50%) scale(0.94);
    /* closing: leave quickly at the full box size, before the shrink starts */
    transition:
      opacity 60ms linear,
      transform 100ms var(--ease-out),
      visibility 0s linear 60ms;
  }

  .pill.island.island-open .open-layer {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
    transform: translate(-50%, -50%) scale(1);
    /* opening: the 440 ms width spring is ~97 % done at 230 ms */
    transition:
      opacity 140ms var(--ease-out) 250ms,
      transform 220ms cubic-bezier(0.2, 1, 0.3, 1) 220ms,
      visibility 0s;
  }

  .idle-row {
    display: flex;
    align-items: center;
    gap: calc(var(--bar-gap) * 0.35);
    padding: calc(var(--bar-padding) * 0.55) calc(var(--bar-padding) * 0.85);
  }

  .idle-plugins {
    display: flex;
    align-items: center;
    gap: 0.05rem;
    margin-left: 0.1rem;
    padding-left: 0.35rem;
    border-left: 1px solid var(--border);
  }

  .idle-tool {
    width: 1.5rem;
    height: 1.5rem;
    animation: none;
  }

  .open-layer {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    min-width: 25rem;
    max-width: 40rem;
    padding: calc(var(--bar-padding) + 0.15rem) calc(var(--bar-padding) + 0.4rem);
  }

  .island-providers {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: calc(var(--bar-gap) * 0.55);
    row-gap: 0.35rem;
  }

  .island-shell {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: max-content;
    gap: 7px;
  }

  .summary {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .more-count {
    flex: none;
    padding: 0 0.35rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--muted);
    font-size: 0.625rem;
    line-height: 1.4;
    white-space: nowrap;
  }

  .island-tools {
    display: grid;
    grid-template-columns: repeat(5, 1.75rem);
    align-items: center;
    justify-content: center;
    gap: 0.25rem 0.4rem;
    align-self: stretch;
    margin-top: 0.15rem;
    padding-top: 0.35rem;
    border-top: 1px solid var(--border);
  }

  .pill.island-open .open-layer .island-tools {
    animation: island-tools-in 360ms cubic-bezier(0.2, 1.35, 0.35, 1);
  }

  .tool {
    position: relative;
    display: grid;
    place-items: center;
    width: 1.65rem;
    height: 1.65rem;
    border-radius: 999px;
    color: var(--muted);
    transition:
      transform 220ms cubic-bezier(0.2, 1.5, 0.4, 1),
      background var(--dur-ui) var(--ease-out),
      color var(--dur-ui) var(--ease-out),
      box-shadow 220ms var(--ease-out);
  }

  .pill.island-open .open-layer .tool {
    animation: island-tool-pop 300ms cubic-bezier(0.2, 1.5, 0.4, 1) backwards;
    animation-delay: calc(var(--i, 0) * 18ms);
  }

  /* The solitary "all plugins are off" shortcut sits centred in the rail. */
  .tool-off {
    grid-column: 1 / -1;
    justify-self: center;
  }

  .tool-badge {
    position: absolute;
    top: -0.125rem;
    right: -0.1875rem;
    min-width: 0.75rem;
    height: 0.75rem;
    padding: 0 0.1875rem;
    border: 1.5px solid var(--bg);
    border-radius: 999px;
    background: var(--focus);
    color: var(--bg);
    font-size: 0.5rem;
    font-weight: 700;
    line-height: 0.75rem;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  .tool-dot {
    position: absolute;
    top: 0.125rem;
    right: 0.125rem;
    width: 0.3125rem;
    height: 0.3125rem;
    border-radius: 999px;
    background: var(--warn);
    box-shadow: 0 0 0 1.5px var(--bg);
  }

  /* A hungry or sleepy pet: the same dot, breathing slowly. */
  .tool-dot.need {
    animation: need-pulse 2.4s ease-in-out infinite;
  }

  @keyframes need-pulse {
    0%,
    100% {
      opacity: 0.55;
      transform: scale(0.85);
    }
    50% {
      opacity: 1;
      transform: scale(1.15);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .tool-dot.need {
      animation: none;
    }
  }

  .tool:hover {
    transform: translateY(-1px) scale(1.1);
    background: var(--surface-2);
    color: var(--text);
  }

  .tool:active {
    transform: translateY(0) scale(0.9);
    transition-duration: 90ms;
  }

  .tool.active {
    transform: scale(1.04);
    background: var(--surface-2);
    color: var(--focus);
    box-shadow: inset 0 0 0 1px var(--border);
  }

  /* A sibling surface under the capsule, centred like a Dynamic Island panel.
     It is measured by the same observer, so the window grows downwards. */
  .island-panel {
    width: max-content;
    max-width: calc(100vw - 1.5rem);
    /* The capsule and tool rail occupy the top ~12rem including the island
       margin. Reserving that much keeps the panel's own scrollbar inside the
       window instead of letting its last rows fall off the screen. */
    max-height: calc(100vh - 13rem);
    padding: 0.55rem 0.7rem;
    border-radius: calc(var(--r-pill) + 2px);
    overflow-y: auto;
    overscroll-behavior: contain;
    transform-origin: 50% 0;
    animation: island-panel-in 420ms cubic-bezier(0.2, 1.35, 0.35, 1);
  }

  .island-panel.closing {
    animation: island-panel-out 170ms cubic-bezier(0.4, 0, 0.8, 0.4) both;
    pointer-events: none;
  }

  @keyframes island-tools-in {
    0% {
      opacity: 0;
      transform: translateY(-3px) scaleX(0.97);
    }
    70% {
      opacity: 1;
      transform: translateY(1px) scaleX(1.008);
    }
    100% {
      opacity: 1;
      transform: translateY(0) scaleX(1);
    }
  }

  @keyframes island-tool-pop {
    0% {
      opacity: 0;
      transform: translateY(3px) scale(0.6);
    }
    60% {
      opacity: 1;
      transform: translateY(-1px) scale(1.06);
    }
  }

  @keyframes island-panel-in {
    0% {
      opacity: 0;
      transform: translateY(-10px) scale(0.94);
    }
    60% {
      opacity: 1;
      transform: translateY(1px) scale(1.008);
    }
    100% {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  @keyframes island-panel-out {
    to {
      opacity: 0;
      transform: translateY(-6px) scale(0.97);
    }
  }

  .handle {
    height: 8.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.0625rem;
    overflow: hidden;
    border-radius: 999px;
    opacity: 0.85;
  }

  .handle.horizontal {
    flex-direction: row;
  }

  /* one equal segment per provider, in that provider's severity colour */
  .handle .seg {
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
    transition: background var(--dur-ring) var(--ease-out);
  }

  /* The inline width/height above win; this only keeps the fallback sane. */
  .stage[data-edge='top'] .handle,
  .stage[data-edge='bottom'] .handle {
    width: 8.75rem;
    height: auto;
  }
</style>
