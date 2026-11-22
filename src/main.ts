import {
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector2,
  WebGLRenderer,
} from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ATRIUM_SPAWN, createAtriumHull, needsRespawn } from "./atrium.ts";
import { ATRIUM_CLEAR, ATRIUM_FOG, addAtrium } from "./floor.ts";
import { mountHud } from "./hud/hud";
import { createInput } from "./input";
import { createLook } from "./look";
import {
  EYE_HEIGHT,
  MAX_FRAME_SECONDS,
  createMoveState,
  createMover,
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
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = NoToneMapping;
renderer.shadowMap.enabled = false;
// Count every pass in the frame, including the half-resolution bloom.
renderer.info.autoReset = false;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
const shell = mountShell(renderer.domElement);
const input = createInput(renderer.domElement);
const player = createPlayerState();
mountHud(player);

const hull = createAtriumHull();
let mover = createMover(hull, createMoveState(ATRIUM_SPAWN));

const scene = new Scene();
scene.background = new Color(ATRIUM_CLEAR);
scene.fog = new FogExp2(ATRIUM_FOG, 0.015);
addAtrium(scene);
scene.add(new HemisphereLight(0x8ea4bc, 0x1a120c, 0.55));
const sheen = new DirectionalLight(0xd5e4f2, 0.85);
sheen.position.set(-6, 14, 8);
sheen.castShadow = false;
scene.add(sheen);

const camera = new PerspectiveCamera(50, 1, 0.08, 80);
camera.position.set(ATRIUM_SPAWN.x, ATRIUM_SPAWN.y + EYE_HEIGHT, ATRIUM_SPAWN.z);
camera.rotation.order = "YXZ";
camera.lookAt(ATRIUM_SPAWN.x, ATRIUM_SPAWN.y + EYE_HEIGHT, ATRIUM_SPAWN.z - 1);
const look = createLook(camera);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new Vector2(window.innerWidth, window.innerHeight), 0.28, 0.32, 0.88);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// The smoke test reads the live camera fov and the frame's draw counters.
Object.defineProperty(renderer.domElement, "fragView", {
  configurable: true,
  enumerable: false,
  value: look.view,
});
Object.defineProperty(renderer.domElement, "fragStats", {
  configurable: true,
  enumerable: false,
  get() {
    return {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    };
  },
});

if (import.meta.env.DEV) {
  exposePlayerDebug(window, player);
  exposeMoveDebug(window, () => mover.state);
}

function resize(): void {
  // 105° horizontal. PerspectiveCamera.fov is vertical; look.resize derives it.
  look.resize(window.innerWidth, window.innerHeight);
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
}

window.addEventListener("resize", resize);
resize();

let lastTime = 0;

function frame(time: number): void {
  // The mover clamps a stall at 250 ms and keeps the sub-step remainder.
  const frameDt = lastTime === 0 ? 0 : Math.max(0, (time - lastTime) / 1000);
  lastTime = time;
  const captured =
    shell.phase === "playing" && document.pointerLockElement === renderer.domElement;
  const controls = input.sample(captured);
  if (captured) {
    look.apply(controls.lookX, controls.lookY);
    if (controls.pressed.sensUp) look.nudgeSensitivity(1);
    if (controls.pressed.sensDown) look.nudgeSensitivity(-1);
    const intent = intentFromInput(controls, look.yaw);
    mover.advance(Math.min(frameDt, MAX_FRAME_SECONDS), intent);
    if (needsRespawn(mover.state.position)) {
      mover = createMover(hull, createMoveState(ATRIUM_SPAWN));
    }
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
  renderer.info.reset();
  composer.render();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
