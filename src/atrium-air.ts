// Skylight dust and pillar scan bands for the Neon Atrium.
//
// The bands stay on the amber beacon mesh. The dust does not: orange and
// amber are gameplay signals, so the motes are a cool tint on the additive
// column pass. That pass already exists, and a second mesh would cost a draw.
// The mote pool is fixed: each index is a stable column slot, and time only
// scrolls it downward.

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

/** Cool pale dust. Orange and amber stay on the beacons, the spine, and the hound. */
export const MOTE_COLOR = 0x9fd8ff;
/** Fraction of that tint added into the frame. The old motes were solid. */
export const MOTE_GAIN = 0.4;

const FALL = 0.95;
const BAND_SPEED = 0.32;
const BAND_HALF_Y = 0.03;
const BAND_PAD = 0.08;
/** Sixty percent of the old 0.05 × 0.08 square. */
const MOTE_W = 0.03;
const MOTE_H = 0.048;
const BOX_VERTS = 36;
/** Two crossed quads. The column material is double-sided, so one winding is enough. */
const MOTE_VERTS = 12;

export function motionVertexCount(): number {
  return ATRIUM_PILLARS.length * BANDS_PER_PILLAR * BOX_VERTS;
}

export function moteVertexCount(): number {
  return MOTE_COUNT * MOTE_VERTS;
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

/** Rewrites the band tail of the amber position buffer. `vertexStart` is the first band vertex. */
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
}

type RGB = readonly [number, number, number];

/** Writes the mote pool at `floatOffset` in a position buffer and a matching color buffer. */
export function paintMotes(
  position: Float32Array,
  color: Float32Array,
  floatOffset: number,
  time: number,
  rgb: RGB,
): void {
  let offset = floatOffset;
  for (let i = 0; i < MOTE_COUNT; i += 1) {
    motePosition(i, time, moteScratch);
    offset = writeMote(position, color, offset, moteScratch.x, moteScratch.y, moteScratch.z, rgb);
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

function putVert(
  position: Float32Array,
  color: Float32Array,
  offset: number,
  x: number,
  y: number,
  z: number,
  rgb: RGB,
): number {
  position[offset] = x;
  position[offset + 1] = y;
  position[offset + 2] = z;
  color[offset] = rgb[0];
  color[offset + 1] = rgb[1];
  color[offset + 2] = rgb[2];
  return offset + 3;
}

function writeQuad(
  position: Float32Array,
  color: Float32Array,
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
  rgb: RGB,
): number {
  offset = putVert(position, color, offset, ax, ay, az, rgb);
  offset = putVert(position, color, offset, bx, by, bz, rgb);
  offset = putVert(position, color, offset, cx, cy, cz, rgb);
  offset = putVert(position, color, offset, ax, ay, az, rgb);
  offset = putVert(position, color, offset, cx, cy, cz, rgb);
  return putVert(position, color, offset, dx, dy, dz, rgb);
}

function writeMote(
  position: Float32Array,
  color: Float32Array,
  offset: number,
  x: number,
  y: number,
  z: number,
  rgb: RGB,
): number {
  offset = writeQuad(
    position,
    color,
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
    rgb,
  );
  return writeQuad(
    position,
    color,
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
    rgb,
  );
}
