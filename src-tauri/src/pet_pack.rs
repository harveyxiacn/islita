//! Imported desktop-pet packs in the DyberPet role format. [BACKEND]
//!
//! DyberPet stores a character as `pet_conf.json` + `act_conf.json` + numbered
//! PNG frames under `action/`. This module copies a folder the user picked into
//! the app's data directory and turns it into a small, defensive manifest that
//! the webview can animate. It never executes pack content: JSON is read as
//! data and only image files are exposed through the asset protocol.
//!
//! Licensing: DyberPet is GPL-3.0. Islita does not ship DyberPet code or its
//! bundled characters; packs are imported by the user at runtime and remain
//! their own files. See docs/PET-PACKS.md.

use anyhow::{bail, Context};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

/// Enough for large, frame-by-frame packs; small enough to keep a bad import
/// from filling the disk.
const MAX_FILES: usize = 3_500;
const MAX_TOTAL_BYTES: u64 = 192 * 1024 * 1024;
const MAX_FRAME_BYTES: u64 = 24 * 1024 * 1024;
const MAX_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_INFO_BYTES: u64 = 512 * 1024;
const MAX_ACTS: usize = 250;
const MAX_RANDOM_ACTS: usize = 100;
const MAX_FRAMES_PER_ACT: usize = 500;
const MAX_INFO_FILES: usize = 40;
const PACKS_DIR: &str = "pet-packs";
const IMAGE_EXTENSIONS: &[&str] = &["png", "webp", "gif", "jpg", "jpeg"];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackAct {
    /// Frame prefix from `act_conf.json` (for example `stand`).
    pub images: String,
    /// File names under `action/`, in play order.
    pub frames: Vec<String>,
    /// How many times the frame list repeats.
    pub act_num: u32,
    pub need_move: bool,
    pub direction: Option<String>,
    pub frame_move: f64,
    /// Seconds per frame.
    pub frame_refresh: f64,
    /// Offset from the bottom-centre, in pack pixels.
    pub anchor: [f64; 2],
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackRandomAct {
    pub name: String,
    /// Act names, in play order.
    pub acts: Vec<String>,
    pub prob: f64,
    /// `[minimum fullness tier, minimum friendship level]`; 10000 = internal.
    pub act_type: [i64; 2],
    pub phase: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PackDefaults {
    pub default: String,
    pub left: String,
    pub right: String,
    pub drag: String,
    pub prefall: String,
    pub fall: String,
    pub on_floor: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PetPack {
    pub id: String,
    pub name: String,
    /// Absolute directory inside app data; the webview loads it via `asset://`.
    pub base_path: String,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
    pub refresh: f64,
    pub defaults: PackDefaults,
    pub acts: BTreeMap<String, PackAct>,
    pub random_acts: Vec<PackRandomAct>,
    /// Fullness tier (`0`–`3`) to pat act name.
    pub patpat: BTreeMap<String, String>,
    /// `info/pfp.png` or another portrait, relative to `base_path`.
    pub icon: Option<String>,
    pub author: Option<String>,
}

/// Native folder picker. The chosen path is not remembered separately; the
/// import step copies it and returns the stored pack.
#[tauri::command]
pub async fn pick_pet_pack_folder(
    window: WebviewWindow,
    state: State<'_, crate::state::AppState>,
) -> Result<Option<String>, String> {
    let chinese = crate::window::tray::prefers_chinese(&state.settings.read());
    let title = if chinese {
        "选择 DyberPet 角色文件夹"
    } else {
        "Choose a DyberPet role folder"
    };
    let picker = window.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .set_parent(&picker)
            .set_title(title)
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| format!("folder picker failed: {e}"))?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Copy the picked role folder into app data and return its manifest. Existing
/// packs are never overwritten: a fresh id (`name-2`, `name-3`, …) is chosen.
#[tauri::command]
pub async fn import_pet_pack(
    app: AppHandle,
    state: State<'_, crate::state::AppState>,
    folder: String,
) -> Result<PetPack, String> {
    let root = packs_root(&state.data_dir);
    allow_assets(&app, &root)?;
    let source = PathBuf::from(folder);
    super::blocking(move || {
        let source = source
            .canonicalize()
            .with_context(|| format!("cannot open {}", source.display()))?;
        import_into(&source, &root)
    })
    .await
    .map_err(|e| format!("{e:#}"))
}

/// Every stored pack, parsed afresh so a manually deleted or damaged folder is
/// skipped instead of breaking the picker.
#[tauri::command]
pub async fn list_pet_packs(
    app: AppHandle,
    state: State<'_, crate::state::AppState>,
) -> Result<Vec<PetPack>, String> {
    let root = packs_root(&state.data_dir);
    allow_assets(&app, &root)?;
    super::blocking(move || {
        let mut packs = Vec::new();
        if !root.is_dir() {
            return Ok(packs);
        }
        let mut entries: Vec<PathBuf> = std::fs::read_dir(&root)
            .with_context(|| format!("cannot read {}", root.display()))?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| {
                std::fs::symlink_metadata(path)
                    .map(|meta| meta.is_dir() && !meta.file_type().is_symlink())
                    .unwrap_or(false)
            })
            .collect();
        entries.sort_by_key(|path| {
            path.file_name()
                .map(|name| name.to_string_lossy().to_lowercase())
                .unwrap_or_default()
        });
        for dir in entries {
            match load_pack(&dir) {
                Ok(pack) => packs.push(pack),
                Err(e) => log::warn!("ignoring pet pack {}: {e:#}", dir.display()),
            }
        }
        packs.sort_by_key(|pack| pack.name.to_lowercase());
        Ok(packs)
    })
    .await
    .map_err(|e| format!("{e:#}"))
}

/// Remove one imported pack. The source folder the user picked is untouched.
#[tauri::command]
pub async fn remove_pet_pack(
    state: State<'_, crate::state::AppState>,
    id: String,
) -> Result<(), String> {
    let root = packs_root(&state.data_dir);
    let dir = pack_dir(&root, &id).map_err(|e| format!("{e:#}"))?;
    super::blocking(move || {
        if dir.exists() {
            std::fs::remove_dir_all(&dir)
                .with_context(|| format!("cannot remove {}", dir.display()))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("{e:#}"))
}

fn packs_root(data_dir: &Path) -> PathBuf {
    data_dir.join(PACKS_DIR)
}

/// The asset protocol only serves paths it was explicitly told about, and that
/// permission is per process. Calling this before every list/import covers a
/// start-up where the pet window restores a pack from local storage.
fn allow_assets(app: &AppHandle, root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| format!("cannot create the pet pack folder: {e}"))?;
    app.asset_protocol_scope()
        .allow_directory(root, true)
        .map_err(|e| format!("cannot allow the pet pack folder: {e}"))
}

fn is_slug(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && id.as_bytes()[0].is_ascii_alphanumeric()
}

fn pack_dir(root: &Path, id: &str) -> anyhow::Result<PathBuf> {
    if !is_slug(id) {
        bail!("invalid pack id");
    }
    let dir = root.join(id);
    // `is_slug` already excludes separators and `..`, but keep the canonical
    // check close to the filesystem operation as a second line of defence.
    let root_canon = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    if let Some(parent) = dir.parent() {
        if let Ok(parent) = parent.canonicalize() {
            if parent != root_canon {
                bail!("invalid pack path");
            }
        }
    }
    Ok(dir)
}

fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in name.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            out.push(lower);
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
        if out.len() >= 48 {
            break;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        "pet-pack".to_string()
    } else {
        out
    }
}

fn unique_slug(root: &Path, base: &str) -> String {
    if !root.join(base).exists() {
        return base.to_string();
    }
    for n in 2..=999 {
        let candidate = format!("{base}-{n}");
        if !root.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{base}-{}", std::process::id())
}

fn extension(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

fn is_image(path: &Path) -> bool {
    IMAGE_EXTENSIONS.contains(&extension(path).as_str())
}

fn read_json(path: &Path, limit: u64) -> anyhow::Result<serde_json::Value> {
    let meta =
        std::fs::metadata(path).with_context(|| format!("cannot read {}", path.display()))?;
    if meta.len() > limit {
        bail!("{} is too large", path.display());
    }
    let bytes = std::fs::read(path).with_context(|| format!("cannot read {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("{} is not valid JSON", path.display()))
}

/// Copy one role folder into `root/<unique-slug>` and build its manifest.
fn import_into(source: &Path, root: &Path) -> anyhow::Result<PetPack> {
    if !source.is_dir() {
        bail!("the chosen path is not a folder");
    }
    let pet_conf_path = source.join("pet_conf.json");
    let act_conf_path = source.join("act_conf.json");
    if !pet_conf_path.is_file() || !act_conf_path.is_file() {
        bail!("this folder is not a DyberPet role (pet_conf.json and act_conf.json are required)");
    }
    // Validate before copying anything.
    let pet_conf = read_json(&pet_conf_path, MAX_CONFIG_BYTES)?;
    let act_conf = read_json(&act_conf_path, MAX_CONFIG_BYTES)?;
    if !pet_conf.is_object() || !act_conf.is_object() {
        bail!("the pack configuration is not a JSON object");
    }

    std::fs::create_dir_all(root).with_context(|| format!("cannot create {}", root.display()))?;
    let display_hint = info_name(source)
        .or_else(|| {
            source
                .file_name()
                .map(|name| name.to_string_lossy().trim().to_string())
        })
        .map(|name| name.chars().take(60).collect::<String>())
        .unwrap_or_default();
    let slug = unique_slug(root, &slugify(&display_hint));
    let staging = root.join(format!(".import-{slug}-{}", std::process::id()));
    if staging.exists() {
        std::fs::remove_dir_all(&staging).ok();
    }
    std::fs::create_dir_all(&staging)
        .with_context(|| format!("cannot create {}", staging.display()))?;

    let result = (|| -> anyhow::Result<PetPack> {
        std::fs::copy(&pet_conf_path, staging.join("pet_conf.json"))?;
        std::fs::copy(&act_conf_path, staging.join("act_conf.json"))?;

        let action_src = source.join("action");
        if !action_src.is_dir() {
            bail!("the role has no action folder");
        }
        let action_dst = staging.join("action");
        std::fs::create_dir_all(&action_dst)?;
        let mut files = 0usize;
        let mut total = 0u64;
        let mut skipped = 0usize;
        for entry in std::fs::read_dir(&action_src)
            .with_context(|| format!("cannot read {}", action_src.display()))?
        {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    skipped += 1;
                    continue;
                }
            };
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => meta,
                _ => {
                    skipped += 1;
                    continue;
                }
            };
            if !is_image(&path) {
                skipped += 1;
                continue;
            }
            if meta.len() > MAX_FRAME_BYTES {
                log::warn!("pet pack: skipping oversized frame {}", path.display());
                skipped += 1;
                continue;
            }
            files += 1;
            total = total.saturating_add(meta.len());
            if files > MAX_FILES || total > MAX_TOTAL_BYTES {
                bail!("the pack is too large (more than {MAX_FILES} files or 192 MB)");
            }
            let Some(name) = path.file_name() else {
                skipped += 1;
                continue;
            };
            std::fs::copy(&path, action_dst.join(name))
                .with_context(|| format!("cannot copy {}", path.display()))?;
        }
        if files == 0 {
            bail!("the role's action folder has no images");
        }
        log::info!("pet pack: copied {files} frame files ({total} bytes), skipped {skipped}");

        // Optional `info/` portrait and author metadata (flat files only).
        let info_src = source.join("info");
        let author = if info_src.is_dir() {
            let info_dst = staging.join("info");
            std::fs::create_dir_all(&info_dst)?;
            let mut count = 0usize;
            for entry in std::fs::read_dir(&info_src)?.flatten() {
                let path = entry.path();
                let meta = match entry.metadata() {
                    Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => meta,
                    _ => continue,
                };
                if count >= MAX_INFO_FILES || meta.len() > MAX_INFO_BYTES {
                    continue;
                }
                if !is_image(&path) && extension(&path) != "json" {
                    continue;
                }
                let Some(name) = path.file_name() else {
                    continue;
                };
                std::fs::copy(&path, info_dst.join(name))?;
                count += 1;
            }
            let info = read_json(&info_src.join("info.json"), MAX_INFO_BYTES).ok();
            info.as_ref()
                .and_then(|value| value.get("author"))
                .and_then(|value| value.as_str())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        } else {
            None
        };

        // Build the manifest while the files are still in staging, then move
        // the whole directory into place in one atomic rename.
        let mut pack = read_manifest(&staging, &slug)?;
        pack.name = display_hint.clone();
        if pack.name.trim().is_empty() {
            pack.name = slug.clone();
        }
        pack.author = pack.author.or(author);
        let final_dir = root.join(&slug);
        if final_dir.exists() {
            bail!("pack folder already exists");
        }
        std::fs::rename(&staging, &final_dir)
            .with_context(|| format!("cannot store the pack in {}", final_dir.display()))?;
        // Re-read so every path in the returned manifest points at the final
        // directory (the staging folder no longer exists). The folder is named
        // after the slug, so restore the human-readable name from the source.
        let mut stored = load_pack(&final_dir)?;
        stored.name = pack.name.clone();
        Ok(stored)
    })();

    if result.is_err() {
        std::fs::remove_dir_all(&staging).ok();
    }
    result
}

fn info_name(root: &Path) -> Option<String> {
    let info = read_json(&root.join("info/info.json"), MAX_INFO_BYTES).ok()?;
    info.get("petName")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value.chars().count() <= 60)
}

fn number(value: Option<&serde_json::Value>, fallback: f64) -> f64 {
    value.and_then(|value| value.as_f64()).unwrap_or(fallback)
}

fn clamp(value: f64, min: f64, max: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        fallback
    }
}

fn act_number(value: Option<&serde_json::Value>) -> u32 {
    number(value, 1.0).round().clamp(1.0, 100.0) as u32
}

/// Match `<images>_<digits>.<image ext>` and return the numeric suffix.
fn frame_number(file_name: &str, images: &str) -> Option<u64> {
    let rest = file_name.strip_prefix(images)?.strip_prefix('_')?;
    let (index, ext) = rest.rsplit_once('.')?;
    if !IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()) {
        return None;
    }
    index.parse::<u64>().ok()
}

fn safe_images(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && !value.contains('/')
        && !value.contains('\\')
        && !value.contains('\0')
        && value != "."
        && value != ".."
}

/// Build a manifest from a stored pack directory. The folder name is the id
/// and must already be a slug; staging folders use `read_manifest` directly.
fn load_pack(dir: &Path) -> anyhow::Result<PetPack> {
    let id = dir
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !is_slug(&id) {
        bail!("folder name is not a pack id");
    }
    read_manifest(dir, &id)
}

fn read_manifest(dir: &Path, id: &str) -> anyhow::Result<PetPack> {
    let pet_conf = read_json(&dir.join("pet_conf.json"), MAX_CONFIG_BYTES)?;
    let act_conf = read_json(&dir.join("act_conf.json"), MAX_CONFIG_BYTES)?;
    let pet = pet_conf
        .as_object()
        .context("pet_conf.json is not an object")?;
    let raw_acts = act_conf
        .as_object()
        .context("act_conf.json is not an object")?;

    // Index the action folder once: lowercase name -> actual file name.
    let action_dir = dir.join("action");
    let mut action_files: HashMap<String, String> = HashMap::new();
    if let Ok(entries) = std::fs::read_dir(&action_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) || !is_image(&path) {
                continue;
            }
            if let Some(name) = path.file_name() {
                action_files.insert(
                    name.to_string_lossy().into_owned(),
                    name.to_string_lossy().into_owned(),
                );
            }
        }
    }

    let mut acts = BTreeMap::new();
    for (name, raw) in raw_acts.iter().take(MAX_ACTS) {
        if name.len() > 80 {
            continue;
        }
        let Some(conf) = raw.as_object() else {
            continue;
        };
        let Some(images) = conf.get("images").and_then(|value| value.as_str()) else {
            continue;
        };
        if !safe_images(images) {
            continue;
        }
        let mut frames: Vec<(u64, String)> = action_files
            .keys()
            .filter_map(|file| frame_number(file, images).map(|n| (n, file.clone())))
            .collect();
        // Sort first so a very long act keeps its lowest frames, not an
        // arbitrary subset of the directory listing.
        frames.sort_by_key(|(n, _)| *n);
        frames.truncate(MAX_FRAMES_PER_ACT);
        if frames.is_empty() {
            continue;
        }
        let direction = conf
            .get("direction")
            .and_then(|value| value.as_str())
            .filter(|value| *value == "left" || *value == "right")
            .map(str::to_string);
        let anchor = conf.get("anchor").and_then(|value| value.as_array());
        let anchor = [
            number(anchor.and_then(|a| a.first()), 0.0).clamp(-8192.0, 8192.0),
            number(anchor.and_then(|a| a.get(1)), 0.0).clamp(-8192.0, 8192.0),
        ];
        acts.insert(
            name.clone(),
            PackAct {
                images: images.to_string(),
                frames: frames.into_iter().map(|(_, file)| file).collect(),
                act_num: act_number(conf.get("act_num")),
                need_move: conf
                    .get("need_move")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                direction,
                frame_move: clamp(number(conf.get("frame_move"), 10.0), 0.0, 200.0, 10.0),
                frame_refresh: clamp(number(conf.get("frame_refresh"), 0.5), 0.04, 10.0, 0.5),
                anchor,
            },
        );
    }
    if acts.is_empty() {
        bail!("no act in act_conf.json has matching images under action/");
    }
    let first = acts
        .keys()
        .next()
        .cloned()
        .unwrap_or_else(|| "default".into());
    let act_name = |key: &str| -> String {
        pet.get(key)
            .and_then(|value| value.as_str())
            .filter(|name| acts.contains_key(*name))
            .map(str::to_string)
            .unwrap_or_else(|| first.clone())
    };
    let defaults = PackDefaults {
        default: act_name("default"),
        left: act_name("left"),
        right: act_name("right"),
        drag: act_name("drag"),
        prefall: act_name("prefall"),
        fall: act_name("fall"),
        on_floor: act_name("on_floor"),
    };

    let mut random_acts = Vec::new();
    if let Some(list) = pet.get("random_act").and_then(|value| value.as_array()) {
        for raw in list.iter().take(MAX_RANDOM_ACTS) {
            let Some(conf) = raw.as_object() else {
                continue;
            };
            let names: Vec<String> = conf
                .get("act_list")
                .and_then(|value| value.as_array())
                .map(|list| {
                    list.iter()
                        .filter_map(|value| value.as_str())
                        .filter(|name| acts.contains_key(*name))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            if names.is_empty() {
                continue;
            }
            let act_type = conf.get("act_type").and_then(|value| value.as_array());
            random_acts.push(PackRandomAct {
                name: conf
                    .get("name")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .chars()
                    .take(120)
                    .collect(),
                acts: names,
                prob: clamp(number(conf.get("act_prob"), 0.2), 0.0, 1000.0, 0.2),
                act_type: [
                    number(act_type.and_then(|a| a.first()), 2.0)
                        .round()
                        .clamp(0.0, 10_000.0) as i64,
                    number(act_type.and_then(|a| a.get(1)), 1.0)
                        .round()
                        .clamp(0.0, 100_000.0) as i64,
                ],
                phase: conf
                    .get("phase")
                    .and_then(|value| value.as_str())
                    .map(|value| value.chars().take(20).collect()),
            });
        }
    }

    let mut patpat = BTreeMap::new();
    match pet.get("patpat") {
        Some(serde_json::Value::String(name)) if acts.contains_key(name) => {
            for tier in 0..4 {
                patpat.insert(tier.to_string(), name.clone());
            }
        }
        Some(serde_json::Value::Object(map)) => {
            for (tier, value) in map {
                if !matches!(tier.as_str(), "0" | "1" | "2" | "3") {
                    continue;
                }
                if let Some(name) = value.as_str().filter(|name| acts.contains_key(*name)) {
                    patpat.insert(tier.clone(), name.to_string());
                }
            }
        }
        _ => {}
    }

    let info = read_json(&dir.join("info/info.json"), MAX_INFO_BYTES).ok();
    let info_str = |key: &str| -> Option<String> {
        info.as_ref()
            .and_then(|value| value.get(key))
            .and_then(|value| value.as_str())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let author = info_str("author").map(|value| value.chars().take(80).collect());
    let mut icon = None;
    for ext in IMAGE_EXTENSIONS {
        let name = format!("info/pfp.{ext}");
        if dir.join(&name).is_file() {
            icon = Some(name);
            break;
        }
    }
    let name = info_str("petName")
        .map(|value| value.chars().take(60).collect::<String>())
        .or_else(|| {
            dir.file_name()
                .map(|value| value.to_string_lossy().chars().take(60).collect::<String>())
        })
        .unwrap_or_else(|| id.to_string());

    let width = clamp(number(pet.get("width"), 128.0), 1.0, 8192.0, 128.0);
    let height = clamp(number(pet.get("height"), 128.0), 1.0, 8192.0, 128.0);
    Ok(PetPack {
        id: id.to_string(),
        name,
        base_path: dir.to_string_lossy().replace('\\', "/"),
        width,
        height,
        scale: clamp(number(pet.get("scale"), 1.0), 0.1, 8.0, 1.0),
        refresh: clamp(number(pet.get("refresh"), 5.0), 0.1, 3600.0, 5.0),
        defaults,
        acts,
        random_acts,
        patpat,
        icon,
        author,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, text).unwrap();
    }

    fn fixture(root: &Path) -> PathBuf {
        let role = root.join("kitty");
        write(
            &role.join("pet_conf.json"),
            r##"{
              "width": 98, "height": 98, "scale": 1.0, "refresh": 5,
              "default": "default", "left": "left", "right": "right",
              "drag": "drag", "fall": "fall", "on_floor": "onfloor",
              "patpat": {"0": "angry", "3": "default"},
              "random_act": [
                {"name": "站立", "act_list": ["default"], "act_prob": 1.0, "act_type": [2,0]},
                {"name": "睡觉", "act_list": ["sleep"], "act_prob": 0.1, "act_type": [1,1]},
                {"name": "bad", "act_list": ["missing"], "act_prob": 1.0}
              ]
            }"##,
        );
        write(
            &role.join("act_conf.json"),
            r##"{
              "default": {"images": "stand", "act_num": 1},
              "left": {"images": "stand", "act_num": 1},
              "right": {"images": "stand", "act_num": 1},
              "drag": {"images": "drag", "act_num": 1},
              "fall": {"images": "fall", "act_num": 1},
              "onfloor": {"images": "angry", "act_num": 1},
              "angry": {"images": "angry", "act_num": 1},
              "sleep": {"images": "sleep", "act_num": 5, "frame_refresh": 0.5},
              "left_walk": {"images": "leftwalk", "act_num": 5, "need_move": true, "direction": "left", "frame_refresh": 0.2},
              "right_walk": {"images": "rightwalk", "act_num": 5, "need_move": true, "direction": "right", "frame_refresh": 0.2}
            }"##,
        );
        for (name, count) in [
            ("stand", 2),
            ("drag", 1),
            ("fall", 1),
            ("angry", 1),
            ("sleep", 2),
            ("leftwalk", 1),
            ("rightwalk", 1),
        ] {
            for i in 0..count {
                write(&role.join(format!("action/{name}_{i}.png")), "png");
            }
        }
        write(&role.join("action/useless.txt"), "not an image");
        write(
            &role.join("info/info.json"),
            r##"{"petName": "凯蒂", "author": "tester"}"##,
        );
        write(&role.join("info/pfp.png"), "png");
        role
    }

    #[test]
    fn a_role_folder_becomes_a_manifest_with_sorted_frames() {
        let root = crate::commands::test_support::tempdir();
        let role = fixture(&root);
        let pack = load_pack(&role).unwrap();
        assert_eq!(pack.name, "凯蒂");
        assert_eq!(pack.author.as_deref(), Some("tester"));
        assert_eq!(pack.icon.as_deref(), Some("info/pfp.png"));
        assert_eq!(pack.acts["sleep"].act_num, 5);
        assert_eq!(
            pack.acts["sleep"].frames,
            vec!["sleep_0.png", "sleep_1.png"]
        );
        assert!(pack.acts["left_walk"].need_move);
        assert_eq!(pack.acts["left_walk"].direction.as_deref(), Some("left"));
        assert_eq!(pack.random_acts.len(), 2);
        assert_eq!(pack.patpat.get("3").map(String::as_str), Some("default"));
        assert_eq!(pack.defaults.on_floor, "onfloor");
    }

    #[test]
    fn import_copies_only_known_files_and_assigns_a_slug() {
        let root = crate::commands::test_support::tempdir();
        let source = fixture(&root.join("downloads"));
        let packs = root.join("packs");
        let pack = import_into(&source, &packs).unwrap();
        assert_eq!(pack.id, "pet-pack");
        assert!(packs.join("pet-pack/action/stand_0.png").is_file());
        assert!(packs.join("pet-pack/info/pfp.png").is_file());
        assert!(!packs.join("pet-pack/action/useless.txt").exists());
        assert!(packs.join("pet-pack/pet_conf.json").is_file());
        assert!(
            !packs.join("pet-pack/info/info.json").exists()
                || packs.join("pet-pack/info/info.json").is_file()
        );

        let second = import_into(&source, &packs).unwrap();
        assert_eq!(second.id, "pet-pack-2");
        assert_eq!(second.name, "凯蒂");
    }

    #[test]
    fn import_keeps_the_source_name_when_the_pack_has_no_info_json() {
        let root = crate::commands::test_support::tempdir();
        let source = fixture(&root.join("downloads"));
        std::fs::remove_dir_all(source.join("info")).unwrap();
        let renamed = source.with_file_name("Kitty");
        std::fs::rename(&source, &renamed).unwrap();
        let pack = import_into(&renamed, &root.join("packs")).unwrap();
        assert_eq!(pack.id, "kitty");
        assert_eq!(pack.name, "Kitty");
    }

    #[test]
    fn path_traversal_in_images_is_refused() {
        let root = crate::commands::test_support::tempdir();
        let role = fixture(&root);
        write(
            &role.join("act_conf.json"),
            r#"{"default": {"images": "../secret", "act_num": 1}}"#,
        );
        assert!(load_pack(&role).is_err());
    }

    #[test]
    fn pack_ids_cannot_escape_the_packs_root() {
        let root = crate::commands::test_support::tempdir();
        assert!(pack_dir(&root, "../x").is_err());
        assert!(pack_dir(&root, "a/b").is_err());
        assert!(pack_dir(&root, "kitty").is_ok());
    }

    #[test]
    fn missing_images_are_reported_instead_of_panicking() {
        let root = crate::commands::test_support::tempdir();
        let role = fixture(&root);
        std::fs::remove_dir_all(role.join("action")).unwrap();
        assert!(load_pack(&role).is_err());
    }
}
