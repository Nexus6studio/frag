// WISP-4, the rogue security drone. The only enemy in the early release.
//
// Wave 1 spawns two of them, already hostile. Later waves reuse this same
// pool, up to four alive. Each hovers at 5.5 m/s,
// strafe-orbits at 8–14 m, and holds 1.2–2.4 m above the deck under it.
// Inside 6 m it takes the high end of that band. A player up on a catwalk
// makes it climb clear of the parapet and then drop to the low band to peek.
// It does not look for cover.
//
// The gun is a two-bolt plasma burst. Bolts are 0.15 s apart. The next burst's
// first bolt is 1.8 s after the second bolt. The last 0.3 s of that gap is the
// glow telegraph, so every burst is announced at least 0.25 s ahead. Bolts die
// on the atrium hull. Flechettes are the only thing that damages a drone, and
// they arrive through the shared hitbox list, not a hitscan ray.
//
// Death is sparks, small metal and plastic scraps, and dark hydraulic fluid.
// Those particles, and the bolts, are fixed pools.

import { CEILING_Y, KILL_Y, MAP_HALF, PARAPET_Y } from "./atrium.ts";
import type { HitboxHandle, HitboxWorld } from "./hitbox.ts";
import { playerHitboxes } from "./hitbox.ts";
import { CAPSULE_HEIGHT, CAPSULE_RADIUS, EYE_HEIGHT, type BoxSolid, type Hull, type RampSolid, type Vec3 } from "./move.ts";
import { damagePlayer } from "./player/hurt.ts";
import type { PlayerStore } from "./player/state.ts";
import { traceRay, traceSegment, type TraceHit } from "./trace.ts";
import {
  DRONE_CAP,
  createWaveDirector,
  type DeathRecap,
  type WavePhase,
} from "./waves.ts";

export const WISP_HP = 40;
export const WISP_ARMOR = 0;
export const WISP_SPEED = 5.5;
export const WISP_ALTITUDE_MIN = 1.2;
export const WISP_ALTITUDE_MAX = 2.4;
export const WISP_CLOSE = 6;
export const WISP_RANGE_MIN = 8;
export const WISP_RANGE_MAX = 14;
export const WISP_RADIUS = 0.46;
export const WISP_COUNT = 2;
export const WISP_SEPARATION = 8;

export const WISP_BOLT_SPEED = 18;
export const WISP_BOLT_RADIUS = 0.25;
export const WISP_BOLT_DAMAGE = 8;
export const WISP_BOLT_GAP = 0.15;
export const WISP_BURST_GAP = 1.8;
export const WISP_TELEGRAPH = 0.3;
/** Quiet gap after the second bolt. The telegraph fills the rest of the burst gap. */
export const WISP_RECOVER = WISP_BURST_GAP - WISP_TELEGRAPH;
export const WISP_BOLT_LIFE = 3;
export const WISP_BOLT_CAP = 8;

export const WISP_SPARK_CAP = 16;
export const WISP_GIB_CAP = 8;
export const WISP_FLUID_CAP = 10;
export const WISP_SPARKS_PER_DEATH = 8;
export const WISP_GIBS_PER_DEATH = 4;
export const WISP_FLUID_PER_DEATH = 5;

/** Dark hydraulic oil. Not red. */
export const WISP_FLUID_COLOR = 0x14110e;
export const WISP_GIB_METAL = 0x8d97a3;
export const WISP_GIB_PLASTIC = 0x2c3544;
export const WISP_VISOR_AGGRO = 0xff2a2a;
export const WISP_VISOR_IDLE = 0x35e4ff;

const RECORD = 24;
const SLOP = 0.02;
const VOLUME_PAD = 0.02;

export type WispPhase = "grace" | "telegraph" | "intra" | "recover";

/** Drones do not fire for this long after a spawn, a restart, or a new wave. */
export const WISP_SPAWN_GRACE = 2;

export interface WispDrone {
  readonly index: number;
  alive: boolean;
  hp: number;
  readonly aggro: boolean;
  readonly orbit: number;
  readonly position: Vec3;
  phase: WispPhase;
  timer: number;
  yaw: number;
}

export interface WispBolt {
  alive: boolean;
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  age: number;
  serial: number;
  /** Set when this bolt has applied its one hit. Later overlaps do nothing. */
  hit: boolean;
}

export interface WispParticle {
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
  /** Gibs alternate metal and plastic. Sparks and fluid ignore this. */
  metal: boolean;
}

export interface WispSnapshot {
  count: number;
  bolts: number;
  drones: { x: number; y: number; z: number; alive: boolean; hp: number; aggro: boolean }[];
  wave: number;
  wavesCleared: number;
  frags: number;
  timeAlive: number;
  phase: WavePhase;
  enforcers: number;
  /** Seconds since spawn. Stays 0 until the sim is stepped, so a warning or pause does not burn grace. */
  time: number;
  fired: number;
  hits: number;
  damageEvents: number;
  /** Sim time of the first bolt, or null when none has fired. */
  firstBolt: number | null;
}

export interface WispSim {
  readonly drones: readonly WispDrone[];
  readonly bolts: readonly WispBolt[];
  readonly sparks: readonly WispParticle[];
  readonly gibs: readonly WispParticle[];
  readonly fluid: readonly WispParticle[];
  readonly time: number;
  readonly focus: Vec3;
  readonly wave: number;
  readonly wavesCleared: number;
  readonly frags: number;
  readonly timeAlive: number;
  readonly phase: WavePhase;
  readonly enforcers: number;
  update(dt: number, feet: Vec3): void;
  aliveCount(): number;
  hurt(index: number, amount: number): void;
  killAlive(): void;
  restart(origin: Vec3): void;
  recap(): DeathRecap;
  boltCount(drone: number): number;
  boltTime(drone: number, index: number): number;
  telegraphCount(drone: number): number;
  telegraphTime(drone: number, index: number): number;
  snapshot(): WispSnapshot;
}

export interface WispOptions {
  hull: Hull;
  player: PlayerStore;
  hitboxes?: HitboxWorld;
  origin?: Vec3;
  /** Defaults to ENFORCER_ENABLED. The count is recorded; no enforcer is built. */
  enforcersEnabled?: boolean;
}

interface Drone extends WispDrone {
  handle: HitboxHandle;
}

const scratchHit: TraceHit = {
  t: 0,
  distance: 0,
  point: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 0 },
};
const downFrom: Vec3 = { x: 0, y: 0, z: 0 };
const downDir: Vec3 = { x: 0, y: -1, z: 0 };
const boltFrom: Vec3 = { x: 0, y: 0, z: 0 };
const boltTo: Vec3 = { x: 0, y: 0, z: 0 };
const capA: Vec3 = { x: 0, y: 0, z: 0 };
const capB: Vec3 = { x: 0, y: 0, z: 0 };

const SPARK_DIR: readonly (readonly [number, number, number])[] = [
  [0.9, 0.55, 0.15],
  [-0.8, 0.7, 0.25],
  [0.2, 0.95, -0.45],
  [-0.35, 0.45, 0.9],
  [0.65, 0.3, -0.75],
  [-0.95, 0.4, -0.2],
  [0.15, 0.8, 0.7],
  [-0.55, 0.6, -0.7],
];

const GIB_DIR: readonly (readonly [number, number, number])[] = [
  [0.7, 0.55, 0.2],
  [-0.45, 0.7, 0.55],
  [0.2, 0.4, -0.85],
  [-0.8, 0.35, -0.25],
];

const FLUID_DIR: readonly (readonly [number, number, number])[] = [
  [0.35, 0.15, 0.2],
  [-0.4, 0.2, 0.1],
  [0.1, 0.25, -0.45],
  [-0.15, 0.1, -0.3],
  [0.25, 0.05, 0.35],
];

export function wispVisorHex(aggro: boolean): number {
  return aggro ? WISP_VISOR_AGGRO : WISP_VISOR_IDLE;
}

export function wispInsideVolume(position: Vec3, radius = WISP_RADIUS): boolean {
  return (
    position.x - radius >= -MAP_HALF - 1e-3 &&
    position.x + radius <= MAP_HALF + 1e-3 &&
    position.z - radius >= -MAP_HALF - 1e-3 &&
    position.z + radius <= MAP_HALF + 1e-3 &&
    position.y - radius >= -1e-3 &&
    position.y + radius <= CEILING_Y + 1e-3
  );
}

export function wispFloorY(x: number, y: number, z: number, hull: Hull): number {
  downFrom.x = x;
  downFrom.y = Math.min(CEILING_Y - 0.05, y + 0.05);
  downFrom.z = z;
  const hit = traceRay(downFrom, downDir, 40, hull, scratchHit);
  return hit ? hit.point.y : 0;
}

export function sphereHitsHull(position: Vec3, radius: number, hull: Hull): boolean {
  const limit = radius - 1e-3;
  if (!(limit > 0)) return false;
  const boxes = hull.boxes;
  for (let i = 0; i < boxes.length; i += 1) {
    if (sphereHitsBox(position, limit, boxes[i]!)) return true;
  }
  const ramps = hull.ramps;
  for (let i = 0; i < ramps.length; i += 1) {
    if (sphereHitsRamp(position, limit, ramps[i]!)) return true;
  }
  return false;
}

export function planWispSpawns(feet: Vec3, hull: Hull, count = WISP_COUNT): Vec3[] {
  const wanted = Math.max(0, Math.min(DRONE_CAP, Math.floor(count)));
  const found: Vec3[] = [];
  if (wanted === 0) return found;
  const seeds: { x: number; z: number }[] = [
    { x: feet.x, z: feet.z - 14 },
    { x: feet.x - 10, z: feet.z - 6 },
    { x: feet.x + 10, z: feet.z - 6 },
    { x: feet.x, z: feet.z + 10 },
  ];
  for (let ring = 0; ring < 8; ring += 1) {
    const radius = 9 + ring * 1.1;
    for (let i = 0; i < 24; i += 1) {
      const angle = (i / 24) * Math.PI * 2 + ring * 0.17;
      seeds.push({ x: feet.x + Math.cos(angle) * radius, z: feet.z + Math.sin(angle) * radius });
    }
  }
  for (let i = 0; i < seeds.length; i += 1) {
    const seed = seeds[i]!;
    const point = spawnPoint(seed.x, seed.z, feet, hull);
    if (!point) continue;
    let spaced = true;
    for (let j = 0; j < found.length; j += 1) {
      const other = found[j]!;
      if (Math.hypot(other.x - point.x, other.z - point.z) < 6) spaced = false;
    }
    if (!spaced) continue;
    found.push(point);
    if (found.length === wanted) return found;
  }
  throw new Error(`WISP-4 could not find ${wanted} clear spawns`);
}

export function createWispSim(options: WispOptions): WispSim {
  const hull = options.hull;
  const player = options.player;
  const hitboxes = options.hitboxes ?? playerHitboxes;
  const origin = options.origin ?? { x: 0, y: 0, z: 0 };
  const director = createWaveDirector({ enforcersEnabled: options.enforcersEnabled });
  const parked: Vec3 = { x: 0, y: -20, z: 0 };
  const drones: Drone[] = [];
  for (let i = 0; i < DRONE_CAP; i += 1) {
    const drone = makeDrone(
      i,
      parked,
      i % 2 === 0 ? 1 : -1,
      "recover",
      hitboxes,
      (unit, amount) => applyFlechette(unit, amount),
    );
    drone.alive = false;
    drone.hp = 0;
    drone.handle.setActive(false);
    drones.push(drone);
  }
  const bolts: WispBolt[] = [];
  for (let i = 0; i < WISP_BOLT_CAP; i += 1) bolts.push(makeBolt());
  const sparks = makePool(WISP_SPARK_CAP);
  const gibs = makePool(WISP_GIB_CAP);
  const fluid = makePool(WISP_FLUID_CAP);
  const boltTimes: Float64Array[] = [];
  const telegraphTimes: Float64Array[] = [];
  const boltCounts: number[] = [];
  const telegraphCounts: number[] = [];
  for (let i = 0; i < DRONE_CAP; i += 1) {
    boltTimes.push(new Float64Array(RECORD));
    telegraphTimes.push(new Float64Array(RECORD));
    boltCounts.push(0);
    telegraphCounts.push(0);
  }
  const focus: Vec3 = { x: origin.x, y: origin.y, z: origin.z };
  let time = 0;
  let birth = 0;
  let boltsHit = 0;
  let damageEvents = 0;
  let firstBolt = Number.POSITIVE_INFINITY;

  spawnWave(origin);

  function beginTelegraph(drone: Drone, at: number): void {
    drone.phase = "telegraph";
    drone.timer = 0;
    const count = telegraphCounts[drone.index]!;
    if (count < RECORD) {
      telegraphTimes[drone.index]![count] = at;
      telegraphCounts[drone.index] = count + 1;
    }
  }

  function launch(drone: Drone, at: number): void {
    const count = boltCounts[drone.index]!;
    if (count < RECORD) {
      boltTimes[drone.index]![count] = at;
      boltCounts[drone.index] = count + 1;
    }
    const slot = takeBolt();
    if (!slot) return;
    const tx = focus.x - drone.position.x;
    const ty = focus.y + EYE_HEIGHT - drone.position.y;
    const tz = focus.z - drone.position.z;
    const len = Math.hypot(tx, ty, tz);
    if (!(len > 1e-6)) return;
    slot.alive = true;
    slot.x = drone.position.x;
    slot.y = drone.position.y;
    slot.z = drone.position.z;
    slot.dx = tx / len;
    slot.dy = ty / len;
    slot.dz = tz / len;
    slot.age = 0;
    slot.hit = false;
    slot.serial = birth + 1;
    birth += 1;
    if (at < firstBolt) firstBolt = at;
  }

  function takeBolt(): WispBolt | null {
    let oldest: WispBolt | null = null;
    for (let i = 0; i < bolts.length; i += 1) {
      const bolt = bolts[i]!;
      if (!bolt.alive) return bolt;
      if (!oldest || bolt.serial < oldest.serial) oldest = bolt;
    }
    return oldest;
  }

  function finishPhase(drone: Drone, at: number): void {
    if (!drone.alive) return;
    if (drone.phase === "grace") {
      // The lead starts the telegraph. The others wait out a recover first,
      // so the two guns do not fire on the same tick.
      if (drone.index === 0) beginTelegraph(drone, at);
      else {
        drone.phase = "recover";
        drone.timer = 0;
      }
      return;
    }
    if (drone.phase === "telegraph") {
      launch(drone, at);
      drone.phase = "intra";
    } else if (drone.phase === "intra") {
      launch(drone, at);
      drone.phase = "recover";
    } else {
      beginTelegraph(drone, at);
      return;
    }
    drone.timer = 0;
  }

  function soonest(): number {
    let need = Infinity;
    for (let i = 0; i < drones.length; i += 1) {
      const drone = drones[i]!;
      if (!drone.alive) continue;
      const left = phaseDuration(drone.phase) - drone.timer;
      if (left < need) need = left;
    }
    return need;
  }

  function due(drone: Drone): boolean {
    return drone.alive && drone.timer >= phaseDuration(drone.phase) - 1e-8;
  }

  function moveDrone(drone: Drone, dt: number): void {
    const pos = drone.position;
    const dx = focus.x - pos.x;
    const dz = focus.z - pos.z;
    const dist = Math.hypot(dx, dz);
    const floorY = wispFloorY(pos.x, pos.y, pos.z, hull);
    const band = dist < WISP_CLOSE ? WISP_ALTITUDE_MAX : WISP_ALTITUDE_MIN;
    let targetY = floorY + band;
    // A deck above us is a catwalk. Climb over the parapet, then the floor
    // sample on the far side drops the target back into the peek band.
    if (focus.y > floorY + 1.5) {
      targetY = Math.max(targetY, focus.y + band, PARAPET_Y + WISP_RADIUS + 0.15);
    }
    const yLo = WISP_RADIUS + VOLUME_PAD;
    const yHi = CEILING_Y - WISP_RADIUS - VOLUME_PAD;
    if (targetY < yLo) targetY = yLo;
    if (targetY > yHi) targetY = yHi;

    let hx = 0;
    let hz = 0;
    if (dist > 1e-4) {
      const inv = 1 / dist;
      const tx = dx * inv;
      const tz = dz * inv;
      drone.yaw = Math.atan2(-dx, -dz);
      if (dist > WISP_RANGE_MAX) {
        hx = tx;
        hz = tz;
      } else if (dist < WISP_RANGE_MIN) {
        hx = -tx;
        hz = -tz;
      } else {
        hx = -tz * drone.orbit;
        hz = tx * drone.orbit;
        const mid = (WISP_RANGE_MIN + WISP_RANGE_MAX) * 0.5;
        const radial = (dist - mid) / (WISP_RANGE_MAX - WISP_RANGE_MIN);
        hx += tx * radial;
        hz += tz * radial;
      }
    }
    for (let i = 0; i < drones.length; i += 1) {
      const other = drones[i]!;
      if (other === drone || !other.alive) continue;
      const ox = pos.x - other.position.x;
      const oz = pos.z - other.position.z;
      const od = Math.hypot(ox, oz);
      if (od < 1.6 && od > 1e-4) {
        hx += (ox / od) * 0.85;
        hz += (oz / od) * 0.85;
      }
    }
    const hlen = Math.hypot(hx, hz);
    if (hlen > 1e-6) {
      hx /= hlen;
      hz /= hlen;
    }
    const yNorm = clamp((targetY - pos.y) / 0.8, -1, 1);
    const vlen = Math.hypot(hx, yNorm, hz) || 1;
    const scale = (WISP_SPEED * dt) / vlen;
    pos.x += hx * scale;
    pos.y += yNorm * scale;
    pos.z += hz * scale;
    resolveSphere(pos, WISP_RADIUS, hull);
    clampVolume(pos);
    resolveSphere(pos, WISP_RADIUS, hull);
    clampVolume(pos);
  }

  function stepBolt(bolt: WispBolt, dt: number): void {
    if (!bolt.alive || bolt.hit) return;
    const remain = WISP_BOLT_LIFE - bolt.age;
    if (remain <= 1e-8) {
      bolt.alive = false;
      return;
    }
    const step = dt < remain ? dt : remain;
    const travel = WISP_BOLT_SPEED * step;
    boltFrom.x = bolt.x;
    boltFrom.y = bolt.y;
    boltFrom.z = bolt.z;
    boltTo.x = bolt.x + bolt.dx * travel;
    boltTo.y = bolt.y + bolt.dy * travel;
    boltTo.z = bolt.z + bolt.dz * travel;

    let stop = 1;
    let blocked = false;
    const hullHit = traceSegment(boltFrom, boltTo, hull, scratchHit);
    if (hullHit && hullHit.t <= stop) {
      stop = hullHit.t;
      blocked = true;
    }
    capA.x = focus.x;
    capA.y = focus.y + CAPSULE_RADIUS;
    capA.z = focus.z;
    capB.x = focus.x;
    capB.y = focus.y + CAPSULE_HEIGHT - CAPSULE_RADIUS;
    capB.z = focus.z;
    const body = segmentSegment(boltFrom, boltTo, capA, capB);
    const reach = CAPSULE_RADIUS + WISP_BOLT_RADIUS;
    const grazes = body.dist <= reach;
    // The closest point of a slice that ends inside the capsule is s === 1.
    // Requiring s < stop - epsilon skipped that contact, left the bolt alive
    // inside the body, and let the next substep test the same overlap again.
    const playerHit = grazes && (body.s < stop - 1e-4 || !blocked);
    if (playerHit) stop = Math.min(stop, body.s);

    bolt.x += bolt.dx * travel * stop;
    bolt.y += bolt.dy * travel * stop;
    bolt.z += bolt.dz * travel * stop;
    bolt.age += step * stop;
    if (playerHit || (!blocked && overlapsPlayer(bolt.x, bolt.y, bolt.z, reach))) {
      strike(bolt);
      return;
    }
    if (
      blocked ||
      bolt.age >= WISP_BOLT_LIFE - 1e-8 ||
      !wispInsideVolume({ x: bolt.x, y: bolt.y, z: bolt.z }, 0)
    ) {
      bolt.alive = false;
    }
  }

  function stepBolts(dt: number): void {
    for (let i = 0; i < bolts.length; i += 1) stepBolt(bolts[i]!, dt);
  }

  function overlapsPlayer(x: number, y: number, z: number, reach: number): boolean {
    const ay = focus.y + CAPSULE_RADIUS;
    const by = focus.y + CAPSULE_HEIGHT - CAPSULE_RADIUS;
    const span = by - ay;
    const t = span > 0 ? clamp((y - ay) / span, 0, 1) : 0;
    const cy = ay + span * t;
    const dx = x - focus.x;
    const dy = y - cy;
    const dz = z - focus.z;
    return dx * dx + dy * dy + dz * dz <= reach * reach;
  }

  function strike(bolt: WispBolt): void {
    bolt.alive = false;
    if (bolt.hit) return;
    bolt.hit = true;
    if (player.get().hp <= 0) return;
    const before = player.get().hp;
    damagePlayer(player, WISP_BOLT_DAMAGE);
    if (player.get().hp === before) return;
    boltsHit += 1;
    damageEvents += 1;
  }

  function stepPools(dt: number): void {
    stepPool(sparks, dt, 3);
    stepPool(gibs, dt, 9);
    stepPool(fluid, dt, 14);
  }

  function silence(pool: WispParticle[]): void {
    for (let i = 0; i < pool.length; i += 1) pool[i]!.alive = false;
  }

  function countAlive(): number {
    let count = 0;
    for (let i = 0; i < drones.length; i += 1) if (drones[i]!.alive) count += 1;
    return count;
  }

  function spawnWave(feet: Vec3): void {
    const plan = director.plan();
    const points = planWispSpawns(feet, hull, plan.drones);
    for (let i = 0; i < drones.length; i += 1) {
      const drone = drones[i]!;
      drone.alive = false;
      drone.hp = 0;
      drone.handle.setActive(false);
    }
    for (let i = 0; i < plan.drones; i += 1) {
      const drone = drones[i]!;
      const point = points[i]!;
      drone.position.x = point.x;
      drone.position.y = point.y;
      drone.position.z = point.z;
      drone.alive = true;
      drone.hp = WISP_HP;
      drone.phase = "grace";
      drone.timer = 0;
      drone.handle.setActive(true);
      faceOrigin(drone, feet);
    }
    director.acknowledgeSpawn();
  }

  function restart(next: Vec3): void {
    director.restart();
    time = 0;
    boltsHit = 0;
    damageEvents = 0;
    firstBolt = Number.POSITIVE_INFINITY;
    for (let i = 0; i < bolts.length; i += 1) {
      bolts[i]!.alive = false;
      bolts[i]!.hit = false;
    }
    silence(sparks);
    silence(gibs);
    silence(fluid);
    for (let i = 0; i < DRONE_CAP; i += 1) {
      boltCounts[i] = 0;
      telegraphCounts[i] = 0;
    }
    focus.x = next.x;
    focus.y = next.y;
    focus.z = next.z;
    spawnWave(next);
  }

  function rememberTime(mark: number): void {
    director.addTime(time - mark);
  }

  return {
    drones,
    bolts,
    sparks,
    gibs,
    fluid,
    focus,
    get time() {
      return time;
    },
    get wave() {
      return director.wave;
    },
    get wavesCleared() {
      return director.wavesCleared;
    },
    get frags() {
      return director.frags;
    },
    get timeAlive() {
      return director.timeAlive;
    },
    get phase() {
      return director.phase;
    },
    get enforcers() {
      return director.enforcers;
    },
    aliveCount(): number {
      return countAlive();
    },
    hurt(index: number, amount: number): void {
      const drone = drones[index];
      if (!drone) return;
      applyFlechette(drone, amount);
    },
    killAlive(): void {
      for (let i = 0; i < drones.length; i += 1) {
        const drone = drones[i]!;
        if (!drone.alive) continue;
        applyFlechette(drone, drone.hp > 0 ? drone.hp : WISP_HP);
      }
    },
    restart,
    recap(): DeathRecap {
      return director.recap();
    },
    update(dt: number, feet: Vec3): void {
      if (!Number.isFinite(dt) || dt <= 0) return;
      if (player.get().hp <= 0) return;
      focus.x = feet.x;
      focus.y = feet.y;
      focus.z = feet.z;
      if (director.phase === "fighting" && countAlive() === 0) director.noteEmpty();
      const mark = time;
      if (director.phase === "gap") {
        stepBolts(dt);
        stepPools(dt);
        time += dt;
        if (player.get().hp <= 0) {
          rememberTime(mark);
          return;
        }
        rememberTime(mark);
        director.stepGap(dt);
        if (director.pendingSpawn) spawnWave(feet);
        return;
      }
      let left = dt;
      let cursor = time;
      let guard = 0;
      while (left > 1e-9 && guard < 8) {
        guard += 1;
        const need = soonest();
        const slice = Math.min(left, need > 0 ? need : 0);
        if (slice > 1e-8) {
          for (let i = 0; i < drones.length; i += 1) {
            const drone = drones[i]!;
            if (!drone.alive) continue;
            moveDrone(drone, slice);
            drone.timer += slice;
          }
          stepBolts(slice);
          stepPools(slice);
          cursor += slice;
          left -= slice;
          if (player.get().hp <= 0) {
            time = cursor;
            rememberTime(mark);
            return;
          }
        }
        let fired = false;
        for (let i = 0; i < drones.length; i += 1) {
          const drone = drones[i]!;
          if (!due(drone)) continue;
          finishPhase(drone, cursor);
          fired = true;
        }
        if (!fired && slice <= 1e-8) break;
      }
      time = cursor;
      rememberTime(mark);
    },
    boltCount(drone: number): number {
      return boltCounts[drone] ?? 0;
    },
    boltTime(drone: number, index: number): number {
      const count = boltCounts[drone] ?? 0;
      if (index < 0 || index >= count) return Number.NaN;
      return boltTimes[drone]![index]!;
    },
    telegraphCount(drone: number): number {
      return telegraphCounts[drone] ?? 0;
    },
    telegraphTime(drone: number, index: number): number {
      const count = telegraphCounts[drone] ?? 0;
      if (index < 0 || index >= count) return Number.NaN;
      return telegraphTimes[drone]![index]!;
    },
    snapshot(): WispSnapshot {
      let count = 0;
      let liveBolts = 0;
      const view: WispSnapshot["drones"] = [];
      for (let i = 0; i < drones.length; i += 1) {
        const drone = drones[i]!;
        if (drone.alive) count += 1;
        view.push({
          x: drone.position.x,
          y: drone.position.y,
          z: drone.position.z,
          alive: drone.alive,
          hp: drone.hp,
          aggro: drone.aggro,
        });
      }
      for (let i = 0; i < bolts.length; i += 1) if (bolts[i]!.alive) liveBolts += 1;
      let fired = 0;
      for (let i = 0; i < boltCounts.length; i += 1) fired += boltCounts[i] ?? 0;
      return {
        count,
        bolts: liveBolts,
        drones: view,
        wave: director.wave,
        wavesCleared: director.wavesCleared,
        frags: director.frags,
        timeAlive: director.timeAlive,
        phase: director.phase,
        enforcers: director.enforcers,
        time,
        fired,
        hits: boltsHit,
        damageEvents,
        firstBolt: Number.isFinite(firstBolt) ? firstBolt : null,
      };
    },
  };

  function applyFlechette(drone: Drone, amount: number): void {
    if (!drone.alive || !Number.isFinite(amount) || amount <= 0) return;
    drone.hp -= amount;
    if (drone.hp > 0) return;
    drone.hp = 0;
    drone.alive = false;
    drone.handle.setActive(false);
    emitDeath(drone.position);
    director.noteFrag();
    if (countAlive() === 0) director.noteEmpty();
  }

  function emitDeath(at: Vec3): void {
    emitKind(sparks, SPARK_DIR, WISP_SPARKS_PER_DEATH, at, 4.5, 0.42, 7);
    emitKind(gibs, GIB_DIR, WISP_GIBS_PER_DEATH, at, 2.4, 1.15, 4);
    emitKind(fluid, FLUID_DIR, WISP_FLUID_PER_DEATH, at, 1.1, 0.9, 2);
  }
}

const RUN_DEBUG_KEY = "__fragRun";

export function exposeRunDebug(
  target: object,
  sim: { killAlive(): void; snapshot(): WispSnapshot },
): void {
  Object.defineProperty(target, RUN_DEBUG_KEY, {
    configurable: true,
    enumerable: true,
    value: {
      killAlive(): void {
        sim.killAlive();
      },
      get snapshot(): WispSnapshot {
        return sim.snapshot();
      },
    },
  });
}

function makeDrone(
  index: number,
  point: Vec3,
  orbit: number,
  phase: WispPhase,
  hitboxes: HitboxWorld,
  onHit: (drone: Drone, amount: number) => void,
): Drone {
  const position: Vec3 = { x: point.x, y: point.y, z: point.z };
  const drone: Drone = {
    index,
    alive: true,
    hp: WISP_HP,
    aggro: true,
    orbit,
    position,
    phase,
    timer: 0,
    yaw: 0,
    handle: null as unknown as HitboxHandle,
  };
  drone.handle = hitboxes.register({
    center: position,
    radius: WISP_RADIUS,
    onHit(amount: number) {
      onHit(drone, amount);
    },
  });
  return drone;
}

function faceOrigin(drone: Drone, origin: Vec3): void {
  const dx = origin.x - drone.position.x;
  const dz = origin.z - drone.position.z;
  if (Math.hypot(dx, dz) > 1e-4) drone.yaw = Math.atan2(-dx, -dz);
}

function makeBolt(): WispBolt {
  return { alive: false, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1, age: 0, serial: 0, hit: false };
}

function makePool(count: number): WispParticle[] {
  const pool: WispParticle[] = [];
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
      metal: i % 2 === 0,
    });
  }
  return pool;
}

function phaseDuration(phase: WispPhase): number {
  if (phase === "grace") return WISP_SPAWN_GRACE;
  if (phase === "telegraph") return WISP_TELEGRAPH;
  if (phase === "intra") return WISP_BOLT_GAP;
  return WISP_RECOVER;
}

function emitKind(
  pool: WispParticle[],
  dirs: readonly (readonly [number, number, number])[],
  count: number,
  at: Vec3,
  speed: number,
  life: number,
  spin: number,
): void {
  for (let i = 0; i < count; i += 1) {
    const slot = takeParticle(pool);
    const dir = dirs[i % dirs.length]!;
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const scale = speed * (0.75 + (i % 3) * 0.12);
    slot.alive = true;
    slot.x = at.x;
    slot.y = at.y;
    slot.z = at.z;
    slot.vx = (dir[0] / len) * scale;
    slot.vy = Math.abs(dir[1] / len) * scale + 0.4;
    slot.vz = (dir[2] / len) * scale;
    slot.age = 0;
    slot.life = life;
    slot.spin = spin * (i % 2 === 0 ? 1 : -1);
    slot.metal = i % 2 === 0;
  }
}

function takeParticle(pool: WispParticle[]): WispParticle {
  let oldest: WispParticle | null = null;
  for (let i = 0; i < pool.length; i += 1) {
    const slot = pool[i]!;
    if (!slot.alive) return slot;
    if (!oldest || slot.age > oldest.age) oldest = slot;
  }
  return oldest ?? pool[0]!;
}

function stepPool(pool: WispParticle[], dt: number, gravity: number): void {
  for (let i = 0; i < pool.length; i += 1) {
    const slot = pool[i]!;
    if (!slot.alive) continue;
    slot.vy -= gravity * dt;
    slot.x += slot.vx * dt;
    slot.y += slot.vy * dt;
    slot.z += slot.vz * dt;
    slot.age += dt;
    // The kill plane and the outer walls retire scraps that leave the atrium.
    // Otherwise a falling droplet stays alive below the map until its timer.
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

function spawnPoint(x: number, z: number, feet: Vec3, hull: Hull): Vec3 | null {
  if (Math.abs(x) > MAP_HALF - 1 || Math.abs(z) > MAP_HALF - 1) return null;
  const floorY = wispFloorY(x, CEILING_Y - 0.2, z, hull);
  const y = floorY + (WISP_ALTITUDE_MIN + WISP_ALTITUDE_MAX) * 0.5;
  const point = { x, y, z };
  if (!wispInsideVolume(point)) return null;
  const horizontal = Math.hypot(x - feet.x, z - feet.z);
  const apart = Math.hypot(x - feet.x, y - feet.y, z - feet.z);
  if (horizontal < WISP_SEPARATION || apart < WISP_SEPARATION) return null;
  if (sphereHitsHull(point, WISP_RADIUS + 0.05, hull)) return null;
  return point;
}

function clampVolume(pos: Vec3): void {
  const lo = WISP_RADIUS + VOLUME_PAD;
  const hiX = MAP_HALF - WISP_RADIUS - VOLUME_PAD;
  const hiY = CEILING_Y - WISP_RADIUS - VOLUME_PAD;
  pos.x = clamp(pos.x, -hiX, hiX);
  pos.y = clamp(pos.y, lo, hiY);
  pos.z = clamp(pos.z, -hiX, hiX);
}

function resolveSphere(pos: Vec3, radius: number, hull: Hull): void {
  for (let pass = 0; pass < 6; pass += 1) {
    let hit = false;
    const boxes = hull.boxes;
    for (let i = 0; i < boxes.length; i += 1) {
      if (pushSphereBox(pos, radius, boxes[i]!)) hit = true;
    }
    const ramps = hull.ramps;
    for (let i = 0; i < ramps.length; i += 1) {
      if (pushSphereRamp(pos, radius, ramps[i]!)) hit = true;
    }
    if (!hit) return;
  }
}

function sphereHitsBox(pos: Vec3, radius: number, box: BoxSolid): boolean {
  const cx = clamp(pos.x, box.min.x, box.max.x);
  const cy = clamp(pos.y, box.min.y, box.max.y);
  const cz = clamp(pos.z, box.min.z, box.max.z);
  const dx = pos.x - cx;
  const dy = pos.y - cy;
  const dz = pos.z - cz;
  return dx * dx + dy * dy + dz * dz < radius * radius;
}

function pushSphereBox(pos: Vec3, radius: number, box: BoxSolid): boolean {
  const cx = clamp(pos.x, box.min.x, box.max.x);
  const cy = clamp(pos.y, box.min.y, box.max.y);
  const cz = clamp(pos.z, box.min.z, box.max.z);
  let dx = pos.x - cx;
  let dy = pos.y - cy;
  let dz = pos.z - cz;
  const d2 = dx * dx + dy * dy + dz * dz;
  const limit = radius + SLOP;
  if (d2 >= limit * limit) return false;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    const push = limit - d;
    const inv = 1 / d;
    pos.x += dx * inv * push;
    pos.y += dy * inv * push;
    pos.z += dz * inv * push;
    return true;
  }
  const faces = [
    { pen: pos.x - box.min.x, axis: 0, sign: -1, face: box.min.x },
    { pen: box.max.x - pos.x, axis: 0, sign: 1, face: box.max.x },
    { pen: pos.y - box.min.y, axis: 1, sign: -1, face: box.min.y },
    { pen: box.max.y - pos.y, axis: 1, sign: 1, face: box.max.y },
    { pen: pos.z - box.min.z, axis: 2, sign: -1, face: box.min.z },
    { pen: box.max.z - pos.z, axis: 2, sign: 1, face: box.max.z },
  ];
  let best = faces[0]!;
  for (let i = 1; i < faces.length; i += 1) if (faces[i]!.pen < best.pen) best = faces[i]!;
  const target = best.face + best.sign * limit;
  if (best.axis === 0) pos.x = target;
  else if (best.axis === 1) pos.y = target;
  else pos.z = target;
  return true;
}

function rampFrame(ramp: RampSolid): { slope: number; ny: number; nz: number; plane: number } | null {
  const span = ramp.maxZ - ramp.minZ;
  if (span < 1e-6) return null;
  const slope = ramp.rise / span;
  const grad = Math.hypot(1, slope);
  const ny = 1 / grad;
  const nz = slope / grad;
  return { slope, ny, nz, plane: ny * ramp.yAtMaxZ + nz * ramp.maxZ };
}

function sphereHitsRamp(pos: Vec3, radius: number, ramp: RampSolid): boolean {
  const frame = rampFrame(ramp);
  if (!frame) return false;
  if (pos.x < ramp.minX - radius || pos.x > ramp.maxX + radius) return false;
  if (pos.z < ramp.minZ - radius || pos.z > ramp.maxZ + radius) return false;
  const signed = frame.ny * pos.y + frame.nz * pos.z - frame.plane;
  const cx = clamp(pos.x, ramp.minX, ramp.maxX);
  const cz = clamp(pos.z, ramp.minZ, ramp.maxZ);
  const horiz = Math.hypot(pos.x - cx, pos.z - cz);
  if (horiz <= 1e-4) return signed < radius && pos.y > ramp.yAtMaxZ - ramp.rise - radius;
  if (horiz >= radius) return false;
  const edgeY = ramp.yAtMaxZ + frame.slope * (ramp.maxZ - cz);
  // Above the slope, only the top edge can touch the disc.
  if (pos.y >= edgeY) return Math.hypot(horiz, pos.y - edgeY) < radius;
  return pos.y > edgeY - ramp.rise - radius;
}

function pushSphereRamp(pos: Vec3, radius: number, ramp: RampSolid): boolean {
  const frame = rampFrame(ramp);
  if (!frame) return false;
  const limit = radius + SLOP;
  if (pos.x < ramp.minX - limit || pos.x > ramp.maxX + limit) return false;
  if (pos.z < ramp.minZ - limit || pos.z > ramp.maxZ + limit) return false;
  const signed = frame.ny * pos.y + frame.nz * pos.z - frame.plane;
  const cx = clamp(pos.x, ramp.minX, ramp.maxX);
  const cz = clamp(pos.z, ramp.minZ, ramp.maxZ);
  const hx = pos.x - cx;
  const hz = pos.z - cz;
  const horiz = Math.hypot(hx, hz);
  if (horiz <= 1e-4) {
    if (signed >= limit) return false;
    if (pos.y < ramp.yAtMaxZ - ramp.rise - limit) return false;
    const push = limit - signed;
    pos.y += frame.ny * push;
    pos.z += frame.nz * push;
    return true;
  }
  const edgeY = ramp.yAtMaxZ + frame.slope * (ramp.maxZ - cz);
  if (horiz >= limit && pos.y >= edgeY) return false;
  if (pos.y >= edgeY) {
    // Lift over the wedge. Pushing out sideways fights the parapet beside the ramp.
    if (pos.y >= edgeY + limit) return false;
    pos.y = edgeY + limit;
    return true;
  }
  if (horiz >= limit) return false;
  const push = limit - horiz;
  pos.x += (hx / horiz) * push;
  pos.z += (hz / horiz) * push;
  return true;
}

function segmentSegment(
  a0: Vec3,
  a1: Vec3,
  b0: Vec3,
  b1: Vec3,
): { s: number; dist: number } {
  const d1x = a1.x - a0.x;
  const d1y = a1.y - a0.y;
  const d1z = a1.z - a0.z;
  const d2x = b1.x - b0.x;
  const d2y = b1.y - b0.y;
  const d2z = b1.z - b0.z;
  const rx = a0.x - b0.x;
  const ry = a0.y - b0.y;
  const rz = a0.z - b0.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0;
  let t = 0;
  if (a <= 1e-10 && e <= 1e-10) {
    s = 0;
    t = 0;
  } else if (a <= 1e-10) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-10) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > 1e-10 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }
  const cx = a0.x + d1x * s - (b0.x + d2x * t);
  const cy = a0.y + d1y * s - (b0.y + d2y * t);
  const cz = a0.z + d1z * s - (b0.z + d2z * t);
  return { s, dist: Math.hypot(cx, cy, cz) };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
