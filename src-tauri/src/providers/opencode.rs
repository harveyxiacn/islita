//! OpenCode Zen / Go quota provider. [BACKEND]
//!
//! **Experimental — not verified against a live account.** The response shapes
//! below come from OpenCode's own source (`packages/core/src/usage-limits.ts`
//! and its tests, fetched 2026-11-05); the fixtures are written from those
//! files, not captured from a real key.
//!
//! OpenCode has two paid products on the same Console account:
//!
//! * **Go** is a subscription with three rolling allowances. `GET
//!   /zen/go/v1/usage` returns `rolling` (5 hours), `weekly` (7 days) and
//!   `monthly` (30 days), each with `{status, percent, resetsAt}`. A key whose
//!   workspace is not subscribed to Go gets `403`.
//! * **Zen** is pay-as-you-go. The Console exposes the workspace's monthly
//!   spend limits at `GET /api/policies/current-budgets`; they are dollar
//!   caps rather than the three time windows, so this provider shows Go's
//!   windows when they exist and otherwise the tightest Zen budget as one
//!   "Zen budget" window.
//!
//! Both calls use `Authorization: Bearer <key>`. The usage call takes the
//! workspace id in `x-opencode-org-id`; Console takes it in `x-org-id`. OpenCode
//! itself always sends the id it learned while signing in, so a key alone may
//! not identify a workspace. `opencodeWorkspaceId` is optional here and can be
//! pasted as a bare id (`wrk_…`) or as the Console URL that contains it.
//!
//! The API key is stored in the OS keychain (service
//! `io.github.harveyxiacn.islita.opencode`), never in `settings.json`, a log
//! line or the UI. As a headless fallback the app also reads OpenCode's own
//! `OPENCODE_API_KEY` environment variable. The key is only ever sent to
//! `opencode.ai`.

use super::{
    clamp_percent, degraded, empty_quota, mark_primary, normalize_rfc3339, now_rfc3339,
    rate_limited, retry_after_of, send_with_retry, write_cache, Provider, ProviderCtx, OPENCODE_ID,
};
use crate::model::{
    ExtraSeverity, ProviderInfo, ProviderQuota, ProviderStatus, QuotaExtra, QuotaWindow, WindowKind,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};

pub const DISPLAY_NAME: &str = "OpenCode";
pub const USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";
pub const BUDGETS_URL: &str = "https://opencode.ai/console/api/policies/current-budgets";
/// OpenCode's own environment variable; an alternative to saving a key.
pub const DEFAULT_KEY_ENV: &str = "OPENCODE_API_KEY";
const KEYCHAIN_SERVICE: &str = "io.github.harveyxiacn.islita.opencode";
const KEYCHAIN_USER: &str = "api-key";
const MAX_KEY_CHARS: usize = 512;
const MAX_WORKSPACE_CHARS: usize = 80;

pub const EXPIRED_MESSAGE: &str =
    "OpenCode rejected the API key — save a new one in Settings → Providers";
pub const NO_GO_MESSAGE: &str = "OpenCode Go is not enabled for this key (HTTP 403). If the key belongs to a Console workspace, add its workspace ID in Settings → Providers.";
pub const INVALID_WORKSPACE_MESSAGE: &str =
    "The OpenCode workspace ID is invalid — use the id after /console/ (wrk_…), or leave the field empty";

pub fn not_logged_in_message() -> String {
    format!(
        "No OpenCode API key — add one in Settings → Providers (or set the {DEFAULT_KEY_ENV} environment variable)"
    )
}

// ---------------------------------------------------------------------------
// API response shapes
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Meter {
    /// `"ok"` or `"rate-limited"`.
    pub status: String,
    pub percent: f64,
    #[serde(rename = "resetsAt")]
    pub resets_at: String,
}

#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct UsageWindows {
    pub rolling: Meter,
    pub weekly: Meter,
    pub monthly: Meter,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct UsageEnvelope {
    usage: UsageWindows,
}

/// One entry of `GET /api/policies/current-budgets`; only the fields this
/// provider draws are declared, everything else is ignored.
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Budget {
    #[serde(rename = "ruleID")]
    pub rule_id: String,
    pub limit_dollars: f64,
    pub spent_dollars: f64,
    pub resets_at: Option<String>,
    pub coverage: String,
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

fn meter_window(kind: WindowKind, label: &str, window_seconds: u64, meter: &Meter) -> QuotaWindow {
    QuotaWindow {
        kind,
        label: label.to_string(),
        window_seconds: Some(window_seconds),
        used_percent: clamp_percent(meter.percent),
        resets_at: normalize_rfc3339(&meter.resets_at),
        scope: None,
        is_primary: false,
        forecast: None,
    }
}

/// Go's three allowances as the bar's windows: 5-hour, weekly, 30-day.
pub fn map_go(windows: &UsageWindows) -> Vec<QuotaWindow> {
    let mut out = vec![
        meter_window(WindowKind::FiveHour, "5-hour", 5 * 3600, &windows.rolling),
        meter_window(WindowKind::SevenDay, "Weekly", 7 * 86_400, &windows.weekly),
        meter_window(WindowKind::Other, "30-day", 30 * 86_400, &windows.monthly),
    ];
    mark_primary(&mut out);
    out
}

fn used_ratio(budget: &Budget) -> f64 {
    if budget.limit_dollars > 0.0 {
        budget.spent_dollars / budget.limit_dollars
    } else {
        0.0
    }
}

/// The budget closest to its cap: the one worth showing on the bar.
pub fn tightest_budget(budgets: &[Budget]) -> Option<&Budget> {
    budgets
        .iter()
        .filter(|b| b.limit_dollars > 0.0)
        .max_by(|a, b| used_ratio(a).total_cmp(&used_ratio(b)))
}

/// A Zen monthly budget as one window. There is no fixed window length in the
/// response, only the next reset, so `windowSeconds` stays `None`.
pub fn budget_window(budget: &Budget) -> QuotaWindow {
    QuotaWindow {
        kind: WindowKind::Other,
        label: "Zen budget".to_string(),
        window_seconds: None,
        used_percent: clamp_percent(used_ratio(budget) * 100.0),
        resets_at: budget.resets_at.as_deref().and_then(normalize_rfc3339),
        scope: None,
        is_primary: true,
        forecast: None,
    }
}

pub fn budget_value(budget: &Budget) -> String {
    format!(
        "${:.2} / ${:.2}",
        budget.spent_dollars.max(0.0),
        budget.limit_dollars.max(0.0)
    )
}

/// A bare workspace id, or the id inside an OpenCode Console URL. Anything
/// else is ignored rather than sent as a header: a typo must not turn into a
/// malformed request.
pub fn workspace_id(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let candidate = trimmed
        .split_once("/console/")
        .map(|(_, rest)| rest)
        .unwrap_or(trimmed);
    let candidate = candidate.split(['/', '?', '#']).next().unwrap_or("");
    let candidate = candidate.trim();
    if candidate.is_empty()
        || candidate.chars().count() > MAX_WORKSPACE_CHARS
        || !candidate
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    Some(candidate.to_string())
}

// ---------------------------------------------------------------------------
// Secrets: OS keychain with an environment fallback
// ---------------------------------------------------------------------------

/// `None` = never read yet; `Some(None)` = read, no key stored.
static KEY_CACHE: OnceLock<Mutex<Option<Option<String>>>> = OnceLock::new();

fn key_cache() -> &'static Mutex<Option<Option<String>>> {
    KEY_CACHE.get_or_init(|| Mutex::new(None))
}

fn cached_slot() -> Option<Option<String>> {
    key_cache().lock().ok().and_then(|slot| slot.clone())
}

fn remember_key(key: Option<String>) {
    if let Ok(mut slot) = key_cache().lock() {
        *slot = Some(key);
    }
}

fn env_key() -> Option<String> {
    std::env::var(DEFAULT_KEY_ENV)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Validate and trim a key the user pasted. Keys are opaque single-line
/// tokens; a newline or space is always a paste accident, not part of a key.
pub fn validated_key(value: &str) -> Result<String, String> {
    let key = value.trim();
    if key.is_empty() {
        return Err("the OpenCode API key is empty".to_string());
    }
    if key.chars().count() > MAX_KEY_CHARS {
        return Err("the OpenCode API key is too long".to_string());
    }
    if !key.chars().all(|c| c.is_ascii_graphic()) {
        return Err("the OpenCode API key contains spaces or control characters".to_string());
    }
    Ok(key.to_string())
}

fn keychain_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USER)
        .map_err(|e| format!("OS keychain is unavailable: {e}"))
}

fn keychain_get_blocking() -> Result<Option<String>, String> {
    let entry = keychain_entry()?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value.trim().to_string()).filter(|v| !v.is_empty())),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!(
            "could not read the OpenCode key from the OS keychain: {e}"
        )),
    }
}

fn keychain_set_blocking(key: &str) -> Result<(), String> {
    keychain_entry()?
        .set_password(key)
        .map_err(|e| format!("could not store the OpenCode key in the OS keychain: {e}"))
}

fn keychain_delete_blocking() -> Result<(), String> {
    let entry = keychain_entry()?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!(
            "could not remove the OpenCode key from the OS keychain: {e}"
        )),
    }
}

/// Keychain access can block (and on macOS can show a system prompt), so it
/// never runs directly on a runtime worker.
async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| format!("background task failed: {e}"))?
}

async fn load_stored_key() -> Option<String> {
    if let Some(slot) = cached_slot() {
        return slot;
    }
    let key = match run_blocking(keychain_get_blocking).await {
        Ok(key) => key,
        Err(e) => {
            log::warn!("opencode: {e}");
            None
        }
    };
    remember_key(key.clone());
    key
}

/// Prime the in-memory key cache once, so `info()` and the provider list can
/// tell whether a key is saved without touching the keychain again.
pub async fn prime_key_cache() {
    let _ = load_stored_key().await;
}

/// The active key: a saved keychain entry first, then `OPENCODE_API_KEY`.
async fn load_key() -> Option<String> {
    let stored = load_stored_key().await;
    stored.or_else(env_key)
}

/// Save a key the user pasted in Settings → Providers.
pub async fn store_key(value: &str) -> Result<(), String> {
    let key = validated_key(value)?;
    let to_store = key.clone();
    run_blocking(move || keychain_set_blocking(&to_store)).await?;
    remember_key(Some(key));
    Ok(())
}

/// Remove the app's own keychain entry. `OPENCODE_API_KEY` is not touched.
pub async fn clear_key() -> Result<(), String> {
    run_blocking(keychain_delete_blocking).await?;
    remember_key(None);
    Ok(())
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    /// A key is stored in the app's OS-keychain entry.
    pub saved: bool,
    /// `OPENCODE_API_KEY` is set in the app's environment.
    pub from_env: bool,
}

pub async fn key_status() -> KeyStatus {
    prime_key_cache().await;
    KeyStatus {
        saved: cached_slot().flatten().is_some(),
        from_env: env_key().is_some(),
    }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

#[cfg_attr(not(test), allow(dead_code))]
enum KeySource {
    Keychain,
    /// Tests only: never touch the real keychain.
    Fixed(Option<String>),
}

pub struct OpenCodeProvider {
    ctx: ProviderCtx,
    workspace_id: Option<String>,
    /// The user typed something in the workspace field that is not a valid id;
    /// say so instead of silently dropping the header.
    invalid_workspace: bool,
    key_source: KeySource,
}

impl OpenCodeProvider {
    pub fn new(ctx: ProviderCtx) -> Self {
        let raw = ctx.opencode_workspace_id.trim().to_string();
        Self {
            workspace_id: workspace_id(&raw),
            invalid_workspace: !raw.is_empty() && workspace_id(&raw).is_none(),
            ctx,
            key_source: KeySource::Keychain,
        }
    }

    #[cfg(test)]
    fn with_key(ctx: ProviderCtx, key: Option<&str>) -> Self {
        let raw = ctx.opencode_workspace_id.trim().to_string();
        Self {
            workspace_id: workspace_id(&raw),
            invalid_workspace: !raw.is_empty() && workspace_id(&raw).is_none(),
            ctx,
            key_source: KeySource::Fixed(key.map(str::to_string)),
        }
    }

    async fn key(&self) -> Option<String> {
        match &self.key_source {
            KeySource::Keychain => load_key().await,
            KeySource::Fixed(key) => key.clone(),
        }
    }

    fn has_key(&self) -> bool {
        match &self.key_source {
            KeySource::Keychain => cached_slot().flatten().is_some() || env_key().is_some(),
            KeySource::Fixed(key) => key.is_some(),
        }
    }

    fn fail(&self, status: ProviderStatus, message: impl Into<String>) -> ProviderQuota {
        degraded(&self.ctx, OPENCODE_ID, DISPLAY_NAME, status, message)
    }

    /// The workspace's budgets, or `None` when Console refuses them (it does
    /// for service-account keys) or answers with something unexpected. A
    /// missing budget must never turn a good Go answer into an error.
    async fn fetch_budgets(
        &self,
        http: &reqwest::Client,
        key: &str,
        workspace_id: &str,
    ) -> Option<Vec<Budget>> {
        let resp = send_with_retry(&self.ctx, || {
            http.get(self.ctx.endpoint(BUDGETS_URL))
                .bearer_auth(key)
                .header("Accept", "application/json")
                .header("x-org-id", workspace_id)
        })
        .await
        .ok()?;
        if !resp.status().is_success() {
            log::debug!("opencode budgets: HTTP {}", resp.status().as_u16());
            return None;
        }
        let body = resp.bytes().await.ok()?;
        serde_json::from_slice::<Vec<Budget>>(&body)
            .map_err(|e| log::debug!("opencode budgets response has an unexpected shape: {e}"))
            .ok()
    }
}

#[async_trait]
impl Provider for OpenCodeProvider {
    fn id(&self) -> &'static str {
        OPENCODE_ID
    }

    fn display_name(&self) -> &'static str {
        DISPLAY_NAME
    }

    fn experimental(&self) -> bool {
        true
    }

    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            id: OPENCODE_ID.into(),
            display_name: DISPLAY_NAME.into(),
            logged_in: self.has_key(),
            // no file of our own to point at; say what holds the credential
            credential_path: Some(format!("OS keychain or ${DEFAULT_KEY_ENV}")),
            log_path: None,
            plan_label: None,
            experimental: true,
        }
    }

    async fn fetch(&self, http: &reqwest::Client) -> ProviderQuota {
        let Some(key) = self.key().await else {
            let mut q = empty_quota(OPENCODE_ID, DISPLAY_NAME, ProviderStatus::NotLoggedIn);
            q.error = Some(not_logged_in_message());
            return q;
        };
        if self.invalid_workspace {
            return self.fail(ProviderStatus::Error, INVALID_WORKSPACE_MESSAGE);
        }

        let resp = match send_with_retry(&self.ctx, || {
            let mut request = http
                .get(self.ctx.endpoint(USAGE_URL))
                .bearer_auth(&key)
                .header("Accept", "application/json");
            if let Some(workspace) = &self.workspace_id {
                request = request.header("x-opencode-org-id", workspace);
            }
            request
        })
        .await
        {
            Ok(resp) => resp,
            Err(e) => {
                log::warn!("opencode usage request failed: {e}");
                return self.fail(
                    ProviderStatus::Error,
                    format!("Could not reach opencode.ai: {e}"),
                );
            }
        };

        let status = resp.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return self.fail(ProviderStatus::TokenExpired, EXPIRED_MESSAGE);
        }
        if status == reqwest::StatusCode::FORBIDDEN {
            // The key is valid but this workspace has no Go subscription (or
            // the workspace header is missing). Zen budgets are the other
            // product on the same account; show the tightest one if Console
            // lets this key read them.
            let zen = match &self.workspace_id {
                Some(workspace) => self.fetch_budgets(http, &key, workspace).await,
                None => None,
            };
            if let Some(budget) = zen.as_deref().and_then(tightest_budget) {
                let mut quota = empty_quota(OPENCODE_ID, DISPLAY_NAME, ProviderStatus::Ok);
                quota.windows = vec![budget_window(budget)];
                quota.plan_label = Some("Zen".to_string());
                quota.extras.push(QuotaExtra::value(
                    "zen_budget",
                    budget_value(budget),
                    ExtraSeverity::Info,
                ));
                quota.fetched_at = now_rfc3339();
                write_cache(&self.ctx, &quota);
                return quota;
            }
            return self.fail(ProviderStatus::Error, NO_GO_MESSAGE);
        }
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let retry_after = retry_after_of(resp.headers());
            log::warn!("opencode answered HTTP 429");
            return rate_limited(
                &self.ctx,
                OPENCODE_ID,
                DISPLAY_NAME,
                retry_after,
                "OpenCode is rate-limiting the usage endpoint (HTTP 429); showing the last known values until the next attempt",
            );
        }
        if !status.is_success() {
            return self.fail(
                ProviderStatus::Error,
                format!("OpenCode usage API returned HTTP {}", status.as_u16()),
            );
        }

        let body = match resp.bytes().await {
            Ok(body) => body,
            Err(e) => {
                return self.fail(
                    ProviderStatus::Error,
                    format!("Could not read the OpenCode response: {e}"),
                )
            }
        };
        let usage = match serde_json::from_slice::<UsageEnvelope>(&body) {
            Ok(env) => env.usage,
            Err(e) => {
                log::warn!("opencode usage response has an unexpected shape: {e}");
                return self.fail(
                    ProviderStatus::Error,
                    format!("Unexpected OpenCode response: {e}"),
                );
            }
        };

        let mut quota = empty_quota(OPENCODE_ID, DISPLAY_NAME, ProviderStatus::Ok);
        quota.windows = map_go(&usage);
        quota.plan_label = Some("Go".to_string());

        // Go and Zen can be on the same workspace; report the tightest Zen
        // budget as an extra line, without adding a fourth ring.
        if let Some(workspace) = &self.workspace_id {
            if let Some(budget) = self
                .fetch_budgets(http, &key, workspace)
                .await
                .as_deref()
                .and_then(tightest_budget)
            {
                quota.extras.push(QuotaExtra::value(
                    "zen_budget",
                    budget_value(budget),
                    ExtraSeverity::Info,
                ));
                quota.plan_label = Some("Go + Zen".to_string());
            }
        }

        quota.fetched_at = now_rfc3339();
        write_cache(&self.ctx, &quota);
        quota
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::StubServer;
    use std::time::Duration;

    // ---- Fixtures are written from OpenCode's own source, NOT captured live. ----

    const GO: &str = r#"{"usage":{
        "rolling":{"status":"ok","percent":42,"resetsAt":"2026-10-24T17:00:00.000Z"},
        "weekly":{"status":"ok","percent":18,"resetsAt":"2026-10-29T00:00:00.000Z"},
        "monthly":{"status":"rate-limited","percent":100,"resetsAt":"2026-11-01T00:00:00.000Z"}}}"#;
    const BUDGETS: &str = r#"[{"ruleID":"rule_astra","limitDollars":20,"spentDollars":15,
        "scope":"each","per":"model","coverage":"all","models":[],"vendors":[],
        "picked":false,"shared":false,"resetsAt":"2026-11-01T00:00:00.000Z"}]"#;

    fn stub(server: &StubServer, workspace: &str, key: Option<&str>) -> OpenCodeProvider {
        OpenCodeProvider::with_key(
            ProviderCtx {
                api_base: Some(server.base.clone()),
                retry_delay: Duration::from_millis(5),
                opencode_workspace_id: workspace.to_string(),
                ..ProviderCtx::default()
            },
            key,
        )
    }

    fn ok(body: &str) -> (&'static str, Vec<(&'static str, &'static str)>, String) {
        ("200 OK", vec![], body.to_string())
    }

    #[tokio::test]
    async fn go_becomes_five_hour_weekly_and_thirty_day_windows() {
        let server = StubServer::start(vec![ok(GO)]);
        let q = stub(&server, "", Some("sk-opencode-test-not-a-real-key"))
            .fetch(&reqwest::Client::new())
            .await;
        assert_eq!(q.status, ProviderStatus::Ok);
        assert_eq!(q.plan_label.as_deref(), Some("Go"));
        assert_eq!(q.windows.len(), 3);
        assert_eq!(q.windows[0].kind, WindowKind::FiveHour);
        assert_eq!(q.windows[0].label, "5-hour");
        assert_eq!(q.windows[0].window_seconds, Some(18_000));
        assert!((q.windows[0].used_percent - 42.0).abs() < 1e-9);
        assert!(q.windows[0].is_primary);
        assert_eq!(q.windows[1].kind, WindowKind::SevenDay);
        assert_eq!(q.windows[1].label, "Weekly");
        assert!((q.windows[1].used_percent - 18.0).abs() < 1e-9);
        assert_eq!(q.windows[2].kind, WindowKind::Other);
        assert_eq!(q.windows[2].label, "30-day");
        assert_eq!(q.windows[2].window_seconds, Some(2_592_000));
        assert!((q.windows[2].used_percent - 100.0).abs() < 1e-9);
        assert_eq!(
            q.windows[0].resets_at.as_deref(),
            Some("2026-10-24T17:00:00Z")
        );
        assert_eq!(server.hits(), 1, "no workspace id, no budget request");
    }

    #[tokio::test]
    async fn a_workspace_also_reports_its_tightest_zen_budget() {
        // Go succeeds, then the budget call (same workspace) adds one extra.
        let server = StubServer::start(vec![ok(GO), ok(BUDGETS)]);
        let q = stub(
            &server,
            "wrk_anomaly",
            Some("sk-opencode-test-not-a-real-key"),
        )
        .fetch(&reqwest::Client::new())
        .await;
        assert_eq!(q.status, ProviderStatus::Ok);
        assert_eq!(q.windows.len(), 3, "Zen is an extra, not a fourth ring");
        assert_eq!(q.plan_label.as_deref(), Some("Go + Zen"));
        assert_eq!(q.extras[0].kind, "zen_budget");
        assert_eq!(q.extras[0].value.as_deref(), Some("$15.00 / $20.00"));
        assert_eq!(server.hits(), 2);
    }

    #[tokio::test]
    async fn a_key_without_go_shows_the_zen_budget_instead() {
        let server = StubServer::start(vec![("403 Forbidden", vec![], "{}".into()), ok(BUDGETS)]);
        let q = stub(
            &server,
            "wrk_anomaly",
            Some("sk-opencode-test-not-a-real-key"),
        )
        .fetch(&reqwest::Client::new())
        .await;
        assert_eq!(q.status, ProviderStatus::Ok);
        assert_eq!(q.plan_label.as_deref(), Some("Zen"));
        assert_eq!(q.windows.len(), 1);
        assert_eq!(q.windows[0].label, "Zen budget");
        assert!((q.windows[0].used_percent - 75.0).abs() < 1e-9);
        assert!(q.windows[0].is_primary);
        assert_eq!(q.extras[0].value.as_deref(), Some("$15.00 / $20.00"));
    }

    #[tokio::test]
    async fn a_403_without_readable_budgets_says_go_is_not_enabled() {
        let server = StubServer::start(vec![
            ("403 Forbidden", vec![], "{}".into()),
            ("403 Forbidden", vec![], "{}".into()),
        ]);
        let q = stub(
            &server,
            "wrk_anomaly",
            Some("sk-opencode-test-not-a-real-key"),
        )
        .fetch(&reqwest::Client::new())
        .await;
        assert_eq!(q.status, ProviderStatus::Error);
        assert_eq!(q.error.as_deref(), Some(NO_GO_MESSAGE));
        assert!(q.windows.is_empty());
        // a failed read keeps the previous good values, when there are any
        assert_eq!(server.hits(), 2);
    }

    #[tokio::test]
    async fn a_401_means_the_key_was_rejected() {
        let server = StubServer::start(vec![("401 Unauthorized", vec![], "{}".into())]);
        let q = stub(&server, "", Some("sk-opencode-test-not-a-real-key"))
            .fetch(&reqwest::Client::new())
            .await;
        assert_eq!(q.status, ProviderStatus::TokenExpired);
        assert_eq!(q.error.as_deref(), Some(EXPIRED_MESSAGE));
    }

    #[tokio::test]
    async fn a_429_is_rate_limited_not_an_error() {
        let server = StubServer::start(vec![(
            "429 Too Many Requests",
            vec![("Retry-After", "120")],
            "{}".into(),
        )]);
        let q = stub(&server, "", Some("sk-opencode-test-not-a-real-key"))
            .fetch(&reqwest::Client::new())
            .await;
        assert_eq!(q.status, ProviderStatus::RateLimited);
        assert!(q.next_attempt_at.is_some());
        assert_eq!(server.hits(), 1, "429 is final, not retried");
    }

    #[tokio::test]
    async fn no_key_is_not_logged_in_and_makes_no_request() {
        let server = StubServer::start(vec![ok(GO)]);
        let p = stub(&server, "", None);
        let q = p.fetch(&reqwest::Client::new()).await;
        assert_eq!(q.status, ProviderStatus::NotLoggedIn);
        assert!(q.error.unwrap().contains(DEFAULT_KEY_ENV));
        assert_eq!(server.hits(), 0);
        assert!(!p.info().logged_in);
    }

    #[tokio::test]
    async fn an_invalid_workspace_id_is_reported_without_a_request() {
        let server = StubServer::start(vec![ok(GO)]);
        let q = stub(
            &server,
            "not a workspace",
            Some("sk-opencode-test-not-a-real-key"),
        )
        .fetch(&reqwest::Client::new())
        .await;
        assert_eq!(q.status, ProviderStatus::Error);
        assert_eq!(q.error.as_deref(), Some(INVALID_WORKSPACE_MESSAGE));
        assert_eq!(server.hits(), 0);
    }

    #[test]
    fn a_workspace_id_is_read_from_a_bare_id_or_a_console_url() {
        assert_eq!(workspace_id("wrk_anomaly").as_deref(), Some("wrk_anomaly"));
        assert_eq!(
            workspace_id("https://opencode.ai/console/wrk_anomaly/activity/overview").as_deref(),
            Some("wrk_anomaly")
        );
        assert_eq!(
            workspace_id(" https://opencode.ai/console/wrk_anomaly/go?tab=usage ").as_deref(),
            Some("wrk_anomaly")
        );
        assert_eq!(workspace_id(""), None);
        assert_eq!(workspace_id("not a workspace"), None);
        assert_eq!(workspace_id("wrk_\nX"), None);
    }

    #[test]
    fn pasted_keys_are_single_line_tokens() {
        assert_eq!(validated_key("  sk-abc  ").unwrap(), "sk-abc");
        assert!(validated_key("").is_err());
        assert!(validated_key("sk-abc\nsk-def").is_err());
        assert!(validated_key("sk abc").is_err());
        assert!(validated_key(&"x".repeat(MAX_KEY_CHARS + 1)).is_err());
    }

    #[test]
    fn the_windows_are_clamped_and_keep_a_parseable_reset() {
        let usage = UsageWindows {
            rolling: Meter {
                status: "ok".into(),
                percent: 140.0,
                resets_at: "2026-10-24T17:00:00.000Z".into(),
            },
            weekly: Meter {
                status: "ok".into(),
                percent: -3.0,
                resets_at: "not a date".into(),
            },
            monthly: Meter::default(),
        };
        let windows = map_go(&usage);
        assert_eq!(windows[0].used_percent, 100.0);
        assert_eq!(windows[1].used_percent, 0.0);
        assert_eq!(windows[1].resets_at, None);
    }
}
