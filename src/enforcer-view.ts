// UNIT-7 view. Boxes only: bulky shoulders, an opaque visor, an ORION-VEC
// chevron on the chest. The mark is a fictional plate, not a real logo.
// The visor slit is an unlit amber-red lamp so a shot reads in the dark atrium.
// Tracers, the muzzle flash, the collapse sparks, and the blood pools reuse
// fixed meshes. The blood splat is one procedural texture shared by every decal.
// Nothing here is loaded.

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
import {
  ENFORCER_FLASH_CAP,
  ENFORCER_SPARK_CAP,
  type EnforcerFlash,
  type EnforcerSim,
} from "./enforcer.ts";
import { GORE_BLOOD, GORE_DECAL_CAP, GORE_GIB_CAP, GORE_SPRAY_CAP, type GoreDecal, type GorePart } from "./gore.ts";
import { ENFORCER_CAP } from "./waves.ts";

const _quat = new Quaternion();
const _tilt = new Quaternion();
const _pos = new Vector3();
const _scale = new Vector3();
const _matrix = new Matrix4();
const _up = new Vector3(0, 1, 0);
const _right = new Vector3(1, 0, 0);
const _forward = new Vector3(0, 0, -1);
const _decalNormal = new Vector3(0, 0, 1);
const _aim = new Vector3();
const _color = new Color();
const _gibA = new Color(GORE_BLOOD);
const _gibB = new Color(0x4e1014);

const ARMOR: readonly [number, number, number] = [0.16, 0.19, 0.24];
const PLATE: readonly [number, number, number] = [0.28, 0.33, 0.4];
const SHOULDER: readonly [number, number, number] = [0.12, 0.14, 0.18];
const MARK: readonly [number, number, number] = [0.93, 0.62, 0.18];

export function mountEnforcerView(scene: Scene, sim: EnforcerSim): { sync(): void } {
  const bodyMat = new MeshBasicMaterial({
    vertexColors: true,
    toneMapped: false,
    fog: true,
  });
  const bodies = instanced(bodyGeometry(), bodyMat, ENFORCER_CAP);
  bodies.name = "enforcer-body";

  const visorMat = new MeshBasicMaterial({
    color: 0xff4a1a,
    toneMapped: false,
    fog: false,
  });
  const visors = instanced(visorGeometry(), visorMat, ENFORCER_CAP);
  visors.name = "enforcer-visor";

  const flashMat = new MeshBasicMaterial({
    color: 0xffe2a8,
    transparent: true,
    opacity: 0.9,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const tracers = instanced(tracerGeometry(), flashMat, ENFORCER_FLASH_CAP * 2);
  tracers.name = "enforcer-tracer";

  const sparkPositions = new Float32Array(ENFORCER_SPARK_CAP * 3);
  const sparkGeom = new BufferGeometry();
  sparkGeom.setAttribute("position", new BufferAttribute(sparkPositions, 3));
  const sparkPoints = new Points(
    sparkGeom,
    new PointsMaterial({
      color: 0xf0c36a,
      size: 0.07,
      sizeAttenuation: true,
      toneMapped: false,
      fog: false,
      depthWrite: false,
    }),
  );
  sparkPoints.name = "enforcer-sparks";
  sparkPoints.frustumCulled = false;
  sparkPoints.visible = false;

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
  bloodPoints.name = "enforcer-blood";
  bloodPoints.frustumCulled = false;
  bloodPoints.visible = false;

  const gibMat = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false, fog: true });
  const gibs = instanced(chunkGeometry(), gibMat, GORE_GIB_CAP);
  gibs.name = "enforcer-gibs";
  paint(gibs, _gibA);

  const splat = bloodTexture();
  const decalMat = new MeshBasicMaterial({
    map: splat,
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
  decals.name = "enforcer-decals";
  paint(decals, _color.setRGB(1, 1, 1));

  scene.add(bodies, visors, tracers, sparkPoints, bloodPoints, gibs, decals);

  return {
    sync(): void {
      let shown = 0;
      const units = sim.units;
      for (let i = 0; i < units.length; i += 1) {
        const unit = units[i]!;
        const falling = !unit.alive && unit.down >= 0 && unit.down < 0.5;
        if (!unit.alive && !falling) continue;
        const fall = falling ? unit.down / 0.5 : 0;
        placeBody(bodies, shown, unit.position.x, unit.position.y - fall * 0.35, unit.position.z, unit.yaw, fall);
        placeBody(visors, shown, unit.position.x, unit.position.y - fall * 0.35, unit.position.z, unit.yaw, fall);
        shown += 1;
      }
      show(bodies, shown);
      show(visors, shown);

      let flashes = 0;
      const shots = sim.flashes;
      for (let i = 0; i < shots.length; i += 1) {
        const flash = shots[i]!;
        if (!flash.alive) continue;
        placeMuzzle(tracers, flashes, flash);
        flashes += 1;
        placeTracer(tracers, flashes, flash);
        flashes += 1;
      }
      show(tracers, flashes);

      const sparkCount = packPoints(sparkPositions, sim.sparks);
      sparkGeom.getAttribute("position").needsUpdate = true;
      sparkGeom.setDrawRange(0, sparkCount);
      sparkPoints.visible = sparkCount > 0;

      const bloodCount = packPoints(bloodPositions, sim.spray);
      bloodGeom.getAttribute("position").needsUpdate = true;
      bloodGeom.setDrawRange(0, bloodCount);
      bloodPoints.visible = bloodCount > 0;

      show(gibs, packGibs(gibs, sim.gibs));
      if (gibs.instanceColor) gibs.instanceColor.needsUpdate = true;
      show(decals, packDecals(decals, sim.decals));
      if (decals.instanceColor) decals.instanceColor.needsUpdate = true;
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

function placeBody(mesh: InstancedMesh, index: number, x: number, y: number, z: number, yaw: number, fall: number): void {
  _quat.setFromAxisAngle(_up, yaw);
  if (fall > 0) {
    _tilt.setFromAxisAngle(_right, fall * 1.35);
    _quat.multiply(_tilt);
  }
  _pos.set(x, y, z);
  _scale.set(1, 1, 1);
  _matrix.compose(_pos, _quat, _scale);
  mesh.setMatrixAt(index, _matrix);
}

function aimFlash(flash: EnforcerFlash): void {
  _aim.set(flash.dx, flash.dy, flash.dz);
  if (_aim.lengthSq() < 1e-8) _aim.set(0, 0, -1);
  else _aim.normalize();
  _quat.setFromUnitVectors(_forward, _aim);
}

function placeMuzzle(mesh: InstancedMesh, index: number, flash: EnforcerFlash): void {
  aimFlash(flash);
  const depth = 0.2;
  _pos.set(flash.x + _aim.x * depth * 0.45, flash.y + _aim.y * depth * 0.45, flash.z + _aim.z * depth * 0.45);
  _scale.set(0.28, 0.28, depth);
  _matrix.compose(_pos, _quat, _scale);
  mesh.setMatrixAt(index, _matrix);
}

function placeTracer(mesh: InstancedMesh, index: number, flash: EnforcerFlash): void {
  aimFlash(flash);
  _pos.set(flash.x, flash.y, flash.z);
  _scale.set(0.035, 0.035, Math.max(0.2, flash.length));
  _matrix.compose(_pos, _quat, _scale);
  mesh.setMatrixAt(index, _matrix);
}

function packPoints(out: Float32Array, parts: readonly { alive: boolean; x: number; y: number; z: number }[]): number {
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
    const fade = Math.max(0.08, 1 - part.age / Math.max(part.life, 1e-4));
    placeChunk(mesh, count, part.x, part.y, part.z, part.spin * part.age, 0.9 * fade);
    _color.copy(part.shade === 0 ? _gibA : _gibB);
    _color.multiplyScalar(fade);
    mesh.setColorAt(count, _color);
    count += 1;
  }
  return count;
}

function packDecals(mesh: InstancedMesh, parts: readonly GoreDecal[]): number {
  let count = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (!part.alive) continue;
    const fade = Math.max(0, 1 - part.age / Math.max(part.life, 1e-4));
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

function placeChunk(mesh: InstancedMesh, index: number, x: number, y: number, z: number, yaw: number, scale: number): void {
  _quat.setFromAxisAngle(_up, yaw);
  _pos.set(x, y, z);
  _scale.set(scale, scale, scale);
  _matrix.compose(_pos, _quat, _scale);
  mesh.setMatrixAt(index, _matrix);
}

function paint(mesh: InstancedMesh, color: Color): void {
  const capacity = mesh.instanceMatrix.count;
  for (let i = 0; i < capacity; i += 1) mesh.setColorAt(i, color);
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

function bodyGeometry(): BufferGeometry {
  const position: number[] = [];
  const color: number[] = [];
  addBox(position, color, -0.16, 0, -0.12, -0.02, 0.78, 0.12, ARMOR);
  addBox(position, color, 0.02, 0, -0.12, 0.16, 0.78, 0.12, ARMOR);
  addBox(position, color, -0.22, 0.72, -0.16, 0.22, 0.92, 0.16, PLATE);
  addBox(position, color, -0.28, 0.9, -0.18, 0.28, 1.42, 0.2, ARMOR);
  addBox(position, color, -0.62, 1.18, -0.2, -0.26, 1.48, 0.22, SHOULDER);
  addBox(position, color, 0.26, 1.18, -0.2, 0.62, 1.48, 0.22, SHOULDER);
  addBox(position, color, -0.58, 0.78, -0.12, -0.4, 1.22, 0.12, PLATE);
  addBox(position, color, 0.4, 0.78, -0.12, 0.58, 1.22, 0.12, PLATE);
  addBox(position, color, -0.16, 1.42, -0.16, 0.16, 1.78, 0.16, ARMOR);
  // ORION-VEC chest chevron. Amber on the front plate, not a copied mark.
  pushTri(position, color, [-0.12, 1.02, -0.19], [0, 1.16, -0.19], [0.12, 1.02, -0.19], MARK);
  pushTri(position, color, [-0.08, 1.05, -0.195], [0, 1.2, -0.195], [0.08, 1.05, -0.195], MARK);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(color, 3));
  return geometry;
}

function visorGeometry(): BufferGeometry {
  const position: number[] = [];
  const color: number[] = [];
  const shade: readonly [number, number, number] = [0.08, 0.09, 0.11];
  addBox(position, color, -0.12, 1.52, -0.2, 0.12, 1.66, -0.15, shade);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(color, 3));
  return geometry;
}

function tracerGeometry(): BufferGeometry {
  const position: number[] = [];
  const color: number[] = [];
  const white: readonly [number, number, number] = [1, 0.9, 0.6];
  // Local -Z so a unit-vector rotation from -Z lays the bolt along the shot.
  addBox(position, color, -0.5, -0.5, -1, 0.5, 0.5, 0, white);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(color, 3));
  return geometry;
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
