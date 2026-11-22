// Walking, jumping, and capsule collision for the test floor.
//
// The body is a vertical capsule. Callers pass the current state, a wish
// (forward / strafe / jump / yaw), and a timestep. The function returns a new
// state and does not read the clock, the DOM, or three.js, so the same step
// runs in the browser and in headless tests.
//
// Ground movement steers the horizontal velocity toward a wish of fixed length.
// Forward, back, strafe, and diagonals share that length. With no wish, drag
// bleeds speed off until a small rest threshold, which is what makes a full
// stop take about a third of a second. For a short grace after landing, that
// drag is skipped, so a jump in the grace keeps the speed you landed with.
// Horizontal speed is always limited, including in the air.
//
// Air control uses the same wish shape with a much smaller acceleration, so a
// strafe can turn the trajectory without holding the body up. Gravity is the
// only vertical acceleration. A jump is accepted only while already grounded.

import type { InputState } from "./input";

export const CAPSULE_RADIUS = 0.35;
export const CAPSULE_HEIGHT = 1.6;
export const EYE_HEIGHT = 1.45;

export const GROUND_WISH_SPEED = 8;
export const GROUND_ACCEL = 10;
export const GROUND_FRICTION = 6;
export const AIR_WISH_SPEED = 8;
export const AIR_ACCEL = 2;
export const GRAVITY = 20;
export const JUMP_SPEED = 6.8;
export const STEP_HEIGHT = 0.3;
export const WALK_SLOPE_DEG = 45;
export const PLANAR_CAP = 9.2;
/** Ground drag stays off this long after a landing, so a jump inside it keeps speed. */
export const LANDING_GRACE = 0.08;

export const SIM_HZ = 120;
export const SIM_DT = 1 / SIM_HZ;

/** Below this, drag snaps to rest. ln(8 / 1.3) / 6 is about 0.30 s from a full run. */
const REST_SPEED = 1.3;
const WALK_Y = Math.cos((WALK_SLOPE_DEG * Math.PI) / 180);
const UP = { x: 0, y: 1, z: 0 };

export const SPAWN = { x: 0, y: 0, z: 5 };

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface MoveState {
  /** Bottom of the capsule, in meters. */
  position: Vec3;
  velocity: Vec3;
  grounded: boolean;
  /** Seconds spent grounded since the last landing. Zero on the landing step. */
  timeOnGround: number;
}

export interface MoveIntent {
  /** +1 forward, -1 back. */
  forward: number;
  /** +1 right, -1 left. */
  strafe: number;
  jump: boolean;
  /** Degrees. Zero looks toward -Z, and positive yaw looks toward -X. */
  yawDeg: number;
}

export interface BoxSolid {
  min: Vec3;
  max: Vec3;
}

export interface RampSolid {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Surface height at maxZ. Height rises toward minZ. */
  yAtMaxZ: number;
  rise: number;
}

export interface Hull {
  boxes: BoxSolid[];
  ramps: RampSolid[];
}

export function createMoveState(position: Vec3 = SPAWN): MoveState {
  return {
    position: { x: position.x, y: position.y, z: position.z },
    velocity: { x: 0, y: 0, z: 0 },
    grounded: true,
    timeOnGround: 1,
  };
}

export function flatHull(): Hull {
  return { boxes: [], ramps: [] };
}

/** Ground, a 0.30 m step, a 1 m ledge, a 45° ramp, and a pillar. */
export function createTestHull(): Hull {
  return {
    boxes: [
      { min: { x: 6, y: 0, z: -18 }, max: { x: 10, y: STEP_HEIGHT, z: -4 } },
      { min: { x: 12, y: 0, z: -18 }, max: { x: 17, y: 1, z: -5 } },
      { min: { x: -4.2, y: 0, z: -9 }, max: { x: -2.6, y: 3, z: -6.6 } },
    ],
    ramps: [
      { minX: -12, maxX: -6, minZ: -8, maxZ: -2, yAtMaxZ: 0, rise: 6 },
    ],
  };
}

export function isWalkableNormal(normalY: number): boolean {
  return normalY >= WALK_Y - 1e-6;
}

export function planarSpeedOf(velocity: Vec3): number {
  return Math.hypot(velocity.x, velocity.z);
}

export function wishDirection(
  yawDeg: number,
  forward: number,
  strafe: number,
): { x: number; z: number } | null {
  const yaw = (yawDeg * Math.PI) / 180;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const x = fx * forward + rx * strafe;
  const z = fz * forward + rz * strafe;
  const length = Math.hypot(x, z);
  if (length < 1e-8) return null;
  return { x: x / length, z: z / length };
}

export function intentFromInput(input: InputState, yawDeg: number): MoveIntent {
  return {
    forward: (input.down.forward ? 1 : 0) - (input.down.back ? 1 : 0),
    strafe: (input.down.right ? 1 : 0) - (input.down.left ? 1 : 0),
    jump: input.pressed.jump,
    yawDeg,
  };
}

export function stepMovement(state: MoveState, intent: MoveIntent, dt: number, hull: Hull): MoveState {
  if (!(dt > 0)) return cloneState(state);

  const wish = wishDirection(intent.yawDeg, intent.forward, intent.strafe);
  let vx = state.velocity.x;
  let vy = state.velocity.y;
  let vz = state.velocity.z;
  const startedGrounded = state.grounded;
  const grace = startedGrounded && state.timeOnGround <= LANDING_GRACE;

  if (startedGrounded) {
    if (!grace) {
      if (wish) {
        const bled = bleedUncommanded(vx, vz, wish, GROUND_WISH_SPEED, dt);
        vx = bled.x;
        vz = bled.z;
      } else {
        const stopped = brakePlanar(vx, vz, dt);
        vx = stopped.x;
        vz = stopped.z;
      }
    }
    if (wish) {
      const sped = accelerate(vx, vz, wish, GROUND_WISH_SPEED, GROUND_ACCEL, dt);
      vx = sped.x;
      vz = sped.z;
    }
    const capped = capPlanar(vx, vz, PLANAR_CAP);
    vx = capped.x;
    vz = capped.z;
    vy = intent.jump ? JUMP_SPEED : 0;
  } else {
    if (wish) {
      const sped = accelerate(vx, vz, wish, AIR_WISH_SPEED, AIR_ACCEL, dt);
      vx = sped.x;
      vz = sped.z;
    }
    const capped = capPlanar(vx, vz, PLANAR_CAP);
    vx = capped.x;
    vz = capped.z;
    vy -= GRAVITY * dt;
  }

  const moved = collideMove(
    state.position,
    { x: vx, y: vy, z: vz },
    dt,
    hull,
    vy > 0,
    startedGrounded,
  );

  let timeOnGround = 0;
  if (moved.grounded) {
    timeOnGround = startedGrounded && !(vy > 0) ? state.timeOnGround + dt : 0;
  }

  return {
    position: moved.position,
    velocity: moved.velocity,
    grounded: moved.grounded,
    timeOnGround,
  };
}

export function createMover(hull: Hull, initial?: MoveState): {
  readonly state: MoveState;
  advance(frameSeconds: number, intent: MoveIntent): MoveState;
} {
  let state = cloneState(initial ?? createMoveState());
  let accumulator = 0;
  return {
    get state() {
      return cloneState(state);
    },
    advance(frameSeconds: number, intent: MoveIntent): MoveState {
      const clamped = Number.isFinite(frameSeconds) ? Math.min(Math.max(frameSeconds, 0), 0.1) : 0;
      accumulator += clamped;
      let steps = 0;
      while (accumulator >= SIM_DT && steps < 16) {
        state = stepMovement(state, intent, SIM_DT, hull);
        accumulator -= SIM_DT;
        steps += 1;
      }
      return cloneState(state);
    },
  };
}

export interface MoveDebug {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly planarSpeed: number;
  readonly grounded: boolean;
}

export function moveDebug(state: MoveState): MoveDebug {
  return {
    x: state.position.x,
    y: state.position.y,
    z: state.position.z,
    planarSpeed: planarSpeedOf(state.velocity),
    grounded: state.grounded,
  };
}

/** Read-only snapshot. There is no setter; the sim does not take writes from the page. */
export function exposeMoveDebug(target: object, read: () => MoveState): void {
  Object.defineProperty(target, "__fragMove", {
    configurable: true,
    enumerable: true,
    get() {
      return moveDebug(read());
    },
  });
}

function cloneState(state: MoveState): MoveState {
  return {
    position: { x: state.position.x, y: state.position.y, z: state.position.z },
    velocity: { x: state.velocity.x, y: state.velocity.y, z: state.velocity.z },
    grounded: state.grounded,
    timeOnGround: state.timeOnGround,
  };
}

function brakePlanar(x: number, z: number, dt: number): { x: number; z: number } {
  const speed = Math.hypot(x, z);
  if (speed <= REST_SPEED) return { x: 0, z: 0 };
  const next = speed * Math.exp(-GROUND_FRICTION * dt);
  if (next <= REST_SPEED) return { x: 0, z: 0 };
  const scale = next / speed;
  return { x: x * scale, z: z * scale };
}

function bleedUncommanded(
  x: number,
  z: number,
  wish: { x: number; z: number },
  wishSpeed: number,
  dt: number,
): { x: number; z: number } {
  const along = x * wish.x + z * wish.z;
  const perp = brakePlanar(x - along * wish.x, z - along * wish.z, dt);
  let nextAlong = along;
  if (along > wishSpeed) {
    nextAlong = wishSpeed + (along - wishSpeed) * Math.exp(-GROUND_FRICTION * dt);
  } else if (along < 0) {
    nextAlong = brakePlanar(along, 0, dt).x;
  }
  return { x: perp.x + wish.x * nextAlong, z: perp.z + wish.z * nextAlong };
}

function accelerate(
  x: number,
  z: number,
  wish: { x: number; z: number },
  wishSpeed: number,
  accel: number,
  dt: number,
): { x: number; z: number } {
  const along = x * wish.x + z * wish.z;
  const room = wishSpeed - along;
  if (room <= 0) return { x, z };
  const add = Math.min(room, accel * dt);
  return { x: x + wish.x * add, z: z + wish.z * add };
}

function capPlanar(x: number, z: number, cap: number): { x: number; z: number } {
  const speed = Math.hypot(x, z);
  if (speed <= cap || speed === 0) return { x, z };
  const scale = cap / speed;
  return { x: x * scale, z: z * scale };
}

interface Plane {
  normal: Vec3;
  d: number;
}

function rampPlane(ramp: RampSolid): Plane {
  const span = ramp.maxZ - ramp.minZ;
  const slope = span === 0 ? 0 : ramp.rise / span;
  const len = Math.hypot(1, slope);
  const normal = { x: 0, y: 1 / len, z: slope / len };
  const d = normal.y * ramp.yAtMaxZ + normal.z * ramp.maxZ;
  return { normal, d };
}

function restFeetY(x: number, z: number, plane: Plane): number {
  const n = plane.normal;
  return (CAPSULE_RADIUS * (1 - n.y) + plane.d - n.x * x - n.z * z) / n.y;
}

function highestWalkable(x: number, z: number, hull: Hull): { y: number; normal: Vec3 } {
  let best = { y: 0, normal: UP };
  for (const box of hull.boxes) {
    if (x < box.min.x || x > box.max.x || z < box.min.z || z > box.max.z) continue;
    if (box.max.y > best.y) best = { y: box.max.y, normal: UP };
  }
  for (const ramp of hull.ramps) {
    const plane = rampPlane(ramp);
    if (!isWalkableNormal(plane.normal.y)) continue;
    if (x < ramp.minX || x > ramp.maxX || z < ramp.minZ || z > ramp.maxZ) continue;
    const y = restFeetY(x, z, plane);
    if (y > best.y) best = { y, normal: plane.normal };
  }
  return best;
}

function isStep(box: BoxSolid, feetY: number): boolean {
  const rise = box.max.y - feetY;
  return rise > 0.001 && rise <= STEP_HEIGHT + 1e-4;
}

interface WallPush {
  depth: number;
  nx: number;
  nz: number;
  ny: number;
}

function circleRectPush(x: number, z: number, box: BoxSolid): WallPush | null {
  const { min, max } = box;
  const inside = x >= min.x && x <= max.x && z >= min.z && z <= max.z;
  if (inside) {
    const faces = [
      { depth: x - min.x + CAPSULE_RADIUS, nx: -1, nz: 0 },
      { depth: max.x - x + CAPSULE_RADIUS, nx: 1, nz: 0 },
      { depth: z - min.z + CAPSULE_RADIUS, nx: 0, nz: -1 },
      { depth: max.z - z + CAPSULE_RADIUS, nx: 0, nz: 1 },
    ];
    let best = faces[0]!;
    for (const face of faces) {
      if (face.depth < best.depth) best = face;
    }
    return { ...best, ny: 0 };
  }
  const cx = clamp(x, min.x, max.x);
  const cz = clamp(z, min.z, max.z);
  const dx = x - cx;
  const dz = z - cz;
  const dist = Math.hypot(dx, dz);
  if (dist >= CAPSULE_RADIUS || dist < 1e-10) return null;
  return { depth: CAPSULE_RADIUS - dist, nx: dx / dist, nz: dz / dist, ny: 0 };
}

function steepRampPush(x: number, y: number, z: number, ramp: RampSolid): WallPush | null {
  const plane = rampPlane(ramp);
  if (isWalkableNormal(plane.normal.y)) return null;
  if (x < ramp.minX - CAPSULE_RADIUS || x > ramp.maxX + CAPSULE_RADIUS) return null;
  if (z < ramp.minZ - CAPSULE_RADIUS || z > ramp.maxZ + CAPSULE_RADIUS) return null;
  const nearestX = clamp(x, ramp.minX, ramp.maxX);
  const nearestZ = clamp(z, ramp.minZ, ramp.maxZ);
  if ((x - nearestX) ** 2 + (z - nearestZ) ** 2 > CAPSULE_RADIUS ** 2) return null;
  const dist =
    plane.normal.x * x + plane.normal.y * (y + CAPSULE_RADIUS) + plane.normal.z * z - plane.d;
  if (dist >= CAPSULE_RADIUS) return null;
  return {
    depth: CAPSULE_RADIUS - dist,
    nx: plane.normal.x,
    ny: plane.normal.y,
    nz: plane.normal.z,
  };
}

function slideWalls(
  pos: Vec3,
  feetY: number,
  hull: Hull,
  canStep: boolean,
): { position: Vec3; wall: Vec3 | null } {
  let x = pos.x;
  let y = pos.y;
  let z = pos.z;
  let wall: Vec3 | null = null;
  for (let iter = 0; iter < 4; iter += 1) {
    let hit: WallPush | null = null;
    for (const box of hull.boxes) {
      if (feetY >= box.max.y - 0.02) continue;
      if (canStep && isStep(box, feetY)) continue;
      if (feetY + CAPSULE_HEIGHT <= box.min.y) continue;
      const push = circleRectPush(x, z, box);
      if (push && (!hit || push.depth > hit.depth)) hit = push;
    }
    for (const ramp of hull.ramps) {
      const push = steepRampPush(x, y, z, ramp);
      if (push && (!hit || push.depth > hit.depth)) hit = push;
    }
    if (!hit || hit.depth <= 1e-5) break;
    const slop = hit.depth + 1e-4;
    x += hit.nx * slop;
    y += hit.ny * slop;
    z += hit.nz * slop;
    wall = { x: hit.nx, y: hit.ny, z: hit.nz };
  }
  return { position: { x, y, z }, wall };
}

function collideMove(
  origin: Vec3,
  velocity: Vec3,
  dt: number,
  hull: Hull,
  jumping: boolean,
  wasGrounded: boolean,
): { position: Vec3; velocity: Vec3; grounded: boolean } {
  const canStep = wasGrounded && !jumping;
  const proposed = {
    x: origin.x + velocity.x * dt,
    y: origin.y,
    z: origin.z + velocity.z * dt,
  };
  const slid = slideWalls(proposed, origin.y, hull, canStep);
  let vx = velocity.x;
  let vy = velocity.y;
  let vz = velocity.z;
  if (slid.wall && slid.wall.y < WALK_Y) {
    const into = vx * slid.wall.x + vy * slid.wall.y + vz * slid.wall.z;
    if (into < 0) {
      vx -= slid.wall.x * into;
      vy -= slid.wall.y * into;
      vz -= slid.wall.z * into;
    }
  }

  const floor = highestWalkable(slid.position.x, slid.position.z, hull);
  if (canStep) {
    const rise = floor.y - origin.y;
    if (rise <= STEP_HEIGHT + 1e-4 && rise >= -STEP_HEIGHT - 1e-4) {
      return {
        position: { x: slid.position.x, y: floor.y, z: slid.position.z },
        velocity: { x: vx, y: 0, z: vz },
        grounded: true,
      };
    }
  }

  const nextY = origin.y + vy * dt;
  if (!jumping && vy <= 0 && origin.y + 0.03 >= floor.y && nextY <= floor.y + 0.03) {
    return {
      position: { x: slid.position.x, y: floor.y, z: slid.position.z },
      velocity: { x: vx, y: 0, z: vz },
      grounded: true,
    };
  }

  if (nextY <= 0 && vy <= 0) {
    return {
      position: { x: slid.position.x, y: 0, z: slid.position.z },
      velocity: { x: vx, y: 0, z: vz },
      grounded: true,
    };
  }

  // A steep face can shove the body upward. That shove should survive the
  // vertical step, but a normal fall has to keep the lower height.
  const y = slid.position.y > origin.y ? Math.max(nextY, slid.position.y) : nextY;
  return {
    position: { x: slid.position.x, y, z: slid.position.z },
    velocity: { x: vx, y: vy, z: vz },
    grounded: false,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
