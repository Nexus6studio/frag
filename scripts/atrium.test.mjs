import assert from "node:assert/strict";
import test from "node:test";
import {
  ATRIUM_PADS,
  ATRIUM_RAMPS,
  ATRIUM_SPAWN,
  ATRIUM_STAIRS,
  CATWALK_Y,
  CONCOURSE,
  GROUND_Y,
  KILL_Y,
  MAP_HALF,
  PARAPET_Y,
  RING_INNER,
  WELL_HALF,
  capsuleClear,
  createAtriumHull,
  needsRespawn,
  onGroundRing,
  stepAtrium,
} from "../src/atrium.ts";
import { SIM_DT, createMoveState, planarSpeedOf } from "../src/move.ts";
import { traceRay, traceSegment } from "../src/trace.ts";

const hull = createAtriumHull();
const still = { forward: 0, strafe: 0, jump: false, yawDeg: 0 };

function yawToward(from, to) {
  return (Math.atan2(-(to.x - from.x), -(to.z - from.z)) * 180) / Math.PI;
}

function reached(state, wp) {
  const dist = Math.hypot(state.position.x - wp.x, state.position.z - wp.z);
  if (dist > (wp.radius ?? 0.85)) return false;
  if (wp.minY !== undefined && state.position.y < wp.minY) return false;
  if (wp.maxY !== undefined && state.position.y > wp.maxY) return false;
  return true;
}

function shouldJump(state, wp) {
  if (!state.grounded || state.position.y > 0.35) return false;
  if (wp.z > -5 && wp.z < 5 && Math.abs(wp.x) < 5) return false;
  if (planarSpeedOf(state.velocity) < 6.5) return false;
  const { x, z } = state.position;
  if (wp.z < -WELL_HALF && z < -3.15 && z > -4.6) return true;
  if (wp.z > WELL_HALF && z > 3.15 && z < 4.6) return true;
  if (wp.x > WELL_HALF && x > 3.15 && x < 4.6) return true;
  if (wp.x < -WELL_HALF && x < -3.15 && x > -4.6) return true;
  return false;
}

function drive(start, wp) {
  let state = start;
  const limit = Math.round((wp.seconds ?? 14) / SIM_DT);
  let best = Infinity;
  const trail = [];
  for (let i = 0; i < limit; i += 1) {
    if (reached(state, wp)) return { state, trail };
    const dist = Math.hypot(state.position.x - wp.x, state.position.z - wp.z);
    if (dist < best) best = dist;
    if (i % 40 === 0) {
      trail.push(
        `${state.position.x.toFixed(1)},${state.position.y.toFixed(1)},${state.position.z.toFixed(1)}`,
      );
    }
    state = stepAtrium(state, {
      forward: 1,
      strafe: 0,
      jump: shouldJump(state, wp),
      yawDeg: yawToward(state.position, wp),
    }, SIM_DT);
    if (needsRespawn(state.position) && (state.position.x !== ATRIUM_SPAWN.x || state.position.z !== ATRIUM_SPAWN.z)) {
      break;
    }
  }
  const here = state.position;
  throw new Error(
    `${wp.id} not reached at ${here.x.toFixed(2)},${here.y.toFixed(2)},${here.z.toFixed(2)} best xz ${best.toFixed(2)}\n${trail.join(" | ")}`,
  );
}

test("spawn stands on the ground ring and outside every hull", () => {
  assert.equal(ATRIUM_SPAWN.y, GROUND_Y);
  assert.ok(onGroundRing(ATRIUM_SPAWN), `spawn ${ATRIUM_SPAWN.x},${ATRIUM_SPAWN.z} is off the ring`);
  assert.ok(Math.abs(ATRIUM_SPAWN.x) < 2);
  assert.ok(ATRIUM_SPAWN.z > WELL_HALF + 1 && ATRIUM_SPAWN.z < CONCOURSE - 1);
  assert.equal(capsuleClear(ATRIUM_SPAWN, hull), true);
  let state = createMoveState(ATRIUM_SPAWN);
  for (let i = 0; i < Math.round(0.6 / SIM_DT); i += 1) state = stepAtrium(state, still, SIM_DT);
  assert.equal(state.grounded, true);
  assert.ok(Math.abs(state.position.x - ATRIUM_SPAWN.x) < 0.05);
  assert.ok(Math.abs(state.position.y - ATRIUM_SPAWN.y) < 0.05);
  assert.ok(Math.abs(state.position.z - ATRIUM_SPAWN.z) < 0.05);
});

test("the seven pads sit on the atrium landmarks", () => {
  const of = (kind) => ATRIUM_PADS.filter((pad) => pad.kind === kind);
  assert.equal(of("health").length, 2);
  assert.equal(of("armor").length, 2);
  assert.equal(of("ammo").length, 3);

  const well = of("ammo").find((pad) => Math.hypot(pad.position.x, pad.position.z) < 0.4);
  assert.ok(well);
  assert.equal(well.position.y, 0);

  const stairHealth = of("health").find((pad) => pad.position.y === GROUND_Y);
  assert.ok(stairHealth);
  assert.ok(stairHealth.position.x > 0 && stairHealth.position.z > WELL_HALF);
  assert.ok(stairHealth.position.x < CONCOURSE && stairHealth.position.z < CONCOURSE);

  const stairArmor = of("armor").find((pad) => pad.position.y === GROUND_Y);
  assert.ok(stairArmor);
  assert.ok(stairArmor.position.x < -WELL_HALF && stairArmor.position.z < -WELL_HALF + 0.2);
  assert.ok(Math.abs(stairArmor.position.z) < CONCOURSE);

  const south = of("health").find((pad) => pad.position.y === CATWALK_Y);
  assert.ok(south);
  assert.ok(Math.abs(south.position.x) < 1.5 && south.position.z > RING_INNER);

  const north = of("armor").find((pad) => pad.position.y === CATWALK_Y);
  assert.ok(north);
  assert.ok(Math.abs(north.position.x) < 1.5 && north.position.z < -RING_INNER);

  const alley = of("ammo").find((pad) => pad.position.x > RING_INNER && Math.abs(pad.position.z) < 8);
  assert.ok(alley);
  assert.equal(alley.position.y, CATWALK_Y);

  const landing = of("ammo").find((pad) => pad.position.x > 0 && pad.position.z < -RING_INNER);
  assert.ok(landing);
  assert.equal(landing.position.y, CATWALK_Y);
});

test("a jump from the well floor cannot reach the catwalk", () => {
  let state = createMoveState({ x: 0, y: 0, z: 0 });
  let jumped = false;
  let peak = 0;
  for (let i = 0; i < Math.round(4 / SIM_DT); i += 1) {
    const jump =
      !jumped &&
      state.grounded &&
      state.position.y < 0.2 &&
      state.position.z > 3.15 &&
      planarSpeedOf(state.velocity) > 6.5;
    if (jump) jumped = true;
    state = stepAtrium(
      state,
      { forward: 1, strafe: 0, jump, yawDeg: 180 },
      SIM_DT,
    );
    if (state.position.y > peak) peak = state.position.y;
  }
  assert.equal(jumped, true);
  assert.ok(peak > 1, `jump never left the floor, peak ${peak}`);
  assert.ok(peak < CATWALK_Y - 3, `well jump reached ${peak}, catwalk is ${CATWALK_Y}`);
  assert.ok(state.position.y < 2, `ended at y ${state.position.y}`);
});

test("the kill plane respawns the player on the ground ring", () => {
  const dropped = stepAtrium(createMoveState({ x: 2, y: -4, z: 3 }), still, SIM_DT);
  assert.deepEqual(dropped.position, ATRIUM_SPAWN);
  assert.equal(dropped.grounded, true);
  assert.equal(dropped.velocity.x, 0);
  assert.equal(dropped.velocity.y, 0);
  assert.equal(dropped.velocity.z, 0);
  assert.ok(onGroundRing(dropped.position));
  assert.ok(dropped.position.y > KILL_Y);

  let outside = createMoveState({ x: 30, y: 4, z: 0 });
  outside = stepAtrium(outside, still, SIM_DT);
  assert.deepEqual(outside.position, ATRIUM_SPAWN);
});

test("outer walls keep a sprint inside the map", () => {
  const starts = [
    { yaw: 0, x: 0, z: 0 },
    { yaw: 180, x: 0, z: 0 },
    { yaw: 90, x: 0, z: 8 },
    { yaw: -90, x: 0, z: 8 },
  ];
  for (const start of starts) {
    let state = createMoveState({ x: start.x, y: GROUND_Y, z: start.z });
    for (let i = 0; i < Math.round(4 / SIM_DT); i += 1) {
      state = stepAtrium(state, { forward: 1, strafe: 0, jump: false, yawDeg: start.yaw }, SIM_DT);
    }
    assert.ok(Math.abs(state.position.x) < MAP_HALF, `x escaped ${state.position.x} yaw ${start.yaw}`);
    assert.ok(Math.abs(state.position.z) < MAP_HALF, `z escaped ${state.position.z} yaw ${start.yaw}`);
    assert.ok(state.position.y > KILL_Y);
  }
});

test("a scripted circuit crosses the well, every corner, both catwalks, and the alley", () => {
  const se = ATRIUM_STAIRS.find((stair) => stair.id === "se");
  const sw = ATRIUM_STAIRS.find((stair) => stair.id === "sw");
  const ne = ATRIUM_RAMPS.find((ramp) => ramp.id === "ne");
  const nw = ATRIUM_RAMPS.find((ramp) => ramp.id === "nw");
  const route = [
    { id: "well", x: 0, z: 0, maxY: 0.35, radius: 1.2, seconds: 8 },
    { id: "north-ring", x: 0, z: -7.2, minY: 0.5, maxY: 1.3, seconds: 8 },
    { id: "nw-foot", x: nw.lineX, z: -5.5, minY: 0.5, maxY: 1.4, seconds: 8 },
    { id: "nw-ramp", x: nw.lineX, z: -9.2, minY: 2.2, maxY: 5.6, seconds: 10 },
    { id: "nw-top", x: nw.lineX, z: -14.4, minY: 4.9, seconds: 8 },
    { id: "north-armor", x: 0, z: -14.6, minY: 4.9, seconds: 8 },
    { id: "ne-landing", x: 11.6, z: -14.6, minY: 4.9, seconds: 8 },
    { id: "ne-align", x: ne.lineX, z: -14.5, minY: 4.9, seconds: 8 },
    { id: "ne-bridge", x: ne.lineX, z: -12, minY: 4.9, seconds: 8 },
    { id: "ne-down", x: ne.lineX, z: -6.4, minY: 0.45, maxY: 1.5, seconds: 12 },
    { id: "east-ground", x: ne.lineX, z: 7.5, minY: 0.5, maxY: 1.4, seconds: 10 },
    { id: "se-approach", x: 0.7, z: 7.5, minY: 0.5, maxY: 1.4, seconds: 8 },
    { id: "se-foot", x: 0.7, z: se.lineZ, minY: 0.5, maxY: 1.4, seconds: 8 },
    { id: "se-mid", x: 5.4, z: se.lineZ, minY: 2.2, seconds: 10 },
    { id: "se-top", x: 12.2, z: se.lineZ, minY: 4.9, seconds: 10 },
    { id: "se-alley", x: 14.45, z: se.lineZ, minY: 4.9, seconds: 8 },
    { id: "east-south", x: 14.45, z: 6, minY: 4.9, seconds: 8 },
    { id: "east-ammo", x: 14.45, z: -3.4, minY: 4.9, seconds: 10 },
    { id: "east-north", x: 14.45, z: -10, minY: 4.9, seconds: 8 },
    { id: "east-corner", x: 14.45, z: 14.6, minY: 4.9, seconds: 12 },
    { id: "south-health", x: 0, z: 14.6, minY: 4.9, seconds: 10 },
    { id: "south-west", x: -14.5, z: 14.6, minY: 4.9, seconds: 10 },
    { id: "west-south", x: -14.5, z: 8, minY: 4.9, seconds: 8 },
    { id: "west-span", x: -14.5, z: 0, minY: 4.9, seconds: 8 },
    { id: "west-north", x: -14.5, z: -8, minY: 4.9, seconds: 8 },
    { id: "west-door", x: -14.5, z: sw.lineZ, minY: 4.9, seconds: 8 },
    { id: "sw-top", x: -12.2, z: sw.lineZ, minY: 4.9, seconds: 10 },
    { id: "sw-down", x: -1.2, z: sw.lineZ, minY: 0.45, maxY: 1.6, seconds: 12 },
  ];

  let state = createMoveState(ATRIUM_SPAWN);
  for (const wp of route) {
    const driven = drive(state, wp);
    state = driven.state;
    assert.ok(Math.abs(state.position.x) < MAP_HALF, `${wp.id} left the map at x ${state.position.x}`);
    assert.ok(Math.abs(state.position.z) < MAP_HALF, `${wp.id} left the map at z ${state.position.z}`);
    assert.ok(state.position.y > KILL_Y, `${wp.id} fell through at y ${state.position.y}`);
  }

  assert.ok(state.position.y < 2, `did not come back down (y ${state.position.y})`);
  assert.equal(state.grounded, true);
  assert.ok(Math.abs(state.position.x) < CONCOURSE);
  assert.ok(PARAPET_Y > CATWALK_Y);
});

test("segment queries hit floors, walls, and ramp planes", () => {
  const floor = traceSegment({ x: 0, y: 2, z: 0 }, { x: 0, y: -1, z: 0 }, hull);
  assert.ok(floor);
  assert.ok(Math.abs(floor.point.y - 0) < 0.05, `well floor y ${floor.point.y}`);
  assert.ok(floor.normal.y > 0.9);

  const wall = traceSegment({ x: 0, y: 7.2, z: 14.6 }, { x: 24, y: 7.2, z: 14.6 }, hull);
  assert.ok(wall);
  assert.ok(Math.abs(wall.point.x - MAP_HALF) < 0.2, `wall x ${wall.point.x}`);
  assert.ok(wall.normal.x < -0.5);

  const ramp = ATRIUM_RAMPS[0];
  const midZ = (ramp.minZ + ramp.maxZ) / 2;
  const above = traceSegment(
    { x: ramp.lineX, y: 6, z: midZ },
    { x: ramp.lineX, y: 0, z: midZ },
    hull,
  );
  assert.ok(above, "ramp plane was not hit");
  assert.ok(above.point.y > GROUND_Y + 0.4 && above.point.y < CATWALK_Y, `ramp y ${above.point.y}`);
  assert.ok(above.normal.y > 0.6);

  const miss = traceSegment({ x: 0, y: 1, z: 0 }, { x: 0, y: 2, z: 0 }, hull);
  assert.equal(miss, null);

  const ray = traceRay({ x: 0, y: 3, z: 0 }, { x: 0, y: -1, z: 0 }, 8, hull);
  assert.ok(ray);
  assert.ok(Math.abs(ray.point.y) < 0.05);
});

test("the drawn atrium stays inside the triangle and mesh budget", async () => {
  const { buildAtriumView } = await import("../src/floor.ts");
  const view = buildAtriumView();
  assert.ok(view.triangles > 100 && view.triangles <= 50_000, `triangles ${view.triangles}`);
  assert.ok(view.meshes.length > 0 && view.meshes.length <= 16, `meshes ${view.meshes.length}`);
  console.log(`atrium meshes ${view.meshes.length} triangles ${view.triangles}`);
});
