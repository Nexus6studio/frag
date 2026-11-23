// VEC-9 Quill Driver.
//
// Magnetic flechette carbine. Holding fire launches one rail-spike on the
// trigger edge and then one every 0.125 s. Each spike is a projectile: 70 m/s,
// 0.06 m radius, removed after 1 s or 70 m. A hit deals 9 with no falloff.
// The magazine is 40. Reserve starts at 40, never exceeds 80, and never goes
// negative. Reload takes 1.4 s from R or from an empty magazine, and the
// trigger does nothing while it runs. An empty hold with no reserve left
// does not fire and does not advance the shot clock.
//
// The shot clock is an accumulator, so a 20 fps frame and a 144 fps frame
// land on the same pulses. Spikes live in a fixed pool. Past the cap, the
// oldest slot is reused. The 0.12° pitch punch is a view offset: it settles
// in 0.10 s, before the next pulse, and it does not bend the bore line.

import { CEILING_Y, KILL_Y, MAP_HALF } from "./atrium.ts";
import { playerHitboxes, type HitboxSweep, type HitboxWorld } from "./hitbox.ts";
import type { Hull, Vec3 } from "./move.ts";
import type { PlayerStore } from "./player/state.ts";
import { traceSegment, type TraceHit } from "./trace.ts";

export const QUILL_DAMAGE = 9;
export const QUILL_SPEED = 70;
export const QUILL_RADIUS = 0.06;
export const QUILL_LENGTH = 0.35;
export const QUILL_LIFETIME = 1;
export const QUILL_RANGE = 70;
export const QUILL_INTERVAL = 0.125;
export const QUILL_PUNCH_DEG = 0.12;
/** Settles before the next 0.125 s pulse while the player holds aim. */
export const QUILL_PUNCH_RECOVER = 0.1;
export const QUILL_MAG = 40;
export const QUILL_RESERVE_CAP = 80;
export const QUILL_RESERVE_START = 40;
export const QUILL_RELOAD = 1.4;
export const QUILL_POOL_CAP = 16;
export const QUILL_FLASH_SECONDS = 0.045;
/** Muzzle, meters forward of the eye along the bore. */
export const MUZZLE_FORWARD = 0.45;

const RECORD = 128;
const DEG = Math.PI / 180;

export interface FlechetteSlot {
  alive: boolean;
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  age: number;
  traveled: number;
  serial: number;
}

export interface QuillCommand {
  fire: boolean;
  /** Rising edge of reload. Held frames after the edge are ignored. */
  reload: boolean;
  origin: Vec3;
  direction: Vec3;
}

export interface QuillOptions {
  hull?: Hull | null;
  player?: PlayerStore | null;
  /** Defaults to the shared enemy list. */
  hitboxes?: HitboxWorld;
  poolCap?: number;
}

export interface QuillDriver {
  update(dt: number, command: QuillCommand): void;
  readonly mag: number;
  readonly reserve: number;
  readonly reloading: boolean;
  /** View punch still left, in degrees. Zero once it has recovered. */
  readonly punchDeg: number;
  /** 1 on the frame of a shot, 0 once the punch has recovered. */
  readonly kick: number;
  /** 1 at the muzzle flash, falling to 0. */
  readonly flash: number;
  readonly shotsFired: number;
  readonly poolCap: number;
  readonly poolSize: number;
  readonly liveCount: number;
  /** Slot objects created. Stays at the cap after the pool is built. */
  readonly allocated: number;
  readonly slots: readonly FlechetteSlot[];
  shotTime(index: number): number;
  shotDirection(index: number): Vec3;
  /**
   * Stores flechettes in the reserve, capped at 80. Does not fill the
   * magazine. Returns how many rounds fit. Ammo pads call this.
   */
  grantReserve(amount: number): number;
  /** Magazine 40, reserve 40, no live flechettes. A death restart calls this. */
  reset(): void;
}

export function aimDirection(yawDeg: number, pitchDeg: number, out: Vec3): Vec3 {
  const yaw = yawDeg * DEG;
  const pitch = pitchDeg * DEG;
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

export function muzzleOrigin(eye: Vec3, direction: Vec3, out: Vec3): Vec3 {
  out.x = eye.x + direction.x * MUZZLE_FORWARD;
  out.y = eye.y + direction.y * MUZZLE_FORWARD - 0.05;
  out.z = eye.z + direction.z * MUZZLE_FORWARD;
  return out;
}

const from: Vec3 = { x: 0, y: 0, z: 0 };
const to: Vec3 = { x: 0, y: 0, z: 0 };
const worldScratch: TraceHit = {
  t: 0,
  distance: 0,
  point: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 0 },
};
const sweepScratch: HitboxSweep = { t: 0, onHit() {} };
const missed: Vec3 = { x: 0, y: 0, z: 0 };

export function createQuill(options: QuillOptions = {}): QuillDriver {
  const hull = options.hull ?? null;
  const targets = options.hitboxes ?? playerHitboxes;
  const player = options.player ?? null;
  const cap = clampCap(options.poolCap ?? QUILL_POOL_CAP);
  const pool: FlechetteSlot[] = [];
  for (let i = 0; i < cap; i += 1) pool.push(createSlot());

  const shotTimes = new Float64Array(RECORD);
  const shotDirs: Vec3[] = [];
  for (let i = 0; i < RECORD; i += 1) shotDirs.push({ x: 0, y: 0, z: 0 });

  let mag = QUILL_MAG;
  let reserve = QUILL_RESERVE_START;
  let reloading = false;
  let reloadTimer = 0;
  let carry = QUILL_INTERVAL;
  let triggerHeld = false;
  let clock = 0;
  let shotsFired = 0;
  let recorded = 0;
  let birth = 0;
  let punch = 0;
  let punchAge = QUILL_PUNCH_RECOVER;
  let flash = 0;
  let publishedMag = mag;
  let publishedReserve = reserve;

  function shoot(command: QuillCommand, time: number): boolean {
    const dx = command.direction.x;
    const dy = command.direction.y;
    const dz = command.direction.z;
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 1e-8) || mag <= 0) return false;

    let slot: FlechetteSlot | null = null;
    let oldest: FlechetteSlot | null = null;
    for (let i = 0; i < pool.length; i += 1) {
      const candidate = pool[i]!;
      if (!candidate.alive) {
        slot = candidate;
        break;
      }
      if (!oldest || candidate.serial < oldest.serial) oldest = candidate;
    }
    if (!slot) slot = oldest;
    if (!slot) return false;

    const inv = 1 / len;
    slot.alive = true;
    slot.x = command.origin.x;
    slot.y = command.origin.y;
    slot.z = command.origin.z;
    slot.dx = dx * inv;
    slot.dy = dy * inv;
    slot.dz = dz * inv;
    slot.age = 0;
    slot.traveled = 0;
    slot.serial = birth + 1;
    birth += 1;
    mag -= 1;
    shotsFired += 1;
    if (recorded < RECORD) {
      shotTimes[recorded] = time;
      const dir = shotDirs[recorded]!;
      dir.x = slot.dx;
      dir.y = slot.dy;
      dir.z = slot.dz;
      recorded += 1;
    }
    punch = QUILL_PUNCH_DEG;
    punchAge = 0;
    flash = 1;
    if (mag <= 0 && reserve > 0) tryStartReload();
    return true;
  }

  function tryStartReload(): void {
    if (reloading || mag >= QUILL_MAG || reserve <= 0) return;
    reloading = true;
    reloadTimer = 0;
  }

  function finishReload(): void {
    reloading = false;
    reloadTimer = 0;
    const room = QUILL_MAG - mag;
    let take = reserve < room ? reserve : room;
    if (take < 0) take = 0;
    mag += take;
    reserve -= take;
    if (reserve < 0) reserve = 0;
    if (reserve > QUILL_RESERVE_CAP) reserve = QUILL_RESERVE_CAP;
    if (mag > QUILL_MAG) mag = QUILL_MAG;
  }

  function advance(dt: number): void {
    if (!(dt > 0)) return;
    // stepSlot reads these. update does not call another driver.
    activeHull = hull;
    activeTargets = targets;
    for (let i = 0; i < pool.length; i += 1) {
      const slot = pool[i]!;
      if (slot.alive) stepSlot(slot, dt);
    }
  }

  function recover(dt: number): void {
    if (!(dt > 0) || punch <= 0) return;
    punchAge += dt;
    if (punchAge >= QUILL_PUNCH_RECOVER - 1e-8) {
      punch = 0;
      return;
    }
    punch = QUILL_PUNCH_DEG * (1 - punchAge / QUILL_PUNCH_RECOVER);
  }

  function decayFlash(dt: number): void {
    if (!(dt > 0) || flash <= 0) return;
    flash -= dt / QUILL_FLASH_SECONDS;
    if (flash < 0) flash = 0;
  }

  function settle(dt: number): void {
    advance(dt);
    recover(dt);
    decayFlash(dt);
  }

  function publish(): void {
    if (!player || (publishedMag === mag && publishedReserve === reserve)) return;
    publishedMag = mag;
    publishedReserve = reserve;
    player.set({ mag, reserve });
  }

  return {
    update(dt: number, command: QuillCommand): void {
      if (!Number.isFinite(dt) || dt < 0) dt = 0;
      if (command.reload) tryStartReload();
      if (!reloading && mag <= 0 && reserve > 0) tryStartReload();

      if (reloading) {
        reloadTimer += dt;
        if (reloadTimer >= QUILL_RELOAD) finishReload();
        settle(dt);
        carry = QUILL_INTERVAL;
        triggerHeld = command.fire;
        clock += dt;
        publish();
        return;
      }

      if (mag <= 0) {
        settle(dt);
        carry = QUILL_INTERVAL;
        triggerHeld = command.fire;
        clock += dt;
        publish();
        return;
      }

      if (command.fire && !triggerHeld) carry = QUILL_INTERVAL;
      triggerHeld = command.fire;

      if (!command.fire) {
        settle(dt);
        carry = QUILL_INTERVAL;
        clock += dt;
        publish();
        return;
      }

      let pending = dt;
      let elapsed = 0;
      while (mag > 0) {
        const need = QUILL_INTERVAL - carry;
        if (need > 1e-6 && need > pending + 1e-6) {
          settle(pending);
          carry += pending;
          pending = 0;
          break;
        }
        if (need > 1e-6) {
          settle(need);
          pending -= need;
          elapsed += need;
        }
        carry = 0;
        if (!shoot(command, clock + elapsed)) break;
        if (mag <= 0 || pending <= 1e-6) break;
      }
      if (pending > 1e-8) {
        if (reloading) reloadTimer += pending;
        settle(pending);
      }
      clock += dt;
      publish();
    },
    get mag() {
      return mag;
    },
    get reserve() {
      return reserve;
    },
    get reloading() {
      return reloading;
    },
    get punchDeg() {
      return punch;
    },
    get kick() {
      return punch > 0 ? punch / QUILL_PUNCH_DEG : 0;
    },
    get flash() {
      return flash;
    },
    get shotsFired() {
      return shotsFired;
    },
    get poolCap() {
      return cap;
    },
    get poolSize() {
      return pool.length;
    },
    get liveCount() {
      let count = 0;
      for (let i = 0; i < pool.length; i += 1) if (pool[i]!.alive) count += 1;
      return count;
    },
    get allocated() {
      return pool.length;
    },
    get slots() {
      return pool;
    },
    shotTime(index: number): number {
      if (index < 0 || index >= recorded) return Number.NaN;
      return shotTimes[index]!;
    },
    shotDirection(index: number): Vec3 {
      if (index < 0 || index >= recorded) return missed;
      return shotDirs[index]!;
    },
    grantReserve(amount: number): number {
      if (!Number.isFinite(amount) || amount <= 0) return 0;
      const room = QUILL_RESERVE_CAP - reserve;
      if (room <= 0) return 0;
      const gain = amount < room ? amount : room;
      reserve += gain;
      publish();
      return gain;
    },
    reset(): void {
      mag = QUILL_MAG;
      reserve = QUILL_RESERVE_START;
      reloading = false;
      reloadTimer = 0;
      carry = QUILL_INTERVAL;
      triggerHeld = false;
      punch = 0;
      punchAge = QUILL_PUNCH_RECOVER;
      flash = 0;
      for (let i = 0; i < pool.length; i += 1) pool[i]!.alive = false;
      publishedMag = -1;
      publishedReserve = -1;
      publish();
    },
  };
}

function stepSlot(slot: FlechetteSlot, dt: number): void {
  const timeLeft = QUILL_LIFETIME - slot.age;
  const distLeft = QUILL_RANGE - slot.traveled;
  if (timeLeft <= 1e-8 || distLeft <= 1e-6) {
    slot.alive = false;
    return;
  }
  const stepTime = dt < timeLeft ? dt : timeLeft;
  const want = QUILL_SPEED * stepTime;
  const dist = want < distLeft ? want : distLeft;
  if (!(dist > 0)) {
    slot.alive = false;
    return;
  }

  from.x = slot.x;
  from.y = slot.y;
  from.z = slot.z;
  to.x = slot.x + slot.dx * dist;
  to.y = slot.y + slot.dy * dist;
  to.z = slot.z + slot.dz * dist;

  let hitT = 1;
  let blocked = false;
  let hit: ((damage: number) => void) | null = null;
  const driverHull = activeHull;
  if (driverHull) {
    const world = traceSegment(from, to, driverHull, worldScratch);
    if (world && world.t <= hitT) {
      hitT = world.t;
      blocked = true;
    }
  }
  const driverTargets = activeTargets;
  if (driverTargets.sweep(from, to, QUILL_RADIUS, sweepScratch) && sweepScratch.t <= hitT) {
    hitT = sweepScratch.t;
    blocked = true;
    hit = sweepScratch.onHit;
  }

  const used = dist * hitT;
  slot.x += slot.dx * used;
  slot.y += slot.dy * used;
  slot.z += slot.dz * used;
  slot.traveled += used;
  slot.age += used / QUILL_SPEED;

  if (hit) hit(QUILL_DAMAGE);
  // Open sky is not a hull. A spike that leaves the atrium is spent.
  const outside =
    driverHull !== null &&
    (Math.abs(slot.x) > MAP_HALF ||
      Math.abs(slot.z) > MAP_HALF ||
      slot.y < KILL_Y ||
      slot.y > CEILING_Y);
  if (hit || blocked || outside || slot.age >= QUILL_LIFETIME - 1e-8 || slot.traveled >= QUILL_RANGE - 1e-4) {
    slot.alive = false;
  }
}

// stepSlot is outside the driver so it can stay allocation-free. The active
// driver is the one currently inside update; traces are not re-entrant.
let activeHull: Hull | null = null;
let activeTargets: HitboxWorld = playerHitboxes;

function createSlot(): FlechetteSlot {
  return {
    alive: false,
    x: 0,
    y: 0,
    z: 0,
    dx: 0,
    dy: 0,
    dz: 1,
    age: 0,
    traveled: 0,
    serial: 0,
  };
}

function clampCap(value: number): number {
  if (!Number.isFinite(value)) return QUILL_POOL_CAP;
  const n = Math.floor(value);
  if (n < 1) return 1;
  if (n > 64) return 64;
  return n;
}
