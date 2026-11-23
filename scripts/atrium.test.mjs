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
import { CAPSULE_RADIUS, SIM_DT, createMoveState, planarSpeedOf } from "../src/move.ts";
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
  const seX = (se.x0 + se.x1) / 2;
  const swX = (sw.x0 + sw.x1) / 2;
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
    { id: "east-ground", x: 7.2, z: 1.2, minY: 0.5, maxY: 1.4, seconds: 12 },
    { id: "se-foot", x: seX, z: 1.55, minY: 0.5, maxY: 1.5, seconds: 8 },
    { id: "se-mid", x: seX, z: 6.4, minY: 2.2, seconds: 10 },
    { id: "se-top", x: seX, z: 10.3, minY: 4.9, seconds: 10 },
    { id: "se-alley", x: 14.45, z: 10.3, minY: 4.9, seconds: 8 },
    { id: "east-south", x: 14.45, z: 6, minY: 4.9, seconds: 8 },
    { id: "east-ammo", x: 14.45, z: -3.4, minY: 4.9, seconds: 10 },
    { id: "east-north", x: 14.45, z: -10, minY: 4.9, seconds: 8 },
    { id: "east-corner", x: 14.45, z: 14.6, minY: 4.9, seconds: 12 },
    { id: "south-health", x: 0, z: 14.6, minY: 4.9, seconds: 10 },
    { id: "south-west", x: -14.5, z: 14.6, minY: 4.9, seconds: 10 },
    { id: "west-span", x: -14.5, z: 0, minY: 4.9, seconds: 10 },
    { id: "west-north", x: -14.5, z: -8, minY: 4.9, seconds: 8 },
    { id: "west-door", x: -14.5, z: 10.3, minY: 4.9, seconds: 12 },
    { id: "sw-top", x: swX, z: 10.3, minY: 4.9, seconds: 10 },
    { id: "sw-down", x: swX, z: 1.55, minY: 0.45, maxY: 1.6, seconds: 12 },
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

test("every hull is a rendered surface or an outer boundary wall", async () => {
  const { buildAtriumView } = await import("../src/floor.ts");
  const view = buildAtriumView();
  const tris = [];
  for (const mesh of view.meshes) {
    const pos = mesh.geometry.getAttribute("position");
    if (!pos) continue;
    for (let i = 0; i < pos.count; i += 3) {
      tris.push([
        [pos.getX(i), pos.getY(i), pos.getZ(i)],
        [pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)],
        [pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2)],
      ]);
    }
  }
  const cell = 2;
  const grid = new Map();
  for (const tri of tris) {
    const xs = tri.map((p) => p[0]);
    const ys = tri.map((p) => p[1]);
    const zs = tri.map((p) => p[2]);
    const min = [Math.min(...xs), Math.min(...ys), Math.min(...zs)];
    const max = [Math.max(...xs), Math.max(...ys), Math.max(...zs)];
    for (let x = Math.floor((min[0] - 0.3) / cell); x <= Math.floor((max[0] + 0.3) / cell); x += 1) {
      for (let y = Math.floor((min[1] - 0.3) / cell); y <= Math.floor((max[1] + 0.3) / cell); y += 1) {
        for (let z = Math.floor((min[2] - 0.3) / cell); z <= Math.floor((max[2] + 0.3) / cell); z += 1) {
          const key = `${x},${y},${z}`;
          let bucket = grid.get(key);
          if (!bucket) {
            bucket = [];
            grid.set(key, bucket);
          }
          bucket.push(tri);
        }
      }
    }
  }
  const distPointTri = (p, tri) => {
    const [a, b, c] = tri;
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const abab = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    const abac = ab[0] * ac[0] + ab[1] * ac[1] + ab[2] * ac[2];
    const acac = ac[0] * ac[0] + ac[1] * ac[1] + ac[2] * ac[2];
    const apab = ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2];
    const apac = ap[0] * ac[0] + ap[1] * ac[1] + ap[2] * ac[2];
    const denom = abab * acac - abac * abac;
    if (Math.abs(denom) < 1e-10) {
      return Math.min(
        Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2]),
        Math.hypot(p[0] - b[0], p[1] - b[1], p[2] - b[2]),
        Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]),
      );
    }
    let u = (acac * apab - abac * apac) / denom;
    let v = (abab * apac - abac * apab) / denom;
    u = Math.max(0, Math.min(1, u));
    v = Math.max(0, Math.min(1, v));
    if (u + v > 1) {
      const sum = u + v;
      u /= sum;
      v /= sum;
    }
    return Math.hypot(
      p[0] - (a[0] + ab[0] * u + ac[0] * v),
      p[1] - (a[1] + ab[1] * u + ac[1] * v),
      p[2] - (a[2] + ab[2] * u + ac[2] * v),
    );
  };
  const nearMesh = (p) => {
    const ix = Math.floor(p[0] / cell);
    const iy = Math.floor(p[1] / cell);
    const iz = Math.floor(p[2] / cell);
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const bucket = grid.get(`${ix + dx},${iy + dy},${iz + dz}`);
          if (!bucket) continue;
          for (const tri of bucket) {
            const dist = distPointTri(p, tri);
            if (dist < best) best = dist;
            if (best < 0.05) return best;
          }
        }
      }
    }
    return best;
  };
  const boundary = (box) =>
    box.min.x >= MAP_HALF - 1e-4 ||
    box.max.x <= -MAP_HALF + 1e-4 ||
    box.min.z >= MAP_HALF - 1e-4 ||
    box.max.z <= -MAP_HALF + 1e-4;

  const eps = 0.12;
  const gaps = [];
  for (const box of hull.boxes) {
    if (boundary(box)) continue;
    const samples = [[(box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2]];
    if (box.max.y > 0.2) {
      const y = Math.min(box.max.y - 0.05, Math.max(box.min.y + 0.15, GROUND_Y + 0.12));
      const midX = (box.min.x + box.max.x) / 2;
      const midZ = (box.min.z + box.max.z) / 2;
      for (const p of [
        [box.max.x, y, midZ],
        [box.min.x, y, midZ],
        [midX, y, box.max.z],
        [midX, y, box.min.z],
      ]) {
        if (Math.abs(p[0]) > MAP_HALF - 0.05 || Math.abs(p[2]) > MAP_HALF - 0.05) continue;
        if (p[1] < 0.15 || p[1] > box.max.y + 1e-4) continue;
        samples.push(p);
      }
    }
    for (const p of samples) {
      const dist = nearMesh(p);
      if (dist > eps) {
        gaps.push(
          `box ${box.min.x.toFixed(2)}..${box.max.x.toFixed(2)} y ${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)} z ${box.min.z.toFixed(2)}..${box.max.z.toFixed(2)} sample ${p.map((n) => n.toFixed(2)).join(",")} dist ${dist.toFixed(3)}`,
        );
      }
    }
  }
  for (const ramp of hull.ramps) {
    const span = ramp.maxZ - ramp.minZ;
    for (const t of [0.2, 0.5, 0.8]) {
      const z = ramp.minZ + span * t;
      const y = ramp.yAtMaxZ + ramp.rise * (1 - t);
      const x = (ramp.minX + ramp.maxX) / 2;
      const dist = nearMesh([x, y, z]);
      if (dist > eps) gaps.push(`ramp ${ramp.minX},${ramp.maxZ} at ${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)} dist ${dist.toFixed(3)}`);
    }
  }
  assert.equal(gaps.length, 0, gaps.slice(0, 8).join("\n"));
});

test("each corner ascent is walked from the ground ring up to the upper ring", () => {
  const climbs = [
    { id: "nw", x: -8.9, z: -5.35, yaw: 0 },
    { id: "ne", x: 8.9, z: -5.35, yaw: 0 },
    { id: "sw", x: -9.88, z: 1.45, yaw: 180 },
    { id: "se", x: 9.88, z: 1.45, yaw: 180 },
  ];
  for (const climb of climbs) {
    const start = { x: climb.x, y: GROUND_Y, z: climb.z };
    assert.equal(capsuleClear(start), true, `${climb.id} mouth is blocked`);
    assert.equal(onGroundRing(start), true, `${climb.id} mouth is off the ground ring`);
    let state = createMoveState(start);
    let jumped = false;
    let entered = false;
    for (let i = 0; i < Math.round(8 / SIM_DT); i += 1) {
      const beforeY = state.position.y;
      state = stepAtrium(state, { forward: 1, strafe: 0, jump: false, yawDeg: climb.yaw }, SIM_DT);
      if (state.velocity.y > 1) jumped = true;
      if (state.position.y > beforeY + 0.05 && state.position.y > GROUND_Y + 0.15) entered = true;
      if (needsRespawn(state.position)) break;
    }
    assert.equal(jumped, false, `${climb.id} needed a jump`);
    assert.equal(entered, true, `${climb.id} never stepped onto the ascent`);
    assert.ok(state.position.y >= CATWALK_Y - 0.05, `${climb.id} topped out at ${state.position.y}`);
    assert.equal(state.grounded, true, `${climb.id} was airborne at the top`);
    assert.ok(!needsRespawn(state.position), `${climb.id} left the map`);
    console.log(`${climb.id} climb y ${state.position.y.toFixed(2)} at ${state.position.x.toFixed(2)},${state.position.z.toFixed(2)}`);
  }

  for (const x of [-5.77, -7.2, 5.77, 7.2]) {
    let state = createMoveState({ x, y: GROUND_Y, z: 6.4 });
    for (let i = 0; i < Math.round(2 / SIM_DT); i += 1) {
      state = stepAtrium(state, { forward: 1, strafe: 0, jump: false, yawDeg: 180 }, SIM_DT);
    }
    assert.ok(state.position.z > 10.2, `south ring wall at x ${x}, z ${state.position.z.toFixed(2)}`);
    assert.ok(Math.abs(state.position.y - GROUND_Y) < 0.08, `south ring left the ground at x ${x}`);
  }
});

test("a lap of the upper ring comes back down to the ground ring", () => {
  const sw = ATRIUM_STAIRS.find((stair) => stair.id === "sw");
  const swX = (sw.x0 + sw.x1) / 2;
  const route = [
    { id: "south-catwalk", x: 0, z: 14.5, minY: 4.9, radius: 1, seconds: 4 },
    { id: "east-alley", x: 14.45, z: -3.2, minY: 4.9, seconds: 14 },
    { id: "north-catwalk", x: 0, z: -14.5, minY: 4.9, seconds: 12 },
    { id: "north-west", x: -14.5, z: -14.5, minY: 4.9, seconds: 10 },
    { id: "west-catwalk", x: -14.5, z: 4, minY: 4.9, seconds: 12 },
    { id: "west-return", x: -14.5, z: 10.4, minY: 4.9, seconds: 8 },
    { id: "sw-landing", x: swX, z: 10.4, minY: 4.9, seconds: 8 },
    { id: "ground-ring", x: swX, z: 1.55, minY: 0.45, maxY: 1.6, seconds: 12 },
  ];
  let state = createMoveState({ x: 0, y: CATWALK_Y, z: 14.5 });
  let lowest = state.position.y;
  for (const wp of route) {
    const driven = drive(state, wp);
    state = driven.state;
    for (const mark of driven.trail) {
      const y = Number(mark.split(",")[1]);
      if (y < lowest) lowest = y;
    }
    assert.ok(Math.abs(state.position.x) <= MAP_HALF, `${wp.id} x ${state.position.x}`);
    assert.ok(Math.abs(state.position.z) <= MAP_HALF, `${wp.id} z ${state.position.z}`);
    assert.ok(state.position.y > KILL_Y, `${wp.id} fell to ${state.position.y}`);
    assert.equal(needsRespawn(state.position), false, `${wp.id} respawned`);
  }
  assert.ok(lowest > 0.2, `lap dipped to ${lowest}`);
  assert.ok(state.position.y < 1.7, `did not return to the ground ring (y ${state.position.y})`);
  assert.equal(state.grounded, true);
  assert.equal(onGroundRing(state.position), true);
  console.log(`upper-ring lap returned to ${state.position.x.toFixed(2)},${state.position.y.toFixed(2)},${state.position.z.toFixed(2)}`);
});

test("holding W into the NW corner stores about 0 m/s", () => {
  let state = createMoveState({ x: -10.3, y: GROUND_Y, z: -10.3 });
  for (let i = 0; i < Math.round(1 / SIM_DT); i += 1) {
    state = stepAtrium(state, { forward: 1, strafe: 0, jump: false, yawDeg: 45 }, SIM_DT);
  }
  const parked = { x: state.position.x, z: state.position.z };
  const speed = planarSpeedOf(state.velocity);
  for (let i = 0; i < Math.round(0.3 / SIM_DT); i += 1) {
    state = stepAtrium(state, { forward: 1, strafe: 0, jump: false, yawDeg: 45 }, SIM_DT);
  }
  assert.ok(speed < 0.15, `NW corner speed ${speed}`);
  assert.ok(planarSpeedOf(state.velocity) < 0.15, `NW corner kept ${planarSpeedOf(state.velocity)}`);
  assert.ok(Math.hypot(state.position.x - parked.x, state.position.z - parked.z) < 0.05);
  assert.equal(state.position.y > KILL_Y && Math.abs(state.position.x) < MAP_HALF, true);
  console.log(`NW corner speed m/s ${speed.toFixed(3)} at ${parked.x.toFixed(2)},${parked.z.toFixed(2)}`);
});

test("a standing hop from rest clears the 0.8 m well lip", () => {
  let state = createMoveState({ x: 0, y: 0, z: WELL_HALF - CAPSULE_RADIUS });
  for (let i = 0; i < 15; i += 1) state = stepAtrium(state, still, SIM_DT);
  assert.equal(state.grounded, true);
  assert.ok(state.position.y < 0.05, `not at rest on the well floor (y ${state.position.y})`);
  assert.ok(planarSpeedOf(state.velocity) < 0.05, `not at rest (speed ${planarSpeedOf(state.velocity)})`);
  let hopped = false;
  for (let i = 0; i < Math.round(1 / SIM_DT); i += 1) {
    const jump = !hopped && state.grounded && state.position.y < 0.2;
    if (jump) hopped = true;
    state = stepAtrium(state, { forward: 1, strafe: 0, jump, yawDeg: 180 }, SIM_DT);
    if (hopped && state.grounded && state.position.y > GROUND_Y - 0.05 && state.position.z > WELL_HALF) break;
  }
  assert.equal(hopped, true);
  assert.equal(state.grounded, true);
  assert.ok(Math.abs(state.position.y - GROUND_Y) < 0.05, `lip y ${state.position.y}`);
  assert.ok(state.position.z > WELL_HALF, `still in the well at z ${state.position.z}`);
  assert.ok(state.position.y < CATWALK_Y - 3, `standing hop reached ${state.position.y}`);
  console.log(`standing lip hop y ${state.position.y.toFixed(3)} z ${state.position.z.toFixed(3)}`);
});

test("the drawn atrium stays inside the triangle and mesh budget", async () => {
  const { buildAtriumView } = await import("../src/floor.ts");
  const view = buildAtriumView();
  assert.ok(view.triangles > 100 && view.triangles <= 50_000, `triangles ${view.triangles}`);
  assert.ok(view.meshes.length > 0 && view.meshes.length <= 16, `meshes ${view.meshes.length}`);
  console.log(`atrium meshes ${view.meshes.length} triangles ${view.triangles}`);
});
