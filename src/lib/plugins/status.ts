// Pure view-model helpers for the Service status island plugin. [FRONTEND]
//
// Kept free of imports (no `$lib` alias, no runes) so tests/status.unit.ts can
// exercise the normalisation and severity rules under plain Playwright/Node.
// The Rust command already normalises, but the panel treats the payload as
// external input: a future Statuspage field value must degrade, not break.

export type StatusIndicator =
  | 'none'
  | 'minor'
  | 'major'
  | 'critical'
  | 'maintenance'
  | 'unknown';

export type StatusTone = 'ok' | 'warn' | 'critical' | 'info' | 'unknown';

export type IncidentImpact = 'none' | 'minor' | 'major' | 'critical';

export type IncidentState =
  | 'investigating'
  | 'identified'
  | 'monitoring'
  | 'resolved'
  | 'scheduled'
  | 'in_progress'
  | 'verifying'
  | 'completed';

export interface StatusIncident {
  name: string;
  status: string;
  impact: string;
  shortlink: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ServiceStatus {
  id: string;
  name: string;
  url: string;
  indicator: StatusIndicator;
  description: string;
  updatedAt: string | null;
  incidents: StatusIncident[];
  error: string | null;
}

export interface ServiceStatusReport {
  /** Epoch milliseconds of the backend fetch that produced this report. */
  fetchedAt: number;
  /** Always Claude and OpenAI, in display order. */
  services: ServiceStatus[];
}

const INDICATORS: readonly StatusIndicator[] = [
  'none',
  'minor',
  'major',
  'critical',
  'maintenance',
  'unknown',
];

const IMPACTS: readonly IncidentImpact[] = ['none', 'minor', 'major', 'critical'];

const STATES: readonly IncidentState[] = [
  'investigating',
  'identified',
  'monitoring',
  'resolved',
  'scheduled',
  'in_progress',
  'verifying',
  'completed',
];

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Unknown or malformed indicators read as `unknown`, never as operational. */
export function normalizeIndicator(value: unknown): StatusIndicator {
  const candidate = normalized(value);
  return (INDICATORS as readonly string[]).includes(candidate)
    ? (candidate as StatusIndicator)
    : 'unknown';
}

/** Dot colour family for an indicator (the panel maps these to CSS vars). */
export function indicatorTone(value: unknown): StatusTone {
  switch (normalizeIndicator(value)) {
    case 'none':
      return 'ok';
    case 'minor':
      return 'warn';
    case 'major':
    case 'critical':
      return 'critical';
    case 'maintenance':
      return 'info';
    default:
      return 'unknown';
  }
}

/** i18n key for the indicator label; assemble with `tDyn`. */
export function indicatorKey(value: unknown): string {
  return `plugin.status.indicator.${normalizeIndicator(value)}`;
}

/** Unknown impact falls back to `none`, the Statuspage "no impact" value. */
export function normalizeImpact(value: unknown): IncidentImpact {
  const candidate = normalized(value);
  return (IMPACTS as readonly string[]).includes(candidate)
    ? (candidate as IncidentImpact)
    : 'none';
}

/** i18n key for the impact badge; assemble with `tDyn`. */
export function impactKey(value: unknown): string {
  return `plugin.status.impact.${normalizeImpact(value)}`;
}

/** `null` for an unrecognised state, so the panel can show the raw API value. */
export function normalizeState(value: unknown): IncidentState | null {
  const candidate = normalized(value);
  return (STATES as readonly string[]).includes(candidate)
    ? (candidate as IncidentState)
    : null;
}

/** i18n key for the incident state; assemble with `tDyn`, `null` if unknown. */
export function stateKey(value: unknown): string | null {
  const state = normalizeState(value);
  return state ? `plugin.status.state.${state}` : null;
}
