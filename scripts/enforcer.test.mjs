import assert from "node:assert/strict";
import test from "node:test";
import {
  ATRIUM_SPAWN,
  CATWALK_Y,
  CONCOURSE,
  GROUND_Y,
  JUMP_LANE_HALF,
  RING_INNER,
  capsuleClear,
  createAtriumHull,
  inJumpSlot,
} from "../src/atrium.ts";
import { createFight } from "../src/fight.ts";
import { createHitboxWorld } from "../src/hitbox.ts";
import { createPlayerState } from "../src/player/state.ts";
import { createQuill } from "../src/quill.ts";
import {
  ENFORCER_ARMOR,
  ENFORCER_DAMAGE,
  ENFORCER_GRACE,
  ENFORCER_HP,
  ENFORCER_INTERVAL,
  ENFORCER_RANGE,
  ENFORCER_SEPARATION,
  ENFORCER_SPEED,
  createEnforcerSim,
  enforcerInsideVolume,
} from "../src/enforcer.ts";
import { WAVE_GAP_SECONDS } from "../src/waves.ts";
import { HIT_FLASH_SECONDS } from "../src/feel.ts";

const DT = 1 / 120;

function step(sim, seconds, feet) {
  let t = 0;
  while (t < seconds - 1e-9) {
    sim.update(DT, feet);
    t += DT;
  }
}

function openHull() {
  return {
    boxes: [{ min: { x: -40, y: -1, z: -40 }, max: { x: 40, y: 0, z: 40 } }],
    ramps: [],
  };
}

test("an enforcer climbs a ramp to the player and skirts the well", () => {
  const hull = createAtriumHull();
  const player = createPlayerState({ hp: 5000 });
  const feet = { x: 0, y: CATWALK_Y, z: -14.6 };
  const sim = createEnforcerSim({ hull, player, hitboxes: createHitboxWorld() });
  sim.place(0, { x: 0, y: GROUND_Y, z: -7.2 });
  let dipped = false;
  let t = 0;
  while (t < 40) {
    sim.update(DT, feet);
    const pos = sim.units[0].position;
    if (Math.abs(pos.x) < 5.2 && Math.abs(pos.z) < 5.2 && pos.y < 0.45) dipped = true;
    assert.equal(enforcerInsideVolume(pos), true, `left the atrium at ${pos.x} ${pos.y} ${pos.z}`);
    const along = Math.hypot(pos.x - feet.x, pos.z - feet.z);
    if (pos.y > 4.8 && along < 8.5) break;
    t += DT;
  }
  const pos = sim.units[0].position;
  console.log(
    `enforcer ramp arrival ${pos.x.toFixed(2)} ${pos.y.toFixed(2)} ${pos.z.toFixed(2)} in ${t.toFixed(1)} s`,
  );
  assert.equal(dipped, false, "fell in the well");
  assert.ok(pos.y > 4.8, `never climbed (y ${pos.y})`);
  assert.ok(Math.hypot(pos.x - feet.x, pos.z - feet.z) < 8.5, "did not close on the catwalk");
  assert.equal(sim.units[0].alive, true);

  const skirt = createEnforcerSim({ hull, player, hitboxes: createHitboxWorld() });
  skirt.place(0, { x: 0, y: GROUND_Y, z: 8.2 });
  const north = { x: 0, y: GROUND_Y, z: -7.2 };
  dipped = false;
  t = 0;
  while (t < 25) {
    skirt.update(DT, north);
    const pos = skirt.units[0].position;
    if (Math.abs(pos.x) < 5.2 && Math.abs(pos.z) < 5.2 && pos.y < 0.45) dipped = true;
    assert.equal(enforcerInsideVolume(pos), true);
    if (Math.hypot(pos.x - north.x, pos.z - north.z) < 8.5 && pos.y < 1.6) break;
    t += DT;
  }
  const arrived = skirt.units[0].position;
  console.log(
    `enforcer well skirt ${arrived.x.toFixed(2)} ${arrived.y.toFixed(2)} ${arrived.z.toFixed(2)} in ${t.toFixed(1)} s`,
  );
  assert.equal(dipped, false, "cut through the well");
  assert.ok(Math.hypot(arrived.x - north.x, arrived.z - north.z) < 8.5, "stuck on the ring");
  assert.ok(arrived.y < 1.6, `left the ground ring (y ${arrived.y})`);
});

test("an enforcer pathing the catwalk past a jump slot stays at catwalk height", () => {
  const hull = createAtriumHull();
  const player = createPlayerState({ hp: 5000 });
  for (const side of [1, -1]) {
    const sim = createEnforcerSim({ hull, player, hitboxes: createHitboxWorld(), grace: 0 });
    const x = 14.45 * side;
    sim.place(0, { x, y: CATWALK_Y, z: 8 });
    const goal = { x, y: CATWALK_Y, z: -14 };
    let minY = CATWALK_Y;
    let entered = false;
    let passed = false;
    for (let i = 0; i < Math.round(16 / DT); i += 1) {
      sim.update(DT, goal);
      const pos = sim.units[0].position;
      if (pos.y < minY) minY = pos.y;
      if (inJumpSlot(pos.x, pos.z)) entered = true;
      if (pos.z < -2 && pos.y > CATWALK_Y - 0.2) passed = true;
      assert.equal(enforcerInsideVolume(pos), true);
    }
    assert.equal(passed, true, `side ${side} did not pass the slot`);
    assert.ok(minY >= CATWALK_Y - 0.2, `side ${side} dropped to ${minY.toFixed(2)}`);
    assert.equal(entered, false, `side ${side} entered the jump slot`);
    console.log(`enforcer slot pass side ${side} min y ${minY.toFixed(2)}`);

    const bait = createEnforcerSim({ hull, player, hitboxes: createHitboxWorld(), grace: 0 });
    bait.place(0, { x: side * (RING_INNER + 0.45), y: CATWALK_Y, z: 0 });
    bait.hurt(0, 25);
    const shelf = { x: side * (CONCOURSE + 0.4), y: CATWALK_Y, z: 0 };
    let baitMin = CATWALK_Y;
    let baitEntered = false;
    for (let i = 0; i < Math.round(2 / DT); i += 1) {
      bait.update(DT, shelf);
      const pos = bait.units[0].position;
      if (pos.y < baitMin) baitMin = pos.y;
      if (inJumpSlot(pos.x, pos.z)) baitEntered = true;
    }
    assert.ok(baitMin >= CATWALK_Y - 0.2, `side ${side} sidestep dropped to ${baitMin.toFixed(2)}`);
    assert.equal(baitEntered, false, `side ${side} sidestep entered the slot`);
    assert.ok(Math.abs(shelf.z) <= JUMP_LANE_HALF);
  }
});

test("cruise speed is 4.2 m/s and the body does not jump", () => {
  const player = createPlayerState({ hp: 500 });
  const sim = createEnforcerSim({
    hull: openHull(),
    player,
    hitboxes: createHitboxWorld(),
    grace: 2,
  });
  sim.place(0, { x: 0, y: 0, z: 0 });
  const goal = { x: 0, y: 0, z: -30 };
  step(sim, 1.5, goal);
  const mid = sim.units[0].position.z;
  step(sim, 0.5, goal);
  const end = sim.units[0].position;
  const speed = Math.abs(end.z - mid) / 0.5;
  console.log(`enforcer cruise ${speed.toFixed(2)} m/s, y ${end.y.toFixed(2)}`);
  assert.ok(Math.abs(speed - ENFORCER_SPEED) < 0.25, `speed ${speed}`);
  assert.ok(end.y < 0.15, `jumped to ${end.y}`);
});

test("eleven flechettes kill an enforcer and ten leave it alive", () => {
  const hull = createAtriumHull();
  const player = createPlayerState();
  const hitboxes = createHitboxWorld();
  const sim = createEnforcerSim({ hull, player, hitboxes, grace: 0 });
  sim.place(0, { x: 0, y: GROUND_Y, z: -6 });
  const unit = sim.units[0];
  assert.equal(unit.hp, ENFORCER_HP);
  assert.equal(unit.armor, ENFORCER_ARMOR);
  const quill = createQuill({ hull, hitboxes, player });
  const fire = {
    fire: true,
    reload: false,
    origin: { x: 0, y: GROUND_Y + 0.95, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
  };
  const idle = { ...fire, fire: false };
  const shoot = () => {
    const before = unit.hp;
    quill.update(0, fire);
    quill.update(0, idle);
    let t = 0;
    while (unit.hp === before && unit.alive && t < 0.4) {
      quill.update(DT, idle);
      t += DT;
    }
  };
  const table = [];
  shoot();
  table.push({ hp: unit.hp, armor: unit.armor });
  assert.deepEqual(table[0], { hp: 77, armor: 9 });
  shoot();
  assert.deepEqual({ hp: unit.hp, armor: unit.armor }, { hp: 74, armor: 3 });
  shoot();
  assert.deepEqual({ hp: unit.hp, armor: unit.armor }, { hp: 68, armor: 0 });
  for (let i = 0; i < 7; i += 1) shoot();
  assert.equal(unit.hp, 5, "10 flechettes should leave 5 HP");
  assert.equal(unit.alive, true);
  shoot();
  assert.equal(unit.hp, 0);
  assert.equal(unit.alive, false);
  assert.ok(sim.sparks.some((slot) => slot.alive), "death did not emit sparks");
  const after = unit.hp;
  shoot();
  assert.equal(unit.hp, after, "a dead enforcer still took a flechette");
});

test("the stun-blaster hits inside 12 m, stops at range, and stops on atrium walls", () => {
  const hull = createAtriumHull();
  const player = createPlayerState();
  const hitboxes = createHitboxWorld();
  const sim = createEnforcerSim({ hull, player, hitboxes, grace: 0 });
  sim.place(0, { x: 0, y: GROUND_Y, z: 8.2 });
  const near = { x: 6, y: GROUND_Y, z: 8.2 };
  step(sim, 0.05, near);
  assert.equal(player.get().hp, 100 - ENFORCER_DAMAGE);
  assert.equal(sim.shotCount(), 1);
  assert.ok(sim.flashes.some((flash) => flash.alive), "the shot had no tracer");
  assert.ok(sim.shotTime(0) < 0.05);

  player.set({ hp: 100, armor: 15 });
  const armored = createEnforcerSim({ hull, player, hitboxes: createHitboxWorld(), grace: 0 });
  armored.place(0, { x: 0, y: GROUND_Y, z: 8.2 });
  step(armored, 0.05, near);
  assert.equal(player.get().hp, 96, "armor did not absorb floor(12·2/3)");
  assert.equal(player.get().armor, 7);

  player.set({ hp: 100, armor: 25 });
  const plated = createEnforcerSim({ hull, player, hitboxes: createHitboxWorld(), grace: 0 });
  plated.place(0, { x: 0, y: GROUND_Y, z: 8.2 });
  step(plated, 0.05, near);
  assert.equal(player.get().hp, 96, "25 armor should lose 4 HP to a 12 blast");
  assert.equal(player.get().armor, 17);

  player.set({ hp: 100, armor: 0 });
  const far = createEnforcerSim({ hull, player, hitboxes: createHitboxWorld(), grace: 0 });
  far.place(0, { x: 0, y: GROUND_Y, z: 8.2 });
  step(far, 0.05, { x: 0, y: GROUND_Y, z: 8.2 - (ENFORCER_RANGE + 2) });
  assert.equal(player.get().hp, 100, "a shot landed past 12 m");
  assert.equal(far.shotCount(), 0);

  const walled = {
    boxes: [
      { min: { x: -30, y: -1, z: -30 }, max: { x: 30, y: 0, z: 30 } },
      { min: { x: -1.5, y: 0, z: 2.2 }, max: { x: 1.5, y: 3, z: 2.7 } },
    ],
    ramps: [],
  };
  const blocked = createPlayerState();
  const behind = createEnforcerSim({ hull: walled, player: blocked, hitboxes: createHitboxWorld(), grace: 0 });
  behind.place(0, { x: 0, y: 0, z: 0 });
  step(behind, 0.2, { x: 0, y: 0, z: 6 });
  assert.equal(blocked.get().hp, 100, "the blast passed through a wall");
  assert.equal(behind.shotCount(), 0);

  const pillar = createPlayerState();
  const atriumShot = createEnforcerSim({ hull, player: pillar, hitboxes: createHitboxWorld(), grace: 0 });
  atriumShot.place(0, { x: 8.6, y: GROUND_Y, z: 6.05 });
  step(atriumShot, 0.2, { x: 3.4, y: GROUND_Y, z: 6.05 });
  assert.equal(pillar.get().hp, 100, "the blast passed an atrium pillar");

  const paced = createPlayerState({ hp: 500 });
  const cadence = createEnforcerSim({
    hull: openHull(),
    player: paced,
    hitboxes: createHitboxWorld(),
    grace: 0,
  });
  cadence.place(0, { x: 0, y: 0, z: 0 });
  step(cadence, 2, { x: 0, y: 0, z: -6 });
  assert.ok(cadence.shotCount() >= 3, `shots ${cadence.shotCount()}`);
  const gap = cadence.shotTime(1) - cadence.shotTime(0);
  assert.ok(Math.abs(gap - ENFORCER_INTERVAL) < 0.03, `interval ${gap}`);
});

test("25 damage inside 1 s sidesteps, then the enforcer pushes again", () => {
  const hull = openHull();
  const quiet = createPlayerState({ hp: 500 });
  const hold = createEnforcerSim({ hull, player: quiet, hitboxes: createHitboxWorld() });
  hold.place(0, { x: 0, y: 0, z: 0 });
  const goal = { x: 0, y: 0, z: -12 };
  hold.hurt(0, 24);
  step(hold, 0.6, goal);
  assert.ok(hold.units[0].position.z < -1, "24 damage sidestepped instead of pushing");
  assert.ok(Math.abs(hold.units[0].position.x) < 0.35, `24 damage strafed to x ${hold.units[0].position.x}`);

  const player = createPlayerState({ hp: 500 });
  const sim = createEnforcerSim({ hull, player, hitboxes: createHitboxWorld() });
  sim.place(0, { x: 0, y: 0, z: 0 });
  sim.hurt(0, 13);
  step(sim, 0.4, goal);
  sim.hurt(0, 13);
  assert.ok(sim.units[0].sidestep > 0.5, "26 damage inside the window did not sidestep");
  const mark = { x: sim.units[0].position.x, z: sim.units[0].position.z };
  step(sim, 0.5, goal);
  const dx = Math.abs(sim.units[0].position.x - mark.x);
  const dz = Math.abs(sim.units[0].position.z - mark.z);
  console.log(`enforcer sidestep dx ${dx.toFixed(2)} dz ${dz.toFixed(2)}`);
  assert.ok(dx > 0.7, `lateral ${dx}`);
  assert.ok(dx > dz, "the sidestep was mostly forward");

  const resume = createEnforcerSim({ hull, player, hitboxes: createHitboxWorld() });
  resume.place(0, { x: 0, y: 0, z: 0 });
  resume.hurt(0, 25);
  step(resume, 1.05, goal);
  const afterSide = resume.units[0].position.z;
  step(resume, 0.7, goal);
  assert.ok(resume.units[0].position.z < afterSide - 0.8, "did not push after the sidestep");

  const stale = createEnforcerSim({ hull, player, hitboxes: createHitboxWorld() });
  stale.place(0, { x: 0, y: 0, z: 0 });
  stale.hurt(0, 20);
  step(stale, 1.15, goal);
  const before = stale.units[0].position.z;
  stale.hurt(0, 20);
  step(stale, 0.4, goal);
  assert.ok(stale.units[0].position.z < before - 0.4, "an expired window still sidestepped");
});

test("spawns stay inside the atrium and at least 8 m from the player", () => {
  const hull = createAtriumHull();
  const player = createPlayerState();
  const fight = createFight({
    hull,
    player,
    hitboxes: createHitboxWorld(),
    origin: ATRIUM_SPAWN,
  });
  assert.equal(fight.enforcers.aliveCount(), 0);
  assert.equal(fight.wisps.aliveCount(), 2);
  const pool = fight.enforcers.units;
  const sparks = fight.enforcers.sparks;
  fight.killAll();
  fight.update(2, ATRIUM_SPAWN);
  assert.equal(fight.wisps.wave, 2);
  assert.equal(fight.wisps.aliveCount(), 3);
  assert.equal(fight.enforcers.aliveCount(), 1);
  for (const unit of fight.enforcers.units) {
    if (!unit.alive) continue;
    const apart = Math.hypot(
      unit.position.x - ATRIUM_SPAWN.x,
      unit.position.y - ATRIUM_SPAWN.y,
      unit.position.z - ATRIUM_SPAWN.z,
    );
    console.log(
      `enforcer spawn ${unit.position.x.toFixed(2)} ${unit.position.y.toFixed(2)} ${unit.position.z.toFixed(2)} dist ${apart.toFixed(2)}`,
    );
    assert.ok(apart >= ENFORCER_SEPARATION, `spawn distance ${apart}`);
    assert.equal(enforcerInsideVolume(unit.position), true);
    assert.equal(capsuleClear(unit.position, hull), true);
    assert.equal(unit.hp, ENFORCER_HP);
    assert.equal(unit.armor, ENFORCER_ARMOR);
  }
  assert.equal(fight.enforcers.units, pool);
  assert.equal(fight.enforcers.sparks, sparks);
  fight.wisps.restart(ATRIUM_SPAWN);
  assert.equal(fight.wisps.wave, 1);
  assert.equal(fight.wisps.aliveCount(), 2);
  assert.equal(fight.enforcers.aliveCount(), 0);
  assert.ok(fight.enforcers.sparks.every((slot) => slot.alive === false));
  assert.equal(fight.enforcers.units, pool);
});

test("the enforcer waits 2 s after start, restart, and each new wave", () => {
  const player = createPlayerState({ hp: 800 });
  const sim = createEnforcerSim({
    hull: openHull(),
    player,
    hitboxes: createHitboxWorld(),
  });
  sim.place(0, { x: 0, y: 0, z: 0 });
  assert.equal(sim.units[0].grace, ENFORCER_GRACE);
  const front = { x: 0, y: 0, z: -6 };
  step(sim, ENFORCER_GRACE - 0.05, front);
  assert.equal(sim.shotCount(), 0, "fired during the spawn grace");
  assert.ok(sim.units[0].grace > 0);
  step(sim, 0.15, front);
  assert.ok(sim.shotCount() >= 1, "did not fire once grace ended");
  assert.ok(sim.shotTime(0) >= ENFORCER_GRACE - DT, `first shot at ${sim.shotTime(0)}`);

  const hull = createAtriumHull();
  const hero = createPlayerState({ hp: 5000 });
  const fight = createFight({
    hull,
    player: hero,
    hitboxes: createHitboxWorld(),
    origin: ATRIUM_SPAWN,
  });
  const armed = () => fight.enforcers.units.filter((unit) => unit.alive);
  assert.equal(armed().length, 0, "wave 1 fields an enforcer");

  function reachWave2() {
    fight.killAll();
    let gap = 0;
    while (fight.wisps.wave === 1 && gap < WAVE_GAP_SECONDS + 0.5) {
      fight.update(DT, ATRIUM_SPAWN);
      gap += DT;
    }
    assert.equal(fight.wisps.wave, 2);
    assert.ok(gap >= WAVE_GAP_SECONDS - DT, `wave 2 arrived early at ${gap.toFixed(3)} s`);
    assert.equal(armed().length, 1);
    assert.ok(armed().every((unit) => unit.grace > ENFORCER_GRACE - 0.02 && unit.grace <= ENFORCER_GRACE));
  }

  reachWave2();
  const shotsAtWave = fight.enforcers.shotCount();
  step(fight, 1.5, ATRIUM_SPAWN);
  assert.equal(fight.enforcers.shotCount(), shotsAtWave, "wave 2 fired during grace");
  assert.ok(armed().every((unit) => unit.grace > 0.4));

  fight.wisps.restart(ATRIUM_SPAWN);
  assert.equal(fight.wisps.wave, 1);
  assert.equal(armed().length, 0, "restart armed a wave 1 enforcer");
  reachWave2();
  const shotsAtRestart = fight.enforcers.shotCount();
  step(fight, 1.5, ATRIUM_SPAWN);
  assert.equal(fight.enforcers.shotCount(), shotsAtRestart, "restart fired during grace");
});

test("a hit and a kill flash the enforcer for 60 ms", () => {
  const sim = createEnforcerSim({
    hull: openHull(),
    player: createPlayerState(),
    hitboxes: createHitboxWorld(),
  });
  sim.place(0, { x: 0, y: 0, z: 0 });
  assert.equal(sim.units[0].hitFlash, 0);
  sim.hurt(0, 9);
  assert.equal(sim.units[0].alive, true);
  assert.equal(sim.units[0].hitFlash, HIT_FLASH_SECONDS);
  sim.tickFlash(0.03);
  assert.ok(Math.abs(sim.units[0].hitFlash - (HIT_FLASH_SECONDS - 0.03)) < 1e-9);
  sim.hurt(0, ENFORCER_HP + ENFORCER_ARMOR);
  assert.equal(sim.units[0].alive, false);
  assert.equal(sim.units[0].hitFlash, HIT_FLASH_SECONDS);
});
