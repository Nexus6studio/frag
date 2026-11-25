// Neon Atrium meshes. Collision stays in the hull; these shapes are only drawn.
// Geometry is built in code from the atrium plan. Nothing here is a loaded model.
// Walls, pillars, and ramps share one procedural panel. Trim is a higher value
// on the lips, ramps, and joins so those edges read without lighting the room.

import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  SRGBColorSpace,
  type Scene,
  type Texture,
} from "three";
import {
  ATRIUM_CRATES,
  ATRIUM_JUMP_PADS,
  ATRIUM_PADS,
  ATRIUM_PILLARS,
  ATRIUM_RAMPS,
  ATRIUM_STAIRS,
  CATWALK_Y,
  CEILING_Y,
  CONCOURSE,
  GROUND_Y,
  JUMP_LANE_HALF,
  MAP_HALF,
  PARAPET_Y,
  RING_INNER,
  STAIR_COUNT,
  STAIR_DEPTH,
  STAIR_LAND_Z0,
  STAIR_RISE,
  WELL_HALF,
  sideParapetRuns,
  stairCollisionBoxes,
  type AtriumJumpPad,
  type AtriumPad,
  type AtriumRamp,
  type AtriumStair,
} from "./atrium.ts";
import { motionVertexCount, paintMotionPositions } from "./atrium-air.ts";
import { PANEL_METERS, createPanelTexture } from "./panel.ts";
import {
  AMMO_COLOR,
  AMMO_DORMANT,
  ARMOR_COLOR,
  ARMOR_DORMANT,
  ARMOR_ENABLED,
  HEALTH_COLOR,
  HEALTH_DORMANT,
  type PickupPad,
} from "./pickups.ts";

const VOID = 0x0a0b10;
const FLOOR = 0x151820;
const TRIM = 0x546378;
const CYAN = 0x00e5ff;
const MAGENTA = 0xff2e9f;
const AMBER = 0xf5a623;

type Triple = readonly [number, number, number];

class Soup {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly uv: number[] = [];

  get triangles(): number {
    return this.position.length / 9;
  }

  geometry(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(this.position, 3));
    geometry.setAttribute("normal", new Float32BufferAttribute(this.normal, 3));
    geometry.setAttribute("uv", new Float32BufferAttribute(this.uv, 2));
    return geometry;
  }

  face(a: Triple, b: Triple, c: Triple, d: Triple, n: Triple): void {
    this.tri(a, b, c, n);
    this.tri(a, c, d, n);
  }

  /** Same as face, but the winding is flipped when it does not face `n`. */
  orientedFace(a: Triple, b: Triple, c: Triple, d: Triple, n: Triple): void {
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const abz = b[2] - a[2];
    const acx = c[0] - a[0];
    const acy = c[1] - a[1];
    const acz = c[2] - a[2];
    const cx = aby * acz - abz * acy;
    const cy = abz * acx - abx * acz;
    const cz = abx * acy - aby * acx;
    if (cx * n[0] + cy * n[1] + cz * n[2] < 0) this.face(a, d, c, b, n);
    else this.face(a, b, c, d, n);
  }

  tri(a: Triple, b: Triple, c: Triple, n: Triple): void {
    this.position.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.normal.push(n[0], n[1], n[2], n[0], n[1], n[2], n[0], n[1], n[2]);
    const ua = planarUv(a, n);
    const ub = planarUv(b, n);
    const uc = planarUv(c, n);
    this.uv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
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

/**
 * Orthonormal planar UVs in tile units. Axis-aligned faces follow the plan.
 * A sloped face uses the slope length, so a ramp panel is not squashed.
 */
function planarUv(p: Triple, n: Triple): [number, number] {
  const nlen = Math.hypot(n[0], n[1], n[2]) || 1;
  const ux = n[0] / nlen;
  const uy = n[1] / nlen;
  const uz = n[2] / nlen;
  const ax = Math.abs(ux);
  const ay = Math.abs(uy);
  const az = Math.abs(uz);
  let rx = 0;
  let ry = 0;
  let rz = 0;
  if (ay >= ax && ay >= az) rx = 1;
  else if (ax >= az) rz = 1;
  else rx = 1;
  const dot = rx * ux + ry * uy + rz * uz;
  let tx = rx - ux * dot;
  let ty = ry - uy * dot;
  let tz = rz - uz * dot;
  const tl = Math.hypot(tx, ty, tz) || 1;
  tx /= tl;
  ty /= tl;
  tz /= tl;
  const bx = uy * tz - uz * ty;
  const by = uz * tx - ux * tz;
  const bz = ux * ty - uy * tx;
  return [(p[0] * tx + p[1] * ty + p[2] * tz) / PANEL_METERS, (p[0] * bx + p[1] * by + p[2] * bz) / PANEL_METERS];
}

function phongMesh(soup: Soup, material: MeshPhongMaterial, name: string): Mesh {
  const mesh = new Mesh(soup.geometry(), material);
  mesh.name = name;
  return mesh;
}

function floorMaterial(): MeshPhongMaterial {
  // Emissive holds the floor at its palette value. Diffuse stays off so the
  // hemisphere and key light cannot wash the concourse; specular is the wet gloss.
  const material = new MeshPhongMaterial({
    color: 0x000000,
    emissive: FLOOR,
    specular: 0x9aa8b8,
    shininess: 42,
  });
  material.name = "atrium-floor";
  return material;
}

function shellMaterial(texture: Texture): MeshPhongMaterial {
  const material = new MeshPhongMaterial({
    color: 0x000000,
    emissive: 0xffffff,
    emissiveMap: texture,
    specular: 0x1c242c,
    shininess: 12,
  });
  material.name = "atrium-panel";
  return material;
}

function trimMaterial(): MeshPhongMaterial {
  // Cool slate, brighter than the floor and dimmer than pickups and enemy lights.
  const material = new MeshPhongMaterial({
    color: 0x000000,
    emissive: TRIM,
    specular: 0x121820,
    shininess: 6,
  });
  material.name = "atrium-trim";
  return material;
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

/**
 * Appends skylight motes and pillar bands to the amber beacons.
 * One mesh keeps the bloom pass from drawing the atmosphere a second time as its own object.
 */
function attachAtriumMotion(mesh: Mesh): void {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  const staticVerts = position.count;
  const extra = motionVertexCount();
  const total = staticVerts + extra;
  const nextPos = new Float32Array(total * 3);
  const nextNor = new Float32Array(total * 3);
  const nextUv = new Float32Array(total * 2);
  nextPos.set(position.array as Float32Array);
  nextNor.set(normal.array as Float32Array);
  nextUv.set(uv.array as Float32Array);
  paintMotionPositions(nextPos, staticVerts, 0);
  const posAttr = new Float32BufferAttribute(nextPos, 3);
  posAttr.setUsage(DynamicDrawUsage);
  geometry.setAttribute("position", posAttr);
  geometry.setAttribute("normal", new Float32BufferAttribute(nextNor, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(nextUv, 2));
  geometry.computeBoundingSphere();
  mesh.frustumCulled = false;
  mesh.userData.motionStart = staticVerts;
  mesh.onBeforeRender = () => {
    applyAtriumMotion(mesh, performance.now() / 1000);
  };
}

/** Scrolls the amber mesh's mote and band vertices. The beacon verts stay put. */
export function applyAtriumMotion(mesh: Mesh, time: number): void {
  const start = mesh.userData.motionStart;
  if (typeof start !== "number") return;
  const position = mesh.geometry.getAttribute("position");
  paintMotionPositions(position.array as Float32Array, start, time);
  position.needsUpdate = true;
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
  const ny = 1 / len;
  const nz = slope / len;
  soup.face(a, b, c, d, [0, ny, nz]);
  soup.tri(a, d, [ramp.minX, ramp.yLow, ramp.minZ], [-1, 0, 0]);
  soup.tri(b, [ramp.maxX, ramp.yLow, ramp.minZ], c, [1, 0, 0]);
  soup.face(
    [ramp.minX, ramp.yLow, ramp.minZ],
    [ramp.maxX, ramp.yLow, ramp.minZ],
    c,
    d,
    [0, 0, -1],
  );
  // Soffit, dropped along the slope normal so the underside is a surface
  // the player can read when walking under the deck.
  const drop = 0.02;
  soup.orientedFace(
    [a[0], a[1] - ny * drop, a[2] - nz * drop],
    [d[0], d[1] - ny * drop, d[2] - nz * drop],
    [c[0], c[1] - ny * drop, c[2] - nz * drop],
    [b[0], b[1] - ny * drop, b[2] - nz * drop],
    [0, -ny, -nz],
  );
}

/** Walkable top goes to the floor. Every other face is panelled shell. */
function splitBox(
  floor: Soup,
  shell: Soup,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
): void {
  const xa = Math.min(x0, x1);
  const xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1);
  const yb = Math.max(y0, y1);
  const za = Math.min(z0, z1);
  const zb = Math.max(z0, z1);
  floor.face([xa, yb, zb], [xb, yb, zb], [xb, yb, za], [xa, yb, za], [0, 1, 0]);
  shell.face([xa, ya, za], [xb, ya, za], [xb, ya, zb], [xa, ya, zb], [0, -1, 0]);
  shell.face([xb, ya, za], [xb, yb, za], [xb, yb, zb], [xb, ya, zb], [1, 0, 0]);
  shell.face([xa, ya, zb], [xa, yb, zb], [xa, yb, za], [xa, ya, za], [-1, 0, 0]);
  shell.face([xa, ya, zb], [xb, ya, zb], [xb, yb, zb], [xa, yb, zb], [0, 0, 1]);
  shell.face([xb, ya, za], [xa, ya, za], [xa, yb, za], [xb, yb, za], [0, 0, -1]);
}

function addStair(floor: Soup, shell: Soup, stair: AtriumStair): void {
  // Draw the same solids the capsule walks. The portion under the concourse
  // stays in the hull only, so the floor and the tread do not share a plane.
  for (const solid of stairCollisionBoxes(stair)) {
    const y0 = Math.max(solid.min.y, GROUND_Y);
    if (solid.max.y - y0 < 0.02) continue;
    splitBox(floor, shell, solid.min.x, solid.max.x, y0, solid.max.y, solid.min.z, solid.max.z);
  }
}

function addStructure(floor: Soup, shell: Soup, ramps: Soup): void {
  const w = WELL_HALF;
  const c = CONCOURSE;
  const ring = RING_INNER;
  const edge = MAP_HALF;
  splitBox(floor, shell, -w, w, -0.06, 0, -w, w);
  splitBox(floor, shell, -c, c, 0, GROUND_Y, w, c);
  splitBox(floor, shell, -c, c, 0, GROUND_Y, -c, -w);
  splitBox(floor, shell, -c, -w, 0, GROUND_Y, -w, w);
  splitBox(floor, shell, w, c, 0, GROUND_Y, -w, w);

  // Outer ring. The inner edge stops a centimetre short of the parapet so the
  // shared plane does not flicker.
  const seam = 0.02;
  splitBox(floor, shell, -edge, edge, 0, CATWALK_Y, ring + seam, edge);
  splitBox(floor, shell, -edge, edge, 0, CATWALK_Y, -edge, -(ring + seam));
  splitBox(floor, shell, ring + seam, edge, 0, CATWALK_Y, -ring, ring);
  splitBox(floor, shell, -edge, -(ring + seam), 0, CATWALK_Y, -ring, ring);

  shell.box(-ring, ring, 0, PARAPET_Y, c, ring);
  shell.box(-ring, -10.2, 0, PARAPET_Y, -ring, -c);
  shell.box(-7.6, 7.6, 0, PARAPET_Y, -ring, -c);
  shell.box(10.2, ring, 0, PARAPET_Y, -ring, -c);
  for (const run of sideParapetRuns()) {
    shell.box(run.x0, run.x1, 0, run.y1, run.z0, run.z1);
  }

  for (const ramp of ATRIUM_RAMPS) {
    addRamp(ramps, ramp);
    splitBox(floor, shell, ramp.minX, ramp.maxX, GROUND_Y, CATWALK_Y, -ring, ramp.minZ);
    const againstParapet = ramp.minX < 0 ? "west" : "east";
    if (againstParapet !== "west") {
      shell.box(ramp.minX, ramp.minX + 0.16, GROUND_Y, PARAPET_Y - 0.05, ramp.minZ, ramp.maxZ);
    }
    if (againstParapet !== "east") {
      shell.box(ramp.maxX - 0.16, ramp.maxX, GROUND_Y, PARAPET_Y - 0.05, ramp.minZ, ramp.maxZ);
    }
  }
  for (const stair of ATRIUM_STAIRS) addStair(floor, shell, stair);

  for (const pillar of ATRIUM_PILLARS) {
    shell.box(
      pillar.x - pillar.half,
      pillar.x + pillar.half,
      GROUND_Y,
      pillar.top,
      pillar.z - pillar.half,
      pillar.z + pillar.half,
    );
  }

  shell.box(ATRIUM_CRATES.x0, ATRIUM_CRATES.x1, ATRIUM_CRATES.y0, ATRIUM_CRATES.y0 + ATRIUM_CRATES.height, ATRIUM_CRATES.z0, ATRIUM_CRATES.z1);
  shell.box(
    ATRIUM_CRATES.x0,
    ATRIUM_CRATES.x1,
    ATRIUM_CRATES.y0 + ATRIUM_CRATES.height,
    ATRIUM_CRATES.y0 + ATRIUM_CRATES.height * 2,
    ATRIUM_CRATES.z0,
    ATRIUM_CRATES.z1,
  );
  shell.box(1.7, 3.5, 0, 0.28, -2.55, -2.15);

  const wall = 0.4;
  shell.box(-edge, edge, 0, CEILING_Y, edge, edge + wall);
  shell.box(-edge, edge, 0, CEILING_Y, -(edge + wall), -edge);
  shell.box(edge, edge + wall, 0, CEILING_Y, -edge, edge);
  shell.box(-(edge + wall), -edge, 0, CEILING_Y, -edge, edge);

  const sky = 6.2;
  const slab = 0.22;
  const cy = CEILING_Y - 0.05;
  shell.box(-edge, edge, cy, cy + slab, sky, edge);
  shell.box(-edge, edge, cy, cy + slab, -edge, -sky);
  shell.box(sky, edge, cy, cy + slab, -sky, sky);
  shell.box(-edge, -sky, cy, cy + slab, -sky, sky);
  for (const at of [-2.6, 2.6]) {
    shell.box(-5.4, 5.4, 8.48, 8.64, at - 0.06, at + 0.06);
    shell.box(at - 0.06, at + 0.06, 8.48, 8.64, -5.4, 5.4);
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

  // Slot lips. The well-side edge of each lowered shelf, drawn with the
  // existing glow so the drop reads on purpose. No hull, so it cannot block.
  const lipZ0 = -JUMP_LANE_HALF + 0.04;
  const lipZ1 = JUMP_LANE_HALF - 0.04;
  const lipY0 = CATWALK_Y + 0.015;
  const lipY1 = CATWALK_Y + 0.045;
  cyan.box(CONCOURSE + 0.04, CONCOURSE + 0.2, lipY0, lipY1, lipZ0, lipZ1);
  cyan.box(CONCOURSE - 0.05, CONCOURSE - 0.012, CATWALK_Y - 0.16, CATWALK_Y + 0.02, lipZ0, lipZ1);
  magenta.box(-CONCOURSE - 0.2, -CONCOURSE - 0.04, lipY0, lipY1, lipZ0, lipZ1);
  magenta.box(-CONCOURSE + 0.012, -CONCOURSE + 0.05, CATWALK_Y - 0.16, CATWALK_Y + 0.02, lipZ0, lipZ1);
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

/** Cyan vest plate standing on a lit pad. Drawn when ARMOR_ENABLED is on. */
function addArmorShape(soup: Soup, pad: AtriumPad): void {
  const { x, z } = pad.position;
  const y = pad.position.y + 0.02;
  soup.box(x - 0.34, x + 0.34, y, y + 0.045, z - 0.24, z + 0.24);
  soup.box(x - 0.38, x + 0.38, y + 0.045, y + 0.07, z - 0.28, z - 0.22);
  soup.box(x - 0.38, x + 0.38, y + 0.045, y + 0.07, z + 0.22, z + 0.28);
  soup.box(x - 0.38, x - 0.32, y + 0.045, y + 0.07, z - 0.22, z + 0.22);
  soup.box(x + 0.32, x + 0.38, y + 0.045, y + 0.07, z - 0.22, z + 0.22);
  soup.box(x - 0.15, x + 0.15, y + 0.07, y + 0.48, z - 0.04, z + 0.04);
  soup.box(x - 0.2, x - 0.08, y + 0.36, y + 0.54, z - 0.03, z + 0.03);
  soup.box(x + 0.08, x + 0.2, y + 0.36, y + 0.54, z - 0.03, z + 0.03);
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

function shift(p: Triple, n: Triple, dist: number): [number, number, number] {
  return [p[0] + n[0] * dist, p[1] + n[1] * dist, p[2] + n[2] * dist];
}

/** A quad pushed off the surface it marks so it does not flicker against it. */
function proud(soup: Soup, a: Triple, b: Triple, c: Triple, d: Triple, n: Triple, dist = 0.022): void {
  soup.orientedFace(shift(a, n, dist), shift(b, n, dist), shift(c, n, dist), shift(d, n, dist), n);
}

function addWellLip(trim: Soup): void {
  const w = WELL_HALF;
  const y1 = GROUND_Y;
  // Full-height risers, one per side of the 0.8 m step, proud into the well.
  proud(trim, [-w, 0.02, w], [w, 0.02, w], [w, y1, w], [-w, y1, w], [0, 0, -1]);
  proud(trim, [-w, 0.02, -w], [-w, y1, -w], [w, y1, -w], [w, 0.02, -w], [0, 0, 1]);
  proud(trim, [w, 0.02, -w], [w, y1, -w], [w, y1, w], [w, 0.02, w], [-1, 0, 0]);
  proud(trim, [-w, 0.02, -w], [-w, 0.02, w], [-w, y1, w], [-w, y1, -w], [1, 0, 0]);
  // Nosing on the concourse side of the lip, seen from the ring.
  proud(trim, [-w, y1, w - 0.02], [w, y1, w - 0.02], [w, y1, w + 0.08], [-w, y1, w + 0.08], [0, 1, 0], 0.028);
  proud(trim, [-w, y1, -w - 0.08], [w, y1, -w - 0.08], [w, y1, -w + 0.02], [-w, y1, -w + 0.02], [0, 1, 0], 0.028);
  proud(trim, [w - 0.02, y1, -w], [w - 0.02, y1, w], [w + 0.08, y1, w], [w + 0.08, y1, -w], [0, 1, 0], 0.028);
  proud(trim, [-w - 0.08, y1, -w], [-w - 0.08, y1, w], [-w + 0.02, y1, w], [-w + 0.02, y1, -w], [0, 1, 0], 0.028);
  // The low block in the well is a short step. A cap keeps its top from vanishing.
  proud(trim, [1.7, 0.28, -2.55], [3.5, 0.28, -2.55], [3.5, 0.28, -2.15], [1.7, 0.28, -2.15], [0, 1, 0], 0.02);
}

function addRampTrim(trim: Soup, ramp: AtriumRamp): void {
  const yHigh = ramp.yLow + ramp.rise;
  const span = ramp.maxZ - ramp.minZ;
  const slope = span === 0 ? 0 : ramp.rise / span;
  const len = Math.hypot(1, slope);
  const ny = 1 / len;
  const nz = slope / len;
  const lift = 0.03;
  const y0 = ramp.yLow + ny * lift;
  const z0 = ramp.maxZ + nz * lift;
  const y1 = yHigh + ny * lift;
  const z1 = ramp.minZ + nz * lift;
  const up: Triple = [0, ny, nz];
  const down: Triple = [0, -ny, -nz];
  // Rails eat the outer centimetres. The ribbons sit on the walking edges.
  const westRail = ramp.minX < 0 ? 0 : 0.16;
  const eastRail = ramp.minX < 0 ? 0.16 : 0;
  const xWest = ramp.minX + westRail;
  const xEast = ramp.maxX - eastRail;
  const band = 0.07;
  proud(
    trim,
    [xWest + 0.012, y0, z0],
    [xWest + band, y0, z0],
    [xWest + band, y1, z1],
    [xWest + 0.012, y1, z1],
    up,
    0.01,
  );
  proud(
    trim,
    [xEast - band, y0, z0],
    [xEast - 0.012, y0, z0],
    [xEast - 0.012, y1, z1],
    [xEast - band, y1, z1],
    up,
    0.01,
  );
  const drop = 0.045;
  const sy0 = ramp.yLow - ny * drop;
  const sz0 = ramp.maxZ - nz * drop;
  const sy1 = yHigh - ny * drop;
  const sz1 = ramp.minZ - nz * drop;
  proud(
    trim,
    [xWest + 0.012, sy0, sz0],
    [xWest + 0.012, sy1, sz1],
    [xWest + band, sy1, sz1],
    [xWest + band, sy0, sz0],
    down,
    0.01,
  );
  proud(
    trim,
    [xEast - 0.012, sy0, sz0],
    [xEast - band, sy0, sz0],
    [xEast - band, sy1, sz1],
    [xEast - 0.012, sy1, sz1],
    down,
    0.01,
  );
  // Thresholds: the foot on the ground ring, and the landing on the bridge.
  trim.box(ramp.minX, ramp.maxX, ramp.yLow + 0.01, ramp.yLow + 0.045, ramp.maxZ + 0.004, ramp.maxZ + 0.09);
  trim.box(ramp.minX, ramp.maxX, yHigh + 0.01, yHigh + 0.042, ramp.minZ - 0.1, ramp.minZ + 0.02);
}

function addStairTrim(trim: Soup, stair: AtriumStair): void {
  const x0 = Math.min(stair.x0, stair.x1);
  const x1 = Math.max(stair.x0, stair.x1);
  const flightEnd = stair.z0 + STAIR_COUNT * STAIR_DEPTH;
  for (let i = 0; i < STAIR_COUNT; i += 1) {
    const z = stair.z0 + i * STAIR_DEPTH;
    const y0 = GROUND_Y + i * STAIR_RISE;
    const y1 = y0 + STAIR_RISE;
    proud(trim, [x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], [0, 0, -1], 0.02);
    proud(trim, [x0, y1, z - 0.01], [x1, y1, z - 0.01], [x1, y1, z + 0.06], [x0, y1, z + 0.06], [0, 1, 0], 0.018);
  }
  const stringer = (xEdge: number, outward: number): void => {
    const xNear = xEdge + outward * 0.012;
    const xFar = xEdge + outward * 0.055;
    const n: Triple = [outward > 0 ? 1 : -1, 0, 0];
    trim.orientedFace(
      [xNear, GROUND_Y, stair.z0],
      [xFar, GROUND_Y, stair.z0],
      [xFar, CATWALK_Y, flightEnd],
      [xNear, CATWALK_Y, flightEnd],
      n,
    );
  };
  stringer(x0, -1);
  stringer(x1, 1);
  proud(
    trim,
    [x0, CATWALK_Y, flightEnd - 0.02],
    [x1, CATWALK_Y, flightEnd - 0.02],
    [x1, CATWALK_Y, flightEnd + 0.1],
    [x0, CATWALK_Y, flightEnd + 0.1],
    [0, 1, 0],
    0.02,
  );
}

function addBaseboards(trim: Soup): void {
  const h0 = GROUND_Y + 0.012;
  const h1 = GROUND_Y + 0.16;
  const t0 = 0.01;
  const t1 = 0.05;
  // Parapet feet on the ground ring. Gaps match the ramp mouths and stair doors.
  trim.box(-CONCOURSE + 0.06, CONCOURSE - 0.06, h0, h1, CONCOURSE - t1, CONCOURSE - t0);
  trim.box(-CONCOURSE + 0.06, -10.25, h0, h1, -CONCOURSE + t0, -CONCOURSE + t1);
  trim.box(-7.55, 7.55, h0, h1, -CONCOURSE + t0, -CONCOURSE + t1);
  trim.box(10.25, CONCOURSE - 0.06, h0, h1, -CONCOURSE + t0, -CONCOURSE + t1);
  trim.box(CONCOURSE + t0, CONCOURSE + t1, h0, h1, -CONCOURSE + 0.06, STAIR_LAND_Z0 - 0.04);
  trim.box(-CONCOURSE - t1, -CONCOURSE - t0, h0, h1, -CONCOURSE + 0.06, STAIR_LAND_Z0 - 0.04);

  const c0 = CATWALK_Y + 0.012;
  const c1 = CATWALK_Y + 0.18;
  const inset = 0.1;
  trim.box(-MAP_HALF + inset, MAP_HALF - inset, c0, c1, MAP_HALF - t1, MAP_HALF - t0);
  trim.box(-MAP_HALF + inset, MAP_HALF - inset, c0, c1, -MAP_HALF + t0, -MAP_HALF + t1);
  trim.box(MAP_HALF - t1, MAP_HALF - t0, c0, c1, -MAP_HALF + inset, MAP_HALF - inset);
  trim.box(-MAP_HALF + t0, -MAP_HALF + t1, c0, c1, -MAP_HALF + inset, MAP_HALF - inset);
}

function addPillarPlinths(trim: Soup): void {
  for (const pillar of ATRIUM_PILLARS) {
    const pad = pillar.half + 0.07;
    trim.box(
      pillar.x - pad,
      pillar.x + pad,
      GROUND_Y + 0.01,
      GROUND_Y + 0.05,
      pillar.z - pad,
      pillar.z + pad,
    );
  }
}

function addSoffitLips(trim: Soup): void {
  const y0 = CATWALK_Y - 0.1;
  const y1 = CATWALK_Y + 0.045;
  const south: Triple = [0, 0, -1];
  const north: Triple = [0, 0, 1];
  proud(trim, [-RING_INNER, y0, CONCOURSE], [RING_INNER, y0, CONCOURSE], [RING_INNER, y1, CONCOURSE], [-RING_INNER, y1, CONCOURSE], south);
  proud(trim, [-RING_INNER, y0, -CONCOURSE], [-10.25, y0, -CONCOURSE], [-10.25, y1, -CONCOURSE], [-RING_INNER, y1, -CONCOURSE], north);
  proud(trim, [-7.55, y0, -CONCOURSE], [7.55, y0, -CONCOURSE], [7.55, y1, -CONCOURSE], [-7.55, y1, -CONCOURSE], north);
  proud(trim, [10.25, y0, -CONCOURSE], [RING_INNER, y0, -CONCOURSE], [RING_INNER, y1, -CONCOURSE], [10.25, y1, -CONCOURSE], north);
  proud(
    trim,
    [CONCOURSE, y0, -CONCOURSE],
    [CONCOURSE, y0, STAIR_LAND_Z0],
    [CONCOURSE, y1, STAIR_LAND_Z0],
    [CONCOURSE, y1, -CONCOURSE],
    [-1, 0, 0],
  );
  proud(
    trim,
    [-CONCOURSE, y0, -CONCOURSE],
    [-CONCOURSE, y1, -CONCOURSE],
    [-CONCOURSE, y1, STAIR_LAND_Z0],
    [-CONCOURSE, y0, STAIR_LAND_Z0],
    [1, 0, 0],
  );
}

function addTrim(trim: Soup): void {
  addWellLip(trim);
  for (const ramp of ATRIUM_RAMPS) addRampTrim(trim, ramp);
  for (const stair of ATRIUM_STAIRS) addStairTrim(trim, stair);
  addBaseboards(trim);
  addPillarPlinths(trim);
  addSoffitLips(trim);
}

type RGB = readonly [number, number, number];

/** Chevron scroll and column rise. One full cycle is about a second. */
export const JUMP_PAD_MARK_PERIOD_MS = 1000;

const CHEVRON_COUNT = 4;
const CHEVRON_DEPTH = 0.26;
const SPAN_RATIO = 0.7;
const PLATE_EAST: RGB = [0, 1, 1];
const PLATE_WEST: RGB = [1, 0, 1];
const COLUMN_TOP = 3.8;
const PARTICLE_COUNT = 6;

export function jumpPadMarkPhase(nowMs: number): number {
  const period = JUMP_PAD_MARK_PERIOD_MS;
  const wrapped = ((nowMs % period) + period) % period;
  return wrapped / period;
}

function writeTri(
  position: Float32Array,
  color: Float32Array,
  offset: number,
  a: Triple,
  b: Triple,
  c: Triple,
  rgb: RGB,
): number {
  const verts = [a, b, c];
  for (const vert of verts) {
    position[offset] = vert[0];
    position[offset + 1] = vert[1];
    position[offset + 2] = vert[2];
    color[offset] = rgb[0];
    color[offset + 1] = rgb[1];
    color[offset + 2] = rgb[2];
    offset += 3;
  }
  return offset;
}

function writeQuad(
  position: Float32Array,
  color: Float32Array,
  offset: number,
  a: Triple,
  b: Triple,
  c: Triple,
  d: Triple,
  rgb: RGB,
): number {
  offset = writeTri(position, color, offset, a, b, c, rgb);
  return writeTri(position, color, offset, a, c, d, rgb);
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
  rgb: RGB,
): number {
  offset = writeQuad(position, color, offset, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], rgb);
  offset = writeQuad(position, color, offset, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], rgb);
  offset = writeQuad(position, color, offset, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], rgb);
  offset = writeQuad(position, color, offset, [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], rgb);
  offset = writeQuad(position, color, offset, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], rgb);
  return writeQuad(position, color, offset, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], rgb);
}

/** Tip positions along the launch axis. Phase 0 spans SPAN_RATIO of the plate. */
function chevronTips(pad: AtriumJumpPad, phase: number): number[] {
  const alongMin = pad.dirX > 0 ? pad.minX : -pad.maxX;
  const alongMax = pad.dirX > 0 ? pad.maxX : -pad.minX;
  const span = SPAN_RATIO * (alongMax - alongMin);
  const travel = ((span - CHEVRON_DEPTH) * CHEVRON_COUNT) / (CHEVRON_COUNT - 1);
  const spacing = travel / CHEVRON_COUNT;
  const center = (alongMin + alongMax) / 2;
  const tip0 = center - span / 2 + CHEVRON_DEPTH;
  const shift = phase * spacing;
  const tips: number[] = [];
  for (let i = 0; i < CHEVRON_COUNT; i += 1) {
    const raw = tip0 + i * spacing + shift;
    tips.push(tip0 + ((((raw - tip0) % travel) + travel) % travel));
  }
  return tips;
}

function writeChevron(
  position: Float32Array,
  color: Float32Array,
  offset: number,
  tipAlong: number,
  dirX: number,
  z: number,
  rgb: RGB,
): number {
  const y = 0.078;
  const tipX = dirX * tipAlong;
  const tailX = tipX - dirX * CHEVRON_DEPTH;
  const near = 0.05;
  const far = 0.22;
  offset = writeQuad(
    position,
    color,
    offset,
    [tailX, y, z + near],
    [tailX, y, z + far],
    [tipX, y, z + 0.015],
    [tipX, y, z - 0.015],
    rgb,
  );
  return writeQuad(
    position,
    color,
    offset,
    [tailX, y, z - far],
    [tailX, y, z - near],
    [tipX, y, z + 0.015],
    [tipX, y, z - 0.015],
    rgb,
  );
}

function paintPads(position: Float32Array, color: Float32Array, phase: number): void {
  let offset = 0;
  const pulse = 0.4 + 0.6 * (0.5 - 0.5 * Math.cos(phase * Math.PI * 2));
  const mark: RGB = [pulse, pulse, pulse];
  for (const pad of ATRIUM_JUMP_PADS) {
    const plate = pad.dirX > 0 ? PLATE_EAST : PLATE_WEST;
    offset = writeBox(
      position,
      color,
      offset,
      pad.minX,
      pad.maxX,
      0.02,
      0.05,
      pad.minZ,
      pad.maxZ,
      plate,
    );
    for (const tip of chevronTips(pad, phase)) {
      offset = writeChevron(position, color, offset, tip, pad.dirX, pad.z, mark);
    }
  }
}

function paintColumns(position: Float32Array, color: Float32Array, phase: number): void {
  let offset = 0;
  const rise = COLUMN_TOP - 0.4;
  for (const pad of ATRIUM_JUMP_PADS) {
    const plate = pad.dirX > 0 ? PLATE_EAST : PLATE_WEST;
    const half = 0.07;
    offset = writeQuad(
      position,
      color,
      offset,
      [pad.x - half, 0.06, pad.z],
      [pad.x + half, 0.06, pad.z],
      [pad.x + half, COLUMN_TOP, pad.z],
      [pad.x - half, COLUMN_TOP, pad.z],
      plate,
    );
    offset = writeQuad(
      position,
      color,
      offset,
      [pad.x, 0.06, pad.z - half],
      [pad.x, 0.06, pad.z + half],
      [pad.x, COLUMN_TOP, pad.z + half],
      [pad.x, COLUMN_TOP, pad.z - half],
      plate,
    );
    const speck = 0.045;
    for (let i = 0; i < PARTICLE_COUNT; i += 1) {
      const y = 0.4 + ((((i / PARTICLE_COUNT + phase) % 1) + 1) % 1) * rise;
      offset = writeQuad(
        position,
        color,
        offset,
        [pad.x - speck, y, pad.z - speck],
        [pad.x + speck, y, pad.z - speck],
        [pad.x + speck, y + 0.02, pad.z + speck],
        [pad.x - speck, y + 0.02, pad.z + speck],
        plate,
      );
    }
  }
}

function markMesh(
  name: string,
  floats: number,
  paint: (position: Float32Array, color: Float32Array, phase: number) => void,
  material: MeshBasicMaterial,
): Mesh {
  const position = new Float32Array(floats);
  const color = new Float32Array(floats);
  paint(position, color, 0);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(color, 3));
  const mesh = new Mesh(geometry, material);
  mesh.name = name;
  material.name = name;
  mesh.onBeforeRender = () => {
    applyJumpPadMarks(mesh, jumpPadMarkPhase(performance.now()));
  };
  return mesh;
}

/** Rewrites chevrons or the rising column for one phase in 0..1. */
export function applyJumpPadMarks(mesh: Mesh, phase: number): void {
  const position = mesh.geometry.getAttribute("position");
  const color = mesh.geometry.getAttribute("color");
  if (!position || !color) return;
  const positions = position.array as Float32Array;
  const colors = color.array as Float32Array;
  if (mesh.name === "atrium-jump-columns") paintColumns(positions, colors, phase);
  else paintPads(positions, colors, phase);
  position.needsUpdate = true;
  color.needsUpdate = true;
}

function padFloatCount(): number {
  const boxVerts = 36;
  const chevronVerts = CHEVRON_COUNT * 12;
  return ATRIUM_JUMP_PADS.length * (boxVerts + chevronVerts) * 3;
}

function columnFloatCount(): number {
  const crossVerts = 12;
  const particleVerts = PARTICLE_COUNT * 6;
  return ATRIUM_JUMP_PADS.length * (crossVerts + particleVerts) * 3;
}

/** Saturated plates plus chevrons that scroll along the launch. */
function jumpPadMesh(): { mesh: Mesh; triangles: number } {
  const mesh = markMesh(
    "atrium-jump-pads",
    padFloatCount(),
    paintPads,
    new MeshBasicMaterial({
      vertexColors: true,
      toneMapped: false,
      side: DoubleSide,
    }),
  );
  return { mesh, triangles: padFloatCount() / 9 };
}

/** Thin additive column and rising specks. Depth is not written, so it cannot hide a target. */
function jumpColumnMesh(): { mesh: Mesh; triangles: number } {
  const mesh = markMesh(
    "atrium-jump-columns",
    columnFloatCount(),
    paintColumns,
    new MeshBasicMaterial({
      vertexColors: true,
      toneMapped: false,
      transparent: true,
      opacity: 0.28,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    }),
  );
  return { mesh, triangles: columnFloatCount() / 9 };
}

export function buildAtriumView(): AtriumView {
  const floor = new Soup();
  const shell = new Soup();
  const ramps = new Soup();
  addStructure(floor, shell, ramps);
  const trim = new Soup();
  addTrim(trim);
  const cyan = new Soup();
  const magenta = new Soup();
  addChannels(cyan, magenta);
  const amber = new Soup();
  addBeacons(amber);
  const motionTriangles = motionVertexCount() / 3;
  const pads = buildPadViews();
  const jumpPads = jumpPadMesh();
  const jumpColumns = jumpColumnMesh();

  const panel = createPanelTexture();
  const panels = shellMaterial(panel);
  const meshes = [
    phongMesh(floor, floorMaterial(), "atrium-floor"),
    phongMesh(shell, panels, "atrium-shell"),
    phongMesh(ramps, panels, "atrium-ramp"),
    phongMesh(trim, trimMaterial(), "atrium-trim"),
    glowMesh(cyan, CYAN, "atrium-cyan"),
    glowMesh(magenta, MAGENTA, "atrium-magenta"),
    glowMesh(amber, AMBER, "atrium-amber"),
  ];
  const amberMesh = meshes[meshes.length - 1];
  if (amberMesh) attachAtriumMotion(amberMesh);
  for (const pad of pads.pads) meshes.push(pad.mesh);
  meshes.push(jumpPads.mesh);
  meshes.push(jumpColumns.mesh);
  let triangles =
    floor.triangles +
    shell.triangles +
    ramps.triangles +
    trim.triangles +
    cyan.triangles +
    magenta.triangles +
    amber.triangles +
    motionTriangles +
    pads.triangles +
    jumpPads.triangles +
    jumpColumns.triangles;
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
/** Exponential fog. Light enough that a drone at 14 m and the slot lips stay readable. */
export const ATRIUM_FOG_DENSITY = 0.015;
