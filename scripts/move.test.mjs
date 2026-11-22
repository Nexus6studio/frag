import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  AIR_ACCEL,
  CAPSULE_HEIGHT,
  CAPSULE_RADIUS,
  EYE_HEIGHT,
  GRAVITY,
  GROUND_ACCEL,
  GROUND_FRICTION,
  GROUND_WISH_SPEED,
  JUMP_SPEED,
  LANDING_GRACE,
  PLANAR_CAP,
  SIM_DT,
  STEP_HEIGHT,
  WALK_SLOPE_DEG,
  createMoveState,
  createMover,
  createTestHull,
  exposeMoveDebug,
  flatHull,
  isWalkableNormal,
  planarSpeedOf,
  stepMovement,
  wishDirection,
} from "../src/move.ts";

const flat = flatHull();
const hull = createTestHull();
const still = { forward: 0, strafe: 0, jump: false, yawDeg: 0 };

function run(state, intent, seconds, world = flat) {
  const steps = Math.round(seconds / SIM_DT);
  let current = state;
  let peak = current.position.y;
  let maxPlanar = planarSpeedOf(current.velocity);
  let groundedAbove = 0;
  for (let i = 0; i < steps; i += 1) {
    current = stepMovement(current, intent, SIM_DT, world);
    if (current.position.y > peak) peak = current.position.y;
    const speed = planarSpeedOf(current.velocity);
    if (speed > maxPlanar) maxPlanar = speed;
    if (current.grounded && current.position.y > groundedAbove) groundedAbove = current.position.y;
  }
  return { state: current, peak, maxPlanar, groundedAbove };
}

function topSpeed(intent) {
  const result = run(createMoveState({ x: 0, y: 0, z: 0 }), intent, 2);
  return planarSpeedOf(result.state.velocity);
}

test("capsule, speeds, and gravity match the feel targets", () => {
  assert.equal(CAPSULE_RADIUS, 0.35);
  assert.equal(CAPSULE_HEIGHT, 1.6);
  assert.equal(EYE_HEIGHT, 1.45);
  assert.equal(GROUND_WISH_SPEED, 8);
  assert.equal(GROUND_ACCEL, 10);
  assert.equal(GROUND_FRICTION, 6);
  assert.equal(AIR_ACCEL, 2);
  assert.equal(GRAVITY, 20);
  assert.equal(JUMP_SPEED, 6.8);
  assert.equal(STEP_HEIGHT, 0.3);
  assert.equal(WALK_SLOPE_DEG, 45);
  assert.equal(PLANAR_CAP, 9.2);
  assert.equal(LANDING_GRACE, 0.08);
});

test("wish direction follows yaw and shares one horizontal cap", () => {
  const forward = wishDirection(0, 1, 0);
  assert.ok(forward);
  assert.ok(Math.abs(forward.x) < 1e-9);
  assert.ok(Math.abs(forward.z + 1) < 1e-9);
  const right = wishDirection(0, 0, 1);
  assert.ok(right);
  assert.ok(Math.abs(right.x - 1) < 1e-9);
  assert.ok(Math.abs(right.z) < 1e-9);
  const diagonal = wishDirection(0, 1, 1);
  assert.ok(diagonal);
  assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.z) - 1) < 1e-9);
  assert.equal(isWalkableNormal(Math.cos((45 * Math.PI) / 180)), true);
  assert.equal(isWalkableNormal(Math.cos((46 * Math.PI) / 180)), false);
  assert.equal(isWalkableNormal(1), true);
  assert.equal(isWalkableNormal(0), false);
});

test("grounded top speed is 8 m/s forward, back, and on a pure strafe", () => {
  const forward = topSpeed({ forward: 1, strafe: 0, jump: false, yawDeg: 0 });
  const back = topSpeed({ forward: -1, strafe: 0, jump: false, yawDeg: 0 });
  const strafe = topSpeed({ forward: 0, strafe: 1, jump: false, yawDeg: 0 });
  const diagonal = topSpeed({ forward: 1, strafe: 1, jump: false, yawDeg: 0 });
  for (const speed of [forward, back, strafe, diagonal]) {
    assert.ok(Math.abs(speed - 8) <= 0.2, `speed ${speed}`);
  }
  const moved = run(createMoveState({ x: 0, y: 0, z: 0 }), { forward: 1, strafe: 0, jump: false, yawDeg: 0 }, 1.2);
  assert.ok(moved.state.position.z < -1, `forward z ${moved.state.position.z}`);
  const backed = run(createMoveState({ x: 0, y: 0, z: 0 }), { forward: -1, strafe: 0, jump: false, yawDeg: 0 }, 1.2);
  assert.ok(backed.state.position.z > 1, `back z ${backed.state.position.z}`);
  const sidled = run(createMoveState({ x: 0, y: 0, z: 0 }), { forward: 0, strafe: 1, jump: false, yawDeg: 0 }, 1.2);
  assert.ok(sidled.state.position.x > 1, `strafe x ${sidled.state.position.x}`);
  console.log(
    `measured top speed m/s forward ${forward.toFixed(3)} back ${back.toFixed(3)} strafe ${strafe.toFixed(3)} diagonal ${diagonal.toFixed(3)}`,
  );
});

test("no input stops an 8 m/s run in about 0.3 s", () => {
  let state = {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: -8 },
    grounded: true,
    timeOnGround: 1,
  };
  let stoppedAt = null;
  for (let i = 1; i <= 80; i += 1) {
    state = stepMovement(state, still, SIM_DT, flat);
    if (stoppedAt === null && planarSpeedOf(state.velocity) === 0) stoppedAt = i * SIM_DT;
  }
  assert.ok(stoppedAt !== null);
  assert.ok(stoppedAt >= 0.25 && stoppedAt <= 0.4, `stopped at ${stoppedAt}`);
});

test("jump apex on flat ground is about 1.15 m and there is no coyote time", () => {
  let state = createMoveState({ x: 0, y: 0, z: 0 });
  state = stepMovement(state, { ...still, jump: true }, SIM_DT, flat);
  let peak = state.position.y;
  for (let i = 0; i < 200 && !(state.grounded && i > 5); i += 1) {
    state = stepMovement(state, still, SIM_DT, flat);
    if (state.position.y > peak) peak = state.position.y;
  }
  assert.ok(Math.abs(peak - 1.15) <= 0.08, `apex ${peak}`);
  assert.equal(state.grounded, true);

  let air = {
    position: { x: 0, y: 0.4, z: 0 },
    velocity: { x: 0, y: -1, z: 0 },
    grounded: false,
    timeOnGround: 0,
  };
  air = stepMovement(air, { ...still, jump: true }, SIM_DT, flat);
  assert.ok(air.velocity.y < 0, `airborne jump vy ${air.velocity.y}`);
  assert.ok(air.velocity.y > -2);
  console.log(`measured jump apex m ${peak.toFixed(3)}`);
});

test("a 0.30 m step is walkable and a 1 m ledge is not", () => {
  const stepped = run(
    createMoveState({ x: 8, y: 0, z: -2 }),
    { forward: 1, strafe: 0, jump: false, yawDeg: 0 },
    1.5,
    hull,
  );
  assert.ok(
    Math.abs(stepped.state.position.y - STEP_HEIGHT) < 0.02,
    `step y ${stepped.state.position.y}`,
  );
  assert.equal(stepped.state.grounded, true);
  assert.ok(stepped.state.position.z < -4, `did not reach the step, z ${stepped.state.position.z}`);

  const blocked = run(
    createMoveState({ x: 14.5, y: 0, z: -2 }),
    { forward: 1, strafe: 0, jump: false, yawDeg: 0 },
    2,
    hull,
  );
  assert.ok(blocked.peak < 0.2, `ledge walk peak ${blocked.peak}`);
  assert.ok(blocked.state.position.z > -4.8, `walked into the ledge, z ${blocked.state.position.z}`);
  assert.equal(blocked.state.grounded, true);
});

test("the 45 degree ramp can be walked and the pillar blocks", () => {
  const climbed = run(
    createMoveState({ x: -9, y: 0, z: 0 }),
    { forward: 1, strafe: 0, jump: false, yawDeg: 0 },
    3,
    hull,
  );
  assert.ok(climbed.groundedAbove > 1, `ramp grounded height ${climbed.groundedAbove}`);
  assert.ok(climbed.peak > 1, `ramp peak ${climbed.peak}`);

  const pillar = run(
    createMoveState({ x: -3.4, y: 0, z: -4 }),
    { forward: 1, strafe: 0, jump: false, yawDeg: 0 },
    2,
    hull,
  );
  assert.ok(pillar.state.position.z > -6.35, `passed the pillar, z ${pillar.state.position.z}`);
  assert.ok(pillar.peak < 0.2, `pillar climb ${pillar.peak}`);
  assert.equal(pillar.state.grounded, true);
});

test("a running jump lands on the 1 m ledge", () => {
  let state = createMoveState({ x: 14.5, y: 0, z: 4 });
  let jumped = false;
  let landed = false;
  for (let i = 0; i < Math.round(4 / SIM_DT); i += 1) {
    const jump = !jumped && state.grounded && state.position.z <= -2.5 && planarSpeedOf(state.velocity) > 6;
    if (jump) jumped = true;
    state = stepMovement(
      state,
      { forward: 1, strafe: 0, jump, yawDeg: 0 },
      SIM_DT,
      hull,
    );
    if (jumped && state.grounded && state.position.y > 0.85) {
      landed = true;
      break;
    }
  }
  assert.equal(jumped, true);
  assert.equal(landed, true, `never stood on the ledge (y ${state.position.y}, z ${state.position.z})`);
});

test("air strafe turns the trajectory without flight or breaking the planar cap", () => {
  let state = run(
    createMoveState({ x: 0, y: 0, z: 20 }),
    { forward: 1, strafe: 0, jump: false, yawDeg: 0 },
    1.2,
  ).state;
  state = stepMovement(state, { forward: 1, strafe: 0, jump: true, yawDeg: 0 }, SIM_DT, flat);
  const launchZ = state.velocity.z;
  let maxPlanar = planarSpeedOf(state.velocity);
  let peak = state.position.y;
  let turned = 0;
  for (let i = 0; i < 200; i += 1) {
    state = stepMovement(state, { forward: 0, strafe: 1, jump: false, yawDeg: 0 }, SIM_DT, flat);
    const speed = planarSpeedOf(state.velocity);
    if (speed > maxPlanar) maxPlanar = speed;
    if (state.position.y > peak) peak = state.position.y;
    if (!state.grounded) turned = state.velocity.x;
    if (state.grounded && i > 5) break;
  }
  assert.ok(state.grounded, "did not land");
  assert.ok(turned > 0.4, `strafe added ${turned} m/s sideways`);
  assert.ok(launchZ < -1);
  assert.ok(maxPlanar <= PLANAR_CAP + 1e-6, `air planar ${maxPlanar}`);
  assert.ok(peak < 1.15 + 0.08, `air peak ${peak}`);
  assert.ok(peak > 0.4, `did not leave the ground, peak ${peak}`);

  let overspeed = {
    position: { x: 0, y: 1, z: 0 },
    velocity: { x: 0, y: 0, z: -12 },
    grounded: false,
    timeOnGround: 0,
  };
  overspeed = stepMovement(overspeed, { forward: 0, strafe: 1, jump: false, yawDeg: 0 }, SIM_DT, flat);
  assert.ok(planarSpeedOf(overspeed.velocity) <= PLANAR_CAP + 1e-6);
  console.log(`measured max air planar m/s ${maxPlanar.toFixed(3)}`);
});

test("a jump inside the landing grace keeps planar speed and honors the cap", () => {
  function land(planarZ) {
    let state = {
      position: { x: 0, y: 1.2, z: 30 },
      velocity: { x: 0, y: -4, z: planarZ },
      grounded: false,
      timeOnGround: 0,
    };
    for (let i = 0; i < 180; i += 1) {
      state = stepMovement(state, still, SIM_DT, flat);
      if (state.grounded) return state;
    }
    throw new Error("did not land");
  }

  let kept = land(-9);
  const graceSteps = Math.round(0.04 / SIM_DT);
  for (let i = 0; i < graceSteps; i += 1) kept = stepMovement(kept, still, SIM_DT, flat);
  assert.ok(kept.timeOnGround <= LANDING_GRACE);
  const before = planarSpeedOf(kept.velocity);
  kept = stepMovement(kept, { ...still, jump: true }, SIM_DT, flat);
  const keptSpeed = planarSpeedOf(kept.velocity);
  assert.ok(Math.abs(keptSpeed - before) < 0.05, `bhop ${keptSpeed} vs ${before}`);
  assert.ok(keptSpeed <= PLANAR_CAP + 1e-6);
  assert.ok(keptSpeed > 8.5, `expected the landing speed to survive, got ${keptSpeed}`);

  let slow = land(-9);
  for (let i = 0; i < Math.round(0.25 / SIM_DT); i += 1) slow = stepMovement(slow, still, SIM_DT, flat);
  const slowed = planarSpeedOf(slow.velocity);
  assert.ok(slowed < 6, `friction should have cut speed, got ${slowed}`);

  let capped = {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: -12 },
    grounded: true,
    timeOnGround: 0,
  };
  capped = stepMovement(capped, { ...still, jump: true }, SIM_DT, flat);
  const cappedSpeed = planarSpeedOf(capped.velocity);
  assert.ok(Math.abs(cappedSpeed - PLANAR_CAP) < 1e-6, `capped ${cappedSpeed}`);
  console.log(
    `measured bhop speed m/s ${keptSpeed.toFixed(3)} capped ${cappedSpeed.toFixed(3)} after grace ${slowed.toFixed(3)}`,
  );
});

test("fixed steps do not depend on how a frame is sliced", () => {
  const intent = { forward: 1, strafe: 0, jump: false, yawDeg: 0 };
  const mover = createMover(flat, createMoveState({ x: 0, y: 0, z: 0 }));
  mover.advance(1 / 60, intent);
  mover.advance(1 / 60, intent);
  let stepped = createMoveState({ x: 0, y: 0, z: 0 });
  for (let i = 0; i < 4; i += 1) stepped = stepMovement(stepped, intent, SIM_DT, flat);
  assert.ok(Math.abs(mover.state.position.z - stepped.position.z) < 1e-9);
  assert.ok(Math.abs(mover.state.velocity.z - stepped.velocity.z) < 1e-9);
});

test("move debug hook is read-only and gated on import.meta.env.DEV", () => {
  const host = {};
  let state = createMoveState({ x: 1, y: 0, z: 2 });
  exposeMoveDebug(host, () => state);
  assert.equal(host.__fragMove.x, 1);
  assert.equal(host.__fragMove.z, 2);
  assert.equal(host.__fragMove.grounded, true);
  assert.equal(host.__fragMove.planarSpeed, 0);
  host.__fragMove.x = 9;
  assert.equal(host.__fragMove.x, 1);
  state = {
    position: { x: 3, y: 0, z: 4 },
    velocity: { x: 0, y: 0, z: -8 },
    grounded: false,
    timeOnGround: 0,
  };
  assert.equal(host.__fragMove.z, 4);
  assert.equal(host.__fragMove.grounded, false);
  assert.ok(Math.abs(host.__fragMove.planarSpeed - 8) < 1e-9);
  const descriptor = Object.getOwnPropertyDescriptor(host, "__fragMove");
  assert.equal(descriptor.set, undefined);

  const source = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.match(source, /if \(import\.meta\.env\.DEV\) \{[^}]*exposePlayerDebug\(window, player\);/);
  assert.match(source, /if \(import\.meta\.env\.DEV\) \{[^}]*exposeMoveDebug\(window, \(\) => mover\.state\);/);
});
