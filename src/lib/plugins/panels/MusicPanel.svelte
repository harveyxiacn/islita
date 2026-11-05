<!--
  Island → Music player with synced LRC lyrics. [FRONTEND]

  Files are opened with the browser File API, played from an object URL and
  never leave the machine. The audio element lives in `player.svelte.ts`, so
  collapsing the island or switching plugins keeps the music playing. The LRC
  parser is local (`lrc.ts`); the active line follows `timeupdate`.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '$lib/i18n/i18n.svelte';
  import { activeLineAt } from '$lib/plugins/lrc';
  import { player } from '$lib/plugins/player.svelte';
  import { readPluginState, writePluginState } from '$lib/plugins/storage';

  let audioInput = $state<HTMLInputElement>();
  let lyricInput = $state<HTMLInputElement>();
  let lyricsBox = $state<HTMLElement | null>(null);
  let showPlaylist = $state(false);
  let lyricNotice = $state<'added' | 'empty' | 'none' | null>(null);
  let dragging = $state(false);

  const current = $derived(player.current);
  const lyrics = $derived(current?.lyrics ?? null);
  const activeIndex = $derived(lyrics ? activeLineAt(lyrics.lines, player.positionMs) : -1);
  const duration = $derived(player.durationMs || current?.durationMs || 0);
  const progress = $derived(duration > 0 ? Math.min(1, player.positionMs / duration) : 0);

  /** The line to show before the first timestamp (and a helpful placeholder). */
  const lyricWindow = $derived.by(() => {
    if (!lyrics || lyrics.lines.length === 0) return [];
    const center = activeIndex >= 0 ? activeIndex : 0;
    const from = Math.max(0, center - 2);
    const to = Math.min(lyrics.lines.length, center + 3);
    return lyrics.lines.slice(from, to).map((line, offset) => ({ line, index: from + offset }));
  });

  onMount(() => {
    const saved = readPluginState<'list' | 'hidden'>('music.playlist', 'hidden');
    showPlaylist = saved === 'list';
    return () => writePluginState('music.playlist', showPlaylist ? 'list' : 'hidden');
  });

  // Keep the active lyric visible without yanking the whole island around.
  $effect(() => {
    void activeIndex;
    if (!lyricsBox) return;
    const line = lyricsBox.querySelector<HTMLElement>('.lyric.active');
    if (!line) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    // Scroll only the lyric viewport. `scrollIntoView` would also scroll the
    // stage/window and make the whole island jump on every line.
    const top = line.offsetTop - lyricsBox.clientHeight / 2 + line.clientHeight / 2;
    lyricsBox.scrollTo({ top: Math.max(0, top), behavior: reduced ? 'auto' : 'smooth' });
  });

  function pickAudio() {
    audioInput?.click();
  }

  function onAudioPicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    if (input.files) player.addFiles(input.files);
    input.value = '';
    showPlaylist = true;
    writePluginState('music.playlist', 'list');
  }

  function pickLyrics() {
    lyricInput?.click();
  }

  async function onLyricsPicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    if (input.files?.length) {
      const count = await player.addLyricsFiles(input.files);
      lyricNotice = count > 0 ? 'added' : 'empty';
      setTimeout(() => (lyricNotice = null), 3500);
    }
    input.value = '';
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    dragging = false;
    if (!event.dataTransfer?.files?.length) return;
    player.addFiles(event.dataTransfer.files);
    showPlaylist = true;
  }

  function formatClock(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '0:00';
    const total = Math.floor(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function togglePlaylist() {
    showPlaylist = !showPlaylist;
    writePluginState('music.playlist', showPlaylist ? 'list' : 'hidden');
  }
</script>

<div class="panel">
  <header class="panel-head">
    <div class="heading">
      <strong>{t('plugin.music')}</strong>
      {#if current}
        <span class="now" title={current.fileName}>{t('plugin.music.local')}</span>
      {/if}
    </div>
    <div class="head-actions">
      {#if current}
        <button class="link" onclick={pickLyrics}>{t('plugin.music.lyrics')}</button>
        <button class="link" onclick={pickAudio}>{t('plugin.music.add')}</button>
        <button
          class="link icon"
          aria-pressed={showPlaylist}
          aria-label={t('plugin.music.playlist')}
          title={t('plugin.music.playlist')}
          onclick={togglePlaylist}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <path d="M4 7h10M4 12h10M4 17h6M18 7v9.5a2.5 2.5 0 1 1-2-2.45" />
          </svg>
          {player.tracks.length}
        </button>
      {/if}
    </div>
  </header>

  {#if !current}
    <button
      class="dropzone"
      class:dragging
      onclick={pickAudio}
      ondragover={(e) => {
        e.preventDefault();
        dragging = true;
      }}
      ondragleave={() => (dragging = false)}
      ondrop={onDrop}
    >
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
        <path d="M9 18V5l10-2v13M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3ZM19 16a3 3 0 1 1-3-3 3 3 0 0 1 3 3Z" />
      </svg>
      <span>{t('plugin.music.choose')}</span>
      <small>{t('plugin.music.choose.hint')}</small>
    </button>
    <input class="hidden" type="file" accept="audio/*,.mp3,.m4a,.flac,.wav,.ogg,.opus" multiple bind:this={audioInput} onchange={onAudioPicked} />
  {:else}
    <div class="track-line">
      <span class="track-title" title={current.name}>{current.name}</span>
      {#if current.lyrics?.artist}<span class="artist">{current.lyrics.artist}</span>{/if}
    </div>

    <div class="lyrics" class:empty={!lyrics || lyrics.lines.length === 0} bind:this={lyricsBox} aria-live="off">
      {#if !lyrics || lyrics.lines.length === 0}
        <button class="lyric-empty" onclick={pickLyrics}>
          <span>{t('plugin.music.noLyrics')}</span>
          <small>{t('plugin.music.noLyrics.hint')}</small>
        </button>
      {:else}
        {#each lyricWindow as row (row.index)}
          <button
            class="lyric"
            class:active={row.index === activeIndex}
            class:past={row.index < activeIndex}
            aria-current={row.index === activeIndex ? 'true' : undefined}
            onclick={() => player.seek(row.line.timeMs)}
          >
            {row.line.text}
          </button>
        {/each}
      {/if}
    </div>

    <div class="progress-row">
      <span class="time">{formatClock(player.positionMs)}</span>
      <input
        class="progress"
        type="range"
        min="0"
        max={Math.max(1, duration)}
        step="100"
        value={Math.min(player.positionMs, Math.max(1, duration))}
        aria-label={t('plugin.music.seek')}
        style:--progress={`${progress * 100}%`}
        oninput={(e) => player.seek(e.currentTarget.valueAsNumber)}
      />
      <span class="time">{formatClock(duration)}</span>
    </div>

    <div class="controls">
      <button class="ctl" onclick={() => player.prev()} aria-label={t('plugin.music.previous')} title={t('plugin.music.previous')}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6 5h2v14H6zM20 5v14L9 12z" /></svg>
      </button>
      <button class="play" onclick={() => player.toggle()} aria-label={player.playing ? t('plugin.music.pause') : t('plugin.music.play')}>
        {#if player.playing}
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
        {:else}
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
        {/if}
      </button>
      <button class="ctl" onclick={() => player.next()} aria-label={t('plugin.music.next')} title={t('plugin.music.next')}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M16 5h2v14h-2zM4 5v14l11-7z" /></svg>
      </button>
      <span class="volume-wrap">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
          <path d="M4 10v4h4l5 4V6L8 10H4ZM17 9a4 4 0 0 1 0 6" />
        </svg>
        <input
          class="volume"
          type="range"
          min="0"
          max="1"
          step="0.02"
          value={player.volume}
          aria-label={t('plugin.music.volume')}
          oninput={(e) => player.setVolume(e.currentTarget.valueAsNumber)}
        />
      </span>
    </div>

    {#if player.error}
      <p class="notice bad" role="alert">{t('plugin.music.error')}</p>
    {:else if lyricNotice === 'added'}
      <p class="notice" role="status">{t('plugin.music.lyrics.added')}</p>
    {:else if lyricNotice === 'empty'}
      <p class="notice bad" role="status">{t('plugin.music.lyrics.unreadable')}</p>
    {/if}

    {#if showPlaylist}
      <ul class="playlist">
        {#each player.tracks as track, index (track.id)}
          <li class:active={index === player.index}>
            <button class="pick" onclick={() => player.select(index)} aria-current={index === player.index ? 'true' : undefined}>
              <span class="dot" aria-hidden="true"></span>
              <span class="pick-name">{track.name}</span>
              {#if track.lyrics}<span class="badge">{t('plugin.music.lrc')}</span>{/if}
              <span class="pick-time">{track.durationMs > 0 ? formatClock(track.durationMs) : '—'}</span>
            </button>
            <button class="remove" onclick={() => player.remove(index)} aria-label={t('plugin.music.remove', { name: track.name })} title={t('plugin.music.remove', { name: track.name })}>
              ×
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    <input class="hidden" type="file" accept="audio/*,.mp3,.m4a,.flac,.wav,.ogg,.opus" multiple bind:this={audioInput} onchange={onAudioPicked} />
  {/if}
  <input class="hidden" type="file" accept=".lrc,text/plain" multiple bind:this={lyricInput} onchange={onLyricsPicked} />
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
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .heading {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
  }

  .panel-head strong {
    font-size: 0.8125rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .now {
    overflow: hidden;
    font-size: 0.625rem;
    color: var(--faint);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .head-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: none;
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

  .link.icon {
    display: inline-flex;
    align-items: center;
    gap: 0.1875rem;
    color: var(--muted);
  }

  .link.icon[aria-pressed='true'] {
    color: var(--text);
  }

  .dropzone {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 1.15rem 0.75rem;
    border: 1px dashed var(--border-strong);
    border-radius: 0.75rem;
    background: transparent;
    color: var(--muted);
    transition: border-color var(--dur-ui) var(--ease-out), background var(--dur-ui) var(--ease-out), color var(--dur-ui) var(--ease-out);
  }

  .dropzone:hover,
  .dropzone.dragging {
    border-color: var(--focus);
    background: var(--surface-2);
    color: var(--text);
  }

  .dropzone span {
    font-size: 0.75rem;
    font-weight: 500;
  }

  .dropzone small {
    font-size: 0.625rem;
    color: var(--faint);
  }

  .track-line {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
  }

  .track-title {
    overflow: hidden;
    font-size: 0.75rem;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .artist {
    overflow: hidden;
    flex: none;
    max-width: 9rem;
    font-size: 0.625rem;
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .lyrics {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.125rem;
    height: 6.75rem;
    overflow-y: auto;
    padding: 0.125rem 0.25rem;
    border-radius: 0.65rem;
    background: linear-gradient(180deg, var(--surface-2), transparent 18%, transparent 82%, var(--surface-2));
    scrollbar-width: none;
    mask-image: linear-gradient(180deg, transparent, #000 16%, #000 84%, transparent);
  }

  .lyrics::-webkit-scrollbar {
    display: none;
  }

  .lyrics.empty {
    justify-content: center;
    background: var(--surface-2);
    mask-image: none;
  }

  .lyric {
    flex: none;
    max-width: 100%;
    padding: 0.125rem 0.375rem;
    border-radius: 0.375rem;
    font-size: 0.75rem;
    line-height: 1.35;
    color: var(--faint);
    text-align: center;
    transition: color var(--dur-ui) var(--ease-out), transform var(--dur-ui) var(--ease-out), opacity var(--dur-ui) var(--ease-out);
  }

  .lyric:hover {
    color: var(--muted);
  }

  .lyric.past {
    opacity: 0.55;
  }

  .lyric.active {
    color: var(--text);
    font-weight: 600;
    transform: scale(1.03);
  }

  .lyric-empty {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.5rem;
    color: var(--muted);
    font-size: 0.6875rem;
  }

  .lyric-empty small {
    color: var(--faint);
    font-size: 0.625rem;
  }

  .progress-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .time {
    flex: none;
    width: 2.1rem;
    font-size: 0.625rem;
    color: var(--faint);
    font-variant-numeric: tabular-nums;
  }

  .time:last-child {
    text-align: right;
  }

  .progress,
  .volume {
    height: 0.75rem;
    margin: 0;
    appearance: none;
    background: transparent;
    cursor: pointer;
  }

  .progress {
    flex: 1 1 auto;
  }

  .progress::-webkit-slider-runnable-track {
    height: 0.1875rem;
    border-radius: 999px;
    background: linear-gradient(90deg, var(--text) var(--progress), var(--border-strong) var(--progress));
  }

  .progress::-moz-range-track {
    height: 0.1875rem;
    border-radius: 999px;
    background: var(--border-strong);
  }

  .progress::-moz-range-progress {
    height: 0.1875rem;
    border-radius: 999px;
    background: var(--text);
  }

  .progress::-webkit-slider-thumb,
  .volume::-webkit-slider-thumb {
    width: 0.625rem;
    height: 0.625rem;
    margin-top: -0.2188rem;
    appearance: none;
    border-radius: 999px;
    background: var(--text);
  }

  .progress::-moz-range-thumb,
  .volume::-moz-range-thumb {
    width: 0.625rem;
    height: 0.625rem;
    border: 0;
    border-radius: 999px;
    background: var(--text);
  }

  .controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.625rem;
  }

  .ctl {
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 999px;
    color: var(--muted);
  }

  .ctl:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  .play {
    display: grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 999px;
    background: var(--text);
    color: var(--bg);
    transition: transform var(--dur-ui) var(--ease-out);
  }

  .play:hover {
    transform: scale(1.05);
  }

  .play:active {
    transform: scale(0.96);
  }

  .volume-wrap {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-left: auto;
    color: var(--faint);
  }

  .volume {
    width: 3.25rem;
  }

  .volume::-webkit-slider-runnable-track,
  .volume::-moz-range-track {
    height: 0.1875rem;
    border-radius: 999px;
    background: var(--border-strong);
  }

  .volume::-webkit-slider-thumb {
    margin-top: -0.2188rem;
  }

  .notice {
    margin: 0;
    font-size: 0.625rem;
    color: var(--muted);
  }

  .notice.bad {
    color: var(--critical);
  }

  .playlist {
    display: flex;
    flex-direction: column;
    max-height: 8rem;
    overflow-y: auto;
    margin: 0;
    padding: 0.25rem 0;
    border-top: 1px solid var(--border);
    list-style: none;
  }

  .playlist li {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .playlist li.active .pick {
    color: var(--text);
  }

  .pick {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex: 1 1 auto;
    min-width: 0;
    padding: 0.25rem 0.375rem;
    border-radius: 0.375rem;
    color: var(--muted);
    font-size: 0.6875rem;
    text-align: left;
  }

  .pick:hover {
    background: var(--surface-2);
    color: var(--text);
  }

  .dot {
    flex: none;
    width: 0.3125rem;
    height: 0.3125rem;
    border-radius: 999px;
    background: var(--border-strong);
  }

  .active .dot {
    background: var(--focus);
  }

  .pick-name {
    overflow: hidden;
    flex: 1 1 auto;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .badge {
    flex: none;
    padding: 0 0.25rem;
    border-radius: 0.25rem;
    background: var(--surface-3, var(--surface-2));
    color: var(--focus);
    font-size: 0.5625rem;
    letter-spacing: 0.02em;
  }

  .pick-time {
    flex: none;
    color: var(--faint);
    font-size: 0.5625rem;
    font-variant-numeric: tabular-nums;
  }

  .remove {
    flex: none;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 0.375rem;
    color: var(--faint);
    font-size: 0.875rem;
    line-height: 1;
  }

  .remove:hover {
    background: var(--surface-2);
    color: var(--critical);
  }

  .hidden {
    display: none;
  }
</style>
