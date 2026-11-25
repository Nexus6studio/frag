// VEC-9 Quill Driver.
//
// Magnetic flechette carbine. Holding fire launches one rail-spike on the
// trigger edge and then one every 0.125 s. A click that is already released
// still counts: `presses` is how many left-clicks landed since the last
// sample, and each one attempts a shot when the clock allows. Presses that
// do not fit before this update ends are dropped, not saved for later, so a
// burst cannot outrun the hold and cannot dump a backlog into the next frame.
// Each spike is a projectile: 70 m/s, 0.06 m radius, removed after 1 s or 70 m.
// A hit deals 9 with no falloff.
// The magazine is 40. Reserve starts at 40, never exceeds 80, and never goes
// negative. Reload takes 1.4 s from R or from an empty magazine, and the
// trigger does nothing while it runs. An empty hold with no reserve left
// does not fire and does not advance the shot clock.
//
// Right mouse charges a pierce burst. The charge takes 0.45 s and then fires
// three flechettes down the same bore. Those three cost 5 magazine rounds.
// Each deals 9 and can pass through the first enemy to hit the one behind it.
// A second charge waits out a 0.8 s cooldown. Letting go early, or dropping
// under 5 rounds while the charge is running, aborts it. Reload, and a
// magazine under 5, will not fire the burst. Left-click stays at eight a second.
//
// The shot clock is an accumulator, so a 20 fps frame and a 144 fps frame
// land on the same pulses. Spikes live in a fixed pool. Past the cap, the
// oldest slot is reused. The 0.12° pitch punch is a view offset: it settles
// in 0.10 s, before the next pulse, and it does not bend the bore line.

import { CEILING_Y, KILL_Y, MAP_HALF } from "./atrium.ts";
import type { CueListener } from "./cues.ts";
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
/** Right-click hold before the pierce burst fires. */
export const QUILL_CHARGE = 0.45;
/** Flechettes in the charged burst. Each deals QUILL_DAMAGE. */
export const QUILL_BURST = 3;
/** Magazine rounds the burst spends. The spine lamp shortens by this many. */
export const QUILL_BURST_COST = 5;
/** Seconds after a burst before another charge can start. */
export const QUILL_BURST_COOLDOWN = 0.8;
/** How long the abort flash stays up, in seconds. */
export const QUILL_CHARGE_ABORT = 0.12;
/** Enemies a burst flechette may pass through before the next hit stops it. */
export const QUILL_PIERCE = 1;
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
  /** Enemies this spike can still pass through. Primary shots stay at 0. */
  pierce: number;
  /** Enemy already damaged. The next sweep skips that callback. */
  passed: ((damage: number) => void) | null;
  /**
   * Seconds to wait before this spike starts moving. A burst born partway
   * through a frame uses this so it does not fly the whole slice.
   */
  delay: number;
}

export interface QuillCommand {
  /** Held at the sample. Full-auto for this whole update. */
  fire: boolean;
  /**
   * Left clicks since the previous sample, including a click that is already
   * up. Omitted keeps the legacy rising edge, which fires even with no time
   * between pulls. A number, including 0, stays on the 0.125 s clock.
   */
  presses?: number;
  /** Rising edge of reload. Held frames after the edge are ignored. */
  reload: boolean;
  /** Right mouse held. Omitted does not charge. */
  alt?: boolean;
  /**
   * Right-click down edge since the previous sample. A tap that is already
   * up still counts, and that one aborts instead of firing.
   */
  altEdge?: boolean;
  origin: Vec3;
  direction: Vec3;
}

export interface QuillOptions {
  hull?: Hull | null;
  player?: PlayerStore | null;
  /** Defaults to the shared enemy list. */
  hitboxes?: HitboxWorld;
  poolCap?: number;
  /** Shot, dry click, and reload. Omitted in tests that only check the gun. */
  onEvent?: CueListener;
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
  /** 0 at rest, 1 when the right-click charge is full. */
  readonly charge: number;
  /** True while right mouse is charging the burst. */
  readonly charging: boolean;
  /** 1 when a charge aborts, falling to 0 over QUILL_CHARGE_ABORT. */
  readonly chargeAbort: number;
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
  let charging = false;
  let chargeTime = 0;
  let altHeld = false;
  let cooldown = 0;
  let abortLeft = 0;
  // A burst can open a reload after part of the frame has already passed.
  // -1 means the reload branch should count the whole dt.
  let reloadSlice = -1;

  function fillSlot(command: QuillCommand, time: number, pierce: number, delay: number): boolean {
    const dx = command.direction.x;
    const dy = command.direction.y;
    const dz = command.direction.z;
    const len = Math.hypot(dx, dy, dz);
    if (!(len > 1e-8)) return false;

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
    slot.pierce = pierce;
    slot.passed = null;
    slot.delay = delay;
    birth += 1;
    shotsFired += 1;
    if (recorded < RECORD) {
      shotTimes[recorded] = time;
      const dir = shotDirs[recorded]!;
      dir.x = slot.dx;
      dir.y = slot.dy;
      dir.z = slot.dz;
      recorded += 1;
    }
    return true;
  }

  function shoot(command: QuillCommand, time: number): boolean {
    if (mag <= 0) return false;
    if (!fillSlot(command, time, 0, 0)) return false;
    mag -= 1;
    punch = QUILL_PUNCH_DEG;
    punchAge = 0;
    flash = 1;
    if (mag <= 0 && reserve > 0) tryStartReload();
    options.onEvent?.({ type: "quill-shot" });
    return true;
  }

  function launchBurst(command: QuillCommand, time: number, delay: number, overshoot: number): boolean {
    if (mag < QUILL_BURST_COST) return false;
    const dx = command.direction.x;
    const dy = command.direction.y;
    const dz = command.direction.z;
    if (!(Math.hypot(dx, dy, dz) > 1e-8)) return false;
    let spawned = 0;
    for (let i = 0; i < QUILL_BURST; i += 1) {
      if (fillSlot(command, time, QUILL_PIERCE, delay)) spawned += 1;
    }
    if (spawned === 0) return false;
    mag -= QUILL_BURST_COST;
    if (mag < 0) mag = 0;
    punch = QUILL_PUNCH_DEG;
    punchAge = 0;
    flash = 1;
    cooldown = QUILL_BURST_COOLDOWN;
    if (mag <= 0 && reserve > 0) {
      tryStartReload();
      reloadSlice = Math.max(0, overshoot);
    }
    options.onEvent?.({ type: "quill-charge-end" });
    for (let i = 0; i < spawned; i += 1) options.onEvent?.({ type: "quill-shot" });
    return true;
  }

  function abortCharge(): void {
    charging = false;
    chargeTime = 0;
    abortLeft = QUILL_CHARGE_ABORT;
    options.onEvent?.({ type: "quill-charge-abort" });
  }

  function stepAlt(dt: number, command: QuillCommand): void {
    if (dt > 0) {
      if (abortLeft > 0) {
        abortLeft -= dt;
        if (abortLeft < 0) abortLeft = 0;
      }
      if (cooldown > 0) {
        cooldown -= dt;
        if (cooldown < 0) cooldown = 0;
      }
    }

    const altDown = command.alt === true;
    const edge = command.altEdge === true || (altDown && !altHeld);
    altHeld = altDown;

    if (reloading) {
      if (charging) abortCharge();
      return;
    }

    // A click that is already up never held long enough to charge.
    if (edge && !altDown && !charging && cooldown <= 0) {
      abortCharge();
      return;
    }

    if (mag < QUILL_BURST_COST) {
      if (charging || (edge && cooldown <= 0)) abortCharge();
      return;
    }

    if (!charging) {
      if (!(edge && altDown && cooldown <= 0)) return;
      charging = true;
      chargeTime = 0;
      options.onEvent?.({ type: "quill-charge" });
    } else if (!altDown) {
      abortCharge();
      return;
    }

    chargeTime += dt;
    if (chargeTime < QUILL_CHARGE - 1e-9) return;
    const overshoot = Math.max(0, chargeTime - QUILL_CHARGE);
    const delay = Math.max(0, dt - overshoot);
    charging = false;
    chargeTime = 0;
    if (!launchBurst(command, clock + delay, delay, overshoot)) abortCharge();
  }

  function tryStartReload(): void {
    if (reloading || mag >= QUILL_MAG || reserve <= 0) return;
    reloading = true;
    reloadTimer = 0;
    reloadSlice = -1;
    options.onEvent?.({ type: "reload-start" });
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
    options.onEvent?.({ type: "reload-end" });
  }

  function noteDry(command: QuillCommand): void {
    if (reserve > 0) return;
    const rawPresses = command.presses;
    const paced = typeof rawPresses === "number";
    const presses = paced ? Math.max(0, Math.floor(rawPresses)) : 0;
    const pulls = Math.min(8, paced ? presses : command.fire && !triggerHeld ? 1 : 0);
    for (let i = 0; i < pulls; i += 1) options.onEvent?.({ type: "quill-dry" });
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
      stepAlt(dt, command);

      if (reloading) {
        const slice = reloadSlice >= 0 ? reloadSlice : dt;
        reloadSlice = -1;
        reloadTimer += slice;
        if (reloadTimer >= QUILL_RELOAD) finishReload();
        settle(dt);
        carry = QUILL_INTERVAL;
        triggerHeld = command.fire;
        clock += dt;
        publish();
        return;
      }

      if (mag <= 0) {
        noteDry(command);
        settle(dt);
        carry = QUILL_INTERVAL;
        triggerHeld = command.fire;
        clock += dt;
        publish();
        return;
      }

      const rawPresses = command.presses;
      const paced = typeof rawPresses === "number";
      const presses = paced ? Math.max(0, Math.floor(rawPresses)) : 0;
      // Legacy pulls with no `presses` still fire on the rising edge, so a
      // zero-length click in the old tests spends a round. The game always
      // passes a count and cannot skip the cooldown that way.
      if (command.fire && !triggerHeld && !paced) carry = QUILL_INTERVAL;
      triggerHeld = command.fire;

      if (!command.fire && presses > 0) {
        // The button is up, but one or more clicks landed since the last
        // sample. Spend as many as this slice can fit. The rest are dropped.
        let budget = presses;
        let pending = dt;
        let elapsed = 0;
        while (budget > 0 && mag > 0) {
          const need = QUILL_INTERVAL - carry;
          // Strictly inside the slice. A pulse that would land on the far
          // edge belongs to the next sample, and it is not kept as a debt.
          if (need > 1e-6 && need >= pending - 1e-12) {
            settle(pending);
            carry += pending;
            if (carry > QUILL_INTERVAL) carry = QUILL_INTERVAL;
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
          budget -= 1;
          if (budget <= 0 || pending <= 1e-6) break;
        }
        if (pending > 1e-8) {
          if (reloading) reloadTimer += pending;
          settle(pending);
          carry += pending;
          if (carry > QUILL_INTERVAL) carry = QUILL_INTERVAL;
        }
        triggerHeld = false;
        clock += dt;
        publish();
        return;
      }

      if (!command.fire) {
        settle(dt);
        if (paced) {
          carry += dt;
          if (carry > QUILL_INTERVAL) carry = QUILL_INTERVAL;
        } else {
          carry = QUILL_INTERVAL;
        }
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
    get charge() {
      if (!charging) return 0;
      const t = chargeTime / QUILL_CHARGE;
      if (t <= 0) return 0;
      if (t >= 1) return 1;
      return t;
    },
    get charging() {
      return charging;
    },
    get chargeAbort() {
      if (!(abortLeft > 0)) return 0;
      const t = abortLeft / QUILL_CHARGE_ABORT;
      return t > 1 ? 1 : t;
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
      if (charging) options.onEvent?.({ type: "quill-charge-end" });
      mag = QUILL_MAG;
      reserve = QUILL_RESERVE_START;
      reloading = false;
      reloadTimer = 0;
      reloadSlice = -1;
      carry = QUILL_INTERVAL;
      triggerHeld = false;
      charging = false;
      chargeTime = 0;
      altHeld = false;
      cooldown = 0;
      abortLeft = 0;
      punch = 0;
      punchAge = QUILL_PUNCH_RECOVER;
      flash = 0;
      for (let i = 0; i < pool.length; i += 1) {
        const slot = pool[i]!;
        slot.alive = false;
        slot.passed = null;
        slot.pierce = 0;
        slot.delay = 0;
      }
      publishedMag = -1;
      publishedReserve = -1;
      publish();
    },
  };
}

function endSlot(slot: FlechetteSlot): void {
  slot.alive = false;
  slot.passed = null;
  slot.pierce = 0;
  slot.delay = 0;
}

function stepSlot(slot: FlechetteSlot, dt: number): void {
  if (slot.delay > 0) {
    const skip = dt < slot.delay ? dt : slot.delay;
    slot.delay -= skip;
    dt -= skip;
    if (!(dt > 1e-8)) return;
  }
  const timeLeft = QUILL_LIFETIME - slot.age;
  const distLeft = QUILL_RANGE - slot.traveled;
  if (timeLeft <= 1e-8 || distLeft <= 1e-6) {
    endSlot(slot);
    return;
  }
  const stepTime = dt < timeLeft ? dt : timeLeft;
  const want = QUILL_SPEED * stepTime;
  let remain = want < distLeft ? want : distLeft;
  if (!(remain > 0)) {
    endSlot(slot);
    return;
  }

  const driverHull = activeHull;
  const driverTargets = activeTargets;
  // One pass, plus another for each enemy this spike is still allowed to pierce.
  let guard = 0;
  while (remain > 1e-6 && guard < 4) {
    guard += 1;
    from.x = slot.x;
    from.y = slot.y;
    from.z = slot.z;
    to.x = slot.x + slot.dx * remain;
    to.y = slot.y + slot.dy * remain;
    to.z = slot.z + slot.dz * remain;

    let hitT = 1;
    let blocked = false;
    let hit: ((damage: number) => void) | null = null;
    if (driverHull) {
      const world = traceSegment(from, to, driverHull, worldScratch);
      if (world && world.t <= hitT) {
        hitT = world.t;
        blocked = true;
      }
    }
    if (driverTargets.sweep(from, to, QUILL_RADIUS, sweepScratch, slot.passed) && sweepScratch.t <= hitT) {
      hitT = sweepScratch.t;
      blocked = true;
      hit = sweepScratch.onHit;
    }

    const used = remain * hitT;
    slot.x += slot.dx * used;
    slot.y += slot.dy * used;
    slot.z += slot.dz * used;
    slot.traveled += used;
    slot.age += used / QUILL_SPEED;
    remain -= used;

    if (hit) {
      hit(QUILL_DAMAGE);
      if (slot.pierce > 0) {
        slot.pierce -= 1;
        slot.passed = hit;
        const nudge = remain > 0.001 ? 0.001 : 0;
        if (nudge > 0) {
          slot.x += slot.dx * nudge;
          slot.y += slot.dy * nudge;
          slot.z += slot.dz * nudge;
          slot.traveled += nudge;
          slot.age += nudge / QUILL_SPEED;
          remain -= nudge;
        }
        continue;
      }
      endSlot(slot);
      return;
    }

    // Open sky is not a hull. A spike that leaves the atrium is spent.
    const outside =
      driverHull !== null &&
      (Math.abs(slot.x) > MAP_HALF ||
        Math.abs(slot.z) > MAP_HALF ||
        slot.y < KILL_Y ||
        slot.y > CEILING_Y);
    if (blocked || outside || slot.age >= QUILL_LIFETIME - 1e-8 || slot.traveled >= QUILL_RANGE - 1e-4) {
      endSlot(slot);
      return;
    }
    break;
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
    pierce: 0,
    passed: null,
    delay: 0,
  };
}

function clampCap(value: number): number {
  if (!Number.isFinite(value)) return QUILL_POOL_CAP;
  const n = Math.floor(value);
  if (n < 1) return 1;
  if (n > 64) return 64;
  return n;
}
