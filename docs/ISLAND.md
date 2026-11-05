# Dynamic Island & Plugin Architecture

Status: **implemented foundation** (2026-11). This document records the
architecture decision, the plugin contract, the shipped built-in plugins
(including opt-in cloud mail and the Windows WeChat mirror) and the remaining
product decisions.

## 1. Decision: extend this repository, do not start a second product

The question was whether the sidebar should become a new "dynamic island"
project, with the current quota widget reduced to a plugin.

**Recommendation: no new project.** Evolve this repository into an island
*host* with a plugin contract; make AI usage the first built-in plugin. A
separate repository would duplicate the expensive, already-solved parts:

| Capability | Already in this repository |
|---|---|
| Frameless, transparent, click-through-free overlay | `src-tauri/tauri.conf.json`, `window/mod.rs` |
| Multi-monitor / DPI-aware placement | `window/monitors.rs` (unit tested) |
| Top/bottom/left/right docking, auto-hide, hover timers | `window/{sidebar,hover,drag}.rs` |
| Popover that never steals focus | `window/popover.rs` |
| Live settings file + history + presets + tray | `settings*.rs`, `window/tray.rs` |
| Updater, autostart, global shortcuts, notifications | `updater.rs`, `shortcuts.rs`, `alerts/` |
| Local data store, ingestion, history | SQLite via `store/`, `ingest/` |
| Three-window frontend with shared stores | SvelteKit routes + `src/lib/stores/` |

A new project would re-derive all of that before drawing a single plugin. The
island is a **presentation mode plus an extension surface**, not a different
product. If a third-party plugin ecosystem appears later, the *host* can be
extracted into its own crate/package then; doing it now only freezes an API
before there is a second consumer.

### Recommended repository evolution (when it is warranted)

1. Stay single-repo for now. Keep `src/lib/plugins/` as the plugin surface.
2. When a plugin needs a backend of its own, add a Rust command module and a
   typed frontend API instead of letting the panel invoke raw commands.
3. Only if external developers need to ship plugins independently:
   convert to a workspace (`apps/island-shell`, `packages/plugin-sdk`,
   `plugins/*`) and publish the SDK. The built-in plugins move first; nothing
   is rewritten.
4. Renaming the product is a marketing decision, not a repository split.

### 1.1 Naming: Islita

At v0.7.0 the project was renamed from **AI Usage Sidebar** to **Islita**,
because it is now a plugin island rather than a quota sidebar. Only the
maintainer was using it, so no data migration was written; the technical
identifiers moved with the product:

| Identifier | Used by |
|---|---|
| `islita` (binary, crate, package) | `scripts/install-linux.sh`, launchers, tests, docs, `--print` |
| `io.github.harveyxiacn.islita` (app id) | config/data/log folders, updater feeds, WebView storage, keychain service |
| `harveyxiacn/islita` (repository) | release download URLs, issue links, the updater's GitHub feed |

The old repository URL redirects to the new one, and GitHub answers the old
`releases/latest/download/latest.json` with a 301. An installed 0.6.0 build
therefore still reaches the first Islita release. Because the Windows
installer keys its install directory off the product name, that first update
lands beside the old copy; uninstall the old one afterwards. Later updates are
ordinary in-place updates.

Avoid "Dynamic Island" as the product name: it is strongly associated with
Apple and makes a confusing search result. "Islita" is a coined diminutive of
"isla" (island) and had no GitHub repository of that name when chosen.

## 2. What is implemented

### 2.1 Island mode (`Settings.island`)

* Opt-in (`island: false` keeps the existing edge bar byte-for-byte).
* Placement: top centre of the target monitor's work area, `islandMargin` px
  below the top. `edge`, `verticalAlign` and `verticalOffset` are ignored
  while it is on; `monitor` still selects the screen.
* Geometry: the window is always sized to the rendered capsule, in both the
  expanded and collapsed states. `monitors::sidebar_rect` has a dedicated
  island branch; the edge-collapsed sliver does not apply.
* Popover: the island is treated as a horizontal, top-anchored bar, so the
  detail bubble opens **below** it regardless of the saved `edge`.
* Dragging: disabled in both the frontend (the capsule has no drag handle) and
  the backend (`drag::drag` returns early), because a drop would fight the
  top-centre watchdog and the drop maths assumes an edge.
* Motion: a jelly capsule morph on idle↔expanded (overshoot keyframes on
  `transform`, not a window resize), a staggered spring pop for the tool rail,
  a panel that arrives with a small squash-and-settle and leaves on a 170 ms
  exit beat before the island collapses. Hover/press states use spring-like
  cubic-béziers. The global `prefers-reduced-motion` rule collapses all of it;
  the close beat is skipped in JS as well, so Escape stays instant.

### 2.2 Idle and expanded states

The island renders a **single summary ring** (the busiest provider) plus a
`+N` badge when idle. Pointer enter or keyboard focus expands it into the full
provider row and the plugin rail. Leaving schedules a 360 ms collapse, but an
open plugin panel or keyboard focus keeps it expanded. This is frontend state;
the Rust hover state machine still owns auto-hide for edge bars.

The measured content is reported through the existing `sidebar_relayout`
protocol, so opening a panel grows the window and re-centres it. No new window
or resize feedback loop was introduced.

### 2.3 Plugin contract

`src/lib/plugins/types.ts`:

```ts
interface IslandPlugin {
  id: string;                 // storage namespace + stable key
  label: string;              // i18n key
  hint?: string;              // i18n key
  icon: string;               // 24×24 SVG path, stroke style
  order: number;              // rail order
  component: Component;       // panel body
}
```

A panel is an ordinary Svelte component. It receives `close()` but may ignore
it. Registration is one entry in `src/lib/plugins/registry.ts`; the shell reads
that list and nothing else. Plugin state is stored with
`src/lib/plugins/storage.ts` (`localStorage`, namespaced, every access
guarded), so a storage failure never takes down the island.

Built-in panels shipped with this foundation:

| Plugin | What it does | Data boundary |
|---|---|---|
| `providers` | Track / bar switches per provider, live percentage, link to Settings | existing `settings` store + backend commands |
| `calendar` | Import a local `.ics`, show the next five events and a 15-minute "starts soon" state; expands simple RRULEs (DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY + EXDATE) | local file picker + `localStorage`; no account, token or network |
| `mail` | Unread count and newest subjects/senders from a local `.eml` folder or Maildir, **or** an opt-in cloud account (Gmail / Outlook OAuth, or any IMAP host with an app password) | local folder: native picker + `scan_mail_folder`, headers only, no account or network. Cloud: `mail_cloud_*`, read-only inbox headers, tokens/passwords in the OS keychain and metadata only in `cloud-accounts.json`. Polled only while the panel is open |
| `wechat` | Latest message per visible WeChat conversation (Windows only), with the client's own time labels | UI Automation of `mmui::ChatSessionCell`; read-only mirror, no chat database, keystrokes, network or sending |
| `tasks` | Finished Claude Code / Codex turns, newest first; updates live from `task-completed` | new `list_task_completions` command; provider, project and local title only |
| `notes` | Sticky note with autosave, clear, character count | local device only, never uploaded |
| `sessions` | Latest Claude Code / Codex sessions: title, age, tokens, warm indicator | existing `list_sessions` command; no prompt or response text |
| `music` | Local audio playlist, play/pause/seek/volume and synced LRC lyrics; playback survives closing the panel | File API + object URL; files never reach the backend |
| `timer` | 25/5 focus timer, deadline survives restart | local device only, no notification permission |
| `drop` | Native drop target + file picker; copies regular files into a private dropbox, lists recent ones, opens the folder | `save_dropped_files` / `pick_dropped_files` / `list_dropped_files`; 20 files, 512 MiB each, no execution |

The plugin rail is only rendered in island mode. Edge-bar users keep Settings
→ Providers and the new tray submenu. The rail itself carries two attention
badges (`attention.svelte.ts`): the mail icon shows the local folder's unread
count and the calendar icon shows a dot when an imported event starts within
15 minutes. Both read the same namespaced localStorage keys as the panels and
refresh once a minute, plus immediately when a panel writes its state. Cloud
accounts are intentionally not polled in the background, so they do not add a
rail badge yet; their unread count appears when the Mail panel is open.

### 2.4 Provider selection

The request "choose which AI usages are monitored; only show the enabled
providers" is satisfied at three levels:

1. **Settings → Providers** — the detailed switchboard (`enabled`,
   `showInSidebar`, order, experimental badges). `enabled = false` stops
   polling.
2. **Tray → Monitored providers** — one native check item per provider for a
   one-click start/stop.
3. **Island → Providers panel** — the same switches next to the rings, with
   live percentages.

The bar and popover already filtered by `enabled`/`showInSidebar`; the
dashboard Overview now also hides providers that are not polled, so turning
one off declutters the whole surface (History keeps the historical data).

## 3. Security and privacy rules for every plugin

These are not optional, and a plugin that cannot meet them does not ship:

* **No credential reads in a panel.** A panel talks to a named backend
  command; only the provider layer may read credential files, and it never
  returns their contents.
* **No silent network access.** A plugin that polls a service must have an
  explicit settings switch, show its account/endpoint, and respect focus mode.
* **No unbounded storage.** Plugin state stays small and local; anything
  durable and queryable belongs in SQLite behind a command.
* **No focus stealing.** Panels live in the sidebar window, which never takes
  focus from the editor unless the user clicks it.
* **Least privilege.** The shipped cloud-mail accounts use OAuth in the system
  browser with a `localhost` loopback redirect (or IMAP with an app password)
  and keep tokens/passwords in the OS keychain, never in `settings.json` or
  plugin localStorage. The OAuth scopes are read-only (`gmail.readonly`,
  `Mail.Read`); IMAP fetches only `RFC822.HEADER`. The local folder reader,
  calendar and the other file-based plugins never contact a network. A mail
  account is added only by an explicit user action.
* **Accessibility stays read-only.** The WeChat panel may read accessible names
  from the visible conversation list, but must never invoke an accessible
  action, click, type, scroll or change WeChat's window.
* **Explain before enabling.** The plugin rail and Settings must say which
  external service is contacted, and the first run must be an explicit opt-in.

## 4. Roadmap for the requested plugins

Each entry names the hardest constraint first; that is what decides the design.

### 4.1 Task-completion notices for Claude Code / Codex (log path shipped)

The log-based path is implemented: the session parser records `finished_at`
for Claude when the last streamed assistant fragment carries a terminal
`stop_reason` (`end_turn`, `max_tokens`, `stop_sequence`, `refusal`); Codex
already emits `task_complete`. After each ingestion pass, newly finished
**main-session** turns (subagents excluded) update the `tasks` panel and, with
`notifications` + `taskNotifications` on, go through the existing alert
fan-out. The notice contains the provider and the project folder only, so a
lock-screen banner cannot leak conversation text. A start-up high-water mark
and a 10-minute maximum age prevent replaying old work after a restart or a
long sleep.

Remaining work:

1. **Agent-native hooks** (preferred when available): Claude Code hooks and
   Codex notify commands can call a small `islita notify` entry
   point. That is deterministic and avoids guessing from logs.
2. Track per-session running/ready state for the panel instead of only
   completed turns, and add "open this session" deep links.
3. Keep the local event independent from the notification switch so the panel
   updates even when OS notifications are off (already the case).

### 4.2 File drop station (shipped)

The drop plugin listens to Tauri's native drag-drop event while its panel is
open and hands the paths to `save_dropped_files`; the click target uses a
native multi-file picker through `pick_dropped_files`. Both routes share the
same rules in `src-tauri/src/dropbox.rs`:

* regular files only — directories, devices and symlinks are skipped;
* at most 20 files and 512 MiB per file per drop;
* names are sanitised and never overwrite an existing file (`name (2).ext`);
* destination: `<data>/dropbox/YYYY-MM-DD/`, with a list command and an
  "open folder" action.

Nothing is executed, opened or uploaded. `list_dropped_files` returns only the
destination name, size, save time and dropbox-relative path, never the original
source path. A future cleanup policy (age/size budget) belongs here, not in the
panel.

### 4.3 Music player + LRC (shipped)

Local-first: the File API opens audio and `.lrc` files, `<audio>` plays an
object URL, and `lrc.ts` parses timestamps, metadata and `offset`. The active
line follows `timeupdate`; clicking a line seeks. The audio element lives in
`player.svelte.ts`, outside the panel component, so collapsing the island or
switching plugins does not stop playback. The playlist is session-only because
object URLs do not survive a restart; the panel says so instead of pretending
otherwise. No asset protocol, file-system scope, streaming service, DRM or
media-key capture was added.

### 4.4 Sticky notes (done) and richer notes

The shipped panel is intentionally one scratchpad. Next steps: multiple notes,
markdown preview, pin/unpin, export to `.md`, and per-provider/project notes.
SQLite-backed if notes must sync with the dashboard; localStorage if they stay
a quick scratchpad.

### 4.5 E-mail and calendar

**Calendar is shipped as a local `.ics` import** (see §2.3). It deliberately
has no CalDAV client, account or refresh token yet: an exported file is enough
for a reminder card, and it keeps the first version inside the "no silent
network access" rule.

**Mail has two user-selectable sources.** The local reader (`.eml` / Maildir)
lists unread counts and the newest subjects/senders; the backend reads only
the first 128 KiB of headers, never a body, and no password, token or network
client is involved. Maildir `new/` and `cur/` read flags are honoured; plain
`.eml` has no portable read flag, so those files are listed as read. A Windows
Maildir may use `;2,` or `!2,` instead of `:2,`; all three are accepted.

**Cloud mail is shipped as an opt-in account** (`Tauri` → `cloud_mail.rs`,
panel tab **Accounts**). The user chooses one of three routes at setup:

| Route | Sign-in | Read path |
|---|---|---|
| Gmail | Google OAuth, authorization code + PKCE, `gmail.readonly` | Gmail API, unread inbox metadata (`From`, `Subject`, `internalDate`) |
| Outlook | Microsoft OAuth, authorization code + PKCE, `Mail.Read` | Graph `me/mailFolders/inbox/messages`, unread only |
| Any IMAP | App password (Gmail, Outlook or a custom host) | `INBOX`, `UID SEARCH UNSEEN`, `RFC822.HEADER` only |

Details that matter:

* **Secrets.** Refresh/access tokens, the Google client secret and IMAP app
  passwords live in the OS keychain under
  `io.github.harveyxiacn.islita.mail`; `cloud-accounts.json` stores
  only id, provider, address, host/port, display name and sync metadata. The
  keychain is never read by the webview. Removing an account deletes its
  keychain entries.
* **OAuth clients are bring-your-own.** Google requires a *Desktop app* OAuth
  client (client ID + client secret; enable the Gmail API). Microsoft requires
  a public client registration with `http://localhost` as a redirect URI
  (client ID only). The setup form links to both consoles and explains this;
  an app cannot ship a shared secret.
* **Loopback only.** The sign-in listener binds ephemeral IPv4 and IPv6
  loopback ports, uses `http://localhost:<port>/`, validates OAuth `state`,
  times out after five minutes and can be cancelled from the panel. No custom
  URL scheme or embedded browser is used.
* **Read-only, headers only.** No mark-as-read, send, delete, attachment or
  body fetch is implemented. Gmail/Graph are read via their HTTP APIs; IMAP
  fetches header sections only.
* **No background poller.** An account is scanned when the panel opens, when
  the user refreshes it, and once a minute while the panel remains open. This
  keeps the "no silent network access" rule. A future background poller must be
  a visible setting with an explicit host and must feed the existing alert
  gate.
* **Password caveat.** Microsoft is retiring password-based IMAP; the form
  recommends Outlook OAuth if an app password is rejected. Gmail app passwords
  require 2-Step Verification.

Calendar remains local-only (`.ics` import, no CalDAV). Writing mail/events
stays out of scope until the read-only path is trusted.

### 4.6 WeChat messages (Windows read-only mirror shipped)

There is no supported WeChat desktop API for reading messages, and reading its
local chat database was rejected: encryption, breakage on every update, and a
privacy blast radius far beyond a usage widget.

The shipped `wechat` plugin takes the narrowest available route: on Windows it
reads the **visible conversation list** through UI Automation
(`mmui::ChatSessionCell`), the same tree a screen reader uses. It shows the
contact, the latest message preview and the client's own time label for each
conversation. It never opens a chat, clicks, types, reads the WeChat database,
contacts a server or sends a message; the scan runs only while the panel is
open and the result is never persisted.

Limits are explicit in the UI: Windows only; WeChat must be running; only what
the client has rendered is visible (usually the sessions in view, not full
history); an elevated WeChat and a non-elevated sidebar cannot share the
accessibility tree. WeChat 4.x (`mmui::MainWindow`) and 3.x
(`WeChatMainWndForPC`) are both probed, and an unexpected client reports
`no_sessions` or `blocked` rather than inventing data.

Not shipped: macOS/Linux mirroring (no equivalent no-permission surface), and
the WeCom (企业微信) incoming webhook (official, but group robots only, not
personal chats).

To verify the live path on a Windows machine with WeChat open (prints counts
and states only, never message text):

```sh
cargo test --lib --manifest-path src-tauri/Cargo.toml \
  live_wechat_scan_smoke -- --ignored --nocapture
```

### 4.7 Anything else

A plugin may add a new *surface* only through the contract above. If it needs a
new window, a new process or a new protocol, that is a platform feature first
(backend module + docs + tests), and the plugin is the second consumer.

## 5. Testing and UX rules for new panels

* Keep the idle island under ~10 rem wide; panels are ≤ 22 rem unless the
  monitor is narrow.
* Never animate the window size directly; animate the content and let
  `observeSize` report. The 50 ms debounce is the resize budget.
* Every panel must be usable at `scale` 0.75–1.5 and in light / dark / cyber
  surfaces.
* Reduced motion, keyboard focus, Escape-to-close and a visible active state
  are part of the definition of done.
* A panel must render something sane while the snapshot is `null`, the backend
  is unreachable, or localStorage throws.

## 6. Contract summary

* Settings: `island`, `islandMargin`, `taskNotifications` (see AGENTS.md §5).
* Backend: `list_task_completions` + `task-completed` event; detection in the
  session parser/ingestion path, delivery through the existing alert gate.
  `read_wechat_sessions` (Windows UI Automation, read-only) backs the WeChat
  panel and is polled only while that panel is open. `mail_cloud_*` backs the
  cloud mail tab: account metadata in `cloud-accounts.json`, secrets in the OS
  keychain, OAuth + PKCE via a loopback listener, read-only Gmail/Graph/IMAP
  header scans. It is invoked only by the open panel (plus explicit refresh).
* Placement: `monitors::sidebar_rect` island branch; popover uses `Edge::Top`.
* Frontend: `src/routes/+page.svelte` (idle/expanded + rail),
  `src/lib/plugins/{types,registry,storage}.ts`,
  `src/lib/plugins/panels/*`.
* Provider switches: Settings → Providers, tray submenu, island panel.
* No new window label. Credential/network additions are limited to the
  user-invoked cloud-mail commands and the keychain entries above; everything
  else remains local-first.
