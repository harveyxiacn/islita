<!--
  The detached pet's rice bowl. [FRONTEND]

  The island panel gets the full cutscene (RiceFeast); the small transparent
  desktop window gets a prop instead: a bowl at the pet's feet, steam, and a
  few grains rising towards its mouth while it chews. Nothing here is
  interactive and nothing blocks the pet's own pointer handling.
-->
<script lang="ts">
  interface Props {
    active?: boolean;
    label: string;
  }

  let { active = true, label }: Props = $props();
  const GRAINS = Array.from({ length: 6 }, (_, index) => index);
</script>

<div
  class="desktop-feast"
  class:active
  role="img"
  aria-label={label}
  data-testid="desktop-feast"
>
  <span class="steam" aria-hidden="true"><i></i><i></i><i></i></span>

  <svg class="bowl" viewBox="0 0 64 54" aria-hidden="true">
    <path
      class="rice"
      d="M12 20c1.4-7.6 8.7-12 20-12s18.6 4.4 20 12Z"
    />
    <path class="grain" d="M21 13.5c1.3-1 3-1.3 4.4-.7M31 9.8c1.4-.8 3-.7 4.2.1M40 13.2c1.2-.7 2.7-.6 3.8.2" />
    <path class="rim" d="M9.5 20h45" />
    <path class="body" d="M10 20h44c0 16.5-9.1 27-22 27S10 36.5 10 20Z" />
    <path class="line" d="M24 43.5h16" />
    <path class="shine" d="M18.5 24.5c1.2 8 5.2 14.5 11.5 18.5" />
    <path class="whale" d="M45 30.5c-1.6-2.4-5.6-2.4-7.2 0 1.6 2.4 5.6 2.4 7.2 0Zm0 0 2.2-1.6m-2.2 1.6 2.2 1.6" />
  </svg>

  <span class="grains" aria-hidden="true">
    {#each GRAINS as grain (grain)}
      <i style:--i={grain}></i>
    {/each}
  </span>
</div>

<style>
  .desktop-feast {
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
    opacity: 0;
    transition: opacity 180ms ease-out;
  }

  .desktop-feast.active {
    opacity: 1;
  }

  .bowl {
    position: absolute;
    bottom: 3%;
    left: 2%;
    width: 4.7rem;
    height: auto;
    overflow: visible;
    filter: drop-shadow(0 0.2rem 0.3rem rgb(0 0 0 / 0.28));
    transform-origin: 50% 90%;
  }

  .active .bowl {
    animation: bowl-bob 1.6s ease-in-out infinite;
  }

  .rice {
    fill: #fffdf4;
  }

  .grain {
    fill: none;
    stroke: #e6dcc2;
    stroke-width: 1.2;
    stroke-linecap: round;
  }

  .rim {
    fill: none;
    stroke: #6a8dbd;
    stroke-width: 2.2;
    stroke-linecap: round;
  }

  .body {
    fill: #eef5ff;
    stroke: #5b7fb5;
    stroke-width: 2.2;
    stroke-linejoin: round;
  }

  .line {
    fill: none;
    stroke: #5b7fb5;
    stroke-width: 1.8;
    stroke-linecap: round;
    opacity: 0.55;
  }

  .shine {
    fill: none;
    stroke: #c9dcf3;
    stroke-width: 2;
    stroke-linecap: round;
  }

  .whale {
    fill: none;
    stroke: #5b7fb5;
    stroke-width: 1.3;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.7;
  }

  .steam {
    position: absolute;
    bottom: 34%;
    left: 8%;
    width: 3.4rem;
    height: 3.6rem;
    pointer-events: none;
  }

  .steam i {
    position: absolute;
    bottom: 0;
    width: 0.55rem;
    height: 1.5rem;
    border-radius: 50%;
    background: linear-gradient(to top, rgb(255 255 255 / 0), rgb(255 255 255 / 0.7));
    filter: blur(0.08rem);
    opacity: 0;
  }

  .steam i:nth-child(1) {
    left: 12%;
  }

  .steam i:nth-child(2) {
    left: 42%;
    height: 1.85rem;
  }

  .steam i:nth-child(3) {
    left: 72%;
    height: 1.25rem;
  }

  .active .steam i {
    animation: snack-steam 2.6s ease-out infinite;
  }

  .active .steam i:nth-child(2) {
    animation-delay: 0.7s;
  }

  .active .steam i:nth-child(3) {
    animation-delay: 1.35s;
  }

  .grains {
    position: absolute;
    inset: 0;
  }

  .grains i {
    position: absolute;
    top: 82%;
    left: 20%;
    width: 0.24rem;
    height: 0.15rem;
    border-radius: 50% 45% 55% 50%;
    background: #fffdf4;
    box-shadow:
      0 0 0 0.5px rgb(112 92 54 / 0.3),
      0 1px 1px rgb(0 0 0 / 0.22);
    opacity: 0;
  }

  .active .grains i {
    animation: snack-grain 1.6s cubic-bezier(0.42, 0.02, 0.58, 0.98) infinite;
    animation-delay: calc(var(--i) * 0.24s);
  }

  @keyframes bowl-bob {
    0%,
    100% {
      transform: translateY(0) rotate(-1deg);
    }
    50% {
      transform: translateY(-1.5px) rotate(1.2deg);
    }
  }

  @keyframes snack-steam {
    0% {
      opacity: 0;
      transform: translateY(10%) scale(0.7);
    }
    25% {
      opacity: 0.75;
    }
    100% {
      opacity: 0;
      transform: translateY(-95%) scale(1.2);
    }
  }

  @keyframes snack-grain {
    0% {
      top: 82%;
      left: 20%;
      opacity: 0;
      transform: scale(0.55) rotate(0deg);
    }
    10% {
      opacity: 1;
    }
    52% {
      top: 62%;
      left: 38%;
      opacity: 1;
      transform: scale(1) rotate(130deg);
    }
    100% {
      top: 51%;
      left: 50%;
      opacity: 0;
      transform: scale(0.7) rotate(250deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .active .bowl,
    .active .steam i,
    .active .grains i {
      animation: none;
    }

    .steam i,
    .grains i {
      display: none;
    }
  }
</style>
