import { test, expect } from '@playwright/test';
import {
  chooseRandomAct,
  frameIndexAt,
  fullnessTier,
  moodPackMode,
  packFramePath,
  packIconPath,
  packIdlePose,
  packPatPose,
  packPose,
  packSequence,
  packSleepPose,
  packWalkPose,
  parsePetPack,
  type PetPack,
  type PetPackAct,
  type PetPackRandomAct,
} from '../src/lib/pet/pack';

function act(overrides: Partial<PetPackAct> = {}): PetPackAct {
  return {
    images: 'stand',
    frames: ['stand_0.png', 'stand_1.png'],
    actNum: 1,
    needMove: false,
    direction: null,
    frameMove: 10,
    frameRefresh: 0.5,
    anchor: [0, 0],
    ...overrides,
  };
}

function randomAct(overrides: Partial<PetPackRandomAct> = {}): PetPackRandomAct {
  return {
    name: '站立',
    acts: ['default'],
    prob: 1,
    actType: [2, 0],
    phase: null,
    ...overrides,
  };
}

function pack(overrides: Partial<PetPack> = {}): PetPack {
  return {
    id: 'kitty',
    name: 'Kitty',
    basePath: 'C:/data/pet-packs/kitty',
    width: 98,
    height: 98,
    scale: 1,
    refresh: 5,
    defaults: {
      default: 'default',
      left: 'left',
      right: 'right',
      drag: 'drag',
      prefall: 'fall',
      fall: 'fall',
      onFloor: 'onfloor',
    },
    acts: {
      default: act(),
      left: act({ frames: ['stand_0.png'] }),
      right: act({ frames: ['stand_0.png'] }),
      drag: act({ frames: ['drag_0.png'] }),
      fall: act({ frames: ['fall_0.png'] }),
      onfloor: act({ frames: ['angry_0.png'] }),
      angry: act({ frames: ['angry_0.png'] }),
      sleep: act({ frames: ['sleep_0.png', 'sleep_1.png'], actNum: 5 }),
      left_walk: act({
        frames: ['leftwalk_0.png', 'leftwalk_1.png'],
        needMove: true,
        direction: 'left',
        frameRefresh: 0.2,
        actNum: 5,
      }),
      right_walk: act({
        frames: ['rightwalk_0.png', 'rightwalk_1.png'],
        needMove: true,
        direction: 'right',
        frameRefresh: 0.2,
        actNum: 5,
      }),
    },
    randomActs: [
      randomAct(),
      randomAct({ name: '睡觉', acts: ['sleep'], prob: 0.05, actType: [1, 1] }),
      randomAct({ name: 'hungry', acts: ['angry'], prob: 1, actType: [0, 0] }),
      randomAct({ name: 'onfloor', acts: ['onfloor'], prob: 0, actType: [0, 10000] }),
    ],
    patpat: { '0': 'angry', '3': 'default' },
    icon: null,
    author: 'tester',
    ...overrides,
  };
}

function sequence(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

test('the backend manifest is parsed defensively and defaults are repaired', () => {
  const raw = {
    id: 'kitty-2',
    name: 'Kitty',
    basePath: 'C:\\data\\pet-packs\\kitty-2\\',
    width: 98,
    height: 98,
    scale: 1,
    refresh: 5,
    defaults: { default: 'default', drag: 'drag', fall: 'fall', onFloor: 'nope' },
    acts: {
      default: {
        images: 'stand',
        frames: ['stand_0.png', 'stand_1.png'],
        actNum: 1,
        needMove: false,
        direction: null,
        frameMove: 10,
        frameRefresh: 0.5,
        anchor: [0, 0],
      },
      drag: {
        images: 'drag',
        frames: ['drag_0.png'],
        actNum: 1,
        needMove: false,
        direction: null,
        frameMove: 10,
        frameRefresh: 0.5,
        anchor: [0, 0],
      },
    },
    randomActs: [
      { name: '站立', acts: ['default', 'missing'], prob: 1, actType: [2, 0] },
    ],
    patpat: { '0': 'default', '1': 'missing' },
    icon: 'info/pfp.png',
    author: 'tester',
  };
  const parsed = parsePetPack(raw);
  expect(parsed).not.toBeNull();
  expect(parsed!.id).toBe('kitty-2');
  expect(parsed!.basePath).toBe('C:/data/pet-packs/kitty-2');
  expect(parsed!.defaults.onFloor).toBe('default');
  expect(parsed!.randomActs[0].acts).toEqual(['default']);
  expect(parsed!.patpat).toEqual({ '0': 'default' });
  expect(parsed!.icon).toBe('info/pfp.png');

  expect(parsePetPack({ ...raw, id: '../kitty' })).toBeNull();
  expect(parsePetPack({ ...raw, id: 'Kitty' })).toBeNull();
  expect(parsePetPack({ ...raw, acts: {} })).toBeNull();
  expect(parsePetPack({ ...raw, basePath: '' })).toBeNull();
  expect(parsePetPack(null)).toBeNull();
});

test('unsafe frame names and impossible numbers are dropped', () => {
  const parsed = parsePetPack({
    id: 'kitty',
    name: 'Kitty',
    basePath: '/packs/kitty',
    width: 999999,
    height: -3,
    scale: 99,
    refresh: 0,
    defaults: { default: 'default' },
    acts: {
      default: {
        images: 'stand',
        frames: ['stand_0.png', '../escape.png', 'notes.txt', 'stand_1.PNG'],
        actNum: 999,
        frameRefresh: 99,
        anchor: ['x', 4],
      },
      broken: { images: 'broken', frames: ['../x.png'] },
    },
    randomActs: [],
    patpat: {},
  });
  expect(parsed).not.toBeNull();
  expect(parsed!.acts.default.frames).toEqual(['stand_0.png', 'stand_1.PNG']);
  expect(parsed!.acts.broken).toBeUndefined();
  expect(parsed!.width).toBe(8192);
  expect(parsed!.height).toBe(1);
  expect(parsed!.scale).toBe(8);
  expect(parsed!.refresh).toBe(0.1);
  expect(parsed!.acts.default.actNum).toBe(100);
  expect(parsed!.acts.default.frameRefresh).toBe(10);
  expect(parsed!.acts.default.anchor).toEqual([0, 4]);
});

test('fullness tiers follow DyberPet boundaries', () => {
  expect(fullnessTier(100)).toBe(3);
  expect(fullnessTier(80)).toBe(2);
  expect(fullnessTier(79.9)).toBe(1);
  expect(fullnessTier(50)).toBe(1);
  expect(fullnessTier(49.9)).toBe(0);
  expect(fullnessTier(0)).toBe(0);
  expect(fullnessTier(Number.NaN)).toBe(2);
});

test('walking prefers matching directional art and mirrors a single act', () => {
  const both = pack();
  expect(packWalkPose(both, -1)).toMatchObject({ name: 'left_walk', mirror: false });
  expect(packWalkPose(both, 1)).toMatchObject({ name: 'right_walk', mirror: false });

  const leftOnly = pack();
  delete leftOnly.acts.right_walk;
  expect(packWalkPose(leftOnly, 1)).toMatchObject({ name: 'left_walk', mirror: true });
  expect(packWalkPose(leftOnly, -1)).toMatchObject({ name: 'left_walk', mirror: false });

  const generic = pack();
  delete generic.acts.left_walk;
  delete generic.acts.right_walk;
  generic.acts.walk = act({ needMove: true, direction: null });
  expect(packWalkPose(generic, 1)).toMatchObject({ name: 'walk', mirror: false });
  expect(packWalkPose(generic, -1)).toMatchObject({ name: 'walk', mirror: true });

  const idle = pack({ acts: { default: act() } });
  expect(packWalkPose(idle, -1)).toMatchObject({ name: 'default', mirror: true });
});

test('sleep and pat acts come from the pack with sensible fallbacks', () => {
  expect(packSleepPose(pack()).name).toBe('sleep');
  expect(packPatPose(pack(), 100).name).toBe('default');
  expect(packPatPose(pack(), 10).name).toBe('angry');
  // Tier 1 is absent: the generic tier 0 entry is used.
  expect(packPatPose(pack(), 60).name).toBe('angry');
  expect(packPose(pack(), 'drag', 100, 1).name).toBe('drag');
  expect(packPose(pack(), 'fall', 100, 1).name).toBe('fall');
  expect(packPose(pack(), 'idle', 100, 0).name).toBe('default');
  expect(packPatPose(pack({ patpat: {} }), 100).name).toBe('default');
  expect(packSleepPose(pack({ acts: { default: act() }, randomActs: [] })).name).toBe('default');
  expect(moodPackMode('tired')).toBe('sleep');
  expect(moodPackMode('happy')).toBe('idle');
});

test('pat is one shot while every other mode loops', () => {
  expect(packSequence(pack(), 'pat', 100, 1)).toMatchObject({ loop: false, mirror: false });
  expect(packSequence(pack(), 'idle', 100, 1).loop).toBe(true);
  expect(packSequence(pack(), 'walk', 100, -1).loop).toBe(true);
  expect(packSequence(pack(), 'sleep', 100, 1).loop).toBe(true);
});

test('random acts use DyberPet tier gates and weights', () => {
  // A full pet has a 50% chance of trying a non-default act.
  expect(chooseRandomAct(pack(), 100, 0, sequence([0.9]))).toBeNull();
  expect(chooseRandomAct(pack(), 100, 0, sequence([0.1, 0]))).toEqual(['default']);
  // Friendship gates an act: the sleep entry needs level 1.
  expect(chooseRandomAct(pack(), 100, 0, sequence([0.1, 0.999]))).toEqual(['default']);
  // Starving always attempts an act and only tier-0 entries qualify.
  expect(chooseRandomAct(pack(), 20, 0, sequence([0]))).toEqual(['angry']);
  // A pack with no eligible random act falls back to the default pose.
  expect(
    chooseRandomAct(
      pack({ randomActs: [randomAct({ acts: ['default'], actType: [2, 0] })] }),
      20,
      0,
      sequence([0])
    )
  ).toBeNull();
});

test('frame timing repeats the whole list actNum times', () => {
  const sleep = pack().acts.sleep;
  expect(frameIndexAt({ ...sleep, frameRefresh: 0.5, actNum: 1 }, 0, true)).toBe(0);
  expect(frameIndexAt({ ...sleep, frameRefresh: 0.5, actNum: 1 }, 499, true)).toBe(0);
  expect(frameIndexAt({ ...sleep, frameRefresh: 0.5, actNum: 1 }, 500, true)).toBe(1);
  expect(frameIndexAt({ ...sleep, frameRefresh: 0.5, actNum: 1 }, 1000, true)).toBe(0);
  expect(frameIndexAt({ ...sleep, frameRefresh: 0.5, actNum: 5 }, 4999, false)).toBe(1);
  expect(frameIndexAt({ ...sleep, frameRefresh: 0.5, actNum: 5 }, 5000, false)).toBeNull();
  expect(frameIndexAt({ ...sleep, frameRefresh: 0 }, 0, true)).toBe(0);
  expect(frameIndexAt({ ...sleep, frames: [] }, 0, true)).toBeNull();
});

test('asset paths are built from the pack root', () => {
  const kitty = pack({ icon: 'info/pfp.png' });
  expect(packFramePath(kitty, 'stand_0.png')).toBe(
    'C:/data/pet-packs/kitty/action/stand_0.png'
  );
  expect(packIconPath(kitty)).toBe('C:/data/pet-packs/kitty/info/pfp.png');
  expect(packIconPath(pack({ icon: null }))).toBe(
    'C:/data/pet-packs/kitty/action/stand_0.png'
  );
  expect(packIdlePose(kitty).name).toBe('default');
});
