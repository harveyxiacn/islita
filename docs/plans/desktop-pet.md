# Desktop pet (island plugin + detached window)

Status: shipped. The island panel is the `pet` plugin; the detached
always-on-top window (`route /pet`, window label `pet`) and its full-body art
are in v0.9.0. `petOnDesktop` is opt-in and off by default.

## Scope

The MVP is a local-only companion inside the existing island panel. The
detached window below is the second surface; both are backed by the same state.
It provides:

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

## Detached window (shipped)

`petOnDesktop` (default `false`) adds a `pet` Tauri window: transparent,
frameless, always on top, skipped in the taskbar, `focus: false` and
`set_focusable(false)` so petting never steals focus from the user's work.
`petRoam` (default `true`) lets it wander along the current monitor's
work-area floor. The window is created at startup and stays hidden until the
page has loaded and the setting is on.

### Why 2D sprites, not 3D

The supplied characters are flat, chibi 2D art. A 3D route (image-to-3D such as
Trellis/Pixal, then three.js) was evaluated and rejected for this release:
segmentation and retopology would lose the drawn faces and clothing detail,
the chibi proportions read worse from arbitrary angles, a transparent WebView2
overlay would need a full WebGL context awake for a small always-on-top
companion, and the result still needs a rig to walk. Transparent WebP frames
plus small transform animations (bob, sway, hop, dangle) keep the original art
crisp at every DPI, cost one decoded image per pose, and need no graphics
runtime. `image2threejs`-style pipelines are a reasonable future path for an
original 3D mascot, not for preserving this 2D character art. The island
`mochi` skin stays an inline SVG and has no raster set.

### Window and motion (`src-tauri/src/window/pet.rs`)

- Logical size `240 × 300 × settings.scale` CSS px; physical size multiplies by
  the display's device-pixel ratio. Position is kept in virtual logical
  coordinates and clamped inside the monitor's **work area** (excluding
  taskbars/docks), with an 8 px margin.
- A Rust loop ticks every 33 ms. It only moves the window while
  `petOnDesktop && petRoam && roamAllowed && !dragging`; it picks walk segments
  and pauses at random, turns at the work-area edges, and gently falls back to
  the floor if the window was left above it (for example after a monitor
  change). It emits `pet-motion` (`{moving, dir, falling, x, y}`) so the page
  only needs to swap the sprite. Keeping the loop in Rust avoids a per-frame
  IPC call and is not subject to OS throttling of an unfocused webview.
- The page drags with pointer capture and `pet_move_by` (rAF-batched), so a
  click without movement is still a pat. `pet_set_dragging` stops the wander
  loop; releasing it adds a 600 ms settle pause. The last position is stored in
  `island.pet.desktop.position` and passed to `pet_ready` at startup; invalid or
  off-screen values are clamped by the platform layer.
- While the pointer is over the pet, a menu is open, or the pet is asleep, the
  page vetoes roaming with `pet_set_roaming`. Sleeping is derived
  (`shouldSleep`): energy below 22 or three quiet minutes; interacting wakes it.
- `prefers-reduced-motion` keeps the window's real movement but removes the
  decorative bob/hop/dangle loops.

Interaction: click = pat, drag = move, right-click = a compact menu with
Feed / Play / Rest / Pet, a Wander toggle (`petRoam`), Settings… and Hide from
desktop (`petOnDesktop=false`). The menu closes on an outside pointer-down,
pointer-leave, Escape or after another interaction; the window is deliberately
not focusable, so blur is not available. Speech bubbles use the existing
situation lines and are readable over any wallpaper (dark or light theme).

### Art pipeline

`static/pet/desktop/` holds 13 transparent full-body WebP sprites: DeepSeek
chibi (idle, walk, sleep, happy, drag), DeepSeek transformed (idle, walk,
sleep, happy; drag reuses idle) and Hachiware (idle, walk, sleep, happy; drag
reuses idle). They were produced locally, with no network model call from the
app:

1. Use the owner-supplied `v-pet/` derivative artwork as the character
   reference. With local ComfyUI's Qwen Image 2.1 edit (`UNETLoader` +
   `QwenImage21Cache` + `TextEncodeQwenImage21`, cfg 1, euler/simple, 25 steps),
   re-render a full-body standing character on a pure green background,
   preserving the design. Autogrow inputs use dotted API keys
   (`"images.image_1"`), not a nested dict.
2. Cut out with BiRefNet (`LoadBackgroundRemovalModel` →
   `RemoveBackground` → `InvertMask` → `JoinImageWithAlpha`); its mask is
   inverted. Flood-fill/chroma keying was tried first and failed on white
   clothing and green-tinted interior shading.
3. Despill the green fringe, erode and feather the alpha by about 1 px, trim
   the transparent margins, then export WebP (max side 480 px, ~20–55 KB).
4. Poses were generated as separate edits (neutral, three-quarter walk, lying
   sleep, arms-up happy, dangling) from the same reference; no atlas or
   sidecar metadata is involved.

The same pipeline can add skins; keep the source provenance and do not add
artwork whose rights are unknown. The user's own imported sprite (portrait or
4:1 four-frame strip) takes precedence in both the panel and the detached
window.

### State sharing

Both surfaces use the same versioned JSON in the `island.plugin.pet`
localStorage entry and the pure `parsePetState` / `advancePet` / `applyAction`
functions. Every action writes the state immediately. The detached window also
emits `pet-state {state, action}` to the sidebar so a mounted pet panel can
adopt it and the island can note the speech line; the panel emits the same
event to the pet window after its own changes. Receivers compare `lastSeen`
and only adopt a strictly newer state, so an echoed copy cannot undo a newer
one. A `pet-state-request` on startup covers a platform where the two webviews
do not share plugin storage; a `storage` listener covers the common shared
case. Nothing is written to the backend, no credential is read, and the data
URL is never logged.

The island forwards its own detected `warn` / `critical` / `reset` /
`providerDown` / `taskDone` events to the pet window as `pet-event` when
`petOnDesktop` is on. The pet page also listens to the backend's
`task-completed` event directly, so it still speaks when the island window was
never opened.

### Cost

The pet window is created at startup regardless, but it is hidden and the
wander loop returns immediately while `petOnDesktop` is off. While visible,
the page advances needs every 30 s (persisting at most once a minute), the
backend loop emits at most every 450 ms when nothing changed, and the sprite
uses CSS animations only. The window is tightly cropped (240×300 at scale 1)
so its transparent corners take little desktop area; it is not click-through,
which is the one known interaction trade-off (true per-pixel hit regions are
not exposed by Tauri).

### Follow-ups

- Per-pixel click-through, if a platform hit-region API becomes available.
- Optional tray/palette commands for show/hide (the panel and context menu
  cover it today).
- A manifest for multi-frame action sprites if the importer grows beyond the
  portrait/4-frame contract.

## Verification

- `pnpm test` (Playwright unit config): `tests/pet.unit.ts` covers decay, the
  offline cap, clamps, XP/level thresholds, status priority, corrupt-state
  repair, frame classification and import rejection; `tests/pet-desktop.unit.ts`
  checks the sprite mapping against the files on disk, the Rust window constants,
  position parsing, actions, sleep and facing.
- `tests/pet.e2e.ts` opens the island panel, checks the default mascot/stats and
  verifies that feeding updates the reaction line.
- `tests/pet-desktop.e2e.ts` opens `/pet` in the browser preview, renders the
  saved DeepSeek/Hachiware/Mochi/custom sprite, pats, feeds from the context
  menu, verifies the persisted fullness, and toggles Wander.
- `cargo test --locked` covers the window clamp and random-range helpers;
  `cargo clippy --locked --all-targets -- -D warnings`, `pnpm check`,
  `pnpm check:i18n` and `pnpm check:agents` are part of the release gate.

