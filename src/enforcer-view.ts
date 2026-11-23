// UNIT-7 view. Boxes only: bulky shoulders, an opaque visor, an ORION-VEC
// chevron on the chest. The mark is a fictional plate, not a real logo.
// Tracers and the collapse sparks reuse fixed pools. Nothing here is loaded.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Quaternion,
  Vector3,
  type Scene,
} from "three";
import {
  ENFORCER_FLASH_CAP,
  ENFORCER_SPARK_CAP,
  type EnforcerSim,
} from "./enforcer.ts";
import { ENFORCER_CAP } from "./waves.ts";

const _quat = new Quaternion();
const _tilt = new Quaternion();
const _pos = new Vector3();
const _scale = new Vector3();
const _matrix = new Matrix4();
const _up = new Vector3(0, 1, 0);
const _right = new Vector3(1, 0, 0);
const _forward = new Vector3(0, 0, -1);
const _aim = new Vector3();

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
    color: 0x14181e,
    toneMapped: false,
    fog: true,
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
  const tracers = instanced(tracerGeometry(), flashMat, ENFORCER_FLASH_CAP);
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

  scene.add(bodies, visors, tracers, sparkPoints);

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
        placeTracer(tracers, flashes, flash.x, flash.y, flash.z, flash.dx, flash.dy, flash.dz, flash.length);
        flashes += 1;
      }
      show(tracers, flashes);

      let sparkCount = 0;
      const parts = sim.sparks;
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i]!;
        if (!part.alive) continue;
        const offset = sparkCount * 3;
        sparkPositions[offset] = part.x;
        sparkPositions[offset + 1] = part.y;
        sparkPositions[offset + 2] = part.z;
        sparkCount += 1;
      }
      sparkGeom.getAttribute("position").needsUpdate = true;
      sparkGeom.setDrawRange(0, sparkCount);
      sparkPoints.visible = sparkCount > 0;
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

function placeTracer(
  mesh: InstancedMesh,
  index: number,
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
  length: number,
): void {
  _aim.set(dx, dy, dz);
  if (_aim.lengthSq() < 1e-8) _aim.set(0, 0, -1);
  else _aim.normalize();
  _quat.setFromUnitVectors(_forward, _aim);
  _pos.set(x, y, z);
  _scale.set(0.05, 0.05, Math.max(0.2, length));
  _matrix.compose(_pos, _quat, _scale);
  mesh.setMatrixAt(index, _matrix);
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
