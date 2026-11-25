// Diegetic magazine lamp on the Quill Driver's top spine.
//
// Length is the magazine fraction. Color holds cyan while the magazine is
// nearly full, reaches amber at 45%, and falls to red when it is empty.
// The channels are the same 0..1 sRGB values the viewmodel already uses.

export const SPINE_FULL_LENGTH = 0.46;
export const SPINE_VERTEX_COUNT = 36;

const CYAN_FROM = 0.82;
const AMBER_AT = 0.45;

const CYAN: readonly [number, number, number] = [0x3d / 255, 0xe1 / 255, 0xff / 255];
const AMBER: readonly [number, number, number] = [0xf5 / 255, 0xa6 / 255, 0x23 / 255];
const RED: readonly [number, number, number] = [0xff / 255, 0x3a / 255, 0x42 / 255];

/** Stock end of the lamp, viewmodel meters. The lit run shrinks toward -Z. */
const STOCK_Z = 0.06;
const X0 = -0.008;
const X1 = 0.014;
const Y0 = 0.064;
const Y1 = 0.092;

export interface SpineBar {
  /** Lit length in meters. Zero when the magazine is empty. */
  length: number;
  /** sRGB 0..1. */
  color: readonly [number, number, number];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function mix(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  u: number,
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

/** `fraction` is rounds in the magazine divided by capacity. */
export function spineFromMagazine(fraction: number): SpineBar {
  const t = clamp01(fraction);
  let color: [number, number, number];
  if (t >= CYAN_FROM) color = [CYAN[0], CYAN[1], CYAN[2]];
  else if (t >= AMBER_AT) color = mix(AMBER, CYAN, (t - AMBER_AT) / (CYAN_FROM - AMBER_AT));
  else color = mix(RED, AMBER, t / AMBER_AT);
  return { length: t * SPINE_FULL_LENGTH, color };
}

/**
 * Writes the spine box at `vertex`. An empty magazine collapses it onto the
 * stock end so the lamp disappears without dropping the draw.
 */
export function paintSpine(
  position: Float32Array,
  color: Float32Array,
  vertex: number,
  fraction: number,
): void {
  const bar = spineFromMagazine(fraction);
  writeBox(position, color, vertex * 3, X0, X1, Y0, Y1, STOCK_Z - bar.length, STOCK_Z, bar.color);
}

function writeBox(
  position: Float32Array,
  color: Float32Array,
  offset: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  rgb: readonly [number, number, number],
): void {
  const xa = Math.min(x0, x1);
  const xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1);
  const yb = Math.max(y0, y1);
  const za = Math.min(z0, z1);
  const zb = Math.max(z0, z1);
  const corners: readonly (readonly [number, number, number])[] = [
    [xa, ya, za],
    [xb, ya, za],
    [xb, yb, za],
    [xa, yb, za],
    [xa, ya, zb],
    [xb, ya, zb],
    [xb, yb, zb],
    [xa, yb, zb],
  ];
  const faces = [
    [0, 1, 2, 0, 2, 3],
    [4, 6, 5, 4, 7, 6],
    [0, 4, 5, 0, 5, 1],
    [3, 2, 6, 3, 6, 7],
    [0, 3, 7, 0, 7, 4],
    [1, 5, 6, 1, 6, 2],
  ];
  let cursor = offset;
  for (let f = 0; f < faces.length; f += 1) {
    const face = faces[f]!;
    for (let i = 0; i < face.length; i += 1) {
      const corner = corners[face[i]!]!;
      position[cursor] = corner[0];
      position[cursor + 1] = corner[1];
      position[cursor + 2] = corner[2];
      color[cursor] = rgb[0];
      color[cursor + 1] = rgb[1];
      color[cursor + 2] = rgb[2];
      cursor += 3;
    }
  }
}
