<!--
  DeepSeek 大肥鱼 animation player. [FRONTEND]

  One H3 performance is stored as a horizontal strip of 60 transparent WebP
  cells (12 fps). The frame is advanced with a small rAF loop instead of CSS
  `steps()` so the strip stays aligned at every container size, and a poster
  frame covers the moment before the strip decodes. Reduced motion, or a
  missing strip, leaves the poster in place.

  The same component drives the island panel and the detached desktop window;
  the character is transparent so the desktop keeps its wallpaper.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    PET_ANIMATION_FRAMES,
    animationFps,
    animationPoster,
    animationSrc,
    type PetAnimation,
  } from './animations';

  interface Props {
    /** Which performance to play. */
    clip: PetAnimation;
    /** Run the loop; when false the first frame is held. */
    active?: boolean;
    /** Accessible description, normally "… is walking." */
    label: string;
    /** Play once and hold the final frame (jump). */
    once?: boolean;
  }

  let { clip, active = true, label, once = false }: Props = $props();

  let frame = $state(0);
  let reduced = $state(false);
  let failed = $state(false);
  let loaded = $state(false);

  const frames = PET_ANIMATION_FRAMES;
  const fps = $derived(animationFps(clip));

  onMount(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduced = query.matches;
    const change = () => (reduced = query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  });

  // A new clip starts from its first frame and waits for its own strip. This
  // runs before the DOM swaps `src`, so a cached image cannot fire `onload`
  // and then be reset to "not loaded" by a later effect.
  $effect.pre(() => {
    clip;
    loaded = false;
    failed = false;
    frame = 0;
  });

  $effect(() => {
    if (!active || reduced || failed || !loaded || frames < 2) {
      if (!active) frame = 0;
      return;
    }
    const period = 1000 / fps;
    let raf = 0;
    let start = performance.now();
    let last = -1;
    const tick = (now: number) => {
      const elapsed = Math.floor((now - start) / period);
      const next = once ? Math.min(elapsed, frames - 1) : elapsed % frames;
      if (next !== last) {
        last = next;
        frame = next;
      }
      if (once && next >= frames - 1) return;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });
</script>

<span
  class="film"
  class:ready={loaded && !failed}
  role="img"
  aria-label={label}
  data-testid="pet-film"
  data-kind={reduced || failed ? 'still' : 'film'}
  data-clip={clip}
  data-src={reduced || failed ? animationPoster(clip) : animationSrc(clip)}
  style:--frames={frames}
>
  {#if reduced || failed}
    <img class="still" src={animationPoster(clip)} alt="" draggable="false" />
  {:else}
    <span class="window" aria-hidden="true">
      <img class="poster" src={animationPoster(clip)} alt="" draggable="false" />
      <img
        class="sheet"
        src={animationSrc(clip)}
        alt=""
        draggable="false"
        style:transform={`translateX(${(-frame * 100) / frames}%)`}
        onload={() => (loaded = true)}
        onerror={() => (failed = true)}
      />
    </span>
  {/if}
</span>

<style>
  .film {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    aspect-ratio: 1;
    isolation: isolate;
  }

  .window {
    position: absolute;
    inset: 0;
    display: block;
    overflow: hidden;
    filter: drop-shadow(0 0.18rem 0.3rem rgb(8 18 34 / 0.24));
  }

  .poster,
  .sheet,
  .still {
    display: block;
    width: 100%;
    height: 100%;
    user-select: none;
    -webkit-user-drag: none;
  }

  .poster {
    position: absolute;
    inset: 0;
    object-fit: contain;
  }

  .sheet {
    position: absolute;
    top: 0;
    left: 0;
    width: calc(var(--frames) * 100%);
    max-width: none;
    object-fit: fill;
    opacity: 0;
    will-change: transform;
  }

  .film.ready .sheet {
    opacity: 1;
  }

  .still {
    object-fit: contain;
    filter: drop-shadow(0 0.18rem 0.3rem rgb(8 18 34 / 0.24));
  }
</style>
