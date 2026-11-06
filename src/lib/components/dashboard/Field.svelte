<!--
  One settings row: label and control on the first line, the hint below both so
  it can use the card's full width. [FRONTEND]
  Inside the Settings tab the row also hides itself when it does not match the
  search box (label and hint, in the current language).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { matchesQuery } from '$lib/settings-search';
  import { getCardScope, getSettingsSearch } from '$lib/settings-scope.svelte';

  interface Props {
    label: string;
    hint?: string;
    /** stretch the control to the full row width (sliders, editors) */
    wide?: boolean;
    children: Snippet;
  }

  let { label, hint, wide = false, children }: Props = $props();

  const search = getSettingsSearch();
  const scope = getCardScope();
  const shown = $derived(!search?.active || !!scope?.headMatches || matchesQuery(search.query, label, hint));
  const id = Symbol('field');
  $effect(() => {
    if (!scope) return;
    scope.fields.set(id, shown);
    return () => scope.fields.delete(id);
  });
</script>

<div class="setting-field" class:wide hidden={!shown}>
  <div class="text">
    <span class="label">{label}</span>
    {#if hint}<span class="hint">{hint}</span>{/if}
  </div>
  <div class="control">{@render children()}</div>
</div>

<style>
  .setting-field {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    column-gap: 1rem;
    row-gap: 0.125rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
  }

  .setting-field[hidden] {
    display: none;
  }

  .setting-field:last-child {
    border-bottom: none;
  }

  /* Let the label and hint participate in the row grid directly, so the hint
     can use the full width instead of a narrow left column. */
  .text {
    display: contents;
  }

  .label {
    grid-column: 1;
    grid-row: 1;
    min-width: 0;
    color: var(--text);
  }

  .hint {
    grid-column: 1 / -1;
    grid-row: 2;
    min-width: 0;
    max-width: 72ch;
    font-size: 0.75rem;
    line-height: 1.45;
    color: var(--muted);
    overflow-wrap: anywhere;
  }

  .control {
    grid-column: 2;
    grid-row: 1;
    justify-self: end;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    max-width: 100%;
    flex-wrap: wrap;
  }

  .control :global(select) { max-width: 100%; }

  .setting-field.wide {
    grid-template-columns: minmax(0, 1fr);
  }

  .setting-field.wide .label {
    grid-column: 1;
    grid-row: 1;
  }

  .setting-field.wide .hint {
    grid-column: 1;
    grid-row: 2;
  }

  .setting-field.wide .control {
    grid-column: 1;
    grid-row: 3;
    justify-self: stretch;
  }

  @media (max-width: 620px) {
    .setting-field,
    .setting-field.wide {
      grid-template-columns: minmax(0, 1fr);
    }

    .label,
    .hint,
    .control,
    .setting-field.wide .label,
    .setting-field.wide .hint,
    .setting-field.wide .control {
      grid-column: 1;
      grid-row: auto;
    }

    .control,
    .setting-field.wide .control {
      justify-self: start;
    }
  }
</style>
