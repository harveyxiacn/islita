<!--
  Island → Sticky note. A single scratchpad that lives beside the AI usage
  rings: autosaved locally, never uploaded, survives restarts. [FRONTEND]
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n/i18n.svelte';
  import { readPluginState, removePluginState, writePluginState } from '$lib/plugins/storage';

  interface NoteState {
    text: string;
    updatedAt: number;
  }

  const PLUGIN = 'notes';
  const MAX_CHARS = 4000;

  let text = $state('');
  let savedAt = $state<number | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function persist() {
    writePluginState(PLUGIN, { text, updatedAt: Date.now() } satisfies NoteState);
    savedAt = Date.now();
  }

  function scheduleSave() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(persist, 250);
  }

  onMount(() => {
    const state = readPluginState<NoteState | null>(PLUGIN, null);
    if (state && typeof state.text === 'string') {
      text = state.text.slice(0, MAX_CHARS);
      savedAt = text.length > 0 ? (state.updatedAt ?? null) : null;
    }
    return () => {
      if (timer) clearTimeout(timer);
      if (text.length > 0) persist();
      else removePluginState(PLUGIN);
    };
  });

  function clear() {
    text = '';
    if (timer) clearTimeout(timer);
    timer = null;
    removePluginState(PLUGIN);
    savedAt = null;
  }
</script>

<div class="panel">
  <header class="panel-head">
    <strong>{t('plugin.notes')}</strong>
    <button class="link" onclick={clear} disabled={text.length === 0}>{t('plugin.notes.clear')}</button>
  </header>
  <textarea
    class="note"
    aria-label={t('plugin.notes')}
    placeholder={t('plugin.notes.placeholder')}
    maxlength={MAX_CHARS}
    bind:value={text}
    oninput={scheduleSave}
  ></textarea>
  <footer class="meta">
    <span>{t('plugin.notes.characters', { count: String(text.length) })}</span>
    <span>{savedAt ? t('plugin.notes.saved') : t('plugin.notes.local')}</span>
  </footer>
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    width: 22rem;
    max-width: calc(100vw - 2rem);
  }

  .panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .panel-head strong {
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .link {
    padding: 0;
    font-size: 0.6875rem;
    color: var(--focus);
  }

  .link:disabled {
    color: var(--faint);
    cursor: default;
  }

  .link:hover:not(:disabled) {
    text-decoration: underline;
  }

  .note {
    width: 100%;
    min-height: 7rem;
    max-height: 14rem;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--surface-2);
    color: var(--text);
    font-size: 0.75rem;
    line-height: 1.5;
    resize: vertical;
    outline: none;
    /* the sidebar hides selection everywhere; the note needs it back */
    user-select: text;
    -webkit-user-select: text;
  }

  .note:focus-visible {
    border-color: var(--focus);
  }

  .note::placeholder {
    color: var(--faint);
  }

  .meta {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.625rem;
    color: var(--faint);
  }
</style>
