// Cyber-Ganger Rusher. A fictional street-gang flanker, not a person.
//
// 35 HP, no armor. It stays on the ground, walks at 6.4 m/s, and climbs the
// same ramps and stairs as the enforcer. Inside 2.2 m it holds for a 0.40 s
// windup, then lunges for 12 melee damage. The windup is the tell: the view
// flashes the body and a procedural cue plays once. The 1.4 s cooldown starts
// when the lunge resolves. Only one rusher in the fight may be winding up or
// lunging, and a different rusher's lunge waits 0.5 s after the previous one
// ends. Strafing out of the 2.2 m reach during the windup makes the lunge miss.
// Spawn grace is 2 s: it may close, and it does not swing.
//
// Death uses the same fictional blood, gibs, and decals as the enforcer.
// The player, the pads, and the props do not gib.

import { clearNavMemory, createAtriumNav, navFloorY, navWaypoint } from "./atrium-nav.ts";
import {
  CATWALK_Y,
  CEILING_Y,
  GROUND_Y,
  MAP_HALF,
  WELL_HALF,
  capsuleClear,
  inJumpSlot,
} from "./atrium.ts";
import type { CueListener } from "./cues.ts";
import { HIT_FLASH_SECONDS } from "./feel.ts";
import { createBloodGore, type GoreDecal, type GorePart } from "./gore.ts";
import type { HitboxHandle, HitboxWorld } from "./hitbox.ts";
import { playerHitboxes } from "./hitbox.ts";
import {
  CAPSULE_HEIGHT,
  CAPSULE_RADIUS,
  SIM_DT,
  createMoveState,
  stepMovement,
  type Hull,
  type MoveState,
  type Vec3,
} from "./move.ts";
import { applyDamage } from "./pickups.ts";
import { damagePlayer } from "./player/hurt.ts";
import type { PlayerStore } from "./player/state.ts";
import { traceSegment, type TraceHit } from "./trace.ts";
import { RUSHER_CAP, type WaveDirector } from "./waves.ts";

export const RUSHER_HP = 35;
export const RUSHER_ARMOR = 0;
export const RUSHER_SPEED = 6.4;
export const RUSHER_RANGE = 2.2;
export const RUSHER_DAMAGE = 12;
/** Starts when the lunge resolves, not when it begins. */
export const RUSHER_COOLDOWN = 1.4;
/** Windup. The body flashes and one cue plays; the dash has not started. */
export const RUSHER_TELEGRAPH = 0.4;
/**
 * Quiet between lunges of different rushers. Measured from the end of one
 * dash to the start of the next. Windup and the dash itself stay exclusive.
 */
export const RUSHER_LUNGE_GAP = 0.5;
/** The dash itself. Damage lands on the first slice, then the trail follows. */
export const RUSHER_LUNGE = 0.18;
export const RUSHER_LUNGE_SPEED = 9.2;
/** Quiet start on wave 2 and later. Wave 1 fields none. */
export const RUSHER_GRACE = 2;
export const RUSHER_SEPARATION = 8;
export const RUSHER_CHEST = 0.9;
export const RUSHER_RADIUS = 0.36;
export const RUSHER_TRAIL_CAP = 16;

export type RusherPhase = "hunt" | "telegraph" | "lunge" | "recover";

export interface RusherTrail {
  alive: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  age: number;
  life: number;
}

export interface RusherUnit {
  readonly index: number;
  alive: boolean;
  hp: number;
  armor: number;
  readonly position: Vec3;
  yaw: number;
  grace: number;
  hitFlash: number;
  /** Collapse timer. Negative hides a corpse; 0 starts the fall. */
  down: number;
  phase: RusherPhase;
  /** Seconds already spent in `phase`. */
  swing: number;
}

export interface RusherSnapshot {
  alive: number;
  lunges: number;
  units: { x: number; y: number; z: number; alive: boolean; hp: number; phase: RusherPhase }[];
}

export interface RusherSim {
  readonly units: readonly RusherUnit[];
  readonly trails: readonly RusherTrail[];
  readonly spray: readonly GorePart[];
  readonly gibs: readonly GorePart[];
  readonly decals: readonly GoreDecal[];
  readonly goreBursts: number;
  readonly time: number;
  update(dt: number, feet: Vec3): void;
  aliveCount(): number;
  hurt(index: number, amount: number): void;
  tickFlash(dt: number): void;
  killAlive(): void;
  spawnCount(count: number, feet: Vec3, occupied?: readonly Vec3[]): void;
  place(index: number, feet: Vec3): void;
  /** Dev capture. Holds one rusher mid-lunge so a frame can see the blade trail. */
  poseLunge(at: Vec3, yaw: number): void;
  /** Dev capture. Holds one rusher at the bright point of the windup tell. */
  poseWindup(at: Vec3, yaw: number): void;
  /** Dev capture. Drops a posed rusher so the next pose has an empty foreground. */
  clearShowcase(): void;
  lungeCount(): number;
  lungeTime(index: number): number;
  snapshot(): RusherSnapshot;
}

export interface RusherOptions {
  hull: Hull;
  player: PlayerStore;
  hitboxes?: HitboxWorld;
  director?: WaveDirector;
  onCleared?: () => void;
  /** Override the 2 s spawn grace. Melee tests pass 0. */
  grace?: number;
  onEvent?: CueListener;
}

interface Unit extends RusherUnit {
  body: MoveState;
  chest: Vec3;
  seen: boolean;
  lastSeen: Vec3;
  path: number[];
  pathCursor: number;
  pathEnd: number;
  anchorX: number;
  anchorZ: number;
  stuck: number;
  /** Dev showcase. The sim leaves this unit where poseLunge put it. */
  held: boolean;
  /** The current lunge has already dealt its damage. */
  struck: boolean;
  trailMark: number;
  handle: HitboxHandle;
}

const LUNGE_RECORD = 32;
const TRAIL_LIFE = 0.22;

const scratchHit: TraceHit = {
  t: 0,
  distance: 0,
  point: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 0 },
};
const shotTo: Vec3 = { x: 0, y: 0, z: 0 };
const shotFrom: Vec3 = { x: 0, y: 0, z: 0 };
const steerIntent = { forward: 0, strafe: 0, jump: false as const, yawDeg: 0, wishSpeed: 0 };

export function rusherInsideVolume(feet: Vec3): boolean {
  return (
    Math.abs(feet.x) + CAPSULE_RADIUS <= MAP_HALF + 0.08 &&
    Math.abs(feet.z) + CAPSULE_RADIUS <= MAP_HALF + 0.08 &&
    feet.y >= -0.05 &&
    feet.y + CAPSULE_HEIGHT <= CEILING_Y + 0.08
  );
}

export function createRusherSim(options: RusherOptions): RusherSim {
  const hull = options.hull;
  const player = options.player;
  const hitboxes = options.hitboxes ?? playerHitboxes;
  const director = options.director;
  const graceTime = options.grace ?? RUSHER_GRACE;
  const nav = createAtriumNav();

  const units: Unit[] = [];
  for (let i = 0; i < RUSHER_CAP; i += 1) {
    units.push(makeUnit(i, hitboxes, (unit, amount) => applyHit(unit, amount)));
  }
  const trails = makeTrails(RUSHER_TRAIL_CAP);
  const gore = createBloodGore();
  const lungeTimes = new Float64Array(LUNGE_RECORD);
  let time = 0;
  let lunges = 0;
  /** Index of the rusher in windup or mid-lunge. -1 when the token is free. */
  let token = -1;
  /** Earliest sim time a lunge dash may begin. */
  let lungeGate = 0;

  function releaseToken(unit: Unit): void {
    if (token === unit.index) token = -1;
  }

  function claimWindup(unit: Unit): boolean {
    if (token !== -1) return false;
    if (time + RUSHER_TELEGRAPH < lungeGate - 1e-8) return false;
    token = unit.index;
    return true;
  }

  function applyHit(unit: Unit, amount: number): void {
    if (!unit.alive || !Number.isFinite(amount) || amount <= 0) return;
    const next = applyDamage(amount, unit.hp, unit.armor);
    unit.hp = next.hp;
    unit.armor = next.armor;
    unit.hitFlash = HIT_FLASH_SECONDS;
    if (unit.hp > 0) {
      options.onEvent?.({ type: "enemy-hit" });
      return;
    }
    unit.hp = 0;
    unit.alive = false;
    unit.down = 0;
    unit.phase = "hunt";
    unit.swing = 0;
    unit.held = false;
    releaseToken(unit);
    unit.handle.setActive(false);
    options.onEvent?.({ type: "enemy-kill" });
    gore.burst(unit.position, hull);
    director?.noteFrag();
    if (aliveCount() === 0) options.onCleared?.();
  }

  function aliveCount(): number {
    let count = 0;
    for (let i = 0; i < units.length; i += 1) if (units[i]!.alive) count += 1;
    return count;
  }

  function spawnCount(count: number, feet: Vec3, occupied?: readonly Vec3[]): void {
    token = -1;
    lungeGate = 0;
    const wanted = Math.max(0, Math.min(RUSHER_CAP, Math.floor(count)));
    const points = planSpawns(feet, hull, wanted, occupied ?? []);
    for (let i = 0; i < units.length; i += 1) deactivate(units[i]!);
    for (let i = 0; i < trails.length; i += 1) trails[i]!.alive = false;
    gore.reset();
    for (let i = 0; i < wanted; i += 1) activate(units[i]!, points[i]!, feet, graceTime);
  }

  function place(index: number, feet: Vec3): void {
    const unit = units[index];
    if (!unit) return;
    releaseToken(unit);
    activate(unit, feet, feet, graceTime);
  }

  function poseLunge(at: Vec3, yaw: number): void {
    token = -1;
    const unit = units[0]!;
    activate(unit, at, at, 0);
    unit.yaw = yaw;
    unit.phase = "lunge";
    unit.swing = 0.04;
    unit.struck = true;
    unit.held = true;
    unit.grace = 0;
    for (let i = 0; i < trails.length; i += 1) trails[i]!.alive = false;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    for (let i = 0; i < 5; i += 1) {
      const slot = trails[i]!;
      slot.alive = true;
      slot.age = i * 0.03;
      slot.life = 2;
      slot.yaw = yaw;
      slot.x = at.x - fx * (0.35 + i * 0.28);
      slot.y = at.y + 0.95;
      slot.z = at.z - fz * (0.35 + i * 0.28);
    }
    syncChest(unit);
  }

  function poseWindup(at: Vec3, yaw: number): void {
    token = -1;
    const unit = units[0]!;
    activate(unit, at, at, 0);
    unit.yaw = yaw;
    unit.phase = "telegraph";
    unit.swing = 0;
    unit.struck = false;
    unit.held = true;
    unit.grace = 0;
    for (let i = 0; i < trails.length; i += 1) trails[i]!.alive = false;
    syncChest(unit);
  }

  function clearShowcase(): void {
    token = -1;
    for (let i = 0; i < units.length; i += 1) {
      const unit = units[i]!;
      if (!unit.held) continue;
      deactivate(unit);
    }
    for (let i = 0; i < trails.length; i += 1) trails[i]!.alive = false;
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
    let showcasing = false;
    for (let i = 0; i < units.length; i += 1) {
      const unit = units[i]!;
      if (unit.held) {
        showcasing = true;
        syncChest(unit);
        continue;
      }
      if (!unit.alive) {
        if (unit.down >= 0) unit.down += dt;
        continue;
      }
      if (unit.grace > 0) unit.grace -= dt;
      remember(unit, feet, hull);
      const intent = steerUnit(unit, hull, feet);
      const next = stepMovement(unit.body, intent, dt, hull);
      if (inJumpSlot(next.position.x, next.position.z) && !inJumpSlot(unit.body.position.x, unit.body.position.z)) {
        next.position.x = unit.body.position.x;
        next.position.y = unit.body.position.y;
        next.position.z = unit.body.position.z;
        next.velocity.x = 0;
        next.velocity.z = 0;
      }
      copyMove(unit.body, next);
      syncChest(unit);
      advanceSwing(unit, dt, feet, hull);
    }
    if (!showcasing) stepTrails(trails, dt);
    gore.step(dt);
  }

  function advanceSwing(unit: Unit, dt: number, feet: Vec3, world: Hull): void {
    if (unit.grace > 0) {
      releaseToken(unit);
      unit.phase = "hunt";
      unit.swing = 0;
      return;
    }
    const dist = gap(unit, feet);
    if (unit.phase === "hunt") {
      if (dist <= RUSHER_RANGE && lineClear(unit, feet, world) && claimWindup(unit)) {
        unit.phase = "telegraph";
        unit.swing = 0;
        unit.body.velocity.x = 0;
        unit.body.velocity.z = 0;
        options.onEvent?.({ type: "rusher-windup" });
      }
      return;
    }
    unit.swing += dt;
    if (unit.phase === "telegraph") {
      if (unit.swing + 1e-8 < RUSHER_TELEGRAPH) return;
      unit.phase = "lunge";
      unit.swing = 0;
      unit.struck = false;
      unit.trailMark = -1;
      lungeGate = time + RUSHER_LUNGE + RUSHER_LUNGE_GAP;
    }
    if (unit.phase === "lunge") {
      // One check, on the frame the windup resolves. Leaving the 2.2 m reach
      // during the windup is a miss, and the dash does not strike again.
      if (!unit.struck) {
        unit.struck = true;
        if (gap(unit, feet) <= RUSHER_RANGE && lineClear(unit, feet, world)) connect(unit);
      }
      const mark = Math.floor(unit.swing / 0.03);
      if (mark !== unit.trailMark) {
        unit.trailMark = mark;
        emitTrail(trails, unit);
      }
      if (unit.swing + 1e-8 < RUSHER_LUNGE) return;
      unit.phase = "recover";
      unit.swing = 0;
      releaseToken(unit);
      return;
    }
    if (unit.swing + 1e-8 >= RUSHER_COOLDOWN) {
      unit.phase = "hunt";
      unit.swing = 0;
    }
  }

  function connect(unit: Unit): void {
    const beforeHp = player.get().hp;
    const beforeArmor = player.get().armor;
    shotFrom.x = unit.position.x;
    shotFrom.y = unit.position.y + RUSHER_CHEST;
    shotFrom.z = unit.position.z;
    damagePlayer(player, RUSHER_DAMAGE, shotFrom);
    if (player.get().hp === beforeHp && player.get().armor === beforeArmor) return;
    if (lunges < LUNGE_RECORD) lungeTimes[lunges] = time;
    lunges += 1;
  }

  function steerUnit(unit: Unit, world: Hull, feet: Vec3) {
    const goal = unit.lastSeen;
    const pos = unit.position;
    const aim = navWaypoint(pos, goal, unit, world, nav);
    let faceX = aim.x - pos.x;
    let faceZ = aim.z - pos.z;
    let forward = 1;
    let wish = RUSHER_SPEED;
    if (unit.phase === "telegraph" || unit.phase === "recover") {
      forward = 0;
      faceX = feet.x - pos.x;
      faceZ = feet.z - pos.z;
    } else if (unit.phase === "lunge") {
      forward = 1;
      wish = RUSHER_LUNGE_SPEED;
      faceX = feet.x - pos.x;
      faceZ = feet.z - pos.z;
    }
    if (Math.hypot(faceX, faceZ) < 1e-4) {
      faceX = -Math.sin(unit.yaw);
      faceZ = -Math.cos(unit.yaw);
    }
    unit.yaw = Math.atan2(-faceX, -faceZ);
    steerIntent.forward = forward;
    steerIntent.strafe = 0;
    steerIntent.jump = false;
    steerIntent.yawDeg = (unit.yaw * 180) / Math.PI;
    steerIntent.wishSpeed = wish;
    return steerIntent;
  }

  function snapshot(): RusherSnapshot {
    const view: RusherSnapshot["units"] = [];
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
        phase: unit.phase,
      });
    }
    return { alive, lunges, units: view };
  }

  return {
    units,
    trails,
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
        applyHit(unit, unit.hp > 0 ? unit.hp : RUSHER_HP);
      }
    },
    spawnCount,
    place,
    poseLunge,
    poseWindup,
    clearShowcase,
    lungeCount(): number {
      return lunges;
    },
    lungeTime(index: number): number {
      if (index < 0 || index >= lunges || index >= LUNGE_RECORD) return Number.NaN;
      return lungeTimes[index]!;
    },
    snapshot,
  };
}

function gap(unit: Unit, feet: Vec3): number {
  return Math.hypot(feet.x - unit.position.x, feet.y - unit.position.y, feet.z - unit.position.z);
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
  const ay = unit.position.y + RUSHER_CHEST;
  const az = unit.position.z;
  const bx = feet.x;
  const by = feet.y + RUSHER_CHEST;
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
  return !hit || hit.distance >= dist - 0.35;
}

function emitTrail(pool: RusherTrail[], unit: Unit): void {
  const slot = takeTrail(pool);
  const fx = -Math.sin(unit.yaw);
  const fz = -Math.cos(unit.yaw);
  slot.alive = true;
  slot.age = 0;
  slot.life = TRAIL_LIFE;
  slot.yaw = unit.yaw;
  slot.x = unit.position.x - fx * 0.42;
  slot.y = unit.position.y + 0.95;
  slot.z = unit.position.z - fz * 0.42;
}

function stepTrails(pool: RusherTrail[], dt: number): void {
  for (let i = 0; i < pool.length; i += 1) {
    const slot = pool[i]!;
    if (!slot.alive) continue;
    slot.age += dt;
    if (slot.age >= slot.life) slot.alive = false;
  }
}

const SPAWNS: readonly { x: number; z: number; y: number }[] = [
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

function planSpawns(feet: Vec3, hull: Hull, count: number, occupied: readonly Vec3[]): Vec3[] {
  if (count === 0) return [];
  const ranked: { x: number; y: number; z: number; d: number; i: number }[] = [];
  for (let i = 0; i < SPAWNS.length; i += 1) {
    const seed = SPAWNS[i]!;
    const point = legalSpawn(seed.x, seed.z, seed.y, feet, hull, occupied);
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
  throw new Error(`Cyber-Ganger could not find ${count} clear spawns`);
}

function legalSpawn(
  x: number,
  z: number,
  y: number,
  feet: Vec3,
  hull: Hull,
  occupied: readonly Vec3[],
): Vec3 | null {
  if (Math.abs(x) > MAP_HALF - 1 || Math.abs(z) > MAP_HALF - 1) return null;
  if (Math.abs(x) < WELL_HALF + 0.3 && Math.abs(z) < WELL_HALF + 0.3) return null;
  const floor = navFloorY(x, y + 1.6, z, hull);
  if (Math.abs(floor - y) > 0.35) return null;
  const point = { x, y: floor, z };
  if (!rusherInsideVolume(point)) return null;
  if (!capsuleClear(point, hull)) return null;
  const apart = Math.hypot(point.x - feet.x, point.y - feet.y, point.z - feet.z);
  if (apart < RUSHER_SEPARATION) return null;
  for (let i = 0; i < occupied.length; i += 1) {
    const other = occupied[i]!;
    if (Math.hypot(other.x - point.x, other.z - point.z) < 3.2) return null;
  }
  return point;
}

function makeUnit(index: number, hitboxes: HitboxWorld, onHit: (unit: Unit, amount: number) => void): Unit {
  const body = createMoveState({ x: 0, y: -20, z: 0 });
  const chest: Vec3 = { x: 0, y: -20, z: 0 };
  const unit: Unit = {
    index,
    alive: false,
    hp: 0,
    armor: 0,
    position: body.position,
    yaw: 0,
    grace: 0,
    hitFlash: 0,
    down: -1,
    phase: "hunt",
    swing: 0,
    body,
    chest,
    seen: false,
    lastSeen: { x: 0, y: 0, z: 0 },
    path: [],
    pathCursor: 0,
    pathEnd: -1,
    anchorX: 0,
    anchorZ: 0,
    stuck: 0,
    held: false,
    struck: false,
    trailMark: -1,
    handle: null as unknown as HitboxHandle,
  };
  unit.handle = hitboxes.register({
    center: chest,
    radius: RUSHER_RADIUS,
    onHit(amount: number) {
      onHit(unit, amount);
    },
  });
  unit.handle.setActive(false);
  return unit;
}

function activate(unit: Unit, point: Vec3, face: Vec3, grace: number): void {
  unit.alive = true;
  unit.hp = RUSHER_HP;
  unit.armor = RUSHER_ARMOR;
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
  unit.down = -1;
  unit.phase = "hunt";
  unit.swing = 0;
  unit.held = false;
  unit.struck = false;
  unit.trailMark = -1;
  unit.seen = false;
  unit.lastSeen.x = face.x;
  unit.lastSeen.y = face.y;
  unit.lastSeen.z = face.z;
  clearNavMemory(unit, point.x, point.z);
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
  unit.phase = "hunt";
  unit.swing = 0;
  unit.held = false;
  unit.handle.setActive(false);
}

function syncChest(unit: Unit): void {
  unit.chest.x = unit.position.x;
  unit.chest.y = unit.position.y + RUSHER_CHEST;
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

function makeTrails(count: number): RusherTrail[] {
  const pool: RusherTrail[] = [];
  for (let i = 0; i < count; i += 1) {
    pool.push({ alive: false, x: 0, y: 0, z: 0, yaw: 0, age: 0, life: 0 });
  }
  return pool;
}

function takeTrail(pool: RusherTrail[]): RusherTrail {
  let oldest: RusherTrail | null = null;
  for (let i = 0; i < pool.length; i += 1) {
    const slot = pool[i]!;
    if (!slot.alive) return slot;
    if (!oldest || slot.age > oldest.age) oldest = slot;
  }
  return oldest ?? pool[0]!;
}
