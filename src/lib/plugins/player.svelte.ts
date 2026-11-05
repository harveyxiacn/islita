// Music player state shared by the island panel. [FRONTEND]
//
// The player survives closing the panel: the <audio> element lives in this
// module, not in the component, so the island can collapse while music keeps
// playing. Files are read through the File API and played from an object URL;
// nothing is uploaded and no path is sent to the backend.
//
// Object URLs are revoked when a track is removed or the list is cleared.
// Closing the app ends playback; the playlist itself is not persisted (object
// URLs do not survive a restart), so the panel says so instead of pretending.

import { parseLrc, type LrcDoc } from './lrc';
import { readPluginState, writePluginState } from '$lib/plugins/storage';

export interface Track {
  id: string;
  /** File name without its extension, shown in the player. */
  name: string;
  fileName: string;
  /** Object URL for this session only. */
  url: string;
  durationMs: number;
  lyrics: LrcDoc | null;
}

const AUDIO_EXTENSIONS = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba|webm)$/i;
const VOLUME_KEY = 'music.volume';

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

function initialVolume(): number {
  const value = readPluginState<number>(VOLUME_KEY, 0.8);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.8;
}

function makeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

class PlayerStore {
  tracks = $state<Track[]>([]);
  index = $state(-1);
  playing = $state(false);
  positionMs = $state(0);
  durationMs = $state(0);
  volume = $state(initialVolume());
  error = $state<string | null>(null);

  private audio: HTMLAudioElement | null = null;
  private pendingSeekMs: number | null = null;

  get current(): Track | null {
    return this.tracks[this.index] ?? null;
  }

  get hasNext(): boolean {
    return this.tracks.length > 1;
  }

  private ensureAudio(): HTMLAudioElement | null {
    if (typeof window === 'undefined') return null;
    if (this.audio) return this.audio;
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.volume = this.volume;
    audio.addEventListener('timeupdate', () => {
      this.positionMs = audio.currentTime * 1000;
    });
    audio.addEventListener('durationchange', () => {
      if (Number.isFinite(audio.duration)) this.durationMs = audio.duration * 1000;
    });
    audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(audio.duration)) this.durationMs = audio.duration * 1000;
      const track = this.current;
      if (track && this.durationMs > 0) track.durationMs = this.durationMs;
      if (this.pendingSeekMs !== null) {
        const target = this.pendingSeekMs;
        this.pendingSeekMs = null;
        audio.currentTime = Math.min(target / 1000, Math.max(0, audio.duration || target / 1000));
      }
    });
    audio.addEventListener('play', () => {
      this.playing = true;
    });
    audio.addEventListener('pause', () => {
      this.playing = false;
    });
    audio.addEventListener('ended', () => {
      this.playing = false;
      this.next(true);
    });
    audio.addEventListener('error', () => {
      this.playing = false;
      this.error = 'unplayable';
    });
    this.audio = audio;
    return audio;
  }

  /** Add audio files to the playlist; the first one is selected if idle. */
  addFiles(files: Iterable<File>): number {
    const added: Track[] = [];
    for (const file of files) {
      if (!AUDIO_EXTENSIONS.test(file.name) && !file.type.startsWith('audio/')) continue;
      const url = URL.createObjectURL(file);
      added.push({
        id: makeId(),
        name: stripExtension(file.name) || file.name,
        fileName: file.name,
        url,
        durationMs: 0,
        lyrics: null,
      });
    }
    if (added.length === 0) return 0;
    this.tracks = [...this.tracks, ...added];
    if (this.index === -1) this.select(this.tracks.length - added.length, false);
    return added.length;
  }

  select(index: number, autoplay = true): void {
    if (index < 0 || index >= this.tracks.length) return;
    const audio = this.ensureAudio();
    const track = this.tracks[index];
    this.index = index;
    this.positionMs = 0;
    this.durationMs = track.durationMs;
    this.error = null;
    this.pendingSeekMs = null;
    if (!audio) return;
    audio.src = track.url;
    audio.load();
    if (autoplay) void this.play();
    else this.playing = false;
  }

  async play(): Promise<void> {
    const audio = this.ensureAudio();
    if (!audio || !this.current) return;
    if (!audio.src) audio.src = this.current.url;
    try {
      await audio.play();
      this.error = null;
    } catch {
      // Autoplay policies and unreadable files land here. The panel shows a
      // play button either way; an unreadable file also fires `error`.
      this.playing = false;
    }
  }

  pause(): void {
    this.audio?.pause();
    this.playing = false;
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  seek(ms: number): void {
    const clamped = Math.max(0, Math.min(ms, this.durationMs || ms));
    this.positionMs = clamped;
    const audio = this.ensureAudio();
    if (!audio) return;
    if (audio.readyState === 0) {
      this.pendingSeekMs = clamped;
      return;
    }
    audio.currentTime = clamped / 1000;
  }

  next(autoplay = this.playing): void {
    if (this.tracks.length === 0) return;
    this.select((this.index + 1) % this.tracks.length, autoplay);
  }

  prev(autoplay = this.playing): void {
    if (this.tracks.length === 0) return;
    this.select((this.index - 1 + this.tracks.length) % this.tracks.length, autoplay);
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.audio) this.audio.volume = this.volume;
    writePluginState(VOLUME_KEY, this.volume);
  }

  /** Attach a parsed LRC document to the current track. */
  attachLyrics(source: string): boolean {
    const track = this.current;
    if (!track) return false;
    const doc = parseLrc(source);
    track.lyrics = doc;
    // The metadata tags are more trustworthy than the file name, but never
    // replace a playlist entry's name with an empty tag. The artist stays a
    // separate field so re-attaching a file cannot stack prefixes.
    if (doc.title.trim()) track.name = doc.title.trim();
    this.tracks = [...this.tracks];
    return doc.lines.length > 0;
  }

  /** Match a set of `.lrc` files to tracks by base name; unused files go to
   *  the current track, which is the common "one song, one lyric file" case. */
  addLyricsFiles(files: Iterable<File>): Promise<number> {
    return (async () => {
      let attached = 0;
      for (const file of files) {
        if (!/\.lrc$/i.test(file.name)) continue;
        const base = stripExtension(file.name).toLowerCase();
        const match = this.tracks.findIndex((track) => stripExtension(track.fileName).toLowerCase() === base);
        const target = match >= 0 ? match : this.index;
        if (target < 0) continue;
        const previous = this.index;
        this.index = target;
        if (this.attachLyrics(await file.text())) attached += 1;
        this.index = previous;
      }
      return attached;
    })();
  }

  remove(index: number): void {
    const track = this.tracks[index];
    if (!track) return;
    URL.revokeObjectURL(track.url);
    const wasCurrent = index === this.index;
    const nextTracks = this.tracks.filter((_, i) => i !== index);
    if (nextTracks.length === 0) {
      this.clear();
      return;
    }
    if (wasCurrent) {
      const nextIndex = Math.min(index, nextTracks.length - 1);
      this.tracks = nextTracks;
      this.select(nextIndex, false);
    } else {
      this.tracks = nextTracks;
      if (index < this.index) this.index -= 1;
    }
  }

  clear(): void {
    this.audio?.pause();
    if (this.audio) this.audio.removeAttribute('src');
    for (const track of this.tracks) URL.revokeObjectURL(track.url);
    this.tracks = [];
    this.index = -1;
    this.playing = false;
    this.positionMs = 0;
    this.durationMs = 0;
    this.error = null;
  }
}

export const player = new PlayerStore();
