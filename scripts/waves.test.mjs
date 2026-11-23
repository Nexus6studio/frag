import assert from "node:assert/strict";
import test from "node:test";
import { ATRIUM_SPAWN, createAtriumHull } from "../src/atrium.ts";
import { restartCombat } from "../src/combat.ts";
import { createFight } from "../src/fight.ts";
import { createHitboxWorld } from "../src/hitbox.ts";
import { deathRecapText } from "../src/hud/model.ts";
import { createMoveState } from "../src/move.ts";
import { applyDamage, createPickupSim } from "../src/pickups.ts";
import { damagePlayer } from "../src/player/hurt.ts";
import { START_VITALS, createPlayerState } from "../src/player/state.ts";
import { createQuill } from "../src/quill.ts";
import { WISP_BOLT_CAP, WISP_SEPARATION, createWispSim, sphereHitsHull, wispInsideVolume } from "../src/wisp.ts";
import {
  DRONE_CAP,
  ENFORCER_CAP,
  ENFORCER_ENABLED,
  WAVE_GAP_SECONDS,
  createWaveDirector,
  formatClock,
  waveComposition,
  waveSpawnCounts,
} from "../src/waves.ts";

const DT = 1 / 120;

function step(sim, seconds, feet) {
  let t = 0;
  while (t < seconds - 1e-9) {
    sim.update(DT, feet);
    t += DT;
  }
  return t;
}

function assertSpawns(sim, hull, feet) {
  const alive = sim.drones.filter((drone) => drone.alive);
  assert.ok(alive.length > 0 && alive.length <= DRONE_CAP);
  for (const drone of alive) {
    const apart = Math.hypot(
      drone.position.x - feet.x,
      drone.position.y - feet.y,
      drone.position.z - feet.z,
    );
    assert.ok(apart >= WISP_SEPARATION, `spawn ${apart.toFixed(2)} m from the player`);
    assert.equal(wispInsideVolume(drone.position), true);
    assert.equal(sphereHitsHull(drone.position, 0.46, hull), false);
  }
}

function clearIntoNext(sim, feet) {
  const mark = sim.time;
  sim.killAlive();
  assert.equal(sim.aliveCount(), 0);
  assert.equal(sim.phase, "gap");
  step(sim, WAVE_GAP_SECONDS - 0.1, feet);
  assert.equal(sim.aliveCount(), 0, "the next wave spawned early");
  step(sim, 0.2, feet);
  const gap = sim.time - mark;
  assert.ok(gap >= WAVE_GAP_SECONDS - 0.02 && gap <= WAVE_GAP_SECONDS + 0.12, `gap ${gap}`);
  assert.equal(sim.phase, "fighting");
  assert.ok(sim.aliveCount() > 0);
}

test("wave composition caps drones at 4 and enforcers at 2", () => {
  assert.equal(ENFORCER_ENABLED, true);
  assert.deepEqual(waveComposition(1), { drones: 2, enforcers: 0 });
  assert.deepEqual(waveComposition(2), { drones: 3, enforcers: 1 });
  assert.deepEqual(waveComposition(3), { drones: 4, enforcers: 2 });
  assert.deepEqual(waveComposition(4), { drones: 4, enforcers: 2 });
  assert.deepEqual(waveComposition(12), { drones: DRONE_CAP, enforcers: ENFORCER_CAP });
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((wave) => waveSpawnCounts(wave, false)),
    [
      { drones: 2, enforcers: 0 },
      { drones: 3, enforcers: 0 },
      { drones: 4, enforcers: 0 },
      { drones: 4, enforcers: 0 },
      { drones: 4, enforcers: 0 },
    ],
  );
  assert.deepEqual(
    [1, 2, 3, 4].map((wave) => waveSpawnCounts(wave, true)),
    [
      { drones: 2, enforcers: 0 },
      { drones: 3, enforcers: 1 },
      { drones: 4, enforcers: 2 },
      { drones: 4, enforcers: 2 },
    ],
  );
  assert.equal(formatClock(0), "00:00");
  assert.equal(formatClock(65), "01:05");
  assert.equal(formatClock(599.9), "09:59");
  assert.equal(formatClock(600), "10:00");
});

test("a director never reaches a clear or win state", () => {
  for (const enabled of [false, true]) {
    const director = createWaveDirector({ enforcersEnabled: enabled });
    const seen = [];
    for (let i = 0; i < 5; i += 1) {
      seen.push(director.plan());
      director.noteEmpty();
      assert.equal(director.phase, "gap");
      director.stepGap(WAVE_GAP_SECONDS - 0.05);
      assert.equal(director.phase, "gap");
      director.stepGap(0.05);
      assert.equal(director.phase, "fighting");
      assert.equal(director.pendingSpawn, true);
      director.acknowledgeSpawn();
    }
    assert.deepEqual(
      seen,
      [1, 2, 3, 4, 5].map((wave) => waveSpawnCounts(wave, enabled)),
    );
    assert.equal(director.phase, "fighting");
    assert.equal(director.cleared, undefined);
    assert.equal(director.won, undefined);
    assert.equal(director.wavesCleared, 5);
  }
});

test("flag off clears 2, 3, 4, 4, 4 drones with a two second gap and no win", () => {
  const hull = createAtriumHull();
  const player = createPlayerState();
  const sim = createWispSim({
    hull,
    player,
    hitboxes: createHitboxWorld(),
    origin: ATRIUM_SPAWN,
    enforcersEnabled: false,
  });
  const pool = sim.drones;
  const feet = { x: ATRIUM_SPAWN.x, y: ATRIUM_SPAWN.y, z: ATRIUM_SPAWN.z };
  const seen = [];
  let maxAlive = 0;
  for (let i = 0; i < 5; i += 1) {
    maxAlive = Math.max(maxAlive, sim.aliveCount());
    seen.push({ drones: sim.aliveCount(), enforcers: sim.enforcers });
    assertSpawns(sim, hull, feet);
    assert.equal(sim.phase, "fighting");
    if (i < 4) clearIntoNext(sim, feet);
  }
  console.log(
    `waves ${seen.map((row) => `${row.drones}+${row.enforcers}`).join(", ")}, max alive ${maxAlive}`,
  );
  assert.deepEqual(seen, [
    { drones: 2, enforcers: 0 },
    { drones: 3, enforcers: 0 },
    { drones: 4, enforcers: 0 },
    { drones: 4, enforcers: 0 },
    { drones: 4, enforcers: 0 },
  ]);
  assert.ok(maxAlive <= DRONE_CAP);
  assert.equal(sim.drones, pool);
  assert.equal(sim.drones.length, DRONE_CAP);
  assert.equal(sim.bolts.length, WISP_BOLT_CAP);
  assert.equal(sim.phase, "fighting");
  assert.equal(sim.cleared, undefined);
  assert.equal(sim.won, undefined);
  assert.ok(sim.wave >= 5);
});

test("live waves are 2+0, 3+1, 4+2, 4+2 and cap at 6", () => {
  const hull = createAtriumHull();
  const player = createPlayerState({ hp: 500 });
  const fight = createFight({
    hull,
    player,
    hitboxes: createHitboxWorld(),
    origin: ATRIUM_SPAWN,
  });
  const feet = { x: ATRIUM_SPAWN.x, y: ATRIUM_SPAWN.y, z: ATRIUM_SPAWN.z };
  const seen = [];
  let maxAlive = 0;
  for (let i = 0; i < 4; i += 1) {
    const drones = fight.wisps.aliveCount();
    const enforcers = fight.enforcers.aliveCount();
    maxAlive = Math.max(maxAlive, drones + enforcers);
    seen.push({ drones, enforcers });
    assert.ok(drones <= DRONE_CAP);
    assert.ok(enforcers <= ENFORCER_CAP);
    assert.ok(drones + enforcers <= DRONE_CAP + ENFORCER_CAP);
    assertSpawns(fight.wisps, hull, feet);
    for (const unit of fight.enforcers.units) {
      if (!unit.alive) continue;
      const apart = Math.hypot(
        unit.position.x - feet.x,
        unit.position.y - feet.y,
        unit.position.z - feet.z,
      );
      assert.ok(apart >= 8, `enforcer spawn ${apart.toFixed(2)} m`);
    }
    if (i < 3) {
      const mark = fight.wisps.time;
      fight.killAll();
      assert.equal(fight.wisps.aliveCount(), 0);
      assert.equal(fight.enforcers.aliveCount(), 0);
      assert.equal(fight.wisps.phase, "gap");
      step(fight, WAVE_GAP_SECONDS - 0.1, feet);
      assert.equal(fight.wisps.aliveCount(), 0, "the next wave spawned early");
      step(fight, 0.2, feet);
      const gap = fight.wisps.time - mark;
      assert.ok(gap >= WAVE_GAP_SECONDS - 0.02 && gap <= WAVE_GAP_SECONDS + 0.12, `gap ${gap}`);
      assert.equal(fight.wisps.phase, "fighting");
    }
  }
  console.log(
    `waves ${seen.map((row) => `${row.drones}+${row.enforcers}`).join(", ")}, max alive ${maxAlive}`,
  );
  assert.deepEqual(seen, [
    { drones: 2, enforcers: 0 },
    { drones: 3, enforcers: 1 },
    { drones: 4, enforcers: 2 },
    { drones: 4, enforcers: 2 },
  ]);
  assert.ok(maxAlive <= DRONE_CAP + ENFORCER_CAP);
  assert.equal(fight.wisps.cleared, undefined);
  assert.equal(fight.wisps.won, undefined);
});

test("a player standing idle in wave 1 still has HP at 12 s and is not dead before 15 s", () => {
  const hull = createAtriumHull();
  const player = createPlayerState();
  const fight = createFight({
    hull,
    player,
    hitboxes: createHitboxWorld(),
    origin: ATRIUM_SPAWN,
  });
  const feet = { x: ATRIUM_SPAWN.x, y: ATRIUM_SPAWN.y, z: ATRIUM_SPAWN.z };
  assert.equal(fight.wisps.wave, 1);
  assert.equal(fight.wisps.aliveCount(), 2);
  assert.equal(fight.enforcers.aliveCount(), 0);
  let t = 0;
  let hpAt12 = null;
  while (t < 15 - 1e-9) {
    fight.update(DT, feet);
    t += DT;
    const hp = player.get().hp;
    if (hpAt12 == null && t + 1e-9 >= 12) hpAt12 = hp;
    assert.ok(hp > 0, `dead at ${t.toFixed(3)} s`);
  }
  assert.ok(hpAt12 > 0, `hp at 12 s is ${hpAt12}`);
  assert.equal(fight.wisps.wave, 1);
  assert.equal(fight.enforcers.aliveCount(), 0);
  console.log(`wave 1 idle hp at 12 s ${hpAt12}, at 15 s ${player.get().hp}`);
});

test("death recap matches a scripted fight and further hits do nothing", () => {
  const hull = createAtriumHull();
  // Extra HP so in-flight bolts cannot end the run before the scripted fatal hit.
  const player = createPlayerState({ hp: 500 });
  const sim = createWispSim({
    hull,
    player,
    hitboxes: createHitboxWorld(),
    origin: ATRIUM_SPAWN,
  });
  const feet = { x: ATRIUM_SPAWN.x, y: ATRIUM_SPAWN.y, z: ATRIUM_SPAWN.z };
  while (sim.timeAlive < 1) sim.update(DT, feet);
  sim.killAlive();
  assert.equal(sim.frags, 2);
  assert.equal(sim.wavesCleared, 1);
  clearIntoNext(sim, feet);
  assert.equal(sim.wave, 2);
  assert.equal(sim.aliveCount(), 3);
  while (sim.timeAlive < 4) sim.update(DT, feet);
  const victim = sim.drones.find((drone) => drone.alive);
  sim.hurt(victim.index, 1000);
  assert.equal(sim.frags, 3);
  assert.equal(sim.wavesCleared, 1);
  assert.equal(sim.aliveCount(), 2);

  const fatal = applyDamage(10_000, player.get().hp, player.get().armor);
  player.set({ hp: fatal.hp, armor: fatal.armor });
  const recap = sim.recap();
  assert.equal(player.get().hp, 0);
  assert.equal(recap.wavesCleared, 1);
  assert.equal(recap.frags, 3);
  assert.ok(recap.timeAlive >= 4 && recap.timeAlive < 5, `time ${recap.timeAlive}`);
  assert.equal(deathRecapText(recap), `waves 1\nfrags 3\n${formatClock(recap.timeAlive)}\nclick to restart`);
  assert.equal(formatClock(recap.timeAlive), "00:04");

  const frozen = recap.timeAlive;
  const armor = player.get().armor;
  step(sim, 3, feet);
  damagePlayer(player, 30);
  assert.equal(player.get().hp, 0);
  assert.equal(player.get().armor, armor);
  assert.equal(sim.timeAlive, frozen);
  assert.equal(sim.wavesCleared, 1);
  assert.equal(sim.wave, 2);
});

test("restart returns spawn vitals, wave 1, and an empty battlefield", () => {
  const hull = createAtriumHull();
  const player = createPlayerState();
  const hitboxes = createHitboxWorld();
  const quill = createQuill({ hull, player, hitboxes });
  const pickups = createPickupSim(quill);
  const sim = createWispSim({ hull, player, hitboxes, origin: ATRIUM_SPAWN, enforcersEnabled: false });
  const pool = sim.drones;
  const bolts = sim.bolts;
  const feet = { x: ATRIUM_SPAWN.x, y: ATRIUM_SPAWN.y, z: ATRIUM_SPAWN.z };
  const idle = {
    fire: false,
    reload: false,
    origin: { x: feet.x, y: feet.y + 1.4, z: feet.z },
    direction: { x: 0, y: 0, z: -1 },
  };
  quill.update(0, { ...idle, fire: true });
  quill.update(0.2, idle);
  assert.ok(quill.mag < 40 || quill.liveCount > 0);

  player.set({ hp: 50 });
  const health = pickups.pads.find((pad) => pad.kind === "health");
  pickups.step(0, { x: health.x, y: health.y, z: health.z }, player);
  assert.ok(health.cooldown > 0);

  step(sim, 0.5, { x: 0, y: ATRIUM_SPAWN.y, z: 0 });
  sim.hurt(0, 1000);
  assert.ok(sim.sparks.some((slot) => slot.alive) || sim.frags > 0);
  player.set({ hp: 0, armor: 15 });

  const body = createMoveState(ATRIUM_SPAWN);
  restartCombat({
    player,
    quill,
    pickups,
    wisps: sim,
    origin: ATRIUM_SPAWN,
  });

  assert.deepEqual(player.get(), START_VITALS);
  assert.deepEqual(body.position, ATRIUM_SPAWN);
  assert.equal(quill.mag, 40);
  assert.equal(quill.reserve, 40);
  assert.equal(quill.liveCount, 0);
  assert.ok(pickups.pads.every((pad) => pad.cooldown === 0));
  assert.equal(sim.wave, 1);
  assert.equal(sim.aliveCount(), 2);
  assert.equal(sim.enforcers, 0);
  assert.equal(sim.frags, 0);
  assert.equal(sim.wavesCleared, 0);
  assert.equal(sim.timeAlive, 0);
  assert.equal(sim.phase, "fighting");
  assert.equal(sim.drones, pool);
  assert.equal(sim.bolts, bolts);
  assert.ok(sim.bolts.every((bolt) => bolt.alive === false));
  assert.ok(sim.sparks.every((slot) => slot.alive === false));
  assert.ok(sim.gibs.every((slot) => slot.alive === false));
  assert.ok(sim.fluid.every((slot) => slot.alive === false));
  assertSpawns(sim, hull, ATRIUM_SPAWN);
  quill.update(DT, idle);
  assert.equal(player.get().hp, 100);
  assert.equal(player.get().armor, 0);
  assert.equal(player.get().mag, 40);
  assert.equal(player.get().reserve, 40);
});
