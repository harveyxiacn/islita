# Pet themes and imported DyberPet packs

Islita's desktop pet has three hand-drawn scenes and can also wear characters
made for [DyberPet](https://github.com/DyberPet/DyberPet). Both are chosen in
**Dashboard -> Plugins -> Desktop pet**; neither adds a settings key, because
the choice belongs to the pet and is stored with its state in this device's
plugin storage.

## Built-in scenes

Each bundled character has a scene drawn for it. `auto` follows the selected
character; an explicit pick stays even when you change the character.

| Theme | Scene | Default for |
|---|---|---|
| `auto` | Follows the character | all characters |
| `matcha` | Sunny picnic | Mochi (麻薯) |
| `abyss` | Lantern-lit seabed | DeepSeek 大肥鱼 |
| `aquarium` | Bright fish tank | Hachiware (小八) |

The scene paints the pet panel and the detached pet window (aura, speech bubble
and ground shadow). It does not affect the island or the rest of the app.

## Importing a DyberPet pack

1. Open **Dashboard -> Plugins -> Desktop pet**.
2. Under **Pet pack**, choose **Import DyberPet pack**.
3. Pick the character's *role folder*: the folder that directly contains
   `pet_conf.json` and `act_conf.json` (for example
   `DyberPet/res/role/Kitty`), not the `res` or `role` directory above it.
4. The pack appears in the list and is shown immediately. Use the select to
   switch back to **Built-in art**, or **Remove** to delete the imported copy.

Importing copies the folder into the app's data directory; the original folder
is never modified or moved. Importing the same character twice creates a second
copy with a numbered id (`kitty-2`), so both can be removed independently.

Storage location (`<data dir>` is the app's per-user data directory):

| OS | Imported packs |
|---|---|
| Linux | `~/.local/share/io.github.harveyxiacn.islita/pet-packs/` |
| macOS | `~/Library/Application Support/io.github.harveyxiacn.islita/pet-packs/` |
| Windows | `%LOCALAPPDATA%\io.github.harveyxiacn.islita\pet-packs\` |

Packs are available in the desktop app only; the browser preview keeps the
built-in art. A custom sprite still has the highest priority: while one is set,
the panel says the pack is overridden, and resetting the sprite reveals the pack
again.

## What a pack needs

```
Kitty/
├── pet_conf.json      character defaults, random acts, pat reactions
├── act_conf.json      animation definitions, keyed by act name
├── action/            numbered frames, SVG is not used
│   ├── stand_0.png
│   ├── stand_1.png
│   ├── leftwalk_0.png
│   └── ...
└── info/              optional
    ├── info.json      petName, author, …
    └── pfp.png        portrait used in the pack list
```

Only the files above are copied. Accessories, sub-pets, items, sounds, the LLM
chat configuration and Python code in a DyberPet installation are not read and
are not executed.

### `act_conf.json`

Each key is an act name. The fields Islita uses:

| Field | Meaning |
|---|---|
| `images` | Frame prefix; frames are `action/<images>_<digits>.<png|webp|gif|jpg|jpeg>` |
| `act_num` | How many times the **whole frame list** repeats (default 1, clamped 1-100) |
| `need_move` | The act is a walking act |
| `direction` | `"left"` or `"right"`; lets the player reuse the matching art |
| `frame_move` | Movement per frame in pack pixels (kept for compatibility) |
| `frame_refresh` | Seconds per frame (clamped 0.04-10) |
| `anchor` | Offset from the pet's bottom centre (kept for compatibility) |

Frames are sorted by their numeric suffix, not by file name or directory
order, so `_2` comes before `_10`. An act with no matching image is dropped.
If a directional walk act is missing, the player mirrors the other direction.

### `pet_conf.json`

Islita reads these keys:

| Key | Meaning |
|---|---|
| `default`, `left`, `right` | Idle and direction poses |
| `drag`, `prefall`, `fall`, `on_floor` | Poses while dragged, falling and after landing |
| `random_act` | Idle behaviour list; see below |
| `patpat` | Act shown when the pet is petted: one act name for every fullness tier, or an object keyed `"0"`-`"3"` |

Missing or invalid act names fall back to the pack's first usable act. A pack
without any usable act is rejected at import.

### Random idle acts

Each `random_act` entry has `name`, `act_list`, `act_prob` and `act_type`.
`act_type` is `[minimum fullness tier, minimum friendship level]`;
`act_type[0] == 10000` marks an internal entry and is never chosen.

The selection mirrors DyberPet:

* Fullness tiers are `0` (below 50), `1` (50-79), `2` (80-99) and `3` (100),
  mapped from the pet's fullness need.
* Before picking, a tier gate applies: tier 3 has a 50 % chance, tier 2 25 %,
  tier 1 12.5 %, tier 0 always tries.
* At tier 0 only entries with `act_type[0] == 0` qualify. At the other tiers an
  entry's weight is `act_prob * 0.25^|act_type[0] - tier|`; entries with
  `act_type[0] == 0` are excluded.
* An entry is skipped when `act_type[1]` is above the pet's friendship level,
  which Islita derives from the pet's level.

When nothing qualifies, the pet plays its default pose. `phase`, `sound` and
`effect` are accepted as data but not used.

## Priority and persistence

The pet draws, from highest to lowest:

1. a custom portrait / 4:1 strip imported in the panel;
2. the selected DyberPet pack;
3. the bundled art for the selected character.

The selected theme and pack id live in the pet state (localStorage key
`island.plugin.pet`), are shared between the island and the detached pet window,
and survive restarts. Removing a pack that is currently selected makes the pet
fall back to the bundled art; the panel says so until another pack is chosen.
Selecting a bundled character clears the pack choice.

## Limits and safety

* A pack id is a lowercase slug of at most 64 characters; the importer derives
  it from the character name and never trusts a path from JSON.
* At most 3,500 image files, 192 MB in total and 24 MB per frame. A
  `pet_conf.json` / `act_conf.json` over 2 MB, a frame count over 500 per act or
  an act count over 250 is refused or truncated.
* Only regular files directly inside `action/` and flat files in `info/` are
  copied. Symlinks, subdirectories and unknown extensions are skipped, and no
  pack path can escape the `pet-packs` root.
* JSON is parsed as data, never executed. Images are served to the webview
  through Tauri's asset protocol, whose scope is limited to `pet-packs`.
* The original folder is read-only for Islita. Removing an imported pack only
  deletes the copy under the app data directory.

## Licensing

Islita is MIT-licensed. DyberPet is GPL-3.0. Islita does **not** bundle
DyberPet code, its characters or any other GPL asset; this feature is an
independent reader for the on-disk format that runs only on files the user
imports. Packs keep whatever licence their authors gave them; check it before
redistributing one. The built-in scenes and the three bundled characters are
Islita's own artwork.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| “This folder is not a DyberPet role” | Pick the folder that directly contains both JSON files |
| Import button is missing | Packs need the desktop app, not the browser preview |
| Pet shows built-in art although a pack is selected | A custom sprite overrides the pack, or the pack folder was deleted; the panel shows which |
| Some animations never play | Their `images` prefix has no matching frame in `action/`, or their act was filtered out |
| A mirrored walk looks wrong | The pack has only one walk direction and no `direction` field; draw the other direction for exact art |
