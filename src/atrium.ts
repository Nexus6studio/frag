// Neon Atrium, the play space that replaces the flat test floor.
//
// World scale is 1 unit = 1 meter. The hull is boxes and ramp planes for the
// existing capsule step in move.ts. Nothing here changes that response: the
// kill plane is applied around the step, and surfaces are not stacked in the
// same column, because the walker stands on the highest surface it finds.
//
// Layout, centered on the origin, +X east, +Z south, -Z north:
//   well          10×10 m at y = 0, under the implicit ground plane
//   concourse     6 m ring around the well, at y = 0.8
//   parapet       2 m band at |coord| 11–13, top y = 6.6 (inner rail)
//   catwalk       outer 3 m (|coord| 13–16) at y = 5.3
//   NE/NW ramps   4.5 m rise over 4.8 m, climbing toward -Z onto the north ring
//   SE/SW stairs  0.50 m treads, 0.30 m rises, up to the east and west rings
// Walls close the 32×32 m footprint. Falling through the floor respawns on
// the south concourse.

import {
  CAPSULE_HEIGHT,
  CAPSULE_RADIUS,
  STEP_HEIGHT,
  createMoveState,
  stepMovement,
  type BoxSolid,
  type Hull,
  type MoveIntent,
  type MoveState,
  type RampSolid,
  type Vec3,
} from "./move.ts";

export const MAP_HALF = 16;
export const WELL_HALF = 5;
export const CONCOURSE = 11;
export const RING_INNER = 13;
export const GROUND_Y = 0.8;
export const RAMP_RISE = 4.5;
export const RAMP_RUN = 4.8;
export const CATWALK_Y = GROUND_Y + RAMP_RISE;
export const PARAPET_Y = 6.6;
export const CEILING_Y = 9;
export const KILL_Y = -1;
export const STAIR_DEPTH = 0.5;
export const STAIR_COUNT = 15;
export const STAIR_RISE = STEP_HEIGHT;

export const ATRIUM_SPAWN: Vec3 = { x: 0, y: GROUND_Y, z: 7.4 };

export type PadKind = "health" | "armor" | "ammo";

export interface AtriumPad {
  kind: PadKind;
  /** Feet-level position. Pads are visuals; they are not hulls. */
  position: Vec3;
}

export interface AtriumStair {
  id: "se" | "sw";
  /** +1 climbs toward +X, -1 toward -X. */
  dir: 1 | -1;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  lineZ: number;
}

export interface AtriumRamp {
  id: "ne" | "nw";
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  yLow: number;
  rise: number;
  lineX: number;
}

const STAIR_Z0 = 8.5;
const STAIR_Z1 = 10.7;
const STAIR_X0 = 1.6;

export const ATRIUM_STAIRS: readonly AtriumStair[] = [
  {
    id: "se",
    dir: 1,
    x0: STAIR_X0,
    x1: STAIR_X0 + STAIR_COUNT * STAIR_DEPTH,
    z0: STAIR_Z0,
    z1: STAIR_Z1,
    lineZ: (STAIR_Z0 + STAIR_Z1) / 2,
  },
  {
    id: "sw",
    dir: -1,
    x0: -STAIR_X0,
    x1: -(STAIR_X0 + STAIR_COUNT * STAIR_DEPTH),
    z0: STAIR_Z0,
    z1: STAIR_Z1,
    lineZ: (STAIR_Z0 + STAIR_Z1) / 2,
  },
];

export const ATRIUM_RAMPS: readonly AtriumRamp[] = [
  {
    id: "ne",
    minX: 7.6,
    maxX: 10.2,
    minZ: -CONCOURSE,
    maxZ: -CONCOURSE + RAMP_RUN,
    yLow: GROUND_Y,
    rise: RAMP_RISE,
    lineX: 8.9,
  },
  {
    id: "nw",
    minX: -10.2,
    maxX: -7.6,
    minZ: -CONCOURSE,
    maxZ: -CONCOURSE + RAMP_RUN,
    yLow: GROUND_Y,
    rise: RAMP_RISE,
    lineX: -8.9,
  },
];

export const ATRIUM_PADS: readonly AtriumPad[] = [
  { kind: "ammo", position: { x: 0, y: 0, z: 0 } },
  { kind: "health", position: { x: 0.5, y: GROUND_Y, z: 9.6 } },
  { kind: "armor", position: { x: -8.9, y: GROUND_Y, z: -5.45 } },
  { kind: "health", position: { x: 0, y: CATWALK_Y, z: 14.6 } },
  { kind: "armor", position: { x: 0, y: CATWALK_Y, z: -14.6 } },
  { kind: "ammo", position: { x: 14.15, y: CATWALK_Y, z: -3.4 } },
  { kind: "ammo", position: { x: 11.6, y: CATWALK_Y, z: -14.6 } },
];

export const ATRIUM_PILLARS: readonly { x: number; z: number; half: number; top: number }[] = [
  { x: 6.05, z: 6.05, half: 0.7, top: 4.1 },
  { x: 6.05, z: -6.05, half: 0.7, top: 4.1 },
  { x: -6.05, z: 6.05, half: 0.7, top: 4.1 },
  { x: -6.05, z: -6.05, half: 0.7, top: 4.1 },
];

export const ATRIUM_CRATES = {
  x0: 14.95,
  x1: 15.9,
  z0: 1.35,
  z1: 2.55,
  y0: CATWALK_Y,
  height: 1.05,
} as const;

const WALL = 0.45;

function box(boxes: BoxSolid[], x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
  boxes.push({
    min: { x: Math.min(x0, x1), y: Math.min(y0, y1), z: Math.min(z0, z1) },
    max: { x: Math.max(x0, x1), y: Math.max(y0, y1), z: Math.max(z0, z1) },
  });
}

function stairBoxes(boxes: BoxSolid[], stair: AtriumStair): void {
  const z0 = Math.min(stair.z0, stair.z1);
  const z1 = Math.max(stair.z0, stair.z1);
  for (let i = 0; i < STAIR_COUNT; i += 1) {
    const along0 = i * STAIR_DEPTH;
    const along1 = (i + 1) * STAIR_DEPTH;
    const x0 = stair.dir === 1 ? stair.x0 + along0 : stair.x0 - along1;
    const x1 = stair.dir === 1 ? stair.x0 + along1 : stair.x0 - along0;
    box(boxes, x0, x1, 0, GROUND_Y + (i + 1) * STAIR_RISE, z0, z1);
  }
  const landFar = stair.dir === 1 ? RING_INNER + 0.15 : -(RING_INNER + 0.15);
  box(boxes, stair.x1, landFar, 0, CATWALK_Y, z0, z1);
}

function buildHull(): Hull {
  const boxes: BoxSolid[] = [];
  const ramps: RampSolid[] = [];

  box(boxes, -WELL_HALF, WELL_HALF, -0.4, 0, -WELL_HALF, WELL_HALF);

  box(boxes, -CONCOURSE, CONCOURSE, 0, GROUND_Y, WELL_HALF, CONCOURSE);
  box(boxes, -CONCOURSE, CONCOURSE, 0, GROUND_Y, -CONCOURSE, -WELL_HALF);
  box(boxes, -CONCOURSE, -WELL_HALF, 0, GROUND_Y, -WELL_HALF, WELL_HALF);
  box(boxes, WELL_HALF, CONCOURSE, 0, GROUND_Y, -WELL_HALF, WELL_HALF);

  box(boxes, -MAP_HALF, MAP_HALF, 0, CATWALK_Y, RING_INNER, MAP_HALF);
  box(boxes, -MAP_HALF, MAP_HALF, 0, CATWALK_Y, -MAP_HALF, -RING_INNER);
  box(boxes, RING_INNER, MAP_HALF, 0, CATWALK_Y, -RING_INNER, RING_INNER);
  box(boxes, -MAP_HALF, -RING_INNER, 0, CATWALK_Y, -RING_INNER, RING_INNER);

  box(boxes, -RING_INNER, RING_INNER, 0, PARAPET_Y, CONCOURSE, RING_INNER);
  // North parapet, split around the two ramp bridges.
  box(boxes, -RING_INNER, -10.2, 0, PARAPET_Y, -RING_INNER, -CONCOURSE);
  box(boxes, -7.6, 7.6, 0, PARAPET_Y, -RING_INNER, -CONCOURSE);
  box(boxes, 10.2, RING_INNER, 0, PARAPET_Y, -RING_INNER, -CONCOURSE);
  // East parapet, split around the SE landing.
  box(boxes, CONCOURSE, RING_INNER, 0, PARAPET_Y, -CONCOURSE, STAIR_Z0);
  box(boxes, CONCOURSE, RING_INNER, 0, PARAPET_Y, STAIR_Z1, CONCOURSE);
  // West parapet, split around the SW landing.
  box(boxes, -RING_INNER, -CONCOURSE, 0, PARAPET_Y, -CONCOURSE, STAIR_Z0);
  box(boxes, -RING_INNER, -CONCOURSE, 0, PARAPET_Y, STAIR_Z1, CONCOURSE);

  for (const ramp of ATRIUM_RAMPS) {
    ramps.push({
      minX: ramp.minX,
      maxX: ramp.maxX,
      minZ: ramp.minZ,
      maxZ: ramp.maxZ,
      yAtMaxZ: ramp.yLow,
      rise: ramp.rise,
    });
    box(boxes, ramp.minX, ramp.maxX, 0, CATWALK_Y, -RING_INNER, ramp.minZ);
    box(boxes, ramp.minX - 0.18, ramp.minX, GROUND_Y, PARAPET_Y, ramp.minZ, ramp.maxZ);
    box(boxes, ramp.maxX, ramp.maxX + 0.18, GROUND_Y, PARAPET_Y, ramp.minZ, ramp.maxZ);
  }

  for (const stair of ATRIUM_STAIRS) stairBoxes(boxes, stair);

  for (const pillar of ATRIUM_PILLARS) {
    box(
      boxes,
      pillar.x - pillar.half,
      pillar.x + pillar.half,
      GROUND_Y,
      pillar.top,
      pillar.z - pillar.half,
      pillar.z + pillar.half,
    );
  }

  box(boxes, ATRIUM_CRATES.x0, ATRIUM_CRATES.x1, ATRIUM_CRATES.y0, ATRIUM_CRATES.y0 + ATRIUM_CRATES.height, ATRIUM_CRATES.z0, ATRIUM_CRATES.z1);
  box(
    boxes,
    ATRIUM_CRATES.x0,
    ATRIUM_CRATES.x1,
    ATRIUM_CRATES.y0 + ATRIUM_CRATES.height,
    ATRIUM_CRATES.y0 + ATRIUM_CRATES.height * 2,
    ATRIUM_CRATES.z0,
    ATRIUM_CRATES.z1,
  );

  box(boxes, 1.7, 3.5, 0, 0.28, -2.55, -2.15);

  box(boxes, -MAP_HALF, MAP_HALF, 0, CEILING_Y, MAP_HALF, MAP_HALF + WALL);
  box(boxes, -MAP_HALF, MAP_HALF, 0, CEILING_Y, -(MAP_HALF + WALL), -MAP_HALF);
  box(boxes, MAP_HALF, MAP_HALF + WALL, 0, CEILING_Y, -MAP_HALF, MAP_HALF);
  box(boxes, -(MAP_HALF + WALL), -MAP_HALF, 0, CEILING_Y, -MAP_HALF, MAP_HALF);

  return { boxes, ramps };
}

const HULL = buildHull();

export function createAtriumHull(): Hull {
  return HULL;
}

export function needsRespawn(position: Vec3): boolean {
  return (
    position.y < KILL_Y ||
    Math.abs(position.x) > MAP_HALF + 1.25 ||
    Math.abs(position.z) > MAP_HALF + 1.25
  );
}

export function respawnState(): MoveState {
  return createMoveState(ATRIUM_SPAWN);
}

export function stepAtrium(state: MoveState, intent: MoveIntent, dt: number): MoveState {
  if (needsRespawn(state.position)) return respawnState();
  const next = stepMovement(state, intent, dt, HULL);
  if (needsRespawn(next.position)) return respawnState();
  return next;
}

/** True when the capsule at `feet` is not inside a wall, rail, stair, or prop. */
export function capsuleClear(feet: Vec3, hull: Hull = HULL): boolean {
  const head = feet.y + CAPSULE_HEIGHT - 0.04;
  const radius = CAPSULE_RADIUS - 0.02;
  for (const solid of hull.boxes) {
    if (solid.max.y <= feet.y + 0.05) continue;
    if (solid.min.y >= head) continue;
    if (circleHitsRect(feet.x, feet.z, radius, solid.min.x, solid.max.x, solid.min.z, solid.max.z)) {
      return false;
    }
  }
  return true;
}

function circleHitsRect(
  x: number,
  z: number,
  radius: number,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
): boolean {
  const cx = Math.min(Math.max(x, minX), maxX);
  const cz = Math.min(Math.max(z, minZ), maxZ);
  const dx = x - cx;
  const dz = z - cz;
  return dx * dx + dz * dz < radius * radius;
}

export function onGroundRing(position: Vec3): boolean {
  const outsideWell = Math.abs(position.x) > WELL_HALF + 0.2 || Math.abs(position.z) > WELL_HALF + 0.2;
  const insideRing =
    Math.abs(position.x) <= CONCOURSE - 0.2 &&
    Math.abs(position.z) <= CONCOURSE - 0.2 &&
    (Math.abs(position.x) >= WELL_HALF + 0.3 || Math.abs(position.z) >= WELL_HALF + 0.3);
  return outsideWell && insideRing && Math.abs(position.y - GROUND_Y) < 0.05;
}
