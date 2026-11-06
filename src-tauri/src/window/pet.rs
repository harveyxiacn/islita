//! The detached desktop pet window. [PLATFORM]
//!
//! The pet is a small transparent, always-on-top, never-focused window. The
//! frontend draws and animates the character; this module owns the physical
//! window: sizing from `settings.scale`, placement inside the current
//! monitor's work area, dragging, and the low-frequency wander loop.
//!
//! The wander loop runs in Rust on purpose. A visible-but-unfocused webview can
//! have its `requestAnimationFrame` throttled by the OS, and moving a window
//! from JS would cost one IPC round-trip per frame. The loop only moves the
//! window while the pet is allowed to roam; the frontend switches the sprite
//! between idle and walk from the `pet-motion` events.

use crate::model::{windows, Settings};
use crate::window::{self, monitors};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

/// Logical size of the pet window at `scale = 1`.
pub const BASE_W: f64 = 240.0;
pub const BASE_H: f64 = 300.0;
/// Gap between the pet and the work-area edges, logical px.
pub const MARGIN: f64 = 8.0;
/// Horizontal wander speed, logical px per second.
pub const SPEED: f64 = 34.0;
/// A run segment covers ground this much faster than a walk.
pub const RUN_MULTIPLIER: f64 = 2.2;
/// Share of movement segments that become a run instead of a walk.
pub const RUN_CHANCE: f64 = 0.35;
/// Falling speed after the pet is dropped above the work-area floor.
pub const FALL_SPEED: f64 = 220.0;
/// Wander loop period.
pub const TICK_MS: u64 = 33;
/// Event carrying `{ moving, running, dir, falling, x, y }` to the pet page.
pub const MOTION_EVENT: &str = "pet-motion";
/// Minimum quiet time after a drag before the pet wanders off again.
pub const DRAG_SETTLE: Duration = Duration::from_millis(600);

static LOOP_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Motion {
    pub moving: bool,
    /// A run segment: faster than a walk, so the page plays the run clip.
    pub running: bool,
    /// `-1` left, `1` right, `0` no horizontal movement.
    pub dir: i32,
    pub falling: bool,
    pub x: f64,
    pub y: f64,
}

/// Bookkeeping for the pet window. The frontend owns the personality; this is
/// only where the window is and whether it may move.
pub struct PetWindowState {
    /// Logical top-left of the pet window in virtual-desktop coordinates.
    pub pos: Option<(f64, f64)>,
    /// Last logical size derived from `settings.scale`.
    pub size: (f64, f64),
    pub dir: i32,
    pub moving: bool,
    /// The current movement segment is a run.
    pub running: bool,
    pub falling: bool,
    /// The pet page has loaded and may be shown.
    pub ready: bool,
    /// The page asked the pet to stay put (asleep, menu open, …).
    pub roam_allowed: bool,
    pub dragging: bool,
    /// Settings say the pet should be on the desktop.
    pub want_visible: bool,
    /// Do not start moving before this instant (after a drag / wake-up).
    pub pause_until: Instant,
    /// When the current walk segment may end.
    pub turn_at: Instant,
    pub last_emit: Option<Motion>,
    pub last_emit_at: Instant,
}

impl Default for PetWindowState {
    fn default() -> Self {
        let now = Instant::now();
        Self {
            pos: None,
            size: (BASE_W, BASE_H),
            dir: 1,
            moving: false,
            running: false,
            falling: false,
            ready: false,
            roam_allowed: true,
            dragging: false,
            want_visible: false,
            pause_until: now + Duration::from_secs(2),
            turn_at: now + Duration::from_secs(6),
            last_emit: None,
            last_emit_at: now,
        }
    }
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    match app.get_webview_window(windows::PET) {
        Some(win) => Some(win),
        None => {
            log::error!("window `{}` is missing from tauri.conf.json", windows::PET);
            None
        }
    }
}

fn scale_of(settings: &Settings) -> f64 {
    if settings.scale.is_finite() && settings.scale > 0.0 {
        settings.scale
    } else {
        1.0
    }
}

/// The display's device-pixel ratio. `pet.pos`/`size` are CSS (logical) pixels,
/// the window APIs take physical pixels, and `Settings.scale` is already part
/// of the size — using it here as well would square it.
fn dpi(win: &WebviewWindow) -> f64 {
    match win.scale_factor() {
        Ok(v) if v.is_finite() && v > 0.0 => v,
        _ => 1.0,
    }
}

fn size_for(scale: f64) -> (f64, f64) {
    (BASE_W * scale, BASE_H * scale)
}

/// The monitor whose work area contains `(x, y)`, else the configured target.
fn monitor_at(app: &AppHandle, x: f64, y: f64) -> Option<monitors::MonitorRect> {
    let all = monitors::all_monitors(app);
    if let Some(found) = all
        .iter()
        .find(|m| x >= m.rect.x && x < m.rect.right() && y >= m.rect.y && y < m.rect.bottom())
    {
        return Some(found.clone());
    }
    monitors::target_monitor(app, &window::settings_of(app))
}

fn clamp_to(mon: &monitors::MonitorRect, size: (f64, f64), x: f64, y: f64) -> (f64, f64) {
    let x = monitors::clamp_span(
        x,
        size.0,
        mon.rect.x + MARGIN,
        (mon.rect.w - 2.0 * MARGIN).max(size.0),
    );
    let y = monitors::clamp_span(
        y,
        size.1,
        mon.rect.y + MARGIN,
        (mon.rect.h - 2.0 * MARGIN).max(size.1),
    );
    (x, y)
}

fn default_pos(app: &AppHandle, size: (f64, f64)) -> (f64, f64) {
    let settings = window::settings_of(app);
    let Some(mon) = monitors::target_monitor(app, &settings) else {
        return (MARGIN, MARGIN);
    };
    (
        (mon.rect.right() - size.0 - MARGIN).max(mon.rect.x + MARGIN),
        (mon.rect.bottom() - size.1 - MARGIN).max(mon.rect.y + MARGIN),
    )
}

fn set_position(win: &WebviewWindow, pos: (f64, f64), dpi: f64) {
    let target = PhysicalPosition::new((pos.0 * dpi).round() as i32, (pos.1 * dpi).round() as i32);
    if let Err(e) = win.set_position(target) {
        log::warn!("pet set_position failed: {e}");
    }
}

fn resize(win: &WebviewWindow, size: (f64, f64), dpi: f64) {
    let target = PhysicalSize::new(
        (size.0 * dpi).round().max(1.0) as u32,
        (size.1 * dpi).round().max(1.0) as u32,
    );
    if let Err(e) = window::set_overlay_size(win, target) {
        log::warn!("pet set_size failed: {e}");
    }
}

fn emit_motion(app: &AppHandle, motion: &Motion) {
    if let Err(e) = app.emit_to(windows::PET, MOTION_EVENT, motion.clone()) {
        log::debug!("emitting {MOTION_EVENT} failed: {e}");
    }
}

fn publish(app: &AppHandle, state: &mut PetWindowState, motion: Motion, force: bool) {
    let changed = match &state.last_emit {
        None => true,
        Some(previous) => {
            previous.moving != motion.moving
                || previous.running != motion.running
                || previous.dir != motion.dir
                || previous.falling != motion.falling
                || (previous.x - motion.x).abs() > 0.4
                || (previous.y - motion.y).abs() > 0.4
        }
    };
    let due = state.last_emit_at.elapsed() > Duration::from_millis(450);
    if !changed && !(force && due) {
        return;
    }
    state.last_emit = Some(motion.clone());
    state.last_emit_at = Instant::now();
    emit_motion(app, &motion);
}

/// Called once from `window::setup`.
pub fn setup(app: &AppHandle) {
    let Some(win) = window(app) else { return };
    let settings = window::settings_of(app);
    window::apply_stacking(&win, settings.always_on_top);
    if let Err(e) = win.set_focusable(false) {
        log::debug!("pet set_focusable(false) unsupported here: {e}");
    }
    let scale = scale_of(&settings);
    let size = size_for(scale);
    let dpi = dpi(&win);
    let pos = default_pos(app, size);
    let pos = monitor_at(app, pos.0, pos.1)
        .map(|mon| clamp_to(&mon, size, pos.0, pos.1))
        .unwrap_or(pos);
    if let Some(state) = app.try_state::<crate::window::PlatformState>() {
        let mut pet = state.pet.lock();
        pet.pos = Some(pos);
        pet.size = size;
    }
    resize(&win, size, dpi);
    set_position(&win, pos, dpi);
    if let Err(e) = win.hide() {
        log::debug!("initial pet hide failed: {e}");
    }
    log::info!(
        "pet window prepared at {:.0},{:.0} ({:.0}x{:.0}, ui scale {scale}, dpi {dpi})",
        pos.0,
        pos.1,
        size.0,
        size.1
    );
    start_loop(app.clone());
}

/// Re-apply size / visibility after a settings change.
pub fn apply(app: &AppHandle, settings: &Settings) {
    let Some(win) = window(app) else { return };
    let scale = scale_of(settings);
    let size = size_for(scale);
    let dpi = dpi(&win);
    let (want_visible, ready, pos) = match app.try_state::<crate::window::PlatformState>() {
        Some(state) => {
            let mut pet = state.pet.lock();
            pet.want_visible = settings.pet_on_desktop;
            pet.size = size;
            let pos = pet.pos.unwrap_or_else(|| default_pos(app, size));
            let pos = monitor_at(app, pos.0, pos.1)
                .map(|mon| clamp_to(&mon, size, pos.0, pos.1))
                .unwrap_or(pos);
            pet.pos = Some(pos);
            (pet.want_visible, pet.ready, pos)
        }
        None => (settings.pet_on_desktop, false, default_pos(app, size)),
    };
    resize(&win, size, dpi);
    set_position(&win, pos, dpi);
    window::apply_stacking(&win, settings.always_on_top);
    if !want_visible {
        if win.is_visible().unwrap_or(false) {
            log::info!("pet hidden by settings");
        }
        if let Err(e) = win.hide() {
            log::warn!("hiding the pet failed: {e}");
        }
        return;
    }
    if ready {
        show(&win, app);
    }
}

fn show(win: &WebviewWindow, app: &AppHandle) {
    if win.is_visible().unwrap_or(false) {
        return;
    }
    let settings = window::settings_of(app);
    window::apply_stacking(win, settings.always_on_top);
    match win.show() {
        Ok(()) => {
            window::after_show(win, settings.always_on_top);
            log::info!("pet window shown");
        }
        Err(e) => log::warn!("showing the pet failed: {e}"),
    }
}

/// `pet_ready`: the page loaded. Position from the saved spot (when given),
/// then reveal the window if the settings ask for it.
pub fn ready(app: &AppHandle, x: Option<f64>, y: Option<f64>) {
    let Some(win) = window(app) else { return };
    let settings = window::settings_of(app);
    let scale = scale_of(&settings);
    let size = size_for(scale);
    let dpi = dpi(&win);
    let fallback = default_pos(app, size);
    let wanted = match (x, y) {
        (Some(x), Some(y)) if x.is_finite() && y.is_finite() => (x, y),
        _ => fallback,
    };
    let pos = monitor_at(app, wanted.0, wanted.1)
        .map(|mon| clamp_to(&mon, size, wanted.0, wanted.1))
        .unwrap_or(fallback);
    resize(&win, size, dpi);
    set_position(&win, pos, dpi);
    if let Some(state) = app.try_state::<crate::window::PlatformState>() {
        let mut pet = state.pet.lock();
        pet.pos = Some(pos);
        pet.size = size;
        pet.ready = true;
        pet.want_visible = settings.pet_on_desktop;
        pet.pause_until = Instant::now() + Duration::from_secs(1);
    }
    log::info!(
        "pet page ready at {:.0},{:.0}; onDesktop={}",
        pos.0,
        pos.1,
        settings.pet_on_desktop
    );
    if settings.pet_on_desktop {
        show(&win, app);
    }
}

/// Current logical top-left. Reads the OS position when the window is visible
/// so a native drag is reflected; otherwise returns our bookkeeping.
pub fn where_is(app: &AppHandle) -> Option<(f64, f64)> {
    let win = window(app)?;
    let tracked = app
        .try_state::<crate::window::PlatformState>()
        .and_then(|s| s.pet.lock().pos);
    if win.is_visible().unwrap_or(false) {
        if let (Ok(pos), Ok(Some(mon))) = (win.outer_position(), win.current_monitor()) {
            let scale = mon.scale_factor();
            if scale.is_finite() && scale > 0.0 {
                let logical = (pos.x as f64 / scale, pos.y as f64 / scale);
                if let Some(state) = app.try_state::<crate::window::PlatformState>() {
                    state.pet.lock().pos = Some(logical);
                }
                return Some(logical);
            }
        }
    }
    tracked
}

/// `pet_set_dragging`: stop wandering while the user holds the pet.
pub fn set_dragging(app: &AppHandle, dragging: bool) {
    let Some(state) = app.try_state::<crate::window::PlatformState>() else {
        return;
    };
    let mut pet = state.pet.lock();
    pet.dragging = dragging;
    if dragging {
        pet.moving = false;
        pet.falling = false;
        pet.dir = 0;
        pet.pause_until = Instant::now() + Duration::from_secs(30);
    } else {
        pet.pause_until = Instant::now() + DRAG_SETTLE;
        pet.moving = false;
        pet.falling = false;
    }
    pet.running = false;
    let motion = Motion {
        moving: false,
        running: false,
        dir: 0,
        falling: false,
        x: pet.pos.map(|p| p.0).unwrap_or(0.0),
        y: pet.pos.map(|p| p.1).unwrap_or(0.0),
    };
    publish(app, &mut pet, motion, true);
}

/// `pet_set_roaming`: the page decides whether the pet may walk (asleep or
/// resting = false). It does not override `petRoam` in settings.
pub fn set_roaming(app: &AppHandle, allowed: bool) {
    let Some(state) = app.try_state::<crate::window::PlatformState>() else {
        return;
    };
    let mut pet = state.pet.lock();
    if pet.roam_allowed == allowed {
        return;
    }
    pet.roam_allowed = allowed;
    if allowed {
        pet.pause_until = Instant::now() + Duration::from_millis(400);
    } else {
        pet.moving = false;
        pet.falling = false;
        pet.dir = 0;
    }
    pet.running = false;
    let motion = Motion {
        moving: false,
        running: false,
        dir: 0,
        falling: false,
        x: pet.pos.map(|p| p.0).unwrap_or(0.0),
        y: pet.pos.map(|p| p.1).unwrap_or(0.0),
    };
    publish(app, &mut pet, motion, true);
}

/// `pet_move_by`: fallback for a drag performed in JS. Moves the window by a
/// logical delta and tells the page where it ended up.
pub fn move_by(app: &AppHandle, dx: f64, dy: f64) {
    if !dx.is_finite() || !dy.is_finite() {
        return;
    }
    let Some(win) = window(app) else { return };
    let Some(state) = app.try_state::<crate::window::PlatformState>() else {
        return;
    };
    let scale = scale_of(&window::settings_of(app));
    let dpi = dpi(&win);
    let size = app
        .try_state::<crate::window::PlatformState>()
        .map(|s| s.pet.lock().size)
        .unwrap_or(size_for(scale));
    let mut pet = state.pet.lock();
    let pos = pet.pos.unwrap_or_else(|| default_pos(app, size));
    let target = (pos.0 + dx, pos.1 + dy);
    // Across monitors, clamp to the union of all work areas so the pet can
    // cross a mixed-DPI gap without being snapped back.
    let (x, y) = match monitors::all_monitors(app)
        .iter()
        .map(|m| m.rect)
        .reduce(|a, b| {
            let x = a.x.min(b.x);
            let y = a.y.min(b.y);
            let right = a.right().max(b.right());
            let bottom = a.bottom().max(b.bottom());
            monitors::LogicalRect::new(x, y, right - x, bottom - y)
        }) {
        Some(bounds) => clamp_to(
            &monitors::MonitorRect::new("virtual", bounds.x, bounds.y, bounds.w, bounds.h, scale),
            size,
            target.0,
            target.1,
        ),
        None => target,
    };
    pet.pos = Some((x, y));
    pet.moving = false;
    pet.running = false;
    pet.falling = false;
    pet.dir = 0;
    pet.pause_until = Instant::now() + DRAG_SETTLE;
    set_position(&win, (x, y), dpi);
    let motion = Motion {
        moving: false,
        running: false,
        dir: 0,
        falling: false,
        x,
        y,
    };
    publish(app, &mut pet, motion, true);
}

fn start_loop(app: AppHandle) {
    if LOOP_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut last = Instant::now();
        loop {
            tokio::time::sleep(Duration::from_millis(TICK_MS)).await;
            let now = Instant::now();
            let dt = (now - last).as_secs_f64().min(0.12);
            last = now;
            step(&app, dt);
        }
    });
}

fn step(app: &AppHandle, dt: f64) {
    let settings = window::settings_of(app);
    let Some(win) = app.get_webview_window(windows::PET) else {
        return;
    };
    let Some(slot) = app.try_state::<crate::window::PlatformState>() else {
        return;
    };
    let mut pet = slot.pet.lock();
    let visible = win.is_visible().unwrap_or(false);
    if !visible || !settings.pet_on_desktop {
        pet.moving = false;
        pet.running = false;
        pet.falling = false;
        return;
    }
    let can_move = settings.pet_roam && pet.roam_allowed && !pet.dragging;
    if !can_move {
        if pet.moving || pet.running || pet.falling || pet.dir != 0 {
            pet.moving = false;
            pet.running = false;
            pet.falling = false;
            pet.dir = 0;
            let motion = Motion {
                moving: false,
                running: false,
                dir: 0,
                falling: false,
                x: pet.pos.map(|p| p.0).unwrap_or(0.0),
                y: pet.pos.map(|p| p.1).unwrap_or(0.0),
            };
            publish(app, &mut pet, motion, true);
        }
        return;
    }
    let scale = scale_of(&settings);
    let size = size_for(scale);
    let dpi = dpi(&win);
    if pet.size != size {
        pet.size = size;
    }
    let now = Instant::now();
    if now < pet.pause_until {
        pet.moving = false;
        pet.running = false;
        return;
    }
    let pos = pet.pos.unwrap_or_else(|| default_pos(app, size));
    let mon = match monitor_at(app, pos.0 + size.0 / 2.0, pos.1 + size.1 / 2.0) {
        Some(mon) => mon,
        None => return,
    };
    let min_x = mon.rect.x + MARGIN;
    let max_x = (mon.rect.right() - size.0 - MARGIN).max(min_x);
    let floor_y = (mon.rect.bottom() - size.1 - MARGIN).max(mon.rect.y + MARGIN);
    let mut x = pos.0.clamp(min_x, max_x);
    // A window left below the work area (taskbar removed, monitor changed)
    // snaps up; one left above it falls.
    let mut y = pos.1.min(floor_y);

    // A pet dropped above the work-area bottom falls back down to it. This is
    // deliberately gentle: it reads as the character hopping off the window it
    // was left on, not as a dropped object.
    if y < floor_y - 0.5 {
        let mut falling = true;
        y = (y + FALL_SPEED * dt).min(floor_y);
        if y >= floor_y - 0.5 {
            y = floor_y;
            falling = false;
            pet.pause_until = now + Duration::from_millis(350);
        }
        pet.falling = falling;
        pet.moving = false;
        pet.running = false;
        pet.pos = Some((x, y));
        set_position(&win, (x, y), dpi);
        let motion = Motion {
            moving: false,
            running: false,
            dir: pet.dir,
            falling,
            x,
            y,
        };
        publish(app, &mut pet, motion, true);
        return;
    }
    pet.falling = false;

    if now >= pet.turn_at {
        // 40 % of segments end in a pause, the rest turn around.
        if rand01() < 0.4 {
            pet.moving = false;
            pet.running = false;
            pet.dir = 0;
            pet.pause_until =
                now + Duration::from_secs(2) + Duration::from_millis((rand01() * 4000.0) as u64);
        } else {
            pet.dir = if pet.dir == 0 { 1 } else { -pet.dir };
            pet.turn_at =
                now + Duration::from_secs(3) + Duration::from_millis((rand01() * 4000.0) as u64);
        }
    }
    if !pet.moving && now >= pet.pause_until {
        pet.moving = true;
        // About a third of the trips are a run; the page swaps to the run clip.
        pet.running = rand01() < RUN_CHANCE;
        pet.dir = if pet.dir == 0 {
            if rand01() < 0.5 {
                -1
            } else {
                1
            }
        } else {
            pet.dir
        };
        pet.turn_at =
            now + Duration::from_secs(3) + Duration::from_millis((rand01() * 4000.0) as u64);
    }
    if pet.moving {
        let speed = if pet.running {
            SPEED * RUN_MULTIPLIER
        } else {
            SPEED
        };
        x += pet.dir as f64 * speed * dt;
        if x <= min_x {
            x = min_x;
            pet.dir = 1;
            pet.turn_at =
                now + Duration::from_secs(3) + Duration::from_millis((rand01() * 4000.0) as u64);
        } else if x >= max_x {
            x = max_x;
            pet.dir = -1;
            pet.turn_at =
                now + Duration::from_secs(3) + Duration::from_millis((rand01() * 4000.0) as u64);
        }
    }
    let changed = pos.0 != x || pos.1 != y;
    pet.pos = Some((x, y));
    if changed {
        set_position(&win, (x, y), dpi);
    }
    let motion = Motion {
        moving: pet.moving,
        running: pet.moving && pet.running,
        dir: if pet.moving { pet.dir } else { 0 },
        falling: false,
        x,
        y,
    };
    publish(app, &mut pet, motion, false);
}

fn rand01() -> f64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64 ^ d.as_secs())
        .unwrap_or(0);
    // xorshift64*, enough for choosing a direction and a pause length.
    let mut x = nanos | 1;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    let v = x.wrapping_mul(0x2545_F491_4F6C_DD1D);
    (v >> 11) as f64 / (1u64 << 53) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon() -> monitors::MonitorRect {
        monitors::MonitorRect::new("test", 0.0, 0.0, 1920.0, 1080.0, 1.0)
    }

    #[test]
    fn clamping_keeps_the_window_inside_the_work_area_margin() {
        let (x, y) = clamp_to(&mon(), (240.0, 300.0), -50.0, 2000.0);
        assert_eq!(x, MARGIN);
        assert_eq!(y, 1080.0 - 300.0 - MARGIN);
    }

    #[test]
    fn clamping_accounts_for_a_larger_scale() {
        let (x, y) = clamp_to(&mon(), (360.0, 450.0), 1900.0, 1070.0);
        assert_eq!(x, 1920.0 - 360.0 - MARGIN);
        assert_eq!(y, 1080.0 - 450.0 - MARGIN);
    }

    #[test]
    fn run_segments_are_faster_than_walks_and_occasional() {
        const { assert!(RUN_MULTIPLIER > 1.0) };
        const { assert!(RUN_CHANCE > 0.0 && RUN_CHANCE < 1.0) };
        const { assert!(SPEED * RUN_MULTIPLIER <= FALL_SPEED) };
    }

    #[test]
    fn random_values_stay_in_range() {
        for _ in 0..100 {
            let v = rand01();
            assert!((0.0..=1.0).contains(&v));
        }
    }
}
