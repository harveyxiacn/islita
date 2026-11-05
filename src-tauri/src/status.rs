//! Service status for the Claude and OpenAI status pages. [BACKEND]
//!
//! Both are hosted Statuspage instances, so the public `/api/v2/summary.json`
//! endpoint gives the page indicator, description and recent incidents without
//! an account. [`service_status`] is the only command: it fetches both pages
//! concurrently and keeps the combined report for [`CACHE_TTL`] in memory, so
//! reopening the island panel does not hit the endpoints again.
//!
//! One status page failing never fails the command: each [`ServiceStatus`]
//! carries its own `error`, and the other service still renders. No credential
//! is read and no response body is ever logged.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

/// How long a combined report may be reused before both pages are polled again.
pub const CACHE_TTL: Duration = Duration::from_secs(60);
/// Both requests share this budget. Statuspage answers well within it.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
/// The panel shows at most three incidents per service.
const MAX_INCIDENTS: usize = 3;

pub const CLAUDE_SUMMARY: &str = "https://status.claude.com/api/v2/summary.json";
pub const OPENAI_SUMMARY: &str = "https://status.openai.com/api/v2/summary.json";

struct ServiceDef {
    id: &'static str,
    name: &'static str,
    page: &'static str,
    summary: &'static str,
}

const CLAUDE: ServiceDef = ServiceDef {
    id: "claude",
    name: "Claude",
    page: "https://status.claude.com",
    summary: CLAUDE_SUMMARY,
};

const OPENAI: ServiceDef = ServiceDef {
    id: "openai",
    name: "OpenAI",
    page: "https://status.openai.com",
    summary: OPENAI_SUMMARY,
};

/// Combined report handed to `service_status` and the status panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusReport {
    /// Epoch milliseconds of the fetch that produced this report.
    pub fetched_at: i64,
    /// Always both services, in display order.
    pub services: Vec<ServiceStatus>,
}

/// One status page. `error` is set instead of the fields above when the page
/// could not be fetched; the other service is unaffected.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub id: String,
    pub name: String,
    pub url: String,
    /// One of `none`, `minor`, `major`, `critical`, `maintenance`, `unknown`.
    pub indicator: String,
    pub description: String,
    pub updated_at: Option<String>,
    pub incidents: Vec<StatusIncident>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusIncident {
    pub name: String,
    pub status: String,
    pub impact: String,
    /// Only https links are passed through, so the panel can open them safely.
    pub shortlink: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

static CACHE: Lazy<Mutex<Option<(Instant, StatusReport)>>> = Lazy::new(|| Mutex::new(None));

static HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .user_agent(concat!("islita/", env!("CARGO_PKG_VERSION")))
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(REQUEST_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

/// The Statuspage summary fields the panel needs. Everything is optional so a
/// changed upstream shape degrades to "unknown" instead of failing a service.
#[derive(Debug, Deserialize, Default)]
struct Summary {
    #[serde(default)]
    page: Option<Page>,
    #[serde(default)]
    status: Option<PageStatus>,
    #[serde(default)]
    incidents: Vec<RawIncident>,
}

#[derive(Debug, Deserialize, Default)]
struct Page {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct PageStatus {
    #[serde(default)]
    indicator: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawIncident {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    impact: Option<String>,
    #[serde(default)]
    shortlink: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

fn normalize_indicator(value: Option<&str>) -> &'static str {
    match value
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "none" => "none",
        "minor" => "minor",
        "major" => "major",
        "critical" => "critical",
        "maintenance" => "maintenance",
        _ => "unknown",
    }
}

fn https_link(value: Option<String>, fallback: &str) -> String {
    value
        .filter(|link| link.trim().to_ascii_lowercase().starts_with("https://"))
        .unwrap_or_else(|| fallback.to_string())
}

fn map_incident(raw: RawIncident) -> StatusIncident {
    StatusIncident {
        name: raw.name.unwrap_or_default().trim().to_string(),
        status: raw.status.unwrap_or_default().trim().to_ascii_lowercase(),
        impact: raw.impact.unwrap_or_default().trim().to_ascii_lowercase(),
        shortlink: raw
            .shortlink
            .filter(|link| link.trim().to_ascii_lowercase().starts_with("https://"))
            .unwrap_or_default(),
        created_at: raw.created_at,
        updated_at: raw.updated_at,
    }
}

/// Maps one decoded summary. Kept separate from the HTTP call so the parsing
/// rules can be tested against inline fixtures.
fn map_summary(def: &ServiceDef, summary: Summary) -> ServiceStatus {
    let page = summary.page.unwrap_or_default();
    let status = summary.status.unwrap_or_default();
    let incidents: Vec<StatusIncident> = summary
        .incidents
        .into_iter()
        .map(map_incident)
        .filter(|incident| !incident.name.is_empty())
        .take(MAX_INCIDENTS)
        .collect();

    ServiceStatus {
        id: def.id.to_string(),
        name: page
            .name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| def.name.to_string()),
        url: https_link(page.url, def.page),
        indicator: normalize_indicator(status.indicator.as_deref()).to_string(),
        description: status.description.unwrap_or_default().trim().to_string(),
        updated_at: page.updated_at,
        incidents,
        error: None,
    }
}

fn unavailable(def: &ServiceDef, error: String) -> ServiceStatus {
    ServiceStatus {
        id: def.id.to_string(),
        name: def.name.to_string(),
        url: def.page.to_string(),
        indicator: "unknown".to_string(),
        description: String::new(),
        updated_at: None,
        incidents: Vec::new(),
        error: Some(error),
    }
}

/// A short, human-readable failure. The response body is deliberately not
/// included: status pages may return an HTML error page, and the panel only
/// needs to know which service is unavailable.
fn describe_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return "the status page did not answer within 8 seconds".to_string();
    }
    if let Some(status) = error.status() {
        return format!("HTTP {}", status.as_u16());
    }
    if error.is_connect() {
        return "could not connect to the status page".to_string();
    }
    if error.is_decode() {
        return "the status page returned an unexpected payload".to_string();
    }
    "the status page could not be read".to_string()
}

async fn fetch_service(http: &reqwest::Client, def: &ServiceDef) -> ServiceStatus {
    match http.get(def.summary).send().await {
        Ok(response) => match response.error_for_status() {
            Ok(response) => match response.json::<Summary>().await {
                Ok(summary) => map_summary(def, summary),
                Err(error) => unavailable(def, describe_error(&error)),
            },
            Err(error) => unavailable(def, describe_error(&error)),
        },
        Err(error) => unavailable(def, describe_error(&error)),
    }
}

async fn fetch_all() -> StatusReport {
    let (claude, openai) =
        tokio::join!(fetch_service(&HTTP, &CLAUDE), fetch_service(&HTTP, &OPENAI));
    StatusReport {
        fetched_at: chrono::Utc::now().timestamp_millis(),
        services: vec![claude, openai],
    }
}

fn cached_report() -> Option<StatusReport> {
    let cache = CACHE.lock();
    let (at, report) = cache.as_ref()?;
    (at.elapsed() < CACHE_TTL).then(|| report.clone())
}

/// Fetches both status pages, or reuses the last combined report for up to
/// [`CACHE_TTL`]. `force` is used by the panel's explicit refresh/retry.
pub async fn report(force: bool) -> StatusReport {
    if !force {
        if let Some(report) = cached_report() {
            return report;
        }
    }
    let report = fetch_all().await;
    *CACHE.lock() = Some((Instant::now(), report.clone()));
    report
}

/// Both official status pages. Never fails as a whole; per-service failures
/// are reported in `services[*].error`.
#[tauri::command]
pub async fn service_status(force: Option<bool>) -> StatusReport {
    report(force.unwrap_or(false)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE_FIXTURE: &str = r#"{
      "page": {
        "id": "tymt9n04zgry",
        "name": "Claude",
        "url": "https://status.claude.com",
        "updated_at": "2026-11-05T08:00:00.000Z"
      },
      "status": {
        "indicator": "none",
        "description": "All Systems Operational"
      },
      "incidents": []
    }"#;

    const OPENAI_FIXTURE: &str = r#"{
      "page": {
        "name": "OpenAI",
        "url": "https://status.openai.com",
        "updated_at": "2026-11-05T08:05:00.000Z"
      },
      "status": {
        "indicator": "minor",
        "description": "Partially degraded service"
      },
      "incidents": [
        {
          "name": "Elevated error rates on ChatGPT",
          "status": "monitoring",
          "impact": "minor",
          "shortlink": "https://stspg.io/openai-one",
          "created_at": "2026-11-05T07:30:00.000Z",
          "updated_at": "2026-11-05T08:04:00.000Z"
        },
        {
          "name": "API latency in us-east",
          "status": "identified",
          "impact": "major",
          "shortlink": "https://stspg.io/openai-two",
          "created_at": "2026-11-04T20:00:00.000Z",
          "updated_at": "2026-11-04T21:00:00.000Z"
        },
        {
          "name": "Login issues",
          "status": "resolved",
          "impact": "critical",
          "shortlink": "https://stspg.io/openai-three",
          "created_at": "2026-11-03T10:00:00.000Z",
          "updated_at": "2026-11-03T12:00:00.000Z"
        },
        {
          "name": "Older incident that must be dropped",
          "status": "resolved",
          "impact": "minor",
          "shortlink": "https://stspg.io/openai-four",
          "created_at": "2026-11-01T10:00:00.000Z",
          "updated_at": "2026-11-01T11:00:00.000Z"
        }
      ]
    }"#;

    fn parse(def: &ServiceDef, raw: &str) -> ServiceStatus {
        let summary: Summary = serde_json::from_str(raw).expect("fixture is valid JSON");
        map_summary(def, summary)
    }

    #[test]
    fn maps_an_operational_page() {
        let status = parse(&CLAUDE, CLAUDE_FIXTURE);
        assert_eq!(status.id, "claude");
        assert_eq!(status.name, "Claude");
        assert_eq!(status.url, "https://status.claude.com");
        assert_eq!(status.indicator, "none");
        assert_eq!(status.description, "All Systems Operational");
        assert_eq!(
            status.updated_at.as_deref(),
            Some("2026-11-05T08:00:00.000Z")
        );
        assert!(status.incidents.is_empty());
        assert!(status.error.is_none());
    }

    #[test]
    fn keeps_only_the_three_most_recent_incidents() {
        let status = parse(&OPENAI, OPENAI_FIXTURE);
        assert_eq!(status.indicator, "minor");
        assert_eq!(status.description, "Partially degraded service");
        assert_eq!(status.incidents.len(), MAX_INCIDENTS);

        let first = &status.incidents[0];
        assert_eq!(first.name, "Elevated error rates on ChatGPT");
        assert_eq!(first.status, "monitoring");
        assert_eq!(first.impact, "minor");
        assert_eq!(first.shortlink, "https://stspg.io/openai-one");
        assert_eq!(
            first.created_at.as_deref(),
            Some("2026-11-05T07:30:00.000Z")
        );
        assert_eq!(
            first.updated_at.as_deref(),
            Some("2026-11-05T08:04:00.000Z")
        );
        assert!(!status
            .incidents
            .iter()
            .any(|incident| incident.name.contains("Older")));
    }

    #[test]
    fn unknown_or_missing_fields_degrade_instead_of_failing() {
        let status = parse(
            &OPENAI,
            r#"{"status":{"indicator":" RESPONDING ","description":"  Degraded  "}}"#,
        );
        assert_eq!(status.indicator, "unknown");
        assert_eq!(status.description, "Degraded");
        assert_eq!(status.name, "OpenAI");
        assert_eq!(status.url, "https://status.openai.com");
        assert!(status.updated_at.is_none());
        assert!(status.incidents.is_empty());
        assert!(status.error.is_none());
    }

    #[test]
    fn non_https_links_and_nameless_incidents_are_dropped() {
        let status = parse(
            &CLAUDE,
            r#"{
              "page": {"url": "javascript:alert(1)"},
              "incidents": [
                {"name": "", "shortlink": "https://stspg.io/dropped"},
                {"name": "Safe", "status": "resolved", "impact": "minor", "shortlink": "http://insecure.example"}
              ]
            }"#,
        );
        assert_eq!(status.url, "https://status.claude.com");
        assert_eq!(status.incidents.len(), 1);
        assert_eq!(status.incidents[0].name, "Safe");
        assert_eq!(status.incidents[0].shortlink, "");
        assert_eq!(status.indicator, "unknown");
    }

    #[test]
    fn a_failed_service_does_not_blank_the_other() {
        let failed = unavailable(&OPENAI, "HTTP 503".to_string());
        let healthy = parse(&CLAUDE, CLAUDE_FIXTURE);
        assert_eq!(failed.error.as_deref(), Some("HTTP 503"));
        assert_eq!(failed.indicator, "unknown");
        assert!(failed.incidents.is_empty());
        assert!(healthy.error.is_none());
        assert_eq!(healthy.indicator, "none");
    }

    #[test]
    fn the_report_serializes_with_camel_case_keys() {
        let value = serde_json::to_value(parse(&CLAUDE, CLAUDE_FIXTURE)).unwrap();
        assert_eq!(value["updatedAt"], "2026-11-05T08:00:00.000Z");
        assert!(value.get("updated_at").is_none());
        assert_eq!(value["incidents"], serde_json::json!([]));
    }
}
