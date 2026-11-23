// Segment tests against a movement hull.
//
// Flechettes ask the same boxes and ramp planes the capsule walks on. This
// does not move the body and does not change the step in move.ts. A ramp hit
// is the sloped plane clipped to the ramp's rectangle. A box hit is the first
// face of the AABB. The closest intersection wins.
//
// Pass `out` to reuse one hit record. The scratch used along the way is shared,
// so a trace must finish before another trace starts.

import type { BoxSolid, Hull, RampSolid, Vec3 } from "./move";

export interface TraceHit {
  /** 0 at the segment start, 1 at the segment end. */
  t: number;
  distance: number;
  point: Vec3;
  normal: Vec3;
}

const delta = { x: 0, y: 0, z: 0 };
const face = { t: 0, x: 0, y: 0, z: 0 };
const rayEnd = { x: 0, y: 0, z: 0 };
const axisStart = new Float64Array(3);
const axisTravel = new Float64Array(3);
const axisMin = new Float64Array(3);
const axisMax = new Float64Array(3);

export function traceSegment(from: Vec3, to: Vec3, hull: Hull, out?: TraceHit): TraceHit | null {
  delta.x = to.x - from.x;
  delta.y = to.y - from.y;
  delta.z = to.z - from.z;
  const span = Math.hypot(delta.x, delta.y, delta.z);
  let bestT = Infinity;
  let bestX = 0;
  let bestY = 0;
  let bestZ = 0;
  let found = false;

  const boxes = hull.boxes;
  for (let i = 0; i < boxes.length; i += 1) {
    if (!traceBox(from, delta, boxes[i]!)) continue;
    if (face.t < bestT) {
      bestT = face.t;
      bestX = face.x;
      bestY = face.y;
      bestZ = face.z;
      found = true;
    }
  }
  const ramps = hull.ramps;
  for (let i = 0; i < ramps.length; i += 1) {
    if (!traceRamp(from, delta, ramps[i]!)) continue;
    if (face.t < bestT) {
      bestT = face.t;
      bestX = face.x;
      bestY = face.y;
      bestZ = face.z;
      found = true;
    }
  }

  if (!found || bestT > 1) return null;
  const hit = out ?? {
    t: 0,
    distance: 0,
    point: { x: 0, y: 0, z: 0 },
    normal: { x: 0, y: 0, z: 0 },
  };
  hit.t = bestT;
  hit.distance = span * bestT;
  hit.point.x = from.x + delta.x * bestT;
  hit.point.y = from.y + delta.y * bestT;
  hit.point.z = from.z + delta.z * bestT;
  hit.normal.x = bestX;
  hit.normal.y = bestY;
  hit.normal.z = bestZ;
  return hit;
}

/** Ray from `origin` along `direction` (any length) out to `maxDistance`. */
export function traceRay(
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
  hull: Hull,
  out?: TraceHit,
): TraceHit | null {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (length < 1e-8 || !(maxDistance > 0)) return null;
  const scale = maxDistance / length;
  rayEnd.x = origin.x + direction.x * scale;
  rayEnd.y = origin.y + direction.y * scale;
  rayEnd.z = origin.z + direction.z * scale;
  return traceSegment(origin, rayEnd, hull, out);
}

function traceBox(origin: Vec3, step: Vec3, box: BoxSolid): boolean {
  axisStart[0] = origin.x;
  axisStart[1] = origin.y;
  axisStart[2] = origin.z;
  axisTravel[0] = step.x;
  axisTravel[1] = step.y;
  axisTravel[2] = step.z;
  axisMin[0] = box.min.x;
  axisMin[1] = box.min.y;
  axisMin[2] = box.min.z;
  axisMax[0] = box.max.x;
  axisMax[1] = box.max.y;
  axisMax[2] = box.max.z;

  let tEnter = 0;
  let tExit = 1;
  let nx = 0;
  let ny = 1;
  let nz = 0;

  for (let axis = 0; axis < 3; axis += 1) {
    const start = axisStart[axis]!;
    const travel = axisTravel[axis]!;
    const lo = axisMin[axis]!;
    const hi = axisMax[axis]!;
    if (Math.abs(travel) < 1e-12) {
      if (start < lo || start > hi) return false;
      continue;
    }
    let t1 = (lo - start) / travel;
    let t2 = (hi - start) / travel;
    let facing: -1 | 1 = -1;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
      facing = 1;
    }
    if (t1 > tEnter) {
      tEnter = t1;
      nx = 0;
      ny = 0;
      nz = 0;
      if (axis === 0) nx = facing;
      else if (axis === 1) ny = facing;
      else nz = facing;
    }
    if (t2 < tExit) tExit = t2;
    if (tEnter > tExit) return false;
  }

  if (tExit < 0 || tEnter > 1) return false;
  face.t = tEnter < 0 ? 0 : tEnter;
  face.x = nx;
  face.y = ny;
  face.z = nz;
  return true;
}

function traceRamp(origin: Vec3, step: Vec3, ramp: RampSolid): boolean {
  const span = ramp.maxZ - ramp.minZ;
  const slope = span === 0 ? 0 : ramp.rise / span;
  const len = Math.hypot(1, slope);
  const ny = 1 / len;
  const nz = slope / len;
  const planeD = ny * ramp.yAtMaxZ + nz * ramp.maxZ;
  const denom = ny * step.y + nz * step.z;
  if (Math.abs(denom) < 1e-8) return false;
  const t = (planeD - (ny * origin.y + nz * origin.z)) / denom;
  if (t < 0 || t > 1) return false;
  const x = origin.x + step.x * t;
  const z = origin.z + step.z * t;
  if (x < ramp.minX - 1e-4 || x > ramp.maxX + 1e-4) return false;
  if (z < ramp.minZ - 1e-4 || z > ramp.maxZ + 1e-4) return false;
  const sign = denom < 0 ? 1 : -1;
  face.t = t;
  face.x = 0;
  face.y = ny * sign;
  face.z = nz * sign;
  return true;
}
