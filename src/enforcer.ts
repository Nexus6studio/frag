// UNIT-7 Hound, the megacorp enforcer.
//
// A grounded armored humanoid. 80 HP, 15 armor, the same absorb rule as the
// player. It walks at 4.2 m/s, never jumps, and uses the player capsule step
// so atrium ramps and 0.30 m stairs are the same surfaces the player climbs.
// The nav graph is the route the atrium circuit already proves: around the
// well, up a ramp or a stair, along the catwalk, never across a parapet.
//
// The stun-blaster is a short hitscan cone. The atrium hull is tested first,
// so a round stops on a wall. Death is a collapse, a spark pool, and a blood
// spray with gibs and surface decals. The hound is a fictional unit. The
// player, the pads, and the props do not gib.

import {
  ATRIUM_RAMPS,
  ATRIUM_STAIRS,
  CATWALK_Y,
  CEILING_Y,
  GROUND_Y,
  MAP_HALF,
  WELL_HALF,
  capsuleClear,
} from "./atrium.ts";
import type { HitboxHandle, HitboxWorld } from "./hitbox.ts";
import { playerHitboxes } from "./hitbox.ts";
import {
  CAPSULE_HEIGHT,
  CAPSULE_RADIUS,
  SIM_DT,
  STEP_HEIGHT,
  createMoveState,
  stepMovement,
  type Hull,
  type MoveState,
  type Vec3,
} from "./move.ts";
import type { CueListener } from "./cues.ts";
import { HIT_FLASH_SECONDS } from "./feel.ts";
import { createBloodGore, type GoreDecal, type GorePart } from "./gore.ts";
import { applyDamage } from "./pickups.ts";
import { damagePlayer } from "./player/hurt.ts";
import type { PlayerStore } from "./player/state.ts";
import { traceRay, traceSegment, type TraceHit } from "./trace.ts";
import { ENFORCER_CAP, type WaveDirector } from "./waves.ts";

export const ENFORCER_HP = 80;
export const ENFORCER_ARMOR = 15;
export const ENFORCER_SPEED = 4.2;
export const ENFORCER_STEP = STEP_HEIGHT;
export const ENFORCER_RANGE = 12;
export const ENFORCER_RANGE_MIN = 4;
export const ENFORCER_RANGE_MAX = 8;
export const ENFORCER_DAMAGE = 12;
export const ENFORCER_INTERVAL = 0.9;
/** Same quiet start as the drones, so wave 1 does not shoot during the latch. */
export const ENFORCER_GRACE = 2;
export const ENFORCER_SEPARATION = 8;
export const ENFORCER_SIDESTEP = 1;
export const ENFORCER_HURT_WINDOW = 1;
export const ENFORCER_HURT_TRIGGER = 25;
export const ENFORCER_SPARK_CAP = 16;
export const ENFORCER_FLASH_CAP = 4;
export const ENFORCER_CHEST = 0.95;
export const ENFORCER_RADIUS = 0.5;

const CONE_COS = Math.cos((14 * Math.PI) / 180);
const SHOT_RECORD = 32;
const HURT_SLOTS = 8;
const SPARKS_PER_DEATH = 8;
const FLASH_LIFE = 0.12;

export interface EnforcerSpark {
  alive: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
}

export interface EnforcerFlash {
  alive: boolean;
  age: number;
  life: number;
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  length: number;
}

export interface EnforcerUnit {
  readonly index: number;
  alive: boolean;
  hp: number;
  armor: number;
  /** Feet. The move state writes this same object. */
  readonly position: Vec3;
  /** Radians. Zero looks toward -Z. */
  yaw: number;
  /** Seconds of lateral cover left. Zero means it is pushing. */
  sidestep: number;
  /** Seconds of spawn grace left. */
  grace: number;
  /** Seconds of white-cyan hit flash still left. */
  hitFlash: number;
  /** Collapse timer. Negative hides a corpse; 0 starts the fall. */
  down: number;
}

export interface EnforcerSnapshot {
  alive: number;
  shots: number;
  hits: number;
  firstShot: number | null;
  units: { x: number; y: number; z: number; alive: boolean; hp: number }[];
}

export interface EnforcerSim {
  readonly units: readonly EnforcerUnit[];
  readonly sparks: readonly EnforcerSpark[];
  readonly flashes: readonly EnforcerFlash[];
  readonly spray: readonly GorePart[];
  readonly gibs: readonly GorePart[];
  readonly decals: readonly GoreDecal[];
  readonly goreBursts: number;
  readonly time: number;
  update(dt: number, feet: Vec3): void;
  aliveCount(): number;
  hurt(index: number, amount: number): void;
  /** Age the hit flash. Safe to call when the rest of the sim is paused. */
  tickFlash(dt: number): void;
  killAlive(): void;
  spawnCount(count: number, feet: Vec3): void;
  place(index: number, feet: Vec3): void;
  shotCount(): number;
  shotTime(index: number): number;
  snapshot(): EnforcerSnapshot;
}

export interface EnforcerOptions {
  hull: Hull;
  player: PlayerStore;
  hitboxes?: HitboxWorld;
  director?: WaveDirector;
  /** Called once when the last living enforcer drops. */
  onCleared?: () => void;
  /** Override the 2 s spawn grace. Tests that measure the gun pass 0. */
  grace?: number;
  /** Shots, hits, and kills. The view plays these. The sim does not. */
  onEvent?: CueListener;
}

interface Unit extends EnforcerUnit {
  body: MoveState;
  chest: Vec3;
  side: number;
  cooldown: number;
  seen: boolean;
  lastSeen: Vec3;
  hurtCount: number;
  hurtTime: Float64Array;
  hurtAmount: Float64Array;
  path: number[];
  pathCursor: number;
  pathEnd: number;
  anchorX: number;
  anchorZ: number;
  stuck: number;
  handle: HitboxHandle;
}

interface NavNode {
  x: number;
  z: number;
  y: number;
}

const scratchHit: TraceHit = {
  t: 0,
  distance: 0,
  point: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 0 },
};
const downFrom: Vec3 = { x: 0, y: 0, z: 0 };
const downDir: Vec3 = { x: 0, y: -1, z: 0 };
const shotTo: Vec3 = { x: 0, y: 0, z: 0 };
const shotFrom: Vec3 = { x: 0, y: 0, z: 0 };
const steer = { x: 0, z: 0 };
const steerIntent = { forward: 0, strafe: 0, jump: false as const, yawDeg: 0, wishSpeed: 0 };
const pathStack: number[] = [];

const SPARK_DIR: readonly (readonly [number, number, number])[] = [
  [0.85, 0.7, 0.2],
  [-0.75, 0.85, 0.3],
  [0.2, 0.95, -0.55],
  [-0.4, 0.6, 0.85],
  [0.55, 0.4, -0.8],
  [-0.9, 0.5, -0.25],
  [0.15, 0.8, 0.65],
  [-0.5, 0.7, -0.6],
];

export function enforcerInsideVolume(feet: Vec3): boolean {
  return (
    Math.abs(feet.x) + CAPSULE_RADIUS <= MAP_HALF + 0.08 &&
    Math.abs(feet.z) + CAPSULE_RADIUS <= MAP_HALF + 0.08 &&
    feet.y >= -0.05 &&
    feet.y + CAPSULE_HEIGHT <= CEILING_Y + 0.08
  );
}

export function createEnforcerSim(options: EnforcerOptions): EnforcerSim {
  const hull = options.hull;
  const player = options.player;
  const hitboxes = options.hitboxes ?? playerHitboxes;
  const director = options.director;
  const graceTime = options.grace ?? ENFORCER_GRACE;
  const nav = buildNav();
  const edges = linkNav(nav.nodes);
  const dist = new Float64Array(nav.nodes.length);
  const prev = new Int16Array(nav.nodes.length);
  const used = new Uint8Array(nav.nodes.length);

  const units: Unit[] = [];
  for (let i = 0; i < ENFORCER_CAP; i += 1) {
    units.push(makeUnit(i, hitboxes, (unit, amount) => applyHit(unit, amount)));
  }
  const sparks = makeSparks(ENFORCER_SPARK_CAP);
  const flashes = makeFlashes(ENFORCER_FLASH_CAP);
  const gore = createBloodGore();
  const shotTimes = new Float64Array(SHOT_RECORD);
  let time = 0;
  let shots = 0;
  let hits = 0;
  let firstShot = Number.POSITIVE_INFINITY;

  function applyHit(unit: Unit, amount: number): void {
    if (!unit.alive || !Number.isFinite(amount) || amount <= 0) return;
    const next = applyDamage(amount, unit.hp, unit.armor);
    unit.hp = next.hp;
    unit.armor = next.armor;
    unit.hitFlash = HIT_FLASH_SECONDS;
    rememberHurt(unit, amount, time);
    if (unit.hp > 0) {
      options.onEvent?.({ type: "enemy-hit" });
      if (hurtSum(unit, time) >= ENFORCER_HURT_TRIGGER && unit.sidestep <= 0) {
        unit.sidestep = ENFORCER_SIDESTEP;
        unit.side = coverSign(unit, hull);
      }
      return;
    }
    unit.hp = 0;
    unit.alive = false;
    unit.down = 0;
    unit.sidestep = 0;
    unit.handle.setActive(false);
    options.onEvent?.({ type: "enemy-kill" });
    burst(unit.position);
    gore.burst(unit.position, hull);
    director?.noteFrag();
    if (aliveCount() === 0) options.onCleared?.();
  }

  function aliveCount(): number {
    let count = 0;
    for (let i = 0; i < units.length; i += 1) if (units[i]!.alive) count += 1;
    return count;
  }

  function spawnCount(count: number, feet: Vec3): void {
    const wanted = Math.max(0, Math.min(ENFORCER_CAP, Math.floor(count)));
    const points = planSpawns(feet, hull, wanted);
    for (let i = 0; i < units.length; i += 1) deactivate(units[i]!);
    for (let i = 0; i < sparks.length; i += 1) sparks[i]!.alive = false;
    for (let i = 0; i < flashes.length; i += 1) flashes[i]!.alive = false;
    gore.reset();
    for (let i = 0; i < wanted; i += 1) activate(units[i]!, points[i]!, feet, graceTime);
  }

  function place(index: number, feet: Vec3): void {
    const unit = units[index];
    if (!unit) return;
    activate(unit, feet, feet, graceTime);
  }

  function update(dt: number, feet: Vec3): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (player.get().hp <= 0) return;
    let left = dt;
    while (left > 1e-9) {
      const slice = left > SIM_DT ? SIM_DT : left;
      step(slice, feet);
      left -= slice;
    }
  }

  function step(dt: number, feet: Vec3): void {
    time += dt;
    for (let i = 0; i < units.length; i += 1) {
      const unit = units[i]!;
      if (!unit.alive) {
        if (unit.down >= 0) unit.down += dt;
        continue;
      }
      if (unit.grace > 0) unit.grace -= dt;
      if (unit.sidestep > 0) {
        unit.sidestep -= dt;
        if (unit.sidestep <= 0) {
          unit.sidestep = 0;
          unit.hurtCount = 0;
        }
      }
      remember(unit, feet, hull);
      const intent = steerUnit(unit, hull, nav.nodes, edges, dist, prev, used);
      const next = stepMovement(unit.body, intent, dt, hull);
      copyMove(unit.body, next);
      syncChest(unit);
      if (!(unit.grace > 0)) {
        unit.cooldown -= dt;
        if (unit.cooldown <= 0) {
          const overshoot = unit.cooldown;
          const fired = tryFire(unit, feet, hull);
          unit.cooldown = fired ? ENFORCER_INTERVAL + overshoot : 0;
        }
      }
    }
    stepSparks(sparks, dt);
    stepFlashes(flashes, dt);
    gore.step(dt);
  }

  function tryFire(unit: Unit, feet: Vec3, world: Hull): boolean {
    const mx = unit.position.x - Math.sin(unit.yaw) * 0.42;
    const my = unit.position.y + 1.5;
    const mz = unit.position.z - Math.cos(unit.yaw) * 0.42;
    const tx = feet.x - mx;
    const ty = feet.y + ENFORCER_CHEST - my;
    const tz = feet.z - mz;
    const dist = Math.hypot(tx, ty, tz);
    if (!(dist > 0.2) || dist > ENFORCER_RANGE) return false;
    const inv = 1 / dist;
    const fx = -Math.sin(unit.yaw);
    const fz = -Math.cos(unit.yaw);
    const aim = fx * tx * inv + fz * tz * inv;
    if (aim < CONE_COS) return false;
    shotTo.x = mx + tx;
    shotTo.y = my + ty;
    shotTo.z = mz + tz;
    shotFrom.x = mx;
    shotFrom.y = my;
    shotFrom.z = mz;
    const blocked = traceSegment(shotFrom, shotTo, world, scratchHit);
    if (blocked && blocked.distance < dist - 0.35) return false;
    const armorBefore = player.get().armor;
    const hpBefore = player.get().hp;
    damagePlayer(player, ENFORCER_DAMAGE, shotFrom);
    const changed = player.get().hp !== hpBefore || player.get().armor !== armorBefore;
    if (!changed) return false;
    if (shots < SHOT_RECORD) shotTimes[shots] = time;
    shots += 1;
    options.onEvent?.({ type: "enforcer-shot" });
    hits += 1;
    if (time < firstShot) firstShot = time;
    emitFlash(mx, my, mz, tx * inv, ty * inv, tz * inv, dist);
    return true;
  }

  function emitFlash(x: number, y: number, z: number, dx: number, dy: number, dz: number, length: number): void {
    const slot = takeFlash(flashes);
    slot.alive = true;
    slot.age = 0;
    slot.life = FLASH_LIFE;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.dx = dx;
    slot.dy = dy;
    slot.dz = dz;
    slot.length = length;
  }

  function burst(at: Vec3): void {
    for (let i = 0; i < SPARKS_PER_DEATH; i += 1) {
      const slot = takeSpark(sparks);
      const dir = SPARK_DIR[i % SPARK_DIR.length]!;
      const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      const scale = 4.2 * (0.75 + (i % 3) * 0.12);
      slot.alive = true;
      slot.x = at.x;
      slot.y = at.y + 1;
      slot.z = at.z;
      slot.vx = (dir[0] / len) * scale;
      slot.vy = Math.abs(dir[1] / len) * scale + 1.2;
      slot.vz = (dir[2] / len) * scale;
      slot.age = 0;
      slot.life = 0.55;
    }
  }

  function snapshot(): EnforcerSnapshot {
    const view: EnforcerSnapshot["units"] = [];
    let alive = 0;
    for (let i = 0; i < units.length; i += 1) {
      const unit = units[i]!;
      if (unit.alive) alive += 1;
      view.push({
        x: unit.position.x,
        y: unit.position.y,
        z: unit.position.z,
        alive: unit.alive,
        hp: unit.hp,
      });
    }
    return {
      alive,
      shots,
      hits,
      firstShot: Number.isFinite(firstShot) ? firstShot : null,
      units: view,
    };
  }

  return {
    units,
    sparks,
    flashes,
    spray: gore.spray,
    gibs: gore.gibs,
    decals: gore.decals,
    get goreBursts() {
      return gore.bursts;
    },
    get time() {
      return time;
    },
    update,
    aliveCount,
    hurt(index: number, amount: number): void {
      const unit = units[index];
      if (!unit) return;
      applyHit(unit, amount);
    },
    tickFlash(dt: number): void {
      if (!(dt > 0)) return;
      for (let i = 0; i < units.length; i += 1) {
        const unit = units[i]!;
        if (!(unit.hitFlash > 0)) continue;
        unit.hitFlash -= dt;
        if (unit.hitFlash < 0) unit.hitFlash = 0;
      }
    },
    killAlive(): void {
      for (let i = 0; i < units.length; i += 1) {
        const unit = units[i]!;
        if (!unit.alive) continue;
        applyHit(unit, unit.hp + unit.armor + 1);
      }
    },
    spawnCount,
    place,
    shotCount(): number {
      return shots;
    },
    shotTime(index: number): number {
      if (index < 0 || index >= shots || index >= SHOT_RECORD) return Number.NaN;
      return shotTimes[index]!;
    },
    snapshot,
  };
}

function steerUnit(
  unit: Unit,
  hull: Hull,
  nodes: readonly NavNode[],
  edges: readonly number[][],
  dist: Float64Array,
  prev: Int16Array,
  used: Uint8Array,
): { forward: number; strafe: number; jump: false; yawDeg: number; wishSpeed: number } {
  const goal = unit.lastSeen;
  const pos = unit.position;
  const sameDeck = deck(pos.y) === deck(goal.y) && deck(pos.y) !== 1;
  const clear = sameDeck && routeClear(pos.x, pos.y, pos.z, goal.x, goal.y, goal.z, hull);
  if (clear) {
    steer.x = goal.x;
    steer.z = goal.z;
  } else {
    // Keep the path until the goal's deck node changes. Rebuilding from the
    // nearest node every step flips the ramp foot and the climber walks back down.
    const end = nearestNode(nodes, goal.x, goal.z, goal.y);
    const shifted = Math.hypot(pos.x - unit.anchorX, pos.z - unit.anchorZ);
    if (shifted > 0.4) {
      unit.anchorX = pos.x;
      unit.anchorZ = pos.z;
      unit.stuck = 0;
    } else unit.stuck += 1 / 120;
    const jammed = unit.stuck > 1.2;
    if (unit.pathEnd !== end || unit.path.length === 0 || jammed) {
      const start = nearestNode(nodes, pos.x, pos.z, pos.y);
      writePath(nodes, edges, dist, prev, used, start, end, unit.path);
      unit.pathEnd = end;
      unit.pathCursor = jammed && unit.path.length > 1 ? 1 : 0;
      unit.stuck = 0;
      unit.anchorX = pos.x;
      unit.anchorZ = pos.z;
    }
    while (unit.pathCursor < unit.path.length) {
      const node = nodes[unit.path[unit.pathCursor]!]!;
      if (Math.hypot(node.x - pos.x, node.z - pos.z) < 1.15) unit.pathCursor += 1;
      else break;
    }
    if (unit.pathCursor >= unit.path.length) {
      steer.x = goal.x;
      steer.z = goal.z;
    } else {
      const node = nodes[unit.path[unit.pathCursor]!]!;
      steer.x = node.x;
      steer.z = node.z;
    }
  }

  const toX = goal.x - pos.x;
  const toZ = goal.z - pos.z;
  const toPlayer = Math.hypot(toX, toZ);
  let faceX = steer.x - pos.x;
  let faceZ = steer.z - pos.z;
  let forward = 1;
  let strafe = 0;
  if (unit.sidestep > 0) {
    forward = 0;
    strafe = unit.side;
    faceX = toX;
    faceZ = toZ;
  } else if (clear && toPlayer <= ENFORCER_RANGE_MAX && toPlayer >= ENFORCER_RANGE_MIN) {
    forward = 0;
    faceX = toX;
    faceZ = toZ;
  } else if (clear && toPlayer < ENFORCER_RANGE_MIN) {
    forward = -1;
    faceX = toX;
    faceZ = toZ;
  }
  if (Math.hypot(faceX, faceZ) < 1e-4) {
    faceX = -Math.sin(unit.yaw);
    faceZ = -Math.cos(unit.yaw);
  }
  unit.yaw = Math.atan2(-faceX, -faceZ);
  steerIntent.forward = forward;
  steerIntent.strafe = strafe;
  steerIntent.jump = false;
  steerIntent.yawDeg = (unit.yaw * 180) / Math.PI;
  steerIntent.wishSpeed = ENFORCER_SPEED;
  return steerIntent;
}

function remember(unit: Unit, feet: Vec3, hull: Hull): void {
  if (!unit.seen || lineClear(unit, feet, hull)) {
    unit.lastSeen.x = feet.x;
    unit.lastSeen.y = feet.y;
    unit.lastSeen.z = feet.z;
    unit.seen = true;
  }
}

function lineClear(unit: Unit, feet: Vec3, hull: Hull): boolean {
  const ax = unit.position.x;
  const ay = unit.position.y + 1.5;
  const az = unit.position.z;
  const bx = feet.x;
  const by = feet.y + ENFORCER_CHEST;
  const bz = feet.z;
  const dist = Math.hypot(bx - ax, by - ay, bz - az);
  if (!(dist > 0.05)) return true;
  shotTo.x = bx;
  shotTo.y = by;
  shotTo.z = bz;
  shotFrom.x = ax;
  shotFrom.y = ay;
  shotFrom.z = az;
  const hit = traceSegment(shotFrom, shotTo, hull, scratchHit);
  return !hit || hit.distance >= dist - 0.4;
}

function coverSign(unit: Unit, hull: Hull): number {
  const rx = Math.cos(unit.yaw);
  const rz = -Math.sin(unit.yaw);
  const left = coverDistance(unit, -rx, -rz, hull);
  const right = coverDistance(unit, rx, rz, hull);
  if (left < right) return -1;
  return 1;
}

function coverDistance(unit: Unit, x: number, z: number, hull: Hull): number {
  const fromY = unit.position.y + ENFORCER_CHEST;
  shotTo.x = unit.position.x + x * 3;
  shotTo.y = fromY;
  shotTo.z = unit.position.z + z * 3;
  const hit = traceSegment(
    { x: unit.position.x, y: fromY, z: unit.position.z },
    shotTo,
    hull,
    scratchHit,
  );
  return hit ? hit.distance : 99;
}

function rememberHurt(unit: Unit, amount: number, now: number): void {
  if (unit.hurtCount < HURT_SLOTS) {
    unit.hurtTime[unit.hurtCount] = now;
    unit.hurtAmount[unit.hurtCount] = amount;
    unit.hurtCount += 1;
    return;
  }
  let oldest = 0;
  for (let i = 1; i < HURT_SLOTS; i += 1) {
    if (unit.hurtTime[i]! < unit.hurtTime[oldest]!) oldest = i;
  }
  unit.hurtTime[oldest] = now;
  unit.hurtAmount[oldest] = amount;
}

function hurtSum(unit: Unit, now: number): number {
  let sum = 0;
  for (let i = 0; i < unit.hurtCount; i += 1) {
    if (now - unit.hurtTime[i]! <= ENFORCER_HURT_WINDOW) sum += unit.hurtAmount[i]!;
  }
  return sum;
}

function deck(y: number): number {
  if (y < 1.8) return 0;
  if (y > 4.4) return 2;
  return 1;
}

function routeClear(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  hull: Hull,
): boolean {
  const steps = 8;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    const expect = ay + (by - ay) * t;
    const y = floorY(x, Math.max(ay, by, expect) + 1.6, z, hull);
    // The well floor is 0.8 m under the ring, so a straight line across it fails.
    // A flat test floor stays at one height and stays clear.
    if (Math.abs(y - expect) > 0.65) return false;
    if (!capsuleClear({ x, y, z }, hull)) return false;
  }
  return true;
}

function floorY(x: number, y: number, z: number, hull: Hull): number {
  downFrom.x = x;
  downFrom.y = Math.min(CEILING_Y - 0.05, y);
  downFrom.z = z;
  const hit = traceRay(downFrom, downDir, 30, hull, scratchHit);
  return hit ? hit.point.y : 0;
}

function nearestNode(nodes: readonly NavNode[], x: number, z: number, y: number): number {
  let best = 0;
  let bestScore = Infinity;
  let fallback = 0;
  let fallbackScore = Infinity;
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]!;
    const horizontal = Math.hypot(node.x - x, node.z - z);
    const dy = Math.abs(node.y - y);
    const score = horizontal + dy * 4;
    if (score < fallbackScore) {
      fallbackScore = score;
      fallback = i;
    }
    if (dy > 2.4) continue;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return bestScore < Infinity ? best : fallback;
}

function writePath(
  nodes: readonly NavNode[],
  edges: readonly number[][],
  dist: Float64Array,
  prev: Int16Array,
  used: Uint8Array,
  start: number,
  end: number,
  out: number[],
): void {
  out.length = 0;
  if (start === end) {
    out.push(start);
    return;
  }
  for (let i = 0; i < nodes.length; i += 1) {
    dist[i] = Infinity;
    prev[i] = -1;
    used[i] = 0;
  }
  dist[start] = 0;
  for (;;) {
    let pick = -1;
    let best = Infinity;
    for (let i = 0; i < nodes.length; i += 1) {
      if (used[i] === 0 && dist[i]! < best) {
        best = dist[i]!;
        pick = i;
      }
    }
    if (pick < 0 || pick === end) break;
    used[pick] = 1;
    const list = edges[pick]!;
    for (let i = 0; i < list.length; i += 1) {
      const next = list[i]!;
      const node = nodes[pick]!;
      const other = nodes[next]!;
      const weight = Math.hypot(node.x - other.x, node.z - other.z);
      const score = dist[pick]! + weight;
      if (score < dist[next]!) {
        dist[next] = score;
        prev[next] = pick;
      }
    }
  }
  pathStack.length = 0;
  for (let cursor = end; cursor >= 0; cursor = prev[cursor]!) pathStack.push(cursor);
  for (let i = pathStack.length - 1; i >= 0; i -= 1) out.push(pathStack[i]!);
}

function buildNav(): { nodes: NavNode[] } {
  const ne = ATRIUM_RAMPS.find((ramp) => ramp.id === "ne")!;
  const nw = ATRIUM_RAMPS.find((ramp) => ramp.id === "nw")!;
  const se = ATRIUM_STAIRS.find((stair) => stair.id === "se")!;
  const sw = ATRIUM_STAIRS.find((stair) => stair.id === "sw")!;
  const seX = (se.x0 + se.x1) / 2;
  const swX = (sw.x0 + sw.x1) / 2;
  const nodes: NavNode[] = [
    { x: 0, z: 8.2, y: GROUND_Y },
    { x: 8.1, z: 8.2, y: GROUND_Y },
    { x: 8.2, z: 0, y: GROUND_Y },
    { x: 8.1, z: -7.2, y: GROUND_Y },
    { x: 0, z: -7.2, y: GROUND_Y },
    { x: -8.1, z: -7.2, y: GROUND_Y },
    { x: -8.2, z: 0, y: GROUND_Y },
    { x: -8.1, z: 8.2, y: GROUND_Y },
    { x: ne.lineX, z: -5.5, y: GROUND_Y },
    { x: ne.lineX, z: -9.2, y: 3 },
    { x: ne.lineX, z: -12, y: CATWALK_Y },
    { x: ne.lineX, z: -14.5, y: CATWALK_Y },
    { x: nw.lineX, z: -5.5, y: GROUND_Y },
    { x: nw.lineX, z: -9.2, y: 3 },
    { x: nw.lineX, z: -12, y: CATWALK_Y },
    { x: nw.lineX, z: -14.5, y: CATWALK_Y },
    { x: seX, z: 1.55, y: GROUND_Y },
    { x: seX, z: 6.4, y: 3.2 },
    { x: seX, z: 10.3, y: CATWALK_Y },
    { x: 14.45, z: 10.3, y: CATWALK_Y },
    { x: swX, z: 1.55, y: GROUND_Y },
    { x: swX, z: 6.4, y: 3.2 },
    { x: swX, z: 10.3, y: CATWALK_Y },
    { x: -14.45, z: 10.3, y: CATWALK_Y },
    { x: 0, z: -14.6, y: CATWALK_Y },
    { x: 14.45, z: -14.6, y: CATWALK_Y },
    { x: 14.45, z: -10, y: CATWALK_Y },
    { x: 14.45, z: 0, y: CATWALK_Y },
    { x: 14.45, z: 6, y: CATWALK_Y },
    { x: 14.45, z: 14.6, y: CATWALK_Y },
    { x: 0, z: 14.6, y: CATWALK_Y },
    { x: -14.5, z: 14.6, y: CATWALK_Y },
    { x: -14.5, z: 6, y: CATWALK_Y },
    { x: -14.5, z: 0, y: CATWALK_Y },
    { x: -14.5, z: -8, y: CATWALK_Y },
    { x: -14.5, z: -14.6, y: CATWALK_Y },
  ];
  return { nodes };
}

function linkNav(nodes: readonly NavNode[]): number[][] {
  const edges = nodes.map(() => [] as number[]);
  const pairs = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 0],
    [1, 16],
    [2, 16],
    [3, 8],
    [5, 12],
    [6, 20],
    [7, 20],
    [8, 9],
    [9, 10],
    [10, 11],
    [12, 13],
    [13, 14],
    [14, 15],
    [16, 17],
    [17, 18],
    [18, 19],
    [20, 21],
    [21, 22],
    [22, 23],
    [24, 11],
    [11, 25],
    [25, 26],
    [26, 27],
    [27, 28],
    [28, 19],
    [19, 29],
    [29, 30],
    [30, 31],
    [31, 32],
    [32, 23],
    [23, 33],
    [33, 34],
    [34, 35],
    [35, 15],
    [15, 24],
  ];
  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i]!;
    edges[pair[0]!]!.push(pair[1]!);
    edges[pair[1]!]!.push(pair[0]!);
  }
  return edges;
}

const SPAWNS: readonly NavNode[] = [
  { x: 0, z: -7.2, y: GROUND_Y },
  { x: 8.1, z: -7.2, y: GROUND_Y },
  { x: -8.1, z: -7.2, y: GROUND_Y },
  { x: 8.2, z: 0, y: GROUND_Y },
  { x: -8.2, z: 0, y: GROUND_Y },
  { x: 8.1, z: 8.2, y: GROUND_Y },
  { x: -8.1, z: 8.2, y: GROUND_Y },
  { x: 0, z: -14.6, y: CATWALK_Y },
  { x: 0, z: 14.6, y: CATWALK_Y },
  { x: 14.45, z: 0, y: CATWALK_Y },
  { x: -14.5, z: 0, y: CATWALK_Y },
  { x: 14.45, z: -10, y: CATWALK_Y },
  { x: -14.5, z: 8, y: CATWALK_Y },
  { x: 14.45, z: 14.6, y: CATWALK_Y },
  { x: -14.5, z: -14.6, y: CATWALK_Y },
  { x: 8.9, z: -14.5, y: CATWALK_Y },
  { x: -8.9, z: -14.5, y: CATWALK_Y },
];

function planSpawns(feet: Vec3, hull: Hull, count: number): Vec3[] {
  if (count === 0) return [];
  const ranked: { x: number; y: number; z: number; d: number; i: number }[] = [];
  for (let i = 0; i < SPAWNS.length; i += 1) {
    const seed = SPAWNS[i]!;
    const point = legalSpawn(seed.x, seed.z, seed.y, feet, hull);
    if (!point) continue;
    ranked.push({
      x: point.x,
      y: point.y,
      z: point.z,
      d: Math.hypot(point.x - feet.x, point.y - feet.y, point.z - feet.z),
      i,
    });
  }
  ranked.sort((a, b) => b.d - a.d || a.i - b.i);
  const found: Vec3[] = [];
  for (let i = 0; i < ranked.length; i += 1) {
    const point = ranked[i]!;
    let spaced = true;
    for (let j = 0; j < found.length; j += 1) {
      const other = found[j]!;
      if (Math.hypot(other.x - point.x, other.z - point.z) < 6) spaced = false;
    }
    if (!spaced) continue;
    found.push({ x: point.x, y: point.y, z: point.z });
    if (found.length === count) return found;
  }
  throw new Error(`UNIT-7 could not find ${count} clear spawns`);
}

function legalSpawn(x: number, z: number, y: number, feet: Vec3, hull: Hull): Vec3 | null {
  if (Math.abs(x) > MAP_HALF - 1 || Math.abs(z) > MAP_HALF - 1) return null;
  if (Math.abs(x) < WELL_HALF + 0.3 && Math.abs(z) < WELL_HALF + 0.3) return null;
  const floor = floorY(x, y + 1.6, z, hull);
  if (Math.abs(floor - y) > 0.35) return null;
  const point = { x, y: floor, z };
  if (!enforcerInsideVolume(point)) return null;
  if (!capsuleClear(point, hull)) return null;
  const apart = Math.hypot(point.x - feet.x, point.y - feet.y, point.z - feet.z);
  if (apart < ENFORCER_SEPARATION) return null;
  return point;
}

function makeUnit(
  index: number,
  hitboxes: HitboxWorld,
  onHit: (unit: Unit, amount: number) => void,
): Unit {
  const body = createMoveState({ x: 0, y: -20, z: 0 });
  const chest: Vec3 = { x: 0, y: -20, z: 0 };
  const unit: Unit = {
    index,
    alive: false,
    hp: 0,
    armor: 0,
    position: body.position,
    yaw: 0,
    sidestep: 0,
    grace: 0,
    hitFlash: 0,
    down: -1,
    body,
    chest,
    side: 1,
    cooldown: 0,
    seen: false,
    lastSeen: { x: 0, y: 0, z: 0 },
    hurtCount: 0,
    hurtTime: new Float64Array(HURT_SLOTS),
    hurtAmount: new Float64Array(HURT_SLOTS),
    path: [],
    pathCursor: 0,
    pathEnd: -1,
    anchorX: 0,
    anchorZ: 0,
    stuck: 0,
    handle: null as unknown as HitboxHandle,
  };
  unit.handle = hitboxes.register({
    center: chest,
    radius: ENFORCER_RADIUS,
    onHit(amount: number) {
      onHit(unit, amount);
    },
  });
  unit.handle.setActive(false);
  return unit;
}

function activate(unit: Unit, point: Vec3, face: Vec3, grace: number): void {
  unit.alive = true;
  unit.hp = ENFORCER_HP;
  unit.armor = ENFORCER_ARMOR;
  unit.body.position.x = point.x;
  unit.body.position.y = point.y;
  unit.body.position.z = point.z;
  unit.body.velocity.x = 0;
  unit.body.velocity.y = 0;
  unit.body.velocity.z = 0;
  unit.body.grounded = true;
  unit.body.timeOnGround = 1;
  unit.grace = grace;
  unit.hitFlash = 0;
  unit.sidestep = 0;
  unit.side = 1;
  unit.cooldown = 0;
  unit.down = -1;
  unit.seen = false;
  unit.lastSeen.x = face.x;
  unit.lastSeen.y = face.y;
  unit.lastSeen.z = face.z;
  unit.hurtCount = 0;
  unit.path.length = 0;
  unit.pathCursor = 0;
  unit.pathEnd = -1;
  unit.anchorX = point.x;
  unit.anchorZ = point.z;
  unit.stuck = 0;
  const dx = face.x - point.x;
  const dz = face.z - point.z;
  if (Math.hypot(dx, dz) > 0.2) unit.yaw = Math.atan2(-dx, -dz);
  syncChest(unit);
  unit.handle.setActive(true);
}

function deactivate(unit: Unit): void {
  unit.alive = false;
  unit.hp = 0;
  unit.armor = 0;
  unit.hitFlash = 0;
  unit.down = -1;
  unit.sidestep = 0;
  unit.handle.setActive(false);
}

function syncChest(unit: Unit): void {
  unit.chest.x = unit.position.x;
  unit.chest.y = unit.position.y + ENFORCER_CHEST;
  unit.chest.z = unit.position.z;
}

function copyMove(body: MoveState, next: MoveState): void {
  body.position.x = next.position.x;
  body.position.y = next.position.y;
  body.position.z = next.position.z;
  body.velocity.x = next.velocity.x;
  body.velocity.y = next.velocity.y;
  body.velocity.z = next.velocity.z;
  body.grounded = next.grounded;
  body.timeOnGround = next.timeOnGround;
}

function takeSpark(pool: EnforcerSpark[]): EnforcerSpark {
  let oldest: EnforcerSpark | null = null;
  for (let i = 0; i < pool.length; i += 1) {
    const slot = pool[i]!;
    if (!slot.alive) return slot;
    if (!oldest || slot.age > oldest.age) oldest = slot;
  }
  return oldest ?? pool[0]!;
}

function makeSparks(count: number): EnforcerSpark[] {
  const pool: EnforcerSpark[] = [];
  for (let i = 0; i < count; i += 1) {
    pool.push({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 0 });
  }
  return pool;
}

function makeFlashes(count: number): EnforcerFlash[] {
  const pool: EnforcerFlash[] = [];
  for (let i = 0; i < count; i += 1) {
    pool.push({ alive: false, age: 0, life: 0, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1, length: 1 });
  }
  return pool;
}

function takeFlash(pool: EnforcerFlash[]): EnforcerFlash {
  let oldest: EnforcerFlash | null = null;
  for (let i = 0; i < pool.length; i += 1) {
    const slot = pool[i]!;
    if (!slot.alive) return slot;
    if (!oldest || slot.age > oldest.age) oldest = slot;
  }
  return oldest ?? pool[0]!;
}

function stepFlashes(pool: EnforcerFlash[], dt: number): void {
  for (let i = 0; i < pool.length; i += 1) {
    const slot = pool[i]!;
    if (!slot.alive) continue;
    slot.age += dt;
    if (slot.age >= slot.life) slot.alive = false;
  }
}

function stepSparks(pool: EnforcerSpark[], dt: number): void {
  for (let i = 0; i < pool.length; i += 1) {
    const slot = pool[i]!;
    if (!slot.alive) continue;
    slot.vy -= 8 * dt;
    slot.x += slot.vx * dt;
    slot.y += slot.vy * dt;
    slot.z += slot.vz * dt;
    slot.age += dt;
    if (slot.age >= slot.life || slot.y < -1 || Math.abs(slot.x) > MAP_HALF || Math.abs(slot.z) > MAP_HALF) {
      slot.alive = false;
    }
  }
}
