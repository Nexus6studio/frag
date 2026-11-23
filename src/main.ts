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
import { restartCombat } from "./combat.ts";
import { ATRIUM_CLEAR, ATRIUM_FOG, addAtrium, syncPadViews } from "./floor.ts";
import { playerHitboxes } from "./hitbox.ts";
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
import { aimDirection, createQuill, muzzleOrigin } from "./quill.ts";
import { mountQuillView } from "./quill-view.ts";
import { applyDamage, createPickupSim, exposeDamageDebug } from "./pickups.ts";
import { createPlayerState, exposePlayerDebug } from "./player/state";
import { mountShell } from "./shell";
import { createWispSim, exposeRunDebug } from "./wisp.ts";
import { mountWispView } from "./wisp-view.ts";

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

const hull = createAtriumHull();
let mover = createMover(hull, createMoveState(ATRIUM_SPAWN));

const scene = new Scene();
scene.background = new Color(ATRIUM_CLEAR);
scene.fog = new FogExp2(ATRIUM_FOG, 0.015);
const atrium = addAtrium(scene);
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
const quill = createQuill({ hull, player });
const pickups = createPickupSim(quill);
const debugTarget = import.meta.env.DEV
  ? {
      center: {
        x: ATRIUM_SPAWN.x,
        y: ATRIUM_SPAWN.y + EYE_HEIGHT,
        z: ATRIUM_SPAWN.z - 10,
      },
      radius: 0.35,
    }
  : null;
const quillView = mountQuillView(scene, camera, quill, debugTarget);
const wisps = createWispSim({ hull, player, hitboxes: playerHitboxes, origin: ATRIUM_SPAWN });
const wispView = mountWispView(scene, wisps);

function restartRun(): void {
  restartCombat({
    player,
    quill,
    pickups,
    wisps,
    origin: ATRIUM_SPAWN,
  });
  mover = createMover(hull, createMoveState(ATRIUM_SPAWN));
  camera.position.set(ATRIUM_SPAWN.x, ATRIUM_SPAWN.y + EYE_HEIGHT, ATRIUM_SPAWN.z);
  shell.holdLock();
}

mountHud(player, {
  onRestart: restartRun,
  getRecap: () => wisps.recap(),
});
const aim = { x: 0, y: 0, z: -1 };
const muzzle = { x: 0, y: 0, z: 0 };
const quillCommand = { fire: false, reload: false, origin: muzzle, direction: aim };

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
    const render = renderer.info.render;
    return {
      calls: render.calls,
      triangles: render.triangles,
      lines: render.lines,
      points: render.points,
    };
  },
});
Object.defineProperty(renderer.domElement, "fragDrones", {
  configurable: true,
  enumerable: false,
  get() {
    return wisps.snapshot();
  },
});

if (import.meta.env.DEV) {
  exposePlayerDebug(window, player);
  exposeMoveDebug(window, () => mover.state);
  exposeDamageDebug(window, (damage) => {
    const current = player.get();
    const next = applyDamage(damage, current.hp, current.armor);
    player.set({ hp: next.hp, armor: next.armor });
  });
  exposeRunDebug(window, wisps);
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
  // The Quill Driver sees that same clamped slice, not the raw stall.
  const frameDt = lastTime === 0 ? 0 : Math.max(0, (time - lastTime) / 1000);
  lastTime = time;
  const simDt = Math.min(frameDt, MAX_FRAME_SECONDS);
  const captured =
    shell.phase === "playing" && document.pointerLockElement === renderer.domElement;
  const controls = input.sample(captured);
  const living = player.get().hp > 0;
  if (captured && living) {
    look.apply(controls.lookX, controls.lookY);
    if (controls.pressed.sensUp) look.nudgeSensitivity(1);
    if (controls.pressed.sensDown) look.nudgeSensitivity(-1);
    const intent = intentFromInput(controls, look.yaw);
    mover.advance(simDt, intent);
    if (needsRespawn(mover.state.position)) {
      mover = createMover(hull, createMoveState(ATRIUM_SPAWN));
    }
    pickups.step(simDt, mover.state.position, player);
  }
  const body = mover.state;
  syncPadViews(atrium.pads, pickups.pads);
  camera.position.set(body.position.x, body.position.y + EYE_HEIGHT, body.position.z);
  if (captured && living) {
    aimDirection(look.yaw, look.pitch, aim);
    muzzleOrigin(camera.position, aim, muzzle);
    quillCommand.fire = controls.down.fire;
    quillCommand.reload = controls.pressed.reload;
    quill.update(simDt, quillCommand);
    wisps.update(simDt, body.position);
  }
  look.setViewPunch(quill.punchDeg);
  quillView.setDebugVisible(shell.debug);
  quillView.sync();
  wispView.sync();
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
