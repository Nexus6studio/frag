// Walking, jumping, and capsule collision for the test floor.
//
// The body is a vertical capsule. Callers pass the current state, a wish
// (forward / strafe / jump / yaw), and a timestep. The function returns a new
// state and does not read the clock, the DOM, or three.js, so the same step
// runs in the browser and in headless tests.
//
// Ground movement steers the horizontal velocity toward a wish of fixed length.
// Forward, back, strafe, and diagonals share that length. With no wish, drag
// and a small constant brake bleed speed off until a rest threshold, so a full
// stop takes about a third of a second. For a short grace after landing, that
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
/**
 * Frames longer than this are dropped instead of simulated. A tab switch can
 * stall for seconds; a 20 fps frame (50 ms) must still run in real time.
 */
export const MAX_FRAME_SECONDS = 0.25;

/** Below this, braking snaps to rest. High enough to finish a stop, low enough that a wall clip does not stick. */
const REST_SPEED = 0.45;
/**
 * Constant deceleration added only when no direction is held. Friction stays 6/s;
 * this term brings an 8 m/s coast to rest at about 0.30 s.
 */
const STOP_ACCEL = 6.6;
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
  // Nearby faces redirect the wish along the free direction. When every face
  // opposes the wish, there is no slide and the corner can come to rest.
  const canStep = startedGrounded && !intent.jump;
  const contacts =
    startedGrounded && wish
      ? wallNormals(state.position, state.position.y, hull, canStep, CONTACT_SKIN)
      : [];
  const projected = contacts.length > 0 ? projectPlanar(wish!, contacts) : null;
  const steered = contacts.length > 0 ? projected : wish;

  if (startedGrounded) {
    if (!grace) {
      if (steered) {
        const bled = bleedUncommanded(vx, vz, steered, GROUND_WISH_SPEED, dt);
        vx = bled.x;
        vz = bled.z;
      } else {
        const stopped = brakePlanar(vx, vz, dt, STOP_ACCEL);
        vx = stopped.x;
        vz = stopped.z;
      }
    }
    if (steered) {
      const sped = accelerate(vx, vz, steered, GROUND_WISH_SPEED, GROUND_ACCEL, dt);
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
  }

  const moved = collideMove(
    state.position,
    { x: vx, y: vy, z: vz },
    dt,
    hull,
    vy > 0,
    startedGrounded,
    !startedGrounded || intent.jump,
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
      const clamped = Number.isFinite(frameSeconds)
        ? Math.min(Math.max(frameSeconds, 0), MAX_FRAME_SECONDS)
        : 0;
      accumulator += clamped;
      // Enough steps to consume a full clamped frame. The sub-step remainder stays
      // in the accumulator so a 20 fps delta is not rounded down into slow motion.
      const maxSteps = Math.ceil(MAX_FRAME_SECONDS / SIM_DT) + 2;
      let steps = 0;
      while (accumulator >= SIM_DT && steps < maxSteps) {
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

function brakePlanar(
  x: number,
  z: number,
  dt: number,
  stopAccel = 0,
): { x: number; z: number } {
  const speed = Math.hypot(x, z);
  if (speed <= REST_SPEED) return { x: 0, z: 0 };
  // dv/dt = -friction * v - stopAccel. stopAccel is zero while a wish is held,
  // so steering drag stays the exponential term alone.
  const next =
    stopAccel > 0
      ? (speed + stopAccel / GROUND_FRICTION) * Math.exp(-GROUND_FRICTION * dt) -
        stopAccel / GROUND_FRICTION
      : speed * Math.exp(-GROUND_FRICTION * dt);
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

/** How far outside a surface still counts as contact, so a slide keeps its wish. */
const CONTACT_SKIN = 0.02;

function projectPlanar(wish: { x: number; z: number }, normals: Vec3[]): { x: number; z: number } | null {
  let x = wish.x;
  let z = wish.z;
  for (const normal of normals) {
    if (normal.y >= WALK_Y) continue;
    const horizontal = Math.hypot(normal.x, normal.z);
    if (horizontal < 1e-8) continue;
    const nx = normal.x / horizontal;
    const nz = normal.z / horizontal;
    const into = x * nx + z * nz;
    if (into < 0) {
      x -= nx * into;
      z -= nz * into;
    }
  }
  const length = Math.hypot(x, z);
  if (length < 1e-6) return null;
  return { x: x / length, z: z / length };
}

/** Capsule circle against a box. Faces stay axis-aligned; a real corner uses the direction off that corner so the body can slide out of a gap. */
function boxPush(x: number, z: number, box: BoxSolid, padding = 0): WallPush | null {
  const reach = CAPSULE_RADIUS + padding;
  const { min, max } = box;
  const inside = x >= min.x && x <= max.x && z >= min.z && z <= max.z;
  if (inside) {
    const faces = [
      { depth: x - min.x + reach, nx: -1, nz: 0 },
      { depth: max.x - x + reach, nx: 1, nz: 0 },
      { depth: z - min.z + reach, nx: 0, nz: -1 },
      { depth: max.z - z + reach, nx: 0, nz: 1 },
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
  if (dist >= reach || dist < 1e-10) return null;
  return { depth: reach - dist, nx: dx / dist, nz: dz / dist, ny: 0 };
}

function steepRampPush(
  x: number,
  y: number,
  z: number,
  ramp: RampSolid,
  padding = 0,
): WallPush | null {
  const plane = rampPlane(ramp);
  if (isWalkableNormal(plane.normal.y)) return null;
  const reach = CAPSULE_RADIUS + padding;
  if (x < ramp.minX - reach || x > ramp.maxX + reach) return null;
  if (z < ramp.minZ - reach || z > ramp.maxZ + reach) return null;
  const nearestX = clamp(x, ramp.minX, ramp.maxX);
  const nearestZ = clamp(z, ramp.minZ, ramp.maxZ);
  if ((x - nearestX) ** 2 + (z - nearestZ) ** 2 > reach * reach) return null;
  const dist =
    plane.normal.x * x + plane.normal.y * (y + CAPSULE_RADIUS) + plane.normal.z * z - plane.d;
  if (dist >= reach) return null;
  return {
    depth: reach - dist,
    nx: plane.normal.x,
    ny: plane.normal.y,
    nz: plane.normal.z,
  };
}

function considerWall(
  hit: WallPush | null,
  push: WallPush | null,
): WallPush | null {
  if (!push || push.depth <= 1e-5) return hit;
  if (!hit || push.depth > hit.depth) return push;
  return hit;
}

function deepestWall(
  x: number,
  y: number,
  z: number,
  feetY: number,
  hull: Hull,
  canStep: boolean,
  padding: number,
): WallPush | null {
  let hit: WallPush | null = null;
  for (const box of hull.boxes) {
    if (feetY >= box.max.y - 0.02) continue;
    if (canStep && isStep(box, feetY)) continue;
    if (feetY + CAPSULE_HEIGHT <= box.min.y) continue;
    hit = considerWall(hit, boxPush(x, z, box, padding));
  }
  for (const ramp of hull.ramps) {
    hit = considerWall(hit, steepRampPush(x, y, z, ramp, padding));
  }
  return hit;
}

function wallNormals(pos: Vec3, feetY: number, hull: Hull, canStep: boolean, padding: number): Vec3[] {
  const normals: Vec3[] = [];
  for (const box of hull.boxes) {
    if (feetY >= box.max.y - 0.02) continue;
    if (canStep && isStep(box, feetY)) continue;
    if (feetY + CAPSULE_HEIGHT <= box.min.y) continue;
    const push = boxPush(pos.x, pos.z, box, padding);
    if (push && push.depth > 1e-5) normals.push({ x: push.nx, y: 0, z: push.nz });
  }
  for (const ramp of hull.ramps) {
    const push = steepRampPush(pos.x, feetY, pos.z, ramp, padding);
    if (push && push.depth > 1e-5) normals.push({ x: push.nx, y: push.ny, z: push.nz });
  }
  return normals;
}

function clipAgainst(velocity: Vec3, normal: Vec3): Vec3 {
  if (normal.y >= WALK_Y) return velocity;
  const into = velocity.x * normal.x + velocity.y * normal.y + velocity.z * normal.z;
  if (into >= 0) return velocity;
  return {
    x: velocity.x - normal.x * into,
    y: velocity.y - normal.y * into,
    z: velocity.z - normal.z * into,
  };
}

function slideWalls(
  pos: Vec3,
  velocity: Vec3,
  feetY: number,
  hull: Hull,
  canStep: boolean,
): { position: Vec3; velocity: Vec3 } {
  let x = pos.x;
  let y = pos.y;
  let z = pos.z;
  let next = { x: velocity.x, y: velocity.y, z: velocity.z };
  for (let iter = 0; iter < 4; iter += 1) {
    const hit = deepestWall(x, y, z, feetY, hull, canStep, 0);
    if (!hit) break;
    const slop = hit.depth + 1e-4;
    x += hit.nx * slop;
    y += hit.ny * slop;
    z += hit.nz * slop;
    // Every contact drops the into-normal part of the stored velocity.
    // Clipping only the last face left a corner pinned at full planar speed.
    next = clipAgainst(next, { x: hit.nx, y: hit.ny, z: hit.nz });
  }
  // A face you are resting on, not just one you penetrated this step.
  const resting = wallNormals({ x, y, z }, feetY, hull, canStep, CONTACT_SKIN);
  for (const normal of resting) next = clipAgainst(next, normal);
  return { position: { x, y, z }, velocity: next };
}

function overlapsFootprint(x: number, z: number, box: BoxSolid): boolean {
  const cx = clamp(x, box.min.x, box.max.x);
  const cz = clamp(z, box.min.z, box.max.z);
  const dx = x - cx;
  const dz = z - cz;
  const reach = CAPSULE_RADIUS + 1e-3;
  return dx * dx + dz * dz <= reach * reach;
}

/**
 * A standing jump clears 1.156 m, but the lip is a vertical face and the
 * capsule blocks on its radius until the feet are above the top. Air accel
 * cannot cover that radius before the feet fall back under 0.8 m, so the
 * front edge has to catch the lip: if the circle already touches a ledge
 * the remaining jump can clear, step onto it.
 */
function mantleLanding(
  x: number,
  z: number,
  feetY: number,
  velocity: Vec3,
  hull: Hull,
): Vec3 | null {
  if (!(velocity.y > 0)) return null;
  const apex = feetY + (velocity.y * velocity.y) / (2 * GRAVITY);
  let best: BoxSolid | null = null;
  for (const box of hull.boxes) {
    const top = box.max.y;
    if (top <= feetY + 0.04) continue;
    if (top > apex + 1e-3) continue;
    if (feetY + CAPSULE_HEIGHT <= box.min.y) continue;
    if (!overlapsFootprint(x, z, box)) continue;
    if (!best || top > best.max.y) best = box;
  }
  if (!best) return null;
  const inside = x >= best.min.x && x <= best.max.x && z >= best.min.z && z <= best.max.z;
  if (inside) return { x, y: best.max.y, z };
  const cx = clamp(x, best.min.x, best.max.x);
  const cz = clamp(z, best.min.z, best.max.z);
  const dx = cx - x;
  const dz = cz - z;
  if (velocity.x * dx + velocity.z * dz <= 1e-8) return null;
  const len = Math.hypot(dx, dz) || 1;
  return { x: cx + (dx / len) * 0.05, y: best.max.y, z: cz + (dz / len) * 0.05 };
}

function collideMove(
  origin: Vec3,
  velocity: Vec3,
  dt: number,
  hull: Hull,
  jumping: boolean,
  wasGrounded: boolean,
  useGravity: boolean,
): { position: Vec3; velocity: Vec3; grounded: boolean } {
  const canStep = wasGrounded && !jumping;
  if (jumping && velocity.y > 0) {
    const mantled = mantleLanding(origin.x, origin.z, origin.y, velocity, hull);
    if (mantled) {
      const onto = slideWalls(mantled, velocity, mantled.y, hull, false);
      return {
        position: { x: onto.position.x, y: mantled.y, z: onto.position.z },
        velocity: { x: onto.velocity.x, y: 0, z: onto.velocity.z },
        grounded: true,
      };
    }
  }
  const proposed = {
    x: origin.x + velocity.x * dt,
    y: origin.y,
    z: origin.z + velocity.z * dt,
  };
  const slid = slideWalls(proposed, velocity, origin.y, hull, canStep);
  let vx = slid.velocity.x;
  let vy = slid.velocity.y;
  let vz = slid.velocity.z;

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

  // Constant acceleration over the step: position uses the average velocity,
  // so a 6.8 m/s jump under gravity 20 peaks at v²/2g instead of a step high.
  let yDelta = vy * dt;
  if (useGravity) {
    yDelta = vy * dt - 0.5 * GRAVITY * dt * dt;
    vy -= GRAVITY * dt;
  }
  const nextY = origin.y + yDelta;
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
