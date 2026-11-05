//! File drop station. [BACKEND]
//!
//! The island's drop plugin receives native drag-and-drop paths from Tauri,
//! never file contents from JavaScript. This module copies each regular file
//! into a private folder under the app's data directory:
//!
//!   <data>/dropbox/YYYY-MM-DD/<original name>
//!
//! Rules, all enforced here rather than in the UI:
//!   * regular files only — directories, devices and symlinks are skipped, so
//!     a dropped shortcut cannot make the app copy something else;
//!   * at most 20 files and 512 MiB per file per drop;
//!   * destination names are sanitised and never overwrite an existing file;
//!   * nothing is executed, opened or uploaded — a drop only copies bytes.
//!
//! The source path comes from the OS drop event, which is already within the
//! user's own permissions. We still validate it because a malformed event
//! must produce a per-file `skipped` entry, not a panic or a path traversal
//! into the dropbox tree.

use crate::state::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const MAX_FILES: usize = 20;
const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_LIST: usize = 12;
const MAX_NAME_CHARS: usize = 120;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub name: String,
    pub size: u64,
    pub saved_at: i64,
    /// Path relative to the dropbox root, with `/` separators.
    pub relative: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DropOutcome {
    pub saved: Vec<DroppedFile>,
    /// Basenames with a short reason; never the full source path.
    pub skipped: Vec<String>,
}

fn dropbox_root(data_dir: &Path) -> PathBuf {
    data_dir.join("dropbox")
}

fn day_folder(now_ms: i64) -> String {
    use chrono::{Local, TimeZone};
    match Local.timestamp_millis_opt(now_ms) {
        chrono::LocalResult::Single(t) => t.format("%Y-%m-%d").to_string(),
        _ => "undated".to_string(),
    }
}

/// A conservative cross-platform filename: no separators, control characters
/// or Windows-reserved punctuation, never `.`/`..`, and bounded in length.
fn safe_name(raw: &str) -> Option<String> {
    let base = raw.rsplit(['/', '\\']).next()?.trim();
    if base.is_empty() || base == "." || base == ".." {
        return None;
    }
    let mut out = String::with_capacity(base.len());
    for ch in base.chars() {
        if ch.is_control() || matches!(ch, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let out = out.trim_end_matches([' ', '.']).trim();
    if out.is_empty() {
        return None;
    }
    let mut bounded: String = out.chars().take(MAX_NAME_CHARS).collect();
    // Keep the extension when truncating a long name.
    if out.chars().count() > MAX_NAME_CHARS {
        if let Some(dot) = out.rfind('.') {
            let ext: String = out[dot..].chars().take(16).collect();
            let stem_len = MAX_NAME_CHARS.saturating_sub(ext.chars().count());
            bounded = out.chars().take(stem_len).collect::<String>() + &ext;
        }
    }
    Some(bounded)
}

fn split_name(name: &str) -> (String, String) {
    match name.rfind('.') {
        Some(dot) if dot > 0 => (name[..dot].to_string(), name[dot..].to_string()),
        _ => (name.to_string(), String::new()),
    }
}

fn unique_destination(dir: &Path, name: &str) -> PathBuf {
    let (stem, ext) = split_name(name);
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    for n in 2..=9999 {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem} (copy){ext}"))
}

fn relative_name(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// Copy one batch. Kept pure (a root path, a clock and a list of paths) so the
/// rules above are unit-testable without Tauri.
fn save_from_paths(root: &Path, paths: &[String], now_ms: i64) -> anyhow::Result<DropOutcome> {
    anyhow::ensure!(!paths.is_empty(), "no files were dropped");
    let day = root.join(day_folder(now_ms));
    std::fs::create_dir_all(&day)?;

    let mut saved = Vec::new();
    let mut skipped = Vec::new();
    for path in paths.iter().take(MAX_FILES) {
        let source = Path::new(path);
        let display = safe_name(path).unwrap_or_else(|| "file".to_string());
        let metadata = match std::fs::symlink_metadata(source) {
            Ok(meta) => meta,
            Err(_) => {
                skipped.push(format!("{display}: missing"));
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            skipped.push(format!("{display}: symlink"));
            continue;
        }
        if !metadata.file_type().is_file() {
            skipped.push(format!("{display}: not a file"));
            continue;
        }
        if metadata.len() > MAX_FILE_BYTES {
            skipped.push(format!("{display}: too large"));
            continue;
        }
        let Some(name) = safe_name(path) else {
            skipped.push("file: invalid name".to_string());
            continue;
        };
        let destination = unique_destination(&day, &name);
        match std::fs::copy(source, &destination) {
            Ok(copied) => saved.push(DroppedFile {
                name: destination
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or(name),
                size: copied,
                saved_at: now_ms,
                relative: relative_name(root, &destination),
            }),
            Err(_) => skipped.push(format!("{display}: copy failed")),
        }
    }
    if paths.len() > MAX_FILES {
        skipped.push(format!("{} more: batch limit", paths.len() - MAX_FILES));
    }
    Ok(DropOutcome { saved, skipped })
}

/// Copy OS-dropped paths into the dropbox. Called by the drop plugin.
#[tauri::command]
pub async fn save_dropped_files(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<DropOutcome, String> {
    let root = dropbox_root(&state.data_dir);
    let now = crate::commands::store::now_ms();
    super::blocking(move || save_from_paths(&root, &paths, now)).await
}

/// The click target of the drop zone: a native multi-file picker whose result
/// goes through exactly the same copy rules as a drag-and-drop. `None` when
/// the user cancels.
#[tauri::command]
pub async fn pick_dropped_files(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<DropOutcome>, String> {
    let root = dropbox_root(&state.data_dir);
    let now = crate::commands::store::now_ms();
    let title = if crate::window::tray::prefers_chinese(&state.settings.read()) {
        "添加文件到文件中转站"
    } else {
        "Add files to the dropbox"
    };
    let picker = window.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .set_parent(&picker)
            .set_title(title)
            .blocking_pick_files()
    })
    .await
    .map_err(|e| format!("file picker failed: {e}"))?;
    let Some(files) = picked else {
        return Ok(None);
    };
    let paths: Vec<String> = files
        .into_iter()
        .filter_map(|file| file.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    if paths.is_empty() {
        return Ok(None);
    }
    super::blocking(move || save_from_paths(&root, &paths, now))
        .await
        .map(Some)
}

/// Newest files first. `limit` is capped so a large dropbox cannot make the
/// island's panel huge or the scan expensive.
#[tauri::command]
pub async fn list_dropped_files(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<DroppedFile>, String> {
    let root = dropbox_root(&state.data_dir);
    let limit = limit.unwrap_or(MAX_LIST as u32).clamp(1, 50) as usize;
    super::blocking(move || {
        let mut files = Vec::new();
        if !root.exists() {
            return Ok(files);
        }
        for entry in walkdir::WalkDir::new(&root)
            .max_depth(2)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let metadata = match entry.metadata() {
                Ok(meta) => meta,
                Err(_) => continue,
            };
            let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                continue;
            };
            let saved_at = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or_default();
            files.push(DroppedFile {
                name,
                size: metadata.len(),
                saved_at,
                relative: relative_name(&root, path),
            });
        }
        files.sort_by(|a, b| b.saved_at.cmp(&a.saved_at).then(a.name.cmp(&b.name)));
        files.truncate(limit);
        Ok(files)
    })
    .await
}

/// Open the dropbox in the OS file manager, creating it first.
#[tauri::command]
pub async fn open_dropbox(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let root = dropbox_root(&state.data_dir);
    std::fs::create_dir_all(&root).map_err(|e| format!("{}: {e}", root.display()))?;
    app.opener()
        .open_path(root.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(root.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::tempdir;

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> String {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn bad_names_are_made_safe() {
        assert_eq!(safe_name("/tmp/a.txt").as_deref(), Some("a.txt"));
        assert_eq!(safe_name(r"C:\work\a.txt").as_deref(), Some("a.txt"));
        assert_eq!(safe_name("a<b>c?.txt").as_deref(), Some("a_b_c_.txt"));
        assert_eq!(safe_name(".."), None);
        assert_eq!(safe_name("/"), None);
        assert_eq!(safe_name("   "), None);
        let long = format!("{}.mp3", "x".repeat(300));
        let safe = safe_name(&long).unwrap();
        assert!(safe.ends_with(".mp3"));
        assert_eq!(safe.chars().count(), MAX_NAME_CHARS);
    }

    #[test]
    fn copies_regular_files_and_skips_directories_and_symlinks() {
        let source = tempdir();
        let data = tempdir();
        let file = write(&source, "notes.txt", b"hello");
        let nested = source.join("folder");
        std::fs::create_dir_all(&nested).unwrap();

        #[cfg(unix)]
        let symlink = {
            let link = source.join("link.txt");
            std::os::unix::fs::symlink(&file, &link).unwrap();
            Some(link.to_string_lossy().into_owned())
        };
        #[cfg(not(unix))]
        let symlink: Option<String> = None;

        let mut paths = vec![file.clone(), nested.to_string_lossy().into_owned()];
        if let Some(link) = symlink {
            paths.push(link);
        }
        let outcome = save_from_paths(&data, &paths, 1_790_000_000_000).unwrap();
        assert_eq!(outcome.saved.len(), 1);
        assert_eq!(outcome.saved[0].name, "notes.txt");
        assert_eq!(outcome.saved[0].size, 5);
        assert!(outcome.saved[0].relative.contains("notes.txt"));
        assert!(outcome.skipped.iter().any(|s| s.contains("not a file")));
        assert!(outcome
            .skipped
            .iter()
            .all(|s| !s.contains(&source.display().to_string())));
        let copied = data.join(&outcome.saved[0].relative);
        assert_eq!(std::fs::read(copied).unwrap(), b"hello");

        std::fs::remove_dir_all(source).ok();
        std::fs::remove_dir_all(data).ok();
    }

    #[test]
    fn name_collisions_are_numbered_and_never_overwrite() {
        let source = tempdir();
        let data = tempdir();
        let a = write(&source, "report.pdf", b"first");

        let first = save_from_paths(&data, std::slice::from_ref(&a), 1_790_000_000_000).unwrap();
        write(&source, "report.pdf", b"second");
        let second = save_from_paths(&data, &[a], 1_790_000_000_000).unwrap();
        assert_eq!(first.saved[0].name, "report.pdf");
        assert_eq!(second.saved[0].name, "report (2).pdf");
        assert_eq!(
            std::fs::read(data.join(&first.saved[0].relative)).unwrap(),
            b"first"
        );
        assert_eq!(
            std::fs::read(data.join(&second.saved[0].relative)).unwrap(),
            b"second"
        );

        std::fs::remove_dir_all(source).ok();
        std::fs::remove_dir_all(data).ok();
    }

    #[test]
    fn a_missing_source_is_skipped_without_failing_the_batch() {
        let source = tempdir();
        let data = tempdir();
        let good = write(&source, "good.txt", b"ok");
        let outcome = save_from_paths(
            &data,
            &[source.join("gone.txt").to_string_lossy().into_owned(), good],
            1_790_000_000_000,
        )
        .unwrap();
        assert_eq!(outcome.saved.len(), 1);
        assert_eq!(outcome.skipped.len(), 1);
        assert!(outcome.skipped[0].contains("missing"));

        std::fs::remove_dir_all(source).ok();
        std::fs::remove_dir_all(data).ok();
    }

    #[test]
    fn the_batch_limit_is_reported() {
        let source = tempdir();
        let data = tempdir();
        let mut paths = Vec::new();
        for i in 0..(MAX_FILES + 2) {
            paths.push(write(&source, &format!("f{i}.txt"), b"x"));
        }
        let outcome = save_from_paths(&data, &paths, 1_790_000_000_000).unwrap();
        assert_eq!(outcome.saved.len(), MAX_FILES);
        assert!(outcome.skipped.iter().any(|s| s.contains("2 more")));

        std::fs::remove_dir_all(source).ok();
        std::fs::remove_dir_all(data).ok();
    }
}
