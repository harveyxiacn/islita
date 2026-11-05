<!--
  Island → File drop station. [FRONTEND]

  On the desktop the window receives native drop events from Tauri; the paths
  are handed to `save_dropped_files`, which copies regular files into the
  app's private dropbox. The browser preview cannot copy files, so it accepts
  an HTML drop/file picker and shows the same list from the mock backend.

  The panel never renders a full source path: the backend only returns the
  destination name, size and a dropbox-relative path.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    isTauri,
    listDroppedFiles,
    openDropbox,
    pickDroppedFiles,
    saveDroppedFiles,
  } from '$lib/api';
  import { formatAgo } from '$lib/format';
  import { t } from '$lib/i18n/i18n.svelte';
  import type { DroppedFile } from '$lib/types';

  const LIMIT = 6;

  let fileInput: HTMLInputElement;
  let rows = $state<DroppedFile[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let dragging = $state(false);
  let error = $state<string | null>(null);
  let notice = $state<{ saved: number; skipped: number } | null>(null);
  let now = $state(Date.now());

  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '—';
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${Math.round(bytes)} B`;
  }

  function accept(outcome: { saved: DroppedFile[]; skipped: string[] } | null) {
    if (!outcome) return;
    notice = { saved: outcome.saved.length, skipped: outcome.skipped.length };
    error = outcome.saved.length === 0 && outcome.skipped.length > 0 ? t('plugin.drop.failed') : null;
    void load();
  }

  async function load() {
    try {
      rows = await listDroppedFiles(LIMIT);
      error = null;
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  async function savePaths(paths: string[]) {
    if (paths.length === 0) return;
    saving = true;
    try {
      accept(await saveDroppedFiles(paths));
    } catch (e) {
      error = String(e);
    } finally {
      saving = false;
    }
  }

  async function choose() {
    if (!isTauri()) {
      fileInput?.click();
      return;
    }
    saving = true;
    try {
      accept(await pickDroppedFiles());
    } catch (e) {
      error = String(e);
    } finally {
      saving = false;
    }
  }

  function onPicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const names = Array.from(input.files ?? []).map((file) => file.name);
    input.value = '';
    // Browser preview only: the mock backend records the names. The real app
    // uses the native picker above, which has actual paths to copy.
    void savePaths(names);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    const names = Array.from(event.dataTransfer?.files ?? []).map((file) => file.name);
    void savePaths(names);
  }

  onMount(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void load();
    const clock = setInterval(() => (now = Date.now()), 30_000);

    if (isTauri()) {
      void (async () => {
        try {
          const { getCurrentWebview } = await import('@tauri-apps/api/webview');
          const un = await getCurrentWebview().onDragDropEvent((event) => {
            const payload = event.payload;
            if (payload.type === 'enter' || payload.type === 'over') {
              dragging = true;
            } else if (payload.type === 'leave') {
              dragging = false;
            } else if (payload.type === 'drop') {
              dragging = false;
              void savePaths(payload.paths);
            }
          });
          if (disposed) un();
          else unlisten = un;
        } catch {
          // Older Tauri shells may not expose drop events; the native picker
          // still works, so this is not an error worth showing.
        }
      })();
    }

    // A notice is informative, not a permanent status.
    const clearNotice = setInterval(() => {
      if (notice) notice = null;
    }, 5000);

    return () => {
      disposed = true;
      unlisten?.();
      clearInterval(clock);
      clearInterval(clearNotice);
    };
  });
</script>

<div class="panel">
  <header class="panel-head">
    <div class="heading">
      <strong>{t('plugin.drop')}</strong>
      <span class="where">{t('plugin.drop.local')}</span>
    </div>
    {#if isTauri()}
      <button class="link" onclick={() => void openDropbox()}>{t('plugin.drop.openFolder')}</button>
    {/if}
  </header>

  <button
    class="dropzone"
    class:dragging
    class:busy={saving}
    onclick={() => void choose()}
    disabled={saving}
    ondragover={(e) => {
      e.preventDefault();
      dragging = true;
    }}
    ondragleave={() => (dragging = false)}
    ondrop={onDrop}
  >
    <span class="drop-icon" aria-hidden="true">
      {#if saving}
        <span class="spinner"></span>
      {:else}
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 16V4M7 9l5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
        </svg>
      {/if}
    </span>
    <span class="drop-title">{dragging ? t('plugin.drop.release') : t('plugin.drop.choose')}</span>
    <small>{t('plugin.drop.choose.hint')}</small>
  </button>

  {#if notice}
    <p class="notice" role="status">
      {t('plugin.drop.saved', { count: notice.saved })}
      {#if notice.skipped > 0}<span class="skip">· {t('plugin.drop.skipped', { count: notice.skipped })}</span>{/if}
    </p>
  {:else if error}
    <p class="notice bad" role="alert">{error}</p>
  {/if}

  <section class="recent">
    <div class="recent-head">
      <span>{t('plugin.drop.recent')}</span>
      {#if rows.length > 0}<span class="count">{rows.length}</span>{/if}
    </div>
    {#if loading}
      <p class="empty">{t('common.loading')}</p>
    {:else if rows.length === 0}
      <p class="empty">{t('plugin.drop.empty')}</p>
    {:else}
      <ul>
        {#each rows as file (file.relative)}
          <li>
            <span class="file-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M6 3h8l4 4v14H6zM14 3v5h5" />
              </svg>
            </span>
            <span class="file-name" title={file.name}>{file.name}</span>
            <span class="file-meta">{formatBytes(file.size)} · {formatAgo(new Date(file.savedAt).toISOString(), now)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <p class="privacy">{t('plugin.drop.privacy')}</p>

  <input class="hidden" type="file" multiple bind:this={fileInput} onchange={onPicked} />
</div>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    width: 22rem;
    max-width: calc(100vw - 2rem);
  }

  .panel-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .heading {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    min-width: 0;
  }

  .panel-head strong {
    font-size: 0.8125rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .where {
    font-size: 0.625rem;
    color: var(--faint);
    white-space: nowrap;
  }

  .link {
    padding: 0;
    font-size: 0.6563rem;
    color: var(--focus);
    white-space: nowrap;
  }

  .link:hover {
    text-decoration: underline;
  }

  .dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 1rem 0.75rem;
    border: 1px dashed var(--border-strong);
    border-radius: 0.75rem;
    background: transparent;
    color: var(--muted);
    transition: border-color var(--dur-ui) var(--ease-out), background var(--dur-ui) var(--ease-out),
      color var(--dur-ui) var(--ease-out), transform var(--dur-ui) var(--ease-out);
  }

  .dropzone:hover,
  .dropzone.dragging {
    border-color: var(--focus);
    background: var(--surface-2);
    color: var(--text);
  }

  .dropzone.dragging {
    transform: scale(1.012);
    border-style: solid;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--focus) 25%, transparent);
  }

  .dropzone.busy {
    opacity: 0.8;
  }

  .drop-icon {
    display: grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--text);
  }

  .dropzone.dragging .drop-icon {
    color: var(--focus);
    animation: drop-bob 900ms var(--ease-out) infinite alternate;
  }

  @keyframes drop-bob {
    to {
      transform: translateY(-2px);
    }
  }

  .spinner {
    width: 0.875rem;
    height: 0.875rem;
    border: 2px solid var(--border-strong);
    border-top-color: var(--text);
    border-radius: 999px;
    animation: spin 800ms linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .drop-title {
    font-size: 0.75rem;
    font-weight: 500;
  }

  .dropzone small {
    font-size: 0.625rem;
    color: var(--faint);
  }

  .notice {
    margin: 0;
    font-size: 0.6563rem;
    color: var(--ok);
  }

  .notice.bad {
    color: var(--critical);
  }

  .skip {
    color: var(--muted);
  }

  .recent {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding-top: 0.125rem;
  }

  .recent-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.5938rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--faint);
  }

  .count {
    font-variant-numeric: tabular-nums;
  }

  .empty {
    margin: 0;
    padding: 0.25rem 0;
    font-size: 0.6563rem;
    color: var(--muted);
  }

  ul {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.125rem;
    border-top: 1px solid var(--border);
  }

  .file-icon {
    display: grid;
    place-items: center;
    flex: none;
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 0.3125rem;
    background: var(--surface-2);
    color: var(--muted);
  }

  .file-name {
    overflow: hidden;
    flex: 1 1 auto;
    font-size: 0.6875rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-meta {
    flex: none;
    color: var(--faint);
    font-size: 0.5938rem;
    font-variant-numeric: tabular-nums;
  }

  .privacy {
    margin: 0;
    font-size: 0.5938rem;
    line-height: 1.4;
    color: var(--faint);
  }

  .hidden {
    display: none;
  }
</style>
