<!--
  Island → Sticky notes. A small board of scratchpads beside the AI usage
  rings: pick a note from the list, edit it below, or add another. Autosaved
  locally, never uploaded, survives restarts. [FRONTEND]
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { t } from '$lib/i18n/i18n.svelte';
  import {
    NOTES_MAX_CHARS,
    NOTES_MAX_NOTES,
    buildNoteState,
    newNoteId,
    parseNotes,
    type Note,
  } from '$lib/plugins/notes';
  import { readPluginState, removePluginState, writePluginState } from '$lib/plugins/storage';

  const PLUGIN = 'notes';

  let notes = $state<Note[]>([]);
  let activeId = $state<string | null>(null);
  let text = $state('');
  let savedAt = $state<number | null>(null);
  let noteInput = $state<HTMLTextAreaElement>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function emptyNote(): Note {
    return { id: newNoteId(), text: '', updatedAt: Date.now() };
  }

  function persist() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    // Keep the list preview in step even if the effect has not flushed yet
    // (select/add call persist as the pointer leaves the textarea).
    const active = notes.find((note) => note.id === activeId);
    if (active && active.text !== text) active.text = text;
    const state = buildNoteState(notes, activeId, text);
    if (!state) {
      removePluginState(PLUGIN);
      savedAt = null;
      return;
    }
    writePluginState(PLUGIN, state);
    savedAt = Date.now();
  }

  function scheduleSave() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(persist, 250);
  }

  // Keep the active note's preview in step with the textarea without rewriting
  // it on every render (the list shows the first lines of each note).
  $effect(() => {
    const note = notes.find((entry) => entry.id === activeId);
    if (note && note.text !== text) note.text = text;
  });

  onMount(() => {
    const loaded = parseNotes(readPluginState<unknown>(PLUGIN, null));
    notes = loaded.notes.length > 0 ? loaded.notes : [emptyNote()];
    const preferred = notes.find((note) => note.id === loaded.activeId);
    const first = preferred ?? notes[0];
    activeId = first.id;
    text = first.text;
    savedAt = first.text.trim() ? first.updatedAt : null;
    return () => {
      if (timer) clearTimeout(timer);
      // `persist` clears `timer` itself and drops storage when nothing is left.
      persist();
    };
  });

  function select(id: string) {
    if (id === activeId) return;
    persist();
    const note = notes.find((entry) => entry.id === id);
    if (!note) return;
    activeId = id;
    text = note.text;
    savedAt = note.text.trim() ? note.updatedAt : null;
  }

  function addNote() {
    if (notes.length >= NOTES_MAX_NOTES) return;
    persist();
    const note = emptyNote();
    notes = [note, ...notes];
    activeId = note.id;
    text = '';
    savedAt = null;
    void tick().then(() => noteInput?.focus());
  }

  function remove(id: string) {
    const index = notes.findIndex((note) => note.id === id);
    if (index < 0) return;
    const remaining = notes.filter((note) => note.id !== id);
    if (remaining.length === 0) {
      const note = emptyNote();
      notes = [note];
      activeId = note.id;
      text = '';
      savedAt = null;
      if (timer) clearTimeout(timer);
      timer = null;
      removePluginState(PLUGIN);
      return;
    }
    notes = remaining;
    if (id === activeId) {
      const next = remaining[Math.min(index, remaining.length - 1)];
      activeId = next.id;
      text = next.text;
      savedAt = next.text.trim() ? next.updatedAt : null;
    }
    scheduleSave();
  }

  function clear() {
    text = '';
    const note = notes.find((entry) => entry.id === activeId);
    if (note) note.text = '';
    scheduleSave();
  }
</script>

<div class="panel">
  <header class="panel-head">
    <div class="heading">
      <strong>{t('plugin.notes')}</strong>
      <span class="count" aria-hidden="true">{notes.length}</span>
    </div>
    <div class="head-actions">
      <button class="link" onclick={clear} disabled={text.length === 0}>{t('plugin.notes.clear')}</button>
      <button
        class="link"
        onclick={addNote}
        disabled={notes.length >= NOTES_MAX_NOTES}
        title={notes.length >= NOTES_MAX_NOTES ? t('plugin.notes.limit') : undefined}
      >
        {t('plugin.notes.new')}
      </button>
    </div>
  </header>

  <ul class="note-list" aria-label={t('plugin.notes')}>
    {#each notes as note, index (note.id)}
      <li class:active={note.id === activeId}>
        <button
          class="note-pick"
          onclick={() => select(note.id)}
          aria-current={note.id === activeId ? 'true' : undefined}
          title={note.text.trim().slice(0, 240) || t('plugin.notes.empty')}
        >
          <span class="preview" class:blank={!note.text.trim()}>
            {note.text.trim() || t('plugin.notes.empty')}
          </span>
        </button>
        <button
          class="remove"
          onclick={() => remove(note.id)}
          aria-label={t('plugin.notes.delete', { index: String(index + 1) })}
          title={t('plugin.notes.delete', { index: String(index + 1) })}
        >
          ×
        </button>
      </li>
    {/each}
  </ul>

  <textarea
    class="note"
    bind:this={noteInput}
    aria-label={t('plugin.notes')}
    placeholder={t('plugin.notes.placeholder')}
    maxlength={NOTES_MAX_CHARS}
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
    gap: 0.5rem;
  }

  .heading {
    display: flex;
    align-items: baseline;
    gap: 0.375rem;
  }

  .panel-head strong {
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .count {
    min-width: 1rem;
    padding: 0 0.25rem;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--faint);
    font-size: 0.5938rem;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .head-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .link {
    padding: 0;
    font-size: 0.6875rem;
    color: var(--focus);
    white-space: nowrap;
  }

  .link:disabled {
    color: var(--faint);
    cursor: default;
  }

  .link:hover:not(:disabled) {
    text-decoration: underline;
  }

  .note-list {
    display: flex;
    flex-direction: column;
    gap: 0.1875rem;
    max-height: 7.25rem;
    overflow-y: auto;
    margin: 0;
    padding: 0;
    list-style: none;
    scrollbar-width: thin;
  }

  .note-list li {
    display: flex;
    align-items: stretch;
    gap: 0.125rem;
    border-radius: 0.5rem;
    background: var(--surface-2);
  }

  .note-list li.active {
    box-shadow: inset 0 0 0 1px var(--focus);
  }

  .note-pick {
    display: flex;
    align-items: center;
    flex: 1 1 auto;
    min-width: 0;
    padding: 0.3125rem 0.4375rem;
    border-radius: 0.5rem;
    color: var(--muted);
    font-size: 0.6875rem;
    line-height: 1.35;
    text-align: left;
  }

  .note-pick:hover {
    color: var(--text);
  }

  .note-list li.active .note-pick {
    color: var(--text);
  }

  .preview {
    display: -webkit-box;
    overflow: hidden;
    white-space: pre-wrap;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    word-break: break-word;
  }

  .preview.blank {
    color: var(--faint);
    font-style: italic;
  }

  .remove {
    flex: none;
    width: 1.5rem;
    border-radius: 0.5rem;
    color: var(--faint);
    font-size: 0.875rem;
    line-height: 1;
    opacity: 0;
    transition: opacity var(--dur-ui) var(--ease-out), color var(--dur-ui) var(--ease-out);
  }

  .note-list li:hover .remove,
  .note-list li:focus-within .remove,
  .note-list li.active .remove {
    opacity: 1;
  }

  .remove:hover {
    color: var(--critical);
  }

  .note {
    width: 100%;
    min-height: 6rem;
    max-height: 12rem;
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
