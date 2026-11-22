import { AmbientLight, Color, DirectionalLight, PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { addTestFloor } from "./floor";
import { mountHud } from "./hud/hud";
import { createInput } from "./input";
import { createLook } from "./look";
import {
  EYE_HEIGHT,
  SPAWN,
  createMover,
  createTestHull,
  exposeMoveDebug,
  intentFromInput,
  planarSpeedOf,
} from "./move";
import { createPlayerState, exposePlayerDebug } from "./player/state";
import { mountShell } from "./shell";

const renderer = new WebGLRenderer({
  antialias: true,
  // The headless smoke test reads pixels after the browser composites.
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
const shell = mountShell(renderer.domElement);
const input = createInput(renderer.domElement);
const player = createPlayerState();
mountHud(player);

const hull = createTestHull();
const mover = createMover(hull);

const scene = new Scene();
scene.background = new Color(0x111118);
addTestFloor(scene, hull);

const camera = new PerspectiveCamera(50, 1, 0.1, 150);
camera.position.set(SPAWN.x, SPAWN.y + EYE_HEIGHT, SPAWN.z);
camera.rotation.order = "YXZ";
camera.lookAt(SPAWN.x, SPAWN.y + EYE_HEIGHT, SPAWN.z - 1);
const look = createLook(camera);
// The smoke test reads the live camera fov from the canvas.
Object.defineProperty(renderer.domElement, "fragView", {
  configurable: true,
  enumerable: false,
  value: look.view,
});

if (import.meta.env.DEV) {
  exposePlayerDebug(window, player);
  exposeMoveDebug(window, () => mover.state);
}

const keyLight = new DirectionalLight(0xffffff, 2.4);
keyLight.position.set(3, 8, 2);
scene.add(keyLight);
scene.add(new AmbientLight(0xffffff, 0.55));

function resize(): void {
  // 105° horizontal. PerspectiveCamera.fov is vertical; look.resize derives it.
  look.resize(window.innerWidth, window.innerHeight);
  renderer.setSize(window.innerWidth, window.innerHeight);
}

window.addEventListener("resize", resize);
resize();

let lastTime = 0;

function frame(time: number): void {
  // Stall clamping lives in the mover, so the game and the headless loop share one budget.
  const frameDt = lastTime === 0 ? 0 : Math.max(0, (time - lastTime) / 1000);
  lastTime = time;
  const captured =
    shell.phase === "playing" && document.pointerLockElement === renderer.domElement;
  const controls = input.sample(captured);
  if (captured) {
    look.apply(controls.lookX, controls.lookY);
    if (controls.pressed.sensUp) look.nudgeSensitivity(1);
    if (controls.pressed.sensDown) look.nudgeSensitivity(-1);
    mover.advance(frameDt, intentFromInput(controls, look.yaw));
  }
  const body = mover.state;
  camera.position.set(body.position.x, body.position.y + EYE_HEIGHT, body.position.z);
  // Fire and reload stay on `controls` for a later ticket.
  shell.onFrame(time, {
    x: camera.position.x,
    y: camera.position.y,
    z: camera.position.z,
    yaw: look.yaw,
    pitch: look.pitch,
    sensitivity: look.sensitivity,
    planarSpeed: planarSpeedOf(body.velocity),
    grounded: body.grounded,
  });
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
