// Neon Atrium meshes. Collision stays in the hull; these shapes are only drawn.
// Geometry is built in code from the atrium plan. Nothing here is a loaded model.

import {
  BufferGeometry,
  CanvasTexture,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  SRGBColorSpace,
  type Scene,
} from "three";
import {
  ATRIUM_CRATES,
  ATRIUM_PADS,
  ATRIUM_PILLARS,
  ATRIUM_RAMPS,
  ATRIUM_STAIRS,
  CATWALK_Y,
  CEILING_Y,
  CONCOURSE,
  GROUND_Y,
  MAP_HALF,
  PARAPET_Y,
  RING_INNER,
  STAIR_LAND_Z0,
  WELL_HALF,
  stairCollisionBoxes,
  type AtriumPad,
  type AtriumRamp,
  type AtriumStair,
} from "./atrium.ts";
import {
  AMMO_COLOR,
  AMMO_DORMANT,
  ARMOR_ENABLED,
  HEALTH_COLOR,
  HEALTH_DORMANT,
  type PickupPad,
} from "./pickups.ts";

const VOID = 0x0a0b10;
const CONCRETE = 0x1a1d24;
const CYAN = 0x00e5ff;
const MAGENTA = 0xff2e9f;
const AMBER = 0xf5a623;
const ARMOR_COLOR = 0x00e5ff;
const ARMOR_DORMANT = 0x06343d;

class Soup {
  readonly position: number[] = [];
  readonly normal: number[] = [];

  get triangles(): number {
    return this.position.length / 9;
  }

  geometry(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(this.position, 3));
    geometry.setAttribute("normal", new Float32BufferAttribute(this.normal, 3));
    return geometry;
  }

  face(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    n: readonly [number, number, number],
  ): void {
    this.tri(a, b, c, n);
    this.tri(a, c, d, n);
  }

  tri(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    n: readonly [number, number, number],
  ): void {
    this.position.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.normal.push(n[0], n[1], n[2], n[0], n[1], n[2], n[0], n[1], n[2]);
  }

  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
    const xa = Math.min(x0, x1);
    const xb = Math.max(x0, x1);
    const ya = Math.min(y0, y1);
    const yb = Math.max(y0, y1);
    const za = Math.min(z0, z1);
    const zb = Math.max(z0, z1);
    this.face([xa, yb, zb], [xb, yb, zb], [xb, yb, za], [xa, yb, za], [0, 1, 0]);
    this.face([xa, ya, za], [xb, ya, za], [xb, ya, zb], [xa, ya, zb], [0, -1, 0]);
    this.face([xb, ya, za], [xb, yb, za], [xb, yb, zb], [xb, ya, zb], [1, 0, 0]);
    this.face([xa, ya, zb], [xa, yb, zb], [xa, yb, za], [xa, ya, za], [-1, 0, 0]);
    this.face([xa, ya, zb], [xb, ya, zb], [xb, yb, zb], [xa, yb, zb], [0, 0, 1]);
    this.face([xb, ya, za], [xa, ya, za], [xa, yb, za], [xb, yb, za], [0, 0, -1]);
  }
}

function concreteMesh(soup: Soup): Mesh {
  // Emissive keeps the concrete at its palette value with the lights off.
  // Specular is the cheap wet gloss; nothing here casts a shadow map.
  const mesh = new Mesh(
    soup.geometry(),
    new MeshPhongMaterial({
      color: 0x000000,
      emissive: CONCRETE,
      specular: 0x9aa8b8,
      shininess: 42,
    }),
  );
  mesh.name = "atrium-concrete";
  return mesh;
}

function glowMesh(soup: Soup, color: number, name: string): Mesh {
  const mesh = new Mesh(
    soup.geometry(),
    new MeshBasicMaterial({
      color,
      toneMapped: false,
    }),
  );
  mesh.name = name;
  return mesh;
}

function addRamp(soup: Soup, ramp: AtriumRamp): void {
  const yHigh = ramp.yLow + ramp.rise;
  const a: [number, number, number] = [ramp.minX, ramp.yLow, ramp.maxZ];
  const b: [number, number, number] = [ramp.maxX, ramp.yLow, ramp.maxZ];
  const c: [number, number, number] = [ramp.maxX, yHigh, ramp.minZ];
  const d: [number, number, number] = [ramp.minX, yHigh, ramp.minZ];
  const span = ramp.maxZ - ramp.minZ;
  const slope = span === 0 ? 0 : ramp.rise / span;
  const len = Math.hypot(1, slope);
  soup.face(a, b, c, d, [0, 1 / len, slope / len]);
  soup.tri(a, d, [ramp.minX, ramp.yLow, ramp.minZ], [-1, 0, 0]);
  soup.tri(b, [ramp.maxX, ramp.yLow, ramp.minZ], c, [1, 0, 0]);
  soup.face(
    [ramp.minX, ramp.yLow, ramp.minZ],
    [ramp.maxX, ramp.yLow, ramp.minZ],
    c,
    d,
    [0, 0, -1],
  );
}

function addStair(soup: Soup, stair: AtriumStair): void {
  // Draw the same solids the capsule walks. The portion under the concourse
  // stays in the hull only, so the floor and the tread do not share a plane.
  for (const solid of stairCollisionBoxes(stair)) {
    const y0 = Math.max(solid.min.y, GROUND_Y);
    if (solid.max.y - y0 < 0.02) continue;
    soup.box(solid.min.x, solid.max.x, y0, solid.max.y, solid.min.z, solid.max.z);
  }
}

function addStructure(soup: Soup): void {
  const w = WELL_HALF;
  const c = CONCOURSE;
  const ring = RING_INNER;
  const edge = MAP_HALF;
  soup.box(-w, w, -0.06, 0, -w, w);
  soup.box(-c, c, 0, GROUND_Y, w, c);
  soup.box(-c, c, 0, GROUND_Y, -c, -w);
  soup.box(-c, -w, 0, GROUND_Y, -w, w);
  soup.box(w, c, 0, GROUND_Y, -w, w);

  // Outer ring. The inner edge stops a centimetre short of the parapet so the
  // shared plane does not flicker.
  const seam = 0.02;
  soup.box(-edge, edge, 0, CATWALK_Y, ring + seam, edge);
  soup.box(-edge, edge, 0, CATWALK_Y, -edge, -(ring + seam));
  soup.box(ring + seam, edge, 0, CATWALK_Y, -ring, ring);
  soup.box(-edge, -(ring + seam), 0, CATWALK_Y, -ring, ring);

  soup.box(-ring, ring, 0, PARAPET_Y, c, ring);
  soup.box(-ring, -10.2, 0, PARAPET_Y, -ring, -c);
  soup.box(-7.6, 7.6, 0, PARAPET_Y, -ring, -c);
  soup.box(10.2, ring, 0, PARAPET_Y, -ring, -c);
  soup.box(c, ring, 0, PARAPET_Y, -c, STAIR_LAND_Z0);
  soup.box(-ring, -c, 0, PARAPET_Y, -c, STAIR_LAND_Z0);

  for (const ramp of ATRIUM_RAMPS) {
    addRamp(soup, ramp);
    soup.box(ramp.minX, ramp.maxX, GROUND_Y, CATWALK_Y, -ring, ramp.minZ);
    const againstParapet = ramp.minX < 0 ? "west" : "east";
    if (againstParapet !== "west") {
      soup.box(ramp.minX, ramp.minX + 0.16, GROUND_Y, PARAPET_Y - 0.05, ramp.minZ, ramp.maxZ);
    }
    if (againstParapet !== "east") {
      soup.box(ramp.maxX - 0.16, ramp.maxX, GROUND_Y, PARAPET_Y - 0.05, ramp.minZ, ramp.maxZ);
    }
  }
  for (const stair of ATRIUM_STAIRS) addStair(soup, stair);

  for (const pillar of ATRIUM_PILLARS) {
    soup.box(
      pillar.x - pillar.half,
      pillar.x + pillar.half,
      GROUND_Y,
      pillar.top,
      pillar.z - pillar.half,
      pillar.z + pillar.half,
    );
  }

  soup.box(ATRIUM_CRATES.x0, ATRIUM_CRATES.x1, ATRIUM_CRATES.y0, ATRIUM_CRATES.y0 + ATRIUM_CRATES.height, ATRIUM_CRATES.z0, ATRIUM_CRATES.z1);
  soup.box(
    ATRIUM_CRATES.x0,
    ATRIUM_CRATES.x1,
    ATRIUM_CRATES.y0 + ATRIUM_CRATES.height,
    ATRIUM_CRATES.y0 + ATRIUM_CRATES.height * 2,
    ATRIUM_CRATES.z0,
    ATRIUM_CRATES.z1,
  );
  soup.box(1.7, 3.5, 0, 0.28, -2.55, -2.15);

  const wall = 0.4;
  soup.box(-edge, edge, 0, CEILING_Y, edge, edge + wall);
  soup.box(-edge, edge, 0, CEILING_Y, -(edge + wall), -edge);
  soup.box(edge, edge + wall, 0, CEILING_Y, -edge, edge);
  soup.box(-(edge + wall), -edge, 0, CEILING_Y, -edge, edge);

  const sky = 6.2;
  const slab = 0.22;
  const cy = CEILING_Y - 0.05;
  soup.box(-edge, edge, cy, cy + slab, sky, edge);
  soup.box(-edge, edge, cy, cy + slab, -edge, -sky);
  soup.box(sky, edge, cy, cy + slab, -sky, sky);
  soup.box(-edge, -sky, cy, cy + slab, -sky, sky);
  for (const at of [-2.6, 2.6]) {
    soup.box(-5.4, 5.4, 8.48, 8.64, at - 0.06, at + 0.06);
    soup.box(at - 0.06, at + 0.06, 8.48, 8.64, -5.4, 5.4);
  }
}

function addChannels(cyan: Soup, magenta: Soup): void {
  const y = GROUND_Y + 0.02;
  const h = 0.035;
  const lip = WELL_HALF + 0.18;
  const outer = WELL_HALF + 0.4;
  cyan.box(-outer, outer, y, y + h, lip, outer);
  cyan.box(-outer, outer, y, y + h, -outer, -lip);
  cyan.box(-outer, -lip, y, y + h, -lip, lip);
  cyan.box(lip, outer, y, y + h, -lip, lip);

  const under = CATWALK_Y - 0.22;
  const band = 0.16;
  magenta.box(-RING_INNER, RING_INNER, under, under + 0.07, CONCOURSE - band, CONCOURSE);
  magenta.box(-RING_INNER, RING_INNER, under, under + 0.07, -CONCOURSE, -CONCOURSE + band);
  magenta.box(CONCOURSE - band, CONCOURSE, under, under + 0.07, -CONCOURSE, CONCOURSE);
  magenta.box(-CONCOURSE, -CONCOURSE + band, under, under + 0.07, -CONCOURSE, CONCOURSE);

  const lane = CATWALK_Y + 0.025;
  cyan.box(-10, 10, lane, lane + 0.03, 14.35, 14.52);
  cyan.box(-10, 10, lane, lane + 0.03, -14.52, -14.35);
  cyan.box(-14.52, -14.35, lane, lane + 0.03, -10, 10);
  cyan.box(14.35, 14.52, lane, lane + 0.03, -10, 10);
}

function addBeacons(soup: Soup): void {
  for (const pillar of ATRIUM_PILLARS) {
    soup.box(pillar.x - 0.16, pillar.x + 0.16, pillar.top, pillar.top + 0.28, pillar.z - 0.16, pillar.z + 0.16);
    soup.box(pillar.x - pillar.half - 0.02, pillar.x - pillar.half + 0.05, GROUND_Y + 0.4, pillar.top - 0.2, pillar.z - 0.08, pillar.z + 0.08);
  }
}

export interface PadView {
  kind: AtriumPad["kind"];
  x: number;
  y: number;
  z: number;
  mesh: Mesh;
  setAvailable(available: boolean): void;
}

function padMaterial(color: number, name: string): MeshBasicMaterial {
  const material = new MeshBasicMaterial({ color, toneMapped: false });
  material.name = name;
  return material;
}

function padMesh(
  soup: Soup,
  pad: AtriumPad,
  live: MeshBasicMaterial,
  dormant: MeshBasicMaterial,
  name: string,
): PadView {
  const mesh = new Mesh(soup.geometry(), live);
  mesh.name = name;
  return {
    kind: pad.kind,
    x: pad.position.x,
    y: pad.position.y,
    z: pad.position.z,
    mesh,
    setAvailable(available: boolean): void {
      mesh.material = available ? live : dormant;
    },
  };
}

/** Acid-green canister with a cross on the cap. */
function addHealthShape(soup: Soup, pad: AtriumPad): void {
  const { x, z } = pad.position;
  const y = pad.position.y + 0.02;
  soup.box(x - 0.11, x + 0.11, y + 0.04, y + 0.52, z - 0.11, z + 0.11);
  soup.box(x - 0.14, x + 0.14, y + 0.42, y + 0.5, z - 0.14, z + 0.14);
  soup.box(x - 0.07, x + 0.07, y + 0.5, y + 0.62, z - 0.07, z + 0.07);
  soup.box(x - 0.26, x + 0.26, y + 0.66, y + 0.76, z - 0.05, z + 0.05);
  soup.box(x - 0.05, x + 0.05, y + 0.56, y + 0.86, z - 0.05, z + 0.05);
}

/** Magenta crate: a box, a lid, and four corner posts. */
function addAmmoShape(soup: Soup, pad: AtriumPad): void {
  const { x, z } = pad.position;
  const y = pad.position.y + 0.02;
  soup.box(x - 0.22, x + 0.22, y, y + 0.28, z - 0.16, z + 0.16);
  soup.box(x - 0.25, x + 0.25, y + 0.28, y + 0.36, z - 0.19, z + 0.19);
  const posts: readonly (readonly [number, number])[] = [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ];
  for (const [sx, sz] of posts) {
    soup.box(
      x + sx * 0.22 - 0.035,
      x + sx * 0.22 + 0.035,
      y,
      y + 0.42,
      z + sz * 0.16 - 0.035,
      z + sz * 0.16 + 0.035,
    );
  }
}

/** Square shell. Drawn only when ARMOR_ENABLED is on. */
function addArmorShape(soup: Soup, pad: AtriumPad): void {
  const { x, z } = pad.position;
  const y = pad.position.y + 0.02;
  soup.box(x - 0.28, x + 0.28, y, y + 0.08, z - 0.28, z - 0.16);
  soup.box(x - 0.28, x + 0.28, y, y + 0.08, z + 0.16, z + 0.28);
  soup.box(x - 0.28, x - 0.16, y, y + 0.08, z - 0.16, z + 0.16);
  soup.box(x + 0.16, x + 0.28, y, y + 0.08, z - 0.16, z + 0.16);
  soup.box(x - 0.08, x + 0.08, y + 0.08, y + 0.36, z - 0.08, z + 0.08);
}

function buildPadViews(): { pads: PadView[]; triangles: number } {
  const healthLive = padMaterial(HEALTH_COLOR, "pad-health-live");
  const healthDim = padMaterial(HEALTH_DORMANT, "pad-health-dormant");
  const ammoLive = padMaterial(AMMO_COLOR, "pad-ammo-live");
  const ammoDim = padMaterial(AMMO_DORMANT, "pad-ammo-dormant");
  const armorLive = padMaterial(ARMOR_COLOR, "pad-armor-live");
  const armorDim = padMaterial(ARMOR_DORMANT, "pad-armor-dormant");
  const pads: PadView[] = [];
  let triangles = 0;
  for (const pad of ATRIUM_PADS) {
    if (pad.kind === "armor" && !ARMOR_ENABLED) continue;
    const soup = new Soup();
    if (pad.kind === "health") addHealthShape(soup, pad);
    else if (pad.kind === "ammo") addAmmoShape(soup, pad);
    else addArmorShape(soup, pad);
    const live = pad.kind === "health" ? healthLive : pad.kind === "ammo" ? ammoLive : armorLive;
    const dormant = pad.kind === "health" ? healthDim : pad.kind === "ammo" ? ammoDim : armorDim;
    pads.push(padMesh(soup, pad, live, dormant, `pad-${pad.kind}`));
    triangles += soup.triangles;
  }
  return { pads, triangles };
}

export function syncPadViews(views: readonly PadView[], pads: readonly PickupPad[]): void {
  for (const view of views) {
    let pad: PickupPad | undefined;
    for (const candidate of pads) {
      if (
        candidate.kind === view.kind &&
        candidate.x === view.x &&
        candidate.y === view.y &&
        candidate.z === view.z
      ) {
        pad = candidate;
        break;
      }
    }
    if (!pad) {
      view.mesh.visible = false;
      continue;
    }
    view.mesh.visible = true;
    view.setAvailable(pad.cooldown <= 0);
  }
}

function signMaterial(): MeshBasicMaterial | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#0A0B10";
  context.fillRect(0, 0, 1024, 256);
  context.strokeStyle = "#00E5FF";
  context.lineWidth = 10;
  context.strokeRect(16, 16, 992, 224);
  context.fillStyle = "#00E5FF";
  context.font = "600 78px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("ORION-VEC ATRIUM", 512, 100);
  context.fillStyle = "#FF2E9F";
  context.font = "600 46px sans-serif";
  context.fillText("LEVEL 0", 512, 176);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const material = new MeshBasicMaterial({ map: texture, toneMapped: false });
  material.name = "atrium-sign";
  return material;
}

function addSigns(meshes: Mesh[], triangles: { count: number }): void {
  const material = signMaterial();
  if (!material) return;
  const soup = new Soup();
  const y = 7.15;
  const w = 1.7;
  const h = 0.42;
  soup.face([-w, y + h, -12.15], [w, y + h, -12.15], [w, y - h, -12.15], [-w, y - h, -12.15], [0, 0, 1]);
  soup.face([-w, y - h, 12.15], [w, y - h, 12.15], [w, y + h, 12.15], [-w, y + h, 12.15], [0, 0, -1]);
  const mesh = new Mesh(soup.geometry(), material);
  mesh.name = "atrium-sign";
  meshes.push(mesh);
  triangles.count += soup.triangles;
}

export interface AtriumView {
  meshes: Mesh[];
  triangles: number;
  pads: PadView[];
}

export function buildAtriumView(): AtriumView {
  const concrete = new Soup();
  addStructure(concrete);
  const cyan = new Soup();
  const magenta = new Soup();
  addChannels(cyan, magenta);
  const amber = new Soup();
  addBeacons(amber);
  const pads = buildPadViews();

  const meshes = [
    concreteMesh(concrete),
    glowMesh(cyan, CYAN, "atrium-cyan"),
    glowMesh(magenta, MAGENTA, "atrium-magenta"),
    glowMesh(amber, AMBER, "atrium-amber"),
  ];
  for (const pad of pads.pads) meshes.push(pad.mesh);
  let triangles = concrete.triangles + cyan.triangles + magenta.triangles + amber.triangles + pads.triangles;
  const extra = { count: 0 };
  addSigns(meshes, extra);
  triangles += extra.count;
  return { meshes, triangles, pads: pads.pads };
}

export function addAtrium(scene: Scene): { triangles: number; meshes: number; pads: PadView[] } {
  const view = buildAtriumView();
  for (const mesh of view.meshes) scene.add(mesh);
  return { triangles: view.triangles, meshes: view.meshes.length, pads: view.pads };
}

export const ATRIUM_CLEAR = VOID;
export const ATRIUM_FOG = 0x0c1016;
