<!--
  Sleeping "zzz" for the DeepSeek fish. [FRONTEND]

  H3 cannot reliably draw text, so the ZZZ is a DOM overlay: three Z letters
  and a 💤 rise from the character on a slow loop. It is decorative, hidden
  from assistive tech, and held still when the user prefers reduced motion.
-->
<script lang="ts">
  interface Props {
    /** Only draw while the fish is actually asleep. */
    active?: boolean;
  }

  let { active = true }: Props = $props();
</script>

{#if active}
  <span class="zzz" aria-hidden="true" data-testid="pet-zzz">
    <span class="z z1">Z</span>
    <span class="z z2">Z</span>
    <span class="z z3">Z</span>
  </span>
{/if}

<style>
  .zzz {
    position: absolute;
    top: 0;
    right: 0;
    width: 44%;
    height: 48%;
    container-type: size;
    pointer-events: none;
    z-index: 3;
    filter: drop-shadow(0 0.08rem 0.16rem rgb(8 18 34 / 0.28));
  }

  .z {
    position: absolute;
    font-weight: 800;
    line-height: 1;
    color: #eaf4ff;
    -webkit-text-stroke: 0.09em #2b6cb0;
    paint-order: stroke fill;
    opacity: 0;
    animation: rise 2.6s ease-in-out infinite;
  }

  /* cqw keeps the letters tied to the film, which is 13.4rem on the desktop
     and 7.8rem in the island panel; percentage font sizes would be relative
     to the inherited text size instead and shrink to a few pixels. */
  .z1 {
    left: 4%;
    bottom: 14%;
    font-size: 22cqw;
    animation-delay: 0s;
  }

  .z2 {
    left: 32%;
    bottom: 38%;
    font-size: 27cqw;
    animation-delay: 0.45s;
  }

  .z3 {
    left: 60%;
    bottom: 62%;
    font-size: 32cqw;
    animation-delay: 0.9s;
  }

  @keyframes rise {
    0% {
      opacity: 0;
      transform: translate3d(0, 18%, 0) scale(0.7) rotate(-6deg);
    }
    22% {
      opacity: 1;
    }
    70% {
      opacity: 0.9;
    }
    100% {
      opacity: 0;
      transform: translate3d(10%, -58%, 0) scale(1.06) rotate(6deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .z {
      animation: none;
      opacity: 0.85;
      transform: none;
    }
  }
</style>
