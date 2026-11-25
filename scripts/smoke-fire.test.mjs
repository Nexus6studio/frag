import assert from "node:assert/strict";
import test from "node:test";
import { createHitboxWorld } from "../src/hitbox.ts";
import { MAX_FRAME_SECONDS } from "../src/move.ts";
import { QUILL_INTERVAL, QUILL_MAG, QUILL_RELOAD, createQuill } from "../src/quill.ts";
import {
  HELD_FIRE_ROUNDS,
  heldFireBudgetSeconds,
  judgeHeldFire,
  judgeReload,
  reloadBudgetSeconds,
  settleSimVerdict,
} from "./smoke-fire.ts";

const origin = { x: 0, y: 0, z: 0 };
const forward = { x: 0, y: 0, z: -1 };

function hold(fire) {
  return { fire, presses: 0, reload: false, origin, direction: forward };
}

function sample(overrides) {
  return {
    sim: 0,
    shots: 0,
    mag: QUILL_MAG,
    reserve: QUILL_MAG,
    reloading: false,
    hud: `${QUILL_MAG}+${QUILL_MAG}`,
    hp: 100,
    phase: "playing",
    ...overrides,
  };
}

test("the hold budget is the six-round clock plus one clamped frame, not a wall timeout", () => {
  assert.equal(HELD_FIRE_ROUNDS, 6);
  assert.equal(heldFireBudgetSeconds(), (HELD_FIRE_ROUNDS - 1) * QUILL_INTERVAL + MAX_FRAME_SECONDS);
  assert.ok(heldFireBudgetSeconds() < 2);
  assert.equal(reloadBudgetSeconds(), QUILL_RELOAD + MAX_FRAME_SECONDS);
  assert.ok(reloadBudgetSeconds() < 3);
});

test("clamped 250 ms frames spend six rounds inside the sim budget", () => {
  const quill = createQuill({ hitboxes: createHitboxWorld() });
  const start = { sim: 0, shots: 0 };
  let sim = 0;
  let verdict = { state: "pending" };
  for (let frame = 0; frame < 8 && verdict.state === "pending"; frame += 1) {
    quill.update(MAX_FRAME_SECONDS, hold(true));
    sim += MAX_FRAME_SECONDS;
    verdict = judgeHeldFire(
      start,
      sample({
        sim,
        shots: quill.shotsFired,
        mag: quill.mag,
        hud: `${quill.mag}+${quill.reserve}`,
      }),
    );
  }
  assert.equal(verdict.state, "pass");
  assert.ok(sim <= heldFireBudgetSeconds() + 1e-9, `sim ${sim} passed the budget ${heldFireBudgetSeconds()}`);
  assert.ok(quill.mag <= QUILL_MAG - HELD_FIRE_ROUNDS);
});

test("a hold that does not shoot fails once the sim budget has elapsed", () => {
  const start = { sim: 1, shots: 4 };
  const early = judgeHeldFire(start, sample({ sim: 1.2, shots: 4, mag: 36, hud: "36+40" }));
  assert.equal(early.state, "pending");
  const late = judgeHeldFire(
    start,
    sample({ sim: 1 + heldFireBudgetSeconds() + 0.01, shots: 4, mag: 36, hud: "36+40" }),
  );
  assert.equal(late.state, "fail");
  assert.equal(late.code, "not-fired");
});

test("death or pause fails the hold before the budget, and a spent mag still counts", () => {
  const start = { sim: 0, shots: 0 };
  const dead = judgeHeldFire(start, sample({ sim: 0.2, hp: 0, hud: "40+40" }));
  assert.equal(dead.state, "fail");
  assert.equal(dead.code, "dead");
  const paused = judgeHeldFire(start, sample({ sim: 0.2, phase: "paused" }));
  assert.equal(paused.state, "fail");
  assert.equal(paused.code, "phase");
  const spentThenDead = judgeHeldFire(
    start,
    sample({ sim: 0.7, shots: 6, mag: 34, hud: "34+40", hp: 0 }),
  );
  assert.equal(spentThenDead.state, "pass");
});

test("a hud that does not follow the magazine fails the hold", () => {
  const verdict = judgeHeldFire(
    { sim: 0, shots: 0 },
    sample({ sim: heldFireBudgetSeconds() + 0.05, shots: 8, mag: 32, hud: "40+40" }),
  );
  assert.equal(verdict.state, "fail");
  assert.equal(verdict.code, "hud");
});

test("clamped frames finish a 1.4 s reload inside the sim budget", () => {
  const quill = createQuill({ hitboxes: createHitboxWorld() });
  quill.update(0, hold(true));
  while (quill.mag > 29) quill.update(QUILL_INTERVAL, hold(true));
  const startMag = quill.mag;
  const startReserve = quill.reserve;
  assert.ok(startMag < QUILL_MAG);
  assert.equal(startReserve, QUILL_MAG);
  const startSim = 2;
  quill.update(0, { fire: false, presses: 0, reload: true, origin, direction: forward });
  let sim = startSim;
  let verdict = { state: "pending" };
  for (let frame = 0; frame < 12 && verdict.state === "pending"; frame += 1) {
    quill.update(MAX_FRAME_SECONDS, hold(false));
    sim += MAX_FRAME_SECONDS;
    verdict = judgeReload(
      { sim: startSim, mag: startMag, reserve: startReserve },
      sample({
        sim,
        shots: quill.shotsFired,
        mag: quill.mag,
        reserve: quill.reserve,
        reloading: quill.reloading,
        hud: `${quill.mag}+${quill.reserve}`,
      }),
    );
  }
  assert.equal(verdict.state, "pass");
  assert.equal(quill.mag, QUILL_MAG);
  assert.ok(quill.reserve < QUILL_MAG);
  assert.ok(sim - startSim <= reloadBudgetSeconds() + 1e-9, `reload sim ${sim - startSim}`);
});

test("a reload key the sim never samples fails after the budget", () => {
  const start = { sim: 3, mag: 29, reserve: 40 };
  const pending = judgeReload(start, sample({ sim: 3.4, mag: 29, reserve: 40, hud: "29+40" }));
  assert.equal(pending.state, "pending");
  const missed = judgeReload(
    start,
    sample({ sim: 3 + reloadBudgetSeconds() + 0.01, mag: 29, reserve: 40, hud: "29+40" }),
  );
  assert.equal(missed.state, "fail");
  assert.equal(missed.code, "not-sampled");
});

test("a reload that stays open past the budget fails even if the key was sampled", () => {
  const verdict = judgeReload(
    { sim: 0, mag: 29, reserve: 40 },
    sample({
      sim: reloadBudgetSeconds() + 0.01,
      mag: 29,
      reserve: 40,
      reloading: true,
      hud: "29+40",
    }),
  );
  assert.equal(verdict.state, "fail");
  assert.equal(verdict.code, "not-refilled");
});

test("death during a reload fails as death while the phase is still playing", () => {
  const verdict = judgeReload(
    { sim: 0, mag: 29, reserve: 40 },
    sample({ sim: 0.5, mag: 29, reserve: 40, reloading: true, hud: "29+40", hp: 0 }),
  );
  assert.equal(verdict.state, "fail");
  assert.equal(verdict.code, "dead");
  assert.match(verdict.reason, /died/);
});

test("wall time past 15s still passes when each slow frame advances the sim", async () => {
  const quill = createQuill({ hitboxes: createHitboxWorld() });
  const frames = [];
  let sim = 0;
  while (quill.shotsFired < HELD_FIRE_ROUNDS) {
    quill.update(MAX_FRAME_SECONDS, hold(true));
    sim += MAX_FRAME_SECONDS;
    frames.push(
      sample({
        sim,
        shots: quill.shotsFired,
        mag: quill.mag,
        hud: `${quill.mag}+${quill.reserve}`,
      }),
    );
  }
  let wall = 0;
  let index = 0;
  const result = await settleSimVerdict({
    now: () => wall,
    hangMs: 15_000,
    pollMs: 0,
    delay: async () => {
      wall += 10_000;
    },
    read: async () => {
      wall += 10_000;
      return frames[Math.min(index++, frames.length - 1)];
    },
    judge: (live) => judgeHeldFire({ sim: 0, shots: 0 }, live),
  });
  assert.equal(result.verdict.state, "pass");
  assert.ok(wall >= 15_000, `wall ${wall}`);
});

test("a sim that stops advancing fails even though the wall hang is the only clock", async () => {
  let wall = 0;
  const result = await settleSimVerdict({
    now: () => wall,
    hangMs: 1_000,
    pollMs: 0,
    delay: async () => {
      wall += 400;
    },
    read: async () => sample({ sim: 2, mag: 40, hud: "40+40" }),
    judge: () => ({ state: "pending" }),
  });
  assert.equal(result.verdict.state, "fail");
  assert.equal(result.verdict.code, "stalled");
  assert.ok(wall >= 1_000);
});
