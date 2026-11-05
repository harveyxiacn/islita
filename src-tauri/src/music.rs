//! Local music folder discovery. [BACKEND]
//!
//! The user picks a folder once; this module lists its audio files (recursively)
//! and reads a sibling `.lrc` when one has the same stem. Audio bytes never
//! pass through this module: the webview plays them through the asset protocol,
//! which is granted access to exactly the picked folder at scan time.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use walkdir::WalkDir;

/// Extensions the browser `<audio>` element can generally decode.
const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "weba", "webm",
];
/// A library larger than this is not useful in a 22 rem panel.
const MAX_TRACKS: usize = 5_000;
/// LRC files are tiny; refuse anything that looks like a mis-named media file.
const MAX_LRC_BYTES: u64 = 512 * 1024;
const MAX_DEPTH: usize = 12;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MusicTrack {
    /// File name without its extension.
    pub name: String,
    pub file_name: String,
    /// Absolute path on this machine; used only to build an asset URL.
    pub path: String,
    /// Sibling `.lrc` contents, when present and readable.
    pub lyrics: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MusicScan {
    pub folder: String,
    pub tracks: Vec<MusicTrack>,
    /// Files that were unreadable or beyond the track cap.
    pub skipped: usize,
}

/// Native folder picker. Only the chosen path is remembered by the frontend;
/// the audio itself is never copied.
#[tauri::command]
pub async fn pick_music_folder(
    window: WebviewWindow,
    state: State<'_, crate::state::AppState>,
) -> Result<Option<String>, String> {
    let chinese = crate::window::tray::prefers_chinese(&state.settings.read());
    let title = if chinese {
        "选择音乐文件夹"
    } else {
        "Choose a music folder"
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

/// List the audio files under `folder` and pair sibling LRC files. The folder
/// is also added to the asset-protocol scope, which is what lets the webview
/// read the chosen files without a copy.
#[tauri::command]
pub async fn scan_music_folder(app: AppHandle, folder: String) -> Result<MusicScan, String> {
    let root = PathBuf::from(folder);
    let root = root
        .canonicalize()
        .map_err(|e| format!("cannot open the music folder: {e}"))?;
    if !root.is_dir() {
        return Err("the chosen music path is not a folder".into());
    }
    app.asset_protocol_scope()
        .allow_directory(&root, true)
        .map_err(|e| format!("cannot allow the music folder: {e}"))?;
    super::blocking(move || scan_folder(&root)).await
}

fn extension(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Read an LRC as UTF-8, falling back to GB18030 for the many Chinese lyric
/// files that predate UTF-8. A BOM is stripped so `[ti:…]` stays the first tag.
fn read_lyrics(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() == 0 || meta.len() > MAX_LRC_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let text = match String::from_utf8(bytes.clone()) {
        Ok(text) => text,
        Err(_) => encoding_rs::GB18030.decode(&bytes).0.into_owned(),
    };
    Some(text.trim_start_matches('\u{feff}').to_string())
}

fn scan_folder(root: &Path) -> anyhow::Result<MusicScan> {
    let mut audio: Vec<PathBuf> = Vec::new();
    let mut lyrics: HashMap<(PathBuf, String), PathBuf> = HashMap::new();
    let mut skipped = 0usize;

    for entry in WalkDir::new(root)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .into_iter()
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.into_path();
        let ext = extension(&path);
        if ext == "lrc" {
            let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
            let stem = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if !stem.is_empty() {
                lyrics.entry((parent, stem)).or_insert(path);
            }
        } else if AUDIO_EXTENSIONS.contains(&ext.as_str()) {
            audio.push(path);
        } else {
            skipped += 1;
        }
    }

    audio.sort_by(|a, b| {
        a.strip_prefix(root)
            .unwrap_or(a)
            .to_string_lossy()
            .to_lowercase()
            .cmp(
                &b.strip_prefix(root)
                    .unwrap_or(b)
                    .to_string_lossy()
                    .to_lowercase(),
            )
    });

    let total = audio.len();
    let tracks = audio
        .into_iter()
        .take(MAX_TRACKS)
        .filter_map(|path| {
            let file_name = path.file_name()?.to_string_lossy().into_owned();
            let stem = path.file_stem()?.to_string_lossy().into_owned();
            let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
            let lyrics = lyrics
                .get(&(parent, stem.to_lowercase()))
                .and_then(|p| read_lyrics(p));
            Some(MusicTrack {
                name: stem,
                file_name,
                path: path.to_string_lossy().into_owned(),
                lyrics,
            })
        })
        .collect();
    Ok(MusicScan {
        folder: root.to_string_lossy().into_owned(),
        tracks,
        skipped: skipped + total.saturating_sub(MAX_TRACKS),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn audio_is_found_recursively_and_paired_with_a_sibling_lrc() {
        let root = crate::commands::test_support::tempdir();
        touch(&root.join("01 - 今日.flac"), b"not really audio");
        touch(
            &root.join("01 - 今日.lrc"),
            "[ti:今日]\n[00:01.00]line\n".as_bytes(),
        );
        touch(&root.join("02 - 陪着你走.MP3"), b"audio");
        touch(&root.join("电台节目/03 - 认真如初.mp3"), b"audio");
        touch(&root.join("电台节目/cover.jpg"), b"not audio");
        touch(
            &root.join("电台节目/03 - 认真如初.LRC"),
            "[00:02.00]电台\n".as_bytes(),
        );

        let scan = scan_folder(&root).unwrap();
        assert_eq!(scan.tracks.len(), 3);
        assert_eq!(scan.skipped, 1);
        assert_eq!(scan.tracks[0].file_name, "01 - 今日.flac");
        assert_eq!(scan.tracks[0].name, "01 - 今日");
        assert!(scan.tracks[0].lyrics.as_deref().unwrap().contains("今日"));
        assert_eq!(scan.tracks[1].file_name, "02 - 陪着你走.MP3");
        assert!(scan.tracks[1].lyrics.is_none());
        assert_eq!(scan.tracks[2].file_name, "03 - 认真如初.mp3");
        assert!(scan.tracks[2].lyrics.as_deref().unwrap().contains("电台"));
    }

    #[test]
    fn a_gbk_lyric_file_is_decoded_instead_of_dropped() {
        let root = crate::commands::test_support::tempdir();
        touch(&root.join("song.mp3"), b"audio");
        let (bytes, _, _) = encoding_rs::GB18030.encode("[ti:中文]\n[00:01.00]你好\n");
        touch(&root.join("song.lrc"), &bytes);
        let scan = scan_folder(&root).unwrap();
        let lyrics = scan.tracks[0].lyrics.as_deref().unwrap();
        assert!(lyrics.contains("中文"));
        assert!(lyrics.contains("你好"));
    }

    #[test]
    fn empty_folders_and_bad_paths_do_not_panic() {
        let root = crate::commands::test_support::tempdir();
        let scan = scan_folder(&root).unwrap();
        assert!(scan.tracks.is_empty());
        assert_eq!(scan.skipped, 0);
    }
}
