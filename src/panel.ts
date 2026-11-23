// Tileable atrium panel. One procedural texture is shared by every wall,
// pillar, and ramp. Pixel space wraps, so a wide wall and a narrow pillar
// show the same panel size instead of a stretched slab.
//
// The bytes stay dark. Seams and ribs are value, not a second neon accent.

import { CanvasTexture, DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, SRGBColorSpace, type Texture } from "three";

export const PANEL_SIZE = 256;
/** World meters covered by one tile. UVs are world distance divided by this. */
export const PANEL_METERS = 2;

const LATTICE = 8;

function wrapDist(v: number, period: number): number {
  const m = ((v % period) + period) % period;
  return Math.min(m, period - m);
}

function hash2(ix: number, iy: number): number {
  const x = ((ix % LATTICE) + LATTICE) % LATTICE;
  const y = ((iy % LATTICE) + LATTICE) % LATTICE;
  let n = Math.imul(x + 1, 374761393) ^ Math.imul(y + 1, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Wrapped value noise. The lattice period divides the tile, so the edges meet. */
function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = fade(x - x0);
  const ty = fade(y - y0);
  const a = hash2(x0, y0);
  const b = hash2(x0 + 1, y0);
  const c = hash2(x0, y0 + 1);
  const d = hash2(x0 + 1, y0 + 1);
  const ab = a + (b - a) * tx;
  const cd = c + (d - c) * tx;
  return ab + (cd - ab) * ty;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** sRGB byte at a pixel. Coordinates wrap, so `panelPixel(x, y)` equals `panelPixel(x + PANEL_SIZE, y)`. */
export function panelPixel(x: number, y: number): readonly [number, number, number] {
  const px = ((x % PANEL_SIZE) + PANEL_SIZE) % PANEL_SIZE;
  const py = ((y % PANEL_SIZE) + PANEL_SIZE) % PANEL_SIZE;
  const seam = Math.min(wrapDist(px, PANEL_SIZE), wrapDist(py, PANEL_SIZE));
  const rib = Math.min(wrapDist(py - PANEL_SIZE / 4, PANEL_SIZE / 2), wrapDist(px - PANEL_SIZE / 2, PANEL_SIZE));

  let r = 24;
  let g = 27;
  let b = 34;
  const grain = Math.sin((py / PANEL_SIZE) * Math.PI * 2 * 40);
  r += grain * 1.5;
  g += grain * 1.6;
  b += grain * 1.7;
  const n = valueNoise(px / 32, py / 32);
  r += (n - 0.5) * 4;
  g += (n - 0.5) * 4;
  b += (n - 0.5) * 5;

  if (seam < 5) {
    const t = seam / 5;
    r = 8 + t * 6;
    g = 9 + t * 6;
    b = 12 + t * 7;
  } else if (seam < 13) {
    const t = (seam - 5) / 8;
    r += (1 - t) * 8;
    g += (1 - t) * 9;
    b += (1 - t) * 11;
  } else if (rib < 2) {
    r -= 5;
    g -= 5;
    b -= 6;
  }

  const corners: readonly (readonly [number, number])[] = [
    [28, 28],
    [28, PANEL_SIZE - 28],
    [PANEL_SIZE - 28, 28],
    [PANEL_SIZE - 28, PANEL_SIZE - 28],
  ];
  for (const [cx, cy] of corners) {
    const dist = Math.hypot(px - cx, py - cy);
    if (dist < 6) {
      const t = dist / 6;
      r += (1 - t) * 12;
      g += (1 - t) * 13;
      b += (1 - t) * 14;
    } else if (dist < 8.5) {
      r -= 3;
      g -= 3;
      b -= 3;
    }
  }

  return [clampByte(r), clampByte(g), clampByte(b)];
}

export function paintPanel(): Uint8Array {
  const size = PANEL_SIZE;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = panelPixel(x, y);
      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

function finish(texture: Texture): Texture {
  texture.name = "atrium-panel";
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * One tileable panel. The browser paints a canvas. Tests without `document`
 * upload the same bytes as a data texture. Callers share the returned texture.
 */
export function createPanelTexture(): Texture {
  const data = paintPanel();
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = PANEL_SIZE;
    canvas.height = PANEL_SIZE;
    const context = canvas.getContext("2d");
    if (context) {
      const image = context.createImageData(PANEL_SIZE, PANEL_SIZE);
      image.data.set(data);
      context.putImageData(image, 0, 0);
      return finish(new CanvasTexture(canvas));
    }
  }
  return finish(new DataTexture(data, PANEL_SIZE, PANEL_SIZE));
}
