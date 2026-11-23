import assert from "node:assert/strict";
import test from "node:test";
import { mountShell, unlockShouldPause } from "../src/shell.ts";

test("a pointer-lock release pauses play unless that request is still in flight", () => {
  assert.equal(unlockShouldPause({ phase: "playing", requestOpen: true }), false);
  assert.equal(unlockShouldPause({ phase: "playing", requestOpen: false }), true);
  assert.equal(unlockShouldPause({ phase: "paused", requestOpen: false }), false);
  assert.equal(unlockShouldPause({ phase: "warning", requestOpen: false }), false);
  assert.equal(unlockShouldPause({ phase: "ready", requestOpen: false }), false);
  assert.equal(unlockShouldPause({ phase: "playing", requestOpen: false, hold: true }), false);
});

const IDS = [
  "app-shell",
  "content-warning",
  "click-to-play",
  "pause",
  "content-warning-continue",
  "build-hash",
  "fps-readout",
];

function clickEvent() {
  return { button: 0, preventDefault() {}, stopPropagation() {} };
}

function createHarness() {
  const keyListeners = [];
  const lockListeners = [];
  const elements = new Map();
  for (const id of IDS) {
    const listeners = new Map();
    elements.set(id, {
      id,
      hidden: false,
      dataset: {},
      textContent: "",
      focus() {},
      contains() {
        return false;
      },
      addEventListener(type, fn) {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      dispatch(type, event) {
        for (const fn of listeners.get(type) ?? []) fn(event);
      },
    });
  }

  const canvasListeners = new Map();
  let pointerLockElement = null;
  const canvas = {
    addEventListener(type, fn) {
      const list = canvasListeners.get(type) ?? [];
      list.push(fn);
      canvasListeners.set(type, list);
    },
    dispatch(type, event) {
      for (const fn of canvasListeners.get(type) ?? []) fn(event);
    },
    requestPointerLock() {
      return Promise.resolve();
    },
  };

  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    build: globalThis.__FRAG_BUILD__,
  };
  const doc = {
    get pointerLockElement() {
      return pointerLockElement;
    },
    set pointerLockElement(value) {
      pointerLockElement = value;
    },
    addEventListener(type, fn) {
      if (type === "pointerlockchange") lockListeners.push(fn);
    },
    exitPointerLock() {
      if (pointerLockElement === null) return;
      pointerLockElement = null;
      for (const fn of [...lockListeners]) fn();
    },
    querySelector(selector) {
      return elements.get(String(selector).slice(1)) ?? null;
    },
  };
  globalThis.__FRAG_BUILD__ = "testbld";
  globalThis.document = doc;
  globalThis.window = {
    addEventListener(type, fn) {
      if (type === "keydown") keyListeners.push(fn);
    },
    setTimeout,
    clearTimeout,
  };

  return {
    canvas,
    elements,
    key(code) {
      const event = { code, repeat: false, target: null, preventDefault() {}, stopPropagation() {} };
      for (const fn of keyListeners) fn(event);
    },
    lockChange() {
      for (const fn of [...lockListeners]) fn();
    },
    restore() {
      globalThis.document = previous.document;
      globalThis.window = previous.window;
      if (previous.build === undefined) delete globalThis.__FRAG_BUILD__;
      else globalThis.__FRAG_BUILD__ = previous.build;
    },
  };
}

async function settle() {
  // The lock request resolves in a microtask, then clears its token on a timer.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function play(h) {
  const shell = mountShell(h.canvas);
  h.elements.get("content-warning-continue").dispatch("click", clickEvent());
  assert.equal(shell.phase, "ready");
  h.elements.get("click-to-play").dispatch("click", clickEvent());
  assert.equal(shell.phase, "playing");
  assert.equal(h.elements.get("pause").hidden, true);
  return shell;
}

test("escape pauses with and without the pointer lock", async (t) => {
  const h = createHarness();
  t.after(() => h.restore());
  const shell = play(h);
  await settle();

  h.key("Escape");
  assert.equal(shell.phase, "paused");
  assert.equal(h.elements.get("pause").hidden, false);

  h.key("Enter");
  await settle();
  globalThis.document.pointerLockElement = h.canvas;
  h.lockChange();
  assert.equal(shell.phase, "playing");
  assert.equal(globalThis.document.pointerLockElement, h.canvas);

  h.key("Escape");
  assert.equal(shell.phase, "paused");
  assert.equal(h.elements.get("pause").hidden, false);
  assert.equal(globalThis.document.pointerLockElement, null);

  h.key("Enter");
  await settle();
  globalThis.document.pointerLockElement = h.canvas;
  h.lockChange();
  globalThis.document.pointerLockElement = null;
  h.lockChange();
  assert.equal(shell.phase, "paused", "browser-consumed escape did not pause");
  assert.equal(h.elements.get("pause").hidden, false);
});

test("enter and a click both resume from pause", (t) => {
  const h = createHarness();
  t.after(() => h.restore());
  const shell = play(h);
  h.key("Escape");
  assert.equal(shell.phase, "paused");

  h.key("Enter");
  assert.equal(shell.phase, "playing");
  assert.equal(h.elements.get("pause").hidden, true);

  h.key("Escape");
  h.elements.get("pause").dispatch("click", clickEvent());
  assert.equal(shell.phase, "playing");
  assert.equal(h.elements.get("pause").hidden, true);

  h.key("Escape");
  h.canvas.dispatch("mousedown", clickEvent());
  assert.equal(shell.phase, "playing");
  assert.equal(h.elements.get("pause").hidden, true);
});

test("a rejected pointer lock does not soft-lock resume", async (t) => {
  const h = createHarness();
  t.after(() => h.restore());
  h.canvas.requestPointerLock = () => Promise.reject(new Error("SecurityError"));
  const shell = play(h);
  await settle();
  assert.equal(shell.phase, "playing");
  assert.equal(h.elements.get("pause").hidden, true);
  assert.equal(globalThis.document.pointerLockElement, null);

  h.key("Escape");
  assert.equal(shell.phase, "paused");
  assert.equal(h.elements.get("pause").hidden, false);

  h.key("Enter");
  await settle();
  assert.equal(shell.phase, "playing");
  assert.equal(h.elements.get("pause").hidden, true);
  assert.equal(globalThis.document.pointerLockElement, null);

  h.key("Escape");
  h.elements.get("pause").dispatch("click", clickEvent());
  await settle();
  assert.equal(shell.phase, "playing");
  assert.equal(h.elements.get("pause").hidden, true);
  assert.equal(globalThis.document.pointerLockElement, null);
});

test("losing the pointer pauses even inside the first second, but not mid-request", async (t) => {
  const h = createHarness();
  t.after(() => h.restore());
  let release = () => {};
  h.canvas.requestPointerLock = () =>
    new Promise((resolve) => {
      release = () => {
        globalThis.document.pointerLockElement = h.canvas;
        h.lockChange();
        resolve();
      };
    });
  const shell = play(h);
  globalThis.document.pointerLockElement = h.canvas;
  h.lockChange();
  globalThis.document.pointerLockElement = null;
  h.lockChange();
  assert.equal(shell.phase, "playing", "an in-flight drop paused");
  assert.equal(h.elements.get("pause").hidden, true);

  release();
  await settle();
  assert.equal(shell.phase, "playing");
  globalThis.document.pointerLockElement = null;
  h.lockChange();
  assert.equal(shell.phase, "paused", "a settled unlock did not pause");
  assert.equal(h.elements.get("pause").hidden, false);
});
