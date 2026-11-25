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
import { ATRIUM_PADS, ATRIUM_SPAWN, createAtriumHull, createAtriumMover, needsRespawn } from "./atrium.ts";
import { createAudio } from "./audio.ts";
import { cueFor, hurtFromVitals, type SimEvent } from "./cues.ts";
import { createCombatFeedback, strafeOf, stepWalkPhase, viewmodelOffset } from "./feel.ts";
import { restartCombat } from "./combat.ts";
import { ATRIUM_CLEAR, ATRIUM_FOG, ATRIUM_FOG_DENSITY, addAtrium, syncPadViews } from "./floor.ts";
import { createFight } from "./fight.ts";
import { playerHitboxes } from "./hitbox.ts";
import { mountHud } from "./hud/hud";
import { createInput } from "./input";
import { createLook } from "./look";
import { mountPauseSettings } from "./pause-settings.ts";
import { loadSettings, saveSettings } from "./settings.ts";
import {
  CAMERA_NEAR,
  EYE_HEIGHT,
  MAX_FRAME_SECONDS,
  clampedFrameSeconds,
  createMoveState,
  exposeMoveDebug,
  intentFromInput,
  planarSpeedOf,
} from "./move";
import { aimDirection, createQuill, muzzleOrigin } from "./quill.ts";
import { mountQuillView } from "./quill-view.ts";
import { applyDamage, createPickupSim, exposeDamageDebug } from "./pickups.ts";
import { subscribePlayerHurt } from "./player/hurt.ts";
import { createPlayerState, exposePlayerDebug } from "./player/state";
import { mountShell } from "./shell";
import { exposeRunDebug } from "./wisp.ts";
import { mountWispView } from "./wisp-view.ts";
import { mountEnforcerView } from "./enforcer-view.ts";
import { mountRusherView } from "./rusher-view.ts";

function harnessFlag(name: "__fragKeepDrawingBuffer"): boolean {
  const host = globalThis as unknown as Record<string, unknown>;
  return host[name] === true;
}

const renderer = new WebGLRenderer({
  antialias: true,
  // Keeping the drawing buffer makes Chrome read every frame back to composite
  // it ("GPU stall due to ReadPixels"). The smoke probe opts in before boot.
  preserveDrawingBuffer: harnessFlag("__fragKeepDrawingBuffer"),
});
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = NoToneMapping;
renderer.shadowMap.enabled = false;
// Count every pass in the frame, including the half-resolution bloom.
renderer.info.autoReset = false;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
const settings = loadSettings();
const audio = createAudio();
if (settings.muted) audio.setMuted(true);
const feedback = createCombatFeedback();
let showMute = (muted: boolean): void => {
  muteShown = muted;
};
let muteShown = false;
if (settings.muted) showMute(true);
let pauseSettings: { setMuted(muted: boolean): void } = {
  setMuted(muted: boolean): void {
    settings.muted = muted;
  },
};
const hear = (event: SimEvent): void => {
  audio.play(cueFor(event));
  if (event.type === "enemy-hit") feedback.noteHit(false);
  else if (event.type === "enemy-kill") feedback.noteHit(true);
};
let playerDead = (): boolean => false;
const shell = mountShell(renderer.domElement, {
  onGesture() {
    audio.prime();
  },
  dead() {
    return playerDead();
  },
  onMute() {
    audio.prime();
    const muted = audio.toggleMute();
    settings.muted = muted;
    pauseSettings.setMuted(muted);
    showMute(muted);
    saveSettings(settings);
  },
});
let onPointerDown = (): void => {};
let onPointerUp = (): void => {};
const input = createInput(renderer.domElement, {
  onPointerDown: () => onPointerDown(),
  onPointerUp: () => onPointerUp(),
});
// The stationary smoke probe raises this so drone bolts can be counted for a
// full 10 s while the enforcer is also shooting. A normal load leaves it unset.
const benchHp = (window as Window & { __fragBenchHp?: unknown }).__fragBenchHp;
const player = createPlayerState(
  typeof benchHp === "number" && Number.isFinite(benchHp) && benchHp > 0 ? { hp: benchHp } : undefined,
);
playerDead = () => player.get().hp <= 0;
let heardHp = player.get().hp;
player.subscribe((state) => {
  if (hurtFromVitals(heardHp, state.hp)) hear({ type: "player-hurt" });
  heardHp = state.hp;
  audio.setHp(state.hp);
});
audio.setHp(heardHp);

const hull = createAtriumHull();
const hearLaunch = (): void => {
  hear({ type: "jump-pad" });
};
let mover = createAtriumMover(createMoveState(ATRIUM_SPAWN), hearLaunch);

const scene = new Scene();
scene.background = new Color(ATRIUM_CLEAR);
scene.fog = new FogExp2(ATRIUM_FOG, ATRIUM_FOG_DENSITY);
const atrium = addAtrium(scene);
scene.add(new HemisphereLight(0x8ea4bc, 0x1a120c, 0.55));
const sheen = new DirectionalLight(0xd5e4f2, 0.85);
sheen.position.set(-6, 14, 8);
sheen.castShadow = false;
scene.add(sheen);

const camera = new PerspectiveCamera(50, 1, CAMERA_NEAR, 80);
camera.position.set(ATRIUM_SPAWN.x, ATRIUM_SPAWN.y + EYE_HEIGHT, ATRIUM_SPAWN.z);
camera.rotation.order = "YXZ";
camera.lookAt(ATRIUM_SPAWN.x, ATRIUM_SPAWN.y + EYE_HEIGHT, ATRIUM_SPAWN.z - 1);
const look = createLook(camera, {
  sensitivity: settings.sensitivity,
  horizontalFov: settings.fov,
  invertY: settings.invertY,
});
subscribePlayerHurt((source) => {
  feedback.noteDamage(look.yaw, camera.position, source);
});
const quill = createQuill({ hull, player, onEvent: hear });
const pickups = createPickupSim(quill, ATRIUM_PADS, hear);
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
const fight = createFight({ hull, player, hitboxes: playerHitboxes, origin: ATRIUM_SPAWN, onEvent: hear });
const wisps = fight.wisps;
const enforcers = fight.enforcers;
const rushers = fight.rushers;
const wispView = mountWispView(scene, wisps, camera);
const enforcerView = mountEnforcerView(scene, enforcers);
const rusherView = mountRusherView(scene, rushers);

let walkPhase = 0;

function restartRun(): void {
  // The click that leaves the recap is not a shot on the next frame.
  audio.prime();
  audio.cut();
  feedback.reset();
  walkPhase = 0;
  input.discard();
  restartCombat({
    player,
    quill,
    pickups,
    wisps,
    origin: ATRIUM_SPAWN,
  });
  mover = createAtriumMover(createMoveState(ATRIUM_SPAWN), hearLaunch);
  camera.position.set(ATRIUM_SPAWN.x, ATRIUM_SPAWN.y + EYE_HEIGHT, ATRIUM_SPAWN.z);
  look.reset();
  input.clearLook();
  shell.holdLock();
}

const hud = mountHud(player, {
  onRestart: restartRun,
  getRecap: () => wisps.recap(),
  trackPointer(down, up) {
    onPointerDown = down;
    onPointerUp = up;
  },
});
showMute = (muted) => hud.setMuted(muted);
if (muteShown) hud.setMuted(true);
pauseSettings = mountPauseSettings(settings, (next) => {
  settings.sensitivity = next.sensitivity;
  settings.fov = next.fov;
  settings.muted = next.muted;
  settings.invertY = next.invertY;
  look.setSensitivity(next.sensitivity);
  look.setHorizontalFov(next.fov);
  look.setInvertY(next.invertY);
  showMute(audio.setMuted(next.muted));
  saveSettings(settings);
});
const aim = { x: 0, y: 0, z: -1 };
const muzzle = { x: 0, y: 0, z: 0 };
const quillCommand = {
  fire: false,
  presses: 0,
  reload: false,
  alt: false,
  altEdge: false,
  origin: muzzle,
  direction: aim,
};

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
    const memory = renderer.info.memory;
    return {
      calls: render.calls,
      triangles: render.triangles,
      lines: render.lines,
      points: render.points,
      geometries: memory.geometries,
      textures: memory.textures,
    };
  },
});
Object.defineProperty(renderer.domElement, "fragFeedback", {
  configurable: true,
  enumerable: false,
  get() {
    return feedback.sample();
  },
});
Object.defineProperty(renderer.domElement, "fragDrones", {
  configurable: true,
  enumerable: false,
  get() {
    return fight.snapshot();
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
  const runDebug = {
    killAlive(): void {
      fight.killAll();
    },
    snapshot() {
      return fight.snapshot();
    },
    faceSpawn(): void {
      look.setSensitivity(0);
      look.reset();
      // The capture runs on the live dev page, which may be mid-arena after
      // wave 4. Park on the south concourse so the lunge is in the open view.
      mover = createAtriumMover(createMoveState(ATRIUM_SPAWN), hearLaunch);
    },
    poseLunge(): void {
      const yawRad = (look.yaw * Math.PI) / 180;
      const ahead = 1.45;
      const feet = mover.state.position;
      rushers.poseLunge(
        {
          x: feet.x + -Math.sin(yawRad) * ahead,
          y: feet.y,
          z: feet.z + -Math.cos(yawRad) * ahead,
        },
        yawRad + Math.PI,
      );
    },
    parkWindup(ahead?: number): void {
      parkWindupView(ahead);
    },
    poseWindup(ahead?: number): void {
      const distance = parkWindupView(ahead);
      const yawRad = (look.yaw * Math.PI) / 180;
      const feet = mover.state.position;
      const fx = -Math.sin(yawRad);
      const fz = -Math.cos(yawRad);
      const rx = Math.cos(yawRad);
      const rz = -Math.sin(yawRad);
      rushers.poseWindup(
        {
          x: feet.x + fx * distance,
          y: feet.y,
          z: feet.z + fz * distance,
        },
        yawRad + Math.PI,
      );
      // A companion stands off to the right so the flash can be judged next to
      // another body. Close uses the south concourse; mid range steps west and
      // looks along it, because straight ahead is the well.
      const side = distance >= 6 ? 1.8 : 1.35;
      const depth = distance >= 6 ? distance - 0.8 : 2.05;
      enforcers.place(0, {
        x: feet.x + fx * depth + rx * side,
        y: feet.y,
        z: feet.z + fz * depth + rz * side,
      });
    },
    clearShowcase(): void {
      rushers.clearShowcase();
    },
  };
  exposeRunDebug(window, runDebug);

  function parkWindupView(ahead?: number): number {
    const distance = typeof ahead === "number" && Number.isFinite(ahead) && ahead > 0 ? ahead : 1.45;
    if (distance < 6) return distance;
    mover.state.position.x = -8;
    mover.state.position.y = ATRIUM_SPAWN.y;
    mover.state.position.z = ATRIUM_SPAWN.z;
    mover.state.velocity.x = 0;
    mover.state.velocity.y = 0;
    mover.state.velocity.z = 0;
    look.setYaw(-90);
    return distance;
  }
}

function resize(): void {
  // Horizontal fov comes from the pause card. PerspectiveCamera.fov is vertical.
  look.resize(window.innerWidth, window.innerHeight);
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
}

window.addEventListener("resize", resize);
resize();

const contextLostPanel = document.querySelector<HTMLElement>("#context-lost");
let contextLost = false;

function showContextLost(): void {
  contextLost = true;
  if (contextLostPanel) contextLostPanel.hidden = false;
}

function hideContextLost(): void {
  contextLost = false;
  if (contextLostPanel) contextLostPanel.hidden = true;
}

renderer.domElement.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  // The panel is queried again so a loss still has a message if the first lookup missed.
  const panel = contextLostPanel ?? document.querySelector<HTMLElement>("#context-lost");
  contextLost = true;
  if (panel) panel.hidden = false;
});

renderer.domElement.addEventListener("webglcontextrestored", () => {
  try {
    resize();
    hideContextLost();
  } catch {
    showContextLost();
  }
});

document.querySelector("#context-lost-reload")?.addEventListener("click", () => {
  window.location.reload();
});

let lastTime = 0;
let lastSimDt = 0;
let wallMs = 0;
let simCpuMs = 0;
let simSeconds = 0;
let simFrames = 0;
let dropClock = false;
/** A clamped gap, kept until cleared. The next short frame must not erase it. */
let latchedStall = 0;

document.addEventListener("visibilitychange", () => {
  // The resume frame would otherwise clamp a multi-second gap to 250 ms.
  dropClock = true;
});

Object.defineProperty(renderer.domElement, "fragSim", {
  configurable: true,
  enumerable: false,
  get() {
    return {
      sim: simSeconds,
      frames: simFrames,
      frameDt: lastSimDt,
      wallMs,
      simCpuMs,
      shots: quill.shotsFired,
      firstShot: quill.shotsFired > 0 ? quill.shotTime(0) : null,
      lastShot: quill.shotsFired > 0 ? quill.shotTime(quill.shotsFired - 1) : null,
      mag: quill.mag,
      reserve: quill.reserve,
      reloading: quill.reloading,
      charge: quill.charge,
      charging: quill.charging,
      chargeAbort: quill.chargeAbort,
      stall: latchedStall,
    };
  },
});
Object.defineProperty(renderer.domElement, "fragStall", {
  configurable: true,
  enumerable: false,
  get() {
    return latchedStall;
  },
  set(value: number) {
    if (value === 0) latchedStall = 0;
  },
});
Object.defineProperty(renderer.domElement, "fragPose", {
  configurable: true,
  enumerable: false,
  get() {
    const body = mover.state;
    return {
      x: body.position.x,
      y: body.position.y,
      z: body.position.z,
      vx: body.velocity.x,
      vy: body.velocity.y,
      vz: body.velocity.z,
      simDt: lastSimDt,
    };
  },
});

function frame(time: number): void {
  // A hidden tab drops the gap. Any other stall is clamped at 250 ms.
  // The mover, the Quill Driver, and the drones share that slice.
  const drop = dropClock || document.visibilityState === "hidden";
  dropClock = false;
  const gapMs = lastTime > 0 ? time - lastTime : 0;
  wallMs = gapMs;
  lastSimDt = clampedFrameSeconds(lastTime, time, drop);
  if (!drop && gapMs > MAX_FRAME_SECONDS * 1000) latchedStall = lastSimDt;
  lastTime = time;
  const simDt = lastSimDt;
  const simStart = performance.now();
  const playing = shell.phase === "playing";
  const pointerLocked = document.pointerLockElement === renderer.domElement;
  // The sim clock follows play, not the pointer. Pause, the warning, and
  // click-to-play must not advance it. A rejected lock still plays.
  if (playing) {
    simSeconds += simDt;
    simFrames += 1;
  }
  const living = player.get().hp > 0;
  // Age the previous flash before this frame's hits, so a long frame cannot
  // eat a marker before it is drawn.
  if (playing) {
    fight.tickFlash(simDt);
    feedback.step(simDt);
  }
  // Dead, including the recap's first second, drops a click so it cannot fire
  // after the restart. Pause takes the same path through sample(false).
  if (!living) input.discard();
  const controls = input.sample(playing && living);
  if (playing && living) {
    if (pointerLocked) look.apply(controls.lookX, controls.lookY);
    // Bracket steps stay on the live aim. They are not the saved sensitivity.
    if (controls.pressed.sensUp) look.nudgeSensitivity(1);
    if (controls.pressed.sensDown) look.nudgeSensitivity(-1);
    const intent = intentFromInput(controls, look.yaw);
    mover.advance(simDt, intent);
    if (needsRespawn(mover.state.position)) {
      mover = createAtriumMover(createMoveState(ATRIUM_SPAWN), hearLaunch);
    }
    pickups.step(simDt, mover.state.position, player);
  }
  const body = mover.state;
  syncPadViews(atrium.pads, pickups.pads);
  camera.position.set(body.position.x, body.position.y + EYE_HEIGHT, body.position.z);
  if (playing && living) {
    aimDirection(look.yaw, look.pitch, aim);
    muzzleOrigin(camera.position, aim, muzzle);
    // `firePresses` is the clicks that already went up. Held fire stays on `down`.
    quillCommand.fire = controls.down.fire;
    quillCommand.presses = controls.firePresses;
    quillCommand.reload = controls.pressed.reload;
    quillCommand.alt = controls.down.alt;
    quillCommand.altEdge = controls.pressed.alt;
    quill.update(simDt, quillCommand);
    // Grace, bursts, and bolts run whenever play is running, even if the
    // pointer lock was rejected. The warning, click-to-play, and pause must
    // not burn the spawn grace or leave a burst to land on resume.
    wisps.update(simDt, body.position);
    enforcers.update(simDt, body.position);
    rushers.update(simDt, body.position);
  }
  hud.setWave(wisps.wave);
  hud.setCombat(feedback.sample());
  const speed = planarSpeedOf(body.velocity);
  if (playing && living) walkPhase = stepWalkPhase(walkPhase, simDt, speed);
  look.setViewPunch(quill.punchDeg);
  quillView.setPose(
    viewmodelOffset({
      kick: quill.kick,
      strafe: strafeOf(look.yaw, body.velocity),
      planarSpeed: speed,
      walkPhase,
    }),
  );
  quillView.setDebugVisible(shell.debug);
  quillView.sync();
  wispView.sync();
  enforcerView.sync();
  rusherView.sync();
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
  // Sim, combat, and view sync. The bloom render below is not included.
  simCpuMs = performance.now() - simStart;
  if (!contextLost) {
    renderer.info.reset();
    composer.render(simDt);
  }
  audio.tick();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
