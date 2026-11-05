// Imported DyberPet packs. [FRONTEND]
//
// DyberPet (GPL-3.0) stores a character as `pet_conf.json` + `act_conf.json` +
// PNG frames under `action/`. Islita does not embed DyberPet's Python code or
// its bundled characters: the Rust side copies a user-picked role folder into
// app data, and this module turns the normalised manifest into an animation.
// That keeps the format compatible without pulling GPL assets into this MIT
// application.
//
// Everything here is pure so the pose/timeline rules can be unit-tested; the
// component only supplies time and random numbers.
import type { PetStatus } from './pet';

export const PET_PACK_SCHEMA = 1;

export interface PetPackAct {
  /** Original frame prefix, e.g. `stand`. */
  images: string;
  /** Frame file names relative to `action/`, in play order. */
  frames: string[];
  /** How many times the frame list repeats. */
  actNum: number;
  needMove: boolean;
  direction: 'left' | 'right' | null;
  frameMove: number;
  /** Seconds per frame. */
  frameRefresh: number;
  /** Logical offset from the bottom-centre, in pack pixels. */
  anchor: [number, number];
}

export interface PetPackRandomAct {
  name: string;
  /** Act names from `acts`, in play order. */
  acts: string[];
  prob: number;
  /** `[fullness tier, friendship level]`; 10000 marks an internal action. */
  actType: [number, number];
  phase: string | null;
}

export interface PetPackDefaults {
  default: string;
  left: string;
  right: string;
  drag: string;
  prefall: string;
  fall: string;
  onFloor: string;
}

export interface PetPack {
  id: string;
  name: string;
  /** Absolute directory path; the caller turns it into an asset URL. */
  basePath: string;
  width: number;
  height: number;
  scale: number;
  refresh: number;
  defaults: PetPackDefaults;
  acts: Record<string, PetPackAct>;
  randomActs: PetPackRandomAct[];
  /** Fullness tier (`0`–`3`) to pat-act name. */
  patpat: Record<string, string>;
  /** `info/pfp.png` or the first default frame, relative to `basePath`. */
  icon: string | null;
  author: string | null;
}

export type PackMode = 'idle' | 'walk' | 'drag' | 'fall' | 'sleep' | 'pat';

export interface PackPose {
  act: PetPackAct;
  /** Act name, useful as a stable key while the pose is shown. */
  name: string;
  /** Mirror the frames because the chosen art faces the other way. */
  mirror: boolean;
}

export interface PackSequence {
  acts: PetPackAct[];
  loop: boolean;
  mirror: boolean;
}

const PACK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_FRAME = /^[^/\\]+\.(?:png|webp|gif|jpe?g)$/i;

function finite(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function text(value: unknown, fallback = '', max = 120): string {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, max);
}

function direction(value: unknown): 'left' | 'right' | null {
  return value === 'left' || value === 'right' ? value : null;
}

function parseAct(raw: unknown): PetPackAct | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.frames)) return null;
  const frames = value.frames.filter(
    (frame): frame is string => typeof frame === 'string' && SAFE_FRAME.test(frame)
  );
  if (frames.length === 0) return null;
  const anchor = Array.isArray(value.anchor) ? value.anchor : [];
  return {
    images: text(value.images, '', 80),
    frames,
    actNum: Math.round(finite(value.actNum, 1, 1, 100)),
    needMove: value.needMove === true,
    direction: direction(value.direction),
    frameMove: finite(value.frameMove, 10, 0, 200),
    frameRefresh: finite(value.frameRefresh, 0.5, 0.04, 10),
    anchor: [
      finite(anchor[0], 0, -8192, 8192),
      finite(anchor[1], 0, -8192, 8192),
    ],
  };
}

/** Defensive parser for the backend manifest; never throws. */
export function parsePetPack(raw: unknown): PetPack | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || !PACK_ID.test(value.id)) return null;
  if (typeof value.basePath !== 'string' || !value.basePath) return null;
  if (!value.acts || typeof value.acts !== 'object' || Array.isArray(value.acts)) return null;

  const acts: Record<string, PetPackAct> = {};
  for (const [name, rawAct] of Object.entries(value.acts as Record<string, unknown>)) {
    if (!name || name.length > 80) continue;
    const act = parseAct(rawAct);
    if (act) acts[name] = act;
  }
  const actNames = Object.keys(acts);
  if (actNames.length === 0) return null;

  const rawDefaults =
    value.defaults && typeof value.defaults === 'object' && !Array.isArray(value.defaults)
      ? (value.defaults as Record<string, unknown>)
      : {};
  const actName = (key: string): string => {
    const name = text(rawDefaults[key], '', 80);
    return name && acts[name] ? name : actNames[0];
  };
  const defaults: PetPackDefaults = {
    default: actName('default'),
    left: actName('left'),
    right: actName('right'),
    drag: actName('drag'),
    prefall: actName('prefall'),
    fall: actName('fall'),
    onFloor: actName('onFloor'),
  };

  const randomActs: PetPackRandomAct[] = [];
  if (Array.isArray(value.randomActs)) {
    for (const rawEntry of value.randomActs) {
      if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
      const entry = rawEntry as Record<string, unknown>;
      const names = Array.isArray(entry.acts)
        ? entry.acts.filter((name): name is string => typeof name === 'string' && !!acts[name])
        : [];
      if (names.length === 0) continue;
      const type = Array.isArray(entry.actType) ? entry.actType : [];
      randomActs.push({
        name: text(entry.name, '', 120),
        acts: names,
        prob: finite(entry.prob, 0, 0, 1000),
        actType: [
          Math.round(finite(type[0], 0, 0, 10000)),
          Math.round(finite(type[1], 0, 0, 100000)),
        ],
        phase: typeof entry.phase === 'string' ? text(entry.phase, '', 20) : null,
      });
    }
  }

  const patpat: Record<string, string> = {};
  if (value.patpat && typeof value.patpat === 'object' && !Array.isArray(value.patpat)) {
    for (const [tier, rawName] of Object.entries(value.patpat as Record<string, unknown>)) {
      const name = text(rawName, '', 80);
      if (acts[name]) patpat[tier] = name;
    }
  }

  const width = finite(value.width, 128, 1, 8192);
  const height = finite(value.height, 128, 1, 8192);
  return {
    id: value.id,
    name: text(value.name, value.id, 120) || value.id,
    basePath: value.basePath.replace(/\\/g, '/').replace(/\/+$/, ''),
    width,
    height,
    scale: finite(value.scale, 1, 0.1, 8),
    refresh: finite(value.refresh, 5, 0.1, 3600),
    defaults,
    acts,
    randomActs,
    patpat,
    icon: typeof value.icon === 'string' && value.icon ? text(value.icon, '', 200) : null,
    author: typeof value.author === 'string' && value.author ? text(value.author, '', 80) : null,
  };
}

/** Fullness tiers match DyberPet's `HP_TIERS = [0, 50, 80, 100]`. */
export function fullnessTier(fullness: number): 0 | 1 | 2 | 3 {
  if (!Number.isFinite(fullness)) return 2;
  if (fullness >= 100) return 3;
  if (fullness >= 80) return 2;
  if (fullness >= 50) return 1;
  return 0;
}

function actOf(pack: PetPack, name: string): PetPackAct | null {
  return pack.acts[name] ?? null;
}

export function packIdlePose(pack: PetPack): PackPose {
  const name = pack.defaults.default;
  const act = actOf(pack, name) ?? pack.acts[Object.keys(pack.acts)[0]];
  return { act, name, mirror: false };
}

/** Walk art may be direction-specific; a generic act is mirrored as needed. */
export function packWalkPose(pack: PetPack, dir: number): PackPose {
  const want: 'left' | 'right' = dir < 0 ? 'left' : 'right';
  const moving = Object.entries(pack.acts).filter(([, act]) => act.needMove);
  const exact = moving.find(([, act]) => act.direction === want);
  if (exact) return { act: exact[1], name: exact[0], mirror: false };
  const other = moving.find(([, act]) => act.direction !== null);
  if (other) {
    return { act: other[1], name: other[0], mirror: other[1].direction !== want };
  }
  const generic = moving[0];
  if (generic) return { act: generic[1], name: generic[0], mirror: want === 'left' };
  return { ...packIdlePose(pack), mirror: want === 'left' };
}

/** Prefer an exact `sleep` act, then a sleep-named random act, then idle. */
export function packSleepPose(pack: PetPack): PackPose {
  for (const name of ['sleep', 'fall_asleep', 'fallasleep', 'sleeping', 'sleep_loop']) {
    const act = actOf(pack, name);
    if (act) return { act, name, mirror: false };
  }
  const named = pack.randomActs.find((entry) => /sleep|睡|眠/i.test(entry.name));
  if (named) {
    const name = named.acts.find((act) => !!pack.acts[act]);
    if (name) return { act: pack.acts[name], name, mirror: false };
  }
  const loose = Object.keys(pack.acts).find((name) => /sleep|睡|眠/i.test(name));
  if (loose) return { act: pack.acts[loose], name: loose, mirror: false };
  return packIdlePose(pack);
}

/** The pat reaction follows the pet's real fullness tier, not a random tier. */
export function packPatPose(pack: PetPack, fullness: number): PackPose {
  const tier = fullnessTier(fullness);
  for (const key of [String(tier), String(0), '0']) {
    const name = pack.patpat[key];
    const act = name ? actOf(pack, name) : null;
    if (act && name) return { act, name, mirror: false };
  }
  return packIdlePose(pack);
}

export function packPose(
  pack: PetPack,
  mode: PackMode,
  fullness: number,
  dir: number
): PackPose {
  switch (mode) {
    case 'walk':
      return packWalkPose(pack, dir);
    case 'drag': {
      const name = pack.defaults.drag;
      return { act: actOf(pack, name) ?? packIdlePose(pack).act, name, mirror: false };
    }
    case 'fall': {
      const name = pack.defaults.fall;
      return { act: actOf(pack, name) ?? packIdlePose(pack).act, name, mirror: false };
    }
    case 'sleep':
      return packSleepPose(pack);
    case 'pat':
      return packPatPose(pack, fullness);
    default:
      return packIdlePose(pack);
  }
}

/** One mode as a playable list. Random idle acts are supplied separately. */
export function packSequence(
  pack: PetPack,
  mode: PackMode,
  fullness: number,
  dir: number
): PackSequence {
  const pose = packPose(pack, mode, fullness, dir);
  return {
    acts: [pose.act],
    loop: mode !== 'pat',
    mirror: pose.mirror,
  };
}

/**
 * How often a non-default act is attempted, indexed by fullness tier — the
 * same table DyberPet uses (`sys_nonDefault_prob`). A starving pet always
 * plays its hungry animation; a full one tries something else half the time.
 */
const NON_DEFAULT_PROB = [1, 0.125, 0.25, 0.5] as const;

/**
 * Pick an idle random act. `null` means "play the default act". Selection
 * mirrors DyberPet's `modules.random_act`: a per-tier gate, then weights of
 * `act_prob * 0.25^|act_type[0] - tier|`. `act_type` is
 * `[minimum fullness tier, minimum friendship level]`, not a fixed tier.
 */
export function chooseRandomAct(
  pack: PetPack,
  fullness: number,
  friendship = 0,
  random: () => number = Math.random
): string[] | null {
  const tier = fullnessTier(fullness);
  const gate = NON_DEFAULT_PROB[tier];
  if (gate < 1 && random() > gate) return null;

  const weighted: { acts: string[]; weight: number }[] = [];
  for (const entry of pack.randomActs) {
    if (entry.acts.length === 0 || entry.prob <= 0) continue;
    const [minTier, minFriend] = entry.actType;
    if (minTier === 10000 || minFriend > friendship) continue;
    if (tier === 0) {
      // Starving: only acts explicitly marked for tier 0 are available.
      if (minTier !== 0) continue;
      weighted.push({ acts: entry.acts, weight: entry.prob });
    } else if (minTier !== 0) {
      weighted.push({
        acts: entry.acts,
        weight: entry.prob * Math.pow(0.25, Math.abs(minTier - tier)),
      });
    }
  }
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return null;

  let roll = random() * total;
  for (const entry of weighted) {
    roll -= entry.weight;
    if (roll <= 0) return entry.acts;
  }
  return weighted[weighted.length - 1].acts;
}

/**
 * The frame shown after `elapsedMs`, or `null` when a non-looping act has
 * played all `actNum` repeats. `actNum` counts repeats, not frames — the same
 * convention as DyberPet.
 */
export function frameIndexAt(
  act: PetPackAct,
  elapsedMs: number,
  loop: boolean
): number | null {
  const frames = act.frames.length;
  if (frames === 0) return null;
  const step = Math.max(40, act.frameRefresh * 1000);
  const total = frames * Math.max(1, Math.round(act.actNum));
  const raw = Math.floor(Math.max(0, elapsedMs) / step);
  if (!loop && raw >= total) return null;
  return raw % frames;
}

export function packFramePath(pack: PetPack, frame: string): string {
  return `${pack.basePath}/action/${frame}`;
}

/** The chosen pack icon, or the first frame of the idle act. */
export function packIconPath(pack: PetPack): string {
  if (pack.icon) return `${pack.basePath}/${pack.icon}`;
  const idle = packIdlePose(pack);
  return packFramePath(pack, idle.act.frames[0]);
}

/** Extra display height of a frame due to its anchor, in CSS pixels. */
export function packAnchor(act: PetPackAct, scale: number): { x: number; y: number } {
  return { x: act.anchor[0] * scale, y: act.anchor[1] * scale };
}

/** Map the pet's mood to a pack mode for the panel (which has no walking). */
export function moodPackMode(status: PetStatus): PackMode {
  return status === 'tired' ? 'sleep' : 'idle';
}
