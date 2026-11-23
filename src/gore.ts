// Blood for the UNIT-7 Hound only.
//
// A death sprays pooled droplets, throws a few abstract chunks, and stamps
// short-lived decals on the atrium surface the rays actually hit. The player,
// the pads, and the props never call this. WISP-4 keeps its own sparks,
// metal and plastic scraps, and dark hydraulic fluid.
//
// Every slot is allocated once. A full pool reuses the next ring index.
// Nothing here creates a mesh, a geometry, or a texture.

import { CEILING_Y, KILL_Y, MAP_HALF } from "./atrium.ts";
import type { Hull, Vec3 } from "./move.ts";
import { traceRay, type TraceHit } from "./trace.ts";

export const GORE_SPRAY_CAP = 24;
export const GORE_GIB_CAP = 12;
export const GORE_DECAL_CAP = 12;
export const GORE_SPRAY_PER_DEATH = 8;
export const GORE_GIBS_PER_DEATH = 4;
export const GORE_DECALS_PER_DEATH = 4;

export const GORE_SPRAY_LIFE = 0.5;
export const GORE_GIB_LIFE = 1.15;
export const GORE_DECAL_LIFE = 3.4;
/** Lift off the surface so a decal does not z-fight the floor or the wall. */
export const GORE_DECAL_OFFSET = 0.02;
export const GORE_DECAL_REACH = 4;

/** Fictional blood. Drones do not use this. */
export const GORE_BLOOD = 0x9a1c24;

const SPRAY_DIR: readonly (readonly [number, number, number])[] = [
  [0.15, 0.95, 0.1],
  [-0.8, 0.55, 0.25],
  [0.72, 0.4, -0.48],
  [-0.22, 0.7, 0.66],
  [0.5, 0.32, 0.78],
  [-0.62, 0.48, -0.52],
  [0.18, 0.88, -0.36],
  [-0.38, 0.28, 0.4],
];

const GIB_DIR: readonly (readonly [number, number, number])[] = [
  [0.9, 0.45, 0.15],
  [-0.7, 0.6, 0.35],
  [0.25, 0.85, -0.55],
  [-0.4, 0.35, 0.85],
];

const DECAL_DIR: readonly (readonly [number, number, number])[] = [
  [0, -1, 0],
  [1, -0.2, 0],
  [-1, -0.2, 0],
  [0, -0.2, 1],
  [0, -0.2, -1],
];

export interface GorePart {
  alive: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  spin: number;
  /** 0 or 1. Two blood shades, not a body part. */
  shade: number;
}

export interface GoreDecal {
  alive: boolean;
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  age: number;
  life: number;
  size: number;
}

export interface BloodGore {
  readonly spray: readonly GorePart[];
  readonly gibs: readonly GorePart[];
  readonly decals: readonly GoreDecal[];
  readonly bursts: number;
  burst(at: Vec3, hull: Hull): void;
  step(dt: number): void;
  reset(): void;
}

const scratch: TraceHit = {
  t: 0,
  distance: 0,
  point: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 0 },
};
const rayFrom: Vec3 = { x: 0, y: 0, z: 0 };
const rayDir: Vec3 = { x: 0, y: -1, z: 0 };

export function createBloodGore(): BloodGore {
  const spray = makeParts(GORE_SPRAY_CAP);
  const gibs = makeParts(GORE_GIB_CAP);
  const decals = makeDecals(GORE_DECAL_CAP);
  const sprayCursor = { i: 0 };
  const gibCursor = { i: 0 };
  const decalCursor = { i: 0 };
  let bursts = 0;

  function burst(at: Vec3, hull: Hull): void {
    bursts += 1;
    emit(spray, sprayCursor, SPRAY_DIR, GORE_SPRAY_PER_DEATH, at, 5.2, GORE_SPRAY_LIFE, 0);
    emit(gibs, gibCursor, GIB_DIR, GORE_GIBS_PER_DEATH, at, 2.6, GORE_GIB_LIFE, 6);
    let made = 0;
    for (let i = 0; i < DECAL_DIR.length && made < GORE_DECALS_PER_DEATH; i += 1) {
      if (stamp(at, hull, DECAL_DIR[i]!, 0.36 + (i % 3) * 0.07)) made += 1;
    }
    if (made === 0) stampFallback(at);
  }

  function stamp(at: Vec3, hull: Hull, dir: readonly [number, number, number], size: number): boolean {
    rayFrom.x = at.x;
    rayFrom.y = at.y + 1.05;
    rayFrom.z = at.z;
    rayDir.x = dir[0];
    rayDir.y = dir[1];
    rayDir.z = dir[2];
    const hit = traceRay(rayFrom, rayDir, GORE_DECAL_REACH, hull, scratch);
    if (!hit) return false;
    writeDecal(
      hit.point.x + hit.normal.x * GORE_DECAL_OFFSET,
      hit.point.y + hit.normal.y * GORE_DECAL_OFFSET,
      hit.point.z + hit.normal.z * GORE_DECAL_OFFSET,
      hit.normal.x,
      hit.normal.y,
      hit.normal.z,
      size,
    );
    return true;
  }

  function stampFallback(at: Vec3): void {
    writeDecal(at.x, at.y + GORE_DECAL_OFFSET, at.z, 0, 1, 0, 0.36);
  }

  function writeDecal(x: number, y: number, z: number, nx: number, ny: number, nz: number, size: number): void {
    const slot = take(decals, decalCursor);
    slot.alive = true;
    slot.age = 0;
    slot.life = GORE_DECAL_LIFE;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.nx = nx;
    slot.ny = ny;
    slot.nz = nz;
    slot.size = size;
  }

  function step(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    stepParts(spray, dt, 4);
    stepParts(gibs, dt, 9);
    for (let i = 0; i < decals.length; i += 1) {
      const slot = decals[i]!;
      if (!slot.alive) continue;
      slot.age += dt;
      if (slot.age >= slot.life) slot.alive = false;
    }
  }

  function reset(): void {
    silence(spray);
    silence(gibs);
    silence(decals);
  }

  return {
    spray,
    gibs,
    decals,
    get bursts() {
      return bursts;
    },
    burst,
    step,
    reset,
  };
}

function emit(
  pool: GorePart[],
  cursor: { i: number },
  dirs: readonly (readonly [number, number, number])[],
  count: number,
  at: Vec3,
  speed: number,
  life: number,
  spin: number,
): void {
  for (let i = 0; i < count; i += 1) {
    const slot = take(pool, cursor);
    const dir = dirs[i % dirs.length]!;
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const scale = speed * (0.72 + (i % 3) * 0.14);
    slot.alive = true;
    slot.x = at.x;
    slot.y = at.y + 1;
    slot.z = at.z;
    slot.vx = (dir[0] / len) * scale;
    slot.vy = Math.abs(dir[1] / len) * scale + 0.6;
    slot.vz = (dir[2] / len) * scale;
    slot.age = 0;
    slot.life = life;
    slot.spin = spin * (i % 2 === 0 ? 1 : -1);
    slot.shade = i % 2;
  }
}

function take<T extends { alive: boolean }>(pool: readonly T[], cursor: { i: number }): T {
  const count = pool.length;
  for (let n = 0; n < count; n += 1) {
    const index = (cursor.i + n) % count;
    const slot = pool[index]!;
    if (!slot.alive) {
      cursor.i = (index + 1) % count;
      return slot;
    }
  }
  const slot = pool[cursor.i]!;
  cursor.i = (cursor.i + 1) % count;
  return slot;
}

function stepParts(pool: readonly GorePart[], dt: number, gravity: number): void {
  for (let i = 0; i < pool.length; i += 1) {
    const slot = pool[i]!;
    if (!slot.alive) continue;
    slot.vy -= gravity * dt;
    slot.x += slot.vx * dt;
    slot.y += slot.vy * dt;
    slot.z += slot.vz * dt;
    slot.age += dt;
    if (
      slot.age >= slot.life ||
      slot.y < KILL_Y ||
      slot.y > CEILING_Y ||
      Math.abs(slot.x) > MAP_HALF ||
      Math.abs(slot.z) > MAP_HALF
    ) {
      slot.alive = false;
    }
  }
}

function silence(pool: readonly { alive: boolean }[]): void {
  for (let i = 0; i < pool.length; i += 1) pool[i]!.alive = false;
}

function makeParts(count: number): GorePart[] {
  const pool: GorePart[] = [];
  for (let i = 0; i < count; i += 1) {
    pool.push({
      alive: false,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      age: 0,
      life: 0,
      spin: 0,
      shade: 0,
    });
  }
  return pool;
}

function makeDecals(count: number): GoreDecal[] {
  const pool: GoreDecal[] = [];
  for (let i = 0; i < count; i += 1) {
    pool.push({
      alive: false,
      x: 0,
      y: 0,
      z: 0,
      nx: 0,
      ny: 1,
      nz: 0,
      age: 0,
      life: 0,
      size: 0.4,
    });
  }
  return pool;
}
