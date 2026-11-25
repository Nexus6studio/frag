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
import { GROUND_WISH_SPEED } from "../src/move.ts";
import { createPlayerState } from "../src/player/state.ts";
import { QUILL_BURST, QUILL_BURST_DAMAGE, QUILL_CHARGE, QUILL_DAMAGE, createQuill } from "../src/quill.ts";
import { ENFORCER_DAMAGE } from "../src/enforcer.ts";
import {
  RUSHER_WINDUP_CAP,
  RUSHER_WINDUP_EMISSIVE,
  rusherWindupAmount,
  rusherWindupColor,
} from "../src/rusher-view.ts";
import { WISP_BOLT_DAMAGE } from "../src/wisp.ts";
import {
  RUSHER_ARMOR,
  RUSHER_COOLDOWN,
  RUSHER_DAMAGE,
  RUSHER_GRACE,
  RUSHER_HP,
  RUSHER_LUNGE,
  RUSHER_LUNGE_GAP,
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

test("one alt-fire burst of 18-damage flechettes kills a rusher", () => {
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
  const burst = QUILL_BURST * QUILL_BURST_DAMAGE;
  assert.equal(burst, 54);
  assert.ok(burst >= RUSHER_HP);
  assert.equal(sim.units[0].hp, 0);
  assert.equal(sim.units[0].alive, false);
});

test("a rusher lunges only inside 2.2 m, after a 0.40 s windup, then waits 1.4 s", () => {
  assert.equal(RUSHER_HP, 35);
  assert.equal(RUSHER_SPEED, 6.4);
  assert.equal(RUSHER_RANGE, 2.2);
  assert.equal(RUSHER_GRACE, 2);
  assert.equal(RUSHER_DAMAGE, 12);
  assert.equal(RUSHER_COOLDOWN, 1.4);
  assert.equal(RUSHER_TELEGRAPH, 0.4);
  assert.equal(RUSHER_LUNGE_GAP, 0.5);
  assert.equal(QUILL_DAMAGE, 9);
  assert.equal(QUILL_BURST_DAMAGE, 18);

  const hull = openHull();
  const player = createPlayerState();
  const far = { x: 0, y: 0, z: -(RUSHER_RANGE + 0.35) };
  const sim = createRusherSim({ hull, player, hitboxes: createHitboxWorld(), grace: 0 });
  sim.place(0, { x: 0, y: 0, z: 0 });
  step(sim, 0.2, far);
  assert.equal(sim.units[0].phase, "hunt", "windup started outside melee range");
  assert.equal(player.get().hp, 100);
  assert.equal(sim.lungeCount(), 0);

  const events = [];
  const close = createPlayerState();
  const melee = createRusherSim({
    hull,
    player: close,
    hitboxes: createHitboxWorld(),
    grace: 0,
    onEvent: (event) => events.push(event.type),
  });
  melee.place(0, { x: 0, y: 0, z: 0 });
  const feet = { x: 0, y: 0, z: -1.2 };
  step(melee, RUSHER_TELEGRAPH - 0.02, feet);
  assert.equal(melee.units[0].phase, "telegraph");
  assert.equal(close.get().hp, 100, "the windup dealt damage");
  assert.equal(melee.lungeCount(), 0);
  assert.equal(events.filter((type) => type === "rusher-windup").length, 1);
  step(melee, 0.04, feet);
  assert.equal(melee.lungeCount(), 1);
  assert.equal(close.get().hp, 100 - RUSHER_DAMAGE);
  assert.equal(melee.units[0].phase, "lunge");
  assert.ok(melee.trails.some((slot) => slot.alive), "the lunge had no trail");
  assert.equal(events.filter((type) => type === "rusher-windup").length, 1, "the cue repeated during the dash");
  const first = melee.lungeTime(0);
  assert.ok(first >= RUSHER_TELEGRAPH - DT, `lunge at ${first}`);

  step(melee, RUSHER_COOLDOWN, feet);
  assert.equal(melee.lungeCount(), 1, "cooldown ignored");
  assert.equal(melee.units[0].phase, "recover", "cooldown started before the lunge resolved");
  step(melee, RUSHER_TELEGRAPH + 0.2, feet);
  assert.equal(melee.lungeCount(), 2);
  const gap = melee.lungeTime(1) - melee.lungeTime(0);
  assert.ok(
    gap >= RUSHER_LUNGE + RUSHER_COOLDOWN + RUSHER_TELEGRAPH - 0.05,
    `lunges ${gap.toFixed(3)} s apart`,
  );
});

test("strafing at run speed during the windup makes the lunge miss", () => {
  const hull = openHull();
  const still = createPlayerState();
  const hit = createRusherSim({ hull, player: still, hitboxes: createHitboxWorld(), grace: 0 });
  hit.place(0, { x: 0, y: 0, z: 0 });
  const planted = { x: 0, y: 0, z: -1.4 };
  step(hit, RUSHER_TELEGRAPH + 0.05, planted);
  assert.equal(still.get().hp, 100 - RUSHER_DAMAGE);
  assert.equal(hit.lungeCount(), 1);

  const player = createPlayerState();
  const sim = createRusherSim({ hull, player, hitboxes: createHitboxWorld(), grace: 0 });
  sim.place(0, { x: 0, y: 0, z: 0 });
  let t = 0;
  while (t < RUSHER_TELEGRAPH + 0.08) {
    const feet = { x: GROUND_WISH_SPEED * t, y: 0, z: -1.4 };
    sim.update(DT, feet);
    t += DT;
  }
  const away = Math.hypot(GROUND_WISH_SPEED * RUSHER_TELEGRAPH, 1.4);
  assert.ok(away > RUSHER_RANGE, `strafe ${away.toFixed(2)} m stayed in reach`);
  assert.equal(player.get().hp, 100);
  assert.equal(player.get().armor, 0);
  assert.equal(sim.lungeCount(), 0);
  assert.ok(
    sim.units[0].phase === "lunge" || sim.units[0].phase === "recover",
    `windup cancelled instead of missing (${sim.units[0].phase})`,
  );
});

test("only one rusher winds up or lunges, with 0.5 s between different lunges", () => {
  const hull = openHull();
  const player = createPlayerState({ hp: 500, armor: 0 });
  const events = [];
  const sim = createRusherSim({
    hull,
    player,
    hitboxes: createHitboxWorld(),
    grace: 0,
    onEvent: (event) => events.push(event.type),
  });
  sim.place(0, { x: 0, y: 0, z: 0 });
  sim.place(1, { x: 1.2, y: 0, z: 0 });
  let overlap = 0;
  const starts = [[], []];
  const ends = [[], []];
  const prev = ["hunt", "hunt"];
  let t = 0;
  while (t < 3.5) {
    const a = sim.units[0].position;
    const b = sim.units[1].position;
    const feet = { x: (a.x + b.x) / 2, y: 0, z: (a.z + b.z) / 2 };
    sim.update(DT, feet);
    t += DT;
    let busy = 0;
    for (let i = 0; i < 2; i += 1) {
      const phase = sim.units[i].phase;
      if (phase === "telegraph" || phase === "lunge") busy += 1;
      if (phase === "lunge" && prev[i] !== "lunge") starts[i].push(sim.time);
      if (prev[i] === "lunge" && phase !== "lunge") ends[i].push(sim.time);
      prev[i] = phase;
    }
    if (busy > overlap) overlap = busy;
  }
  assert.equal(overlap, 1, "two rushers were in windup or mid-lunge together");
  assert.ok(starts[0].length >= 1 && starts[1].length >= 1, `lunges ${starts[0].length} and ${starts[1].length}`);
  const order = [];
  for (let i = 0; i < 2; i += 1) {
    for (const at of starts[i]) order.push({ i, at, kind: "start" });
    for (const at of ends[i]) order.push({ i, at, kind: "end" });
  }
  order.sort((p, q) => p.at - q.at);
  let lastEnd = null;
  let lastStart = null;
  for (const mark of order) {
    if (mark.kind === "end") lastEnd = mark;
    if (mark.kind !== "start" || !lastStart) {
      if (mark.kind === "start") lastStart = mark;
      continue;
    }
    if (mark.i !== lastStart.i) {
      assert.ok(mark.at - lastStart.at >= RUSHER_LUNGE_GAP - 1e-4, `lunge starts ${mark.at - lastStart.at} s apart`);
      assert.ok(lastEnd && mark.at - lastEnd.at >= RUSHER_LUNGE_GAP - DT, `gap after a lunge ${mark.at - (lastEnd?.at ?? 0)}`);
    }
    lastStart = mark;
  }
  assert.ok(events.filter((type) => type === "rusher-windup").length >= 2);
});

test("the windup flash stays on the body and under the bloom threshold", () => {
  assert.ok(RUSHER_WINDUP_CAP < 0.88, `cap ${RUSHER_WINDUP_CAP} reaches the bloom extract`);
  const cloth = [0.09, 0.1, 0.13];
  const blade = [1, 0.9, 1];
  for (const swing of [0, 0.05, 0.2, 0.4]) {
    const amount = rusherWindupAmount(swing);
    assert.ok(amount > 0.7 && amount <= 1, `amount ${amount}`);
    for (const vertex of [cloth, blade]) {
      const color = rusherWindupColor(vertex, swing);
      for (let channel = 0; channel < 3; channel += 1) {
        const added = vertex[channel] + amount * RUSHER_WINDUP_EMISSIVE[channel];
        assert.equal(color[channel], Math.min(added, RUSHER_WINDUP_CAP));
        assert.ok(color[channel] <= RUSHER_WINDUP_CAP);
      }
    }
    const lit = rusherWindupColor(cloth, swing);
    assert.ok(lit[0] > 0.55, `cloth red ${lit[0]} is too dim to read`);
    assert.ok(lit[1] < lit[0] * 0.55, `cloth reads white (${lit.join(", ")})`);
  }
});

test("an idle player at 100 HP and 0 armor survives the wave 4 roster for at least 5.5 s", () => {
  const hull = createAtriumHull();
  const player = createPlayerState();
  const fight = createFight({
    hull,
    player,
    hitboxes: createHitboxWorld(),
    origin: ATRIUM_SPAWN,
  });
  const feet = { x: ATRIUM_SPAWN.x, y: ATRIUM_SPAWN.y, z: ATRIUM_SPAWN.z };

  function clearWave() {
    fight.killAll();
    let gap = 0;
    const wave = fight.wisps.wave;
    while (fight.wisps.wave === wave && gap < WAVE_GAP_SECONDS + 0.5) {
      fight.update(DT, feet);
      gap += DT;
    }
  }

  clearWave();
  clearWave();
  clearWave();
  assert.equal(fight.wisps.wave, 4);
  assert.equal(fight.wisps.aliveCount(), 4);
  assert.equal(fight.enforcers.aliveCount(), 2);
  assert.equal(fight.rushers.aliveCount(), 2);
  assert.equal(player.get().hp, 100);
  assert.equal(player.get().armor, 0);

  let t = DT;
  let drone = 0;
  let enforcer = 0;
  let rusher = 0;
  let hits = fight.wisps.snapshot().hits;
  let houndHits = fight.enforcers.snapshot().hits;
  let lunges = fight.rushers.lungeCount();
  let hp = player.get().hp;
  while (hp > 0 && t < 45) {
    fight.update(DT, feet);
    t += DT;
    const nextHp = player.get().hp;
    const nextHits = fight.wisps.snapshot().hits;
    const nextHoundHits = fight.enforcers.snapshot().hits;
    const nextLunges = fight.rushers.lungeCount();
    let left = hp - nextHp;
    const take = (count, amount) => {
      let dealt = 0;
      for (let i = 0; i < count && left > 0; i += 1) {
        const hit = Math.min(amount, left);
        dealt += hit;
        left -= hit;
      }
      return dealt;
    };
    // Fight order is drones, then enforcers, then rushers. A killing blow is partial.
    drone += take(nextHits - hits, WISP_BOLT_DAMAGE);
    enforcer += take(nextHoundHits - houndHits, ENFORCER_DAMAGE);
    rusher += take(nextLunges - lunges, RUSHER_DAMAGE);
    assert.equal(left, 0, `unattributed damage at ${t.toFixed(3)} s`);
    hits = nextHits;
    houndHits = nextHoundHits;
    lunges = nextLunges;
    hp = nextHp;
  }
  console.log(
    `wave 4 idle survival ${t.toFixed(6)} s (${Math.round(t / DT)} ticks) drone ${drone} enforcer ${enforcer} rusher ${rusher} hp ${hp}`,
  );
  assert.equal(hp, 0, `still alive at ${t.toFixed(6)} s`);
  assert.equal(drone, 80);
  assert.equal(enforcer, 20);
  assert.equal(rusher, 0);
  assert.equal(drone + enforcer + rusher, 100);
  assert.ok(t >= 5.5, `died at ${t.toFixed(6)} s`);
});

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
