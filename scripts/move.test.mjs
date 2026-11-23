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
  MAX_FRAME_SECONDS,
  PLANAR_CAP,
  SIM_DT,
  STEP_HEIGHT,
  WALK_SLOPE_DEG,
  createMoveState,
  createMover,
  exposeMoveDebug,
  flatHull,
  isWalkableNormal,
  planarSpeedOf,
  stepMovement,
  wishDirection,
} from "../src/move.ts";

const flat = flatHull();
const still = { forward: 0, strafe: 0, jump: false, yawDeg: 0 };

// The atrium replaced the test floor. These fixtures are the collision cases,
// not the shipped map.
const stepHull = {
  boxes: [{ min: { x: 6, y: 0, z: -18 }, max: { x: 10, y: STEP_HEIGHT, z: -4 } }],
  ramps: [],
};
const ledgeHull = {
  boxes: [{ min: { x: 12, y: 0, z: -18 }, max: { x: 17, y: 1, z: -5 } }],
  ramps: [],
};
const rampHull = {
  boxes: [],
  ramps: [{ minX: -3, maxX: 3, minZ: -2.5, maxZ: -1, yAtMaxZ: 0, rise: 1.5 }],
};
const pillarHull = {
  boxes: [{ min: { x: -4.2, y: 0, z: -9 }, max: { x: -2.6, y: 3, z: -6.6 } }],
  ramps: [],
};

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
  assert.ok(stoppedAt >= 0.27 && stoppedAt <= 0.33, `stopped at ${stoppedAt}`);

  const mover = createMover(flat, {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: -8 },
    grounded: true,
    timeOnGround: 1,
  });
  const frame = 1 / 20;
  let seenAt = null;
  for (let i = 1; i <= 20; i += 1) {
    const stepped = mover.advance(frame, still);
    if (seenAt === null && planarSpeedOf(stepped.velocity) === 0) seenAt = i * frame;
  }
  assert.ok(seenAt !== null);
  assert.ok(Math.abs(seenAt - 0.3) <= 0.05, `20 fps stop ${seenAt}`);
  console.log(`measured stop s ${stoppedAt.toFixed(3)} at 20 fps ${seenAt.toFixed(3)}`);
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
    stepHull,
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
    ledgeHull,
  );
  assert.ok(blocked.peak < 0.2, `ledge walk peak ${blocked.peak}`);
  assert.ok(blocked.state.position.z > -4.8, `walked into the ledge, z ${blocked.state.position.z}`);
  assert.equal(blocked.state.grounded, true);
});

test("the 45 degree ramp can be walked and the pillar blocks", () => {
  const climbed = run(
    createMoveState({ x: 0, y: 0, z: 1 }),
    { forward: 1, strafe: 0, jump: false, yawDeg: 0 },
    3,
    rampHull,
  );
  assert.ok(climbed.groundedAbove > 1, `ramp grounded height ${climbed.groundedAbove}`);
  assert.ok(climbed.peak > 1, `ramp peak ${climbed.peak}`);

  const pillar = run(
    createMoveState({ x: -3.4, y: 0, z: -4 }),
    { forward: 1, strafe: 0, jump: false, yawDeg: 0 },
    2,
    pillarHull,
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
      ledgeHull,
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

function jumpThroughLoop(fps) {
  const frame = 1 / fps;
  const mover = createMover(flat, createMoveState({ x: 0, y: 0, z: 0 }));
  let peak = 0;
  let leftGround = false;
  const limit = Math.ceil(fps * 2);
  for (let i = 0; i < limit; i += 1) {
    const intent = i === 0 ? { ...still, jump: true } : still;
    const stepped = mover.advance(frame, intent);
    if (stepped.position.y > peak) peak = stepped.position.y;
    if (!stepped.grounded) leftGround = true;
    else if (leftGround) return { peak, airtime: (i + 1) * frame, leftGround };
  }
  return { peak, airtime: limit * frame, leftGround };
}

test("jump apex and airtime match the spec through the game loop", () => {
  for (const fps of [120, 60, 30, 20]) {
    const result = jumpThroughLoop(fps);
    assert.equal(result.leftGround, true, `${fps} fps never left the ground`);
    assert.ok(
      Math.abs(result.peak - 1.15) <= 0.05,
      `${fps} fps feet apex ${result.peak}`,
    );
    assert.ok(
      Math.abs(result.airtime - 0.68) <= 0.03,
      `${fps} fps airtime ${result.airtime}`,
    );
    console.log(
      `measured jump at ${fps} fps apex ${result.peak.toFixed(3)} m airtime ${result.airtime.toFixed(3)} s`,
    );
  }
});

test("the sim stays real time down to 20 fps and only clamps long stalls", () => {
  const intent = { forward: 1, strafe: 0, jump: false, yawDeg: 0 };
  const fine = createMover(flat, createMoveState({ x: 0, y: 0, z: 0 }));
  const coarse = createMover(flat, createMoveState({ x: 0, y: 0, z: 0 }));
  for (let i = 0; i < 120; i += 1) fine.advance(1 / 120, intent);
  for (let i = 0; i < 20; i += 1) coarse.advance(1 / 20, intent);
  assert.ok(
    Math.abs(fine.state.position.z - coarse.state.position.z) < 0.05,
    `20 fps z ${coarse.state.position.z} vs 120 fps ${fine.state.position.z}`,
  );

  const stall = createMover(flat, createMoveState({ x: 0, y: 0, z: 0 }));
  stall.advance(0.2, intent);
  let expected = createMoveState({ x: 0, y: 0, z: 0 });
  const steps = Math.round(0.2 / SIM_DT);
  for (let i = 0; i < steps; i += 1) expected = stepMovement(expected, intent, SIM_DT, flat);
  assert.ok(
    Math.abs(stall.state.position.z - expected.position.z) < 0.05,
    `200 ms frame z ${stall.state.position.z} vs ${expected.position.z}`,
  );

  const clamped = createMover(flat, createMoveState({ x: 0, y: 0, z: 0 }));
  clamped.advance(0.4, intent);
  let cap = createMoveState({ x: 0, y: 0, z: 0 });
  const capSteps = Math.round(MAX_FRAME_SECONDS / SIM_DT);
  for (let i = 0; i < capSteps; i += 1) cap = stepMovement(cap, intent, SIM_DT, flat);
  let unclamped = createMoveState({ x: 0, y: 0, z: 0 });
  for (let i = 0; i < Math.round(0.4 / SIM_DT); i += 1) {
    unclamped = stepMovement(unclamped, intent, SIM_DT, flat);
  }
  assert.ok(Math.abs(clamped.state.position.z - cap.position.z) < 0.08, "400 ms stall was not clamped");
  assert.ok(
    Math.abs(clamped.state.position.z - unclamped.position.z) > 0.2,
    "400 ms stall simulated the whole gap",
  );
});

test("a full-speed walk climbs the 45 degree ramp and a steeper face blocks", () => {
  let state = {
    position: { x: 0, y: 0, z: 1 },
    velocity: { x: 0, y: 0, z: -8 },
    grounded: true,
    timeOnGround: 1,
  };
  const intent = { forward: 1, strafe: 0, jump: false, yawDeg: 0 };
  let minOnSlope = 99;
  let maxGrounded = 0;
  for (let i = 0; i < Math.round(1.2 / SIM_DT); i += 1) {
    state = stepMovement(state, intent, SIM_DT, rampHull);
    if (state.grounded && state.position.y > 0.2 && state.position.y < 1.4) {
      minOnSlope = Math.min(minOnSlope, planarSpeedOf(state.velocity));
    }
    if (state.grounded) maxGrounded = Math.max(maxGrounded, state.position.y);
  }
  assert.ok(maxGrounded > 1.2, `ramp height ${maxGrounded}`);
  assert.ok(minOnSlope >= 7.5, `ramp speed ${minOnSlope}`);

  const steep = {
    boxes: [],
    ramps: [{ minX: -2, maxX: 2, minZ: -6, maxZ: -2, yAtMaxZ: 0, rise: 6 }],
  };
  let blocked = {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: -8 },
    grounded: true,
    timeOnGround: 1,
  };
  for (let i = 0; i < Math.round(1 / SIM_DT); i += 1) {
    blocked = stepMovement(blocked, intent, SIM_DT, steep);
  }
  assert.ok(blocked.position.y < 0.2, `steep climb ${blocked.position.y}`);
  assert.ok(blocked.position.z > -2.2, `walked through the steep face, z ${blocked.position.z}`);

  const borderline = Math.tan((46 * Math.PI) / 180) * 4;
  const over = {
    boxes: [],
    ramps: [{ minX: -2, maxX: 2, minZ: -6, maxZ: -2, yAtMaxZ: 0, rise: borderline }],
  };
  let fortySix = createMoveState({ x: 0, y: 0, z: 0 });
  for (let i = 0; i < Math.round(1 / SIM_DT); i += 1) {
    fortySix = stepMovement(fortySix, intent, SIM_DT, over);
  }
  assert.ok(fortySix.position.y < 0.2, `46 degree climb ${fortySix.position.y}`);
});

test("a 30 degree glance keeps the tangential speed and a head-on hit stops", () => {
  const wall = {
    boxes: [{ min: { x: -30, y: 0, z: -8 }, max: { x: 30, y: 3, z: -6 } }],
    ramps: [],
  };
  const angle = (30 * Math.PI) / 180;
  const speed = 8;
  const yaw = (Math.atan2(-Math.cos(angle), Math.sin(angle)) * 180) / Math.PI;
  let state = {
    position: { x: 0, y: 0, z: -6 + 0.35 + 0.4 },
    velocity: { x: speed * Math.cos(angle), y: 0, z: -speed * Math.sin(angle) },
    grounded: true,
    timeOnGround: 1,
  };
  const wish = { forward: 1, strafe: 0, jump: false, yawDeg: yaw };
  let kept = null;
  let recovered = 0;
  for (let i = 0; i < Math.round(0.6 / SIM_DT); i += 1) {
    state = stepMovement(state, wish, SIM_DT, wall);
    const into = state.velocity.z;
    if (kept === null && state.position.z <= -6 + 0.35 + 0.02 && Math.abs(into) < 0.35) {
      kept = planarSpeedOf(state.velocity);
    }
    recovered = planarSpeedOf(state.velocity);
  }
  assert.ok(kept !== null, "never slid along the wall");
  assert.ok(Math.abs(kept - 8 * Math.cos(angle)) <= 0.3, `kept ${kept}`);
  assert.ok(recovered >= 7.6, `did not accelerate back toward 8, speed ${recovered}`);
  assert.ok(recovered <= 9.2 + 1e-6, `slide exceeded the cap, ${recovered}`);
  assert.ok(state.position.z > -6 + 0.3, `passed into the wall, z ${state.position.z}`);

  let head = {
    position: { x: 0, y: 0, z: -6 + 0.35 + 0.3 },
    velocity: { x: 0, y: 0, z: -8 },
    grounded: true,
    timeOnGround: 1,
  };
  for (let i = 0; i < Math.round(0.25 / SIM_DT); i += 1) {
    head = stepMovement(head, { forward: 1, strafe: 0, jump: false, yawDeg: 0 }, SIM_DT, wall);
  }
  assert.ok(planarSpeedOf(head.velocity) < 0.3, `head-on speed ${planarSpeedOf(head.velocity)}`);
  assert.ok(head.position.z > -6 + 0.3, `head-on passed the wall, z ${head.position.z}`);
  console.log(`measured glance kept ${kept.toFixed(3)} m/s then ${recovered.toFixed(3)} m/s`);
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

test("a turning bunny-hop chain climbs above 8 m/s and never passes the cap", () => {
  let state = createMoveState({ x: 0, y: 0, z: 0 });
  const run = { forward: 1, strafe: 0, jump: false, yawDeg: 0 };
  for (let i = 0; i < 90; i += 1) state = stepMovement(state, run, SIM_DT, flat);
  state = stepMovement(state, { ...run, jump: true }, SIM_DT, flat);
  const theta = (30 * Math.PI) / 180;
  let max = planarSpeedOf(state.velocity);
  for (let i = 0; i < Math.round(5 / SIM_DT); i += 1) {
    const travel = Math.atan2(state.velocity.x, state.velocity.z);
    const target = travel - theta;
    let yawDeg = (target * 180) / Math.PI - 180;
    const wish = wishDirection(yawDeg, 1, 0);
    const have = Math.atan2(wish.x, wish.z);
    const err = Math.atan2(Math.sin(target - have), Math.cos(target - have));
    yawDeg += (err * 180) / Math.PI;
    const jump = state.grounded && state.timeOnGround <= LANDING_GRACE;
    state = stepMovement(state, { forward: 1, strafe: 0, jump, yawDeg }, SIM_DT, flat);
    const speed = planarSpeedOf(state.velocity);
    if (speed > max) max = speed;
    assert.ok(speed <= PLANAR_CAP + 1e-6, `bhop planar ${speed}`);
  }
  assert.ok(max > 8, `bhop chain never left 8 m/s (max ${max})`);
  console.log(`measured bhop chain max planar m/s ${max.toFixed(3)}`);
});

test("holding W into a corner sheds planar speed and a glance keeps the tangent", () => {
  const corner = {
    boxes: [
      { min: { x: -20, y: 0, z: -8 }, max: { x: 20, y: 4, z: -6 } },
      { min: { x: -6, y: 0, z: -20 }, max: { x: -4, y: 4, z: 20 } },
    ],
    ramps: [],
  };
  let pinned = createMoveState({ x: -3.2, y: 0, z: -5.2 });
  const into = { forward: 1, strafe: 0, jump: false, yawDeg: 45 };
  for (let i = 0; i < Math.round(0.8 / SIM_DT); i += 1) {
    pinned = stepMovement(pinned, into, SIM_DT, corner);
  }
  const cornerSpeed = planarSpeedOf(pinned.velocity);
  assert.ok(cornerSpeed < 0.15, `corner speed ${cornerSpeed}`);
  assert.ok(pinned.position.x > -4 + 0.2, `inside the west wall at x ${pinned.position.x}`);
  assert.ok(pinned.position.z > -6 + 0.2, `inside the north wall at z ${pinned.position.z}`);
  const parked = { x: pinned.position.x, z: pinned.position.z };
  for (let i = 0; i < Math.round(0.25 / SIM_DT); i += 1) {
    pinned = stepMovement(pinned, into, SIM_DT, corner);
  }
  assert.ok(Math.hypot(pinned.position.x - parked.x, pinned.position.z - parked.z) < 0.04);
  assert.ok(planarSpeedOf(pinned.velocity) < 0.15);

  const wall = {
    boxes: [{ min: { x: -30, y: 0, z: -8 }, max: { x: 30, y: 3, z: -6 } }],
    ramps: [],
  };
  const angle = (30 * Math.PI) / 180;
  const yaw = (Math.atan2(-Math.cos(angle), Math.sin(angle)) * 180) / Math.PI;
  let glance = {
    position: { x: 0, y: 0, z: -6 + CAPSULE_RADIUS + 0.4 },
    velocity: { x: 8 * Math.cos(angle), y: 0, z: -8 * Math.sin(angle) },
    grounded: true,
    timeOnGround: 1,
  };
  let kept = null;
  for (let i = 0; i < Math.round(0.4 / SIM_DT); i += 1) {
    glance = stepMovement(glance, { forward: 1, strafe: 0, jump: false, yawDeg: yaw }, SIM_DT, wall);
    if (kept === null && glance.position.z <= -6 + CAPSULE_RADIUS + 0.02 && Math.abs(glance.velocity.z) < 0.35) {
      kept = planarSpeedOf(glance.velocity);
    }
  }
  assert.ok(kept !== null, "glance never met the wall");
  assert.ok(Math.abs(kept - 8 * Math.cos(angle)) <= 0.35, `tangent ${kept}`);
  console.log(
    `measured corner speed m/s ${cornerSpeed.toFixed(3)} glance tangent ${kept.toFixed(3)}`,
  );
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
