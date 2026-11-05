//! Cloud mail accounts. [BACKEND]
//!
//! The local folder reader in `mail.rs` needs no account. This module is the
//! opt-in alternative: the user connects a mailbox once and the app reads the
//! **headers of unread inbox mail** until the account is removed.
//!
//! Three sign-in routes, chosen by the user:
//!
//! * Gmail OAuth (bring your own Google "Desktop app" client ID + secret);
//! * Microsoft Outlook OAuth (bring your own public client ID);
//! * IMAP with an app password (Gmail, Outlook or any other IMAP server).
//!
//! Secrets never enter `settings.json`, `cloud-accounts.json`, a log line or
//! localStorage. Refresh/access tokens, client secrets and IMAP passwords live
//! in the OS keychain (`keyring`); the JSON file holds only what the UI needs
//! to draw an account row. OAuth uses authorization code + PKCE with a
//! loopback redirect on `127.0.0.1`, state validation and a five-minute
//! timeout. Mail is read-only: Tokens request the narrowest read scopes
//! (`gmail.readonly`, `Mail.Read`) and IMAP only fetches `RFC822.HEADER`.

use crate::commands::mail::{clean, decode_header, parse_date, MailMessage};
use crate::commands::settings;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

pub const MAX_ACCOUNTS: usize = 6;
const MAX_MESSAGES: usize = 20;
const MAX_SUBJECT: usize = 240;
const MAX_FROM: usize = 160;
const MAX_LABEL: usize = 60;
const MAX_EMAIL: usize = 160;
const MAX_ERROR: usize = 300;
const MAX_PASSWORD: usize = 512;
const MAX_CLIENT_ID: usize = 300;
const MAX_CLIENT_SECRET: usize = 400;
const ACCOUNTS_FILE: &str = "cloud-accounts.json";
const KEYCHAIN_SERVICE: &str = "io.github.harveyxiacn.islita.mail";
const OAUTH_TIMEOUT: Duration = Duration::from_secs(300);
/// Kept for documentation and for providers/libraries that normalize the
/// loopback redirect to a path. The primary redirect is the host root, which
/// both Google and Microsoft accept without pre-registering an ephemeral port.
const OAUTH_CALLBACK_PATH: &str = "/oauth/callback";

/// `mail_cloud_oauth_cancel` flips this; the loopback wait checks it every
/// few milliseconds. Reset at the start of every new sign-in.
static OAUTH_CANCELLED: AtomicBool = AtomicBool::new(false);

// ---------------------------------------------------------------------------
// Types shared with the webview
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CloudAccount {
    pub id: String,
    /// `gmail` | `outlook` | `imap`
    pub provider: String,
    /// `oauth` | `password`
    pub mode: String,
    pub email: String,
    pub display_name: String,
    pub label: String,
    pub server: String,
    pub port: u16,
    pub username: String,
    /// STARTTLS (usually port 143). Implicit TLS (usually 993) is `false`.
    pub starttls: bool,
    pub enabled: bool,
    pub created_at_ms: i64,
    pub last_check_ms: i64,
    pub last_error: String,
    /// OAuth client id, needed again when the access token is refreshed. The
    /// client *secret* is not here; it is in the keychain.
    pub client_id: String,
    /// Unix ms at which the cached access token stops being used.
    pub access_expires_at_ms: i64,
}

impl Default for CloudAccount {
    fn default() -> Self {
        Self {
            id: String::new(),
            provider: "imap".to_string(),
            mode: "password".to_string(),
            email: String::new(),
            display_name: String::new(),
            label: String::new(),
            server: String::new(),
            port: 993,
            username: String::new(),
            starttls: false,
            enabled: true,
            created_at_ms: 0,
            last_check_ms: 0,
            last_error: String::new(),
            client_id: String::new(),
            access_expires_at_ms: 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudMailScan {
    pub account: CloudAccount,
    pub messages: Vec<MailMessage>,
    /// Unread inbox messages reported by the provider (capped by `limit`).
    pub unread: usize,
    pub total: usize,
    /// The inbox holds more unread mail than this scan fetched.
    pub truncated: bool,
    pub checked_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordAccountRequest {
    pub provider: String,
    pub email: String,
    pub password: String,
    pub display_name: Option<String>,
    pub label: Option<String>,
    pub server: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub starttls: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct AccountsFile {
    accounts: Vec<CloudAccount>,
}

// ---------------------------------------------------------------------------
// Account metadata (never secrets)
// ---------------------------------------------------------------------------

fn accounts_path(config_dir: &Path) -> PathBuf {
    config_dir.join(ACCOUNTS_FILE)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn load_accounts(config_dir: &Path) -> Vec<CloudAccount> {
    let Ok(text) = std::fs::read_to_string(accounts_path(config_dir)) else {
        return Vec::new();
    };
    let Ok(file) = serde_json::from_str::<AccountsFile>(&text) else {
        log::warn!("cloud mail: ignoring an unreadable account list");
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    file.accounts
        .into_iter()
        .filter_map(normalize_loaded)
        .filter(|account| seen.insert(account.id.clone()))
        .take(MAX_ACCOUNTS)
        .collect()
}

/// Re-validate the file: it is user-readable and may have been edited. Bad
/// rows are dropped rather than shown as a broken account.
fn normalize_loaded(mut account: CloudAccount) -> Option<CloudAccount> {
    account.id = account.id.trim().to_string();
    if account.id.is_empty() || account.id.chars().count() > 160 {
        return None;
    }
    account.provider = normalize_provider(&account.provider).ok()?;
    if !matches!(account.mode.as_str(), "oauth" | "password") {
        return None;
    }
    if account.provider == "imap" && account.mode != "password" {
        return None;
    }
    account.email = account.email.trim().to_string();
    if account.email.is_empty() || account.email.chars().count() > MAX_EMAIL {
        return None;
    }
    account.display_name = clean(&account.display_name, MAX_LABEL);
    account.label = clean(&account.label, MAX_LABEL);
    account.server = account.server.trim().to_string();
    if account.server.is_empty() || account.server.chars().count() > 253 {
        return None;
    }
    account.username = account.username.trim().to_string();
    if account.username.is_empty() {
        account.username = account.email.clone();
    }
    account.last_error = clean(&account.last_error, MAX_ERROR);
    account.client_id = account.client_id.trim().to_string();
    Some(account)
}

fn save_accounts(config_dir: &Path, accounts: &[CloudAccount]) -> Result<(), String> {
    let payload = AccountsFile {
        accounts: accounts.to_vec(),
    };
    let bytes = serde_json::to_vec_pretty(&payload)
        .map_err(|error| format!("could not encode the mail account list: {error}"))?;
    std::fs::create_dir_all(config_dir)
        .map_err(|error| format!("could not create the config folder: {error}"))?;
    let path = accounts_path(config_dir);
    settings::write_atomic(&path, &bytes)
        .map_err(|error| format!("could not save the mail account list: {error:#}"))?;
    restrict_permissions(&path);
    Ok(())
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(error) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        log::warn!("cloud mail: could not restrict account file permissions: {error}");
    }
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

// ---------------------------------------------------------------------------
// OS keychain
// ---------------------------------------------------------------------------

fn keychain_user(account_id: &str, kind: &str) -> String {
    format!("{account_id}:{kind}")
}

fn keychain_set(account_id: &str, kind: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_user(account_id, kind))
        .map_err(|error| format!("OS keychain is unavailable: {error}"))?;
    entry
        .set_password(value)
        .map_err(|error| format!("could not store the mail secret in the OS keychain: {error}"))
}

fn keychain_get(account_id: &str, kind: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_user(account_id, kind))
        .map_err(|error| format!("OS keychain is unavailable: {error}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "could not read the mail secret from the OS keychain: {error}"
        )),
    }
}

fn keychain_delete(account_id: &str, kind: &str) {
    let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, &keychain_user(account_id, kind)) else {
        return;
    };
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(error) => log::warn!("cloud mail: could not delete a keychain entry: {error}"),
    }
}

fn keychain_delete_account(account_id: &str) {
    for kind in ["refresh", "access", "password", "client-secret"] {
        keychain_delete(account_id, kind);
    }
}

/// Keychain access can block (and on macOS can show a system prompt), so it
/// never runs directly on a runtime worker.
async fn run_keychain<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|error| format!("secure storage task failed: {error}"))?
}

// ---------------------------------------------------------------------------
// Validation and defaults
// ---------------------------------------------------------------------------

fn normalize_provider(value: &str) -> Result<String, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "gmail" => Ok("gmail".to_string()),
        "outlook" => Ok("outlook".to_string()),
        "imap" => Ok("imap".to_string()),
        _ => Err("Choose Gmail, Outlook or IMAP.".to_string()),
    }
}

fn provider_label(provider: &str) -> &'static str {
    match provider {
        "gmail" => "Gmail",
        "outlook" => "Outlook",
        _ => "IMAP",
    }
}

fn default_imap(provider: &str) -> Option<(&'static str, u16)> {
    match provider {
        "gmail" => Some(("imap.gmail.com", 993)),
        "outlook" => Some(("outlook.office365.com", 993)),
        _ => None,
    }
}

fn valid_email(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > MAX_EMAIL
        || value.chars().any(char::is_whitespace)
    {
        return false;
    }
    let Some((local, domain)) = value.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.is_empty()
        && !domain.contains('@')
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
}

fn valid_host(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.chars().count() <= 253
        && !value.contains('/')
        && !value.contains(':')
        && !value.chars().any(char::is_whitespace)
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

fn random_id() -> String {
    format!("mail-{}-{}", now_ms(), random_token(6))
}

// ---------------------------------------------------------------------------
// OAuth: PKCE, loopback redirect, token exchange
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct OAuthProvider {
    authorize_url: &'static str,
    token_url: &'static str,
    scope: &'static str,
    /// Extra authorization parameters (`access_type=offline`, …).
    extra_auth: &'static [(&'static str, &'static str)],
    /// Google's installed-app flow still requires the client secret at the
    /// token endpoint; Microsoft treats loopback clients as public.
    needs_secret: bool,
    imap_server: &'static str,
    imap_port: u16,
}

fn oauth_provider(provider: &str) -> Result<OAuthProvider, String> {
    match provider {
        "gmail" => Ok(OAuthProvider {
            authorize_url: "https://accounts.google.com/o/oauth2/v2/auth",
            token_url: "https://oauth2.googleapis.com/token",
            scope: "openid email profile https://www.googleapis.com/auth/gmail.readonly",
            extra_auth: &[("access_type", "offline"), ("prompt", "consent")],
            needs_secret: true,
            imap_server: "imap.gmail.com",
            imap_port: 993,
        }),
        "outlook" => Ok(OAuthProvider {
            authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            scope: "offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read",
            extra_auth: &[("prompt", "select_account")],
            needs_secret: false,
            imap_server: "outlook.office365.com",
            imap_port: 993,
        }),
        _ => Err("OAuth is available for Gmail and Outlook. Use an app password for other IMAP servers.".to_string()),
    }
}

fn random_token(bytes: usize) -> String {
    use base64::Engine;
    use rand::RngCore;
    let mut buffer = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buffer);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buffer)
}

fn pkce_challenge(verifier: &str) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

fn token_expiry(expires_in: Option<i64>, now: i64) -> i64 {
    let seconds = expires_in.unwrap_or(3600).clamp(60, 86_400);
    now.saturating_add(seconds * 1000).saturating_sub(30_000)
}

fn callback_value(query: &str, key: &str) -> Option<String> {
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
}

/// Bind the IPv4 loopback and, when available, the IPv6 loopback on the same
/// ephemeral port. The redirect uses `localhost`, which a browser may resolve
/// to either address.
fn bind_loopback() -> Result<(Vec<TcpListener>, u16), String> {
    let ipv4 = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Could not start the local sign-in listener: {error}"))?;
    let port = ipv4
        .local_addr()
        .map_err(|error| format!("Could not read the sign-in listener address: {error}"))?
        .port();
    let mut listeners = vec![ipv4];
    if let Ok(ipv6) = TcpListener::bind(("::1", port)) {
        listeners.push(ipv6);
    }
    for listener in &listeners {
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("Could not start the sign-in listener: {error}"))?;
    }
    Ok((listeners, port))
}

fn accept_any(listeners: &[TcpListener]) -> std::io::Result<Option<TcpStream>> {
    for listener in listeners {
        match listener.accept() {
            Ok((stream, _)) => return Ok(Some(stream)),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(None)
}

/// The loopback listeners exist only while a sign-in is in progress. Anything
/// that is not the callback path is answered with 404 and the listeners keep
/// waiting, so a browser's favicon probe cannot break the flow.
fn wait_for_callback(
    listeners: Vec<TcpListener>,
    expected_state: &str,
    timeout: Duration,
) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if OAUTH_CANCELLED.load(Ordering::SeqCst) {
            return Err("Sign-in was cancelled.".to_string());
        }
        if Instant::now() >= deadline {
            return Err(
                "Sign-in timed out. Try again when you are ready to finish in the browser."
                    .to_string(),
            );
        }
        let mut stream = match accept_any(&listeners) {
            Ok(Some(stream)) => stream,
            Ok(None) => {
                std::thread::sleep(Duration::from_millis(25));
                continue;
            }
            Err(error) => return Err(format!("The sign-in listener stopped: {error}")),
        };
        stream.set_nonblocking(false).ok();
        stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
        let request = match read_request(&mut stream) {
            Ok(request) => request,
            Err(_) => continue,
        };
        let Some(target) = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
        else {
            respond(&mut stream, "400 Bad Request", "Bad request.");
            continue;
        };
        // Both the root (the redirect both providers accept) and an explicit
        // path are handled, in case a provider normalizes the URI.
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        if path != "/" && path != OAUTH_CALLBACK_PATH {
            respond(&mut stream, "404 Not Found", "Not found.");
            continue;
        }
        let state = callback_value(query, "state").unwrap_or_default();
        if state != expected_state {
            respond(
                &mut stream,
                "400 Bad Request",
                "This sign-in response does not belong to this app window.",
            );
            continue;
        }
        if let Some(error) = callback_value(query, "error") {
            let description = callback_value(query, "error_description")
                .map(|value| clean(&value, 180))
                .unwrap_or_default();
            respond(
                &mut stream,
                "400 Bad Request",
                "Sign-in was not completed. You can close this tab.",
            );
            return Err(if error == "access_denied" {
                "Sign-in was cancelled in the browser.".to_string()
            } else if description.is_empty() {
                format!("The provider rejected the sign-in ({error}).")
            } else {
                format!("The provider rejected the sign-in ({error}): {description}")
            });
        }
        let Some(code) = callback_value(query, "code") else {
            respond(
                &mut stream,
                "400 Bad Request",
                "The sign-in response did not include a code.",
            );
            return Err("The provider did not return an authorization code.".to_string());
        };
        respond(
            &mut stream,
            "200 OK",
            "<!doctype html><meta charset=\"utf-8\"><title>Mail connected</title>\
             <style>body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:18vh auto;padding:0 1.5rem;color:#1d1d1f}strong{display:block;font-size:1.4rem;margin-bottom:.5rem}</style>\
             <strong>Mail connected</strong>You can close this tab and return to Islita.",
        );
        return Ok(code);
    }
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") || bytes.len() > 16 * 1024 {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn respond(stream: &mut TcpStream, status: &str, message: &str) {
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Islita</title>\
         <style>body{{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:18vh auto;padding:0 1.5rem;color:#1d1d1f}}</style>\
         <p>{message}</p>"
    );
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

#[derive(Debug, Default, Deserialize)]
struct TokenResponse {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

fn oauth_token_error(status: reqwest::StatusCode, code: &str, detail: &str) -> String {
    let hint = match code {
        "invalid_grant" => "The sign-in expired or was revoked. Reconnect the account.",
        "invalid_client" => {
            "The OAuth client ID or secret was rejected. Check the values from the provider console."
        }
        "redirect_uri_mismatch" => {
            "The provider rejected the loopback redirect. Allow http://localhost as a redirect URI for this client."
        }
        "invalid_scope" | "insufficient_scope" => {
            "The account did not grant read-only mail access. Reconnect and accept the mail permission."
        }
        _ => "",
    };
    let detail = clean(detail, 220);
    if !hint.is_empty() {
        return hint.to_string();
    }
    if detail.is_empty() {
        format!("The sign-in service returned HTTP {}.", status.as_u16())
    } else {
        format!(
            "The sign-in service returned HTTP {}: {detail}",
            status.as_u16()
        )
    }
}

async fn post_token(
    http: &reqwest::Client,
    token_url: &str,
    form: &[(&str, String)],
) -> Result<TokenResponse, String> {
    let response = http
        .post(token_url)
        .form(form)
        .send()
        .await
        .map_err(|error| {
            format!(
                "Could not reach the sign-in service: {}",
                clean(&error.to_string(), 180)
            )
        })?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let parsed = serde_json::from_str::<TokenResponse>(&text).unwrap_or_default();
    if !status.is_success() || parsed.error.is_some() {
        let code = parsed.error.as_deref().unwrap_or("");
        let detail = parsed.error_description.as_deref().unwrap_or("");
        return Err(oauth_token_error(status, code, detail));
    }
    Ok(parsed)
}

async fn fetch_identity(
    http: &reqwest::Client,
    provider: &str,
    access: &str,
) -> Result<(String, String), String> {
    let (url, label) = match provider {
        "gmail" => ("https://openidconnect.googleapis.com/v1/userinfo", "Google"),
        "outlook" => (
            "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName",
            "Microsoft Graph",
        ),
        _ => return Err("Unsupported sign-in provider.".to_string()),
    };
    let response = http
        .get(url)
        .bearer_auth(access)
        .send()
        .await
        .map_err(|error| format!("Could not read the {label} profile: {error}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(api_error(label, status, &text));
    }
    let value: serde_json::Value = serde_json::from_str(&text)
        .map_err(|_| format!("{label} returned an unreadable profile."))?;
    let field = |name: &str| {
        value
            .get(name)
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let (email, name) = if provider == "gmail" {
        (field("email"), field("name"))
    } else {
        let email = {
            let mail = field("mail");
            if mail.is_empty() {
                field("userPrincipalName")
            } else {
                mail
            }
        };
        (email, field("displayName"))
    };
    if !valid_email(&email) {
        return Err(format!(
            "{label} did not return a usable e-mail address for this account."
        ));
    }
    Ok((email, clean(&name, MAX_LABEL)))
}

fn api_error(label: &str, status: reqwest::StatusCode, body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| {
                    error
                        .get("message")
                        .and_then(|item| item.as_str())
                        .or_else(|| error.as_str())
                })
                .map(str::to_string)
        })
        .map(|message| clean(&message, 220))
        .unwrap_or_default();
    let hint = match status.as_u16() {
        401 => " Reconnect this account.",
        403 => " The account did not grant read-only mail access.",
        429 => " The provider is rate limiting; try again later.",
        _ => "",
    };
    if message.is_empty() {
        format!("{label} returned HTTP {}.{hint}", status.as_u16())
    } else {
        format!("{label} returned HTTP {}: {message}{hint}", status.as_u16())
    }
}

// ---------------------------------------------------------------------------
// Gmail API (read-only)
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GmailList {
    #[serde(default)]
    messages: Vec<GmailRef>,
    #[serde(default)]
    result_size_estimate: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct GmailRef {
    id: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GmailMessage {
    #[serde(default)]
    id: String,
    #[serde(default)]
    internal_date: Option<String>,
    #[serde(default)]
    payload: Option<GmailPayload>,
}

#[derive(Debug, Default, Deserialize)]
struct GmailPayload {
    #[serde(default)]
    headers: Vec<GmailHeader>,
}

#[derive(Debug, Deserialize)]
struct GmailHeader {
    name: String,
    value: String,
}

fn gmail_header<'a>(message: &'a GmailMessage, name: &str) -> &'a str {
    message
        .payload
        .as_ref()
        .and_then(|payload| {
            payload
                .headers
                .iter()
                .find(|header| header.name.eq_ignore_ascii_case(name))
        })
        .map(|header| header.value.as_str())
        .unwrap_or_default()
}

fn gmail_message_to_mail(message: &GmailMessage, fallback_id: &str) -> MailMessage {
    let id = if message.id.trim().is_empty() {
        fallback_id.to_string()
    } else {
        message.id.clone()
    };
    let date_ms = message
        .internal_date
        .as_deref()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or_else(now_ms);
    MailMessage {
        id,
        subject: clean(
            &decode_header(gmail_header(message, "Subject")),
            MAX_SUBJECT,
        ),
        from: clean(&decode_header(gmail_header(message, "From")), MAX_FROM),
        date_ms,
        unread: true,
    }
}

async fn scan_gmail(
    http: &reqwest::Client,
    access: &str,
    limit: usize,
) -> Result<(Vec<MailMessage>, usize, bool), String> {
    let response = http
        .get("https://gmail.googleapis.com/gmail/v1/users/me/messages")
        .bearer_auth(access)
        .query(&[
            ("q", "is:unread in:inbox".to_string()),
            ("maxResults", limit.to_string()),
        ])
        .send()
        .await
        .map_err(|error| format!("Could not reach Gmail: {error}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(api_error("Gmail", status, &text));
    }
    let list: GmailList = serde_json::from_str(&text)
        .map_err(|_| "Gmail returned an unreadable message list.".to_string())?;
    let mut messages = Vec::new();
    for reference in list.messages.iter().take(limit) {
        let response = http
            .get(format!(
                "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}",
                reference.id
            ))
            .bearer_auth(access)
            .query(&[
                ("format", "metadata".to_string()),
                ("metadataHeaders", "From".to_string()),
                ("metadataHeaders", "Subject".to_string()),
            ])
            .send()
            .await
            .map_err(|error| format!("Could not read a Gmail message header: {error}"))?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(api_error("Gmail", status, &body));
        }
        let Ok(message) = serde_json::from_str::<GmailMessage>(&body) else {
            continue;
        };
        messages.push(gmail_message_to_mail(&message, &reference.id));
    }
    let unread = list
        .result_size_estimate
        .map(|estimate| usize::try_from(estimate.max(0)).unwrap_or(limit))
        .unwrap_or(messages.len())
        .max(messages.len());
    let truncated = unread > messages.len();
    Ok((messages, unread, truncated))
}

// ---------------------------------------------------------------------------
// Microsoft Graph (read-only)
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct GraphList {
    #[serde(default)]
    value: Vec<GraphMessage>,
    #[serde(rename = "@odata.count", default)]
    count: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
struct GraphMessage {
    #[serde(default)]
    id: String,
    #[serde(default)]
    subject: Option<String>,
    #[serde(default)]
    from: Option<GraphRecipient>,
    #[serde(default, rename = "receivedDateTime")]
    received_date_time: Option<String>,
    #[serde(default, rename = "isRead")]
    is_read: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct GraphRecipient {
    #[serde(default, rename = "emailAddress")]
    email_address: Option<GraphAddress>,
}

#[derive(Debug, Default, Deserialize)]
struct GraphAddress {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    address: Option<String>,
}

fn graph_message_to_mail(message: &GraphMessage) -> Option<MailMessage> {
    if message.id.trim().is_empty() {
        return None;
    }
    let from = message
        .from
        .as_ref()
        .and_then(|recipient| recipient.email_address.as_ref())
        .map(|address| {
            let name = address.name.as_deref().unwrap_or_default().trim();
            let email = address.address.as_deref().unwrap_or_default().trim();
            match (name.is_empty(), email.is_empty()) {
                (false, false) => format!("{name} <{email}>"),
                (false, true) => name.to_string(),
                (true, false) => email.to_string(),
                (true, true) => String::new(),
            }
        })
        .unwrap_or_default();
    let date_ms = message
        .received_date_time
        .as_deref()
        .and_then(parse_date)
        .unwrap_or_else(now_ms);
    Some(MailMessage {
        id: message.id.clone(),
        subject: clean(message.subject.as_deref().unwrap_or_default(), MAX_SUBJECT),
        from: clean(&from, MAX_FROM),
        date_ms,
        unread: !message.is_read.unwrap_or(false),
    })
}

async fn scan_outlook(
    http: &reqwest::Client,
    access: &str,
    limit: usize,
) -> Result<(Vec<MailMessage>, usize, bool), String> {
    let response = http
        .get("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages")
        .bearer_auth(access)
        .header("ConsistencyLevel", "eventual")
        .query(&[
            ("$filter", "isRead eq false".to_string()),
            ("$top", limit.to_string()),
            ("$orderby", "receivedDateTime desc".to_string()),
            (
                "$select",
                "id,subject,from,receivedDateTime,isRead".to_string(),
            ),
            ("$count", "true".to_string()),
        ])
        .send()
        .await
        .map_err(|error| format!("Could not reach Outlook: {error}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(api_error("Outlook", status, &text));
    }
    let list: GraphList = serde_json::from_str(&text)
        .map_err(|_| "Outlook returned an unreadable message list.".to_string())?;
    let messages: Vec<MailMessage> = list
        .value
        .iter()
        .filter_map(graph_message_to_mail)
        .take(limit)
        .collect();
    let unread = list
        .count
        .map(|count| usize::try_from(count.max(0)).unwrap_or(messages.len()))
        .unwrap_or(messages.len())
        .max(messages.len());
    let truncated = unread > messages.len();
    Ok((messages, unread, truncated))
}

/// Exchange the authorization code, then read the account's address. The
/// caller stores the tokens only after both steps succeed, so a failed
/// sign-in leaves no half-connected account behind.
async fn oauth_tokens(
    http: &reqwest::Client,
    provider: &OAuthProvider,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
    client_id: &str,
    client_secret: &str,
) -> Result<TokenResponse, String> {
    let mut form: Vec<(&str, String)> = vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", code.to_string()),
        ("code_verifier", verifier.to_string()),
        ("redirect_uri", redirect_uri.to_string()),
        ("client_id", client_id.to_string()),
    ];
    if !client_secret.is_empty() {
        form.push(("client_secret", client_secret.to_string()));
    }
    post_token(http, provider.token_url, &form).await
}

async fn refresh_access_token(
    http: &reqwest::Client,
    account: &mut CloudAccount,
) -> Result<String, String> {
    let id = account.id.clone();
    let refresh_id = id.clone();
    let refresh = run_keychain(move || keychain_get(&refresh_id, "refresh"))
        .await?
        .ok_or_else(|| {
            "No saved sign-in for this account. Remove it and connect again.".to_string()
        })?;
    let secret_id = id.clone();
    let client_secret = run_keychain(move || keychain_get(&secret_id, "client-secret"))
        .await?
        .unwrap_or_default();
    let provider = oauth_provider(&account.provider)?;
    if account.client_id.trim().is_empty() {
        return Err(
            "This account has no OAuth client id. Remove it and connect again.".to_string(),
        );
    }
    let mut form: Vec<(&str, String)> = vec![
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", refresh),
        ("client_id", account.client_id.clone()),
    ];
    if !client_secret.is_empty() {
        form.push(("client_secret", client_secret));
    }
    let token = post_token(http, provider.token_url, &form).await?;
    let access = token
        .access_token
        .ok_or_else(|| "The sign-in service did not return an access token.".to_string())?;
    let expires = token_expiry(token.expires_in, now_ms());
    let access_id = id.clone();
    let access_for_store = access.clone();
    run_keychain(move || keychain_set(&access_id, "access", &access_for_store)).await?;
    if let Some(rotated) = token.refresh_token {
        let refresh_id = id.clone();
        run_keychain(move || keychain_set(&refresh_id, "refresh", &rotated)).await?;
    }
    account.access_expires_at_ms = expires;
    Ok(access)
}

async fn access_token(
    http: &reqwest::Client,
    account: &mut CloudAccount,
) -> Result<String, String> {
    let id = account.id.clone();
    let now = now_ms();
    if account.access_expires_at_ms > now.saturating_add(30_000) {
        let access_id = id.clone();
        if let Some(access) = run_keychain(move || keychain_get(&access_id, "access")).await? {
            return Ok(access);
        }
    }
    refresh_access_token(http, account).await
}

async fn scan_oauth(
    http: &reqwest::Client,
    account: &mut CloudAccount,
    limit: usize,
) -> Result<(Vec<MailMessage>, usize, bool), String> {
    let access = access_token(http, account).await?;
    match account.provider.as_str() {
        "gmail" => scan_gmail(http, &access, limit).await,
        "outlook" => scan_outlook(http, &access, limit).await,
        _ => Err("Unsupported OAuth mail provider.".to_string()),
    }
}

// ---------------------------------------------------------------------------
// IMAP with an app password
// ---------------------------------------------------------------------------

fn imap_error(error: imap::Error) -> String {
    let text = error.to_string();
    let lowered = text.to_ascii_lowercase();
    if lowered.contains("authenticationfailed")
        || lowered.contains("invalid credentials")
        || lowered.contains("login failed")
        || lowered.contains("authentication failed")
    {
        return "Sign-in failed. Check the address and app password (Gmail and Outlook require an app password, not your normal password).".to_string();
    }
    format!("IMAP: {}", clean(&text, 260))
}

fn header_value(headers: &[mailparse::MailHeader<'_>], name: &str) -> String {
    headers
        .iter()
        .find(|header| header.get_key_ref().eq_ignore_ascii_case(name))
        .map(|header| header.get_value())
        .unwrap_or_default()
}

fn imap_message(
    uid: imap::types::Uid,
    header: &[u8],
    internal_date_ms: Option<i64>,
    seen: bool,
) -> MailMessage {
    let headers = mailparse::parse_headers(header)
        .map(|(headers, _)| headers)
        .unwrap_or_default();
    let subject = clean(&header_value(&headers, "subject"), MAX_SUBJECT);
    let from = clean(&header_value(&headers, "from"), MAX_FROM);
    let date_ms = {
        let raw = header_value(&headers, "date");
        parse_date(&raw).or(internal_date_ms).unwrap_or_else(now_ms)
    };
    MailMessage {
        id: format!("imap-{uid}"),
        subject,
        from,
        date_ms,
        unread: !seen,
    }
}

fn scan_imap(
    account: &CloudAccount,
    password: &str,
    limit: usize,
) -> Result<(Vec<MailMessage>, usize, bool), String> {
    let tls = native_tls::TlsConnector::builder()
        .build()
        .map_err(|error| format!("Could not prepare TLS: {error}"))?;
    let address = (account.server.as_str(), account.port);
    let client = if account.starttls {
        imap::connect_starttls(address, &account.server, &tls)
    } else {
        imap::connect(address, &account.server, &tls)
    }
    .map_err(imap_error)?;
    let mut session = client
        .login(&account.username, password)
        .map_err(|(error, _)| imap_error(error))?;
    session.select("INBOX").map_err(imap_error)?;
    let unseen = session.uid_search("UNSEEN").map_err(imap_error)?;
    let total = unseen.len();
    let mut uids: Vec<imap::types::Uid> = unseen.into_iter().collect();
    // Newest messages normally have the highest UIDs.
    uids.sort_unstable_by(|a, b| b.cmp(a));
    uids.truncate(limit);
    let mut messages = Vec::new();
    if !uids.is_empty() {
        let set = uids
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let fetches = session
            .uid_fetch(set, "(UID RFC822.HEADER FLAGS INTERNALDATE)")
            .map_err(imap_error)?;
        for fetch in fetches.iter() {
            let Some(uid) = fetch.uid else {
                continue;
            };
            let Some(header) = fetch.header().or_else(|| fetch.body()) else {
                continue;
            };
            let seen = fetch
                .flags()
                .iter()
                .any(|flag| matches!(flag, imap::types::Flag::Seen));
            let internal_date = fetch.internal_date().map(|date| date.timestamp_millis());
            messages.push(imap_message(uid, header, internal_date, seen));
        }
    }
    session.logout().ok();
    messages.sort_by_key(|message| std::cmp::Reverse(message.date_ms));
    messages.truncate(limit);
    let unread = total.max(messages.iter().filter(|message| message.unread).count());
    let truncated = total > messages.len();
    Ok((messages, unread, truncated))
}

fn build_password_account(
    request: &PasswordAccountRequest,
) -> Result<(CloudAccount, String), String> {
    let provider = normalize_provider(&request.provider)?;
    let email = request.email.trim().to_string();
    if !valid_email(&email) {
        return Err("Enter a valid e-mail address.".to_string());
    }
    let raw_password = request.password.trim();
    if raw_password.is_empty() {
        return Err("Enter the app password for this account.".to_string());
    }
    let password: String = if provider == "imap" {
        raw_password.chars().take(MAX_PASSWORD).collect()
    } else {
        // App passwords are often displayed in groups; the server expects
        // them without the spaces.
        raw_password
            .chars()
            .filter(|c| !c.is_whitespace())
            .take(MAX_PASSWORD)
            .collect()
    };
    if password.is_empty() {
        return Err("Enter the app password for this account.".to_string());
    }

    let default = default_imap(&provider);
    let server = request
        .server
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| default.map(|(server, _)| server.to_string()))
        .unwrap_or_default();
    if server.is_empty() {
        return Err("Enter the IMAP server for this account.".to_string());
    }
    if !valid_host(&server) {
        return Err("The IMAP server must be a host name such as imap.example.com.".to_string());
    }
    let port = request
        .port
        .unwrap_or(default.map(|(_, port)| port).unwrap_or(993));
    if port == 0 {
        return Err("The IMAP port must be between 1 and 65535.".to_string());
    }
    if let Some((default_server, default_port)) = default {
        if server != default_server || port != default_port {
            // Keep the provider's documented endpoint; the advanced form is
            // for generic IMAP. This prevents a provider row silently pointing
            // at an unexpected host.
            return Err(format!(
                "{} uses {default_server}:{default_port}. Use the IMAP option for a custom server.",
                provider_label(&provider)
            ));
        }
    }
    let username = request
        .username
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&email)
        .to_string();
    if username.chars().count() > MAX_EMAIL || username.contains('\r') || username.contains('\n') {
        return Err("The IMAP user name is not valid.".to_string());
    }
    let display_name = clean(
        request.display_name.as_deref().unwrap_or_default(),
        MAX_LABEL,
    );
    let label = clean(
        request
            .label
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(if display_name.is_empty() {
                &email
            } else {
                &display_name
            }),
        MAX_LABEL,
    );
    let starttls = if provider == "imap" {
        request.starttls.unwrap_or(false)
    } else {
        false
    };
    let account = CloudAccount {
        id: random_id(),
        provider,
        mode: "password".to_string(),
        email: email.clone(),
        display_name: if display_name.is_empty() {
            email.clone()
        } else {
            display_name
        },
        label,
        server,
        port,
        username,
        starttls,
        enabled: true,
        created_at_ms: now_ms(),
        last_check_ms: 0,
        last_error: String::new(),
        client_id: String::new(),
        access_expires_at_ms: 0,
    };
    Ok((account, password))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn mail_cloud_list(state: State<'_, AppState>) -> Vec<CloudAccount> {
    load_accounts(&state.config_dir)
}

/// Validate the credentials against the server before saving anything. The
/// password goes to the keychain; the JSON file only gets account metadata.
#[tauri::command]
pub async fn mail_cloud_add_password(
    state: State<'_, AppState>,
    request: PasswordAccountRequest,
) -> Result<CloudAccount, String> {
    let (account, password) = build_password_account(&request)?;
    let config_dir = state.config_dir.clone();
    let accounts = load_accounts(&config_dir);
    if accounts.len() >= MAX_ACCOUNTS {
        return Err(format!(
            "At most {MAX_ACCOUNTS} mail accounts can be connected."
        ));
    }
    if accounts.iter().any(|existing| {
        existing.provider == account.provider && existing.email.eq_ignore_ascii_case(&account.email)
    }) {
        return Err("This mail account is already connected.".to_string());
    }

    let test_account = account.clone();
    let test_password = password.clone();
    tauri::async_runtime::spawn_blocking(move || scan_imap(&test_account, &test_password, 1))
        .await
        .map_err(|error| format!("IMAP test task failed: {error}"))??;

    let secret_id = account.id.clone();
    let secret = password.clone();
    run_keychain(move || keychain_set(&secret_id, "password", &secret)).await?;

    let mut accounts = accounts;
    let mut saved = account.clone();
    saved.last_check_ms = now_ms();
    accounts.push(saved);
    if let Err(error) = save_accounts(&config_dir, &accounts) {
        keychain_delete_account(&account.id);
        return Err(error);
    }
    Ok(account)
}

/// Shared by first-time sign-in and reconnect. `existing_id` replaces that
/// account row instead of adding a new one, so a refreshed consent keeps the
/// account's place in the panel.
async fn oauth_flow(
    app: AppHandle,
    http: reqwest::Client,
    config_dir: PathBuf,
    provider: String,
    client_id: String,
    client_secret: String,
    existing_id: Option<String>,
) -> Result<CloudAccount, String> {
    let config = oauth_provider(&provider)?;
    let before = load_accounts(&config_dir);
    let existing = match existing_id.as_deref() {
        Some(id) => Some(
            before
                .iter()
                .find(|account| account.id == id)
                .cloned()
                .ok_or_else(|| "That mail account is not connected.".to_string())?,
        ),
        None => None,
    };
    if let Some(existing) = &existing {
        if existing.provider != provider {
            return Err("The saved account uses a different provider.".to_string());
        }
        if existing.mode != "oauth" {
            return Err(
                "This account uses an app password. Remove it and add it again to change it."
                    .to_string(),
            );
        }
    } else if before.len() >= MAX_ACCOUNTS {
        return Err(format!(
            "At most {MAX_ACCOUNTS} mail accounts can be connected."
        ));
    }

    OAUTH_CANCELLED.store(false, Ordering::SeqCst);
    let (listeners, port) = bind_loopback()?;
    // `localhost` is the one loopback host whose port Microsoft ignores. The
    // pathless form is also the loopback URI shape Google documents for native
    // apps, so no provider-specific callback registration is required beyond
    // allowing the loopback redirect itself.
    let redirect_uri = format!("http://localhost:{port}/");

    let verifier = random_token(48);
    let challenge = pkce_challenge(&verifier);
    let state_token = random_token(24);
    let mut url = url::Url::parse(config.authorize_url)
        .map_err(|error| format!("Invalid authorization endpoint: {error}"))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("response_type", "code");
        query.append_pair("client_id", &client_id);
        query.append_pair("redirect_uri", &redirect_uri);
        query.append_pair("scope", config.scope);
        query.append_pair("state", &state_token);
        query.append_pair("code_challenge", &challenge);
        query.append_pair("code_challenge_method", "S256");
        for (name, value) in config.extra_auth {
            query.append_pair(name, value);
        }
    }
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|error| format!("Could not open the system browser: {error}"))?;

    let expected_state = state_token.clone();
    let code = tauri::async_runtime::spawn_blocking(move || {
        wait_for_callback(listeners, &expected_state, OAUTH_TIMEOUT)
    })
    .await
    .map_err(|error| format!("Sign-in task failed: {error}"))??;

    let token = oauth_tokens(
        &http,
        &config,
        &code,
        &verifier,
        &redirect_uri,
        &client_id,
        &client_secret,
    )
    .await?;
    let access = token
        .access_token
        .ok_or_else(|| "The sign-in service did not return an access token.".to_string())?;
    let refresh = token.refresh_token.ok_or_else(|| {
        "The provider did not grant offline access, so the account could not stay connected. Try again and keep the offline access permission enabled.".to_string()
    })?;
    let (email, name) = fetch_identity(&http, &provider, &access).await?;

    let mut accounts = load_accounts(&config_dir);
    if let Some(existing) = &existing {
        if !accounts.iter().any(|account| account.id == existing.id) {
            keychain_delete_account(&existing.id);
            return Err("The account was removed while signing in.".to_string());
        }
    }
    let duplicate = accounts.iter().any(|candidate| {
        candidate.provider == provider
            && candidate.email.eq_ignore_ascii_case(&email)
            && existing
                .as_ref()
                .map(|existing| existing.id != candidate.id)
                .unwrap_or(true)
    });
    if duplicate {
        return Err("This mail account is already connected.".to_string());
    }

    let id = existing
        .as_ref()
        .map(|account| account.id.clone())
        .unwrap_or_else(random_id);
    let created_at_ms = existing
        .as_ref()
        .map(|account| account.created_at_ms)
        .unwrap_or_else(now_ms);
    let display_name = if name.is_empty() { email.clone() } else { name };
    let account = CloudAccount {
        id: id.clone(),
        provider: provider.clone(),
        mode: "oauth".to_string(),
        email: email.clone(),
        display_name: display_name.clone(),
        label: clean(&display_name, MAX_LABEL),
        server: config.imap_server.to_string(),
        port: config.imap_port,
        username: email,
        starttls: false,
        enabled: true,
        created_at_ms,
        last_check_ms: 0,
        last_error: String::new(),
        client_id: client_id.clone(),
        access_expires_at_ms: token_expiry(token.expires_in, now_ms()),
    };

    let access_for_store = access.clone();
    let refresh_for_store = refresh.clone();
    let secret_for_store = client_secret.clone();
    let id_for_store = id.clone();
    let stored = run_keychain(move || {
        keychain_set(&id_for_store, "access", &access_for_store)?;
        keychain_set(&id_for_store, "refresh", &refresh_for_store)?;
        if !secret_for_store.is_empty() {
            keychain_set(&id_for_store, "client-secret", &secret_for_store)?;
        }
        Ok(())
    })
    .await;
    if let Err(error) = stored {
        if existing.is_none() {
            keychain_delete_account(&id);
        }
        return Err(error);
    }

    if let Some(existing) = &existing {
        let index = accounts
            .iter()
            .position(|candidate| candidate.id == existing.id)
            .ok_or_else(|| "The account was removed while signing in.".to_string())?;
        accounts[index] = account.clone();
    } else {
        accounts.push(account.clone());
    }
    if let Err(error) = save_accounts(&config_dir, &accounts) {
        if existing.is_none() {
            keychain_delete_account(&id);
        }
        return Err(error);
    }
    Ok(account)
}

/// Opens the provider's consent page in the system browser and waits for the
/// loopback redirect. The UI can cancel with `mail_cloud_oauth_cancel`.
#[tauri::command]
pub async fn mail_cloud_oauth_login(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: String,
    client_id: String,
    client_secret: Option<String>,
) -> Result<CloudAccount, String> {
    let provider = normalize_provider(&provider)?;
    let config = oauth_provider(&provider)?;
    let client_id = client_id.trim().to_string();
    if client_id.is_empty() || client_id.chars().count() > MAX_CLIENT_ID {
        return Err("Enter the OAuth client ID from the provider console.".to_string());
    }
    let client_secret = client_secret.unwrap_or_default().trim().to_string();
    if config.needs_secret && client_secret.is_empty() {
        return Err(
            "Google Desktop OAuth clients also need the client secret shown next to the client ID."
                .to_string(),
        );
    }
    if client_secret.chars().count() > MAX_CLIENT_SECRET {
        return Err("The OAuth client secret is too long.".to_string());
    }
    let http = state.http.clone();
    let config_dir = state.config_dir.clone();
    oauth_flow(
        app,
        http,
        config_dir,
        provider,
        client_id,
        client_secret,
        None,
    )
    .await
}

/// Re-run OAuth for an existing account using the client id and secret that
/// were stored at first sign-in. Used when a refresh token expires or is
/// revoked; the user only sees the provider's consent page.
#[tauri::command]
pub async fn mail_cloud_reconnect(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<CloudAccount, String> {
    let config_dir = state.config_dir.clone();
    let account = load_accounts(&config_dir)
        .into_iter()
        .find(|account| account.id == id)
        .ok_or_else(|| "That mail account is not connected.".to_string())?;
    if account.mode != "oauth" {
        return Err(
            "This account uses an app password. Remove it and add it again to change it."
                .to_string(),
        );
    }
    let client_id = account.client_id.trim().to_string();
    if client_id.is_empty() {
        return Err(
            "This account has no OAuth client id. Remove it and connect again.".to_string(),
        );
    }
    let secret_id = id.clone();
    let client_secret = run_keychain(move || keychain_get(&secret_id, "client-secret"))
        .await?
        .unwrap_or_default();
    let http = state.http.clone();
    oauth_flow(
        app,
        http,
        config_dir,
        account.provider,
        client_id,
        client_secret,
        Some(id),
    )
    .await
}

#[tauri::command]
pub fn mail_cloud_oauth_cancel() {
    OAUTH_CANCELLED.store(true, Ordering::SeqCst);
}

#[tauri::command]
pub async fn mail_cloud_remove(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let config_dir = state.config_dir.clone();
    let id_for_keychain = id.clone();
    run_keychain(move || {
        keychain_delete_account(&id_for_keychain);
        Ok(())
    })
    .await?;
    let mut accounts = load_accounts(&config_dir);
    accounts.retain(|account| account.id != id);
    save_accounts(&config_dir, &accounts)
}

/// Read unread inbox headers. A failure is kept on the account row so the UI
/// can explain it after a restart, while the error is also returned for the
/// immediate attempt.
#[tauri::command]
pub async fn mail_cloud_scan(
    state: State<'_, AppState>,
    id: String,
    limit: Option<u32>,
) -> Result<CloudMailScan, String> {
    let limit = limit.unwrap_or(6).clamp(1, MAX_MESSAGES as u32) as usize;
    let config_dir = state.config_dir.clone();
    let http = state.http.clone();
    let mut accounts = load_accounts(&config_dir);
    let index = accounts
        .iter()
        .position(|account| account.id == id)
        .ok_or_else(|| "That mail account is not connected.".to_string())?;
    let mut account = accounts[index].clone();

    let outcome = if account.mode == "password" {
        let password_id = account.id.clone();
        let password = run_keychain(move || keychain_get(&password_id, "password"))
            .await?
            .ok_or_else(|| {
                "The saved app password is missing. Remove the account and connect it again."
                    .to_string()
            })?;
        let task_account = account.clone();
        tauri::async_runtime::spawn_blocking(move || scan_imap(&task_account, &password, limit))
            .await
            .map_err(|error| format!("IMAP task failed: {error}"))?
    } else {
        scan_oauth(&http, &mut account, limit).await
    };

    let checked_at_ms = now_ms();
    match outcome {
        Ok((messages, unread, truncated)) => {
            account.last_check_ms = checked_at_ms;
            account.last_error.clear();
            accounts[index] = account.clone();
            if let Err(error) = save_accounts(&config_dir, &accounts) {
                log::warn!("cloud mail: could not save scan metadata: {error}");
            }
            Ok(CloudMailScan {
                account,
                messages,
                unread,
                total: unread,
                truncated,
                checked_at_ms,
            })
        }
        Err(error) => {
            account.last_error = clean(&error, MAX_ERROR);
            accounts[index] = account;
            if let Err(save_error) = save_accounts(&config_dir, &accounts) {
                log::warn!("cloud mail: could not save the scan error: {save_error}");
            }
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::tempdir;

    fn sample_account() -> CloudAccount {
        CloudAccount {
            id: "mail-test".to_string(),
            provider: "gmail".to_string(),
            mode: "oauth".to_string(),
            email: "user@example.com".to_string(),
            display_name: "User".to_string(),
            label: "User".to_string(),
            server: "imap.gmail.com".to_string(),
            port: 993,
            username: "user@example.com".to_string(),
            starttls: false,
            enabled: true,
            created_at_ms: 1,
            last_check_ms: 0,
            last_error: String::new(),
            client_id: "client-id".to_string(),
            access_expires_at_ms: 0,
        }
    }

    #[test]
    fn pkce_matches_the_rfc_7636_example() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            pkce_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn callback_values_are_percent_decoded_and_state_is_checked() {
        assert_eq!(
            callback_value("code=abc%2F123&state=xyz", "code").as_deref(),
            Some("abc/123")
        );
        assert_eq!(callback_value("state=xyz", "missing"), None);
    }

    #[test]
    fn provider_endpoints_are_the_documented_secure_ones() {
        let gmail = oauth_provider("gmail").unwrap();
        assert!(gmail.authorize_url.starts_with("https://"));
        assert!(gmail.token_url.starts_with("https://"));
        assert!(gmail.scope.contains("gmail.readonly"));
        assert!(gmail.needs_secret);
        let outlook = oauth_provider("outlook").unwrap();
        assert!(outlook.token_url.starts_with("https://"));
        assert!(outlook.scope.contains("Mail.Read"));
        assert!(!outlook.needs_secret);
        assert!(oauth_provider("imap").is_err());
    }

    #[test]
    fn password_accounts_use_provider_defaults_and_keep_the_password_out_of_metadata() {
        let request = PasswordAccountRequest {
            provider: "gmail".to_string(),
            email: "user@example.com".to_string(),
            password: "abcd efgh ijkl mnop".to_string(),
            display_name: None,
            label: None,
            server: None,
            port: None,
            username: None,
            starttls: None,
        };
        let (account, password) = build_password_account(&request).unwrap();
        assert_eq!(account.server, "imap.gmail.com");
        assert_eq!(account.port, 993);
        assert_eq!(password, "abcdefghijklmnop");
        assert!(!serde_json::to_string(&account)
            .unwrap()
            .contains("abcdefghijklmnop"));

        let custom = PasswordAccountRequest {
            provider: "imap".to_string(),
            email: "user@example.com".to_string(),
            password: " secret with spaces ".to_string(),
            display_name: Some("Work".to_string()),
            label: Some("Work".to_string()),
            server: Some("mail.example.com".to_string()),
            port: Some(143),
            username: Some("user".to_string()),
            starttls: Some(true),
        };
        let (account, password) = build_password_account(&custom).unwrap();
        assert_eq!(account.server, "mail.example.com");
        assert_eq!(account.port, 143);
        assert!(account.starttls);
        assert_eq!(password, "secret with spaces");
    }

    #[test]
    fn invalid_passwords_and_hosts_are_rejected() {
        let base = PasswordAccountRequest {
            provider: "imap".to_string(),
            email: "user@example.com".to_string(),
            password: "secret".to_string(),
            display_name: None,
            label: None,
            server: Some("mail.example.com".to_string()),
            port: None,
            username: None,
            starttls: None,
        };
        assert!(build_password_account(&base).is_ok());
        assert!(build_password_account(&PasswordAccountRequest {
            server: Some("https://mail.example.com".to_string()),
            ..base.clone()
        })
        .is_err());
        assert!(build_password_account(&PasswordAccountRequest {
            password: "   ".to_string(),
            ..base.clone()
        })
        .is_err());
        assert!(build_password_account(&PasswordAccountRequest {
            email: "not-an-address".to_string(),
            ..base
        })
        .is_err());
    }

    #[test]
    fn gmail_metadata_maps_subject_sender_and_date() {
        let raw = r#"{
            "id": "18c",
            "internalDate": "1783159200000",
            "payload": {"headers": [
                {"name": "Subject", "value": "=?UTF-8?B?5L2g5aW9?="},
                {"name": "From", "value": "Alice <alice@example.com>"}
            ]}
        }"#;
        let message: GmailMessage = serde_json::from_str(raw).unwrap();
        let mail = gmail_message_to_mail(&message, "fallback");
        assert_eq!(mail.id, "18c");
        assert_eq!(mail.subject, "你好");
        assert_eq!(mail.from, "Alice <alice@example.com>");
        assert_eq!(mail.date_ms, 1_783_159_200_000);
        assert!(mail.unread);
    }

    #[test]
    fn graph_metadata_maps_and_skips_messages_without_an_id() {
        let raw = r#"{
            "id": "AAMk",
            "subject": "Weekly report",
            "from": {"emailAddress": {"name": "Maya", "address": "maya@example.com"}},
            "receivedDateTime": "2026-07-04T10:00:00Z",
            "isRead": false
        }"#;
        let message: GraphMessage = serde_json::from_str(raw).unwrap();
        let mail = graph_message_to_mail(&message).unwrap();
        assert_eq!(mail.subject, "Weekly report");
        assert_eq!(mail.from, "Maya <maya@example.com>");
        assert_eq!(mail.date_ms, 1_783_159_200_000);
        assert!(mail.unread);
        assert!(graph_message_to_mail(&GraphMessage::default()).is_none());
    }

    #[test]
    fn imap_headers_decode_encoded_words_and_fall_back_to_internal_date() {
        let header = b"From: =?UTF-8?B?5L2g5aW9?= <a@example.com>\r\n\
                       Subject: =?UTF-8?Q?Hello_World?=\r\n\
                       Date: Sat, 04 Jul 2026 10:00:00 +0000\r\n\r\n";
        let mail = imap_message(42, header, None, true);
        assert_eq!(mail.id, "imap-42");
        assert_eq!(mail.subject, "Hello World");
        assert_eq!(mail.from, "你好 <a@example.com>");
        assert_eq!(mail.date_ms, 1_783_159_200_000);
        assert!(!mail.unread);

        let no_date = b"Subject: No date\r\n\r\n";
        assert_eq!(
            imap_message(7, no_date, Some(1_700_000_000_000), false).date_ms,
            1_700_000_000_000
        );
    }

    #[test]
    fn account_metadata_round_trips_without_secrets() {
        let root = tempdir();
        let account = sample_account();
        save_accounts(&root, std::slice::from_ref(&account)).unwrap();
        assert_eq!(load_accounts(&root), vec![account]);
        let text = std::fs::read_to_string(accounts_path(&root)).unwrap();
        assert!(!text.contains("refresh_token"));
        assert!(!text.contains("password"));
        assert!(!text.contains("access_token"));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn unreadable_and_invalid_account_rows_are_ignored() {
        let root = tempdir();
        std::fs::write(accounts_path(&root), "not json").unwrap();
        assert!(load_accounts(&root).is_empty());

        let mut bad = sample_account();
        bad.email.clear();
        save_accounts(&root, &[bad, sample_account()]).unwrap();
        let loaded = load_accounts(&root);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "mail-test");
        std::fs::remove_dir_all(root).ok();
    }
}
