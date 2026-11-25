// Cyber-Ganger view. One merged body for every living rusher, so two of them
// are one draw. The magenta blade is vertex color on that same mesh. The trail,
// the hit flash, and the gore pools stay hidden until they have something to
// show, which keeps a wave-1 frame from gaining a draw. Nothing here is loaded.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Scene,
  type Texture,
} from "three";
import { HIT_FLASH_RGB, hitFlashAlpha } from "./feel.ts";
import { GORE_BLOOD, GORE_DECAL_CAP, GORE_GIB_CAP, GORE_SPRAY_CAP, type GoreDecal, type GorePart } from "./gore.ts";
import { RUSHER_TRAIL_CAP, type RusherSim, type RusherTrail, type RusherUnit } from "./rusher.ts";
import { RUSHER_CAP } from "./waves.ts";

const _quat = new Quaternion();
const _tilt = new Quaternion();
const _pos = new Vector3();
const _scale = new Vector3();
const _matrix = new Matrix4();
const _up = new Vector3(0, 1, 0);
const _right = new Vector3(1, 0, 0);
const _decalNormal = new Vector3(0, 0, 1);
const _aim = new Vector3();
const _color = new Color();
const _gibA = new Color(GORE_BLOOD);
const _white = new Color(1, 1, 1);

const CLOTH: readonly [number, number, number] = [0.09, 0.1, 0.13];
const STRAP: readonly [number, number, number] = [0.18, 0.07, 0.12];
const HOOD: readonly [number, number, number] = [0.05, 0.05, 0.07];
/** Pale magenta. Bright enough that the atrium bloom picks the edge up. */
const BLADE: readonly [number, number, number] = [1, 0.9, 1];
const SLIT: readonly [number, number, number] = [1, 0.16, 0.55];

/** Added on top of the body color during windup, then clamped. Linear RGB. */
export const RUSHER_WINDUP_EMISSIVE: readonly [number, number, number] = [0.7, 0.16, 0.58];
/**
 * Cap for the windup flash. The atrium bloom extracts above 0.88, so a body
 * that stays under this lights up without a halo across the frame.
 */
export const RUSHER_WINDUP_CAP = 0.82;

/** 0 hides the flash. 1 is the full emissive add, still clamped by the cap. */
export function rusherWindupAmount(swing: number): number {
  const pulse = 0.5 + 0.5 * Math.sin(swing * 48);
  return 0.72 + pulse * 0.28;
}

/** Body color during windup. Every channel stays at or under the cap. */
export function rusherWindupColor(
  vertex: readonly [number, number, number],
  swing: number,
): readonly [number, number, number] {
  const amount = rusherWindupAmount(swing);
  return [
    Math.min(vertex[0] + amount * RUSHER_WINDUP_EMISSIVE[0], RUSHER_WINDUP_CAP),
    Math.min(vertex[1] + amount * RUSHER_WINDUP_EMISSIVE[1], RUSHER_WINDUP_CAP),
    Math.min(vertex[2] + amount * RUSHER_WINDUP_EMISSIVE[2], RUSHER_WINDUP_CAP),
  ];
}

export function mountRusherView(scene: Scene, sim: RusherSim): { sync(): void } {
  const bodyMat = new MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: true });
  const shellGeom = bodyGeometry();
  const bodyGeom = shellGeom.clone();
  const windup = new InstancedBufferAttribute(new Float32Array(RUSHER_CAP), 1);
  windup.setUsage(DynamicDrawUsage);
  bodyGeom.setAttribute("windup", windup);
  bodyMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float windup;\nvarying float vWindup;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWindup = windup;");
    const add = RUSHER_WINDUP_EMISSIVE.map((channel) => channel.toFixed(3)).join(", ");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vWindup;")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
         diffuseColor.rgb = min(diffuseColor.rgb + vWindup * vec3(${add}), vec3(${RUSHER_WINDUP_CAP.toFixed(3)}));`,
      );
  };
  bodyMat.customProgramCacheKey = () => "rusher-windup-cap";
  const bodies = instanced(bodyGeom, bodyMat, RUSHER_CAP);
  bodies.name = "rusher-body";

  const shellMat = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const shells = instanced(shellGeom, shellMat, RUSHER_CAP);
  shells.name = "rusher-hit-flash";

  const trailMat = new MeshBasicMaterial({
    color: 0xff4ad0,
    transparent: true,
    opacity: 0.85,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
    side: DoubleSide,
  });
  const trails = instanced(trailGeometry(), trailMat, RUSHER_TRAIL_CAP);
  trails.name = "rusher-trail";

  const bloodPositions = new Float32Array(GORE_SPRAY_CAP * 3);
  const bloodGeom = new BufferGeometry();
  bloodGeom.setAttribute("position", new BufferAttribute(bloodPositions, 3));
  const bloodPoints = new Points(
    bloodGeom,
    new PointsMaterial({
      color: GORE_BLOOD,
      size: 0.11,
      sizeAttenuation: true,
      toneMapped: false,
      fog: false,
      depthWrite: false,
    }),
  );
  bloodPoints.name = "rusher-blood";
  bloodPoints.frustumCulled = false;
  bloodPoints.visible = false;

  const gibMat = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false, fog: true });
  const gibs = instanced(chunkGeometry(), gibMat, GORE_GIB_CAP);
  gibs.name = "rusher-gibs";
  paint(gibs, _gibA);

  const decalMat = new MeshBasicMaterial({
    map: bloodTexture(),
    color: 0xffffff,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    toneMapped: false,
    fog: true,
    side: DoubleSide,
  });
  const decals = instanced(decalGeometry(), decalMat, GORE_DECAL_CAP);
  decals.name = "rusher-decals";
  paint(decals, _white);

  scene.add(bodies, shells, trails, bloodPoints, gibs, decals);

  return {
    sync(): void {
      let shown = 0;
      const units = sim.units;
      for (let i = 0; i < units.length; i += 1) {
        const unit = units[i]!;
        const falling = !unit.alive && unit.down >= 0 && unit.down < 0.5;
        if (!unit.alive && !falling) continue;
        const fall = falling ? unit.down / 0.5 : 0;
        placeBody(bodies, shown, unit, fall);
        tintBody(bodies, shown, unit);
        windup.setX(shown, unit.phase === "telegraph" ? rusherWindupAmount(unit.swing) : 0);
        shown += 1;
      }
      show(bodies, shown);
      windup.needsUpdate = true;
      if (shown > 0 && bodies.instanceColor) bodies.instanceColor.needsUpdate = true;

      let shellCount = 0;
      for (let i = 0; i < units.length; i += 1) {
        const unit = units[i]!;
        const alpha = hitFlashAlpha(unit.hitFlash);
        if (!(alpha > 0.02)) continue;
        const falling = !unit.alive && unit.down >= 0 && unit.down < 0.5;
        const fall = falling ? unit.down / 0.5 : 0;
        placeBody(shells, shellCount, unit, fall);
        _color.setRGB(HIT_FLASH_RGB[0] * alpha, HIT_FLASH_RGB[1] * alpha, HIT_FLASH_RGB[2] * alpha);
        shells.setColorAt(shellCount, _color);
        shellCount += 1;
      }
      show(shells, shellCount);
      if (shellCount > 0 && shells.instanceColor) shells.instanceColor.needsUpdate = true;

      const trailCount = packTrails(trails, sim.trails);
      show(trails, trailCount);

      const bloodCount = packPoints(bloodPositions, sim.spray);
      bloodGeom.setDrawRange(0, bloodCount);
      bloodPoints.visible = bloodCount > 0;
      if (bloodCount > 0) bloodGeom.getAttribute("position").needsUpdate = true;

      const gibCount = packGibs(gibs, sim.gibs);
      show(gibs, gibCount);
      if (gibCount > 0 && gibs.instanceColor) gibs.instanceColor.needsUpdate = true;
      const decalCount = packDecals(decals, sim.decals);
      show(decals, decalCount);
      if (decalCount > 0 && decals.instanceColor) decals.instanceColor.needsUpdate = true;
    },
  };
}

function instanced(geometry: BufferGeometry, material: MeshBasicMaterial, cap: number): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, cap);
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.visible = false;
  return mesh;
}

function show(mesh: InstancedMesh, count: number): void {
  mesh.count = count;
  mesh.visible = count > 0;
  if (count > 0) mesh.instanceMatrix.needsUpdate = true;
}

function placeBody(mesh: InstancedMesh, index: number, unit: RusherUnit, fall: number): void {
  _quat.setFromAxisAngle(_up, unit.yaw);
  const lean = unit.phase === "lunge" ? 0.45 : unit.phase === "telegraph" ? -0.18 : 0;
  if (fall > 0 || lean !== 0) {
    _tilt.setFromAxisAngle(_right, fall * 1.2 + lean);
    _quat.multiply(_tilt);
  }
  _pos.set(unit.position.x, unit.position.y - fall * 0.3, unit.position.z);
  _scale.set(1, 1, 1);
  _matrix.compose(_pos, _quat, _scale);
  mesh.setMatrixAt(index, _matrix);
}

function tintBody(mesh: InstancedMesh, index: number, unit: RusherUnit): void {
  if (unit.phase === "lunge") _color.setRGB(1, 0.82, 1);
  else _color.setRGB(1, 1, 1);
  mesh.setColorAt(index, _color);
}

function packTrails(mesh: InstancedMesh, parts: readonly RusherTrail[]): number {
  let count = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (!part.alive) continue;
    const fade = 1 - part.age / Math.max(0.05, part.life);
    _quat.setFromAxisAngle(_up, part.yaw);
    _pos.set(part.x, part.y, part.z);
    const span = 0.55 + fade * 0.65;
    _scale.set(0.16, 0.04, span);
    _matrix.compose(_pos, _quat, _scale);
    mesh.setMatrixAt(count, _matrix);
    count += 1;
  }
  return count;
}

function packPoints(out: Float32Array, parts: readonly GorePart[]): number {
  let count = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (!part.alive) continue;
    const offset = count * 3;
    out[offset] = part.x;
    out[offset + 1] = part.y;
    out[offset + 2] = part.z;
    count += 1;
  }
  return count;
}

function packGibs(mesh: InstancedMesh, parts: readonly GorePart[]): number {
  let count = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (!part.alive) continue;
    _quat.setFromAxisAngle(_up, part.spin * part.age);
    _pos.set(part.x, part.y, part.z);
    const scale = 0.7 + part.shade * 0.35;
    _scale.set(scale, scale, scale);
    _matrix.compose(_pos, _quat, _scale);
    mesh.setMatrixAt(count, _matrix);
    count += 1;
  }
  return count;
}

function packDecals(mesh: InstancedMesh, parts: readonly GoreDecal[]): number {
  let count = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (!part.alive) continue;
    const fade = 1 - part.age / Math.max(0.05, part.life);
    _aim.set(part.nx, part.ny, part.nz);
    if (_aim.lengthSq() < 1e-8) _aim.set(0, 1, 0);
    else _aim.normalize();
    _quat.setFromUnitVectors(_decalNormal, _aim);
    _pos.set(part.x, part.y, part.z);
    const span = part.size * Math.max(0.05, fade);
    _scale.set(span, span, 1);
    _matrix.compose(_pos, _quat, _scale);
    mesh.setMatrixAt(count, _matrix);
    _color.setRGB(fade, fade * 0.92, fade * 0.92);
    mesh.setColorAt(count, _color);
    count += 1;
  }
  return count;
}

function paint(mesh: InstancedMesh, color: Color): void {
  const capacity = mesh.instanceMatrix.count;
  for (let i = 0; i < capacity; i += 1) mesh.setColorAt(i, color);
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

function bodyGeometry(): BufferGeometry {
  const position: number[] = [];
  const color: number[] = [];
  addBox(position, color, -0.16, 0, -0.08, -0.02, 0.72, 0.08, CLOTH);
  addBox(position, color, 0.02, 0, -0.08, 0.16, 0.72, 0.08, CLOTH);
  addBox(position, color, -0.18, 0.66, -0.1, 0.18, 0.9, 0.12, STRAP);
  addBox(position, color, -0.16, 0.86, -0.08, 0.12, 1.28, 0.14, CLOTH);
  addBox(position, color, -0.42, 1.14, -0.1, -0.12, 1.36, 0.12, STRAP);
  addBox(position, color, 0.08, 0.96, -0.16, 0.36, 1.16, 0.08, CLOTH);
  addBox(position, color, 0.2, 0.7, -0.32, 0.38, 1.02, -0.08, STRAP);
  addBox(position, color, -0.12, 1.24, -0.1, 0.12, 1.58, 0.12, HOOD);
  addBox(position, color, -0.08, 1.36, -0.16, 0.08, 1.44, -0.1, SLIT);
  addBox(position, color, 0.24, 0.38, -0.78, 0.36, 1.08, -0.18, BLADE);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(color, 3));
  return geometry;
}

function trailGeometry(): BufferGeometry {
  const position: number[] = [];
  const color: number[] = [];
  addBox(position, color, -0.5, -0.5, -0.5, 0.5, 0.5, 0.5, [1, 1, 1]);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(color, 3));
  return geometry;
}

function chunkGeometry(): BufferGeometry {
  const position: number[] = [];
  const color: number[] = [];
  const white: readonly [number, number, number] = [1, 1, 1];
  const s = 0.1;
  const a: readonly [number, number, number] = [s, s, s];
  const b: readonly [number, number, number] = [-s, -s, s];
  const c: readonly [number, number, number] = [-s, s, -s];
  const d: readonly [number, number, number] = [s, -s, -s];
  pushTri(position, color, a, b, c, white);
  pushTri(position, color, a, d, b, white);
  pushTri(position, color, a, c, d, white);
  pushTri(position, color, b, d, c, white);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(color, 3));
  return geometry;
}

function decalGeometry(): BufferGeometry {
  const s = 0.5;
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new Float32BufferAttribute([-s, -s, 0, s, -s, 0, s, s, 0, -s, -s, 0, s, s, 0, -s, s, 0], 3),
  );
  geometry.setAttribute("uv", new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
  return geometry;
}

function bloodTexture(): Texture {
  const size = 64;
  const pixels = bloodPixels(size);
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (context) {
      const image = context.createImageData(size, size);
      image.data.set(pixels);
      context.putImageData(image, 0, 0);
      const texture = new CanvasTexture(canvas);
      texture.colorSpace = SRGBColorSpace;
      texture.needsUpdate = true;
      return texture;
    }
  }
  const texture = new DataTexture(pixels, size, size);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function bloodPixels(size: number): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const blobs: readonly (readonly [number, number, number])[] = [
    [0.5, 0.48, 0.28],
    [0.32, 0.58, 0.12],
    [0.68, 0.4, 0.1],
    [0.46, 0.7, 0.08],
  ];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      let alpha = 0;
      for (let i = 0; i < blobs.length; i += 1) {
        const blob = blobs[i]!;
        const dx = (u - blob[0]) / blob[2];
        const dy = (v - blob[1]) / blob[2];
        alpha = Math.max(alpha, Math.max(0, 1 - (dx * dx + dy * dy)));
      }
      const offset = (y * size + x) * 4;
      data[offset] = 154;
      data[offset + 1] = 22;
      data[offset + 2] = 28;
      data[offset + 3] = Math.round(alpha * alpha * 220);
    }
  }
  return data;
}

function addBox(
  position: number[],
  color: number[],
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  rgb: readonly [number, number, number],
): void {
  const v: readonly (readonly [number, number, number])[] = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const faces = [
    [0, 2, 1, 0, 3, 2],
    [4, 5, 6, 4, 6, 7],
    [0, 1, 5, 0, 5, 4],
    [3, 6, 2, 3, 7, 6],
    [0, 4, 7, 0, 7, 3],
    [1, 2, 6, 1, 6, 5],
  ];
  for (let i = 0; i < faces.length; i += 1) {
    const face = faces[i]!;
    pushTri(position, color, v[face[0]!]!, v[face[1]!]!, v[face[2]!]!, rgb);
    pushTri(position, color, v[face[3]!]!, v[face[4]!]!, v[face[5]!]!, rgb);
  }
}

function pushTri(
  position: number[],
  color: number[],
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  rgb: readonly [number, number, number],
): void {
  position.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  color.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
}
