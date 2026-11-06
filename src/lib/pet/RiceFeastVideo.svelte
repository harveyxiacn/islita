<!--
  DeepSeek 大肥鱼 rice feast, generated with MiniMax H3. [FRONTEND]

  The island panel is wide enough for the landscape clip: a 5.2 s loop made
  from the owner-supplied chibi card with H3 image-to-video. It is muted and
  decorative; the accessible description lives on the wrapper. If the WebView
  cannot decode VP9/H.264, or the user prefers reduced motion, the pure-CSS
  `RiceFeast` cutout takes over so the moment never breaks.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import RiceFeast from './RiceFeast.svelte';

  interface Props {
    /** Play the loop; the panel only mounts this while the feast is showing. */
    active?: boolean;
    /** Accessible description, normally "… is eating a bowl of rice". */
    label: string;
    poster?: string;
  }

  let {
    active = true,
    label,
    poster = '/pet/deepseek-feast-poster.webp',
  }: Props = $props();

  let failed = $state(false);
  let reduced = $state(false);
  let ready = $state(false);
  let video = $state<HTMLVideoElement>();

  onMount(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduced = query.matches;
    const change = () => (reduced = query.matches);
    query.addEventListener('change', change);
    const timer = setTimeout(() => {
      if (!ready) failed = true;
    }, 4000);
    return () => {
      query.removeEventListener('change', change);
      clearTimeout(timer);
    };
  });

  $effect(() => {
    if (!video) return;
    if (active) {
      void video.play().catch(() => {
        failed = true;
      });
    } else {
      video.pause();
    }
  });
</script>

{#if failed || reduced}
  <RiceFeast active={active && !reduced} {label} />
{:else}
  <span
    class="cinema"
    class:ready
    role="img"
    aria-label={label}
    data-testid="rice-feast"
    data-kind="video"
  >
    <span class="window">
      <video
        bind:this={video}
        class="clip"
        autoplay
        muted
        loop
        playsinline
        preload="auto"
        {poster}
        aria-hidden="true"
        tabindex="-1"
        disablepictureinpicture
        onplaying={() => (ready = true)}
        onerror={() => (failed = true)}
      >
        <source src="/pet/deepseek-feast.webm" type="video/webm" />
        <source src="/pet/deepseek-feast.mp4" type="video/mp4" />
      </video>
      <span class="sheen" aria-hidden="true"></span>
    </span>
  </span>
{/if}

<style>
  .cinema {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    aspect-ratio: 1;
    filter: drop-shadow(0 0.35rem 0.75rem rgb(0 0 0 / 0.34));
    opacity: 0;
    transition: opacity 180ms ease-out;
  }

  .cinema.ready {
    opacity: 1;
  }

  /* A soft oval mask drops the rectangular video edges into the pet scene;
     the character stays centred while the deep-sea plate fades out. */
  .window {
    position: absolute;
    inset: 0;
    display: block;
    overflow: hidden;
    border-radius: 0.85rem;
    background: #06131f;
    -webkit-mask-image: radial-gradient(
      ellipse 76% 76% at 50% 56%,
      #000 56%,
      transparent 82%
    );
    mask-image: radial-gradient(ellipse 76% 76% at 50% 56%, #000 56%, transparent 82%);
  }

  .clip {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: 50% 56%;
  }

  .sheen {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: radial-gradient(
      ellipse at 50% 64%,
      transparent 48%,
      rgb(3 10 18 / 0.24) 100%
    );
  }

  @media (prefers-reduced-motion: reduce) {
    .cinema {
      display: none;
    }
  }
</style>
