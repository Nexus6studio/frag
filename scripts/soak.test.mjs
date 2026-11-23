import assert from "node:assert/strict";
import test from "node:test";
import { PerspectiveCamera, Scene } from "three";
import {
  ATRIUM_SPAWN,
  CEILING_Y,
  KILL_Y,
  MAP_HALF,
  createAtriumHull,
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
  createMover,
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
  createWispSim,
  wispInsideVolume,
} from "../src/wisp.ts";
import { mountWispView } from "../src/wisp-view.ts";
import { DRONE_CAP } from "../src/waves.ts";

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
  const wisps = createWispSim({ hull, player, hitboxes, origin: ATRIUM_SPAWN });
  let mover = createMover(hull, createMoveState(ATRIUM_SPAWN));

  const scene = new Scene();
  const atrium = addAtrium(scene);
  const camera = new PerspectiveCamera(50, 16 / 9, 0.08, 80);
  camera.position.set(ATRIUM_SPAWN.x, ATRIUM_SPAWN.y + EYE_HEIGHT, ATRIUM_SPAWN.z);
  camera.rotation.order = "YXZ";
  camera.lookAt(ATRIUM_SPAWN.x, ATRIUM_SPAWN.y + EYE_HEIGHT, ATRIUM_SPAWN.z - 1);
  const look = createLook(camera);
  const quillView = mountQuillView(scene, camera, quill, null);
  const wispView = mountWispView(scene, wisps);

  const aim = { x: 0, y: 0, z: -1 };
  const muzzle = { x: 0, y: 0, z: 0 };
  const command = { fire: true, reload: false, origin: muzzle, direction: aim };
  const eye = { x: 0, y: 0, z: 0 };
  const previous = wisps.drones.map((drone) => ({
    x: drone.position.x,
    y: drone.position.y,
    z: drone.position.z,
  }));
  const restartMarks = new Set(
    [0.04, 0.12, 0.28, 0.55, 0.8].map((fraction) => Math.floor(STEPS * fraction)),
  );

  let restarts = 0;
  let baseline = null;
  let maxDrones = 0;
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
    mover = createMover(hull, createMoveState(ATRIUM_SPAWN));
    for (let i = 0; i < wisps.drones.length; i += 1) {
      previous[i].x = wisps.drones[i].position.x;
      previous[i].y = wisps.drones[i].position.y;
      previous[i].z = wisps.drones[i].position.z;
    }
    restarts += 1;
    assert.equal(player.get().hp, 100, `${reason} restart hp`);
    assert.equal(wisps.wave, 1, `${reason} restart wave`);
    assert.equal(quill.poolSize, QUILL_POOL_CAP, `${reason} flechette pool grew`);
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
    if (player.get().hp <= 0) restart("death");
    if (restartMarks.has(step)) {
      player.set({ hp: 0 });
      restart("scripted");
    }

    look.apply(2, Math.sin(step / 80) * 0.4);
    const ammoDry = quill.mag <= 0 && quill.reserve <= 0;
    const pad = ammoDry ? nearestAmmo(mover.state.position, pickups.pads) : null;
    const yaw = pad ? yawToward(mover.state.position, pad) : look.yaw;
    mover.advance(SIM_DT, {
      forward: 1,
      strafe: Math.sin(step / 90) > 0 ? 1 : -1,
      jump: step % 480 === 0,
      yawDeg: yaw,
    });
    if (needsRespawn(mover.state.position)) {
      mover = createMover(hull, createMoveState(ATRIUM_SPAWN));
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
    aimAt(eye, wisps.drones, previous, aim, look);
    muzzleOrigin(eye, aim, muzzle);
    if (player.get().hp > 0) {
      quill.update(SIM_DT, command);
      wisps.update(SIM_DT, body.position);
    }
    syncPadViews(atrium.pads, pickups.pads);
    quillView.sync();
    wispView.sync();
    for (let i = 0; i < wisps.drones.length; i += 1) {
      previous[i].x = wisps.drones[i].position.x;
      previous[i].y = wisps.drones[i].position.y;
      previous[i].z = wisps.drones[i].position.z;
    }

    assert.equal(quill.poolSize, QUILL_POOL_CAP);
    assert.equal(quill.allocated, QUILL_POOL_CAP);
    assert.ok(quill.liveCount <= QUILL_POOL_CAP);
    assert.equal(wisps.bolts.length, WISP_BOLT_CAP);
    assert.equal(wisps.sparks.length, WISP_SPARK_CAP);
    assert.equal(wisps.gibs.length, WISP_GIB_CAP);
    assert.equal(wisps.fluid.length, WISP_FLUID_CAP);
    assert.equal(wisps.drones.length, DRONE_CAP);
    assert.ok(wisps.aliveCount() <= DRONE_CAP);
    maxDrones = Math.max(maxDrones, wisps.aliveCount());
    maxWave = Math.max(maxWave, wisps.wave);

    for (let i = 0; i < wisps.drones.length; i += 1) {
      const drone = wisps.drones[i];
      finiteVec(drone.position, `drone ${i}`);
      if (!drone.alive) continue;
      assert.equal(wispInsideVolume(drone.position), true, `drone escaped ${fmt(drone.position)}`);
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
    assertPoolInside(wisps.gibs, "gib");
    assertPoolInside(wisps.fluid, "fluid");

    const vitals = player.get();
    finite(vitals.hp, "hp");
    finite(vitals.armor, "armor");
    finite(vitals.mag, "mag");
    finite(vitals.reserve, "reserve");
    assert.ok(vitals.hp >= 0 && vitals.hp <= 100, `hp ${vitals.hp}`);
    assert.ok(vitals.armor >= 0, `armor ${vitals.armor}`);
    assert.ok(vitals.mag >= 0 && vitals.mag <= QUILL_MAG, `mag ${vitals.mag}`);
    assert.ok(vitals.reserve >= 0 && vitals.reserve <= QUILL_RESERVE_CAP, `reserve ${vitals.reserve}`);
    const hud = hudReadout(vitals, "playing");
    assert.match(hud.hp, /^(100|[1-9]?\d)$/);
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
        flechettes: quill.liveCount,
        bolts: wisps.bolts.filter((bolt) => bolt.alive).length,
      });
    }
  }

  assert.ok(restarts >= 5, `death restarts ${restarts}`);
  assert.ok(maxWave >= 3, `waves did not cycle (max wave ${maxWave})`);
  assert.ok(maxDrones >= 2 && maxDrones <= DRONE_CAP, `drone count ${maxDrones}`);
  assert.ok(baseline, "no memory sample");
  console.log(
    `soak ${SOAK_SECONDS}s restarts ${restarts} maxWave ${maxWave} maxDrones ${maxDrones} geometries ${baseline.geometries} textures ${baseline.textures} sceneChildren ${baseline.children} nodes ${baseline.nodes} samples ${samples.length}`,
  );
});

function aimAt(origin, drones, previous, out, look) {
  let bestD = Infinity;
  let dx = 0;
  let dy = 0;
  let dz = 0;
  for (let i = 0; i < drones.length; i += 1) {
    const drone = drones[i];
    if (!drone.alive) continue;
    const prior = previous[i];
    const vx = (drone.position.x - prior.x) / SIM_DT;
    const vy = (drone.position.y - prior.y) / SIM_DT;
    const vz = (drone.position.z - prior.z) / SIM_DT;
    const ox = drone.position.x - origin.x;
    const oy = drone.position.y - origin.y;
    const oz = drone.position.z - origin.z;
    const dist = Math.hypot(ox, oy, oz);
    if (dist < bestD) {
      bestD = dist;
      const lead = dist / 70;
      dx = ox + vx * lead;
      dy = oy + vy * lead;
      dz = oz + vz * lead;
    }
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

function nearestAmmo(position, pads) {
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < pads.length; i += 1) {
    const pad = pads[i];
    if (pad.kind !== "ammo" || pad.cooldown > 0) continue;
    const dist = Math.hypot(pad.x - position.x, pad.z - position.z);
    if (dist < bestD) {
      bestD = dist;
      best = pad;
    }
  }
  return best;
}

function yawToward(from, pad) {
  const dx = pad.x - from.x;
  const dz = pad.z - from.z;
  return (Math.atan2(-dx, -dz) * 180) / Math.PI;
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
