// Personal bests. One localStorage key, written on death and never before it.
// A load does not write. A tie is not a new best. A throwing or missing
// localStorage keeps the bests in memory for this page and does not log.

import { formatClock, reachedWave } from "./waves.ts";

export const SCORES_KEY = "frag:scores:v1";

export const COPY_LABEL = "Copy score";
export const COPIED_LABEL = "Copied";

export interface PersonalBests {
  wave: number;
  frags: number;
  time: number;
}

export interface RunScore {
  wave: number;
  frags: number;
  time: number;
}

export interface NewBestFlags {
  wave: boolean;
  frags: boolean;
  time: boolean;
}

export const NO_NEW_BESTS: NewBestFlags = { wave: false, frags: false, time: false };

export interface ScoreStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ScoreHost {
  readonly localStorage: ScoreStorage;
}

export interface ScoreBook {
  bests(): PersonalBests | null;
  record(run: RunScore): { bests: PersonalBests; fresh: NewBestFlags };
}

export interface ClipboardWriter {
  writeText(text: string): Promise<void> | void;
}

interface ScoreSource {
  wave: number;
  frags: number;
  timeAlive: number;
}

function storageOf(store: ScoreHost): ScoreStorage | null {
  try {
    return store.localStorage;
  } catch {
    return null;
  }
}

function whole(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function duration(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

export function parseBests(raw: string): PersonalBests | null {
  try {
    const value = JSON.parse(raw) as { wave?: unknown; frags?: unknown; time?: unknown } | null;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const wave = whole(value.wave);
    const frags = whole(value.frags);
    const time = duration(value.time);
    if (wave === null || frags === null || time === null) return null;
    return { wave, frags, time };
  } catch {
    return null;
  }
}

export function scoreFromRecap(recap: ScoreSource): RunScore {
  const frags = Math.floor(recap.frags);
  const time = recap.timeAlive;
  return {
    wave: reachedWave(recap.wave),
    frags: Number.isFinite(frags) && frags >= 0 ? frags : 0,
    time: Number.isFinite(time) && time >= 0 ? time : 0,
  };
}

export function scoreLine(run: RunScore): string {
  const frags = Math.floor(run.frags);
  const shown = Number.isFinite(frags) && frags >= 0 ? frags : 0;
  return `FRAG — Wave ${reachedWave(run.wave)} | ${shown} frags | ${formatClock(run.time)}`;
}

function readBests(store: ScoreHost): PersonalBests | null {
  try {
    const storage = storageOf(store);
    if (!storage) return null;
    const raw = storage.getItem(SCORES_KEY);
    if (raw == null || raw === "") return null;
    return parseBests(raw);
  } catch {
    return null;
  }
}

function writeBests(store: ScoreHost, bests: PersonalBests): void {
  try {
    const storage = storageOf(store);
    if (!storage) return;
    storage.setItem(
      SCORES_KEY,
      JSON.stringify({ wave: bests.wave, frags: bests.frags, time: bests.time }),
    );
  } catch {
    // The book keeps the in-memory bests. Storage is optional.
  }
}

function cleanRun(run: RunScore): RunScore {
  return scoreFromRecap({ wave: run.wave, frags: run.frags, timeAlive: run.time });
}

export function createScoreBook(store: ScoreHost = window): ScoreBook {
  let memory = readBests(store);
  return {
    bests(): PersonalBests | null {
      return memory ? { ...memory } : null;
    },
    record(run: RunScore): { bests: PersonalBests; fresh: NewBestFlags } {
      const next = cleanRun(run);
      const previous = memory;
      const fresh: NewBestFlags = {
        wave: previous === null || next.wave > previous.wave,
        frags: previous === null || next.frags > previous.frags,
        time: previous === null || next.time > previous.time,
      };
      memory = {
        wave: previous === null ? next.wave : Math.max(previous.wave, next.wave),
        frags: previous === null ? next.frags : Math.max(previous.frags, next.frags),
        time: previous === null ? next.time : Math.max(previous.time, next.time),
      };
      writeBests(store, memory);
      return { bests: { ...memory }, fresh };
    },
  };
}

export function readClipboard(host: {
  readonly clipboard?: { writeText?: unknown } | null;
}): ClipboardWriter | null {
  try {
    const clipboard = host.clipboard;
    if (!clipboard || typeof clipboard.writeText !== "function") return null;
    return clipboard as ClipboardWriter;
  } catch {
    return null;
  }
}

export async function writeScoreLine(
  line: string,
  clipboard: ClipboardWriter | null | undefined,
): Promise<"copied" | "fallback"> {
  if (!clipboard || typeof clipboard.writeText !== "function") return "fallback";
  try {
    await clipboard.writeText(line);
    return "copied";
  } catch {
    return "fallback";
  }
}

export interface CopyFeedback {
  button: { textContent: string | null };
  line: { hidden: boolean | string; value: string };
}

/** Clipboard success reads Copied. A miss puts the line in the field. No throw. */
export function applyCopyFeedback(ui: CopyFeedback, result: "copied" | "fallback", line: string): void {
  if (result === "copied") {
    ui.line.hidden = true;
    ui.line.value = "";
    ui.button.textContent = COPIED_LABEL;
    return;
  }
  ui.button.textContent = COPY_LABEL;
  ui.line.hidden = false;
  ui.line.value = line;
}
