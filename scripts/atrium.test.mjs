import assert from "node:assert/strict";
import test from "node:test";
import {
  ATRIUM_JUMP_PADS,
  ATRIUM_PADS,
  ATRIUM_RAMPS,
  ATRIUM_SPAWN,
  ATRIUM_STAIRS,
  CATWALK_Y,
  CEILING_Y,
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
import {
  CAMERA_NEAR,
  CAPSULE_HEIGHT,
  CAPSULE_RADIUS,
  EYE_HEIGHT,
  SIM_DT,
  createMoveState,
  eyeSurfaceClearance,
  planarSpeedOf,
} from "../src/move.ts";
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

test("both center-well jump pads land on the upper ring", () => {
  assert.equal(ATRIUM_JUMP_PADS.length, 2);
  const east = ATRIUM_JUMP_PADS.find((pad) => pad.id === "east");
  const west = ATRIUM_JUMP_PADS.find((pad) => pad.id === "west");
  assert.ok(east && west);
  assert.ok(east.x > 0 && west.x < 0);
  assert.ok(Math.abs(east.x) < WELL_HALF && Math.abs(west.x) < WELL_HALF);
  assert.ok(Math.abs(east.z) < WELL_HALF && Math.abs(west.z) < WELL_HALF);
  for (const pad of ATRIUM_JUMP_PADS) {
    for (const pickup of ATRIUM_PADS) {
      const gap = Math.hypot(pad.x - pickup.position.x, pad.z - pickup.position.z);
      assert.ok(gap > 2, `${pad.id} is ${gap.toFixed(2)} m from a ${pickup.kind} pad`);
    }
    const spawnGap = Math.hypot(pad.x - ATRIUM_SPAWN.x, pad.z - ATRIUM_SPAWN.z);
    assert.ok(spawnGap > 4, `${pad.id} is ${spawnGap.toFixed(2)} m from spawn`);
  }

  const ride = (start, intent, label) => {
    let state = createMoveState(start);
    let launches = 0;
    let peak = start.y;
    let landed = null;
    const limit = Math.round(3.5 / SIM_DT);
    for (let i = 0; i < limit; i += 1) {
      state = stepAtrium(state, intent, SIM_DT, () => {
        launches += 1;
      });
      if (state.position.y > peak) peak = state.position.y;
      const head = state.position.y + CAPSULE_HEIGHT;
      assert.ok(head < CEILING_Y - 0.05, `${label} head ${head.toFixed(2)} met the ceiling`);
      assert.equal(needsRespawn(state.position), false, `${label} left the atrium`);
      assert.ok(Math.abs(state.position.x) <= MAP_HALF, `${label} x ${state.position.x}`);
      assert.ok(Math.abs(state.position.z) <= MAP_HALF, `${label} z ${state.position.z}`);
      assert.ok(state.position.y > KILL_Y, `${label} fell to ${state.position.y}`);
      if (!landed && i > 5 && state.grounded && state.position.y >= 5.3) landed = { ...state.position };
      if (landed) break;
    }
    assert.equal(launches, 1, `${label} launches ${launches}`);
    assert.ok(peak >= 5.3, `${label} peaked at ${peak}`);
    assert.ok(landed, `${label} did not land on the upper ring`);
    assert.ok(landed.y >= 5.3 && landed.y < PARAPET_Y - 0.4, `${label} landed at y ${landed.y}`);
    assert.ok(Math.abs(landed.x) >= RING_INNER - 0.05, `${label} landed at x ${landed.x}, short of the catwalk`);
    assert.equal(state.grounded, true, `${label} was still airborne`);
    return landed;
  };

  const stillRide = { forward: 0, strafe: 0, jump: false, yawDeg: 0 };
  for (const pad of ATRIUM_JUMP_PADS) {
    const landed = ride({ x: pad.x, y: 0, z: pad.z }, stillRide, `${pad.id} stand`);
    assert.ok(Math.sign(landed.x) === Math.sign(pad.dirX), `${pad.id} launched the wrong way`);
  }

  ride({ x: 2, y: 0, z: 0 }, { forward: 1, strafe: 0, jump: false, yawDeg: -90 }, "walk east");
  ride({ x: -2, y: 0, z: 0 }, { forward: 1, strafe: 0, jump: false, yawDeg: 90 }, "walk west");

  let idle = createMoveState({ x: 0, y: 0, z: 0 });
  let idleLaunches = 0;
  for (let i = 0; i < Math.round(0.5 / SIM_DT); i += 1) {
    idle = stepAtrium(idle, stillRide, SIM_DT, () => {
      idleLaunches += 1;
    });
  }
  assert.equal(idleLaunches, 0);
  assert.ok(idle.position.y < 0.2, `well center climbed to ${idle.position.y}`);
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

test("walking under the ramps keeps the eye a near-plane clear of the mesh", () => {
  const ne = ATRIUM_RAMPS.find((ramp) => ramp.id === "ne");
  const nw = ATRIUM_RAMPS.find((ramp) => ramp.id === "nw");
  let worst = Infinity;
  for (const ramp of [ne, nw]) {
    let state = createMoveState({ x: ramp.lineX, y: GROUND_Y, z: ramp.minZ + 1.2 });
    for (let i = 0; i < Math.round(4 / SIM_DT); i += 1) {
      state = stepAtrium(state, { forward: 1, strafe: 0, jump: false, yawDeg: 180 }, SIM_DT);
      const gap = eyeSurfaceClearance(state.position, hull);
      if (gap < worst) worst = gap;
      assert.ok(
        gap + 1e-4 >= CAMERA_NEAR,
        `${ramp.id} eye clearance ${gap.toFixed(3)} m at ${state.position.x.toFixed(2)} ${state.position.y.toFixed(2)} ${state.position.z.toFixed(2)} (eye ${EYE_HEIGHT}, near ${CAMERA_NEAR})`,
      );
    }
  }
  let ring = createMoveState({ x: 14.2, y: CATWALK_Y, z: 8 });
  for (let i = 0; i < Math.round(3 / SIM_DT); i += 1) {
    ring = stepAtrium(ring, { forward: 1, strafe: 0, jump: false, yawDeg: 180 }, SIM_DT);
    const gap = eyeSurfaceClearance(ring.position, hull);
    if (gap < worst) worst = gap;
    assert.ok(gap + 1e-4 >= CAMERA_NEAR, `ring eye clearance ${gap.toFixed(3)}`);
  }
  console.log(`eye clearance under ramps and the ring ${worst.toFixed(3)} m, near plane ${CAMERA_NEAR} m`);
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
  const jumpPads = view.meshes.find((mesh) => mesh.name === "atrium-jump-pads");
  assert.ok(jumpPads, "jump pad chevrons are not drawn");
  const colors = jumpPads.geometry.getAttribute("color");
  assert.ok(colors && colors.count > 12);
  let cyan = 0;
  let magenta = 0;
  for (let i = 0; i < colors.count; i += 1) {
    const r = colors.getX(i);
    const g = colors.getY(i);
    const b = colors.getZ(i);
    if (b > 0.8 && g > 0.7 && r < 0.2) cyan += 1;
    if (r > 0.8 && b > 0.4 && g < 0.4) magenta += 1;
  }
  assert.ok(cyan > 0 && magenta > 0, `chevron colors cyan ${cyan} magenta ${magenta}`);
  console.log(`atrium meshes ${view.meshes.length} triangles ${view.triangles}`);
});

test("the procedural panel tiles, stays dark, and wraps at the seam", async () => {
  const { PANEL_SIZE, panelPixel, paintPanel } = await import("../src/panel.ts");
  assert.deepEqual(panelPixel(0, 4), panelPixel(PANEL_SIZE, 4));
  assert.deepEqual(panelPixel(3, PANEL_SIZE - 1), panelPixel(3 + PANEL_SIZE, -1));
  assert.deepEqual(panelPixel(-1, 20), panelPixel(PANEL_SIZE - 1, 20));
  const seam = panelPixel(1, 40);
  const field = panelPixel(48, 40);
  const edge = panelPixel(PANEL_SIZE - 1, 40);
  assert.ok(field[0] > seam[0] + 6, `panel field ${field[0]} is not lighter than the seam ${seam[0]}`);
  assert.ok(Math.abs(seam[0] - edge[0]) < 8, `seam column broke across the tile (${seam[0]} vs ${edge[0]})`);
  let min = 255;
  let max = 0;
  for (let y = 0; y < PANEL_SIZE; y += 8) {
    for (let x = 0; x < PANEL_SIZE; x += 8) {
      const [r, g, b] = panelPixel(x, y);
      assert.ok(r < 72 && g < 72 && b < 80, `bright panel texel ${r},${g},${b} at ${x},${y}`);
      min = Math.min(min, r, g, b);
      max = Math.max(max, r, g, b);
    }
  }
  assert.ok(max - min >= 12, `panel texture is flat (${min}..${max})`);
  const painted = paintPanel();
  assert.equal(painted.length, PANEL_SIZE * PANEL_SIZE * 4);
  const [r, g, b] = panelPixel(0, 17);
  assert.equal(painted[17 * PANEL_SIZE * 4], r);
  assert.equal(painted[17 * PANEL_SIZE * 4 + 1], g);
  assert.equal(painted[17 * PANEL_SIZE * 4 + 2], b);
  assert.equal(painted[17 * PANEL_SIZE * 4 + 3], 255);
});

function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function add3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale3(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function len3(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

/** Distance from a point to a triangle. Used to prove trim sits on a transition. */
function distPointTriangle(p, a, b, c) {
  const ab = sub3(b, a);
  const ac = sub3(c, a);
  const ap = sub3(p, a);
  const d1 = dot3(ab, ap);
  const d2 = dot3(ac, ap);
  if (d1 <= 0 && d2 <= 0) return len3(ap);
  const bp = sub3(p, b);
  const d3 = dot3(ab, bp);
  const d4 = dot3(ac, bp);
  if (d3 >= 0 && d4 <= d3) return len3(bp);
  const cp = sub3(p, c);
  const d5 = dot3(ab, cp);
  const d6 = dot3(ac, cp);
  if (d6 >= 0 && d5 <= d6) return len3(cp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return len3(sub3(p, add3(a, scale3(ab, v))));
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return len3(sub3(p, add3(a, scale3(ac, w))));
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return len3(sub3(p, add3(b, scale3(sub3(c, b), w))));
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return len3(sub3(p, add3(a, add3(scale3(ab, v), scale3(ac, w)))));
}

function distToMesh(mesh, x, y, z) {
  const pos = mesh.geometry.getAttribute("position");
  const p = [x, y, z];
  let best = Infinity;
  for (let i = 0; i < pos.count; i += 3) {
    const a = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    const b = [pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1)];
    const c = [pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2)];
    const dist = distPointTriangle(p, a, b, c);
    if (dist < best) best = dist;
  }
  return best;
}

function longestUvPerMeter(mesh, pred) {
  const pos = mesh.geometry.getAttribute("position");
  const uv = mesh.geometry.getAttribute("uv");
  let best = null;
  for (let i = 0; i < pos.count; i += 3) {
    for (const [a, b] of [
      [0, 1],
      [1, 2],
      [2, 0],
    ]) {
      const ia = i + a;
      const ib = i + b;
      const ax = pos.getX(ia);
      const ay = pos.getY(ia);
      const az = pos.getZ(ia);
      const bx = pos.getX(ib);
      const by = pos.getY(ib);
      const bz = pos.getZ(ib);
      if (!pred(ax, ay, az) || !pred(bx, by, bz)) continue;
      const world = Math.hypot(ax - bx, ay - by, az - bz);
      if (world < 0.4) continue;
      const span = Math.hypot(uv.getX(ia) - uv.getX(ib), uv.getY(ia) - uv.getY(ib));
      if (!best || world > best.world) best = { world, ratio: span / world };
    }
  }
  return best;
}

test("wall, ramp, and pillar panels share one tiled texture and trim stays in budget", async () => {
  const { PANEL_METERS, PANEL_SIZE } = await import("../src/panel.ts");
  const { RepeatWrapping } = await import("three");
  const { CATWALK_Y, GROUND_Y } = await import("../src/atrium.ts");
  const { buildAtriumView } = await import("../src/floor.ts");
  const view = buildAtriumView();
  const shell = view.meshes.find((mesh) => mesh.name === "atrium-shell");
  const ramp = view.meshes.find((mesh) => mesh.name === "atrium-ramp");
  const floor = view.meshes.find((mesh) => mesh.name === "atrium-floor");
  const trim = view.meshes.find((mesh) => mesh.name === "atrium-trim");
  assert.ok(shell && ramp && floor && trim, "floor, shell, ramp, and trim meshes missing");
  assert.equal(shell.material, ramp.material, "ramp built its own panel material");
  assert.ok(shell.material.emissiveMap, "panel texture was not assigned");
  assert.equal(shell.material.emissiveMap, ramp.material.emissiveMap);
  assert.equal(floor.material.emissiveMap, null);
  assert.equal(trim.material.emissiveMap, null);

  const maps = new Set();
  for (const mesh of view.meshes) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (material.emissiveMap) maps.add(material.emissiveMap);
    }
  }
  assert.equal(maps.size, 1, `panel texture duplicated ${maps.size} times`);
  const texture = shell.material.emissiveMap;
  assert.equal(texture.wrapS, RepeatWrapping);
  assert.equal(texture.wrapT, RepeatWrapping);
  assert.equal(texture.image.width, PANEL_SIZE);
  assert.equal(texture.image.height, PANEL_SIZE);
  assert.equal(texture.name, "atrium-panel");

  const shellPos = shell.geometry.getAttribute("position");
  let pillar = false;
  for (let i = 0; i < shellPos.count; i += 1) {
    if (Math.abs(shellPos.getX(i) - 6.75) < 0.02 && Math.abs(shellPos.getZ(i) - 6.75) < 0.02) pillar = true;
  }
  assert.equal(pillar, true, "pillar was not drawn with the shared shell texture");

  const wall = longestUvPerMeter(
    shell,
    (_x, y, z) => Math.abs(z - 16) < 0.02 && y < 0.05,
  );
  const pillarEdge = longestUvPerMeter(
    shell,
    (x, _y, z) => Math.abs(x - 6.75) < 0.02 && Math.abs(z - 6.75) < 0.02,
  );
  const slope = longestUvPerMeter(ramp, (x, y) => Math.abs(x - 7.6) < 0.02 && y > 0.5);
  assert.ok(wall && pillarEdge && slope, `missing uv edges wall ${!!wall} pillar ${!!pillarEdge} slope ${!!slope}`);
  const tile = 1 / PANEL_METERS;
  assert.ok(Math.abs(wall.ratio - tile) < 0.02, `wall uv/m ${wall.ratio} over ${wall.world.toFixed(2)} m`);
  assert.ok(Math.abs(pillarEdge.ratio - wall.ratio) < 0.02, `pillar uv/m ${pillarEdge.ratio} vs wall ${wall.ratio}`);
  assert.ok(Math.abs(slope.ratio - tile) < 0.02, `ramp uv/m ${slope.ratio} (squashed slope)`);
  assert.ok(wall.world > 20, `wide wall was split into ${wall.world.toFixed(2)} m`);
  assert.ok(pillarEdge.world < 5, `pillar edge is ${pillarEdge.world.toFixed(2)} m`);

  const trimLum = 0.2126 * trim.material.emissive.r + 0.7152 * trim.material.emissive.g + 0.0722 * trim.material.emissive.b;
  const floorLum = 0.2126 * floor.material.emissive.r + 0.7152 * floor.material.emissive.g + 0.0722 * floor.material.emissive.b;
  assert.ok(trimLum > floorLum * 4, `trim luminance ${trimLum} does not separate from the floor ${floorLum}`);
  assert.ok(trimLum < 0.2, `trim luminance ${trimLum} competes with the neon accents`);
  const spread = Math.max(trim.material.emissive.r, trim.material.emissive.g, trim.material.emissive.b) - Math.min(trim.material.emissive.r, trim.material.emissive.g, trim.material.emissive.b);
  assert.ok(spread < 0.16, `trim is saturated (${spread})`);

  const probes = [
    ["well south riser", 0, 0.4, 4.978],
    ["well north riser", 0, 0.4, -4.978],
    ["well east riser", 4.978, 0.4, 0],
    ["well west riser", -4.978, 0.4, 0],
    ["well south nosing", 0, GROUND_Y + 0.028, 5.03],
    ["ne ramp base", 8.9, GROUND_Y + 0.045, -6.153],
    ["nw ramp base", -8.9, GROUND_Y + 0.045, -6.153],
    ["ne ramp edge", 10.159, 3.079, -8.573],
    ["nw ramp edge", -10.159, 3.079, -8.573],
    ["ne landing", 8.9, CATWALK_Y + 0.042, -11.04],
    ["nw landing", -8.9, CATWALK_Y + 0.042, -11.04],
    ["ne soffit", 10.159, 3.01, -8.638],
    ["se stair riser", 9.885, 0.95, 2.38],
    ["sw stair riser", -9.885, 0.95, 2.38],
    ["se stringer", 8.7165, 3.05, 6.15],
    ["sw stringer", -8.7165, 3.05, 6.15],
    ["se landing", 9.885, CATWALK_Y + 0.02, 9.94],
    ["sw landing", -9.885, CATWALK_Y + 0.02, 9.94],
    ["pillar plinth", 6.79, GROUND_Y + 0.05, 6.05],
    ["catwalk baseboard", 0, CATWALK_Y + 0.18, 15.97],
    ["parapet baseboard", 0, GROUND_Y + 0.16, 10.97],
    ["south soffit", 0, 5.272, 10.978],
    ["north soffit", 0, 5.272, -10.978],
  ];
  const misses = [];
  for (const [id, x, y, z] of probes) {
    const dist = distToMesh(trim, x, y, z);
    if (dist > 0.08) misses.push(`${id} dist ${dist.toFixed(3)} at ${x},${y},${z}`);
  }
  assert.equal(misses.length, 0, misses.join("\n"));

  const trimTris = trim.geometry.getAttribute("position").count / 3;
  assert.ok(trimTris > 40 && trimTris < 2_000, `trim triangles ${trimTris}`);
  assert.ok(view.triangles <= 50_000, `triangles ${view.triangles}`);
  assert.ok(view.meshes.length <= 16, `meshes ${view.meshes.length}`);
  console.log(
    `panel shared across shell+ramp, trim tris ${trimTris}, atrium meshes ${view.meshes.length}, triangles ${view.triangles}`,
  );
});
