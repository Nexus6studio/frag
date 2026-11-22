// Test-floor meshes. Collision lives in move.ts; these shapes are only drawn.

import {
  BoxGeometry,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
} from "three";
import type { BoxSolid, Hull, RampSolid } from "./move";

export function addTestFloor(scene: Scene, hull: Hull): void {
  const ground = new Mesh(
    new PlaneGeometry(80, 80),
    new MeshStandardMaterial({ color: 0x3c4454, roughness: 0.92, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  for (const box of hull.boxes) scene.add(boxMesh(box));
  for (const ramp of hull.ramps) scene.add(rampMesh(ramp));
}

function boxMesh(box: BoxSolid): Mesh {
  const sx = box.max.x - box.min.x;
  const sy = box.max.y - box.min.y;
  const sz = box.max.z - box.min.z;
  const mesh = new Mesh(new BoxGeometry(sx, sy, sz), solidMaterial(colorForHeight(sy)));
  mesh.position.set(
    (box.min.x + box.max.x) / 2,
    (box.min.y + box.max.y) / 2,
    (box.min.z + box.max.z) / 2,
  );
  return mesh;
}

function colorForHeight(height: number): number {
  if (height <= 0.4) return 0x3dff9a;
  if (height <= 1.2) return 0xf5a623;
  return 0xff4fa3;
}

function rampMesh(ramp: RampSolid): Mesh {
  const y0 = ramp.yAtMaxZ;
  const y1 = ramp.yAtMaxZ + ramp.rise;
  const x0 = ramp.minX;
  const x1 = ramp.maxX;
  const z0 = ramp.minZ;
  const z1 = ramp.maxZ;
  const positions = [
    x0, y0, z1, x1, y0, z1, x1, y1, z0,
    x0, y0, z1, x1, y1, z0, x0, y1, z0,
    x0, 0, z1, x1, 0, z1, x1, y0, z1,
    x0, 0, z1, x1, y0, z1, x0, y0, z1,
    x0, 0, z0, x0, y1, z0, x1, y1, z0,
    x0, 0, z0, x1, y1, z0, x1, 0, z0,
    x0, 0, z1, x0, y0, z1, x0, y1, z0,
    x0, 0, z1, x0, y1, z0, x0, 0, z0,
    x1, 0, z1, x1, y1, z0, x1, y0, z1,
    x1, 0, z1, x1, 0, z0, x1, y1, z0,
  ];
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return new Mesh(geometry, solidMaterial(0x5b8cff));
}

function solidMaterial(color: number): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    roughness: 0.58,
    metalness: 0.04,
    side: DoubleSide,
  });
}
