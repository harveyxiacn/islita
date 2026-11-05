//! Task-completion notices. [BACKEND]
//!
//! Claude Code and Codex already write their turns to local session logs, and
//! the session index records `finished_at` for a terminal assistant message
//! (Claude `stop_reason`, Codex `task_complete`). After every ingestion pass
//! this module looks for turns finished since the previous pass, emits them to
//! the island's tasks plugin, and — when the user asked for it — sends the
//! same notice through the existing alert fan-out.
//!
//! Privacy: the notice carries the provider and the project folder only. A
//! session title or prompt text is deliberately not read here, so a lock-screen
//! notification cannot leak conversation content. The local panel may show the
//! title because it stays inside the app.
//!
//! A first pass after start-up must not replay history: `AppState.task_watch`
//! starts at the process start time. A machine asleep for longer than
//! [`MAX_NOTIFY_AGE_MS`] also skips the missed completions; the tasks panel
//! still lists them when opened.

use crate::commands::alerts::notifier::{self, Alert, Level};
use crate::commands::providers;
use crate::commands::store::{now_ms, Db};
use crate::model::events;
use crate::sessions::completed_tasks;
use crate::sessions::model::TaskCompletion;
use crate::state::AppState;
use tauri::{AppHandle, Emitter, Manager, State};

/// A completion older than this is not worth interrupting the user for (for
/// example when the laptop wakes from sleep).
const MAX_NOTIFY_AGE_MS: i64 = 10 * 60_000;
/// Upper bound for one scan; a reindex is caught up on the next pass.
const SCAN_LIMIT: u32 = 50;

/// The tasks plugin's list of recent completions. Read-only and local.
#[tauri::command]
pub async fn list_task_completions(
    state: State<'_, AppState>,
    since_ms: Option<i64>,
    limit: Option<u32>,
) -> Result<Vec<TaskCompletion>, String> {
    let db = state.db()?;
    let until = now_ms();
    let since = since_ms.unwrap_or(until - 24 * 3_600_000).clamp(0, until);
    super::blocking(move || completed_tasks(&db, since, until, limit.unwrap_or(5))).await
}

/// Called by the scheduler after an ingestion pass (not after a skipped pass).
pub fn on_ingest(app: &AppHandle, db: &Db) {
    let settings = crate::window::settings_of(app);
    let now = now_ms();
    let state = app.state::<AppState>();
    let tasks = {
        let mut guard = state.task_watch.lock();
        let since = (*guard).max(now - MAX_NOTIFY_AGE_MS);
        match completed_tasks(db, since, now, SCAN_LIMIT) {
            Ok(tasks) => {
                *guard = now;
                tasks
            }
            Err(e) => {
                // Do not advance the mark: the next ingestion pass retries.
                log::warn!("could not scan finished tasks: {e:#}");
                return;
            }
        }
    };
    if tasks.is_empty() {
        return;
    }
    let chinese = crate::window::tray::prefers_chinese(&settings);
    for task in tasks {
        // A provider the user switched off is not shown anywhere else either.
        if !providers::is_enabled(&settings, &task.provider) {
            continue;
        }
        if let Err(e) = app.emit(events::TASK_COMPLETED, &task) {
            log::debug!("could not emit {}: {e}", events::TASK_COMPLETED);
        }
        if should_notify(&settings, &task) {
            notifier::deliver(app, &settings, alert_for(&task, chinese));
        }
    }
}

/// The three user-controlled gates in front of the OS/webhook notice. The
/// local `task-completed` event is deliberately not gated by them.
fn should_notify(settings: &crate::model::Settings, task: &TaskCompletion) -> bool {
    settings.notifications
        && settings.task_notifications
        && providers::is_enabled(settings, &task.provider)
}

fn provider_name(provider: &str) -> &'static str {
    match provider {
        providers::CLAUDE_ID => "Claude Code",
        providers::CODEX_ID => "Codex",
        _ => "AI",
    }
}

/// The last path component, for a safe notification body. Empty for a missing
/// or root-only project.
fn project_name(project: &str) -> Option<&str> {
    project
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty() && *part != "." && *part != "..")
}

/// Native/webhook notification for one completion. The title is the provider;
/// the body is the project folder. Session titles and prompt text never leave
/// the local panel.
pub fn alert_for(task: &TaskCompletion, chinese: bool) -> Alert {
    let name = provider_name(&task.provider);
    let title = if chinese {
        format!("{name} 任务完成")
    } else {
        format!("{name} finished")
    };
    let body = match (chinese, project_name(&task.project)) {
        (false, Some(project)) => format!("{project} is ready."),
        (false, None) => "A task is ready.".to_string(),
        (true, Some(project)) => format!("{project} 已完成，可以查看了。"),
        (true, None) => "任务已完成，可以查看了。".to_string(),
    };
    let mut alert = Alert::new(Level::Task, title, body);
    alert.provider = Some(task.provider.clone());
    alert
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(title: &str, project: &str) -> TaskCompletion {
        TaskCompletion {
            provider: providers::CLAUDE_ID.into(),
            session_id: "session".into(),
            title: title.into(),
            project: project.into(),
            finished_at: 1_790_000_000_000,
        }
    }

    #[test]
    fn notifications_name_the_provider_and_project_but_not_the_title() {
        let a = alert_for(&task("Fix the private billing bug", "/work/my-app"), false);
        assert_eq!(a.level, Level::Task);
        assert_eq!(a.title, "Claude Code finished");
        assert_eq!(a.body, "my-app is ready.");
        assert!(!a.body.contains("billing"));
        assert!(!a.title.contains("billing"));
        assert_eq!(a.provider.as_deref(), Some("claude"));
    }

    #[test]
    fn chinese_and_windows_paths_read_naturally() {
        let a = alert_for(&task("secret", r"C:\work\api\"), true);
        assert_eq!(a.title, "Claude Code 任务完成");
        assert_eq!(a.body, "api 已完成，可以查看了。");
        assert!(!a.body.contains("secret"));
    }

    #[test]
    fn an_unknown_project_keeps_the_notice_generic() {
        assert_eq!(
            alert_for(&task("secret", ""), false).body,
            "A task is ready."
        );
        assert_eq!(
            alert_for(&task("secret", "/"), true).body,
            "任务已完成，可以查看了。"
        );
    }

    #[test]
    fn notifications_need_the_master_switch_type_switch_and_provider_switch() {
        let mut settings = crate::model::Settings::default();
        let t = task("secret", "/work/app");
        assert!(
            !should_notify(&settings, &t),
            "master switch off by default"
        );
        settings.notifications = true;
        assert!(should_notify(&settings, &t));
        settings.task_notifications = false;
        assert!(!should_notify(&settings, &t));
        settings.task_notifications = true;
        settings
            .providers
            .get_mut(providers::CLAUDE_ID)
            .unwrap()
            .enabled = false;
        assert!(!should_notify(&settings, &t), "untracked provider");
    }

    #[test]
    fn codex_has_its_own_name_and_webhook_level() {
        let mut t = task("secret", "/work/cli");
        t.provider = providers::CODEX_ID.into();
        let a = alert_for(&t, false);
        assert_eq!(a.title, "Codex finished");
        assert_eq!(
            serde_json::to_value(a.level).unwrap(),
            serde_json::json!("task")
        );
    }
}
