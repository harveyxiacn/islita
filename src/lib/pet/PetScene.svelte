<!--
  The drawn backdrop behind the bundled pets. [FRONTEND]

  One original scene per character: a matcha picnic for Mochi, a deep-sea
  lantern for DeepSeek and a bright aquarium for Hachiware. Pure SVG + CSS so
  the scenes ship with the app, scale with the panel and need no raster assets.
  The component is decorative; the surrounding scene owns the accessible name.
-->
<script lang="ts">
  import type { PetThemeId } from './themes';

  let { theme }: { theme: PetThemeId } = $props();
</script>

<div class="pet-scene" data-pet-theme={theme} aria-hidden="true">
  {#if theme === 'matcha'}
    <svg class="art" viewBox="0 0 352 128" preserveAspectRatio="xMidYMax slice">
      <defs>
        <radialGradient id="matcha-sun" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stop-color="#f6cd7f" stop-opacity="0.9" />
          <stop offset="0.55" stop-color="#f6cd7f" stop-opacity="0.34" />
          <stop offset="1" stop-color="#f6cd7f" stop-opacity="0" />
        </radialGradient>
        <linearGradient id="matcha-hill-a" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#c9d8b2" />
          <stop offset="1" stop-color="#aec695" />
        </linearGradient>
        <linearGradient id="matcha-hill-b" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#a9c08d" />
          <stop offset="1" stop-color="#8fac74" />
        </linearGradient>
      </defs>
      <circle cx="300" cy="26" r="44" fill="url(#matcha-sun)" />
      <path
        d="M0 96c34-19 66-16 102-5 35 11 64 4 96-5 39-11 78-5 110 7 18 7 32 6 44 2v33H0Z"
        fill="url(#matcha-hill-a)"
        opacity="0.92"
      />
      <path
        d="M0 111c42-13 84-8 123 1 44 10 84-1 126-3 42-2 76 7 103 3v16H0Z"
        fill="url(#matcha-hill-b)"
      />
      <g stroke="#75955b" stroke-width="1.3" stroke-linecap="round" opacity="0.5">
        <path d="M37 119c1-7 2-11 4-15M43 119c0-5-1-9-3-12" />
        <path d="M314 118c1-6 2-10 4-13M320 118c0-5-1-8-3-11" />
        <path d="M74 115c1-5 2-8 3-11M79 115c0-4-1-7-3-9" />
      </g>
      <g fill="#7f9f63" opacity="0.55">
        <ellipse cx="120" cy="90" rx="4" ry="1.6" transform="rotate(-24 120 90)" />
        <ellipse cx="250" cy="82" rx="3.4" ry="1.4" transform="rotate(18 250 82)" />
      </g>
      <path d="M0 119h352v9H0Z" fill="#f4e6c8" opacity="0.82" />
      <path d="M0 123h352" stroke="#dcc49a" stroke-width="1" opacity="0.5" />
      <path d="M22 119v9M44 119v9M66 119v9M88 119v9M110 119v9M132 119v9M154 119v9M176 119v9M198 119v9M220 119v9M242 119v9M264 119v9M286 119v9M308 119v9M330 119v9" stroke="#e4cda6" stroke-width="1" opacity="0.45" />
    </svg>
  {:else if theme === 'abyss'}
    <svg class="art" viewBox="0 0 352 128" preserveAspectRatio="xMidYMax slice">
      <defs>
        <radialGradient id="abyss-glow" cx="0.5" cy="0.2" r="0.7">
          <stop offset="0" stop-color="#3fd8e6" stop-opacity="0.22" />
          <stop offset="0.55" stop-color="#1b7f96" stop-opacity="0.08" />
          <stop offset="1" stop-color="#06141f" stop-opacity="0" />
        </radialGradient>
        <linearGradient id="abyss-floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#0c2a3a" />
          <stop offset="1" stop-color="#071a26" />
        </linearGradient>
        <radialGradient id="abyss-jelly" cx="0.5" cy="0.4" r="0.5">
          <stop offset="0" stop-color="#8ff0f8" stop-opacity="0.5" />
          <stop offset="1" stop-color="#3fd8e6" stop-opacity="0" />
        </radialGradient>
      </defs>
      <rect width="352" height="128" fill="#071a26" />
      <ellipse cx="176" cy="24" rx="170" ry="86" fill="url(#abyss-glow)" />
      <g fill="none" stroke="#3fd8e6" stroke-width="1" opacity="0.11">
        <path d="M-20 30c40-10 80 10 120 0s80-10 120 0 80 10 152-4" />
        <path d="M-20 50c40-10 80 10 120 0s80-10 120 0 80 10 152-4" />
        <path d="M-20 70c40-10 80 10 120 0s80-10 120 0 80 10 152-4" />
      </g>
      <circle cx="292" cy="34" r="26" fill="url(#abyss-jelly)" />
      <g opacity="0.55">
        <ellipse cx="292" cy="30" rx="11" ry="7" fill="#3fd8e6" opacity="0.3" />
        <path
          d="M284 33c0 7 3 11 3 19M292 35v19M300 33c0 7-3 11-3 19"
          fill="none"
          stroke="#8ff0f8"
          stroke-width="1.1"
          stroke-linecap="round"
        />
      </g>
      <path
        d="M0 112c32-8 66-7 100 0 34 7 70 6 106 0 38-7 82-6 146 4v12H0Z"
        fill="url(#abyss-floor)"
      />
      <g fill="#3fd8e6">
        <circle cx="58" cy="120" r="1.3" opacity="0.4" />
        <circle cx="88" cy="124" r="1" opacity="0.3" />
        <circle cx="246" cy="121" r="1.2" opacity="0.35" />
        <circle cx="272" cy="125" r="0.9" opacity="0.28" />
      </g>
      <g fill="none" stroke="#2a8ea3" stroke-width="1.2" stroke-linecap="round" opacity="0.3">
        <path d="M32 120c-1-7 1-12 5-16M38 120c0-6 2-10 6-13" />
        <path d="M322 120c-1-7 1-12 5-16M328 120c0-6 2-10 6-13" />
      </g>
    </svg>
  {:else}
    <svg class="art" viewBox="0 0 352 128" preserveAspectRatio="xMidYMax slice">
      <defs>
        <linearGradient id="aq-water" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#eefcff" />
          <stop offset="0.62" stop-color="#c9eef6" />
          <stop offset="1" stop-color="#a9deea" />
        </linearGradient>
        <linearGradient id="aq-coral" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ff9d7e" />
          <stop offset="1" stop-color="#ee6d50" />
        </linearGradient>
        <linearGradient id="aq-sand" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#f9e3ba" />
          <stop offset="1" stop-color="#efd09d" />
        </linearGradient>
      </defs>
      <rect width="352" height="128" fill="url(#aq-water)" />
      <g fill="#ffffff" opacity="0.3">
        <path d="M-20 10 120 0 70 22 0 32Z" />
        <path d="M90 0 220 0 150 20 60 24Z" />
      </g>
      <g fill="none" stroke="#ffffff" stroke-width="2" opacity="0.4" stroke-linecap="round">
        <path d="M-10 34c44 16 76 16 116 3s80-17 120-3 62 18 132 5" />
        <path d="M-10 56c54 13 84 11 124-1s88-13 128 1 58 12 118 1" />
        <path d="M-10 76c44 10 74 8 114-2s84-10 122 2 64 9 126-1" />
      </g>
      <g fill="#2e93b5" opacity="0.14">
        <circle cx="34" cy="24" r="1.5" />
        <circle cx="48" cy="24" r="1.5" />
        <circle cx="62" cy="24" r="1.5" />
        <circle cx="34" cy="38" r="1.5" />
        <circle cx="48" cy="38" r="1.5" />
        <circle cx="62" cy="38" r="1.5" />
      </g>
      <g fill="url(#aq-coral)">
        <path d="M292 128c0-14-4-24-11-35-3-5 0-9 4-7 8 3 13 12 13 21 0-9 4-17 10-22 5-3 8 1 5 6-5 10-7 22-7 37Z" />
        <path d="M270 128c0-9-3-16-8-22-3-4-1-7 3-5 5 3 8 9 8 16 0-6 2-11 6-15 3-3 6 0 4 4-3 7-4 14-4 22Z" opacity="0.8" />
        <path d="M316 128c0-8-2-14-6-19-2-4 1-6 4-4 4 3 6 8 6 13 0-5 2-9 5-12 3-2 5 0 3 3-2 6-3 12-3 19Z" opacity="0.7" />
      </g>
      <g fill="none" stroke="#2e93b5" stroke-width="2.2" stroke-linecap="round" opacity="0.5">
        <path d="M28 128c-2-14 2-25 8-35M37 128c1-10 5-19 14-25M21 128c-4-8-5-16-3-25" />
        <path d="M62 128c-1-9 2-17 6-23M68 128c1-7 4-13 9-17" opacity="0.7" />
      </g>
      <path d="M0 121c20-6 42-5 62 0s40 4 62 0 46-4 70 1 50 5 86 0 54-4 72 0v6H0Z" fill="url(#aq-sand)" />
      <g fill="#ffffff" opacity="0.55">
        <circle cx="86" cy="22" r="0.9" />
        <circle cx="240" cy="16" r="1.1" />
        <circle cx="330" cy="30" r="0.8" />
      </g>
    </svg>
  {/if}

  <div class="particles">
    <span></span>
    <span></span>
    <span></span>
    <span></span>
    <span></span>
  </div>
</div>

<style>
  .pet-scene {
    position: absolute;
    inset: 0;
    z-index: 0;
    overflow: hidden;
    border-radius: inherit;
    pointer-events: none;
  }

  [data-pet-theme='matcha'] {
    background:
      radial-gradient(ellipse at 80% 12%, rgb(246 205 127 / 0.22), transparent 52%),
      linear-gradient(180deg, #fbf7ea 0%, #f5efdf 58%, #e9eeda 100%);
  }

  [data-pet-theme='abyss'] {
    background: #071a26;
  }

  [data-pet-theme='aquarium'] {
    background: linear-gradient(180deg, #effcff 0%, #d6f3f9 55%, #b6e5ee 100%);
  }

  .art {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }

  .particles {
    position: absolute;
    inset: 0;
  }

  .particles span {
    position: absolute;
    bottom: -14px;
    left: 50%;
    opacity: 0;
    will-change: transform, opacity;
  }

  /* Matcha: drifting leaves. */
  [data-pet-theme='matcha'] .particles span {
    width: 9px;
    height: 5px;
    border-radius: 100% 0 100% 0;
    background: #8fae7a;
    box-shadow: 0 0 0 1px rgb(103 130 78 / 0.15);
    animation: pet-leaf 15s linear infinite;
  }

  /* Abyss: pale lantern bubbles. */
  [data-pet-theme='abyss'] .particles span {
    width: 6px;
    height: 6px;
    border: 1px solid rgb(143 240 248 / 0.55);
    border-radius: 50%;
    background: rgb(63 216 230 / 0.1);
    animation: pet-bubble 17s linear infinite;
  }

  /* Aquarium: soap bubbles with a highlight. */
  [data-pet-theme='aquarium'] .particles span {
    width: 8px;
    height: 8px;
    border: 1px solid rgb(255 255 255 / 0.7);
    border-radius: 50%;
    background: rgb(255 255 255 / 0.28);
    box-shadow: inset 1px 1px 0 rgb(255 255 255 / 0.7);
    animation: pet-bubble 13s linear infinite;
  }

  .particles span:nth-child(1) {
    left: 13%;
    animation-delay: -2s;
  }

  .particles span:nth-child(2) {
    left: 29%;
    animation-delay: -9s;
    animation-duration: 18s;
  }

  .particles span:nth-child(3) {
    left: 58%;
    animation-delay: -5s;
    animation-duration: 16s;
  }

  .particles span:nth-child(4) {
    left: 76%;
    animation-delay: -12s;
    animation-duration: 20s;
  }

  .particles span:nth-child(5) {
    left: 88%;
    animation-delay: -7s;
    animation-duration: 14s;
  }

  [data-pet-theme='matcha'] .particles span:nth-child(even) {
    width: 7px;
    height: 4px;
  }

  [data-pet-theme='abyss'] .particles span:nth-child(even),
  [data-pet-theme='aquarium'] .particles span:nth-child(even) {
    width: 4px;
    height: 4px;
  }

  @keyframes pet-leaf {
    0% {
      opacity: 0;
      transform: translate(0, 0) rotate(0deg);
    }
    12% {
      opacity: 0.75;
    }
    70% {
      opacity: 0.6;
    }
    100% {
      opacity: 0;
      transform: translate(34px, -150px) rotate(260deg);
    }
  }

  @keyframes pet-bubble {
    0% {
      opacity: 0;
      transform: translate(0, 0) scale(0.7);
    }
    14% {
      opacity: 0.85;
    }
    55% {
      transform: translate(-8px, -70px) scale(1);
    }
    100% {
      opacity: 0;
      transform: translate(10px, -150px) scale(1.1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .particles span {
      animation: none;
      opacity: 0;
    }
  }
</style>
