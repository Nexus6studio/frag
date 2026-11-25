import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ATRIUM_SPAWN, createAtriumHull } from "../src/atrium.ts";
import { createFight } from "../src/fight.ts";
import { createHitboxWorld } from "../src/hitbox.ts";
import { acceptRestartClick, bindHud } from "../src/hud/model.ts";
import { createPlayerState } from "../src/player/state.ts";
import { mountShell, unlockShouldPause } from "../src/shell.ts";

const IDS = [
  "app-shell",
  "content-warning",
  "click-to-play",
  "pause",
  "pause-resume",
  "pause-settings",
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
    lockRequests: 0,
    requestPointerLock() {
      canvas.lockRequests += 1;
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
      const event = {
        code,
        repeat: false,
        target: null,
        preventDefault() {},
        stopPropagation() {},
        stopImmediatePropagation() {},
      };
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
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function play(h, hooks) {
  const shell = mountShell(h.canvas, hooks);
  h.elements.get("content-warning-continue").dispatch("click", clickEvent());
  h.elements.get("click-to-play").dispatch("click", clickEvent());
  assert.equal(shell.phase, "playing");
  return shell;
}

function fightOf(player) {
  return createFight({
    hull: createAtriumHull(),
    player,
    hitboxes: createHitboxWorld(),
    origin: ATRIUM_SPAWN,
  });
}

/** Same gate as the frame loop: pause does not step enemies or drain HP. */
function tick(shell, player, fight, seconds) {
  const dt = 1 / 120;
  let t = 0;
  while (t < seconds - 1e-9) {
    if (shell.phase === "playing" && player.get().hp > 0) fight.update(dt, ATRIUM_SPAWN);
    t += dt;
  }
}

function stamp(player, fight) {
  return {
    hp: player.get().hp,
    time: fight.wisps.time,
    timers: fight.wisps.drones.map((drone) => drone.timer),
    grace: fight.enforcers.units.map((unit) => unit.grace),
    enforcerTime: fight.enforcers.time,
  };
}

function deathHud(player, phase) {
  const death = {
    hidden: true,
    inert: false,
    textContent: "",
    style: { display: "", pointerEvents: "" },
    attrs: {},
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
  };
  const armorStat = {
    dataset: {},
    style: { visibility: "" },
    attrs: {},
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
  };
  const bound = bindHud(
    player,
    {
      root: { dataset: {} },
      hp: { textContent: "" },
      armor: { textContent: "" },
      ammo: { textContent: "" },
      armorStat,
      death,
    },
    phase,
    undefined,
    { getRecap: () => ({ wavesCleared: 1, frags: 2, timeAlive: 65 }) },
  );
  return { bound, death };
}

test("a pointer-lock release while dead is not a pause", () => {
  assert.equal(unlockShouldPause({ phase: "playing", requestOpen: false, dead: true }), false);
  assert.equal(unlockShouldPause({ phase: "playing", requestOpen: false, dead: false }), true);
});

test("pointerlockchange with no keydown pauses and freezes the sim", async (t) => {
  const h = createHarness();
  t.after(() => h.restore());
  // The lock promise stays pending for the whole hold. Esc still has to pause
  // once that hold has been observed, without a keydown.
  h.canvas.requestPointerLock = () => new Promise(() => {});
  const player = createPlayerState();
  const fight = fightOf(player);
  const shell = play(h);

  tick(shell, player, fight, 0.5);
  assert.ok(fight.wisps.time > 0, "play did not step the fight");
  assert.ok(
    fight.wisps.drones.some((drone) => drone.timer > 0),
    "play did not advance an enemy timer",
  );

  globalThis.document.pointerLockElement = h.canvas;
  h.lockChange();
  await settle();
  const before = stamp(player, fight);
  globalThis.document.pointerLockElement = null;
  h.lockChange();

  assert.equal(shell.phase, "paused");
  assert.equal(h.elements.get("pause").hidden, false);
  tick(shell, player, fight, 5);
  assert.deepEqual(stamp(player, fight), before);

  const main = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(main, /const playing = shell\.phase === "playing"/);
  assert.match(main, /if \(playing && living\) \{[^}]*wisps\.update\(simDt, body\.position\)/);
  assert.match(main, /enforcers\.update\(simDt, body\.position\)/);
});

test("escape and pointerlockchange pause once", async (t) => {
  const h = createHarness();
  t.after(() => h.restore());
  const shell = play(h);
  await settle();
  globalThis.document.pointerLockElement = h.canvas;
  h.lockChange();
  await settle();

  let pauses = 0;
  h.elements.get("pause").focus = () => {
    pauses += 1;
  };
  h.key("Escape");
  h.lockChange();

  assert.equal(pauses, 1);
  assert.equal(shell.phase, "paused");
  assert.equal(h.elements.get("pause").hidden, false);
  assert.equal(globalThis.document.pointerLockElement, null);
});

test("a lock loss at 0 hp keeps the death recap", async (t) => {
  const h = createHarness();
  t.after(() => h.restore());
  const player = createPlayerState();
  const shell = play(h, { dead: () => player.get().hp <= 0 });
  const { bound, death } = deathHud(player, () => shell.phase);
  t.after(() => bound.destroy());

  await settle();
  globalThis.document.pointerLockElement = h.canvas;
  h.lockChange();
  await settle();

  player.set({ hp: 0 });
  assert.equal(death.hidden, false);
  assert.match(death.textContent, /click to restart/);

  globalThis.document.pointerLockElement = null;
  h.lockChange();
  h.key("Escape");
  bound.update();

  assert.equal(shell.phase, "playing");
  assert.equal(h.elements.get("pause").hidden, true);
  assert.equal(death.hidden, false);
  assert.equal(player.get().hp, 0);
  assert.match(death.textContent, /click to restart/);
  assert.equal(
    acceptRestartClick({ mode: "dead", phase: shell.phase, hidden: false }),
    true,
  );
});
