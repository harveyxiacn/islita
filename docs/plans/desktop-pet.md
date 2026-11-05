# Desktop pet (island plugin) — MVP and phase 2 plan

Status: the island panel is shipped as the `pet` plugin; the detached
always-on-top window in phase 2 is still a plan.

## Scope

The MVP is a local-only companion inside the existing island panel. It is not a
second desktop window yet. It provides:

- an original built-in mascot, **Mochi** (a mochi-bean with a sprout, drawn as
  inline SVG), plus two bundled sticker-card skins from character artwork
  supplied by the project owner: **DeepSeek 大肥鱼** (switchable Q版 chibi and
  变身 transformed forms) and **Hachiware**;
- fullness, mood and energy needs that decay with elapsed time;
- feed, play, rest and pat interactions, XP, levels and a short reaction line;
- original character-voice lines driven by quota, provider and pet needs, shown
  in the panel and beside a ring's quota popover, plus an unread dot on the
  pet's island rail icon;
- a one-image import path for the user's own PNG/WebP/GIF sprite, which takes
  precedence over the selected skin;
- debounced persistence in the plugin's localStorage entry (`island.plugin.pet`).

There is no network request, audio, telemetry, account or model call. Imported
images never leave the machine. The panel uses the island's existing tokens and
fixed-height regions so interactions do not resize the capsule unexpectedly.

## Data model

Everything lives in one versioned object, stored with `writePluginState('pet',
state)`:

```jsonc
{
  "version": 1,
  "name": "Mochi",       // 1–20 characters, whitespace collapsed
  "level": 1,            // 1–99
  "xp": 0,               // XP inside the current level
  "fullness": 82,        // 0–100
  "mood": 76,            // 0–100
  "energy": 70,          // 0–100
  "skin": "mochi",       // mochi | deepseek | hachiware
  "deepseekForm": "chibi", // chibi | transformed (DeepSeek only)
  "lastSeen": 1760000000000,
  "sprite": null         // or the object described below
}
```

`parsePetState` is deliberately forgiving: missing fields use defaults, numbers
are clamped, invalid names, skins, forms and sprites are dropped, future
`lastSeen` values are pinned to now, and non-object JSON becomes a fresh pet. The storage helpers
already swallow disabled/quota errors; the panel also verifies the sprite write
so a too-large import can be rejected instead of appearing to succeed.

### Simulation

| Need | Decay/hour | Fed by |
|---|---:|---|
| Fullness | 6 | Feed +26 |
| Mood | 3 | Play +22, pat +10, feed +4, rest +3 |
| Energy | 4 | Rest +28 |

Play costs 12 energy and 4 fullness, rest costs 2 fullness, and feed costs
1 energy. Offline decay is capped at 12 hours so a weekend away does not erase
the pet. An absence of at
least five minutes shows the localized "missed you" reaction once when the panel
opens. While mounted, a 30-second tick advances needs; `lastSeen` is persisted
on interactions, name/sprite changes, and panel unmount (writes are debounced).

Expression is derived, not stored. Priority: `hungry` (fullness < 30), `tired`
(energy < 30), `bored` (mood < 40), `happy` (fullness ≥ 70, mood ≥ 65, energy ≥
60), otherwise `ok`. The same status drives the built-in face and the localized
`plugin.pet.status.*` chip.

XP per level is `80 + (level - 1) × 40`. Feed 8, play 12, rest 6, pat 4 XP;
excess XP carries through multiple level-ups. Every action has a 1.2–3.2 second
UI cooldown, and its button is disabled during it.

## Speech and the rail dot

`src/lib/pet/speech.ts` is pure and shared by the pet panel and the ring
popover. `petSituation(snapshot, settings, pet)` picks the island-wide line:
polling paused wins, then a critical window, a provider that cannot be reached,
a warning window, a forecast that runs out before reset, and finally the pet's
own needs (`hungry`, `tired`, `bored`, `happy`, `ok`). `quotaSituation(quota,
settings)` is the per-provider variant used in a popover: critical, then
provider down, warning, forecast, and `ok`. Action reactions (`feed`, `play`,
`rest`, `pat`) and the one-time `offline` "missed you" line override the
current situation for a few seconds.

Lines are i18n keys under `plugin.pet.say.<voice>.<situation>`; the voice is
`mochi`, `deepseek-chibi`, `deepseek-transformed` or `hachiware`, so switching
DeepSeek's form changes the character's voice as well as its cards. They are
original character-voice writing inspired by the supplied artwork and public
catchphrases, not transcriptions of dialogue.

`src/lib/pet/speech.svelte.ts` holds the latest island-wide event, its age (a
line older than 10 minutes is no longer shown) and an `unread` flag.
`src/routes/+page.svelte` notes `warn`, `critical` and `reset` ring events
(when the pet has been saved), a provider that changes from `ok` to a failing
status, and each `task-completed` event. A new event raises the dot on the pet
icon in the island rail; `PetPanel.svelte` calls `seen()` while it is mounted,
clearing it. The pet panel may show a newer island-wide event while a ring's
popover speaks about that provider, but both use the same voice and line table.

## Sprite format for user images

- Accepted input: PNG, WebP or GIF, at most 2 MiB, dimensions 8–4096 px.
- **Portrait:** any image not classified as a strip. One frame is shown.
- **Idle strip:** exactly four equal, square frames side by side in one image,
  aspect ratio 4:1 within 5% (for example 2048×512). Frames read left to right
  and are drawn with a stepped CSS animation (about 1.15 s per loop).
- Transparent backgrounds are recommended. Animated GIFs are accepted and the
  browser plays the GIF itself; a static GIF works as a portrait.
- The original file is converted with `FileReader` to a base64 data URL and kept
  in localStorage. It is validated again when loaded; invalid entries fall back
  to the built-in mascot. Selecting **Use the built-in mascot** removes it.

The 4:1 contract is intentionally explicit: there are no hidden frame counts,
atlas offsets or JSON sidecars. The docs shown in the panel say the same thing.

### Mapping a ComfyUI three-view sheet to frames

A three-view (front/side/back) character sheet is a reference, not an animation
atlas. Do not import it directly: a three-frame image is wider than a portrait
and will not match the four-frame contract. Instead:

1. Use the three-view image as a reference in the user's ComfyUI workflow
   (image-to-image, control image or character-sheet conditioning) with a fixed
   seed and consistent scale/pivot.
2. Generate four front-facing idle keyframes: neutral, blink, slight bob, and
   settle. Keep the same canvas, framing and transparent background.
3. Compose them left-to-right into one strip with four equal square cells (for
   example four 512×512 cells → 2048×512) and export PNG or WebP under 2 MiB.
4. Import the strip. It loops as the idle animation until another sprite is
   selected.

This step happens outside Islita. The app does not call an image model.

## Artwork provenance and licensing

The project owner supplied the derivative character artwork in `v-pet/` and
attests that it is authorised for commercial use. `scripts/prepare-pet-assets.py`
crops and trims those source images into the opaque, square WebP cards in
`static/pet/`; it writes only `static/pet/` and never modifies `v-pet/`. Keep
that provenance when adding or replacing a bundled skin, and do not introduce
artwork whose rights are unknown.

The speech lines in `src/lib/pet/speech.ts` and the i18n files are original
character-voice writing inspired by the supplied artwork and public
catchphrases. They are not transcriptions of dialogue from any work. Users
remain responsible for the images they import; the app only stores them
locally.

## Phase 2 — detached always-on-top pet window

The state/simulation modules (`src/lib/pet/pet.ts`, `src/lib/pet/sprite.ts`) are
pure and framework-free, so they can be reused by a dedicated window. The main
work is the native window and a shared persistence/sync path.

### Window

- Add a `pet` Tauri window: transparent, undecorated, always-on-top, not in the
  taskbar, initially small (roughly 180–260 logical px, scaled by DPI). Do not
  make it full-screen: a full-screen transparent window would block desktop
  interaction even where it looks empty.
- Start with the whole window interactive. True per-pixel click-through needs a
  platform window region; Tauri exposes `set_ignore_cursor_events` for the whole
  window, not an arbitrary shaped region. A second, small "interaction hotspot"
  window or temporarily ignoring cursor events while a modifier/shortcut is held
  are safer MVP designs than polling a hit mask. Keep the pet tightly cropped so
  transparent-pixel interception is limited.
- Provide tray/palette commands for show/hide, always-on-top and interaction
  mode. Escape or a global shortcut must restore interaction if the window is
  click-through.

### Position and monitors

- Persist `{ monitorId, monitorName, xRatio, yRatio, scale, edge? }` after a
  debounced move; store normalized coordinates as well as pixels.
- On start, find the saved monitor, clamp the pet to its work area (not the full
  bounds), and handle a removed monitor by falling back to the primary. Re-clamp
  on monitor hot-plug and DPI changes.
- Reuse the island's monitor parsing and work-area helpers where possible.
- Keep drag through the caption-less window but do not treat small pointer
  movements as a move when the user intended to pet.

### State sharing

The sidebar and dashboard windows do not reliably share `localStorage`, and the
island's storage module is per-viewer by design. For two simultaneously visible
pet surfaces, make the backend the source of truth (a small Tauri command/plugin
store holding the same versioned JSON) and broadcast updates with a Tauri event.
The detached window reuses `petStatus`, `advancePet`, `applyAction` and
`parsePetState`; only the persistence adapter changes. Migrate the imported
data URL once, enforce the same 2 MiB/parse guards in Rust, and never log the
image or its data URL.

### Idle CPU and power

- Pause simulation and rendering when the window is hidden, minimized or behind
  a full-screen app; resume on visibility/focus.
- Run the need tick once a minute, not per animation frame. Only write state at
  meaningful events and on a slow checkpoint; use debouncing.
- After a short idle period, stop the breathing/blink timeline and show a single
  static frame. Resume on hover or state change. Respect
  `prefers-reduced-motion` and an app-level reduced-motion setting.
- Let the native layer stop background repaints (and optionally sleep the
  webview) when the pet is fully hidden. Measure memory/CPU on Windows, macOS
  and Linux before shipping; avoid a permanent high-frequency JS timer.
- Keep the detached pet optional and off by default so users who only want the
  usage bar pay no extra window cost.

### Follow-up for the importer

If phase 2 adds per-pixel hit maps or multi-frame actions, store the original
image plus a small manifest (frame size, count, pivot, hit boxes) rather than
inventing metadata in localStorage. The four-frame format above remains the
simple import contract.

## Verification

- `npx playwright test --config=playwright.unit.config.ts tests/pet.unit.ts`
  covers decay, the offline cap, clamps, XP/level thresholds, status priority,
  corrupt-state repair, frame classification and import rejection.
- `tests/pet.e2e.ts` opens the island panel, checks the default mascot/stats and
  verifies that feeding updates the reaction line.
- `npx svelte-check --tsconfig ./tsconfig.json` covers the Svelte integration.
