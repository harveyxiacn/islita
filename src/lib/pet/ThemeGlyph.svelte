<!--
  Tiny glyph used by the theme picker swatches. [FRONTEND]
  Decorative only: the surrounding button already carries the label.
-->
<script lang="ts">
  import type { PetTheme } from './pet';

  let { theme }: { theme: PetTheme } = $props();
</script>

<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  {#if theme === 'matcha'}
    <path d="M8.4 2.2c3 1 4.7 3.3 4.4 6.2-3.1.5-5.4-1-6.1-3.5-.3-1 .4-3.1 1.7-2.7Z" fill="currentColor" />
    <path d="M7.7 5.2C6.2 6.5 5.3 8.5 5.3 11M7.7 5.2c.4 2.2 1.7 3.9 3.8 4.9" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" opacity="0.7" />
  {:else if theme === 'abyss'}
    <path d="M8 1.8c1.9 2.3 3.4 4.2 3.4 6.1a3.4 3.4 0 0 1-6.8 0c0-1.9 1.5-3.8 3.4-6.1Z" fill="currentColor" opacity="0.9" />
    <circle cx="10.4" cy="3.2" r="1.1" fill="currentColor" opacity="0.45" />
    <path d="M6.4 8.2c0 1 .7 1.8 1.7 1.9" fill="none" stroke="#fff" stroke-width="1" stroke-linecap="round" opacity="0.55" />
  {:else if theme === 'aquarium'}
    <circle cx="8" cy="8" r="4.6" fill="none" stroke="currentColor" stroke-width="1.2" />
    <circle cx="6.4" cy="6.4" r="1" fill="#fff" opacity="0.9" />
    <circle cx="10.6" cy="9.6" r="0.9" fill="currentColor" opacity="0.55" />
  {:else}
    <path d="M8 2.2 9.3 6l3.8 1.3-3.8 1.3L8 12.5 6.7 8.6 2.9 7.3 6.7 6 8 2.2Z" fill="currentColor" />
    <circle cx="12.4" cy="3.2" r="0.9" fill="currentColor" opacity="0.45" />
  {/if}
</svg>

<style>
  svg {
    display: block;
    width: 0.75rem;
    height: 0.75rem;
    overflow: visible;
  }
</style>
