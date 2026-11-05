<!--
  Frame player for an imported DyberPet pack. [FRONTEND]

  The Rust importer already resolved the manifest; this component owns only
  timing. Each act repeats its frame list `actNum` times (DyberPet's own
  convention), then the next act in a sequence starts. In `idle` mode a new
  random act is drawn with DyberPet's per-tier probabilities; every other mode
  is a stable loop (`pat` is one shot). Frames are plain `<img>` URLs served by
  the Tauri asset protocol, so packs never pass through JavaScript.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { assetUrl } from '$lib/api';
  import {
    chooseRandomAct,
    frameIndexAt,
    packFramePath,
    packIdlePose,
    packPose,
    type PackMode,
    type PetPack,
    type PetPackAct,
  } from './pack';

  let {
    pack,
    mode,
    fullness,
    level = 1,
    direction = 1,
    active = true,
  }: {
    pack: PetPack;
    mode: PackMode;
    fullness: number;
    level?: number;
    /** 1 = right, -1 = left; only used by walk mode. */
    direction?: number;
    /** false freezes the idle frame (window hidden or reduced motion). */
    active?: boolean;
  } = $props();

  /** A quiet beat between idle acts; DyberPet runs them back to back. */
  const IDLE_GAP_MS = 700;

  let frame = $state(0);
  // The effect below re-plans whenever `pack` changes, so these initial values
  // only cover the first paint (and the parent only renders this after the
  // manifest has loaded).
  // svelte-ignore state_referenced_locally
  let act = $state<PetPackAct>(packIdlePose(pack).act);
  let mirror = $state(false);
  let reduceMotion = $state(false);

  // svelte-ignore state_referenced_locally
  let plan: { acts: PetPackAct[]; loop: boolean; idle: boolean } = {
    acts: [packIdlePose(pack).act],
    loop: true,
    idle: false,
  };
  let actIndex = 0;
  let actStartedAt = 0;
  let ticker = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const currentFrame = $derived(
    act.frames[Math.min(frame, act.frames.length - 1)] ?? act.frames[0]
  );
  const frameUrl = $derived(assetUrl(packFramePath(pack, currentFrame)));

  function stepMs(value: PetPackAct): number {
    return Math.max(40, value.frameRefresh * 1000);
  }

  function durationMs(value: PetPackAct): number {
    return value.frames.length * Math.max(1, Math.round(value.actNum)) * stepMs(value);
  }

  function preload(acts: PetPackAct[]): void {
    let budget = 80;
    for (const item of acts) {
      for (const file of item.frames) {
        if (budget-- <= 0) return;
        const image = new Image();
        image.decoding = 'async';
        image.src = assetUrl(packFramePath(pack, file));
      }
    }
  }

  function cancelTimers(): void {
    if (ticker !== 0) {
      cancelAnimationFrame(ticker);
      ticker = 0;
    }
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function schedule(): void {
    if (ticker === 0 && !disposed) ticker = requestAnimationFrame(tick);
  }

  function startPlan(
    acts: PetPackAct[],
    loop: boolean,
    idle: boolean,
    mirrored: boolean
  ): void {
    cancelTimers();
    const list = acts.length > 0 ? acts : [packIdlePose(pack).act];
    plan = { acts: list, loop, idle };
    actIndex = 0;
    act = list[0];
    frame = 0;
    mirror = mirrored;
    actStartedAt = performance.now();
    preload(list);
    schedule();
  }

  function pickIdle(): void {
    if (disposed || !active || reduceMotion) return;
    const names = chooseRandomAct(
      pack,
      untrack(() => fullness),
      Math.max(0, untrack(() => level) - 1)
    );
    const acts = (names ?? [])
      .map((name) => pack.acts[name])
      .filter((entry): entry is PetPackAct => !!entry);
    if (acts.length === 0) acts.push(packIdlePose(pack).act);
    startPlan(acts, false, true, false);
  }

  function finishIdle(): void {
    frame = Math.min(frame, act.frames.length - 1);
    scheduleIdleGap();
  }

  function scheduleIdleGap(): void {
    cancelTimers();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      pickIdle();
    }, IDLE_GAP_MS);
  }

  function tick(now: number): void {
    ticker = 0;
    if (disposed) return;
    if (reduceMotion || !active) {
      frame = 0;
      return;
    }
    const elapsed = now - actStartedAt;
    if (elapsed >= durationMs(act)) {
      if (actIndex + 1 < plan.acts.length) {
        actIndex += 1;
        act = plan.acts[actIndex];
        frame = 0;
        actStartedAt = now;
        schedule();
        return;
      }
      if (plan.loop) {
        actIndex = 0;
        act = plan.acts[0];
        frame = 0;
        actStartedAt = now;
        schedule();
        return;
      }
      if (plan.idle) {
        finishIdle();
        return;
      }
      // One-shot (pat): rest on the final frame until the parent changes mode.
      frame = act.frames.length - 1;
      return;
    }
    const next = frameIndexAt(act, elapsed, true);
    if (next !== null && next !== frame) frame = next;
    schedule();
  }

  function reset(): void {
    cancelTimers();
    if (!active || reduceMotion) {
      const idle = packIdlePose(pack);
      plan = { acts: [idle.act], loop: true, idle: false };
      act = idle.act;
      frame = 0;
      mirror = false;
      return;
    }
    if (mode === 'idle') {
      pickIdle();
      return;
    }
    const pose = packPose(pack, mode, untrack(() => fullness), direction);
    startPlan([pose.act], mode !== 'pat', false, pose.mirror);
  }

  onMount(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (query) {
      reduceMotion = query.matches;
      const onChange = (event: MediaQueryListEvent) => {
        reduceMotion = event.matches;
      };
      query.addEventListener?.('change', onChange);
      return () => {
        disposed = true;
        cancelTimers();
        query.removeEventListener?.('change', onChange);
      };
    }
    return () => {
      disposed = true;
      cancelTimers();
    };
  });

  $effect(() => {
    // Re-plan only when the displayed pose can change. Fullness and level are
    // read untracked inside `pickIdle`, so the 30 s need tick does not restart
    // the current animation.
    void pack;
    void mode;
    void active;
    void direction;
    void reduceMotion;
    untrack(reset);
  });
</script>

<div class="pack-sprite" class:mirror aria-hidden="true">
  <img src={frameUrl} alt="" draggable="false" decoding="async" />
</div>

<style>
  .pack-sprite {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    width: 100%;
    height: 100%;
    transform-origin: 50% 100%;
    pointer-events: none;
  }

  .mirror {
    transform: scaleX(-1);
  }

  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    pointer-events: none;
    user-select: none;
    -webkit-user-drag: none;
  }
</style>
