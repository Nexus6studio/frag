import assert from "node:assert/strict";
import test from "node:test";
import { ATRIUM_SPAWN, CATWALK_Y, CEILING_Y, GROUND_Y, MAP_HALF, createAtriumHull } from "../src/atrium.ts";
import { createHitboxWorld } from "../src/hitbox.ts";
import { createPlayerState } from "../src/player/state.ts";
import { damagePlayer } from "../src/player/hurt.ts";
import { QUILL_DAMAGE, createQuill } from "../src/quill.ts";
import {
  WISP_ALTITUDE_MAX,
  WISP_ALTITUDE_MIN,
  WISP_ARMOR,
  WISP_BOLT_CAP,
  WISP_BOLT_DAMAGE,
  WISP_BOLT_GAP,
  WISP_BOLT_RADIUS,
  WISP_BOLT_SPEED,
  WISP_SPAWN_GRACE,
  WISP_BURST_GAP,
  WISP_CLOSE,
  WISP_COUNT,
  WISP_FLUID_CAP,
  WISP_FLUID_COLOR,
  WISP_GIB_CAP,
  WISP_HP,
  WISP_SEPARATION,
  WISP_SPARK_CAP,
  WISP_SPEED,
  WISP_TELEGRAPH,
  WISP_VISOR_AGGRO,
  WISP_VISOR_IDLE,
  createWispSim,
  sphereHitsHull,
  wispFloorY,
  wispInsideVolume,
  wispVisorHex,
} from "../src/wisp.ts";
import { DRONE_CAP } from "../src/waves.ts";
import { traceSegment } from "../src/trace.ts";
import { boltVisualScale } from "../src/wisp-view.ts";

const DT = 1 / 120;

function atriumSim(origin = ATRIUM_SPAWN) {
  const hull = createAtriumHull();
  const player = createPlayerState();
  const hitboxes = createHitboxWorld();
  const sim = createWispSim({ hull, player, hitboxes, origin });
  return { hull, player, hitboxes, sim };
}

function step(sim, seconds, feet) {
  let t = 0;
  while (t < seconds - 1e-9) {
    sim.update(DT, feet);
    t += DT;
  }
}

test("two drones spawn clear of the hull and at least 8 m from the player", () => {
  const { hull, sim } = atriumSim();
  assert.equal(sim.drones.length, DRONE_CAP);
  assert.equal(sim.aliveCount(), WISP_COUNT);
  assert.equal(WISP_ARMOR, 0);
  const seen = [];
  for (const drone of sim.drones) {
    if (!drone.alive) continue;
    assert.equal(drone.alive, true);
    assert.equal(drone.hp, WISP_HP);
    assert.equal(drone.aggro, true);
    assert.equal(wispVisorHex(drone.aggro), WISP_VISOR_AGGRO);
    const apart = Math.hypot(
      drone.position.x - ATRIUM_SPAWN.x,
      drone.position.y - ATRIUM_SPAWN.y,
      drone.position.z - ATRIUM_SPAWN.z,
    );
    console.log(
      `wisp ${drone.index} spawn ${drone.position.x.toFixed(2)} ${drone.position.y.toFixed(2)} ${drone.position.z.toFixed(2)} dist ${apart.toFixed(2)} m`,
    );
    assert.ok(apart >= WISP_SEPARATION, `spawn distance ${apart}`);
    assert.ok(wispInsideVolume(drone.position), "spawn left the atrium volume");
    assert.equal(sphereHitsHull(drone.position, 0.46, hull), false, "spawn intersects a hull");
    seen.push(drone.position);
  }
  const between = Math.hypot(seen[0].x - seen[1].x, seen[0].z - seen[1].z);
  assert.ok(between > 4, `drones spawned on top of each other (${between})`);
  assert.equal(wispVisorHex(false), WISP_VISOR_IDLE);
});

test("five flechettes kill a drone and four leave it alive", () => {
  const { sim, hitboxes } = atriumSim();
  const drone = sim.drones[0];
  drone.position.x = 0;
  drone.position.y = 1.2;
  drone.position.z = -6;
  sim.drones[1].position.x = 12;
  sim.drones[1].position.y = 3;
  sim.drones[1].position.z = 12;
  const quill = createQuill({ hitboxes, hull: null });
  const fire = {
    fire: true,
    reload: false,
    origin: { x: 0, y: 1.2, z: 0 },
    direction: { x: 0, y: 0, z: -1 },
  };
  const idle = { ...fire, fire: false };

  const shoot = () => {
    const before = drone.hp;
    quill.update(0, fire);
    assert.equal(drone.hp, before, "flechette hit on the spawn frame");
    quill.update(0, idle);
    let t = 0;
    while (drone.hp === before && t < 0.4) {
      quill.update(DT, idle);
      t += DT;
    }
    return t;
  };

  const first = shoot();
  console.log(`wisp first flechette travel ${first.toFixed(4)} s, hp ${drone.hp}`);
  assert.equal(drone.hp, WISP_HP - QUILL_DAMAGE);
  assert.equal(drone.alive, true);
  shoot();
  shoot();
  shoot();
  assert.equal(drone.hp, WISP_HP - 4 * QUILL_DAMAGE);
  assert.equal(drone.alive, true, "36 damage killed a 40 HP drone");
  shoot();
  assert.equal(drone.hp, 0);
  assert.equal(drone.alive, false);
  assert.ok(sim.sparks.some((slot) => slot.alive), "death did not emit sparks");
  assert.ok(sim.gibs.some((slot) => slot.alive), "death did not emit scraps");
  assert.ok(sim.fluid.some((slot) => slot.alive), "death did not emit hydraulic fluid");
  const after = drone.hp;
  shoot();
  assert.equal(drone.hp, after, "a dead drone still took a flechette");
});

test("each bolt deals 8 and a hull stops the shot", () => {
  const open = {
    boxes: [{ min: { x: -30, y: -1, z: -30 }, max: { x: 30, y: 0, z: 30 } }],
    ramps: [],
  };
  const player = createPlayerState();
  const sim = createWispSim({
    hull: open,
    player,
    hitboxes: createHitboxWorld(),
    origin: { x: 0, y: 0, z: 0 },
  });
  const feet = { x: 0, y: 0, z: 0 };
  const drops = [];
  let previous = player.get().hp;
  let t = 0;
  while (drops.length < 2 && t < 4) {
    sim.update(DT, feet);
    const hp = player.get().hp;
    if (hp !== previous) {
      drops.push(previous - hp);
      previous = hp;
    }
    t += DT;
  }
  console.log(`wisp bolt drops ${drops.join(", ")} by ${t.toFixed(2)} s`);
  assert.ok(drops.length >= 2, "the burst did not land two bolts");
  assert.equal(drops[0], WISP_BOLT_DAMAGE);
  assert.equal(drops[1], WISP_BOLT_DAMAGE);
  assert.equal(player.get().hp, 100 - WISP_BOLT_DAMAGE * 2);

  const walled = {
    boxes: [
      { min: { x: -30, y: -1, z: -30 }, max: { x: 30, y: 0, z: 30 } },
      { min: { x: -1.2, y: 0, z: -1.2 }, max: { x: 1.2, y: 4, z: 1.2 } },
    ],
    ramps: [],
  };
  const blocked = createPlayerState();
  const blockedSim = createWispSim({
    hull: walled,
    player: blocked,
    hitboxes: createHitboxWorld(),
    origin: { x: 0, y: 0, z: 0 },
  });
  step(blockedSim, 3, feet);
  assert.ok(blockedSim.boltCount(0) >= 2, "the walled drone never fired");
  assert.equal(blocked.get().hp, 100, "a bolt passed the hull");
});

test("telegraph leads every burst, bolts are 0.15 s apart, and bursts are 1.8 s apart", () => {
  const { sim } = atriumSim();
  const feet = { x: ATRIUM_SPAWN.x, y: ATRIUM_SPAWN.y, z: ATRIUM_SPAWN.z };
  step(sim, 8, feet);
  for (const drone of sim.drones) {
    if (!drone.alive) continue;
    const bolts = sim.boltCount(drone.index);
    const teles = sim.telegraphCount(drone.index);
    assert.ok(bolts >= 4, `drone ${drone.index} fired ${bolts}`);
    assert.ok(teles >= 2, `drone ${drone.index} telegraphed ${teles}`);
    const bursts = Math.min(teles, Math.floor(bolts / 2));
    for (let burst = 0; burst < bursts; burst += 1) {
      const first = sim.boltTime(drone.index, burst * 2);
      const second = sim.boltTime(drone.index, burst * 2 + 1);
      const lead = first - sim.telegraphTime(drone.index, burst);
      assert.ok(lead >= 0.25, `telegraph lead ${lead}`);
      assert.ok(Math.abs(lead - WISP_TELEGRAPH) < 1e-4, `lead ${lead}`);
      assert.ok(Math.abs(second - first - WISP_BOLT_GAP) < 1e-4, `bolt gap ${second - first}`);
      if (burst + 1 < bursts) {
        const next = sim.boltTime(drone.index, (burst + 1) * 2);
        const gap = next - second;
        assert.ok(Math.abs(gap - WISP_BURST_GAP) < 1e-4, `burst gap ${gap}`);
      }
    }
    console.log(
      `wisp ${drone.index} bursts ${bursts}, first lead ${(sim.boltTime(drone.index, 0) - sim.telegraphTime(drone.index, 0)).toFixed(3)} s`,
    );
  }
});

test("bolts travel at 18 m/s and stay in a fixed pool", () => {
  const { sim } = atriumSim();
  const feet = { x: 40, y: GROUND_Y, z: 40 };
  let bolt = null;
  let guard = 0;
  while (!bolt && guard < WISP_SPAWN_GRACE + 1) {
    sim.update(DT, feet);
    guard += DT;
    bolt = sim.bolts.find((slot) => slot.alive) ?? null;
  }
  assert.ok(bolt, "no bolt was pooled");
  const x = bolt.x;
  const y = bolt.y;
  const z = bolt.z;
  sim.update(0.05, feet);
  const moved = Math.hypot(bolt.x - x, bolt.y - y, bolt.z - z);
  const speed = moved / 0.05;
  console.log(`wisp bolt speed ${speed.toFixed(2)} m/s, radius ${WISP_BOLT_RADIUS} m`);
  assert.ok(Math.abs(speed - WISP_BOLT_SPEED) < 0.05, `speed ${speed}`);
  assert.equal(sim.bolts.length, WISP_BOLT_CAP);
  step(sim, 12, feet);
  assert.equal(sim.bolts.length, WISP_BOLT_CAP, "bolt pool grew");
  assert.equal(sim.sparks.length, WISP_SPARK_CAP);
  assert.equal(sim.gibs.length, WISP_GIB_CAP);
  assert.equal(sim.fluid.length, WISP_FLUID_CAP);
});

test("death scraps are reused from the original pools and the fluid is not blood", () => {
  const red = (WISP_FLUID_COLOR >> 16) & 255;
  const green = (WISP_FLUID_COLOR >> 8) & 255;
  const blue = WISP_FLUID_COLOR & 255;
  assert.ok(red < 40 && green < 40 && blue < 40, `fluid color ${WISP_FLUID_COLOR.toString(16)}`);
  assert.ok(red <= green + 8, "hydraulic fluid reads as blood");

  const { sim, hitboxes } = atriumSim();
  const quill = createQuill({ hitboxes, hull: null });
  const kill = (drone) => {
    const origin = { x: drone.position.x, y: drone.position.y, z: drone.position.z + 2 };
    const direction = { x: 0, y: 0, z: -1 };
    let shots = 0;
    while (drone.alive && shots < 8) {
      quill.update(0, { fire: true, reload: false, origin, direction });
      quill.update(0.2, { fire: false, reload: false, origin, direction });
      shots += 1;
    }
    assert.equal(drone.alive, false, "flechettes did not kill the drone");
  };
  kill(sim.drones[0]);
  const slot = sim.sparks.find((spark) => spark.alive);
  assert.ok(slot);
  const sparks = sim.sparks;
  const gibs = sim.gibs;
  const fluid = sim.fluid;
  step(sim, 2, { x: 0, y: GROUND_Y, z: 0 });
  assert.equal(slot.alive, false, "spark pool slot never expired");
  kill(sim.drones[1]);
  assert.equal(slot.alive, true, "second death allocated a new spark instead of reusing the pool");
  assert.equal(sim.sparks, sparks);
  assert.equal(sim.gibs, gibs);
  assert.equal(sim.fluid, fluid);
  assert.equal(sim.sparks.length, WISP_SPARK_CAP);
});

test("altitude rises inside 6 m, and a 120 s chase stays inside the atrium", () => {
  const { hull, sim } = atriumSim();
  const feet = { x: 0, y: GROUND_Y, z: 0 };
  const drone = sim.drones[0];
  step(sim, 5, feet);
  const farDist = Math.hypot(drone.position.x - feet.x, drone.position.z - feet.z);
  const farFloor = wispFloorY(drone.position.x, drone.position.y, drone.position.z, hull);
  const farAlt = drone.position.y - farFloor;
  console.log(`wisp far dist ${farDist.toFixed(2)} m, altitude ${farAlt.toFixed(2)} m`);
  assert.ok(farDist > WISP_CLOSE, `drone did not hold range (${farDist})`);

  let nearAlt = farAlt;
  let nearDist = farDist;
  for (let t = 0; t < 3; t += DT) {
    feet.x = drone.position.x;
    feet.z = drone.position.z + 4;
    feet.y = GROUND_Y;
    if (Math.abs(feet.z) > MAP_HALF - 2) feet.z = drone.position.z - 4;
    sim.update(DT, feet);
    nearDist = Math.hypot(drone.position.x - feet.x, drone.position.z - feet.z);
    const floor = wispFloorY(drone.position.x, drone.position.y, drone.position.z, hull);
    nearAlt = drone.position.y - floor;
  }
  console.log(`wisp close dist ${nearDist.toFixed(2)} m, altitude ${nearAlt.toFixed(2)} m`);
  assert.ok(nearDist < WISP_CLOSE, `close sample drifted to ${nearDist}`);
  assert.ok(nearAlt > farAlt + 0.6, `altitude did not rise inside 6 m (${farAlt} -> ${nearAlt})`);
  assert.ok(nearAlt > WISP_ALTITUDE_MIN + 0.5, `close altitude ${nearAlt} stayed on the low band`);

  const script = { x: 0, y: GROUND_Y, z: 0 };
  let maxCatwalk = 0;
  const seconds = 120;
  for (let t = 0; t < seconds; t += DT) {
    if (t < 20) {
      script.x = Math.cos(t * 0.35) * 6;
      script.z = Math.sin(t * 0.35) * 6;
      script.y = GROUND_Y;
    } else if (t < 32) {
      script.x = 0;
      script.y = CATWALK_Y;
      script.z = 14.4;
    } else if (t < 40) {
      const lead = sim.drones[0];
      script.x = lead.position.x;
      script.z = lead.position.z + (lead.position.z > 0 ? -4 : 4);
      script.y = GROUND_Y;
      if (Math.abs(script.x) > 12) script.x = 0;
      if (Math.abs(script.z) > 12) script.z = 0;
    } else {
      const angle = t * 0.22;
      script.x = Math.cos(angle) * 7;
      script.z = Math.sin(angle) * 7;
      script.y = GROUND_Y;
    }
    sim.update(DT, script);
    if (t >= 20 && t < 32) {
      for (const unit of sim.drones) if (unit.position.y > maxCatwalk) maxCatwalk = unit.position.y;
    }
    for (const unit of sim.drones) {
      if (!unit.alive) continue;
      if (!wispInsideVolume(unit.position)) {
        assert.fail(
          `drone ${unit.index} left the volume at ${t.toFixed(2)} s (${unit.position.x.toFixed(2)}, ${unit.position.y.toFixed(2)}, ${unit.position.z.toFixed(2)})`,
        );
      }
      if (sphereHitsHull(unit.position, 0.46, hull)) {
        assert.fail(
          `drone ${unit.index} clipped a hull at ${t.toFixed(2)} s (${unit.position.x.toFixed(2)}, ${unit.position.y.toFixed(2)}, ${unit.position.z.toFixed(2)})`,
        );
      }
    }
  }
  console.log(
    `wisp 120 s chase stayed inside ${MAP_HALF * 2}×${MAP_HALF * 2}×${CEILING_Y}, catwalk peek y ${maxCatwalk.toFixed(2)} (band ${WISP_ALTITUDE_MIN}–${WISP_ALTITUDE_MAX}, speed ${WISP_SPEED})`,
  );
  assert.ok(maxCatwalk > 4.5, `drones did not climb toward the catwalk (${maxCatwalk})`);
});

test("damagePlayer is the bolt seam and applies armor absorb", () => {
  const player = createPlayerState({ hp: 100, armor: 0 });
  damagePlayer(player, WISP_BOLT_DAMAGE);
  assert.equal(player.get().hp, 92);
  assert.equal(player.get().armor, 0);
  damagePlayer(player, 0);
  assert.equal(player.get().hp, 92);

  // floor(8·2/3) = 5 absorbed from 9 armor, so HP loses 3.
  const armored = createPlayerState({ hp: 80, armor: 9 });
  damagePlayer(armored, WISP_BOLT_DAMAGE);
  assert.equal(armored.get().hp, 77);
  assert.equal(armored.get().armor, 4);
});

test("a live bolt deals 8 through applyDamage when the player has armor", () => {
  const open = {
    boxes: [{ min: { x: -30, y: -1, z: -30 }, max: { x: 30, y: 0, z: 30 } }],
    ramps: [],
  };
  const player = createPlayerState({ hp: 80, armor: 9 });
  const sim = createWispSim({
    hull: open,
    player,
    hitboxes: createHitboxWorld(),
    origin: { x: 0, y: 0, z: 0 },
  });
  const feet = { x: 0, y: 0, z: 0 };
  let t = 0;
  while (player.get().hp === 80 && t < 4) {
    sim.update(DT, feet);
    t += DT;
  }
  assert.equal(player.get().hp, 77);
  assert.equal(player.get().armor, 4);
});

test("drones do not fire during the 2 s spawn grace, at 120 fps or 5 fps", () => {
  for (const dt of [DT, 0.2]) {
    const { sim } = atriumSim();
    const feet = { x: ATRIUM_SPAWN.x, y: ATRIUM_SPAWN.y, z: ATRIUM_SPAWN.z };
    let t = 0;
    while (t < WISP_SPAWN_GRACE - dt) {
      sim.update(dt, feet);
      t += dt;
    }
    assert.equal(sim.boltCount(0), 0, `${dt} s steps fired during grace`);
    assert.equal(sim.boltCount(1), 0, `${dt} s steps fired during grace`);
    while (t < WISP_SPAWN_GRACE + 0.35) {
      sim.update(dt, feet);
      t += dt;
    }
    assert.ok(sim.boltCount(0) >= 1, `lead did not fire after grace at dt ${dt}`);
    const first = sim.boltTime(0, 0);
    assert.ok(first >= WISP_SPAWN_GRACE + WISP_TELEGRAPH - 0.02, `first bolt ${first}`);
  }
});

test("burst cadence holds at 5 fps and two drones stay under the scripted damage rate", () => {
  const open = {
    boxes: [{ min: { x: -40, y: -1, z: -40 }, max: { x: 40, y: 0, z: 40 } }],
    ramps: [],
  };
  const player = createPlayerState({ hp: 500 });
  const sim = createWispSim({
    hull: open,
    player,
    hitboxes: createHitboxWorld(),
    origin: { x: 0, y: 0, z: 0 },
  });
  const feet = { x: 0, y: 0, z: 0 };
  const dt = 0.2;
  let t = 0;
  while (t < 12) {
    sim.update(dt, feet);
    t += dt;
  }
  for (const index of [0, 1]) {
    const bolts = sim.boltCount(index);
    assert.ok(bolts >= 4, `drone ${index} fired ${bolts} at 5 fps`);
    for (let i = 0; i + 1 < bolts; i += 2) {
      const gap = sim.boltTime(index, i + 1) - sim.boltTime(index, i);
      assert.ok(Math.abs(gap - WISP_BOLT_GAP) < 0.02, `5 fps bolt gap ${gap}`);
      if (i + 2 < bolts) {
        const burst = sim.boltTime(index, i + 2) - sim.boltTime(index, i + 1);
        assert.ok(Math.abs(burst - WISP_BURST_GAP) < 0.02, `5 fps burst gap ${burst}`);
      }
    }
  }
  const dealt = 500 - player.get().hp;
  const window = 12 - WISP_SPAWN_GRACE;
  const perSecond = dealt / window;
  const scripted = (2 * 2 * WISP_BOLT_DAMAGE) / (WISP_BOLT_GAP + WISP_BURST_GAP);
  console.log(
    `wisp worst case ${scripted.toFixed(2)} HP/s if both drones hit every bolt; measured ${perSecond.toFixed(2)} HP/s over ${window.toFixed(1)} s (${dealt} HP)`,
  );
  assert.ok(perSecond <= scripted + 0.5, `measured ${perSecond} exceeded the scripted ${scripted}`);
});

test("a 5 fps bolt step stops on every atrium hull", () => {
  const hull = createAtriumHull();
  const travel = WISP_BOLT_SPEED * 0.2;
  let boxes = 0;
  let ramps = 0;
  for (const box of hull.boxes) {
    const cy = (box.min.y + box.max.y) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    if (cy < box.min.y || cy > box.max.y) continue;
    const from = { x: box.min.x - 0.3, y: cy, z: cz };
    const to = { x: from.x + travel, y: cy, z: cz };
    if (from.z < box.min.z || from.z > box.max.z) continue;
    const hit = traceSegment(from, to, hull);
    assert.ok(hit, `5 fps step missed a box at y ${cy.toFixed(2)}`);
    assert.ok(hit.point.x <= box.min.x + 0.05, `bolt tunneled a box to x ${hit.point.x}`);
    boxes += 1;
  }
  for (const ramp of hull.ramps) {
    const x = (ramp.minX + ramp.maxX) / 2;
    const z = (ramp.minZ + ramp.maxZ) / 2;
    const span = ramp.maxZ - ramp.minZ;
    const slope = ramp.rise / span;
    const y = ramp.yAtMaxZ + slope * (ramp.maxZ - z) - 0.4;
    const from = { x, y, z };
    const to = { x, y: y + travel, z };
    const hit = traceSegment(from, to, hull);
    assert.ok(hit, `5 fps step missed ramp ${x.toFixed(1)} ${z.toFixed(1)}`);
    assert.ok(hit.point.y < y + travel - 0.5, `bolt passed through a ramp at y ${hit.point.y}`);
    ramps += 1;
  }
  console.log(`5 fps bolt sweep stopped on ${boxes} boxes and ${ramps} ramps`);
  assert.ok(boxes > 10);
  assert.equal(ramps, hull.ramps.length);
});

test("a single bolt applies damage once at 5, 30, and 120 fps", () => {
  for (const dt of [1 / 120, 1 / 30, 0.2]) {
    const open = {
      boxes: [{ min: { x: -40, y: -1, z: -40 }, max: { x: 40, y: 0, z: 40 } }],
      ramps: [],
    };
    const player = createPlayerState({ hp: 500 });
    const sim = createWispSim({
      hull: open,
      player,
      hitboxes: createHitboxWorld(),
      origin: { x: 0, y: 0, z: 0 },
    });
    const feet = { x: 0, y: 0, z: 0 };
    const bySerial = new Map();
    let previousHp = player.get().hp;
    let previous = new Set();
    let t = 0;
    while (t < 6) {
      sim.update(dt, feet);
      t += dt;
      const hp = player.get().hp;
      const live = new Set(sim.bolts.filter((bolt) => bolt.alive).map((bolt) => bolt.serial));
      if (hp !== previousHp) {
        const events = (previousHp - hp) / WISP_BOLT_DAMAGE;
        const died = [...previous].filter((serial) => !live.has(serial));
        assert.equal(
          events,
          died.length,
          `${dt} s step dealt ${previousHp - hp} HP from ${died.length} bolts`,
        );
        for (const serial of died) {
          bySerial.set(serial, (bySerial.get(serial) ?? 0) + 1);
          assert.equal(bySerial.get(serial), 1, `bolt ${serial} damaged twice at dt ${dt}`);
        }
        previousHp = hp;
      }
      for (const bolt of sim.bolts) {
        if (!bolt.alive || !bolt.hit) continue;
        assert.fail(`bolt ${bolt.serial} stayed alive after it had already hit`);
      }
      previous = live;
    }
    const shot = sim.snapshot();
    assert.ok(bySerial.size >= 1, `no bolt hit at dt ${dt}`);
    assert.equal(shot.hits, bySerial.size);
    assert.equal(shot.damageEvents, bySerial.size);
    assert.equal(500 - player.get().hp, bySerial.size * WISP_BOLT_DAMAGE);
    assert.ok(shot.firstBolt >= WISP_SPAWN_GRACE, `first bolt ${shot.firstBolt} at dt ${dt}`);
    console.log(`bolt-once dt ${dt}: ${bySerial.size} bolts once each, hp ${player.get().hp}`);
  }
});

test("a near bolt is culled and a far bolt stays at the 0.25 m scale", () => {
  assert.equal(boltVisualScale(0.4), 0);
  assert.equal(boltVisualScale(0.99), 0);
  const atOne = boltVisualScale(1);
  assert.ok(atOne > 0 && atOne < 1, `scale at 1 m is ${atOne}`);
  assert.equal(boltVisualScale(4), 1);
});
