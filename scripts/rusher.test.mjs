import assert from "node:assert/strict";
import test from "node:test";
import {
  ATRIUM_SPAWN,
  CATWALK_Y,
  GROUND_Y,
  capsuleClear,
  createAtriumHull,
} from "../src/atrium.ts";
import { createFight } from "../src/fight.ts";
import { GORE_GIBS_PER_DEATH, GORE_SPRAY_PER_DEATH } from "../src/gore.ts";
import { createHitboxWorld } from "../src/hitbox.ts";
import { createPlayerState } from "../src/player/state.ts";
import { QUILL_BURST, QUILL_CHARGE, QUILL_DAMAGE, createQuill } from "../src/quill.ts";
import {
  RUSHER_ARMOR,
  RUSHER_COOLDOWN,
  RUSHER_DAMAGE,
  RUSHER_GRACE,
  RUSHER_HP,
  RUSHER_RANGE,
  RUSHER_SEPARATION,
  RUSHER_SPEED,
  RUSHER_TELEGRAPH,
  createRusherSim,
  rusherInsideVolume,
} from "../src/rusher.ts";
import { RUSHER_CAP, WAVE_GAP_SECONDS } from "../src/waves.ts";

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

test("four primary flechettes kill a rusher and three leave it alive", () => {
  const hull = createAtriumHull();
  const player = createPlayerState();
  const hitboxes = createHitboxWorld();
  const sim = createRusherSim({ hull, player, hitboxes, grace: 0 });
  sim.place(0, { x: 0, y: GROUND_Y, z: -6 });
  const unit = sim.units[0];
  assert.equal(unit.hp, RUSHER_HP);
  assert.equal(unit.armor, RUSHER_ARMOR);
  const quill = createQuill({ hull, hitboxes, player });
  const fire = {
    fire: true,
    reload: false,
    origin: { x: 0, y: GROUND_Y + 0.9, z: 0 },
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
  shoot();
  assert.equal(unit.hp, RUSHER_HP - QUILL_DAMAGE);
  assert.equal(unit.alive, true);
  shoot();
  shoot();
  assert.equal(unit.hp, RUSHER_HP - 3 * QUILL_DAMAGE);
  assert.equal(unit.alive, true, "three primary hits killed a 35 HP rusher");
  shoot();
  assert.equal(unit.hp, 0);
  assert.equal(unit.alive, false);
  assert.ok(sim.spray.some((slot) => slot.alive), "death did not spray blood");
  assert.equal(
    sim.spray.filter((slot) => slot.alive).length,
    GORE_SPRAY_PER_DEATH,
  );
  assert.equal(
    sim.gibs.filter((slot) => slot.alive).length,
    GORE_GIBS_PER_DEATH,
  );
  const after = unit.hp;
  shoot();
  assert.equal(unit.hp, after, "a dead rusher still took a flechette");
});

test("one current alt-fire burst of 9-damage flechettes leaves a rusher alive", () => {
  const hull = openHull();
  const player = createPlayerState();
  const hitboxes = createHitboxWorld();
  const sim = createRusherSim({ hull, player, hitboxes, grace: 0 });
  sim.place(0, { x: 0, y: 0, z: -4 });
  const origin = { x: 0, y: 0.9, z: 0 };
  const direction = { x: 0, y: 0, z: -1 };
  const quill = createQuill({ hull, hitboxes, player });
  const hold = { fire: false, presses: 0, reload: false, alt: true, origin, direction };
  quill.update(QUILL_CHARGE, hold);
  assert.equal(quill.shotsFired, QUILL_BURST);
  quill.update(0.4, { ...hold, alt: false });
  const burst = QUILL_BURST * QUILL_DAMAGE;
  assert.equal(sim.units[0].hp, RUSHER_HP - burst);
  assert.equal(sim.units[0].alive, true, "one alt-fire burst killed a rusher");
});

test("a rusher lunges only inside 2.2 m, after a 0.25 s telegraph, then waits 0.85 s", () => {
  const hull = openHull();
  const player = createPlayerState();
  const far = { x: 0, y: 0, z: -(RUSHER_RANGE + 0.35) };
  const sim = createRusherSim({ hull, player, hitboxes: createHitboxWorld(), grace: 0 });
  sim.place(0, { x: 0, y: 0, z: 0 });
  step(sim, 0.2, far);
  assert.equal(sim.units[0].phase, "hunt", "telegraph started outside melee range");
  assert.equal(player.get().hp, 100);
  assert.equal(sim.lungeCount(), 0);

  const close = createPlayerState();
  const melee = createRusherSim({ hull, player: close, hitboxes: createHitboxWorld(), grace: 0 });
  melee.place(0, { x: 0, y: 0, z: 0 });
  const feet = { x: 0, y: 0, z: -1.2 };
  step(melee, RUSHER_TELEGRAPH - 0.02, feet);
  assert.equal(melee.units[0].phase, "telegraph");
  assert.equal(close.get().hp, 100, "the telegraph dealt damage");
  assert.equal(melee.lungeCount(), 0);
  step(melee, 0.04, feet);
  assert.equal(melee.lungeCount(), 1);
  assert.equal(close.get().hp, 100 - RUSHER_DAMAGE);
  assert.equal(melee.units[0].phase, "lunge");
  assert.ok(melee.trails.some((slot) => slot.alive), "the lunge had no trail");
  const first = melee.lungeTime(0);
  assert.ok(first >= RUSHER_TELEGRAPH - DT, `lunge at ${first}`);

  step(melee, RUSHER_COOLDOWN, feet);
  assert.equal(melee.lungeCount(), 1, "cooldown ignored");
  step(melee, RUSHER_TELEGRAPH + 0.2, feet);
  assert.equal(melee.lungeCount(), 2);
  const gap = melee.lungeTime(1) - melee.lungeTime(0);
  assert.ok(gap >= RUSHER_LUNGE_GAP(), `lunges ${gap.toFixed(3)} s apart`);
});

function RUSHER_LUNGE_GAP() {
  return RUSHER_COOLDOWN + RUSHER_TELEGRAPH - 0.05;
}

test("spawn grace blocks the lunge for 2 s", () => {
  const hull = openHull();
  const player = createPlayerState();
  const sim = createRusherSim({ hull, player, hitboxes: createHitboxWorld() });
  sim.place(0, { x: 0, y: 0, z: 0 });
  assert.equal(sim.units[0].grace, RUSHER_GRACE);
  const feet = { x: 0, y: 0, z: -1 };
  step(sim, RUSHER_GRACE - 0.05, feet);
  assert.equal(sim.lungeCount(), 0, "lunged during spawn grace");
  assert.equal(player.get().hp, 100);
  assert.ok(sim.units[0].grace > 0);
  assert.equal(sim.units[0].phase, "hunt");
  step(sim, RUSHER_TELEGRAPH + 0.12, feet);
  assert.equal(sim.lungeCount(), 1, "did not lunge once grace ended");
  assert.ok(sim.lungeTime(0) >= RUSHER_GRACE + RUSHER_TELEGRAPH - 0.05);
});

test("a rusher walks at 6.4 m/s, climbs a ramp, and skirts the well", () => {
  const hull = openHull();
  const player = createPlayerState({ hp: 5000 });
  const sim = createRusherSim({ hull, player, hitboxes: createHitboxWorld(), grace: 0 });
  sim.place(0, { x: 0, y: 0, z: 0 });
  const goal = { x: 0, y: 0, z: -30 };
  step(sim, 1, goal);
  const mid = sim.units[0].position.z;
  step(sim, 0.5, goal);
  const end = sim.units[0].position;
  const speed = Math.abs(end.z - mid) / 0.5;
  console.log(`rusher cruise ${speed.toFixed(2)} m/s, y ${end.y.toFixed(2)}`);
  assert.ok(Math.abs(speed - RUSHER_SPEED) < 0.35, `speed ${speed}`);
  assert.ok(end.y < 0.15, `left the floor at ${end.y}`);

  const atrium = createAtriumHull();
  const climber = createRusherSim({
    hull: atrium,
    player: createPlayerState({ hp: 5000 }),
    hitboxes: createHitboxWorld(),
    grace: 0,
  });
  const feet = { x: 0, y: CATWALK_Y, z: -14.6 };
  climber.place(0, { x: 0, y: GROUND_Y, z: -7.2 });
  let dipped = false;
  let t = 0;
  while (t < 30) {
    climber.update(DT, feet);
    const pos = climber.units[0].position;
    if (Math.abs(pos.x) < 5.2 && Math.abs(pos.z) < 5.2 && pos.y < 0.45) dipped = true;
    assert.equal(rusherInsideVolume(pos), true, `left the atrium at ${pos.x} ${pos.y} ${pos.z}`);
    const along = Math.hypot(pos.x - feet.x, pos.z - feet.z);
    if (pos.y > 4.8 && along < 8.5) break;
    t += DT;
  }
  const pos = climber.units[0].position;
  console.log(
    `rusher ramp arrival ${pos.x.toFixed(2)} ${pos.y.toFixed(2)} ${pos.z.toFixed(2)} in ${t.toFixed(1)} s`,
  );
  assert.equal(dipped, false, "fell in the well");
  assert.ok(pos.y > 4.8, `never climbed (y ${pos.y})`);
  assert.ok(Math.hypot(pos.x - feet.x, pos.z - feet.z) < 8.5, "did not close on the catwalk");
  assert.equal(capsuleClear(pos, atrium), true);

  const skirt = createRusherSim({
    hull: atrium,
    player: createPlayerState({ hp: 5000 }),
    hitboxes: createHitboxWorld(),
    grace: 0,
  });
  skirt.place(0, { x: 0, y: GROUND_Y, z: 8.2 });
  const north = { x: 0, y: GROUND_Y, z: -7.2 };
  dipped = false;
  t = 0;
  while (t < 20) {
    skirt.update(DT, north);
    const at = skirt.units[0].position;
    if (Math.abs(at.x) < 5.2 && Math.abs(at.z) < 5.2 && at.y < 0.45) dipped = true;
    if (Math.hypot(at.x - north.x, at.z - north.z) < 2.4) break;
    t += DT;
  }
  assert.equal(dipped, false, "cut across the well");
  assert.ok(Math.hypot(skirt.units[0].position.x - north.x, skirt.units[0].position.z - north.z) < 2.4);
});

test("waves field one rusher from wave 2 and two from wave 4, with a 2 s grace", () => {
  const hull = createAtriumHull();
  const player = createPlayerState({ hp: 5000 });
  const fight = createFight({
    hull,
    player,
    hitboxes: createHitboxWorld(),
    origin: ATRIUM_SPAWN,
  });
  const feet = { x: ATRIUM_SPAWN.x, y: ATRIUM_SPAWN.y, z: ATRIUM_SPAWN.z };
  assert.equal(fight.rushers.aliveCount(), 0, "wave 1 fields a rusher");
  assert.ok(fight.rushers.units.length <= RUSHER_CAP);

  function clearWave() {
    fight.killAll();
    let gap = 0;
    const wave = fight.wisps.wave;
    while (fight.wisps.wave === wave && gap < WAVE_GAP_SECONDS + 0.5) {
      fight.update(DT, feet);
      gap += DT;
    }
    assert.ok(gap >= WAVE_GAP_SECONDS - DT, `wave advanced early at ${gap.toFixed(3)} s`);
  }

  clearWave();
  assert.equal(fight.wisps.wave, 2);
  assert.equal(fight.rushers.aliveCount(), 1);
  const armed = fight.rushers.units.filter((unit) => unit.alive);
  assert.ok(armed.every((unit) => unit.grace > RUSHER_GRACE - 0.05 && unit.grace <= RUSHER_GRACE));
  for (const unit of armed) {
    const apart = Math.hypot(unit.position.x - feet.x, unit.position.y - feet.y, unit.position.z - feet.z);
    assert.ok(apart >= RUSHER_SEPARATION, `spawn ${apart.toFixed(2)} m`);
    assert.equal(rusherInsideVolume(unit.position), true);
    assert.equal(capsuleClear(unit.position, hull), true);
    assert.equal(unit.hp, RUSHER_HP);
    assert.equal(unit.armor, 0);
  }
  const lunges = fight.rushers.lungeCount();
  step(fight, 1.5, feet);
  assert.equal(fight.rushers.lungeCount(), lunges, "wave 2 lunged during grace");

  clearWave();
  assert.equal(fight.wisps.wave, 3);
  assert.equal(fight.rushers.aliveCount(), 1);
  clearWave();
  assert.equal(fight.wisps.wave, 4);
  assert.equal(fight.rushers.aliveCount(), 2);
  assert.equal(fight.wisps.aliveCount(), 4);
  assert.equal(fight.enforcers.aliveCount(), 2);
  const spots = fight.rushers.units.filter((unit) => unit.alive);
  const between = Math.hypot(spots[0].position.x - spots[1].position.x, spots[0].position.z - spots[1].position.z);
  assert.ok(between >= 3, `rushers stacked ${between.toFixed(2)} m apart`);
});
