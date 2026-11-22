import assert from "node:assert/strict";
import test from "node:test";
import { createAtriumHull } from "../src/atrium.ts";
import { createHitboxWorld, registerHitbox } from "../src/hitbox.ts";
import { hudReadout } from "../src/hud/model.ts";
import { createPlayerState } from "../src/player/state.ts";
import {
  QUILL_DAMAGE,
  QUILL_INTERVAL,
  QUILL_POOL_CAP,
  QUILL_PUNCH_DEG,
  QUILL_RELOAD,
  QUILL_SPEED,
  aimDirection,
  createQuill,
} from "../src/quill.ts";

const origin = { x: 0, y: 0, z: 0 };
const forward = { x: 0, y: 0, z: -1 };

function command(fire, reload, direction = forward) {
  return { fire, reload, origin, direction };
}

function fresh() {
  return createQuill({ hitboxes: createHitboxWorld() });
}

test("bore follows look and a 10 m dummy is hit after the fire frame", () => {
  const aim = { x: 0, y: 0, z: 0 };
  aimDirection(0, 0, aim);
  assert.ok(Math.abs(aim.x) < 1e-9 && Math.abs(aim.y) < 1e-9 && Math.abs(aim.z + 1) < 1e-9);
  aimDirection(90, 0, aim);
  assert.ok(Math.abs(aim.x + 1) < 1e-9 && Math.abs(aim.y) < 1e-9 && Math.abs(aim.z) < 1e-9);
  aimDirection(0, 90, aim);
  assert.ok(Math.abs(aim.y - 1) < 1e-9);

  const hits = [];
  const world = createHitboxWorld();
  world.register({
    center: { x: 0, y: 0, z: -10 },
    radius: 0.15,
    onHit(damage) {
      hits.push(damage);
    },
  });
  const quill = createQuill({ hitboxes: world });
  const dt = 1 / 120;
  quill.update(dt, command(true, false));
  assert.equal(hits.length, 0, "flechette hit on the fire frame");
  assert.equal(quill.shotsFired, 1);
  let t = dt;
  while (hits.length === 0 && t < 1) {
    quill.update(dt, command(false, false));
    t += dt;
  }
  const speed = QUILL_SPEED;
  console.log(`quill time to hit at 10 m: ${t.toFixed(4)} s (bore speed ${speed} m/s)`);
  assert.ok(Math.abs(t - 0.14) <= 0.03, `hit at ${t.toFixed(4)} s`);
  assert.equal(hits[0], QUILL_DAMAGE);
});

test("a flechette travels at 70 m/s", () => {
  const quill = fresh();
  quill.update(0.1, command(true, false));
  const slot = quill.slots.find((entry) => entry.alive);
  assert.ok(slot);
  const speed = slot.traveled / slot.age;
  console.log(`quill speed: ${speed.toFixed(3)} m/s over ${slot.traveled.toFixed(3)} m`);
  assert.ok(Math.abs(speed - 70) <= 2, `speed ${speed}`);
  assert.ok(Math.abs(slot.z - -7) <= 0.2, `z ${slot.z}`);
});

test("a hit deals 9 with no falloff and a miss deals 0", () => {
  const damageAt = (distance) => {
    const world = createHitboxWorld();
    let dealt = 0;
    world.register({
      center: { x: 0, y: 0, z: -distance },
      radius: 0.2,
      onHit(damage) {
        dealt += damage;
      },
    });
    const quill = createQuill({ hitboxes: world });
    quill.update(0, command(true, false));
    let t = 0;
    while (dealt === 0 && t < 1.05) {
      quill.update(1 / 120, command(false, false));
      t += 1 / 120;
    }
    return dealt;
  };
  assert.equal(damageAt(2), 9);
  assert.equal(damageAt(60), 9);

  const world = createHitboxWorld();
  let missed = 0;
  world.register({
    center: { x: 0, y: 0, z: -10 },
    radius: 0.4,
    onHit(damage) {
      missed += damage;
    },
  });
  const quill = createQuill({ hitboxes: world });
  const away = { x: 1, y: 0, z: 0 };
  quill.update(0, command(true, false, away));
  quill.update(1.05, command(false, false, away));
  assert.equal(missed, 0);
  assert.equal(quill.liveCount, 0);
});

test("full-auto rate stays 8 per second at 20 fps and 144 fps", () => {
  const measure = (dt) => {
    const quill = fresh();
    let guard = 0;
    while (quill.mag > 0 && guard < 20000) {
      quill.update(dt, command(true, false));
      guard += 1;
    }
    assert.equal(quill.shotsFired, 40);
    assert.equal(quill.mag, 0);
    const first = quill.shotTime(0);
    const last = quill.shotTime(39);
    const mean = (last - first) / 39;
    const rate = 39 / (last - first);
    return { mean, rate, first, last };
  };
  const slow = measure(1 / 20);
  const fast = measure(1 / 144);
  console.log(
    `quill rate 20 fps: interval ${slow.mean.toFixed(5)} s, ${slow.rate.toFixed(3)} shots/s`,
  );
  console.log(
    `quill rate 144 fps: interval ${fast.mean.toFixed(5)} s, ${fast.rate.toFixed(3)} shots/s`,
  );
  for (const sample of [slow, fast]) {
    assert.ok(Math.abs(sample.mean - QUILL_INTERVAL) <= 0.01, `interval ${sample.mean}`);
    assert.ok(Math.abs(sample.rate - 8) <= 0.2, `rate ${sample.rate}`);
  }
});

test("reload takes 1.4 s, refills from reserve, blocks fire, and reserve cannot go negative", () => {
  const quill = fresh();
  for (let i = 0; i < 10; i += 1) {
    quill.update(0, command(true, false));
    quill.update(0, command(false, false));
  }
  assert.equal(quill.mag, 30);
  assert.equal(quill.reserve, 40);

  quill.update(0, command(false, true));
  assert.equal(quill.reloading, true);
  const during = quill.shotsFired;
  let t = 0;
  while (t < 1.35 - 1e-9) {
    quill.update(0.01, command(true, false));
    t += 0.01;
  }
  assert.equal(quill.reloading, true, "reload ended early");
  assert.equal(quill.mag, 30);
  assert.equal(quill.shotsFired, during, "fire was not blocked mid-reload");

  while (quill.reloading && t < 3) {
    quill.update(0.01, command(true, false));
    t += 0.01;
  }
  console.log(`quill reload: ${t.toFixed(4)} s`);
  assert.ok(Math.abs(t - QUILL_RELOAD) <= 0.05, `reload ${t}`);
  assert.equal(quill.reloading, false);
  assert.equal(quill.mag, 40);
  assert.equal(quill.reserve, 30);
  assert.equal(quill.shotsFired, during);

  quill.update(0, command(true, false));
  assert.equal(quill.shotsFired, during + 1, "fire did not resume after reload");
  assert.equal(quill.mag, 39);

  const dump = fresh();
  while (dump.mag > 0) dump.update(1 / 120, command(true, false));
  assert.equal(dump.shotsFired, 40);
  assert.equal(dump.mag, 0);
  assert.equal(dump.reloading, true, "empty magazine did not auto-reload");
  assert.equal(dump.reserve, 40);
  const blocked = dump.shotsFired;
  dump.update(0, command(true, false));
  assert.equal(dump.shotsFired, blocked);
  let auto = 0;
  while (dump.reloading && auto < 3) {
    dump.update(1 / 120, command(true, false));
    auto += 1 / 120;
  }
  console.log(`quill auto-reload: ${auto.toFixed(4)} s`);
  assert.equal(dump.shotsFired, blocked, "fire was not blocked for the whole auto-reload");
  assert.ok(Math.abs(auto - QUILL_RELOAD) <= 0.05, `auto reload ${auto}`);
  assert.equal(dump.mag, 40);
  assert.equal(dump.reserve, 0);

  while (dump.mag > 0) dump.update(1 / 120, command(true, false));
  assert.equal(dump.mag, 0);
  assert.equal(dump.reserve, 0);
  assert.equal(dump.reloading, false);
  const dry = dump.shotsFired;
  let top = 0;
  for (const slot of dump.slots) if (slot.serial > top) top = slot.serial;
  dump.update(1, command(true, true));
  assert.equal(dump.shotsFired, dry, "dry fire cycled a shot");
  assert.equal(dump.mag, 0);
  assert.equal(dump.reserve, 0);
  let after = 0;
  for (const slot of dump.slots) if (slot.serial > after) after = slot.serial;
  assert.equal(after, top, "dry fire reused a slot");
});

test("held aim keeps one bore line while the view punch recovers", () => {
  const quill = fresh();
  quill.update(0, command(true, false));
  assert.ok(Math.abs(quill.punchDeg - QUILL_PUNCH_DEG) < 1e-6, `punch ${quill.punchDeg}`);
  quill.update(0.1, command(true, false));
  assert.equal(quill.shotsFired, 1, "second shot landed before the punch could recover");
  assert.equal(quill.punchDeg, 0);

  const spray = fresh();
  spray.update(0.5, command(true, false));
  assert.ok(spray.shotsFired >= 4);
  const first = spray.shotDirection(0);
  const x = first.x;
  const y = first.y;
  const z = first.z;
  for (let i = 1; i < spray.shotsFired; i += 1) {
    const dir = spray.shotDirection(i);
    assert.ok(Math.abs(dir.x - x) < 1e-9 && Math.abs(dir.y - y) < 1e-9 && Math.abs(dir.z - z) < 1e-9);
  }
  spray.update(0, command(false, false));
  spray.update(0, command(true, false, { x: 1, y: 0, z: 0 }));
  const turned = spray.shotDirection(spray.shotsFired - 1);
  assert.ok(Math.abs(turned.x - 1) < 1e-9 && Math.abs(turned.z) < 1e-9);
});

test("flechettes stop on hulls and do not pass through a dummy", () => {
  const thin = {
    boxes: [{ min: { x: -2, y: -2, z: -6.02 }, max: { x: 2, y: 3, z: -6 } }],
    ramps: [],
  };
  const behind = createHitboxWorld();
  let leaked = 0;
  behind.register({
    center: { x: 0, y: 0, z: -10 },
    radius: 0.5,
    onHit(damage) {
      leaked += damage;
    },
  });
  const quill = createQuill({ hull: thin, hitboxes: behind });
  quill.update(0, command(true, false));
  quill.update(0.25, command(false, false));
  assert.equal(leaked, 0);
  assert.equal(quill.liveCount, 0);
  assert.ok(quill.slots[0].z < -5.5 && quill.slots[0].z > -6.05, `stopped at z ${quill.slots[0].z}`);

  const stacked = createHitboxWorld();
  let first = 0;
  let second = 0;
  stacked.register({
    center: { x: 0, y: 0, z: -10 },
    radius: 0.3,
    onHit(damage) {
      first += damage;
    },
  });
  stacked.register({
    center: { x: 0, y: 0, z: -12 },
    radius: 0.3,
    onHit(damage) {
      second += damage;
    },
  });
  const pass = createQuill({ hitboxes: stacked });
  pass.update(0, command(true, false));
  pass.update(0.5, command(false, false));
  assert.equal(first, 9);
  assert.equal(second, 0);
  assert.equal(pass.liveCount, 0);

  const atrium = createAtriumHull();
  const far = createHitboxWorld();
  let through = 0;
  far.register({
    center: { x: 0, y: 2.25, z: -14 },
    radius: 0.4,
    onHit() {
      through += 1;
    },
  });
  const hall = createQuill({ hull: atrium, hitboxes: far });
  const eye = { x: 0, y: 2.25, z: 7.4 };
  hall.update(0, { fire: true, reload: false, origin: eye, direction: forward });
  let flew = 0;
  while (hall.liveCount > 0 && flew < 1.2) {
    hall.update(1 / 120, { fire: false, reload: false, origin: eye, direction: forward });
    flew += 1 / 120;
  }
  assert.equal(through, 0);
  assert.ok(hall.slots[0].z < -5, `did not travel, z ${hall.slots[0].z}`);
  assert.ok(hall.slots[0].z > -11.25, `passed the atrium hull, z ${hall.slots[0].z}`);
});

test("an aabb hitbox takes the same 9 damage", () => {
  const world = createHitboxWorld();
  let dealt = 0;
  world.register({
    center: { x: 0, y: 0, z: -8 },
    aabb: { min: { x: -0.4, y: -0.4, z: -8.4 }, max: { x: 0.4, y: 0.4, z: -7.6 } },
    onHit(damage) {
      dealt += damage;
    },
  });
  const quill = createQuill({ hitboxes: world });
  quill.update(0, command(true, false));
  quill.update(0.3, command(false, false));
  assert.equal(dealt, 9);
});

test("registerHitbox feeds the shared driver", () => {
  let dealt = 0;
  const handle = registerHitbox({
    center: { x: 0, y: 0, z: -4 },
    radius: 0.25,
    onHit(damage) {
      dealt += damage;
    },
  });
  try {
    const quill = createQuill();
    quill.update(0, command(true, false));
    quill.update(0.2, command(false, false));
    assert.equal(dealt, 9);
  } finally {
    handle.remove();
  }
});

test("continuous fire reuses a bounded pool and recycles the oldest slot", () => {
  const quill = fresh();
  const refs = quill.slots.slice();
  let t = 0;
  while (t < 3 - 1e-9) {
    quill.update(1 / 20, command(true, false));
    t += 1 / 20;
  }
  console.log(
    `quill pool cap ${quill.poolCap}, size ${quill.poolSize}, allocated ${quill.allocated}, shots ${quill.shotsFired}, live ${quill.liveCount}`,
  );
  assert.equal(quill.poolCap, QUILL_POOL_CAP);
  assert.equal(quill.poolSize, QUILL_POOL_CAP);
  assert.equal(quill.allocated, QUILL_POOL_CAP);
  assert.equal(quill.slots.length, refs.length);
  for (let i = 0; i < refs.length; i += 1) assert.equal(quill.slots[i], refs[i]);
  assert.ok(quill.shotsFired > quill.poolCap);
  assert.ok(quill.liveCount <= quill.poolCap);
  let maxSerial = 0;
  for (const slot of quill.slots) if (slot.serial > maxSerial) maxSerial = slot.serial;
  assert.equal(maxSerial, quill.shotsFired);

  const tight = createQuill({ hitboxes: createHitboxWorld(), poolCap: 3 });
  tight.update(0.5, command(true, false));
  assert.equal(tight.poolSize, 3);
  assert.equal(tight.allocated, 3);
  assert.equal(tight.liveCount, 3);
  assert.ok(tight.shotsFired > 3);
  const alive = tight.slots
    .filter((slot) => slot.alive)
    .map((slot) => slot.serial)
    .sort((a, b) => a - b);
  assert.deepEqual(alive, [tight.shotsFired - 2, tight.shotsFired - 1, tight.shotsFired]);
});

test("the hud ammo readout follows mag and reserve", () => {
  const player = createPlayerState();
  const quill = createQuill({ player, hitboxes: createHitboxWorld() });
  assert.equal(hudReadout(player.get(), "playing").ammo, "40+40");
  quill.update(0, command(true, false));
  assert.equal(player.get().mag, 39);
  assert.equal(player.get().reserve, 40);
  assert.equal(hudReadout(player.get(), "playing").ammo, "39+40");
  quill.update(0, command(false, true));
  let t = 0;
  while (quill.reloading && t < 3) {
    quill.update(0.05, command(false, false));
    t += 0.05;
  }
  assert.equal(player.get().mag, 40);
  assert.equal(player.get().reserve, 39);
  assert.equal(hudReadout(player.get(), "playing").ammo, "40+39");
});
