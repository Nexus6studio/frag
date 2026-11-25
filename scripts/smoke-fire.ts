// Sim-time verdicts for the headless hold-fire and reload checks.
//
// A software-GL frame can sit for seconds while the sim only steps 250 ms.
// The magazine and the reload are ready when that sim time has elapsed, which
// may be after a 15 s wall clock. These judges fail a hold or a reload that
// had its sim interval and did not do the work. Wall time only reports a sim
// that has stopped advancing.

import { MAX_FRAME_SECONDS } from "../src/move.ts";
import { QUILL_INTERVAL, QUILL_MAG, QUILL_RELOAD } from "../src/quill.ts";

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
