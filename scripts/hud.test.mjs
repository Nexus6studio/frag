import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  SHOW_ARMOR,
  acceptRestartClick,
  applyHud,
  bindHud,
  hudMode,
  hudReadout,
  recapAcceptsInput,
} from "../src/hud/model.ts";
import { START_VITALS, createPlayerState, exposePlayerDebug } from "../src/player/state.ts";

function fakeHud() {
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
  return {
    root: { dataset: {} },
    hp: { textContent: null },
    armor: { textContent: null },
    ammo: { textContent: null },
    armorStat,
    death: {
      hidden: true,
      inert: false,
      style: { display: "", pointerEvents: "" },
      attrs: {},
      setAttribute(name, value) {
        this.attrs[name] = value;
      },
      removeAttribute(name) {
        delete this.attrs[name];
      },
    },
  };
}

test("player state starts at 100 hp, 0 armor, 40+40 ammo", () => {
  const player = createPlayerState();
  assert.deepEqual(player.get(), { hp: 100, armor: 0, mag: 40, reserve: 40 });
  assert.deepEqual(START_VITALS, { hp: 100, armor: 0, mag: 40, reserve: 40 });
});

test("get returns a copy", () => {
  const player = createPlayerState();
  const first = player.get();
  first.hp = 1;
  assert.equal(player.get().hp, 100);
});

test("subscribers see vitals changes and can unsubscribe", () => {
  const player = createPlayerState();
  const seen = [];
  const stop = player.subscribe((state) => {
    seen.push({ ...state });
  });
  player.set({ hp: 80, armor: 25, mag: 12, reserve: 7 });
  stop();
  player.set({ hp: 1 });
  assert.deepEqual(seen, [{ hp: 80, armor: 25, mag: 12, reserve: 7 }]);
  assert.equal(player.get().hp, 1);
});

test("restart restores the start vitals", () => {
  const player = createPlayerState();
  player.set({ hp: 0, armor: 40, mag: 0, reserve: 0 });
  player.restart();
  assert.deepEqual(player.get(), { hp: 100, armor: 0, mag: 40, reserve: 40 });
});

test("hud readout follows player state and shows armor", () => {
  assert.equal(SHOW_ARMOR, true);
  const player = createPlayerState();
  let phase = "playing";
  const els = fakeHud();
  const hud = bindHud(player, els, () => phase);

  assert.equal(els.hp.textContent, "100");
  assert.equal(els.armor.textContent, "0");
  assert.equal(els.ammo.textContent, "40+40");
  assert.equal(els.armorStat.style.visibility, "visible");
  assert.equal(els.armorStat.dataset.visible, "true");
  assert.equal(els.armorStat.attrs["aria-hidden"], undefined);
  assert.equal(els.root.dataset.mode, "play");
  assert.equal(els.death.hidden, true);
  assert.equal(els.death.inert, true);
  assert.equal(els.death.style.display, "none");
  assert.equal(els.death.style.pointerEvents, "none");
  assert.equal(els.death.attrs["aria-hidden"], "true");

  player.set({ hp: 73, armor: 15, mag: 10, reserve: 5 });
  assert.equal(els.hp.textContent, "73");
  assert.equal(els.armor.textContent, "15");
  assert.equal(els.ammo.textContent, "10+5");
  assert.equal(els.armorStat.style.visibility, "visible");
  assert.equal(hudReadout(player.get(), "playing").showArmor, true);

  phase = "paused";
  hud.update();
  assert.equal(els.root.dataset.mode, "dim");

  phase = "warning";
  hud.update();
  assert.equal(els.root.dataset.mode, "hidden");

  phase = "ready";
  hud.update();
  assert.equal(els.root.dataset.mode, "hidden");

  phase = "playing";
  player.set({ hp: 0 });
  assert.equal(els.root.dataset.mode, "dead");
  assert.equal(els.death.hidden, false);
  assert.equal(els.death.inert, false);
  assert.equal(els.death.style.display, "");
  assert.equal(els.death.style.pointerEvents, "auto");
  assert.equal(els.death.attrs["aria-hidden"], undefined);
  assert.equal(els.hp.textContent, "0");

  phase = "paused";
  hud.update();
  assert.equal(els.root.dataset.mode, "dim");
  assert.equal(els.death.hidden, true);

  player.restart();
  phase = "playing";
  hud.update();
  assert.equal(els.root.dataset.mode, "play");
  assert.equal(els.hp.textContent, "100");
  assert.equal(els.armor.textContent, "0");
  assert.equal(els.armorStat.style.visibility, "visible");
  assert.equal(els.ammo.textContent, "40+40");

  hud.destroy();
  player.set({ hp: 4 });
  assert.equal(els.hp.textContent, "100");
});

test("turning showArmor on reveals the same slot", () => {
  const els = fakeHud();
  applyHud(els, { hp: "100", armor: "0", ammo: "40+40", showArmor: false, mode: "play" });
  assert.equal(els.armorStat.style.visibility, "hidden");
  applyHud(els, { hp: "100", armor: "0", ammo: "40+40", showArmor: true, mode: "play" });
  assert.equal(els.armor.textContent, "0");
  assert.equal(els.armorStat.style.visibility, "visible");
  assert.equal(els.armorStat.dataset.visible, "true");
  assert.equal(els.armorStat.attrs["aria-hidden"], undefined);
  assert.equal(els.hp.textContent, "100");
  assert.equal(els.ammo.textContent, "40+40");
});

test("the recap ignores input for one second", () => {
  assert.equal(recapAcceptsInput(0), false);
  assert.equal(recapAcceptsInput(0.99), false);
  assert.equal(recapAcceptsInput(1), true);
  assert.equal(recapAcceptsInput(1.2), true);
});

test("zero ammo shows an empty cue and a dry magazine shows reload", () => {
  const els = fakeHud();
  els.cue = { hidden: true, textContent: "" };
  applyHud(els, { hp: "0", armor: "0", ammo: "0+12", showArmor: false, mode: "play" });
  assert.equal(els.cue.hidden, false);
  assert.equal(els.cue.textContent, "RELOAD");
  applyHud(els, { hp: "0", armor: "0", ammo: "0+0", showArmor: false, mode: "play" });
  assert.equal(els.cue.hidden, false);
  assert.equal(els.cue.textContent, "EMPTY");
  applyHud(els, { hp: "100", armor: "0", ammo: "40+40", showArmor: false, mode: "play" });
  assert.equal(els.cue.hidden, true);
});

test("a death click does not restart from pause or a blur", () => {
  assert.equal(acceptRestartClick({ mode: "dead", phase: "playing", hidden: false }), true);
  assert.equal(acceptRestartClick({ mode: "dead", phase: "paused", hidden: false }), false);
  assert.equal(acceptRestartClick({ mode: "dead", phase: "playing", hidden: true }), false);
  assert.equal(acceptRestartClick({ mode: "dim", phase: "paused", hidden: false }), false);
  assert.equal(acceptRestartClick({ mode: "play", phase: "playing", hidden: false }), false);
  assert.equal(acceptRestartClick({ mode: "dead", phase: null, hidden: false }), false);
});

test("hud mode hides non-play phases and dims pause", () => {
  assert.equal(hudMode("warning", 100), "hidden");
  assert.equal(hudMode("ready", 100), "hidden");
  assert.equal(hudMode(null, 100), "hidden");
  assert.equal(hudMode("playing", 100), "play");
  assert.equal(hudMode("playing", 0), "dead");
  assert.equal(hudMode("playing", -1), "dead");
  assert.equal(hudMode("paused", 100), "dim");
  assert.equal(hudMode("paused", 0), "dim");
});

test("debug hook attaches only when called", () => {
  const host = {};
  assert.equal("__fragPlayer" in host, false);
  const player = createPlayerState();
  exposePlayerDebug(host, player);
  assert.equal(host.__fragPlayer, player);
  host.__fragPlayer.set({ mag: 8, reserve: 9 });
  assert.equal(player.get().mag, 8);
  assert.equal(player.get().reserve, 9);
});

test("debug hook in main is gated on import.meta.env.DEV", () => {
  const source = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const gated = source.replace(/\s+/g, " ");
  assert.match(gated, /if \(import\.meta\.env\.DEV\) \{[^}]*exposePlayerDebug\(window, player\);/);
});
