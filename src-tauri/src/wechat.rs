//! WeChat conversation-list mirror. [BACKEND]
//!
//! Windows only. WeChat's desktop client exposes its visible conversation list
//! through UI Automation (`mmui::ChatSessionCell`). This module reads exactly
//! that — the same text a screen reader sees — and nothing else. It never
//! opens a chat, reads WeChat's local database, sends a message, simulates
//! input or makes a network request.
//!
//! Why this shape: WeChat has no supported desktop API for reading messages.
//! Decrypting its chat database would expose the full history and break the
//! app's local-first, read-only rule. The accessibility tree is already
//! available to the signed-in user, needs no password, and is limited to the
//! conversation list the client is currently rendering.
//!
//! The panel shows the latest message per visible conversation, not history,
//! and only while WeChat is running. WeChat 4.x uses the `mmui::MainWindow`
//! class; 3.x uses `WeChatMainWndForPC`. If a future client stops exposing the
//! list, the scan reports `no_sessions` rather than inventing data.

use serde::Serialize;

pub const MAX_SESSIONS: usize = 20;
const MAX_CONTACT: usize = 80;
const MAX_PREVIEW: usize = 240;
const MAX_TIME: usize = 24;
const MAX_ID: usize = 160;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WechatSession {
    /// The client's automation id (`session_item_…`); falls back to the contact.
    pub id: String,
    pub contact: String,
    /// Latest message preview exactly as the conversation list renders it.
    pub preview: String,
    /// The list's own time label (`09:24`, `昨天`, …), not a parsed timestamp.
    pub time: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WechatScan {
    pub supported: bool,
    /// `ok` | `not_running` | `no_sessions` | `blocked` | `unsupported`
    pub state: String,
    pub sessions: Vec<WechatSession>,
    pub total: usize,
    pub read_at_ms: i64,
}

fn clean(value: &str, max: usize) -> String {
    // Accessible names can carry NULs or other control characters from a
    // custom-drawn cell; they are layout noise, not message text.
    let sanitized: String = value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let one_line = sanitized.split_whitespace().collect::<Vec<_>>().join(" ");
    one_line.chars().take(max).collect()
}

/// The conversation list's last line is its own label, e.g. `09:24`, `昨天`,
/// `星期天`, `11/5` or `9:24 AM`. This is deliberately conservative: a short
/// message such as `9:30 见` must stay a preview.
fn looks_like_time(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > MAX_TIME {
        return false;
    }
    if matches!(value, "昨天" | "前天" | "刚刚" | "Yesterday") {
        return true;
    }
    if value.starts_with("星期") || value.starts_with('周') {
        return true;
    }
    if value.contains('月') && value.contains('日') {
        return true;
    }
    const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    if WEEKDAYS.iter().any(|day| value.eq_ignore_ascii_case(day)) {
        return true;
    }

    // `上午 9:24`: the period can come before the clock.
    let (clock_part, leading_period) = match value
        .strip_prefix("上午")
        .or_else(|| value.strip_prefix("下午"))
    {
        Some(rest) => (rest.trim(), true),
        None => (value, false),
    };
    let mut parts = clock_part.split_whitespace();
    let clock = parts.next().unwrap_or_default();
    let suffix = parts.collect::<Vec<_>>().join(" ");
    let suffix_ok = suffix.is_empty()
        || suffix.eq_ignore_ascii_case("AM")
        || suffix.eq_ignore_ascii_case("PM")
        || (!leading_period && (suffix == "上午" || suffix == "下午"));
    if !suffix_ok {
        return false;
    }
    if let Some((hour, minute)) = clock.split_once(':') {
        let numeric =
            |part: &str, len: usize| part.len() == len && part.chars().all(|c| c.is_ascii_digit());
        if (numeric(hour, 1) || numeric(hour, 2)) && numeric(minute, 2) {
            return true;
        }
    }

    // `2026/11/5`, `11/5`, `2026-11-05`: at least three digits and a separator.
    let digits = value.chars().filter(|c| c.is_ascii_digit()).count();
    let separators = value
        .chars()
        .filter(|c| matches!(c, '/' | '-' | '.'))
        .count();
    digits >= 3 && separators >= 1
}

fn parse_session_name(name: &str, automation_id: &str) -> Option<WechatSession> {
    let lines: Vec<&str> = name
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let contact = clean(lines.first()?, MAX_CONTACT);
    if contact.is_empty() {
        return None;
    }

    let (preview_lines, time) = if lines.len() >= 2 && looks_like_time(lines[lines.len() - 1]) {
        (
            &lines[1..lines.len() - 1],
            clean(lines[lines.len() - 1], MAX_TIME),
        )
    } else {
        (&lines[1..], String::new())
    };
    let preview = clean(&preview_lines.join(" "), MAX_PREVIEW);
    let id = if automation_id.trim().is_empty() {
        contact.clone()
    } else {
        clean(automation_id, MAX_ID)
    };
    Some(WechatSession {
        id,
        contact,
        preview,
        time,
    })
}

#[cfg(not(windows))]
fn scan(limit: usize) -> WechatScan {
    let _ = limit;
    WechatScan {
        supported: false,
        state: "unsupported".to_string(),
        sessions: Vec::new(),
        total: 0,
        read_at_ms: chrono::Utc::now().timestamp_millis(),
    }
}

#[cfg(windows)]
fn scan(limit: usize) -> WechatScan {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Variant::VARIANT;
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, TreeScope_Descendants, UIA_ClassNamePropertyId,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetTopWindow, GetWindow, GetWindowTextW, GW_HWNDNEXT,
    };

    struct Com(bool);

    impl Com {
        fn init() -> Self {
            // S_FALSE (already initialized) is still a success that needs a
            // matching CoUninitialize. RPC_E_CHANGED_MODE means another
            // apartment is in place; UIA still works and must not be
            // uninitialized here.
            let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            Self(hr.is_ok())
        }
    }

    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    /// Candidate windows across WeChat generations. 4.x draws its main window
    /// in a Qt window whose Win32 class is `Qt…QWindowIcon` (the UIA class is
    /// `mmui::MainWindow`); 3.x uses `WeChatMainWndForPC`. The title check keeps
    /// unrelated Qt apps out, and `read_window` confirms the accessible list
    /// before data is accepted.
    fn find_windows() -> Vec<HWND> {
        let mut candidates = Vec::new();
        let mut current = unsafe { GetTopWindow(None).ok() };
        while let Some(hwnd) = current {
            let mut class_buffer = [0u16; 256];
            let class_len = unsafe { GetClassNameW(hwnd, &mut class_buffer) };
            let mut title_buffer = [0u16; 128];
            let title_len = unsafe { GetWindowTextW(hwnd, &mut title_buffer) };
            if class_len > 0 {
                let class = String::from_utf16_lossy(&class_buffer[..class_len as usize]);
                let title = if title_len > 0 {
                    String::from_utf16_lossy(&title_buffer[..title_len as usize])
                } else {
                    String::new()
                };
                let wechat_class = class == "WeChatMainWndForPC"
                    || class.starts_with("WeChatMainWnd")
                    || (class.starts_with("Qt") && class.ends_with("QWindowIcon"));
                let wechat_title = title.eq_ignore_ascii_case("wechat")
                    || title.eq_ignore_ascii_case("weixin")
                    || title.contains("微信");
                if wechat_class && wechat_title {
                    candidates.push(hwnd);
                }
            }
            current = unsafe { GetWindow(hwnd, GW_HWNDNEXT).ok() };
        }
        candidates
    }

    fn read_window(
        automation: &IUIAutomation,
        hwnd: HWND,
        limit: usize,
    ) -> windows::core::Result<Vec<WechatSession>> {
        let root = unsafe { automation.ElementFromHandle(hwnd)? };
        let condition = unsafe {
            automation.CreatePropertyCondition(
                UIA_ClassNamePropertyId,
                &VARIANT::from("mmui::ChatSessionCell"),
            )?
        };
        let elements = unsafe { root.FindAll(TreeScope_Descendants, &condition)? };
        let count = unsafe { elements.Length()? };
        let mut sessions = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for index in 0..count {
            let Ok(element) = (unsafe { elements.GetElement(index) }) else {
                continue;
            };
            let name = unsafe { element.CurrentName() }
                .map(|value| value.to_string())
                .unwrap_or_default();
            let automation_id = unsafe { element.CurrentAutomationId() }
                .map(|value| value.to_string())
                .unwrap_or_default();
            let Some(session) = parse_session_name(&name, &automation_id) else {
                continue;
            };
            if !seen.insert(session.id.clone()) {
                continue;
            }
            sessions.push(session);
            if sessions.len() >= limit {
                break;
            }
        }
        Ok(sessions)
    }

    fn read_sessions(
        limit: usize,
    ) -> windows::core::Result<(&'static str, Vec<WechatSession>, usize)> {
        let candidates = find_windows();
        if candidates.is_empty() {
            return Ok(("not_running", Vec::new(), 0));
        }
        let _com = Com::init();
        let automation: IUIAutomation =
            unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)? };
        let mut last_error = None;
        for hwnd in candidates {
            match read_window(&automation, hwnd, limit) {
                Ok(sessions) if !sessions.is_empty() => {
                    let total = sessions.len();
                    return Ok(("ok", sessions, total));
                }
                Ok(_) => {}
                Err(error) => last_error = Some(error),
            }
        }
        if let Some(error) = last_error {
            return Err(error);
        }
        Ok(("no_sessions", Vec::new(), 0))
    }

    let read_at_ms = chrono::Utc::now().timestamp_millis();
    match read_sessions(limit) {
        Ok((state, sessions, total)) => WechatScan {
            supported: true,
            state: state.to_string(),
            sessions,
            total,
            read_at_ms,
        },
        Err(error) => {
            // Never log the accessible names (they contain private messages);
            // only the HRESULT is useful for support.
            log::warn!("wechat accessibility scan failed: {error}");
            WechatScan {
                supported: true,
                state: "blocked".to_string(),
                sessions: Vec::new(),
                total: 0,
                read_at_ms,
            }
        }
    }
}

/// Read the visible WeChat conversation list. The frontend calls this only
/// while the WeChat panel is open, so no message text is polled in the
/// background. The result is not persisted anywhere.
#[tauri::command]
pub async fn read_wechat_sessions(limit: Option<u32>) -> Result<WechatScan, String> {
    let limit = limit.unwrap_or(8).clamp(1, MAX_SESSIONS as u32) as usize;
    tauri::async_runtime::spawn_blocking(move || scan(limit))
        .await
        .map_err(|error| format!("wechat scan task failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_name_is_contact_preview_and_time() {
        let session = parse_session_name(
            "Maya\nDesign review moved to 3 pm\n09:24",
            "session_item_Maya",
        )
        .unwrap();
        assert_eq!(session.contact, "Maya");
        assert_eq!(session.preview, "Design review moved to 3 pm");
        assert_eq!(session.time, "09:24");
        assert_eq!(session.id, "session_item_Maya");
    }

    #[test]
    fn group_previews_keep_the_sender_prefix() {
        let session = parse_session_name(
            "Design team\nSam: shipped the build\nYesterday",
            "session_item_Design team",
        )
        .unwrap();
        assert_eq!(session.contact, "Design team");
        assert_eq!(session.preview, "Sam: shipped the build");
        assert_eq!(session.time, "Yesterday");
    }

    #[test]
    fn a_short_message_that_starts_with_a_clock_is_not_a_timestamp() {
        let session = parse_session_name("Sam\n9:30 见\n", "session_item_Sam").unwrap();
        assert_eq!(session.contact, "Sam");
        assert_eq!(session.preview, "9:30 见");
        assert!(session.time.is_empty());
    }

    #[test]
    fn missing_parts_degrade_without_panicking() {
        let session = parse_session_name("Only a contact", "").unwrap();
        assert_eq!(session.contact, "Only a contact");
        assert!(session.preview.is_empty());
        assert!(session.time.is_empty());
        assert_eq!(session.id, "Only a contact");
        assert!(parse_session_name("\n\n", "id").is_none());
    }

    #[test]
    fn control_characters_and_long_text_are_clamped() {
        let long = "x".repeat(400);
        let session = parse_session_name(&format!("A\u{0}B\n{long}\n11/5"), "id").unwrap();
        assert_eq!(session.contact, "A B");
        assert_eq!(session.preview.chars().count(), MAX_PREVIEW);
        assert_eq!(session.time, "11/5");
    }

    #[test]
    fn time_labels_cover_the_common_shapes() {
        for value in [
            "09:24",
            "9:24 AM",
            "上午 9:24",
            "昨天",
            "星期天",
            "周一",
            "11/5",
            "2026-11-05",
            "Mon",
        ] {
            assert!(looks_like_time(value), "{value}");
        }
        for value in ["9:30 见", "hello", "收到，谢谢", "1:2"] {
            assert!(!looks_like_time(value), "{value}");
        }
    }

    /// Live check, not part of CI. It prints counts and states only — never
    /// contact names or message text.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn live_wechat_scan_smoke() {
        let result = scan(10);
        println!(
            "wechat: supported={} state={} sessions={}",
            result.supported,
            result.state,
            result.sessions.len()
        );
        assert!(result.supported);
    }
}
