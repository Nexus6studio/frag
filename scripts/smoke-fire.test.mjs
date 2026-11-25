import assert from "node:assert/strict";
import test from "node:test";
import { ATRIUM_SPAWN, createAtriumHull, createAtriumMover } from "../src/atrium.ts";
import { createFight } from "../src/fight.ts";
import { createHitboxWorld } from "../src/hitbox.ts";
import { GROUND_ACCEL, MAX_FRAME_SECONDS, createMoveState } from "../src/move.ts";
import { createPlayerState } from "../src/player/state.ts";
import { QUILL_INTERVAL, QUILL_MAG, QUILL_RELOAD, createQuill } from "../src/quill.ts";
import { WAVE_GAP_SECONDS } from "../src/waves.ts";
import { WISP_TELEGRAPH, wispSpawnGrace } from "../src/wisp.ts";
import {
  FORWARD_MOVE_METERS,
  HELD_FIRE_ROUNDS,
  forwardMoveBudgetSeconds,
  heldFireBudgetSeconds,
  LOOK_PITCH_AWAY,
  LOOK_YAW_AWAY,
  judgeForwardMove,
  judgeHeldFire,
  judgeLookLeftSpawn,
  judgeReload,
  judgeWave3Bolts,
  lookLeaveBudgetSeconds,
  reloadBudgetSeconds,
  settleSimVerdict,
  wave3BoltBudgetSeconds,
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

function moveSample(overrides) {
  return {
    sim: 0,
    z: ATRIUM_SPAWN.z,
    hp: 100,
    phase: "playing",
    ...overrides,
  };
}

test("the walk budget is the ground-accel meter plus one clamped frame", () => {
  assert.equal(FORWARD_MOVE_METERS, 1);
  assert.equal(
    forwardMoveBudgetSeconds(0),
    Math.sqrt((2 * FORWARD_MOVE_METERS) / GROUND_ACCEL) + MAX_FRAME_SECONDS,
  );
  assert.ok(forwardMoveBudgetSeconds(0) < 1);
  assert.ok(forwardMoveBudgetSeconds(76.8) > forwardMoveBudgetSeconds(0));
  assert.ok(forwardMoveBudgetSeconds(76.8) < 2);
});

test("clamped frames from the atrium spawn cross one meter inside the sim budget", () => {
  const mover = createAtriumMover(createMoveState(ATRIUM_SPAWN));
  const intent = { forward: 1, strafe: 0, jump: false, yawDeg: 0 };
  const startZ = mover.state.position.z;
  let sim = 0;
  let verdict = { state: "pending" };
  for (let frame = 0; frame < 8 && verdict.state === "pending"; frame += 1) {
    mover.advance(MAX_FRAME_SECONDS, intent);
    sim += MAX_FRAME_SECONDS;
    verdict = judgeForwardMove(
      { sim: 0, z: startZ, yaw: 0 },
      moveSample({ sim, z: mover.state.position.z }),
    );
  }
  assert.equal(verdict.state, "pass");
  assert.ok(startZ - mover.state.position.z > FORWARD_MOVE_METERS);
  assert.ok(sim <= forwardMoveBudgetSeconds(0) + 1e-9, `walk sim ${sim}`);
});

test("an off-axis look still covers one meter of -z inside its longer budget", () => {
  const yaw = 76.8;
  const mover = createAtriumMover(createMoveState(ATRIUM_SPAWN));
  const intent = { forward: 1, strafe: 0, jump: false, yawDeg: yaw };
  const startZ = mover.state.position.z;
  let sim = 0;
  let verdict = { state: "pending" };
  for (let frame = 0; frame < 16 && verdict.state === "pending"; frame += 1) {
    mover.advance(MAX_FRAME_SECONDS, intent);
    sim += MAX_FRAME_SECONDS;
    verdict = judgeForwardMove(
      { sim: 0, z: startZ, yaw },
      moveSample({ sim, z: mover.state.position.z }),
    );
  }
  assert.equal(verdict.state, "pass");
  assert.ok(sim <= forwardMoveBudgetSeconds(yaw) + 1e-9, `angled walk sim ${sim}`);
  assert.ok(sim > forwardMoveBudgetSeconds(0), "the straight-ahead budget is too short for this heading");
});

test("a hold of W that does not move fails once the sim budget has elapsed", () => {
  const start = { sim: 4, z: 7.4, yaw: 0 };
  const early = judgeForwardMove(start, moveSample({ sim: 4.2, z: 7.1 }));
  assert.equal(early.state, "pending");
  const late = judgeForwardMove(
    start,
    moveSample({ sim: 4 + forwardMoveBudgetSeconds(0) + 0.01, z: 7.1 }),
  );
  assert.equal(late.state, "fail");
  assert.equal(late.code, "not-moved");
  const turned = judgeForwardMove({ sim: 0, z: 7.4, yaw: 180 }, moveSample({ sim: 0.1, z: 7.4 }));
  assert.equal(turned.state, "fail");
  assert.equal(turned.code, "facing");
});

test("death or pause fails the walk before the budget, and a finished meter still counts", () => {
  const start = { sim: 0, z: 7.4, yaw: 0 };
  const dead = judgeForwardMove(start, moveSample({ sim: 0.1, z: 7.4, hp: 0 }));
  assert.equal(dead.state, "fail");
  assert.equal(dead.code, "dead");
  const paused = judgeForwardMove(start, moveSample({ sim: 0.1, z: 7.4, phase: "paused" }));
  assert.equal(paused.state, "fail");
  assert.equal(paused.code, "phase");
  const arrived = judgeForwardMove(start, moveSample({ sim: 0.5, z: 6.2, hp: 0 }));
  assert.equal(arrived.state, "pass");
});

test("wall time past the old 20s walk deadline still passes when each slow frame advances the sim", async () => {
  const mover = createAtriumMover(createMoveState(ATRIUM_SPAWN));
  const intent = { forward: 1, strafe: 0, jump: false, yawDeg: 0 };
  const startZ = mover.state.position.z;
  const frames = [];
  let sim = 0;
  while (startZ - mover.state.position.z <= FORWARD_MOVE_METERS) {
    mover.advance(MAX_FRAME_SECONDS, intent);
    sim += MAX_FRAME_SECONDS;
    frames.push(moveSample({ sim, z: mover.state.position.z }));
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
    judge: (live) => judgeForwardMove({ sim: 0, z: startZ, yaw: 0 }, live),
  });
  assert.equal(result.verdict.state, "pass");
  assert.ok(wall >= 20_000, `wall ${wall}`);
});

function fieldWave(extraFrames) {
  const player = createPlayerState();
  const fight = createFight({
    hull: createAtriumHull(),
    player,
    hitboxes: createHitboxWorld(),
    origin: ATRIUM_SPAWN,
  });
  const feet = { x: ATRIUM_SPAWN.x, y: ATRIUM_SPAWN.y, z: ATRIUM_SPAWN.z };
  let sim = 0;
  let delay = 0;
  const poll = () => {
    player.set({ hp: 100, armor: 0 });
    const snap = fight.snapshot();
    if (snap.wave < 3 && snap.phase === "fighting" && snap.count > 0) {
      const hold = snap.wave === 1 ? 0 : extraFrames;
      if (delay < hold) delay += 1;
      else {
        fight.killAll();
        delay = 0;
      }
    } else {
      delay = 0;
    }
    const after = fight.snapshot();
    return {
      sim,
      wave: after.wave,
      count: after.count,
      enforcerAlive: after.enforcerAlive,
      bolts: after.bolts,
      calls: 33,
      ready: true,
    };
  };
  const frames = [poll()];
  let verdict = judgeWave3Bolts({ sim: frames[0].sim }, frames[0]);
  while (verdict.state === "pending" && frames.length < 80) {
    fight.update(MAX_FRAME_SECONDS, feet);
    sim += MAX_FRAME_SECONDS;
    const sample = poll();
    frames.push(sample);
    verdict = judgeWave3Bolts({ sim: frames[0].sim }, sample);
  }
  return { verdict, sim, frames };
}

function lookSample(overrides) {
  return { sim: 0, yaw: 0, pitch: 0, ...overrides };
}

test("the look budget is two clamped frames, not a 3 s wall timeout", () => {
  assert.equal(LOOK_YAW_AWAY, 5);
  assert.equal(LOOK_PITCH_AWAY, 15);
  assert.equal(lookLeaveBudgetSeconds(), 2 * MAX_FRAME_SECONDS);
  assert.ok(lookLeaveBudgetSeconds() < 1);
});

test("a look that stays on spawn facing fails once two clamped frames have elapsed", () => {
  const start = { sim: 2 };
  const early = judgeLookLeftSpawn(start, lookSample({ sim: 2.2 }));
  assert.equal(early.state, "pending");
  const late = judgeLookLeftSpawn(start, lookSample({ sim: 2 + lookLeaveBudgetSeconds() + 0.01 }));
  assert.equal(late.state, "fail");
  assert.equal(late.code, "not-turned");
});

test("pitch or yaw past the spawn facing passes before the budget", () => {
  const start = { sim: 0 };
  const pitched = judgeLookLeftSpawn(start, lookSample({ sim: 0.1, pitch: -20 }));
  assert.equal(pitched.state, "pass");
  const yawed = judgeLookLeftSpawn(start, lookSample({ sim: 0.1, yaw: 6 }));
  assert.equal(yawed.state, "pass");
  const inside = judgeLookLeftSpawn(start, lookSample({ sim: 0.1, yaw: LOOK_YAW_AWAY, pitch: LOOK_PITCH_AWAY }));
  assert.equal(inside.state, "pending");
});

test("wall time past the old 3s look deadline still passes when a later frame turns", async () => {
  const frames = [
    lookSample({ sim: 1, yaw: 0, pitch: 0 }),
    lookSample({ sim: 1.25, yaw: 0, pitch: 0 }),
    lookSample({ sim: 1.5, yaw: 10, pitch: -40 }),
  ];
  let wall = 0;
  let index = 0;
  const result = await settleSimVerdict({
    now: () => wall,
    hangMs: 15_000,
    pollMs: 0,
    delay: async () => {
      wall += 4_000;
    },
    read: async () => {
      wall += 4_000;
      return frames[Math.min(index++, frames.length - 1)];
    },
    judge: (live) => judgeLookLeftSpawn({ sim: frames[0].sim }, live),
  });
  assert.equal(result.verdict.state, "pass");
  assert.ok(wall >= 3_000, `wall ${wall}`);
});

test("the wave 3 budget is two straddled gaps, one late kill, and the first bolt", () => {
  assert.equal(wispSpawnGrace(3), 2);
  assert.equal(
    wave3BoltBudgetSeconds(),
    2 * (WAVE_GAP_SECONDS + MAX_FRAME_SECONDS) +
      MAX_FRAME_SECONDS +
      wispSpawnGrace(3) +
      WISP_TELEGRAPH +
      MAX_FRAME_SECONDS,
  );
  assert.ok(wave3BoltBudgetSeconds() < 8);
});

test("clamped frames field wave 3 bolts inside the sim budget", () => {
  for (const extraFrames of [0, 1]) {
    const run = fieldWave(extraFrames);
    assert.equal(run.verdict.state, "pass", `extra ${extraFrames}: ${run.verdict.reason ?? ""}`);
    assert.ok(run.sim <= wave3BoltBudgetSeconds() + 1e-9, `extra ${extraFrames} sim ${run.sim}`);
    const last = run.frames[run.frames.length - 1];
    assert.equal(last.wave, 3);
    assert.equal(last.count, 4);
    assert.equal(last.enforcerAlive, 2);
    assert.ok(last.bolts > 0);
  }
});

test("a wave that never fires fails once the sim budget has elapsed", () => {
  const start = { sim: 2 };
  const early = judgeWave3Bolts(
    start,
    { sim: 4, wave: 2, count: 3, enforcerAlive: 1, bolts: 0, calls: 33, ready: true },
  );
  assert.equal(early.state, "pending");
  const late = judgeWave3Bolts(start, {
    sim: 2 + wave3BoltBudgetSeconds() + 0.01,
    wave: 2,
    count: 3,
    enforcerAlive: 1,
    bolts: 0,
    calls: 33,
    ready: true,
  });
  assert.equal(late.state, "fail");
  assert.equal(late.code, "not-fielded");
  const quiet = judgeWave3Bolts(start, {
    sim: 2 + wave3BoltBudgetSeconds() - 0.05,
    wave: 3,
    count: 4,
    enforcerAlive: 2,
    bolts: 2,
    calls: 0,
    ready: true,
  });
  assert.equal(quiet.state, "pending");
});

test("a missing dev hook fails the wave check before any sim budget", () => {
  const verdict = judgeWave3Bolts(
    { sim: 0 },
    { sim: Number.NaN, wave: Number.NaN, count: 0, enforcerAlive: 0, bolts: 0, calls: 0, ready: false },
  );
  assert.equal(verdict.state, "fail");
  assert.equal(verdict.code, "missing");
});

test("wall time past the old 25s wave deadline still passes when each slow frame advances the sim", async () => {
  const run = fieldWave(1);
  assert.equal(run.verdict.state, "pass");
  let wall = 0;
  let index = 0;
  const result = await settleSimVerdict({
    now: () => wall,
    hangMs: 15_000,
    pollMs: 0,
    delay: async () => {
      wall += 5_000;
    },
    read: async () => {
      wall += 5_000;
      return run.frames[Math.min(index++, run.frames.length - 1)];
    },
    judge: (live) => judgeWave3Bolts({ sim: run.frames[0].sim }, live),
  });
  assert.equal(result.verdict.state, "pass");
  assert.ok(wall >= 25_000, `wall ${wall}`);
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
