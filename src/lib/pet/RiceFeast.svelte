<!--
  DeepSeek 大肥鱼 eating a bowl of white rice. [FRONTEND]

  The character is the supplied feed card with its flat background cut away
  (`deepseek-chibi-rice.webp`, produced by scripts/prepare-pet-assets.py). The
  motion is pure CSS: the whole figure munches, steam curls off the bowl, and
  eight grains arc from the bowl into the open mouth. No video, no canvas and
  no runtime generation, so the loop stays sharp at every window scale and
  stops completely under `prefers-reduced-motion`.

  The overlay coordinates are percentages of the original 512 × 512 card:
  bowl at ~19 % / 32 %, mouth at ~48 % / 52 %.
-->
<script lang="ts">
  interface Props {
    /** Play the loop; when false only the cutout is drawn. */
    active?: boolean;
    /** Accessible description, normally "… is eating a bowl of rice". */
    label: string;
    /** Where the character art comes from; the panel and the desktop differ. */
    src?: string;
  }

  let {
    active = true,
    label,
    src = '/pet/deepseek-chibi-rice.webp',
  }: Props = $props();

  const GRAINS = Array.from({ length: 8 }, (_, index) => index);
</script>

<div class="feast" class:active role="img" aria-label={label} data-testid="rice-feast">
  <span class="warmth" aria-hidden="true"></span>
  <img class="rice-fish" {src} alt="" draggable="false" />

  <span class="steam" aria-hidden="true">
    <i></i><i></i><i></i>
  </span>

  <span class="grains" aria-hidden="true">
    {#each GRAINS as grain (grain)}
      <i style:--i={grain}></i>
    {/each}
  </span>

  <span class="sparkles" aria-hidden="true">
    <i></i><i></i><i></i>
  </span>
</div>

<style>
  .feast {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
    aspect-ratio: 1;
    isolation: isolate;
  }

  .rice-fish {
    position: absolute;
    inset: 0;
    z-index: 1;
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    filter: drop-shadow(0 0.18rem 0.3rem rgb(8 18 34 / 0.24));
    transform-origin: 50% 74%;
    user-select: none;
    -webkit-user-drag: none;
  }

  .active .rice-fish {
    animation: rice-munch 860ms cubic-bezier(0.42, 0, 0.38, 1) infinite;
  }

  /* A warm pool of light behind the bowl makes the feast read as a moment. */
  .warmth {
    position: absolute;
    top: 6%;
    left: 3%;
    z-index: 0;
    width: 82%;
    height: 72%;
    border-radius: 50%;
    background: radial-gradient(
      circle at 30% 48%,
      rgb(255 226 160 / 0.34),
      rgb(255 182 108 / 0.12) 46%,
      transparent 70%
    );
    opacity: 0;
    transform: scale(0.9);
  }

  .active .warmth {
    animation: rice-warmth 2.6s ease-in-out infinite;
  }

  /* Steam: three soft wisps above the rice mound. */
  .steam {
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
  }

  .steam i {
    position: absolute;
    top: 26%;
    width: 7%;
    height: 17%;
    border-radius: 50%;
    background: linear-gradient(to top, rgb(255 255 255 / 0), rgb(255 255 255 / 0.72));
    filter: blur(0.08rem);
    opacity: 0;
    transform-origin: 50% 100%;
  }

  .steam i:nth-child(1) {
    left: 11%;
  }

  .steam i:nth-child(2) {
    left: 18%;
    height: 21%;
  }

  .steam i:nth-child(3) {
    left: 25%;
    height: 14%;
  }

  .active .steam i {
    animation: rice-steam 2.8s ease-out infinite;
  }

  .active .steam i:nth-child(2) {
    animation-delay: 0.65s;
  }

  .active .steam i:nth-child(3) {
    animation-delay: 1.3s;
  }

  /* Rice grains arc from the bowl to the mouth. `left`/`top` animate so the
     path keeps its shape at every container size. */
  .grains {
    position: absolute;
    inset: 0;
    z-index: 3;
    pointer-events: none;
  }

  .grains i {
    position: absolute;
    top: 33%;
    left: 19%;
    width: 4.2%;
    height: 2.5%;
    border-radius: 50% 45% 55% 50%;
    background: #fffdf4;
    box-shadow:
      0 0 0 0.5px rgb(112 92 54 / 0.28),
      0 0.04rem 0.08rem rgb(24 32 48 / 0.22);
    opacity: 0;
    transform: translate(-50%, -50%);
  }

  .active .grains i {
    animation: rice-grain 1.7s cubic-bezier(0.42, 0.02, 0.58, 0.98) infinite;
    animation-delay: calc(var(--i) * 0.2125s);
  }

  /* Sparkles by the bowl, the supplied card's own little glints brought to
     life rather than a new decoration. */
  .sparkles {
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
  }

  .sparkles i {
    position: absolute;
    width: 5.6%;
    height: 5.6%;
    background: #ffd76a;
    clip-path: polygon(
      50% 0%,
      61% 35%,
      98% 35%,
      68% 57%,
      79% 91%,
      50% 70%,
      21% 91%,
      32% 57%,
      2% 35%,
      39% 35%
    );
    filter: drop-shadow(0 0 0.1rem rgb(255 200 80 / 0.85));
    opacity: 0;
    transform: scale(0.4) rotate(0deg);
  }

  .sparkles i:nth-child(1) {
    top: 20%;
    left: 12%;
  }

  .sparkles i:nth-child(2) {
    top: 15%;
    left: 7%;
    width: 3.8%;
    height: 3.8%;
  }

  .sparkles i:nth-child(3) {
    top: 28%;
    left: 5%;
    width: 3%;
    height: 3%;
  }

  .active .sparkles i {
    animation: rice-sparkle 2.1s ease-in-out infinite;
  }

  .active .sparkles i:nth-child(2) {
    animation-delay: 0.45s;
  }

  .active .sparkles i:nth-child(3) {
    animation-delay: 1.1s;
  }

  @keyframes rice-munch {
    0%,
    100% {
      transform: translateY(0) scale(1) rotate(0deg);
    }
    18% {
      transform: translateY(-1.8%) scale(1.012, 0.992) rotate(-0.35deg);
    }
    36% {
      transform: translateY(0) scale(0.994, 1.008) rotate(0.3deg);
    }
    54% {
      transform: translateY(-1.2%) scale(1.008, 0.996) rotate(-0.2deg);
    }
    72% {
      transform: translateY(0) scale(1, 1.004) rotate(0deg);
    }
  }

  @keyframes rice-steam {
    0% {
      opacity: 0;
      transform: translateY(12%) scale(0.65) rotate(-4deg);
    }
    24% {
      opacity: 0.8;
    }
    100% {
      opacity: 0;
      transform: translateY(-96%) scale(1.28) rotate(7deg);
    }
  }

  @keyframes rice-grain {
    0% {
      top: 33%;
      left: 19%;
      opacity: 0;
      transform: translate(-50%, -50%) scale(0.55) rotate(0deg);
    }
    8% {
      opacity: 1;
    }
    46% {
      top: 26.5%;
      left: 36%;
      opacity: 1;
      transform: translate(-50%, -50%) scale(1) rotate(120deg);
    }
    82% {
      opacity: 1;
    }
    100% {
      top: 52%;
      left: 48%;
      opacity: 0;
      transform: translate(-50%, -50%) scale(0.72) rotate(250deg);
    }
  }

  @keyframes rice-sparkle {
    0%,
    100% {
      opacity: 0;
      transform: scale(0.35) rotate(0deg);
    }
    40% {
      opacity: 1;
      transform: scale(1) rotate(22deg);
    }
    70% {
      opacity: 0.55;
      transform: scale(0.82) rotate(34deg);
    }
  }

  @keyframes rice-warmth {
    0%,
    100% {
      opacity: 0.45;
      transform: scale(0.92);
    }
    50% {
      opacity: 0.8;
      transform: scale(1.02);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .active .rice-fish,
    .active .steam i,
    .active .grains i,
    .active .sparkles i,
    .active .warmth {
      animation: none;
    }

    .active .warmth {
      opacity: 0.55;
    }

    .steam i,
    .grains i,
    .sparkles i {
      display: none;
    }
  }
</style>
