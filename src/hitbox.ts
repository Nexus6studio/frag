// Targets a projectile can damage.
//
// The Quill Driver sweeps each flechette against this list. Future enemies
// register a sphere or a box and take the hit in `onHit`. The center and the
// box corners are read live, so a moving owner can write new coordinates
// into the same objects. Registration is not on the shot path.

import type { Vec3 } from "./move.ts";

export interface HitboxAabb {
  min: Vec3;
  max: Vec3;
}

export interface HitboxSpec {
  center: Vec3;
  /** Sphere radius, in meters. Used when `aabb` is omitted. */
  radius?: number;
  /** World-space box. When present, this is the volume instead of `radius`. */
  aabb?: HitboxAabb;
  onHit: (damage: number) => void;
}

export interface HitboxHandle {
  setActive(active: boolean): void;
  remove(): void;
}

export interface HitboxSweep {
  /** 0 at the segment start, 1 at the segment end. */
  t: number;
  onHit: (damage: number) => void;
}

interface HitboxRecord {
  active: boolean;
  center: Vec3;
  radius: number | null;
  aabb: HitboxAabb | null;
  onHit: (damage: number) => void;
}

export interface HitboxWorld {
  register(spec: HitboxSpec): HitboxHandle;
  sweep(from: Vec3, to: Vec3, radius: number, out: HitboxSweep): boolean;
}

export function createHitboxWorld(): HitboxWorld {
  const records: HitboxRecord[] = [];

  return {
    register(spec: HitboxSpec): HitboxHandle {
      const record: HitboxRecord = {
        active: true,
        center: spec.center,
        radius: typeof spec.radius === "number" ? Math.max(0, spec.radius) : null,
        aabb: spec.aabb ?? null,
        onHit: spec.onHit,
      };
      records.push(record);
      return {
        setActive(active: boolean): void {
          record.active = active;
        },
        remove(): void {
          const index = records.indexOf(record);
          if (index >= 0) records.splice(index, 1);
        },
      };
    },
    sweep(from: Vec3, to: Vec3, radius: number, out: HitboxSweep): boolean {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dz = to.z - from.z;
      let bestT = Infinity;
      let bestHit: ((damage: number) => void) | null = null;

      for (let i = 0; i < records.length; i += 1) {
        const record = records[i]!;
        if (!record.active) continue;
        const t = record.aabb
          ? segmentAabb(from.x, from.y, from.z, dx, dy, dz, record.aabb, radius)
          : record.radius === null
            ? null
            : segmentSphere(
                from.x,
                from.y,
                from.z,
                dx,
                dy,
                dz,
                record.center.x,
                record.center.y,
                record.center.z,
                record.radius + radius,
              );
        if (t !== null && t < bestT) {
          bestT = t;
          bestHit = record.onHit;
        }
      }

      if (!bestHit || bestT > 1) return false;
      out.t = bestT;
      out.onHit = bestHit;
      return true;
    },
  };
}

/** The world the playable Quill Driver reads. Enemies register here. */
export const playerHitboxes = createHitboxWorld();

export function registerHitbox(spec: HitboxSpec): HitboxHandle {
  return playerHitboxes.register(spec);
}

function segmentSphere(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
): number | null {
  const fx = ox - cx;
  const fy = oy - cy;
  const fz = oz - cz;
  const a = dx * dx + dy * dy + dz * dz;
  const c = fx * fx + fy * fy + fz * fz - radius * radius;
  if (a < 1e-12) return c <= 0 ? 0 : null;
  const b = 2 * (fx * dx + fy * dy + fz * dz);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  const t0 = (-b - root) / (2 * a);
  if (t0 >= 0 && t0 <= 1) return t0;
  const t1 = (-b + root) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  return c <= 0 ? 0 : null;
}

const slab = { enter: 0, exit: 1, miss: false };

function segmentAabb(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  box: HitboxAabb,
  pad: number,
): number | null {
  slab.enter = 0;
  slab.exit = 1;
  slab.miss = false;
  clipAxis(ox, dx, box.min.x - pad, box.max.x + pad);
  if (slab.miss) return null;
  clipAxis(oy, dy, box.min.y - pad, box.max.y + pad);
  if (slab.miss) return null;
  clipAxis(oz, dz, box.min.z - pad, box.max.z + pad);
  if (slab.miss || slab.exit < 0 || slab.enter > 1) return null;
  return slab.enter < 0 ? 0 : slab.enter;
}

function clipAxis(start: number, travel: number, lo: number, hi: number): void {
  if (Math.abs(travel) < 1e-12) {
    slab.miss = start < lo || start > hi;
    return;
  }
  let t1 = (lo - start) / travel;
  let t2 = (hi - start) / travel;
  if (t1 > t2) {
    const swap = t1;
    t1 = t2;
    t2 = swap;
  }
  if (t1 > slab.enter) slab.enter = t1;
  if (t2 < slab.exit) slab.exit = t2;
  slab.miss = slab.enter > slab.exit;
}
