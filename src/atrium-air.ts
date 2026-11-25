// Skylight dust and pillar scan bands for the Neon Atrium.
//
// Both are painted into the existing amber glow mesh. A separate points
// object would be drawn again by the bloom pass. The mote pool is fixed:
// each index is a stable column slot, and time only scrolls it downward.

import { ATRIUM_PILLARS, GROUND_Y } from "./atrium.ts";

export const MOTE_COUNT = 24;
/** Horizontal radius of the shaft. Inside the jump pads and clear of the pillars. */
export const MOTE_LIMIT = 2.85;
export const MOTE_BOTTOM = 0.45;
export const MOTE_TOP = 8.45;

export const BANDS_PER_PILLAR = 2;
/** Above the plinth, under the cap, so the floor edge and the beacon stay readable. */
export const BAND_LOW = GROUND_Y + 0.7;
export const BAND_HIGH = 3.55;

const FALL = 0.95;
const BAND_SPEED = 0.32;
const BAND_HALF_Y = 0.03;
const BAND_PAD = 0.08;
const MOTE_W = 0.05;
const MOTE_H = 0.08;
const BOX_VERTS = 36;
const MOTE_VERTS = 24;

export function motionVertexCount(): number {
  return ATRIUM_PILLARS.length * BANDS_PER_PILLAR * BOX_VERTS + MOTE_COUNT * MOTE_VERTS;
}

function modulo(value: number, span: number): number {
  if (!(span > 0)) return 0;
  const wrapped = value % span;
  return wrapped < 0 ? wrapped + span : wrapped;
}

export function motePosition(
  index: number,
  time: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const slot = ((index % MOTE_COUNT) + MOTE_COUNT) % MOTE_COUNT;
  const column = MOTE_TOP - MOTE_BOTTOM;
  const phase = ((slot + 1) * 0.61803398875) % 1;
  const down = modulo(time * (FALL / column) + phase, 1);
  out.y = MOTE_TOP - down * column;
  const ang = slot * 2.399963229728653;
  const rad = 0.5 + (slot % 5) * 0.4;
  let x = Math.cos(ang) * rad + Math.sin(time * 0.31 + slot * 1.7) * 0.32;
  let z = Math.sin(ang) * rad + Math.cos(time * 0.27 + slot * 1.3) * 0.32;
  const reach = Math.hypot(x, z);
  if (reach > MOTE_LIMIT) {
    const scale = MOTE_LIMIT / reach;
    x *= scale;
    z *= scale;
  }
  out.x = x;
  out.z = z;
  return out;
}

/** Center height of one amber band. Two bands on a pillar stay about half a cycle apart. */
export function pillarBandY(pillarIndex: number, bandIndex: number, time: number): number {
  const span = BAND_HIGH - BAND_LOW;
  const phase = (pillarIndex * 0.37 + bandIndex * 0.5) * span;
  return BAND_LOW + modulo(time * BAND_SPEED + phase, span);
}

const moteScratch = { x: 0, y: 0, z: 0 };

/** Rewrites the motion tail of the amber position buffer. `vertexStart` is the first motion vertex. */
export function paintMotionPositions(position: Float32Array, vertexStart: number, time: number): void {
  let offset = vertexStart * 3;
  for (let pillarIndex = 0; pillarIndex < ATRIUM_PILLARS.length; pillarIndex += 1) {
    const pillar = ATRIUM_PILLARS[pillarIndex]!;
    const pad = pillar.half + BAND_PAD;
    for (let band = 0; band < BANDS_PER_PILLAR; band += 1) {
      const y = pillarBandY(pillarIndex, band, time);
      offset = writeBox(
        position,
        offset,
        pillar.x - pad,
        pillar.x + pad,
        y - BAND_HALF_Y,
        y + BAND_HALF_Y,
        pillar.z - pad,
        pillar.z + pad,
      );
    }
  }
  for (let i = 0; i < MOTE_COUNT; i += 1) {
    motePosition(i, time, moteScratch);
    offset = writeMote(position, offset, moteScratch.x, moteScratch.y, moteScratch.z);
  }
}

function put(position: Float32Array, offset: number, x: number, y: number, z: number): number {
  position[offset] = x;
  position[offset + 1] = y;
  position[offset + 2] = z;
  return offset + 3;
}

function writeBox(
  position: Float32Array,
  offset: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
): number {
  const xa = Math.min(x0, x1);
  const xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1);
  const yb = Math.max(y0, y1);
  const za = Math.min(z0, z1);
  const zb = Math.max(z0, z1);
  // +Y -Y +X -X +Z -Z. No per-frame arrays; this runs every bloom pass.
  offset = put(position, offset, xa, yb, zb);
  offset = put(position, offset, xb, yb, zb);
  offset = put(position, offset, xb, yb, za);
  offset = put(position, offset, xa, yb, zb);
  offset = put(position, offset, xb, yb, za);
  offset = put(position, offset, xa, yb, za);
  offset = put(position, offset, xa, ya, za);
  offset = put(position, offset, xb, ya, za);
  offset = put(position, offset, xb, ya, zb);
  offset = put(position, offset, xa, ya, za);
  offset = put(position, offset, xb, ya, zb);
  offset = put(position, offset, xa, ya, zb);
  offset = put(position, offset, xb, ya, za);
  offset = put(position, offset, xb, yb, za);
  offset = put(position, offset, xb, yb, zb);
  offset = put(position, offset, xb, ya, za);
  offset = put(position, offset, xb, yb, zb);
  offset = put(position, offset, xb, ya, zb);
  offset = put(position, offset, xa, ya, zb);
  offset = put(position, offset, xa, yb, zb);
  offset = put(position, offset, xa, yb, za);
  offset = put(position, offset, xa, ya, zb);
  offset = put(position, offset, xa, yb, za);
  offset = put(position, offset, xa, ya, za);
  offset = put(position, offset, xa, ya, zb);
  offset = put(position, offset, xb, ya, zb);
  offset = put(position, offset, xb, yb, zb);
  offset = put(position, offset, xa, ya, zb);
  offset = put(position, offset, xb, yb, zb);
  offset = put(position, offset, xa, yb, zb);
  offset = put(position, offset, xb, ya, za);
  offset = put(position, offset, xa, ya, za);
  offset = put(position, offset, xa, yb, za);
  offset = put(position, offset, xb, ya, za);
  offset = put(position, offset, xa, yb, za);
  offset = put(position, offset, xb, yb, za);
  return offset;
}

function writeDoubleQuad(
  position: Float32Array,
  offset: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  dx: number,
  dy: number,
  dz: number,
): number {
  offset = put(position, offset, ax, ay, az);
  offset = put(position, offset, bx, by, bz);
  offset = put(position, offset, cx, cy, cz);
  offset = put(position, offset, ax, ay, az);
  offset = put(position, offset, cx, cy, cz);
  offset = put(position, offset, dx, dy, dz);
  offset = put(position, offset, dx, dy, dz);
  offset = put(position, offset, cx, cy, cz);
  offset = put(position, offset, bx, by, bz);
  offset = put(position, offset, dx, dy, dz);
  offset = put(position, offset, bx, by, bz);
  offset = put(position, offset, ax, ay, az);
  return offset;
}

function writeMote(position: Float32Array, offset: number, x: number, y: number, z: number): number {
  offset = writeDoubleQuad(
    position,
    offset,
    x - MOTE_W,
    y - MOTE_H,
    z,
    x + MOTE_W,
    y - MOTE_H,
    z,
    x + MOTE_W,
    y + MOTE_H,
    z,
    x - MOTE_W,
    y + MOTE_H,
    z,
  );
  return writeDoubleQuad(
    position,
    offset,
    x,
    y - MOTE_H,
    z - MOTE_W,
    x,
    y - MOTE_H,
    z + MOTE_W,
    x,
    y + MOTE_H,
    z + MOTE_W,
    x,
    y + MOTE_H,
    z - MOTE_W,
  );
}
