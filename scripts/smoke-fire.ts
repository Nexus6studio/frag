// Sim-time verdicts for the headless smoke checks.
//
// A software-GL frame can sit for seconds while the sim only steps 250 ms.
// A hold, a reload, a one-meter walk, and the wave-3 bolt are ready when that
// sim time has elapsed, which may be after a wall-clock deadline. These judges
// fail work that had its sim interval and did not happen. Wall time only
// reports a sim that has stopped advancing.

import { GROUND_ACCEL, GROUND_WISH_SPEED, MAX_FRAME_SECONDS } from "../src/move.ts";
import { QUILL_INTERVAL, QUILL_MAG, QUILL_RELOAD } from "../src/quill.ts";
import { WAVE_GAP_SECONDS } from "../src/waves.ts";
import { WISP_TELEGRAPH, wispSpawnGrace } from "../src/wisp.ts";

/** Rounds a held trigger must spend before the smoke check accepts full-auto. */
export const HELD_FIRE_ROUNDS = 6;

export function heldFireBudgetSeconds(): number {
  // The first round leaves at once. The other five wait on the 0.125 s clock.
  // One clamped frame covers the step that both fires the last round and moves sim.
  return (HELD_FIRE_ROUNDS - 1) * QUILL_INTERVAL + MAX_FRAME_SECONDS;
}

export function reloadBudgetSeconds(): number {
  // The key is sampled on the next frame. The reload then runs for 1.4 s.
  return QUILL_RELOAD + MAX_FRAME_SECONDS;
}

/** Meters of -Z the smoke walk must cover before it lets go of W. */
export const FORWARD_MOVE_METERS = 1;

/** Degrees off spawn facing that count as the dev-page mouse move. */
export const LOOK_YAW_AWAY = 5;
export const LOOK_PITCH_AWAY = 15;

export function lookLeaveBudgetSeconds(): number {
  // The move is sampled on a later frame. The frame already in progress can
  // miss it, so the budget is two clamped steps.
  return 2 * MAX_FRAME_SECONDS;
}

export function forwardMoveBudgetSeconds(yawDeg = 0): number {
  // The check wants one meter of -Z. Wish accel is along the facing, so a
  // look that is off spawn-north covers that meter more slowly. Cruise time
  // is zero while the meter is still inside the accel ramp. One clamped frame
  // covers the step that both crosses the meter and moves sim.
  const along = Math.cos((yawDeg * Math.PI) / 180);
  if (!(along > 1e-3)) return MAX_FRAME_SECONDS;
  const accelDistance = (GROUND_WISH_SPEED * GROUND_WISH_SPEED * along) / (2 * GROUND_ACCEL);
  if (accelDistance >= FORWARD_MOVE_METERS) {
    return Math.sqrt((2 * FORWARD_MOVE_METERS) / (GROUND_ACCEL * along)) + MAX_FRAME_SECONDS;
  }
  const accelTime = GROUND_WISH_SPEED / GROUND_ACCEL;
  const cruise = (FORWARD_MOVE_METERS - accelDistance) / (GROUND_WISH_SPEED * along);
  return accelTime + cruise + MAX_FRAME_SECONDS;
}

export function wave3BoltBudgetSeconds(): number {
  // The poll kills wave 1 at once. Each later wave waits out a 2 s gap, and a
  // clamped frame can straddle the moment the gap ends. The poll that kills
  // wave 2 lands on the next frame. Wave 3's lead drone then spends the later
  // wave's grace plus the telegraph. One more clamped frame is the step that
  // both fires the first bolt and moves sim.
  const straddledGap = WAVE_GAP_SECONDS + MAX_FRAME_SECONDS;
  const firstBolt = wispSpawnGrace(3) + WISP_TELEGRAPH + MAX_FRAME_SECONDS;
  return straddledGap + MAX_FRAME_SECONDS + straddledGap + firstBolt;
}

export type MoveSample = {
  sim: number;
  z: number;
  hp: number;
  phase: string;
};

export type LookSample = {
  sim: number;
  yaw: number;
  pitch: number;
};

export type WaveSample = {
  sim: number;
  wave: number;
  count: number;
  enforcerAlive: number;
  bolts: number;
  calls: number;
  ready: boolean;
};

export type QuillSample = {
  sim: number;
  shots: number;
  mag: number;
  reserve: number;
  reloading: boolean;
  hud: string;
  hp: number;
  phase: string;
};

export type Verdict =
  | { state: "pending" }
  | { state: "pass" }
  | { state: "fail"; code: string; reason: string };

function fail(code: string, reason: string): Verdict {
  return { state: "fail", code, reason };
}

export function hudMag(hud: string): number {
  const mag = Number(hud.trim().split("+")[0]);
  return Number.isFinite(mag) ? mag : Number.NaN;
}

function finiteSample(sample: QuillSample): boolean {
  return Number.isFinite(sample.sim) && Number.isFinite(sample.mag) && Number.isFinite(sample.shots);
}

export function judgeHeldFire(start: { sim: number; shots: number }, sample: QuillSample): Verdict {
  if (!finiteSample(sample) || !Number.isFinite(start.sim) || !Number.isFinite(start.shots)) {
    return fail("missing", "quill sample missing");
  }
  const spent = sample.shots - start.shots;
  const readout = hudMag(sample.hud);
  const dropped = spent >= HELD_FIRE_ROUNDS && sample.mag <= QUILL_MAG - HELD_FIRE_ROUNDS;
  if (dropped && readout <= QUILL_MAG - HELD_FIRE_ROUNDS) return { state: "pass" };
  if (sample.phase !== "playing") return fail("phase", `phase ${sample.phase}`);
  if (!(sample.hp > 0)) return fail("dead", `player died (hp ${sample.hp})`);
  if (dropped) return fail("hud", `hud ${sample.hud.trim()} did not follow mag ${sample.mag}`);
  if (sample.sim - start.sim > heldFireBudgetSeconds()) {
    return fail(
      "not-fired",
      `hold spent ${spent} rounds in ${(sample.sim - start.sim).toFixed(3)}s sim (hud ${sample.hud.trim()})`,
    );
  }
  return { state: "pending" };
}

export function judgeReload(start: { sim: number; mag: number; reserve: number }, sample: QuillSample): Verdict {
  if (
    !finiteSample(sample) ||
    !Number.isFinite(sample.reserve) ||
    !Number.isFinite(start.sim) ||
    !Number.isFinite(start.mag) ||
    !Number.isFinite(start.reserve)
  ) {
    return fail("missing", "quill sample missing");
  }
  const readout = hudMag(sample.hud);
  const filled =
    sample.mag === QUILL_MAG && sample.reserve < start.reserve && !sample.reloading && readout === QUILL_MAG;
  if (filled) return { state: "pass" };
  if (sample.phase !== "playing") return fail("phase", `phase ${sample.phase}`);
  if (!(sample.hp > 0)) return fail("dead", `player died (hp ${sample.hp}, hud ${sample.hud.trim()})`);
  if (sample.sim - start.sim > reloadBudgetSeconds()) {
    if (!sample.reloading && sample.mag === start.mag && sample.reserve === start.reserve) {
      return fail("not-sampled", `reload was not sampled (hud ${sample.hud.trim()})`);
    }
    return fail(
      "not-refilled",
      `reload did not refill (hud ${sample.hud.trim()}, reloading ${sample.reloading})`,
    );
  }
  return { state: "pending" };
}

export function judgeForwardMove(start: { sim: number; z: number; yaw: number }, sample: MoveSample): Verdict {
  if (
    !Number.isFinite(sample.sim) ||
    !Number.isFinite(sample.z) ||
    !Number.isFinite(start.sim) ||
    !Number.isFinite(start.z) ||
    !Number.isFinite(start.yaw)
  ) {
    return fail("missing", "move sample missing");
  }
  if (start.z - sample.z > FORWARD_MOVE_METERS) return { state: "pass" };
  if (sample.phase !== "playing") return fail("phase", `phase ${sample.phase}`);
  if (!(sample.hp > 0)) return fail("dead", `player died (hp ${sample.hp})`);
  const along = Math.cos((start.yaw * Math.PI) / 180);
  if (!(along > 1e-3)) return fail("facing", `yaw ${start.yaw.toFixed(1)} does not face -z`);
  if (sample.sim - start.sim > forwardMoveBudgetSeconds(start.yaw)) {
    return fail(
      "not-moved",
      `forward ${(start.z - sample.z).toFixed(2)} m in ${(sample.sim - start.sim).toFixed(3)}s sim at yaw ${start.yaw.toFixed(1)}`,
    );
  }
  return { state: "pending" };
}

export function judgeLookLeftSpawn(start: { sim: number }, sample: LookSample): Verdict {
  if (
    !Number.isFinite(sample.sim) ||
    !Number.isFinite(sample.yaw) ||
    !Number.isFinite(sample.pitch) ||
    !Number.isFinite(start.sim)
  ) {
    return fail("missing", "look sample missing");
  }
  if (Math.abs(sample.pitch) > LOOK_PITCH_AWAY || Math.abs(sample.yaw) > LOOK_YAW_AWAY) return { state: "pass" };
  if (sample.sim - start.sim > lookLeaveBudgetSeconds()) {
    return fail(
      "not-turned",
      `yaw ${sample.yaw.toFixed(1)} pitch ${sample.pitch.toFixed(1)} after ${(sample.sim - start.sim).toFixed(3)}s sim`,
    );
  }
  return { state: "pending" };
}

export function judgeWave3Bolts(start: { sim: number }, sample: WaveSample): Verdict {
  if (!sample.ready || !Number.isFinite(sample.sim) || !Number.isFinite(start.sim)) {
    return fail("missing", "wave sample missing");
  }
  const fielded =
    sample.wave >= 3 &&
    sample.count === 4 &&
    sample.enforcerAlive === 2 &&
    sample.bolts > 0 &&
    sample.calls > 0;
  if (fielded) return { state: "pass" };
  if (sample.sim - start.sim > wave3BoltBudgetSeconds()) {
    return fail(
      "not-fielded",
      `wave ${sample.wave} count ${sample.count} enforcers ${sample.enforcerAlive} bolts ${sample.bolts} calls ${sample.calls} after ${(sample.sim - start.sim).toFixed(3)}s sim`,
    );
  }
  return { state: "pending" };
}

export async function settleSimVerdict<T extends { sim: number }>(options: {
  read: () => Promise<T>;
  judge: (sample: T) => Verdict;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
  hangMs?: number;
  pollMs?: number;
}): Promise<{ verdict: Verdict; sample: T | null }> {
  const now = options.now ?? (() => Date.now());
  const hangMs = options.hangMs ?? 15_000;
  const pollMs = options.pollMs ?? 50;
  const delay =
    options.delay ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastSim = Number.NEGATIVE_INFINITY;
  let lastMove = now();
  let sample: T | null = null;
  for (;;) {
    if (now() - lastMove >= hangMs) {
      return {
        verdict: { state: "fail", code: "stalled", reason: `sim stalled at ${sample?.sim ?? "missing"}` },
        sample,
      };
    }
    sample = await options.read();
    if (Number.isFinite(sample.sim) && sample.sim > lastSim) {
      lastSim = sample.sim;
      lastMove = now();
    }
    const verdict = options.judge(sample);
    if (verdict.state !== "pending") return { verdict, sample };
    await delay(pollMs);
  }
}
