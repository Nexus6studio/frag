import assert from "node:assert/strict";
import test from "node:test";
import { Scene } from "three";
import { ATRIUM_SPAWN, GROUND_Y, createAtriumHull } from "../src/atrium.ts";
import { createFight } from "../src/fight.ts";
import {
  GORE_BLOOD,
  GORE_DECAL_CAP,
  GORE_DECAL_LIFE,
  GORE_DECAL_OFFSET,
  GORE_GIB_CAP,
  GORE_GIBS_PER_DEATH,
  GORE_SPRAY_CAP,
  GORE_SPRAY_LIFE,
  GORE_SPRAY_PER_DEATH,
} from "../src/gore.ts";
import { createHitboxWorld } from "../src/hitbox.ts";
import { mountEnforcerView } from "../src/enforcer-view.ts";
import { createEnforcerSim } from "../src/enforcer.ts";
import { createPickupSim } from "../src/pickups.ts";
import { damagePlayer } from "../src/player/hurt.ts";
import { createPlayerState } from "../src/player/state.ts";
import { createQuill } from "../src/quill.ts";
import { WISP_FLUID_COLOR, WISP_GIB_METAL, WISP_GIB_PLASTIC } from "../src/wisp.ts";

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

function aliveCount(pool) {
  let count = 0;
  for (let i = 0; i < pool.length; i += 1) if (pool[i].alive) count += 1;
  return count;
}

function readsAsBlood(hex) {
  const red = (hex >> 16) & 255;
  const green = (hex >> 8) & 255;
  const blue = hex & 255;
  return red > 90 && red > green * 1.7 && red > blue * 1.7;
}

function quiet(fight) {
  assert.equal(aliveCount(fight.enforcers.spray), 0);
  assert.equal(aliveCount(fight.enforcers.gibs), 0);
  assert.equal(aliveCount(fight.enforcers.decals), 0);
  assert.equal(aliveCount(fight.wisps.sparks), 0);
  assert.equal(aliveCount(fight.wisps.gibs), 0);
  assert.equal(aliveCount(fight.wisps.fluid), 0);
}

test("enforcer death spawns blood spray, gibs, and decals inside a fixed pool", () => {
  assert.equal(readsAsBlood(GORE_BLOOD), true);
  const player = createPlayerState();
  const hull = openHull();
  const sim = createEnforcerSim({ hull, player, hitboxes: createHitboxWorld(), grace: 0 });
  const spraySlots = sim.spray.map((slot) => slot);
  const gibSlots = sim.gibs.map((slot) => slot);
  const decalSlots = sim.decals.map((slot) => slot);
  sim.place(0, { x: 0, y: 0, z: 0 });
  sim.hurt(0, 999);
  assert.equal(sim.goreBursts, 1);
  assert.equal(aliveCount(sim.spray), GORE_SPRAY_PER_DEATH);
  assert.equal(aliveCount(sim.gibs), GORE_GIBS_PER_DEATH);
  assert.ok(aliveCount(sim.decals) >= 1);
  assert.ok(aliveCount(sim.decals) <= 4);
  const floor = sim.decals.find((slot) => slot.alive && slot.ny > 0.8);
  assert.ok(floor, "no floor decal");
  assert.ok(Math.abs(floor.y - GORE_DECAL_OFFSET) < 0.008, `decal y ${floor.y}`);
  assert.ok(Math.abs(floor.x) < 0.05 && Math.abs(floor.z) < 0.05, "decal was not snapped to the hit");
  assert.ok(Math.hypot(floor.nx, floor.ny, floor.nz) > 0.99);

  step(sim, 0.2, { x: 0, y: 0, z: -6 });
  assert.ok(floor.alive);
  assert.ok(floor.age > 0.15 && floor.age < floor.life);
  const spray = sim.spray.find((slot) => slot.alive);
  assert.ok(spray);
  assert.ok(spray.age > 0.15 && spray.age < GORE_SPRAY_LIFE);
  step(sim, GORE_DECAL_LIFE, { x: 0, y: 0, z: -6 });
  assert.equal(floor.alive, false, "decal did not return to the pool");
  assert.equal(aliveCount(sim.spray), 0);
  assert.equal(aliveCount(sim.gibs), 0);
  assert.equal(aliveCount(sim.decals), 0);

  let peakSpray = 0;
  let peakGibs = 0;
  let peakDecals = 0;
  for (let i = 0; i < 40; i += 1) {
    sim.place(0, { x: 0.2, y: 0, z: 0.1 });
    sim.hurt(0, 999);
    peakSpray = Math.max(peakSpray, aliveCount(sim.spray));
    peakGibs = Math.max(peakGibs, aliveCount(sim.gibs));
    peakDecals = Math.max(peakDecals, aliveCount(sim.decals));
  }
  assert.equal(sim.goreBursts, 41);
  assert.equal(sim.spray.length, GORE_SPRAY_CAP);
  assert.equal(sim.gibs.length, GORE_GIB_CAP);
  assert.equal(sim.decals.length, GORE_DECAL_CAP);
  assert.ok(peakSpray <= GORE_SPRAY_CAP);
  assert.ok(peakGibs <= GORE_GIB_CAP);
  assert.ok(peakDecals <= GORE_DECAL_CAP);
  assert.equal(peakSpray, GORE_SPRAY_CAP);
  assert.equal(peakDecals, GORE_DECAL_CAP);
  for (let i = 0; i < spraySlots.length; i += 1) assert.equal(sim.spray[i], spraySlots[i]);
  for (let i = 0; i < gibSlots.length; i += 1) assert.equal(sim.gibs[i], gibSlots[i]);
  for (let i = 0; i < decalSlots.length; i += 1) assert.equal(sim.decals[i], decalSlots[i]);

  const scene = new Scene();
  const view = mountEnforcerView(scene, sim);
  const before = census(scene);
  view.sync();
  for (let i = 0; i < 12; i += 1) {
    sim.place(0, { x: 0, y: 0, z: 0 });
    sim.hurt(0, 999);
    view.sync();
  }
  assert.deepEqual(census(scene), before);
  assert.equal(scene.getObjectByName("enforcer-blood") != null, true);
  assert.equal(scene.getObjectByName("enforcer-gibs") != null, true);
  assert.equal(scene.getObjectByName("enforcer-decals") != null, true);
});

test("blood decals snap to a nearby wall normal", () => {
  const hull = {
    boxes: [
      { min: { x: -8, y: -1, z: -8 }, max: { x: 8, y: 0, z: 8 } },
      { min: { x: 1.15, y: 0, z: -2 }, max: { x: 1.45, y: 3, z: 2 } },
    ],
    ramps: [],
  };
  const sim = createEnforcerSim({
    hull,
    player: createPlayerState(),
    hitboxes: createHitboxWorld(),
    grace: 0,
  });
  sim.place(0, { x: 0, y: 0, z: 0 });
  sim.hurt(0, 999);
  const wall = sim.decals.find((slot) => slot.alive && Math.abs(slot.nx) > 0.8);
  assert.ok(wall, "no wall decal");
  assert.ok(Math.abs(wall.x - (1.15 - GORE_DECAL_OFFSET)) < 0.03, `wall decal x ${wall.x}`);
  assert.ok(wall.y > 0.4 && wall.y < 1.4, `wall decal y ${wall.y}`);
});

test("drone death is sparks, metal and plastic gibs, and dark fluid", () => {
  assert.equal(readsAsBlood(WISP_FLUID_COLOR), false);
  assert.equal(readsAsBlood(WISP_GIB_METAL), false);
  assert.equal(readsAsBlood(WISP_GIB_PLASTIC), false);
  const hull = createAtriumHull();
  const player = createPlayerState({ hp: 500 });
  const fight = createFight({
    hull,
    player,
    hitboxes: createHitboxWorld(),
    origin: ATRIUM_SPAWN,
  });
  fight.wisps.hurt(0, 100);
  assert.equal(fight.wisps.drones[0].alive, false);
  assert.ok(fight.wisps.sparks.some((slot) => slot.alive), "no sparks");
  const gibs = fight.wisps.gibs.filter((slot) => slot.alive);
  assert.ok(gibs.length >= 2, "no scraps");
  assert.ok(gibs.some((slot) => slot.metal), "no metal scrap");
  assert.ok(gibs.some((slot) => slot.metal === false), "no plastic scrap");
  assert.ok(fight.wisps.fluid.some((slot) => slot.alive), "no hydraulic fluid");
  assert.equal(aliveCount(fight.enforcers.spray), 0);
  assert.equal(aliveCount(fight.enforcers.gibs), 0);
  assert.equal(aliveCount(fight.enforcers.decals), 0);
  assert.equal(fight.enforcers.goreBursts, 0);
});

test("the player, a pickup, and a shot into the atrium do not gib", () => {
  const hull = createAtriumHull();
  const hitboxes = createHitboxWorld();
  const player = createPlayerState({ hp: 40 });
  const fight = createFight({ hull, player, hitboxes, origin: ATRIUM_SPAWN });
  const quill = createQuill({ hull, player, hitboxes });
  const pickups = createPickupSim(quill);
  const health = pickups.pads.find((pad) => pad.kind === "health");
  assert.ok(health);
  pickups.step(0.2, { x: health.x, y: health.y, z: health.z }, player);
  assert.ok(player.get().hp > 40, "the health pad did not grant");
  quiet(fight);

  const origin = { x: ATRIUM_SPAWN.x, y: GROUND_Y + 1.6, z: ATRIUM_SPAWN.z };
  const down = { x: 0, y: -1, z: 0 };
  quill.update(0, { fire: true, presses: 1, reload: false, origin, direction: down });
  quill.update(0.3, { fire: false, presses: 0, reload: false, origin, direction: down });
  assert.equal(fight.enforcers.aliveCount(), 1);
  assert.equal(fight.wisps.aliveCount(), 2);
  quiet(fight);

  damagePlayer(player, 500);
  assert.equal(player.get().hp, 0);
  fight.update(1, ATRIUM_SPAWN);
  quiet(fight);
  assert.equal(fight.enforcers.goreBursts, 0);
});

test("restart clears enforcer blood and drone scraps", () => {
  const hull = createAtriumHull();
  const player = createPlayerState({ hp: 500 });
  const fight = createFight({
    hull,
    player,
    hitboxes: createHitboxWorld(),
    origin: ATRIUM_SPAWN,
  });
  const index = fight.enforcers.units.findIndex((unit) => unit.alive);
  fight.enforcers.hurt(index, 999);
  fight.wisps.hurt(0, 100);
  assert.ok(aliveCount(fight.enforcers.spray) > 0);
  assert.ok(aliveCount(fight.enforcers.gibs) > 0);
  assert.ok(aliveCount(fight.enforcers.decals) > 0);
  assert.ok(aliveCount(fight.wisps.sparks) > 0);
  assert.ok(aliveCount(fight.wisps.gibs) > 0);
  assert.ok(aliveCount(fight.wisps.fluid) > 0);
  const spray = fight.enforcers.spray;
  const gibs = fight.enforcers.gibs;
  const decals = fight.enforcers.decals;
  fight.wisps.restart(ATRIUM_SPAWN);
  assert.equal(fight.enforcers.spray, spray);
  assert.equal(fight.enforcers.gibs, gibs);
  assert.equal(fight.enforcers.decals, decals);
  quiet(fight);
  assert.equal(fight.wisps.wave, 1);
});

test("the visor slit is amber-red and a shot draws a muzzle flash plus a tracer", () => {
  const player = createPlayerState({ hp: 400 });
  const sim = createEnforcerSim({
    hull: openHull(),
    player,
    hitboxes: createHitboxWorld(),
    grace: 0,
  });
  sim.place(0, { x: 0, y: 0, z: 0 });
  const scene = new Scene();
  const view = mountEnforcerView(scene, sim);
  view.sync();
  const visor = scene.getObjectByName("enforcer-visor");
  assert.ok(visor);
  assert.equal(visor.material.color.getHex(), 0xff4a1a);
  assert.equal(visor.material.fog, false);
  assert.equal(visor.material.toneMapped, false);

  step(sim, 0.05, { x: 0, y: 0, z: -6 });
  const flash = sim.flashes.find((slot) => slot.alive);
  assert.ok(flash, "no muzzle flash");
  assert.ok(flash.life > 0 && flash.life <= 0.2, `flash life ${flash.life}`);
  assert.ok(flash.length > 1, `tracer length ${flash.length}`);
  view.sync();
  const tracers = scene.getObjectByName("enforcer-tracer");
  assert.equal(tracers.count, 2);
});

function census(scene) {
  const geometries = new Set();
  const textures = new Set();
  let nodes = 0;
  scene.traverse((obj) => {
    nodes += 1;
    if (obj.geometry) geometries.add(obj.geometry);
    const materials = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (let i = 0; i < materials.length; i += 1) {
      for (const value of Object.values(materials[i])) {
        if (value && value.isTexture) textures.add(value);
      }
    }
  });
  return {
    children: scene.children.length,
    nodes,
    geometries: geometries.size,
    textures: textures.size,
  };
}
