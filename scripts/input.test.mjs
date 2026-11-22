import assert from "node:assert/strict";
import test from "node:test";
import {
  actionForCode,
  armLatch,
  buttonEdges,
  buttonState,
  buttonsFromCodes,
  clearLatch,
  createLatch,
  latchTransition,
  takeLatch,
} from "../src/input.ts";

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
