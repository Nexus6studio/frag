import assert from "node:assert/strict";
import test from "node:test";
import { PerspectiveCamera, Scene } from "three";
import {
  ATRIUM_SPAWN,
  CEILING_Y,
  KILL_Y,
  MAP_HALF,
  createAtriumHull,
  createAtriumMover,
  needsRespawn,
} from "../src/atrium.ts";
import { restartCombat } from "../src/combat.ts";
import { addAtrium, syncPadViews } from "../src/floor.ts";
import { createHitboxWorld } from "../src/hitbox.ts";
import { hudReadout } from "../src/hud/model.ts";
import { createLook } from "../src/look.ts";
import {
  CAPSULE_HEIGHT,
  EYE_HEIGHT,
  SIM_DT,
  createMoveState,
} from "../src/move.ts";
import { createPickupSim } from "../src/pickups.ts";
import { createPlayerState } from "../src/player/state.ts";
import { QUILL_MAG, QUILL_POOL_CAP, QUILL_RESERVE_CAP, aimDirection, createQuill, muzzleOrigin } from "../src/quill.ts";
import { mountQuillView } from "../src/quill-view.ts";
import {
  WISP_BOLT_CAP,
  WISP_FLUID_CAP,
  WISP_GIB_CAP,
  WISP_SPARK_CAP,
  wispInsideVolume,
} from "../src/wisp.ts";
import { mountWispView } from "../src/wisp-view.ts";
import { createFight } from "../src/fight.ts";
import {
  ENFORCER_FLASH_CAP,
  ENFORCER_SPARK_CAP,
  enforcerInsideVolume,
} from "../src/enforcer.ts";
import { GORE_DECAL_CAP, GORE_GIB_CAP, GORE_SPRAY_CAP } from "../src/gore.ts";
import { mountEnforcerView } from "../src/enforcer-view.ts";
import { RUSHER_TRAIL_CAP, rusherInsideVolume } from "../src/rusher.ts";
import { mountRusherView } from "../src/rusher-view.ts";
import { DRONE_CAP, ENFORCER_CAP, RUSHER_CAP } from "../src/waves.ts";

const SOAK_SECONDS = 20 * 60;
const STEPS = Math.round(SOAK_SECONDS / SIM_DT);
const WARMUP_STEPS = Math.round(10 / SIM_DT);

test("early-release soak stays bounded for a scripted fight", { timeout: 600_000 }, () => {
  assert.equal(SOAK_SECONDS, 20 * 60);
  const hull = createAtriumHull();
  const player = createPlayerState();
  const hitboxes = createHitboxWorld();
  const quill = createQuill({ hull, player, hitboxes });
  const pickups = createPickupSim(quill);
  const fight = createFight({ hull, player, hitboxes, origin: ATRIUM_SPAWN });
  const wisps = fight.wisps;
  const enforcers = fight.enforcers;
  const rushers = fight.rushers;
  let mover = createAtriumMover(createMoveState(ATRIUM_SPAWN));

  const scene = new Scene();
  const atrium = addAtrium(scene);
  const camera = new PerspectiveCamera(50, 16 / 9, 0.08, 80);
  camera.position.set(ATRIUM_SPAWN.x, ATRIUM_SPAWN.y + EYE_HEIGHT, ATRIUM_SPAWN.z);
  camera.rotation.order = "YXZ";
  camera.lookAt(ATRIUM_SPAWN.x, ATRIUM_SPAWN.y + EYE_HEIGHT, ATRIUM_SPAWN.z - 1);
  const look = createLook(camera);
  const quillView = mountQuillView(scene, camera, quill, null);
  const wispView = mountWispView(scene, wisps);
  const enforcerView = mountEnforcerView(scene, enforcers);
  const rusherView = mountRusherView(scene, rushers);

  const aim = { x: 0, y: 0, z: -1 };
  const muzzle = { x: 0, y: 0, z: 0 };
  const command = { fire: true, reload: false, origin: muzzle, direction: aim };
  const eye = { x: 0, y: 0, z: 0 };
  const previous = wisps.drones.map((drone) => ({
    x: drone.position.x,
    y: drone.position.y,
    z: drone.position.z,
  }));
  const previousHounds = enforcers.units.map((unit) => ({
    x: unit.position.x,
    y: unit.position.y,
    z: unit.position.z,
  }));
  const previousRushers = rushers.units.map((unit) => ({
    x: unit.position.x,
    y: unit.position.y,
    z: unit.position.z,
  }));
  const restartMarks = new Set(
    [0.04, 0.12, 0.28, 0.55, 0.8].map((fraction) => Math.floor(STEPS * fraction)),
  );

  let restarts = 0;
  let baseline = null;
  let maxDrones = 0;
  let maxEnforcers = 0;
  let maxWave = 1;
  const samples = [];

  function restart(reason) {
    restartCombat({
      player,
      quill,
      pickups,
      wisps,
      origin: ATRIUM_SPAWN,
    });
    mover = createAtriumMover(createMoveState(ATRIUM_SPAWN));
    for (let i = 0; i < wisps.drones.length; i += 1) {
      previous[i].x = wisps.drones[i].position.x;
      previous[i].y = wisps.drones[i].position.y;
      previous[i].z = wisps.drones[i].position.z;
    }
    for (let i = 0; i < enforcers.units.length; i += 1) {
      previousHounds[i].x = enforcers.units[i].position.x;
      previousHounds[i].y = enforcers.units[i].position.y;
      previousHounds[i].z = enforcers.units[i].position.z;
    }
    for (let i = 0; i < rushers.units.length; i += 1) {
      previousRushers[i].x = rushers.units[i].position.x;
      previousRushers[i].y = rushers.units[i].position.y;
      previousRushers[i].z = rushers.units[i].position.z;
    }
    restarts += 1;
    assert.equal(player.get().hp, 100, `${reason} restart hp`);
    assert.equal(wisps.wave, 1, `${reason} restart wave`);
    assert.equal(quill.poolSize, QUILL_POOL_CAP, `${reason} flechette pool grew`);
    assert.ok(enforcers.spray.every((slot) => slot.alive === false), `${reason} blood spray survived restart`);
    assert.ok(enforcers.gibs.every((slot) => slot.alive === false), `${reason} blood gibs survived restart`);
    assert.ok(enforcers.decals.every((slot) => slot.alive === false), `${reason} blood decals survived restart`);
    assert.ok(rushers.spray.every((slot) => slot.alive === false), `${reason} rusher blood spray survived restart`);
    assert.ok(rushers.gibs.every((slot) => slot.alive === false), `${reason} rusher gibs survived restart`);
    assert.ok(rushers.decals.every((slot) => slot.alive === false), `${reason} rusher decals survived restart`);
    assert.ok(wisps.sparks.every((slot) => slot.alive === false), `${reason} drone sparks survived restart`);
    assert.ok(wisps.gibs.every((slot) => slot.alive === false), `${reason} drone gibs survived restart`);
    assert.ok(wisps.fluid.every((slot) => slot.alive === false), `${reason} drone fluid survived restart`);
  }

  function finite(value, label) {
    assert.equal(Number.isFinite(value), true, `${label} is ${value}`);
  }

  function finiteVec(vec, label) {
    finite(vec.x, `${label}.x`);
    finite(vec.y, `${label}.y`);
    finite(vec.z, `${label}.z`);
  }

  for (let step = 0; step < STEPS; step += 1) {
    // A downed runner used to reset the wave. The enforcer makes that reset
    // starve the cycle, so a death refills HP and the scripted restarts below
    // are what prove the pools come back clean.
    if (player.get().hp <= 0) player.set({ hp: 100, armor: 0 });
    if (restartMarks.has(step)) {
      player.set({ hp: 0 });
      restart("scripted");
    }

    look.apply(2, Math.sin(step / 80) * 0.4);
    const ammoDry = quill.mag <= 0 && quill.reserve <= 0;
    const pad = ammoDry
      ? nearestPad(mover.state.position, pickups.pads, "ammo")
      : player.get().hp <= 50
        ? nearestPad(mover.state.position, pickups.pads, "health")
        : null;
    // Planting on a drone inside 16 m stalls once the wave 1 enforcer is gone:
    // the drone orbits behind a hull and the hold never breaks. Keep walking
    // unless an enforcer is in that range. The enforcer still gets the plant,
    // because it is what blocks the wave.
    const houndNear = threatNear(mover.state.position, [], enforcers.units, rushers.units, 16);
    const engaged = !pad && houndNear;
    const yaw = pad ? yawToward(mover.state.position, pad) : look.yaw;
    mover.advance(SIM_DT, {
      forward: engaged ? 0 : 1,
      strafe: engaged ? 0 : Math.sin(step / 90) > 0 ? 1 : -1,
      jump: !engaged && step % 480 === 0,
      yawDeg: yaw,
    });
    if (needsRespawn(mover.state.position)) {
      mover = createAtriumMover(createMoveState(ATRIUM_SPAWN));
    }

    const body = mover.state;
    finiteVec(body.position, "player position");
    finiteVec(body.velocity, "player velocity");
    assert.equal(needsRespawn(body.position), false, `player escaped ${fmt(body.position)}`);
    assert.ok(body.position.y + CAPSULE_HEIGHT <= CEILING_Y + 0.05, `player head ${body.position.y}`);
    assert.ok(body.position.y >= KILL_Y, `player below the kill volume ${body.position.y}`);

    if (player.get().hp > 0) pickups.step(SIM_DT, body.position, player);
    eye.x = body.position.x;
    eye.y = body.position.y + EYE_HEIGHT;
    eye.z = body.position.z;
    aimAt(eye, wisps.drones, previous, enforcers.units, previousHounds, rushers.units, previousRushers, aim, look);
    muzzleOrigin(eye, aim, muzzle);
    if (player.get().hp > 0) {
      quill.update(SIM_DT, command);
      fight.update(SIM_DT, body.position);
    }
    syncPadViews(atrium.pads, pickups.pads);
    quillView.sync();
    wispView.sync();
    enforcerView.sync();
    rusherView.sync();
    for (let i = 0; i < wisps.drones.length; i += 1) {
      previous[i].x = wisps.drones[i].position.x;
      previous[i].y = wisps.drones[i].position.y;
      previous[i].z = wisps.drones[i].position.z;
    }
    for (let i = 0; i < enforcers.units.length; i += 1) {
      previousHounds[i].x = enforcers.units[i].position.x;
      previousHounds[i].y = enforcers.units[i].position.y;
      previousHounds[i].z = enforcers.units[i].position.z;
    }
    for (let i = 0; i < rushers.units.length; i += 1) {
      previousRushers[i].x = rushers.units[i].position.x;
      previousRushers[i].y = rushers.units[i].position.y;
      previousRushers[i].z = rushers.units[i].position.z;
    }

    assert.equal(quill.poolSize, QUILL_POOL_CAP);
    assert.equal(quill.allocated, QUILL_POOL_CAP);
    assert.ok(quill.liveCount <= QUILL_POOL_CAP);
    assert.equal(wisps.bolts.length, WISP_BOLT_CAP);
    assert.equal(wisps.sparks.length, WISP_SPARK_CAP);
    assert.equal(wisps.gibs.length, WISP_GIB_CAP);
    assert.equal(wisps.fluid.length, WISP_FLUID_CAP);
    assert.equal(wisps.drones.length, DRONE_CAP);
    assert.equal(enforcers.units.length, ENFORCER_CAP);
    assert.equal(enforcers.sparks.length, ENFORCER_SPARK_CAP);
    assert.equal(enforcers.flashes.length, ENFORCER_FLASH_CAP);
    assert.equal(enforcers.spray.length, GORE_SPRAY_CAP);
    assert.equal(enforcers.gibs.length, GORE_GIB_CAP);
    assert.equal(enforcers.decals.length, GORE_DECAL_CAP);
    assert.ok(aliveCount(enforcers.spray) <= GORE_SPRAY_CAP);
    assert.ok(aliveCount(enforcers.gibs) <= GORE_GIB_CAP);
    assert.ok(aliveCount(enforcers.decals) <= GORE_DECAL_CAP);
    assert.ok(wisps.aliveCount() <= DRONE_CAP);
    assert.ok(enforcers.aliveCount() <= ENFORCER_CAP);
    assert.equal(rushers.units.length, RUSHER_CAP);
    assert.equal(rushers.trails.length, RUSHER_TRAIL_CAP);
    assert.equal(rushers.spray.length, GORE_SPRAY_CAP);
    assert.equal(rushers.gibs.length, GORE_GIB_CAP);
    assert.equal(rushers.decals.length, GORE_DECAL_CAP);
    assert.ok(rushers.aliveCount() <= RUSHER_CAP);
    assert.ok(wisps.aliveCount() + enforcers.aliveCount() + rushers.aliveCount() <= DRONE_CAP + ENFORCER_CAP + RUSHER_CAP);
    maxDrones = Math.max(maxDrones, wisps.aliveCount());
    maxEnforcers = Math.max(maxEnforcers, enforcers.aliveCount());
    maxWave = Math.max(maxWave, wisps.wave);

    for (let i = 0; i < wisps.drones.length; i += 1) {
      const drone = wisps.drones[i];
      finiteVec(drone.position, `drone ${i}`);
      if (!drone.alive) continue;
      assert.equal(wispInsideVolume(drone.position), true, `drone escaped ${fmt(drone.position)}`);
    }
    for (let i = 0; i < enforcers.units.length; i += 1) {
      const unit = enforcers.units[i];
      finiteVec(unit.position, `enforcer ${i}`);
      if (!unit.alive) continue;
      assert.equal(enforcerInsideVolume(unit.position), true, `enforcer escaped ${fmt(unit.position)}`);
    }
    for (let i = 0; i < rushers.units.length; i += 1) {
      const unit = rushers.units[i];
      finiteVec(unit.position, `rusher ${i}`);
      if (!unit.alive) continue;
      assert.equal(rusherInsideVolume(unit.position), true, `rusher escaped ${fmt(unit.position)}`);
    }
    for (let i = 0; i < wisps.bolts.length; i += 1) {
      const bolt = wisps.bolts[i];
      if (!bolt.alive) continue;
      finite(bolt.x, "bolt x");
      finite(bolt.y, "bolt y");
      finite(bolt.z, "bolt z");
      finite(bolt.dx, "bolt dx");
      finite(bolt.dy, "bolt dy");
      finite(bolt.dz, "bolt dz");
      assert.equal(
        wispInsideVolume({ x: bolt.x, y: bolt.y, z: bolt.z }, 0),
        true,
        `bolt escaped ${bolt.x} ${bolt.y} ${bolt.z}`,
      );
    }
    for (let i = 0; i < quill.slots.length; i += 1) {
      const slot = quill.slots[i];
      if (!slot.alive) continue;
      finite(slot.x, "flechette x");
      finite(slot.y, "flechette y");
      finite(slot.z, "flechette z");
      assert.ok(Math.abs(slot.x) <= MAP_HALF + 1, `flechette x ${slot.x}`);
      assert.ok(Math.abs(slot.z) <= MAP_HALF + 1, `flechette z ${slot.z}`);
      assert.ok(slot.y >= KILL_Y && slot.y <= CEILING_Y + 1, `flechette y ${slot.y}`);
    }
    assertPoolInside(wisps.sparks, "spark");
    assertPoolInside(enforcers.sparks, "enforcer spark");
    assertPoolInside(wisps.gibs, "gib");
    assertPoolInside(wisps.fluid, "fluid");
    assertPoolInside(enforcers.spray, "blood spray");
    assertPoolInside(enforcers.gibs, "blood gib");
    assertDecalsInside(enforcers.decals);

    const vitals = player.get();
    finite(vitals.hp, "hp");
    finite(vitals.armor, "armor");
    finite(vitals.mag, "mag");
    finite(vitals.reserve, "reserve");
    assert.ok(vitals.hp >= 0 && vitals.hp <= 100, `hp ${vitals.hp}`);
    assert.ok(vitals.armor >= 0 && vitals.armor <= 100, `armor ${vitals.armor}`);
    assert.ok(vitals.mag >= 0 && vitals.mag <= QUILL_MAG, `mag ${vitals.mag}`);
    assert.ok(vitals.reserve >= 0 && vitals.reserve <= QUILL_RESERVE_CAP, `reserve ${vitals.reserve}`);
    const hud = hudReadout(vitals, "playing");
    assert.match(hud.hp, /^(100|[1-9]?\d)$/);
    assert.match(hud.armor, /^(100|[1-9]?\d)$/);
    assert.equal(hud.showArmor, true);
    assert.match(hud.ammo, /^\d+\+\d+$/);

    if (step >= WARMUP_STEPS && step % 1200 === 0) {
      const census = memoryCensus(scene);
      if (!baseline) baseline = census;
      else {
        assert.equal(census.children, baseline.children, "scene child count grew");
        assert.equal(census.nodes, baseline.nodes, "scene graph grew");
        assert.equal(census.geometries, baseline.geometries, "renderer memory geometries grew");
        assert.equal(census.textures, baseline.textures, "renderer memory textures grew");
      }
      samples.push({
        t: Math.round((step * SIM_DT) / 60),
        ...census,
        wave: wisps.wave,
        drones: wisps.aliveCount(),
        enforcers: enforcers.aliveCount(),
        flechettes: quill.liveCount,
        bolts: wisps.bolts.filter((bolt) => bolt.alive).length,
      });
    }
  }

  assert.ok(restarts >= 5, `death restarts ${restarts}`);
  assert.ok(maxWave >= 3, `waves did not cycle (max wave ${maxWave})`);
  assert.ok(maxDrones >= 2 && maxDrones <= DRONE_CAP, `drone count ${maxDrones}`);
  assert.ok(maxEnforcers >= 1 && maxEnforcers <= ENFORCER_CAP, `enforcer count ${maxEnforcers}`);
  assert.ok(baseline, "no memory sample");
  assert.ok(enforcers.goreBursts >= 2, `gore bursts ${enforcers.goreBursts}`);
  console.log(
    `soak ${SOAK_SECONDS}s restarts ${restarts} maxWave ${maxWave} maxDrones ${maxDrones} maxEnforcers ${maxEnforcers} goreBursts ${enforcers.goreBursts} geometries ${baseline.geometries} textures ${baseline.textures} sceneChildren ${baseline.children} nodes ${baseline.nodes} samples ${samples.length}`,
  );
});

function aimAt(origin, drones, previous, hounds, previousHounds, flankers, previousFlankers, out, look) {
  let bestD = Infinity;
  let dx = 0;
  let dy = 0;
  let dz = 0;
  const consider = (alive, x, y, z, px, py, pz, chest, bias) => {
    if (!alive) return;
    const vx = (x - px) / SIM_DT;
    const vy = (y - py) / SIM_DT;
    const vz = (z - pz) / SIM_DT;
    const ox = x - origin.x;
    const oy = y + chest - origin.y;
    const oz = z - origin.z;
    const dist = Math.hypot(ox, oy, oz);
    // The enforcer blocks the wave and soaks more flechettes. Prefer it while
    // it is anywhere the carbine can reach, then go back to the nearest drone.
    if (dist - bias < bestD) {
      bestD = dist - bias;
      const lead = dist / 70;
      dx = ox + vx * lead;
      dy = oy + vy * lead;
      dz = oz + vz * lead;
    }
  };
  let houndAlive = false;
  for (let i = 0; i < hounds.length; i += 1) if (hounds[i].alive) houndAlive = true;
  for (let i = 0; i < flankers.length; i += 1) if (flankers[i].alive) houndAlive = true;
  if (!houndAlive) {
    for (let i = 0; i < drones.length; i += 1) {
      const drone = drones[i];
      const prior = previous[i];
      consider(drone.alive, drone.position.x, drone.position.y, drone.position.z, prior.x, prior.y, prior.z, 0, 0);
    }
  }
  for (let i = 0; i < hounds.length; i += 1) {
    const unit = hounds[i];
    const prior = previousHounds[i];
    consider(unit.alive, unit.position.x, unit.position.y, unit.position.z, prior.x, prior.y, prior.z, 0.95, 0);
  }
  for (let i = 0; i < flankers.length; i += 1) {
    const unit = flankers[i];
    const prior = previousFlankers[i];
    consider(unit.alive, unit.position.x, unit.position.y, unit.position.z, prior.x, prior.y, prior.z, 0.9, 0);
  }
  const len = Math.hypot(dx, dy, dz);
  if (!(bestD < Infinity) || len < 1e-4) {
    aimDirection(look.yaw, look.pitch, out);
    return;
  }
  const inv = 1 / len;
  out.x = dx * inv;
  out.y = dy * inv;
  out.z = dz * inv;
}

function nearestPad(position, pads, kind) {
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < pads.length; i += 1) {
    const pad = pads[i];
    if (pad.kind !== kind || pad.cooldown > 0) continue;
    const dist = Math.hypot(pad.x - position.x, pad.z - position.z);
    if (dist < bestD) {
      bestD = dist;
      best = pad;
    }
  }
  return best;
}

function threatNear(position, drones, hounds, flankers, reach) {
  for (let i = 0; i < hounds.length; i += 1) {
    const unit = hounds[i];
    if (!unit.alive) continue;
    if (Math.hypot(unit.position.x - position.x, unit.position.z - position.z) < reach) return true;
  }
  for (let i = 0; i < flankers.length; i += 1) {
    const unit = flankers[i];
    if (!unit.alive) continue;
    if (Math.hypot(unit.position.x - position.x, unit.position.z - position.z) < reach) return true;
  }
  for (let i = 0; i < drones.length; i += 1) {
    const drone = drones[i];
    if (!drone.alive) continue;
    if (Math.hypot(drone.position.x - position.x, drone.position.z - position.z) < reach) return true;
  }
  return false;
}

function yawToward(from, pad) {
  const dx = pad.x - from.x;
  const dz = pad.z - from.z;
  return (Math.atan2(-dx, -dz) * 180) / Math.PI;
}

function aliveCount(pool) {
  let count = 0;
  for (let i = 0; i < pool.length; i += 1) if (pool[i].alive) count += 1;
  return count;
}

function assertDecalsInside(pool) {
  for (let i = 0; i < pool.length; i += 1) {
    const slot = pool[i];
    if (!slot.alive) continue;
    assert.equal(Number.isFinite(slot.x) && Number.isFinite(slot.y) && Number.isFinite(slot.z), true, "decal");
    assert.equal(Number.isFinite(slot.nx) && Number.isFinite(slot.ny) && Number.isFinite(slot.nz), true, "decal normal");
    const len = Math.hypot(slot.nx, slot.ny, slot.nz);
    assert.ok(len > 0.9 && len < 1.1, `decal normal ${len}`);
    const inside =
      Math.abs(slot.x) <= MAP_HALF + 0.2 &&
      Math.abs(slot.z) <= MAP_HALF + 0.2 &&
      slot.y >= KILL_Y &&
      slot.y <= CEILING_Y;
    assert.equal(inside, true, `decal escaped ${slot.x} ${slot.y} ${slot.z}`);
    assert.ok(slot.age >= 0 && slot.age <= slot.life + 1e-4, `decal age ${slot.age}`);
  }
}

function assertPoolInside(pool, label) {
  for (let i = 0; i < pool.length; i += 1) {
    const slot = pool[i];
    if (!slot.alive) continue;
    assert.equal(Number.isFinite(slot.x) && Number.isFinite(slot.y) && Number.isFinite(slot.z), true, label);
    assert.equal(Number.isFinite(slot.vx) && Number.isFinite(slot.vy) && Number.isFinite(slot.vz), true, `${label} velocity`);
    const inside =
      Math.abs(slot.x) <= MAP_HALF &&
      Math.abs(slot.z) <= MAP_HALF &&
      slot.y >= KILL_Y &&
      slot.y <= CEILING_Y;
    assert.equal(inside, true, `${label} escaped ${slot.x} ${slot.y} ${slot.z}`);
  }
}

function memoryCensus(scene) {
  const geometries = new Set();
  const textures = new Set();
  let nodes = 0;
  scene.traverse((obj) => {
    nodes += 1;
    if (obj.geometry) geometries.add(obj.geometry);
    const materials = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (let i = 0; i < materials.length; i += 1) {
      const material = materials[i];
      for (const value of Object.values(material)) {
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

function fmt(v) {
  return `${v.x.toFixed(2)} ${v.y.toFixed(2)} ${v.z.toFixed(2)}`;
}
