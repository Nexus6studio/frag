// View for the VEC-9 Quill Driver.
//
// The carbine, the muzzle flash, and the flechettes are built from three.js
// primitives. Nothing here is a loaded model. Spikes and tracers are two
// instanced meshes, so a burst does not add a draw per shot. A development
// build can show a target volume on the debug toggle; production never creates it.

import {
  AdditiveBlending,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  type PerspectiveCamera,
  type Scene,
} from "three";
import { registerHitbox, type HitboxHandle } from "./hitbox.ts";
import type { Vec3 } from "./move.ts";
import { QUILL_LENGTH, type QuillDriver } from "./quill.ts";

export interface QuillDebugTarget {
  center: Vec3;
  radius: number;
}

const STEEL = 0x3c4558;
const STEEL_DARK = 0x232833;
const BARREL = 0x2a3142;
const CYAN = 0x3de1ff;
const MAGENTA = 0xff3aa8;
const AMBER = 0xf5a623;

const REST_X = 0.2;
const REST_Y = -0.22;
const REST_Z = -0.38;

const _quat = new Quaternion();
const _matrix = new Matrix4();
const _pos = new Vector3();
const _scale = new Vector3(1, 1, 1);

export function mountQuillView(
  scene: Scene,
  camera: PerspectiveCamera,
  driver: QuillDriver,
  debugTarget: QuillDebugTarget | null,
): { sync(): void; setDebugVisible(visible: boolean): void } {
  const anchor = new Group();
  anchor.name = "quill-driver";
  anchor.position.set(REST_X, REST_Y, REST_Z);
  camera.add(anchor);
  if (camera.parent !== scene) scene.add(camera);

  const viewmodel = new Mesh(viewmodelGeometry(), viewmodelMaterial());
  viewmodel.name = "quill-viewmodel";
  viewmodel.frustumCulled = false;
  anchor.add(viewmodel);

  const flashMaterial = new MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
    side: DoubleSide,
  });
  const flash = new Mesh(flashGeometry(), flashMaterial);
  flash.name = "quill-flash";
  flash.position.set(0.002, 0.004, -0.6);
  flash.visible = false;
  flash.frustumCulled = false;
  anchor.add(flash);

  const bodies = spikes(driver.poolCap, bodyGeometry(), 0xd7fbff);
  const tracers = spikes(driver.poolCap, tracerGeometry(), 0xff5ad6);
  bodies.name = "quill-flechettes";
  tracers.name = "quill-tracers";
  scene.add(bodies, tracers);

  let dummy: Mesh | null = null;
  let dummyHandle: HitboxHandle | null = null;
  let debugVisible = false;
  // Production builds drop this. The target is not part of the shipped scene.
  if (import.meta.env?.DEV && debugTarget) {
    dummy = new Mesh(
      new SphereGeometry(debugTarget.radius, 10, 8),
      new MeshBasicMaterial({ color: MAGENTA, wireframe: true, toneMapped: false, fog: false }),
    );
    dummy.name = "quill-debug-target";
    dummy.position.set(debugTarget.center.x, debugTarget.center.y, debugTarget.center.z);
    dummy.visible = false;
    scene.add(dummy);
    dummyHandle = registerHitbox({
      center: debugTarget.center,
      radius: debugTarget.radius,
      onHit() {},
    });
    dummyHandle.setActive(false);
  }

  return {
    setDebugVisible(visible: boolean): void {
      debugVisible = visible;
      dummyHandle?.setActive(visible);
    },
    sync(): void {
      const kick = driver.kick;
      anchor.position.set(REST_X, REST_Y - kick * 0.008, REST_Z + kick * 0.03);
      anchor.rotation.x = kick * 0.045;
      const flashing = driver.flash > 0.02;
      flash.visible = flashing;
      if (flashing) {
        const scale = 0.65 + driver.flash;
        flash.scale.set(scale, scale, scale * 1.4);
        flashMaterial.opacity = driver.flash;
      }
      if (dummy) dummy.visible = debugVisible;

      let count = 0;
      const slots = driver.slots;
      for (let i = 0; i < slots.length; i += 1) {
        const slot = slots[i]!;
        if (!slot.alive) continue;
        writeSpike(bodies, count, slot.x, slot.y, slot.z, slot.dx, slot.dy, slot.dz);
        writeSpike(
          tracers,
          count,
          slot.x - slot.dx * QUILL_LENGTH,
          slot.y - slot.dy * QUILL_LENGTH,
          slot.z - slot.dz * QUILL_LENGTH,
          slot.dx,
          slot.dy,
          slot.dz,
        );
        count += 1;
      }
      bodies.count = count;
      tracers.count = count;
      const drawing = count > 0;
      bodies.visible = drawing;
      tracers.visible = drawing;
      if (drawing) {
        bodies.instanceMatrix.needsUpdate = true;
        tracers.instanceMatrix.needsUpdate = true;
      }
    },
  };
}

function spikes(cap: number, geometry: BufferGeometry, color: number): InstancedMesh {
  const mesh = new InstancedMesh(
    geometry,
    new MeshBasicMaterial({ color, toneMapped: false, fog: false }),
    cap,
  );
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.visible = false;
  return mesh;
}

function writeSpike(
  mesh: InstancedMesh,
  index: number,
  x: number,
  y: number,
  z: number,
  dx: number,
  dy: number,
  dz: number,
): void {
  aimQuat(dx, dy, dz);
  _pos.set(x, y, z);
  _matrix.compose(_pos, _quat, _scale);
  mesh.setMatrixAt(index, _matrix);
}

/** Rotate local +Z onto the bore. The spike geometry trails toward local -Z. */
function aimQuat(dx: number, dy: number, dz: number): void {
  if (dz < -0.999999) {
    _quat.set(1, 0, 0, 0);
    return;
  }
  _quat.set(-dy, dx, 0, 1 + dz);
  _quat.normalize();
}

function viewmodelMaterial(): MeshBasicMaterial {
  return new MeshBasicMaterial({
    vertexColors: true,
    toneMapped: false,
    fog: false,
    side: DoubleSide,
  });
}

function viewmodelGeometry(): BufferGeometry {
  const position: number[] = [];
  const color: number[] = [];
  // x0, x1, y0, y1, z0, z1, hex. -Z is down the bore.
  const parts: readonly (readonly [number, number, number, number, number, number, number])[] = [
    [-0.03, 0.04, -0.04, 0.045, -0.18, 0.1, STEEL],
    [-0.02, 0.028, -0.018, 0.03, -0.5, -0.16, BARREL],
    [-0.008, 0.012, -0.006, 0.014, -0.58, -0.48, STEEL_DARK],
    [-0.016, 0.022, 0.045, 0.06, -0.42, 0.08, STEEL],
    [-0.05, -0.03, -0.01, 0.022, -0.42, -0.16, CYAN],
    [0.038, 0.058, -0.01, 0.022, -0.42, -0.16, MAGENTA],
    [-0.018, 0.03, -0.16, -0.035, -0.08, 0.045, STEEL_DARK],
    [-0.01, 0.028, -0.13, -0.02, 0.04, 0.11, STEEL_DARK],
    [-0.02, 0.032, -0.02, 0.042, 0.08, 0.24, STEEL],
    [-0.016, 0.028, -0.012, 0.034, 0.24, 0.27, MAGENTA],
    [-0.006, 0.012, 0.06, 0.095, -0.46, -0.42, CYAN],
    [-0.008, 0.014, 0.06, 0.082, 0.02, 0.055, AMBER],
  ];
  for (const part of parts) {
    const [r, g, b] = hexRgb(part[6]);
    pushBox(position, color, part[0], part[1], part[2], part[3], part[4], part[5], r, g, b);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(color, 3));
  return geometry;
}

function bodyGeometry(): BufferGeometry {
  const geometry = new CylinderGeometry(0.004, 0.018, QUILL_LENGTH, 5, 1);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0, -QUILL_LENGTH / 2);
  return geometry;
}

function tracerGeometry(): BufferGeometry {
  const length = 0.28;
  const geometry = new CylinderGeometry(0.005, 0.008, length, 4, 1);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0, -length / 2);
  return geometry;
}

function flashGeometry(): BufferGeometry {
  const position: number[] = [];
  const color: number[] = [];
  const [cr, cg, cb] = hexRgb(CYAN);
  const [mr, mg, mb] = hexRgb(MAGENTA);
  pushBox(position, color, -0.07, 0.07, -0.012, 0.012, -0.02, 0.04, cr, cg, cb);
  pushBox(position, color, -0.012, 0.012, -0.07, 0.07, -0.01, 0.05, mr, mg, mb);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(color, 3));
  return geometry;
}

function pushBox(
  position: number[],
  color: number[],
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  r: number,
  g: number,
  b: number,
): void {
  const corners = [
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
    [0, 1, 2, 0, 2, 3],
    [4, 6, 5, 4, 7, 6],
    [0, 4, 5, 0, 5, 1],
    [3, 2, 6, 3, 6, 7],
    [0, 3, 7, 0, 7, 4],
    [1, 5, 6, 1, 6, 2],
  ];
  for (let f = 0; f < faces.length; f += 1) {
    const face = faces[f]!;
    for (let v = 0; v < face.length; v += 1) {
      const corner = corners[face[v]!]!;
      position.push(corner[0]!, corner[1]!, corner[2]!);
      color.push(r, g, b);
    }
  }
}

function hexRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
