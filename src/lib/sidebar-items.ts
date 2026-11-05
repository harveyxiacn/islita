// Which providers, quota windows and chrome elements the floating bar may
// draw (`Settings.sidebarItems` + `ProviderSettings.showInSidebar`). [FRONTEND]
//
// Deliberately rune-free so `tests/sidebar-items.unit.ts` can exercise it
// directly; `stores/rings.svelte.ts` builds the ring groups on top of it.
//
// The rule that holds everything together: switching something off here hides
// it *on the bar only*. Providers keep being polled, the dashboard, the
// history and the popover keep every window, and `barSeverity()` below — the
// collapsed auto-hide handle and anything that warns the user — deliberately
// looks at ALL windows of ALL polled providers, so hiding a ring can never
// hide a warning.
import { severityOf, worstSeverity, type Severity } from './severity';
import type {
  AppSnapshot,
  ProviderId,
  ProviderQuota,
  QuotaWindow,
  Settings,
  SidebarItems,
} from './types';

/** Contract default: the bar shows everything. */
export const defaultSidebarItems: SidebarItems = {
  fiveHour: true,
  weekly: true,
  scoped: true,
  other: true,
  logo: true,
  percentLabel: true,
  settingsButton: true,
  moreButton: true,
};

/** Tolerates settings that predate `sidebarItems` (nothing hidden by accident). */
export function itemsOf(s: Settings): SidebarItems {
  return s.sidebarItems ?? defaultSidebarItems;
}

/**
 * May this window appear on the bar? Per-model / per-feature windows (anything
 * with a `scope`) are one bucket whatever their `kind`, because that is how a
 * user reads them: "the Opus ring", "the Spark ring".
 */
export function windowOnBar(w: QuotaWindow, items: SidebarItems): boolean {
  if (w.scope != null) return items.scoped;
  if (w.kind === 'five_hour') return items.fiveHour;
  if (w.kind === 'seven_day') return items.weekly;
  return items.other;
}

/** Is the provider polled at all? (`enabled` off = no polling, no dashboard.) */
export function providerPolled(quota: ProviderQuota, s: Settings): boolean {
  const cfg = s.providers[quota.provider];
  // explicitly switched off, or the backend reports the provider disabled
  return (cfg?.enabled ?? true) && quota.status !== 'disabled';
}

/** Polled *and* not hidden from the bar by `showInSidebar`. */
export function providerOnBar(quota: ProviderQuota, s: Settings): boolean {
  return providerPolled(quota, s) && (s.providers[quota.provider]?.showInSidebar ?? true);
}

function byOrder(s: Settings) {
  return (a: ProviderQuota, b: ProviderQuota) =>
    (s.providers[a.provider]?.order ?? 0) - (s.providers[b.provider]?.order ?? 0);
}

/** Providers the bar may draw, in the configured order. */
export function barProviders(snap: AppSnapshot | null, s: Settings): ProviderQuota[] {
  return (snap?.providers ?? []).filter((p) => providerOnBar(p, s)).sort(byOrder(s));
}

/** primary window first, then the remaining account-wide windows in backend order. */
function nonScopedWindows(windows: QuotaWindow[]): QuotaWindow[] {
  return windows
    .filter((w) => w.scope == null)
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
}

/**
 * Arcs of a concentric group, outer → inner:
 *   account-wide windows, broadest first (weekly → 5-hour for Claude/Codex;
 *   30-day → weekly → 5-hour for OpenCode Go), then the innermost per-model
 *   weekly window (Claude only and only when `sidebarItems.scoped` is on).
 *   Codex' scoped windows are per-feature additional limits, not a slice of
 *   the account limit, so stacking them inside the same group would be
 *   misleading — they stay in the popover's "More limits" section.
 * If the provider only reports other kinds (e.g. a Zen budget), they still
 * appear in length order, so something sensible is always drawn.
 *
 * `visible` is already filtered, so a hidden kind simply is not there.
 */
function concentricArcs(quota: ProviderQuota, visible: QuotaWindow[], items: SidebarItems): QuotaWindow[] {
  // Longest window outermost: Claude/Codex put weekly outside 5-hour, and
  // OpenCode Go adds its 30-day allowance outside both. Sorting by the
  // advertised window length keeps the hierarchy right without a provider
  // table; `null` lengths (budgets) sort innermost. Older snapshots (and the
  // unit fixtures) omit the length, so the kind supplies the usual value.
  const broadness = (w: QuotaWindow): number =>
    w.windowSeconds ??
    (w.kind === 'seven_day' ? 7 * 86_400 : w.kind === 'five_hour' ? 5 * 3_600 : -1);
  const out = visible
    .filter((w) => w.scope == null)
    .sort((a, b) => broadness(b) - broadness(a));

  if (items.scoped && quota.provider !== 'codex') {
    const scoped = visible.find((w) => w.scope != null && w.kind === 'seven_day');
    if (scoped) out.push(scoped);
  }
  return out.slice(0, 3);
}

/**
 * The ring groups of one provider, each as its arcs from outer to inner —
 * filtering happens *here*, before any group is built, so it works the same in
 * all three ring modes:
 *   "concentric" → at most one group that stacks up to three arcs
 *   "primary"    → one single-arc group (the primary visible window)
 *   "all"        → one single-arc group per visible account-wide window
 *
 * Two empty-ish results, deliberately distinct:
 *   `[[]]` — the provider has nothing to show (not signed in, no windows yet):
 *            one dimmed placeholder ring keeps its status visible;
 *   `[]`   — the provider *has* windows but the user hid every one of them:
 *            it disappears from the bar (and only from the bar).
 */
export function barGroups(quota: ProviderQuota, s: Settings): QuotaWindow[][] {
  const items = itemsOf(s);
  const visible = quota.windows.filter((w) => windowOnBar(w, items));
  if (quota.windows.length > 0 && visible.length === 0) return [];

  if (s.ringMode === 'concentric') {
    const arcs = concentricArcs(quota, visible, items);
    return arcs.length > 0 ? [arcs] : [[]];
  }
  const ordered = nonScopedWindows(visible);
  const rings = s.ringMode === 'all' ? ordered : ordered.slice(0, 1);
  return rings.length > 0 ? rings.map((w) => [w]) : [[]];
}

/**
 * Window the percent label of a group refers to: its primary window, falling
 * back to the first *visible* one when the primary is hidden or absent.
 */
export function labelWindowOf(arcs: QuotaWindow[]): QuotaWindow | null {
  return arcs.find((w) => w.isPrimary) ?? arcs[0] ?? null;
}

export interface BarSeverity {
  /** worst severity across every window of every polled provider */
  severity: Severity;
  /** provider closest to its limit; null when nothing is polled */
  leader: ProviderId | null;
}

/**
 * Alarm state of the whole bar. Computed from the full snapshot on purpose:
 * `showInSidebar`, `sidebarItems` and `ringMode` are presentation, and must
 * never be able to suppress a threshold warning. Anything that notifies the
 * user (the collapsed handle colour today, desktop notifications when they
 * land) has to read this and not the ring items.
 */
export function barSeverity(snap: AppSnapshot | null, s: Settings): BarSeverity {
  const polled = (snap?.providers ?? []).filter((p) => providerPolled(p, s)).sort(byOrder(s));
  if (polled.length === 0) return { severity: 'normal', leader: null };

  let severity: Severity = 'normal';
  let leader = polled[0].provider;
  let peak = -1;
  for (const quota of polled) {
    severity = worstSeverity([
      severity,
      ...quota.windows.map((w) => severityOf(w.usedPercent, s.thresholds)),
    ]);
    const highest = quota.windows.reduce((m, w) => Math.max(m, w.usedPercent), -1);
    if (highest > peak) {
      peak = highest;
      leader = quota.provider;
    }
  }
  return { severity, leader };
}
