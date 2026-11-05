<!--
  Window "sidebar" (route "/"). [FRONTEND]

  A transparent, frameless window that contains exactly one painted element:
  the near-black pill hugging the screen edge (or, when auto-hide collapsed the
  bar, a thin coloured handle).

  Window protocol
  ---------------
  * `observeSize` measures the painted element and reports its CSS px size to
    `sidebar_relayout` (debounced 50 ms) — the Rust side resizes the window to
    exactly that and re-anchors it to the configured edge. Everything is
    `width: max-content` / auto height so the measured size never depends on the
    window size (no resize feedback loop).
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
  import { dragHandle, HEARTBEAT_MS, observeSize, throttle, type DragPhase, type SizeReport } from '$lib/actions';
  import {
    hoverReport,
    onSidebarState,
    openDashboard,
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
  import { attention } from '$lib/plugins/attention.svelte';
  import { pluginById, ISLAND_PLUGINS } from '$lib/plugins/registry';
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
   * Island-only state. Idle shows a single summary ring and grows into the
   * full row on hover/focus; a plugin panel keeps it open until it is closed.
   * None of this touches the Rust hover state machine, which still owns
   * auto-hide for edge bars.
   */
  let islandExpanded = $state(false);
  let stageHovered = $state(false);
  let activePluginId = $state<string | null>(null);
  let closingPlugin = $state(false);
  let islandCollapseTimer: ReturnType<typeof setTimeout> | undefined;
  let panelCloseTimer: ReturnType<typeof setTimeout> | undefined;
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
    if (!collapsed) expandedSize = size;
    // A collapsed handle must not overwrite the size to restore on hover.
    void sidebarRelayout(expandedSize.width, expandedSize.height);
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
      const events: RingEvent[] = animate && thKey === prevThresholds ? detectRingEvents(prevLevels, next) : [];
      prevLevels = next;
      prevThresholds = thKey;
      if (events.length === 0) return;
      for (const e of events) fx[e.key] = { kind: e.kind, id: ++fxSeq };
      clearTimeout(fxTimer);
      fxTimer = setTimeout(() => (fx = {}), 1000);
    });
  });

  onMount(() => {
    const disposers: Array<() => void> = [settings.init(), snapshot.init()];
    let un: Unlisten | null = null;
    let disposed = false;
    void onSidebarState((state) => {
      expanded = state.expanded;
      if (!state.pinned) pinnedKey = null;
    }).then((u) => (disposed ? u() : (un = u)));
    return () => {
      disposed = true;
      un?.();
      clearTimeout(fxTimer);
      clearTimeout(islandCollapseTimer);
      clearTimeout(panelCloseTimer);
      clearTimeout(suppressRingTimer);
      disposers.forEach((d) => d());
    };
  });

  // theme / scale / opacity / language follow the settings rune
  $effect(() => applyTheme(settings.value));

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
    islandExpanded = true;
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
      // The ring the bubble points at is about to disappear (the idle island
      // only shows the summary), so a pinned bubble must not be left floating.
      pinnedKey = null;
      void popoverHide();
    }, delay);
  }

  function onStageEnter() {
    stageHovered = true;
    if (island && islandIdle) {
      suppressRingHover = true;
      clearTimeout(suppressRingTimer);
      suppressRingTimer = setTimeout(() => (suppressRingHover = false), 500);
    }
    expandIsland();
    reportHover(true);
  }

  function onStageLeave() {
    stageHovered = false;
    scheduleIslandCollapse();
    reportHover(false);
  }

  function onStageFocusIn(ev: FocusEvent) {
    const target = ev.target;
    stageKeyboardFocus = target instanceof HTMLElement && target.matches(':focus-visible');
    if (island && islandIdle) {
      suppressRingHover = true;
      clearTimeout(suppressRingTimer);
      suppressRingTimer = setTimeout(() => (suppressRingHover = false), 500);
    }
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

  function requestPopover(item: RingItem, el: HTMLElement) {
    const anchor = anchorOf(el);
    void popoverShow({
      provider: item.quotaKey,
      ringIndex: item.index,
      // Both axes travel; the platform layer uses the one along the bar.
      anchorY: anchor.y,
      anchorX: anchor.x,
      windowKind: item.labelWindow?.kind ?? null,
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

{#snippet pillContent()}
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
  {:else if islandIdle && islandSummary}
    <!-- idle island: one ring for the busiest provider, so the capsule stays
         small until the pointer or keyboard asks for the full row -->
    <div class="summary" aria-label={t('island.summary')}>
      {@render ringView(islandSummary)}
      {#if items.length > 1}
        <span class="more-count" aria-label={t('island.providerCount', { count: items.length - 1 })}>
          +{items.length - 1}
        </span>
      {/if}
    </div>
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
    {#if s.sidebarItems.moreButton}
      <button class="dots" onclick={() => void openDashboard('overview')} ondblclick={(e) => e.stopPropagation()} aria-label={t('sidebar.more')}>⋯</button>
    {/if}
  {/if}

  {#if island && !islandIdle && !loading}
    <div class="island-tools" role="toolbar" aria-label={t('island.pluginRail')}>
      {#each ISLAND_PLUGINS as plugin, i (plugin.id)}
        {@const active = activePluginId === plugin.id}
        <button
          type="button"
          class="tool"
          class:active
          style={`--i:${i}`}
          aria-pressed={active}
          aria-label={tDyn(plugin.label)}
          title={active ? `${tDyn(plugin.label)} — ${t('island.closePanel')}` : tDyn(plugin.label)}
          onclick={(e) => {
            e.stopPropagation();
            togglePlugin(plugin.id);
          }}
          ondblclick={(e) => e.stopPropagation()}
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d={plugin.icon}></path>
          </svg>
          {#if plugin.id === 'mail' && attention.mailUnread > 0}
            <span class="tool-badge" aria-hidden="true">{attention.mailUnread > 9 ? '9+' : attention.mailUnread}</span>
          {:else if plugin.id === 'calendar' && attention.calendarSoon}
            <span class="tool-dot" aria-hidden="true"></span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}

{/snippet}

<div
  class="stage"
  data-edge={island ? 'top' : s.edge}
  data-island={island ? 'true' : undefined}
  use:observeSize={reportSize}
  oncontextmenu={(e) => e.preventDefault()}
  onmouseenter={onStageEnter}
  onmouseleave={onStageLeave}
  onfocusin={onStageFocusIn}
  onfocusout={onStageFocusOut}
  onmousemove={heartbeat}
  role="presentation"
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
        ondblclick={() => void openDashboard('overview')}
        role="presentation"
      >
        {@render pillContent()}
      </div>
      {#if activePlugin && !islandIdle && !loading}
        {@const PluginPanel = activePlugin.component}
        <section class="island-panel surface" class:closing={closingPlugin} aria-label={tDyn(activePlugin.label)}>
          <PluginPanel close={closePlugin} />
        </section>
      {/if}
    </div>
  {:else}
    <div class="pill surface" class:compact use:dragHandle={onDrag} ondblclick={() => void openDashboard('overview')} role="presentation">
      {@render pillContent()}
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

  .dots {
    position: relative;
    display: block;
    width: 100%;
    border-radius: 0.25rem;
    margin-top: -0.375rem;
    padding: 0;
    font-size: 1rem;
    line-height: 0.6;
    color: var(--faint);
    letter-spacing: 0.1em;
    transition: color var(--dur-ui) var(--ease-out);
  }

  .dots:hover {
    color: var(--text);
  }

  /* The glyph is ~10px tall; an invisible box makes the target at least 24px
     without moving anything. In a column it grows downwards, into the pill's
     bottom padding, so it never covers the ring above. */
  .dots::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    width: max(100%, 24px);
    height: max(1.5rem, 24px);
  }

  /* In a row the dots sit beside the last ring instead of under it; the
     negative margin keeps them tucked against the group either way. */
  .stage[data-edge='top'] .dots,
  .stage[data-edge='bottom'] .dots {
    width: auto;
    align-self: center;
    margin-top: 0;
    margin-left: -0.375rem;
  }

  /* in a row it grows to the right, centred on the glyph's line */
  .stage[data-edge='top'] .dots::before,
  .stage[data-edge='bottom'] .dots::before {
    top: 50%;
    transform: translateY(-50%);
  }

  /* ---- dynamic island -------------------------------------------------
     Same surface material, but a free-floating capsule: no flush edge, full
     rounding. A plugin panel is a sibling surface below it (`.island-shell`),
     never a child of the pill: a full-width flex child inside a max-content
     pill would otherwise drag the capsule out to the panel's width. The
     window is measured after every state change, so these transitions are
     visible inside the content while Rust re-centres the window. */
  .stage[data-island] .pill.island {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    min-width: 6.5rem;
    min-height: calc(var(--ring-size) + 2 * var(--bar-padding));
    padding: var(--bar-padding) calc(var(--bar-padding) + 0.35rem);
    gap: calc(var(--bar-gap) * 0.55);
    border: 1px solid var(--bar-border);
    border-radius: 999px;
    box-shadow: var(--bar-shadow), 0 18px 46px -20px rgb(0 0 0 / 0.55);
    transform-origin: 50% 0;
    will-change: transform;
    transition:
      border-radius 320ms var(--ease-out),
      padding 220ms var(--ease-out),
      gap 220ms var(--ease-out),
      box-shadow 220ms var(--ease-out);
  }

  /* The jelly is deliberately a content-transform, not a window resize: Rust
     re-centres the window from the measured box, and the capsule overshoots
     inside it. Fill mode is left at `none` so the resting transform is always
     identity, never a stuck keyframe. */
  .stage[data-island] .pill.island.island-open {
    animation: island-open-jelly 520ms cubic-bezier(0.22, 1.35, 0.36, 1);
  }

  .stage[data-island] .pill.island.compact {
    min-width: 0;
    min-height: 0;
    gap: 0.75rem;
    padding: 0.625rem 0.5rem;
  }

  /* Idle: one summary ring, tighter padding, still a capsule. This class is
     toggled by hover/focus, not by the Rust auto-hide state machine. */
  .stage[data-island] .pill.island.island-idle {
    min-width: 5.5rem;
    padding: calc(var(--bar-padding) * 0.6) calc(var(--bar-padding) * 0.9);
    gap: 0;
    animation: island-idle-jelly 380ms cubic-bezier(0.22, 1.3, 0.36, 1);
  }

  .island-shell {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: max-content;
    gap: 0.45rem;
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
    display: flex;
    align-self: stretch;
    align-items: center;
    gap: 0.125rem;
    margin-left: 0.1rem;
    padding-left: 0.45rem;
    border-left: 1px solid var(--border);
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
    animation: island-tool-pop 300ms cubic-bezier(0.2, 1.5, 0.4, 1) backwards;
    animation-delay: calc(var(--i, 0) * 18ms);
    transition:
      transform 220ms cubic-bezier(0.2, 1.5, 0.4, 1),
      background var(--dur-ui) var(--ease-out),
      color var(--dur-ui) var(--ease-out),
      box-shadow 220ms var(--ease-out);
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
    padding: 0.55rem 0.7rem;
    border-radius: calc(var(--r-pill) + 2px);
    transform-origin: 50% 0;
    animation: island-panel-in 420ms cubic-bezier(0.2, 1.35, 0.35, 1);
  }

  .island-panel.closing {
    animation: island-panel-out 170ms cubic-bezier(0.4, 0, 0.8, 0.4) both;
    pointer-events: none;
  }

  @keyframes island-open-jelly {
    0% {
      transform: scale(0.94, 0.84);
    }
    36% {
      transform: scale(1.02, 1.05);
    }
    58% {
      transform: scale(0.99, 0.985);
    }
    79% {
      transform: scale(1.006, 1.006);
    }
    100% {
      transform: scale(1);
    }
  }

  @keyframes island-idle-jelly {
    0% {
      transform: scale(1);
    }
    30% {
      transform: scale(0.96, 0.9);
    }
    62% {
      transform: scale(1.015, 1.02);
    }
    100% {
      transform: scale(1);
    }
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
