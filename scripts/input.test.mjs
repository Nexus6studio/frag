import assert from "node:assert/strict";
import test from "node:test";
import { createHitboxWorld } from "../src/hitbox.ts";
import { RECAP_ARM_SECONDS } from "../src/hud/model.ts";
import {
  actionForCode,
  armLatch,
  buttonEdges,
  buttonState,
  buttonsFromCodes,
  clearLatch,
  createInput,
  createLatch,
  latchTransition,
  takeLatch,
} from "../src/input.ts";
import { createQuill } from "../src/quill.ts";

const CODES = {
  KeyW: "forward",
  KeyA: "left",
  KeyS: "back",
  KeyD: "right",
  Space: "jump",
  KeyR: "reload",
  Escape: "pause",
  Backquote: "debug",
  F1: "debug",
  BracketLeft: "sensDown",
  BracketRight: "sensUp",
};

test("control-table codes map onto one action each", () => {
  for (const [code, action] of Object.entries(CODES)) {
    assert.equal(actionForCode(code), action, code);
  }
  assert.equal(actionForCode("KeyQ"), null);
  assert.equal(actionForCode("Enter"), null);
});

test("button edges are the down and up transitions", () => {
  const previous = buttonState();
  const next = buttonState();
  next.forward = true;
  next.fire = true;
  const first = buttonEdges(previous, next);
  assert.equal(first.pressed.forward, true);
  assert.equal(first.pressed.fire, true);
  assert.equal(first.released.forward, false);
  assert.equal(first.pressed.jump, false);

  const held = buttonEdges(next, next);
  assert.equal(held.pressed.fire, false);
  assert.equal(held.released.fire, false);

  const up = buttonState();
  const released = buttonEdges(next, up);
  assert.equal(released.released.forward, true);
  assert.equal(released.released.fire, true);
  assert.equal(released.pressed.fire, false);
});

test("held fire stays down and only the first read presses", () => {
  const latch = createLatch();
  const firing = buttonState();
  firing.fire = true;
  latchTransition(latch, firing);

  const first = takeLatch(latch, 3, -4);
  assert.equal(first.down.fire, true);
  assert.equal(first.pressed.fire, true);
  assert.equal(first.released.fire, false);
  assert.equal(first.lookX, 3);
  assert.equal(first.lookY, -4);

  const held = takeLatch(latch, 0, 0);
  assert.equal(held.down.fire, true);
  assert.equal(held.pressed.fire, false);
  assert.equal(held.released.fire, false);
});

test("a tap inside one frame is both a press and a release", () => {
  const latch = createLatch();
  const down = buttonState();
  down.sensUp = true;
  latchTransition(latch, down);
  latchTransition(latch, buttonState());

  const frame = takeLatch(latch);
  assert.equal(frame.down.sensUp, false);
  assert.equal(frame.pressed.sensUp, true);
  assert.equal(frame.released.sensUp, true);

  const next = takeLatch(latch);
  assert.equal(next.pressed.sensUp, false);
  assert.equal(next.released.sensUp, false);
});

test("losing capture clears edges, and re-arming does not re-press a held key", () => {
  const held = buttonsFromCodes(["KeyW", "F1"], true);
  assert.equal(held.forward, true);
  assert.equal(held.debug, true);
  assert.equal(held.fire, true);

  const latch = createLatch();
  latchTransition(latch, held);
  const pressed = takeLatch(latch, 2, 2);
  assert.equal(pressed.pressed.forward, true);
  assert.equal(pressed.pressed.debug, true);
  assert.equal(pressed.pressed.fire, true);

  clearLatch(latch);
  const cleared = takeLatch(latch, 9, 9);
  assert.equal(cleared.lookX, 9);
  for (const action of Object.keys(cleared.down)) {
    assert.equal(cleared.down[action], false, action);
    assert.equal(cleared.pressed[action], false, action);
    assert.equal(cleared.released[action], false, action);
  }

  armLatch(latch, held);
  const resumed = takeLatch(latch, 1, 0);
  assert.equal(resumed.down.forward, true);
  assert.equal(resumed.down.fire, true);
  assert.equal(resumed.down.debug, true);
  assert.equal(resumed.pressed.forward, false);
  assert.equal(resumed.pressed.fire, false);
  assert.equal(resumed.released.forward, false);
  assert.equal(resumed.lookX, 1);
});

test("debug stays down while either Backquote or F1 is held", () => {
  assert.equal(buttonsFromCodes(["Backquote"], false).debug, true);
  assert.equal(buttonsFromCodes(["F1"], false).debug, true);
  assert.equal(buttonsFromCodes(["Backquote", "F1"], false).debug, true);
  assert.equal(buttonsFromCodes(["KeyW"], false).debug, false);
});

test("latched clicks survive a slow frame and clear on pause, death, and restart", () => {
  const listeners = [];
  const documentListeners = [];
  const canvas = {};
  const doc = {
    pointerLockElement: canvas,
    addEventListener(type, fn) {
      documentListeners.push({ type, fn });
    },
  };
  const win = {
    addEventListener(type, fn) {
      listeners.push({ type, fn });
    },
  };
  globalThis.document = doc;
  globalThis.window = win;

  const input = createInput(canvas);
  const quill = createQuill({ hitboxes: createHitboxWorld() });
  const origin = { x: 0, y: 0, z: 0 };
  const direction = { x: 0, y: 0, z: -1 };
  const fireDown = listeners.filter((row) => row.type === "mousedown");
  assert.equal(fireDown.length, 1, "game window mousedown listeners");
  assert.equal(fireDown[0].fn.fragRole, "fire");

  const dispatch = (type) => {
    const event = { button: 0, preventDefault() {} };
    for (const row of listeners) if (row.type === type) row.fn(event);
  };
  const click = () => {
    dispatch("mousedown");
    dispatch("mouseup");
  };
  const step = (dt, { captured = true, living = true } = {}) => {
    if (!living) input.discard();
    const controls = input.sample(captured);
    if (captured && living) {
      quill.update(dt, {
        fire: controls.down.fire,
        presses: controls.firePresses,
        reload: false,
        origin,
        direction,
      });
    }
    return controls;
  };

  // Arm while the pointer is locked, the same way the first playing frame does.
  const armed = step(0);
  assert.equal(armed.firePresses, 0);
  assert.equal(armed.down.fire, false);

  click();
  const tapped = input.sample(true);
  assert.equal(tapped.down.fire, false, "a finished click was still held");
  assert.equal(tapped.firePresses, 1, "a click between samples was dropped");
  assert.equal(tapped.pressed.fire, true);
  quill.update(0.2, {
    fire: tapped.down.fire,
    presses: tapped.firePresses,
    reload: false,
    origin,
    direction,
  });
  assert.equal(quill.shotsFired, 1, "the latched click did not fire");
  const next = input.sample(true);
  assert.equal(next.firePresses, 0, "the latch survived the sample that read it");

  click();
  click();
  click();
  const burst = input.sample(true);
  assert.equal(burst.firePresses, 3, "a slow frame collapsed three clicks");
  assert.equal(burst.down.fire, false);

  // Pause consumes the latch instead of turning it into a shot after resume.
  const beforePause = quill.shotsFired;
  click();
  const paused = step(0.2, { captured: false });
  assert.equal(paused.firePresses, 0);
  assert.equal(paused.down.fire, false);
  click();
  const resumed = step(0.2, { captured: true });
  assert.equal(resumed.firePresses, 0, "a click during pause was still latched");
  assert.equal(quill.shotsFired, beforePause, "pause produced a shot");

  // The recap ignores input for RECAP_ARM_SECONDS. The player is dead then,
  // and the restart click itself is discarded.
  assert.equal(RECAP_ARM_SECONDS, 1);
  const beforeDeath = quill.shotsFired;
  click();
  const dead = step(RECAP_ARM_SECONDS, { living: false });
  assert.equal(dead.firePresses, 0, "a recap click stayed latched");
  input.discard();
  const revived = step(0.2, { living: true });
  assert.equal(revived.firePresses, 0, "restart kept the recap click");
  assert.equal(quill.shotsFired, beforeDeath, "the recap click fired after restart");

  // Eight clicks, 250 ms apart, sampled at 5 fps.
  const fresh = createQuill({ hitboxes: createHitboxWorld() });
  const frame = 1 / 5;
  const spacing = 0.25;
  let time = 0;
  let sent = 0;
  while (time < 8 * spacing - 1e-9) {
    const end = time + frame;
    let presses = 0;
    while (sent < 8 && sent * spacing < end - 1e-12) {
      click();
      presses += 1;
      sent += 1;
    }
    const controls = input.sample(true);
    assert.equal(controls.firePresses, presses, `frame at ${time} s`);
    assert.equal(controls.down.fire, false);
    fresh.update(frame, {
      fire: controls.down.fire,
      presses: controls.firePresses,
      reload: false,
      origin,
      direction,
    });
    time = end;
  }
  assert.equal(sent, 8);
  assert.equal(fresh.shotsFired, 8, `5 fps clicks fired ${fresh.shotsFired}`);
});

test("play without pointer lock latches keys and a single canvas click", () => {
  const listeners = [];
  const canvas = {};
  let phase = "playing";
  const shell = {
    getAttribute(name) {
      return name === "data-phase" ? phase : null;
    },
  };
  globalThis.document = {
    pointerLockElement: null,
    addEventListener() {},
    querySelector(selector) {
      return selector === "#app-shell" ? shell : null;
    },
  };
  globalThis.window = {
    addEventListener(type, fn) {
      listeners.push({ type, fn });
    },
  };
  const input = createInput(canvas);
  const dispatch = (type, event) => {
    for (const row of listeners) if (row.type === type) row.fn(event);
  };

  input.sample(true);
  dispatch("keydown", { code: "KeyW", repeat: false, preventDefault() {} });
  dispatch("keydown", { code: "KeyR", repeat: false, preventDefault() {} });
  const moving = input.sample(true);
  assert.equal(moving.down.forward, true);
  assert.equal(moving.pressed.reload, true);
  assert.equal(moving.lookX, 0);
  dispatch("keyup", { code: "KeyW" });
  dispatch("keyup", { code: "KeyR" });

  dispatch("mousedown", { button: 0, target: canvas });
  dispatch("mouseup", { button: 0, target: canvas });
  const shot = input.sample(true);
  assert.equal(shot.firePresses, 1, "unlocked canvas click was dropped or doubled");
  assert.equal(shot.down.fire, false);

  phase = "paused";
  dispatch("mousedown", { button: 0, target: canvas });
  dispatch("mouseup", { button: 0, target: canvas });
  const paused = input.sample(false);
  assert.equal(paused.firePresses, 0, "a resume click stayed latched");
  phase = "playing";
  const resumed = input.sample(true);
  assert.equal(resumed.firePresses, 0, "resume turned the pause click into a shot");
});

test("right click is alt and the canvas context menu is suppressed", () => {
  const listeners = [];
  const canvasListeners = [];
  const canvas = {
    addEventListener(type, fn) {
      canvasListeners.push({ type, fn });
    },
  };
  globalThis.document = {
    pointerLockElement: canvas,
    addEventListener() {},
    querySelector() {
      return null;
    },
  };
  globalThis.window = {
    addEventListener(type, fn) {
      listeners.push({ type, fn });
    },
  };
  const input = createInput(canvas);
  input.sample(true);

  const menu = canvasListeners.find((row) => row.type === "contextmenu");
  assert.ok(menu, "canvas contextmenu listener");
  let prevented = false;
  menu.fn({
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);

  const down = listeners.find((row) => row.type === "mousedown");
  let rightPrevented = false;
  down.fn({
    button: 2,
    preventDefault() {
      rightPrevented = true;
    },
  });
  assert.equal(rightPrevented, true);
  const held = input.sample(true);
  assert.equal(held.down.alt, true);
  assert.equal(held.pressed.alt, true);
  assert.equal(held.down.fire, false);
  assert.equal(held.firePresses, 0, "right click counted as a left click");

  const up = listeners.find((row) => row.type === "mouseup");
  up.fn({ button: 2 });
  const released = input.sample(true);
  assert.equal(released.down.alt, false);
  assert.equal(released.released.alt, true);
  assert.equal(released.firePresses, 0);
});
