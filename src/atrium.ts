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
//   SE/SW stairs  0.50 m treads, 0.30 m rises, climbing +Z off the ground ring
//                 onto landings that meet the east and west catwalks
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
  /** Feet-level position. Pads are not hulls; pickups.ts tests the capsule against a trigger. */
  position: Vec3;
}

export interface AtriumStair {
  id: "se" | "sw";
  /** Cross-axis bounds. The flight is this wide in X and climbs toward +Z. */
  x0: number;
  x1: number;
  /** Z of the low end, where the first riser leaves the ground ring. */
  z0: number;
  /** Outer X of the upper landing, on the catwalk side of the parapet. */
  landFar: number;
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

/**
 * Low end of both south flights. An east-west flight used to sit at z = 8.5,
 * so its north face was one plain wall from about x = -13 to x = -2. A capsule
 * walking south on the ground ring stopped at z = 8.5 - radius (8.15) and could
 * not reach the upper ring. The flights now climb south from this mouth, and
 * the tall side sits against the outer parapet instead of across the concourse.
 */
export const STAIR_MOUTH_Z = 2.4;
/** Z where the last riser reaches the catwalk, and the landing turns outward. */
export const STAIR_LAND_Z0 = STAIR_MOUTH_Z + (STAIR_COUNT - 1) * STAIR_DEPTH;
/** Landing runs into the south parapet so the doorway has no gap at the seam. */
export const STAIR_LAND_Z1 = CONCOURSE + 0.02;

const FLIGHT_WEST_X0 = -11.02;
const FLIGHT_WEST_X1 = -8.75;
const FLIGHT_EAST_X0 = 8.75;
const FLIGHT_EAST_X1 = 11.02;

export const ATRIUM_STAIRS: readonly AtriumStair[] = [
  {
    id: "sw",
    x0: FLIGHT_WEST_X0,
    x1: FLIGHT_WEST_X1,
    z0: STAIR_MOUTH_Z,
    landFar: -(RING_INNER + 0.15),
  },
  {
    id: "se",
    x0: FLIGHT_EAST_X0,
    x1: FLIGHT_EAST_X1,
    z0: STAIR_MOUTH_Z,
    landFar: RING_INNER + 0.15,
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

/** Treads, the flat top, and the landing. The same boxes are drawn in floor.ts. */
export function stairCollisionBoxes(stair: AtriumStair): BoxSolid[] {
  const boxes: BoxSolid[] = [];
  const x0 = Math.min(stair.x0, stair.x1);
  const x1 = Math.max(stair.x0, stair.x1);
  for (let i = 0; i < STAIR_COUNT; i += 1) {
    const zLo = stair.z0 + i * STAIR_DEPTH;
    const zHi = stair.z0 + (i + 1) * STAIR_DEPTH;
    box(boxes, x0, x1, 0, GROUND_Y + (i + 1) * STAIR_RISE, zLo, zHi);
  }
  const flightEnd = stair.z0 + STAIR_COUNT * STAIR_DEPTH;
  box(boxes, x0, x1, 0, CATWALK_Y, flightEnd, STAIR_LAND_Z1);
  const landNear = stair.landFar < x0 ? x0 : x1;
  box(boxes, landNear, stair.landFar, 0, CATWALK_Y, STAIR_LAND_Z0, STAIR_LAND_Z1);
  return boxes;
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
  // East and west parapets stop at the landing so the stair doorway stays open
  // up to the south parapet. The landing solid fills that doorway at catwalk height.
  box(boxes, CONCOURSE, RING_INNER, 0, PARAPET_Y, -CONCOURSE, STAIR_LAND_Z0);
  box(boxes, -RING_INNER, -CONCOURSE, 0, PARAPET_Y, -CONCOURSE, STAIR_LAND_Z0);

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
    // No rail on the parapet side: that crack was narrower than the capsule and
    // pinned the NW corner at full wish speed. The well-side rail sits on the
    // deck so the pillar beside the foot still leaves a gap the body can walk.
    const againstParapet = ramp.minX < 0 ? "west" : "east";
    if (againstParapet !== "west") {
      box(boxes, ramp.minX, ramp.minX + 0.18, GROUND_Y, PARAPET_Y, ramp.minZ, ramp.maxZ);
    }
    if (againstParapet !== "east") {
      box(boxes, ramp.maxX - 0.18, ramp.maxX, GROUND_Y, PARAPET_Y, ramp.minZ, ramp.maxZ);
    }
  }

  for (const stair of ATRIUM_STAIRS) boxes.push(...stairCollisionBoxes(stair));

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
