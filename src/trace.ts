// Segment tests against a movement hull.
//
// Projectiles (later) need to ask the same boxes and ramp planes the capsule
// walks on. This does not move the body and does not change the step in move.ts.
// A ramp hit is the sloped plane clipped to the ramp's rectangle. A box hit is
// the first face of the AABB. The closest intersection wins.

import type { BoxSolid, Hull, RampSolid, Vec3 } from "./move";

export interface TraceHit {
  /** 0 at the segment start, 1 at the segment end. */
  t: number;
  distance: number;
  point: Vec3;
  normal: Vec3;
}

export function traceSegment(from: Vec3, to: Vec3, hull: Hull): TraceHit | null {
  const delta = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  const span = Math.hypot(delta.x, delta.y, delta.z);
  let bestT = Infinity;
  let bestNormal: Vec3 | null = null;

  for (const solid of hull.boxes) {
    const hit = traceBox(from, delta, solid);
    if (hit && hit.t < bestT) {
      bestT = hit.t;
      bestNormal = hit.normal;
    }
  }
  for (const ramp of hull.ramps) {
    const hit = traceRamp(from, delta, ramp);
    if (hit && hit.t < bestT) {
      bestT = hit.t;
      bestNormal = hit.normal;
    }
  }

  if (!bestNormal || bestT > 1) return null;
  return {
    t: bestT,
    distance: span * bestT,
    point: {
      x: from.x + delta.x * bestT,
      y: from.y + delta.y * bestT,
      z: from.z + delta.z * bestT,
    },
    normal: bestNormal,
  };
}

/** Ray from `origin` along `direction` (any length) out to `maxDistance`. */
export function traceRay(origin: Vec3, direction: Vec3, maxDistance: number, hull: Hull): TraceHit | null {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (length < 1e-8 || !(maxDistance > 0)) return null;
  const scale = maxDistance / length;
  return traceSegment(
    origin,
    {
      x: origin.x + direction.x * scale,
      y: origin.y + direction.y * scale,
      z: origin.z + direction.z * scale,
    },
    hull,
  );
}

function traceBox(origin: Vec3, delta: Vec3, box: BoxSolid): { t: number; normal: Vec3 } | null {
  let tEnter = 0;
  let tExit = 1;
  let normal: Vec3 = { x: 0, y: 1, z: 0 };
  const axes = [
    ["x", origin.x, delta.x, box.min.x, box.max.x],
    ["y", origin.y, delta.y, box.min.y, box.max.y],
    ["z", origin.z, delta.z, box.min.z, box.max.z],
  ] as const;

  for (const [axis, start, travel, min, max] of axes) {
    if (Math.abs(travel) < 1e-12) {
      if (start < min || start > max) return null;
      continue;
    }
    let t1 = (min - start) / travel;
    let t2 = (max - start) / travel;
    let facing: -1 | 1 = -1;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
      facing = 1;
    }
    if (t1 > tEnter) {
      tEnter = t1;
      normal = { x: 0, y: 0, z: 0, [axis]: facing };
    }
    if (t2 < tExit) tExit = t2;
    if (tEnter > tExit) return null;
  }

  if (tExit < 0 || tEnter > 1) return null;
  if (tEnter < 0) return { t: 0, normal };
  return { t: tEnter, normal };
}

function traceRamp(origin: Vec3, delta: Vec3, ramp: RampSolid): { t: number; normal: Vec3 } | null {
  const span = ramp.maxZ - ramp.minZ;
  const slope = span === 0 ? 0 : ramp.rise / span;
  const len = Math.hypot(1, slope);
  const ny = 1 / len;
  const nz = slope / len;
  const planeD = ny * ramp.yAtMaxZ + nz * ramp.maxZ;
  const denom = ny * delta.y + nz * delta.z;
  if (Math.abs(denom) < 1e-8) return null;
  const t = (planeD - (ny * origin.y + nz * origin.z)) / denom;
  if (t < 0 || t > 1) return null;
  const x = origin.x + delta.x * t;
  const z = origin.z + delta.z * t;
  if (x < ramp.minX - 1e-4 || x > ramp.maxX + 1e-4) return null;
  if (z < ramp.minZ - 1e-4 || z > ramp.maxZ + 1e-4) return null;
  const sign = denom < 0 ? 1 : -1;
  return { t, normal: { x: 0, y: ny * sign, z: nz * sign } };
}
