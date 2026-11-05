//! Local mail reminders. [BACKEND]
//!
//! This module reads the *headers* of mail that is already on disk: `.eml` /
//! `.emlx` files and Maildir `new/` + `cur/` messages. The user picks the
//! folder with a native dialog; the app never asks for a password, never
//! contacts a mail server and never reads a message body.
//!
//! Live accounts are a separate, opt-in feature in `cloud_mail.rs`: Gmail /
//! Outlook OAuth or IMAP with an app password, with secrets in the OS keychain.
//! Keeping the local reader network-free is deliberate — choosing a folder must
//! never turn into silent network access.
//!
//! Unread state is only known for Maildir: `new/` is unread and a `cur/` file
//! is unread when its `:2,` flags do not contain `S`. Plain `.eml` files have
//! no portable read flag, so they are listed as read.

use encoding_rs::Encoding;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

const MAX_ENTRIES: usize = 5000;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_HEADER_BYTES: u64 = 128 * 1024;
const MAX_SUBJECT: usize = 240;
const MAX_FROM: usize = 160;
const MAX_MESSAGES: usize = 20;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailMessage {
    /// Stable across scans: the path relative to the chosen folder.
    pub id: String,
    pub subject: String,
    pub from: String,
    pub date_ms: i64,
    pub unread: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailScan {
    pub folder: String,
    /// Newest messages, capped by `limit`.
    pub messages: Vec<MailMessage>,
    /// Candidate messages seen (before the display limit).
    pub total: usize,
    pub unread: usize,
    /// The folder held more candidates than the scan cap.
    pub truncated: bool,
}

pub(crate) fn clean(value: &str, max: usize) -> String {
    let one_line = value.split_whitespace().collect::<Vec<_>>().join(" ");
    one_line.chars().take(max).collect()
}

fn split_headers(bytes: &[u8]) -> String {
    let limit = bytes.len().min(MAX_HEADER_BYTES as usize);
    let head = &bytes[..limit];
    let end = head
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 2)
        .or_else(|| head.windows(2).position(|w| w == b"\n\n").map(|i| i + 1))
        .unwrap_or(head.len());
    String::from_utf8_lossy(&head[..end]).into_owned()
}

fn header_fields(head: &str) -> Vec<(String, String)> {
    let mut fields: Vec<(String, String)> = Vec::new();
    for raw in head.lines() {
        let line = raw.trim_end_matches('\r');
        if line.starts_with(' ') || line.starts_with('\t') {
            if let Some(last) = fields.last_mut() {
                last.1.push(' ');
                last.1.push_str(line.trim());
            }
            continue;
        }
        if let Some(colon) = line.find(':') {
            fields.push((
                line[..colon].trim().to_ascii_lowercase(),
                line[colon + 1..].trim().to_string(),
            ));
        }
    }
    fields
}

fn field<'a>(fields: &'a [(String, String)], name: &str) -> Option<&'a str> {
    fields
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

/// Decode one RFC 2047 encoded word, or return `None` when the input is not
/// one. Unknown charsets fall back to UTF-8/lossy instead of dropping text.
fn decode_encoded_word(word: &str) -> Option<String> {
    let inner = word.strip_prefix("=?")?.strip_suffix("?=")?;
    let mut parts = inner.splitn(3, '?');
    let charset = parts.next()?.trim();
    let encoding = parts.next()?.trim().to_ascii_uppercase();
    let payload = parts.next()?;
    let bytes = match encoding.as_str() {
        "B" => {
            let mut padded = payload.trim().to_string();
            while padded.len() % 4 != 0 {
                padded.push('=');
            }
            base64::Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                padded.as_bytes(),
            )
            .ok()?
        }
        "Q" => {
            let mut out = Vec::with_capacity(payload.len());
            let mut chars = payload.bytes();
            while let Some(byte) = chars.next() {
                match byte {
                    b'_' => out.push(b' '),
                    b'=' => {
                        let hi = chars.next()?;
                        let lo = chars.next()?;
                        let hex = [hi, lo];
                        out.push(u8::from_str_radix(std::str::from_utf8(&hex).ok()?, 16).ok()?);
                    }
                    other => out.push(other),
                }
            }
            out
        }
        _ => return None,
    };
    let encoding = Encoding::for_label(charset.as_bytes());
    Some(match encoding {
        Some(encoding) => {
            let (decoded, _, _) = encoding.decode(&bytes);
            decoded.into_owned()
        }
        None => String::from_utf8_lossy(&bytes).into_owned(),
    })
}

/// Decode all encoded words in a header value. Whitespace between adjacent
/// encoded words is ignored, per RFC 2047.
pub(crate) fn decode_header(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find("=?") {
        out.push_str(&rest[..start]);
        let candidate = &rest[start..];
        let Some(end) = candidate.find("?=") else {
            out.push_str(candidate);
            return out;
        };
        let word = &candidate[..end + 2];
        match decode_encoded_word(word) {
            Some(decoded) => {
                // A whitespace run between two encoded words is separator
                // noise, not content.
                if out.ends_with(' ') && decoded.starts_with(' ') {
                    out.pop();
                }
                out.push_str(&decoded);
            }
            None => out.push_str(word),
        }
        rest = &candidate[end + 2..];
    }
    out.push_str(rest);
    out
}

pub(crate) fn parse_date(value: &str) -> Option<i64> {
    if let Ok(date) = chrono::DateTime::parse_from_rfc2822(value) {
        return Some(date.timestamp_millis());
    }
    if let Ok(date) = chrono::DateTime::parse_from_rfc3339(value) {
        return Some(date.timestamp_millis());
    }
    None
}

fn maildir_unread(path: &Path) -> Option<bool> {
    let parent = path.parent()?.file_name()?.to_str()?;
    if parent == "new" {
        return Some(true);
    }
    if parent == "cur" {
        let name = path.file_name()?.to_str()?;
        // Maildir uses `:2,` on Unix. A Windows file name cannot contain a
        // colon, so clients that support Windows use `;2,` or `!2,`; accept
        // all three rather than treating a read message as unread.
        for separator in [":2,", ";2,", "!2,"] {
            if let Some((_, flags)) = name.rsplit_once(separator) {
                return Some(!flags.contains('S'));
            }
        }
        return Some(true);
    }
    None
}

fn is_candidate(path: &Path) -> bool {
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with('.'))
    {
        return false;
    }
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension == "eml" || extension == "emlx" {
        return true;
    }
    // Maildir messages often have no extension; their parent directory is the
    // only reliable marker.
    path.parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .is_some_and(|name| name == "new" || name == "cur")
}

fn read_message(path: &Path, root: &Path) -> Option<MailMessage> {
    let metadata = std::fs::metadata(path).ok()?;
    if metadata.len() > MAX_FILE_BYTES {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    use std::io::Read;
    let mut bytes = Vec::with_capacity(MAX_HEADER_BYTES as usize);
    file.by_ref()
        .take(MAX_HEADER_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    let head = split_headers(&bytes);
    let fields = header_fields(&head);
    let subject = field(&fields, "subject")
        .map(decode_header)
        .map(|value| clean(&value, MAX_SUBJECT))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            clean(
                path.file_stem()
                    .and_then(|stem| stem.to_str())
                    .unwrap_or("message"),
                MAX_SUBJECT,
            )
        });
    let from = field(&fields, "from")
        .map(decode_header)
        .map(|value| clean(&value, MAX_FROM))
        .unwrap_or_default();
    let date_ms = field(&fields, "date")
        .and_then(parse_date)
        .or_else(|| {
            metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
        })
        .unwrap_or_default();
    let relative = path
        .strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    Some(MailMessage {
        id: relative.clone(),
        subject,
        from,
        date_ms,
        unread: maildir_unread(path).unwrap_or(false),
    })
}

fn scan_folder(folder: &Path, limit: usize) -> anyhow::Result<MailScan> {
    let folder = folder.canonicalize()?;
    anyhow::ensure!(folder.is_dir(), "not a folder");
    let mut candidates: Vec<(PathBuf, i64)> = Vec::new();
    let mut seen = 0usize;
    let mut truncated = false;
    for entry in walkdir::WalkDir::new(&folder)
        .max_depth(4)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() || !is_candidate(entry.path()) {
            continue;
        }
        seen += 1;
        if seen > MAX_ENTRIES {
            truncated = true;
            break;
        }
        let modified = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or_default();
        candidates.push((entry.into_path(), modified));
    }
    candidates.sort_by_key(|(_, modified)| std::cmp::Reverse(*modified));
    let total = candidates.len();
    let unread = candidates
        .iter()
        .filter(|(path, _)| maildir_unread(path) == Some(true))
        .count();
    let messages = candidates
        .iter()
        .filter_map(|(path, _)| read_message(path, &folder))
        .take(limit)
        .collect();
    Ok(MailScan {
        folder: folder.to_string_lossy().into_owned(),
        messages,
        total,
        unread,
        truncated,
    })
}

/// Native folder picker. The chosen path is the only thing remembered; no
/// message content is copied into settings.
#[tauri::command]
pub async fn pick_mail_folder(
    window: WebviewWindow,
    state: State<'_, crate::state::AppState>,
) -> Result<Option<String>, String> {
    let chinese = crate::window::tray::prefers_chinese(&state.settings.read());
    let title = if chinese {
        "选择本地邮件文件夹（.eml 或 Maildir）"
    } else {
        "Choose a local mail folder (.eml or Maildir)"
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

/// Read headers only. The path is user-chosen and the result is capped; the
/// frontend polls this while the mail panel is open.
#[tauri::command]
pub async fn scan_mail_folder(folder: String, limit: Option<u32>) -> Result<MailScan, String> {
    let limit = limit.unwrap_or(6).clamp(1, MAX_MESSAGES as u32) as usize;
    let path = PathBuf::from(folder);
    super::blocking(move || scan_folder(&path, limit)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::tempdir;

    #[test]
    fn encoded_words_decode_base64_and_quoted_printable() {
        assert_eq!(decode_header("=?UTF-8?B?5L2g5aW9?="), "你好");
        assert_eq!(decode_header("=?UTF-8?Q?Hello_World?="), "Hello World");
        assert_eq!(decode_header("A =?UTF-8?B?5L2g?= B"), "A 你 B");
        assert_eq!(decode_header("plain text"), "plain text");
        assert_eq!(decode_header("=?GBK?B?xOO6ww==?="), "你好");
        assert_eq!(decode_header("=?broken"), "=?broken");
    }

    #[test]
    fn folded_headers_keep_their_continuation() {
        let fields = header_fields(
            "Subject: A long\r\n subject line\r\nFrom: You <you@example.com>\r\n\r\n",
        );
        assert_eq!(field(&fields, "subject"), Some("A long subject line"));
        assert_eq!(field(&fields, "from"), Some("You <you@example.com>"));
    }

    #[test]
    fn maildir_unread_follows_new_and_the_read_flag() {
        let root = tempdir();
        let new = root.join("new");
        let cur = root.join("cur");
        std::fs::create_dir_all(&new).unwrap();
        std::fs::create_dir_all(&cur).unwrap();
        let a = new.join("1.msg");
        let b = cur.join("2.msg:2,S");
        let c = cur.join("3.msg:2,");
        std::fs::write(&a, b"Subject: one\n\nbody").unwrap();
        std::fs::write(&b, b"Subject: two\n\nbody").unwrap();
        std::fs::write(&c, b"Subject: three\n\nbody").unwrap();
        assert_eq!(maildir_unread(&a), Some(true));
        assert_eq!(maildir_unread(&b), Some(false));
        assert_eq!(maildir_unread(&c), Some(true));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn scanning_reads_headers_only_and_counts_unread_maildir_files() {
        let root = tempdir();
        let inbox = root.join("Inbox");
        let new = inbox.join("new");
        let cur = inbox.join("cur");
        std::fs::create_dir_all(&new).unwrap();
        std::fs::create_dir_all(&cur).unwrap();
        std::fs::write(
            new.join("1.msg"),
            b"From: Alice <alice@example.com>\r\nSubject: =?UTF-8?B?5L2g5aW9?=\r\nDate: Sat, 04 Jul 2026 10:00:00 +0000\r\n\r\nsecret body text\r\n",
        )
        .unwrap();
        std::fs::write(
            cur.join("2.msg;2,S"),
            b"From: Bob <bob@example.com>\r\nSubject: Read already\r\nDate: Sat, 04 Jul 2026 09:00:00 +0000\r\n\r\nbody\r\n",
        )
        .unwrap();
        std::fs::write(
            inbox.join("export.eml"),
            b"From: Carol <carol@example.com>\r\nSubject: Exported\r\nDate: Sat, 04 Jul 2026 08:00:00 +0000\r\n\r\nbody\r\n",
        )
        .unwrap();

        let scan = scan_folder(&root, 10).unwrap();
        assert_eq!(scan.total, 3);
        assert_eq!(scan.unread, 1);
        assert_eq!(scan.messages.len(), 3);
        let first = scan
            .messages
            .iter()
            .find(|message| message.subject == "你好")
            .expect("decoded subject");
        assert_eq!(first.from, "Alice <alice@example.com>");
        assert_eq!(first.date_ms, 1_783_159_200_000);
        assert!(first.unread);
        assert!(scan
            .messages
            .iter()
            .all(|message| !message.subject.contains("secret")));
        assert!(scan
            .messages
            .iter()
            .all(|message| !message.from.contains("body")));

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_missing_or_empty_folder_is_reported_without_panicking() {
        let root = tempdir();
        let missing = root.join("nope");
        assert!(scan_folder(&missing, 5).is_err());
        let empty = scan_folder(&root, 5).unwrap();
        assert_eq!(empty.total, 0);
        assert!(empty.messages.is_empty());
        std::fs::remove_dir_all(root).ok();
    }
}
