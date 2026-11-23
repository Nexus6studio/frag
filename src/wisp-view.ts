// WISP-4 view. A flat octahedral disc, a sensor slit, and pooled shots and scraps.
// Nothing here is a loaded model. The disc spins so the cyan facets read as
// running lights. The slit faces the player and turns red while the drone is
// aggro. Death scraps and the oil droplets reuse one pool each.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
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
import { DRONE_CAP } from "./waves.ts";
import {
  WISP_BOLT_CAP,
  WISP_FLUID_CAP,
  WISP_FLUID_COLOR,
  WISP_GIB_CAP,
  WISP_GIB_METAL,
  WISP_GIB_PLASTIC,
  WISP_SPARK_CAP,
  wispVisorHex,
  type WispParticle,
  type WispSim,
} from "./wisp.ts";

const _quat = new Quaternion();
const _pos = new Vector3();
const _scale = new Vector3();
const _matrix = new Matrix4();
const _up = new Vector3(0, 1, 0);
const _color = new Color();

export function mountWispView(scene: Scene, sim: WispSim): { sync(): void } {
  const bodyMat = new MeshBasicMaterial({
    vertexColors: true,
    toneMapped: false,
    fog: false,
    side: DoubleSide,
  });
  const bodies = instanced(discGeometry(), bodyMat, DRONE_CAP);
  bodies.name = "wisp-body";

  const visorMat = new MeshBasicMaterial({
    color: 0xffffff,
    toneMapped: false,
    fog: false,
  });
  const visors = instanced(visorGeometry(), visorMat, DRONE_CAP);
  visors.name = "wisp-visor";

  const glowMat = new MeshBasicMaterial({
    color: 0x7af6ff,
    transparent: true,
    opacity: 0.45,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
    side: DoubleSide,
  });
  const glows = instanced(discGeometry(), glowMat, DRONE_CAP);
  glows.name = "wisp-telegraph";

  const boltMat = new MeshBasicMaterial({
    color: 0x8af7ff,
    transparent: true,
    opacity: 0.9,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const bolts = instanced(boltGeometry(), boltMat, WISP_BOLT_CAP);
  bolts.name = "wisp-bolts";

  const sparkPositions = new Float32Array(WISP_SPARK_CAP * 3);
  const sparkGeom = new BufferGeometry();
  sparkGeom.setAttribute("position", new BufferAttribute(sparkPositions, 3));
  const sparkPoints = new Points(
    sparkGeom,
    new PointsMaterial({
      color: 0xd7fbff,
      size: 0.08,
      sizeAttenuation: true,
      toneMapped: false,
      fog: false,
      depthWrite: false,
    }),
  );
  sparkPoints.name = "wisp-sparks";
  sparkPoints.frustumCulled = false;
  sparkPoints.visible = false;

  const gibMat = new MeshBasicMaterial({ color: 0xffffff, toneMapped: false, fog: false });
  const gibs = instanced(tetraGeometry(), gibMat, WISP_GIB_CAP);
  gibs.name = "wisp-gibs";

  const fluidMat = new MeshBasicMaterial({ color: WISP_FLUID_COLOR, toneMapped: false, fog: true });
  const fluid = instanced(tetraGeometry(), fluidMat, WISP_FLUID_CAP);
  fluid.name = "wisp-fluid";

  scene.add(bodies, visors, glows, bolts, sparkPoints, gibs, fluid);

  return {
    sync(): void {
      let bodyCount = 0;
      let glowCount = 0;
      const drones = sim.drones;
      for (let i = 0; i < drones.length; i += 1) {
        const drone = drones[i]!;
        if (!drone.alive) continue;
        const spin = sim.time * 1.7 + drone.index * 1.4;
        place(bodies, bodyCount, drone.position.x, drone.position.y, drone.position.z, spin, 1);
        place(visors, bodyCount, drone.position.x, drone.position.y, drone.position.z, drone.yaw, 1);
        _color.setHex(wispVisorHex(drone.aggro));
        visors.setColorAt(bodyCount, _color);
        bodyCount += 1;
        if (drone.phase === "telegraph" && sim.time > 0) {
          const pulse = 1.28 + Math.sin(sim.time * 28) * 0.08;
          place(glows, glowCount, drone.position.x, drone.position.y, drone.position.z, spin, pulse);
          glowCount += 1;
        }
      }
      show(bodies, bodyCount);
      show(visors, bodyCount);
      if (visors.instanceColor) visors.instanceColor.needsUpdate = true;
      glowMat.opacity = 0.35 + Math.sin(sim.time * 22) * 0.15;
      show(glows, glowCount);

      let boltCount = 0;
      const shots = sim.bolts;
      for (let i = 0; i < shots.length; i += 1) {
        const bolt = shots[i]!;
        if (!bolt.alive) continue;
        place(bolts, boltCount, bolt.x, bolt.y, bolt.z, 0, 1);
        boltCount += 1;
      }
      show(bolts, boltCount);

      const sparkCount = packPoints(sparkPositions, sim.sparks);
      sparkGeom.getAttribute("position").needsUpdate = true;
      sparkGeom.setDrawRange(0, sparkCount);
      sparkPoints.visible = sparkCount > 0;

      const gibCount = packParts(gibs, sim.gibs, 1, true);
      show(gibs, gibCount);
      if (gibs.instanceColor) gibs.instanceColor.needsUpdate = true;
      show(fluid, packParts(fluid, sim.fluid, 0.7, false));
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

function place(
  mesh: InstancedMesh,
  index: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  scale: number,
): void {
  _quat.setFromAxisAngle(_up, yaw);
  _pos.set(x, y, z);
  _scale.set(scale, scale, scale);
  _matrix.compose(_pos, _quat, _scale);
  mesh.setMatrixAt(index, _matrix);
}

function packPoints(out: Float32Array, parts: readonly WispParticle[]): number {
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

function packParts(mesh: InstancedMesh, parts: readonly WispParticle[], scale: number, tint: boolean): number {
  let count = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (!part.alive) continue;
    place(mesh, count, part.x, part.y, part.z, part.spin * part.age, scale);
    if (tint) {
      _color.setHex(part.metal ? WISP_GIB_METAL : WISP_GIB_PLASTIC);
      mesh.setColorAt(count, _color);
    }
    count += 1;
  }
  return count;
}

function discGeometry(): BufferGeometry {
  const position: number[] = [];
  const color: number[] = [];
  const rim = 8;
  const top: [number, number, number] = [0, 0.2, 0];
  const bottom: [number, number, number] = [0, -0.14, 0];
  const ring: [number, number, number][] = [];
  for (let i = 0; i < rim; i += 1) {
    const angle = (i / rim) * Math.PI * 2;
    ring.push([Math.cos(angle) * 0.46, 0, Math.sin(angle) * 0.46]);
  }
  const metal: [number, number, number] = [0.16, 0.19, 0.23];
  const cyan: [number, number, number] = [0.1, 0.9, 1];
  for (let i = 0; i < rim; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % rim]!;
    pushTri(position, color, top, a, b, i % 2 === 0 ? cyan : metal);
    pushTri(position, color, bottom, b, a, metal);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(color, 3));
  return geometry;
}

function visorGeometry(): BufferGeometry {
  const position: number[] = [];
  const color: number[] = [];
  const white: [number, number, number] = [1, 1, 1];
  const x = 0.16;
  const y0 = 0.02;
  const y1 = 0.07;
  const z0 = -0.5;
  const z1 = -0.44;
  const corners: [number, number, number][] = [
    [-x, y0, z0],
    [x, y0, z0],
    [x, y1, z0],
    [-x, y1, z0],
    [-x, y0, z1],
    [x, y0, z1],
    [x, y1, z1],
    [-x, y1, z1],
  ];
  const faces = [
    [0, 1, 2, 0, 2, 3],
    [4, 6, 5, 4, 7, 6],
    [0, 4, 5, 0, 5, 1],
    [3, 2, 6, 3, 6, 7],
    [0, 3, 7, 0, 7, 4],
    [1, 5, 6, 1, 6, 2],
  ];
  for (let f = 0; f < faces.length; f += 1) {
    const face = faces[f]!;
    pushTri(position, color, corners[face[0]!]!, corners[face[1]!]!, corners[face[2]!]!, white);
    pushTri(position, color, corners[face[3]!]!, corners[face[4]!]!, corners[face[5]!]!, white);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(color, 3));
  return geometry;
}

function boltGeometry(): BufferGeometry {
  const position: number[] = [];
  const color: number[] = [];
  const r = 0.25;
  const white: [number, number, number] = [0.7, 1, 1];
  const px: [number, number, number] = [r, 0, 0];
  const nx: [number, number, number] = [-r, 0, 0];
  const py: [number, number, number] = [0, r, 0];
  const ny: [number, number, number] = [0, -r, 0];
  const pz: [number, number, number] = [0, 0, r];
  const nz: [number, number, number] = [0, 0, -r];
  const faces: [typeof px, typeof px, typeof px][] = [
    [py, pz, px],
    [py, px, nz],
    [py, nz, nx],
    [py, nx, pz],
    [ny, px, pz],
    [ny, nz, px],
    [ny, nx, nz],
    [ny, pz, nx],
  ];
  for (let i = 0; i < faces.length; i += 1) {
    const face = faces[i]!;
    pushTri(position, color, face[0], face[1], face[2], white);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(color, 3));
  return geometry;
}

function tetraGeometry(): BufferGeometry {
  const position: number[] = [];
  const color: number[] = [];
  const s = 0.08;
  const white: [number, number, number] = [1, 1, 1];
  const a: [number, number, number] = [s, s, s];
  const b: [number, number, number] = [-s, -s, s];
  const c: [number, number, number] = [-s, s, -s];
  const d: [number, number, number] = [s, -s, -s];
  pushTri(position, color, a, b, c, white);
  pushTri(position, color, a, d, b, white);
  pushTri(position, color, a, c, d, white);
  pushTri(position, color, b, d, c, white);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(color, 3));
  return geometry;
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
