<!--
  The original mascot: a mochi-bean with a sprout. [FRONTEND]

  Not based on any existing character or franchise artwork. It is shared by
  the island's pet panel and the detached desktop pet window; both size it
  from the outside, so this component only owns the drawing and the subtle
  breathing / blinking / swaying loops.

  `status` picks the expression. The icon is decorative in both call sites —
  the surrounding button or bubble carries the accessible name.
-->
<script lang="ts">
  import type { PetStatus } from './pet';

  let { status = 'ok' as PetStatus }: { status?: PetStatus } = $props();
</script>

<svg
  class="creature"
  viewBox="0 0 128 128"
  data-status={status}
  aria-hidden="true"
  focusable="false"
>
  <defs>
    <linearGradient id="pet-body-fill" x1="64" y1="26" x2="64" y2="102" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fff2dc" />
      <stop offset="0.62" stop-color="#f7e3c3" />
      <stop offset="1" stop-color="#efd0a3" />
    </linearGradient>
    <radialGradient id="pet-belly-fill" cx="64" cy="76" r="28" gradientUnits="userSpaceOnUse">
      <stop stop-color="#fffaf0" stop-opacity="0.95" />
      <stop offset="0.7" stop-color="#fffaf0" stop-opacity="0.58" />
      <stop offset="1" stop-color="#fffaf0" stop-opacity="0" />
    </radialGradient>
  </defs>
  <ellipse class="shadow" cx="64" cy="111" rx="27" ry="4" fill="#3a2a20" opacity="0.18" />
  <g class="sprout">
    <path d="M64 30c0-7 0-12-1-19" fill="none" stroke="#73a96f" stroke-width="3" stroke-linecap="round" />
    <path d="M63 20c-8-1-13-5-14-13 8 0 14 4 14 13Z" fill="#8ec98a" />
    <path d="M64 16c4-6 10-7 17-5-2 6-8 9-17 8Z" fill="#6fb277" />
  </g>
  <g class="creature-body">
    <path
      d="M64 25C47 25 33 32 28 45c-7 18-2 40 14 51 6 4 14 6 22 6s16-2 22-6c16-11 21-33 14-51C96 32 81 25 64 25Z"
      fill="url(#pet-body-fill)"
      stroke="#d9b281"
      stroke-width="1.4"
    />
    <ellipse cx="64" cy="76" rx="30" ry="24" fill="url(#pet-belly-fill)" />
    <ellipse cx="49" cy="97" rx="9" ry="5.5" fill="#f0d4a8" stroke="#d9b281" stroke-width="1" />
    <ellipse cx="79" cy="97" rx="9" ry="5.5" fill="#f0d4a8" stroke="#d9b281" stroke-width="1" />
    <ellipse cx="40" cy="73" rx="7.5" ry="4.4" fill="#f3a39d" opacity="0.55" />
    <ellipse cx="88" cy="73" rx="7.5" ry="4.4" fill="#f3a39d" opacity="0.55" />

    {#if status === 'happy'}
      <g class="eyes open">
        <ellipse cx="48" cy="62" rx="4.8" ry="5.8" fill="#4b3a34" />
        <ellipse cx="80" cy="62" rx="4.8" ry="5.8" fill="#4b3a34" />
        <circle cx="49.7" cy="60" r="1.45" fill="#fffdf8" />
        <circle cx="81.7" cy="60" r="1.45" fill="#fffdf8" />
      </g>
      <g class="sparkles" fill="#e8b45d">
        <path d="M23 48c.5-2.6 1-3.1 3.6-3.6-2.6-.5-3.1-1-3.6-3.6-.5 2.6-1 3.1-3.6 3.6 2.6.5 3.1 1 3.6 3.6Z" />
        <path d="M105 38c.4-2 1-2.5 3-3-2-.4-2.6-1-3-3-.4 2-1 2.6-3 3 2 .5 2.6 1 3 3Z" />
      </g>
      <path d="M57 74c3 6 11 6 14 0" fill="none" stroke="#4b3a34" stroke-width="2.6" stroke-linecap="round" />
    {:else if status === 'hungry'}
      <g class="eyes open">
        <ellipse cx="48" cy="63" rx="5.4" ry="6.5" fill="#4b3a34" />
        <ellipse cx="80" cy="63" rx="5.4" ry="6.5" fill="#4b3a34" />
        <circle cx="50" cy="60.5" r="1.7" fill="#fffdf8" />
        <circle cx="82" cy="60.5" r="1.7" fill="#fffdf8" />
      </g>
      <path d="M42 52c3-2.5 7-2.5 10 0M76 52c3-2.5 7-2.5 10 0" fill="none" stroke="#4b3a34" stroke-width="2" stroke-linecap="round" opacity="0.72" />
      <ellipse cx="64" cy="80" rx="4.2" ry="4.8" fill="#a46754" />
      <path d="M57 75c2-1.5 4-1.5 6 0M65 75c2-1.5 4-1.5 6 0" fill="none" stroke="#4b3a34" stroke-width="1.5" stroke-linecap="round" opacity="0.55" />
    {:else if status === 'tired'}
      <g class="eyes open">
        <path d="M43 61c4 4 8 4 12 0" fill="none" stroke="#4b3a34" stroke-width="2.8" stroke-linecap="round" />
        <path d="M75 61c4 4 8 4 12 0" fill="none" stroke="#4b3a34" stroke-width="2.8" stroke-linecap="round" />
      </g>
      <path d="M58 77c3 4 9 4 12 0" fill="none" stroke="#4b3a34" stroke-width="2.4" stroke-linecap="round" />
      <g class="snooze" fill="none" stroke="#b78d59" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M95 42h7l-7 8h7" />
        <path d="M106 31h5l-5 6h5" />
      </g>
    {:else if status === 'bored'}
      <g class="eyes open">
        <path d="M42 62h13M75 62h13" fill="none" stroke="#4b3a34" stroke-width="2.8" stroke-linecap="round" />
      </g>
      <path d="M59 76h10" fill="none" stroke="#4b3a34" stroke-width="2.4" stroke-linecap="round" />
      <path d="M88 88c2-1.5 4-1.5 6 0" fill="none" stroke="#b78d59" stroke-width="1.8" stroke-linecap="round" opacity="0.7" />
    {:else}
      <g class="eyes open">
        <ellipse cx="48" cy="62" rx="4.4" ry="5.4" fill="#4b3a34" />
        <ellipse cx="80" cy="62" rx="4.4" ry="5.4" fill="#4b3a34" />
        <circle cx="49.5" cy="60.3" r="1.3" fill="#fffdf8" />
        <circle cx="81.5" cy="60.3" r="1.3" fill="#fffdf8" />
      </g>
      <path d="M59 75c3 3 7 3 10 0" fill="none" stroke="#4b3a34" stroke-width="2.4" stroke-linecap="round" />
    {/if}
  </g>
</svg>

<style>
  .creature {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .creature-body {
    transform-box: view-box;
    transform-origin: 64px 108px;
    animation: pet-breathe 4.2s ease-in-out infinite;
  }

  .eyes.open {
    transform-box: view-box;
    transform-origin: 64px 62px;
    animation: pet-blink 5.8s ease-in-out infinite;
  }

  .sprout {
    transform-box: view-box;
    transform-origin: 63px 30px;
    animation: pet-sway 5.4s ease-in-out infinite;
  }

  .sparkles {
    animation: pet-twinkle 3.6s ease-in-out infinite;
  }

  .shadow {
    transform-box: view-box;
    transform-origin: 64px 111px;
    animation: pet-shadow 4.2s ease-in-out infinite;
  }

  @keyframes pet-breathe {
    0%,
    100% {
      transform: translateY(0) scale(1);
    }
    50% {
      transform: translateY(-1.4px) scale(1.012);
    }
  }

  @keyframes pet-blink {
    0%,
    91%,
    100% {
      transform: scaleY(1);
    }
    94%,
    96% {
      transform: scaleY(0.08);
    }
  }

  @keyframes pet-sway {
    0%,
    100% {
      transform: rotate(-1.5deg);
    }
    50% {
      transform: rotate(2deg);
    }
  }

  @keyframes pet-twinkle {
    0%,
    100% {
      opacity: 0.65;
    }
    50% {
      opacity: 1;
    }
  }

  @keyframes pet-shadow {
    0%,
    100% {
      transform: scaleX(1);
      opacity: 0.18;
    }
    50% {
      transform: scaleX(0.93);
      opacity: 0.13;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .creature-body,
    .eyes.open,
    .sprout,
    .sparkles,
    .shadow {
      animation: none;
    }
  }
</style>
