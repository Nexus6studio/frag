import assert from "node:assert/strict";
import test from "node:test";
import { PerspectiveCamera, Vector3 } from "three";
import {
  applyMouseLook,
  clampPitch,
  createLook,
  stepSensitivity,
  verticalFovDeg,
  wrapYaw,
} from "../src/look.ts";

const RAD2DEG = 180 / Math.PI;

function horizontalFov(verticalDeg, aspect) {
  const vertical = (verticalDeg * Math.PI) / 180;
  return (2 * Math.atan(Math.tan(vertical / 2) * aspect) * 180) / Math.PI;
}

test("pitch clamps to ±89 degrees and does not flip", () => {
  assert.equal(clampPitch(0), 0);
  assert.equal(clampPitch(89), 89);
  assert.equal(clampPitch(-89), -89);
  assert.equal(clampPitch(89.01), 89);
  assert.equal(clampPitch(90), 89);
  assert.equal(clampPitch(180), 89);
  assert.equal(clampPitch(-90), -89);
  assert.equal(clampPitch(-180), -89);
  assert.equal(clampPitch(10.5), 10.5);
});

test("yaw wraps into (-180, 180]", () => {
  assert.equal(wrapYaw(0), 0);
  assert.equal(wrapYaw(180), 180);
  assert.equal(wrapYaw(-180), 180);
  assert.equal(wrapYaw(181), -179);
  assert.equal(wrapYaw(-181), 179);
  assert.equal(wrapYaw(360), 0);
  assert.equal(wrapYaw(-360), 0);
  assert.equal(wrapYaw(540), 180);
  assert.equal(wrapYaw(-540), 180);
  assert.equal(wrapYaw(-90), -90);
  assert.ok(Math.abs(wrapYaw(720.5) - 0.5) < 1e-9);
});

test("vertical fov is derived from 105° horizontal and aspect", () => {
  assert.ok(Math.abs(verticalFovDeg(105, 1) - 105) < 1e-9);
  for (const aspect of [16 / 9, 4 / 3, 9 / 16, 1280 / 720, 900 / 700]) {
    const vertical = verticalFovDeg(105, aspect);
    const horizontal = horizontalFov(vertical, aspect);
    assert.ok(Math.abs(horizontal - 105) < 1e-6, `aspect ${aspect} -> ${horizontal}`);
    if (aspect > 1) assert.ok(vertical < 105);
    if (aspect < 1) assert.ok(vertical > 105);
  }
  assert.equal(verticalFovDeg(105, 0), verticalFovDeg(105, 1));
  assert.equal(verticalFovDeg(105, Number.NaN), verticalFovDeg(105, 1));
});

test("mouse look turns right and down, then stops at the pitch poles", () => {
  const right = applyMouseLook(0, 0, 10, 0, 0.12);
  assert.ok(Math.abs(right.yaw - -1.2) < 1e-9);
  assert.equal(right.pitch, 0);

  const down = applyMouseLook(0, 0, 0, 10, 0.12);
  assert.equal(down.yaw, 0);
  assert.ok(Math.abs(down.pitch - -1.2) < 1e-9);

  const up = applyMouseLook(170, 80, -100, -1000, 0.12);
  assert.equal(up.pitch, 89);
  assert.ok(up.yaw < 0);

  const slammed = applyMouseLook(0, -89, 0, 50, 0.12);
  assert.equal(slammed.pitch, -89);
});

test("sensitivity steps stay inside the temporary range", () => {
  assert.equal(stepSensitivity(0.12, 1), 0.14);
  assert.equal(stepSensitivity(0.12, -1), 0.1);
  assert.equal(stepSensitivity(0.02, -1), 0.02);
  assert.equal(stepSensitivity(1, 1), 1);
});

test("the camera keeps 105° horizontal and clamps look on the rig", () => {
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.rotation.order = "YXZ";
  const look = createLook(camera);

  look.apply(10, 0);
  const turned = camera.getWorldDirection(new Vector3());
  assert.ok(turned.x > 0, "mouse right looks toward +X");
  assert.ok(turned.z < 0);

  look.apply(0, 10);
  const dipped = camera.getWorldDirection(new Vector3());
  assert.ok(dipped.y < 0, "mouse down looks down");

  look.apply(0, -1e6);
  assert.ok(Math.abs(camera.rotation.x * RAD2DEG - 89) < 1e-6);
  const up = camera.getWorldDirection(new Vector3());
  look.apply(0, -1e6);
  const stillUp = camera.getWorldDirection(new Vector3());
  assert.ok(Math.abs(stillUp.y - up.y) < 1e-6);

  look.apply(0, 1e6);
  assert.ok(Math.abs(camera.rotation.x * RAD2DEG - -89) < 1e-6);
  look.apply(1e6, 0);
  assert.ok(Math.abs(look.yaw) <= 180);

  look.resize(1280, 720);
  assert.equal(camera.aspect, 1280 / 720);
  assert.ok(Math.abs(horizontalFov(camera.fov, camera.aspect) - 105) < 1e-6);
  assert.equal(look.view.verticalFov, camera.fov);
  assert.equal(look.view.aspect, camera.aspect);

  const wide = camera.fov;
  look.resize(700, 900);
  assert.ok(camera.fov > wide);
  assert.ok(Math.abs(horizontalFov(camera.fov, camera.aspect) - 105) < 1e-6);

  assert.equal(look.sensitivity, 0.12);
  look.nudgeSensitivity(1);
  assert.equal(look.sensitivity, 0.14);
});

test("seeding look from an existing view does not move the camera until the mouse does", () => {
  const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 100);
  camera.position.set(1.8, 1.2, 2.6);
  camera.lookAt(0, 0, 0);
  const before = camera.getWorldDirection(new Vector3());
  const look = createLook(camera);
  look.apply(0, 0);
  look.resize(1600, 900);
  const after = camera.getWorldDirection(new Vector3());
  assert.ok(before.distanceTo(after) < 1e-8);
  assert.ok(Math.abs(horizontalFov(camera.fov, camera.aspect) - 105) < 1e-6);
});

test("restart facing clears yaw, pitch, and the camera, and keeps sensitivity", () => {
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.rotation.order = "YXZ";
  camera.lookAt(0, 0, -1);
  const look = createLook(camera);
  look.apply(80, -400);
  assert.ok(Math.abs(look.pitch) > 20, `pitch did not leave spawn (${look.pitch})`);
  assert.ok(Math.abs(look.yaw) > 1, `yaw did not leave spawn (${look.yaw})`);
  const sensitivity = look.sensitivity;
  look.reset();
  assert.equal(look.yaw, 0);
  assert.equal(look.pitch, 0);
  assert.equal(look.sensitivity, sensitivity);
  assert.equal(look.view.yaw, 0);
  assert.equal(look.view.pitch, 0);
  const direction = camera.getWorldDirection(new Vector3());
  assert.ok(Math.abs(direction.x) < 1e-6, `x ${direction.x}`);
  assert.ok(Math.abs(direction.y) < 1e-6, `y ${direction.y}`);
  assert.ok(direction.z < -0.99, `z ${direction.z}`);
  assert.ok(Math.abs(camera.rotation.x) < 1e-6);
  assert.ok(Math.abs(camera.rotation.y) < 1e-6);
});

test("view punch offsets the camera without changing the held aim", () => {
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.rotation.order = "YXZ";
  camera.lookAt(0, 0, -1);
  const look = createLook(camera);
  const yaw = look.yaw;
  const pitch = look.pitch;
  look.setViewPunch(0.12);
  assert.equal(look.yaw, yaw);
  assert.equal(look.pitch, pitch);
  assert.ok(Math.abs(camera.rotation.x * RAD2DEG - (pitch + 0.12)) < 1e-6);
  look.setViewPunch(0);
  assert.ok(Math.abs(camera.rotation.x * RAD2DEG - pitch) < 1e-6);
  assert.equal(look.pitch, pitch);
});
