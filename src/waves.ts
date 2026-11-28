// Endless wave counts. There is no last wave and no arena clear.
//
// The schedule is waveComposition. Wave 1 is 2 drones. The first enforcer
// and the first rusher arrive on wave 2. Each clear adds one drone. A second
// enforcer arrives on wave 3. A second rusher arrives on wave 4. The cap is
// 4 drones, 2 enforcers, and 2 rushers, and it stays there.
//
// ENFORCER_ENABLED gates the live enforcer spawner. Rushers are part of the
// same plan. With the flag on, the waves are 2+0+0, 3+1+1, 4+2+1, then 4+2+2.

export const ENFORCER_ENABLED = true;

export const DRONE_CAP = 4;
export const ENFORCER_CAP = 2;
export const RUSHER_CAP = 2;

/** Quiet gap after the last enemy of a wave dies, before the next spawn. */
export const WAVE_GAP_SECONDS = 2;

export type WavePhase = "fighting" | "gap";

export interface WavePlan {
  drones: number;
  enforcers: number;
  rushers: number;
}

export interface DeathRecap {
  /** Wave the HUD was showing. Waves cleared is one behind on the opening wave. */
  wave: number;
  wavesCleared: number;
  frags: number;
  timeAlive: number;
}

/** The wave number on the HUD. A missing or empty value is wave 1. */
export function reachedWave(wave: number): number {
  const n = Math.floor(wave);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

export function waveComposition(wave: number): WavePlan {
  const n = Math.max(1, Math.floor(wave));
  return {
    drones: Math.min(DRONE_CAP, n + 1),
    enforcers: Math.min(ENFORCER_CAP, n <= 1 ? 0 : n >= 3 ? 2 : 1),
    rushers: Math.min(RUSHER_CAP, n <= 1 ? 0 : n >= 4 ? 2 : 1),
  };
}

/** What this release actually spawns. Enforcers stay at 0 while the flag is off. */
export function waveSpawnCounts(wave: number, enforcersEnabled = ENFORCER_ENABLED): WavePlan {
  const plan = waveComposition(wave);
  return {
    drones: plan.drones,
    enforcers: enforcersEnabled ? plan.enforcers : 0,
    rushers: plan.rushers,
  };
}

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(whole / 60);
  const secs = whole % 60;
  const mm = minutes < 10 ? `0${minutes}` : String(minutes);
  const ss = secs < 10 ? `0${secs}` : String(secs);
  return `${mm}:${ss}`;
}

export interface WaveDirector {
  readonly wave: number;
  readonly wavesCleared: number;
  readonly frags: number;
  readonly timeAlive: number;
  readonly phase: WavePhase;
  readonly gap: number;
  readonly pendingSpawn: boolean;
  readonly enforcers: number;
  plan(): WavePlan;
  addTime(dt: number): void;
  noteFrag(): void;
  noteEmpty(): void;
  stepGap(dt: number): void;
  acknowledgeSpawn(): void;
  restart(): void;
  recap(): DeathRecap;
}

export function createWaveDirector(options?: { enforcersEnabled?: boolean }): WaveDirector {
  const enforcersEnabled = options?.enforcersEnabled ?? ENFORCER_ENABLED;
  let wave = 1;
  let wavesCleared = 0;
  let frags = 0;
  let timeAlive = 0;
  let phase: WavePhase = "fighting";
  let gap = 0;
  let pendingSpawn = false;
  let enforcers = waveSpawnCounts(1, enforcersEnabled).enforcers;

  function plan(): WavePlan {
    return waveSpawnCounts(wave, enforcersEnabled);
  }

  return {
    get wave() {
      return wave;
    },
    get wavesCleared() {
      return wavesCleared;
    },
    get frags() {
      return frags;
    },
    get timeAlive() {
      return timeAlive;
    },
    get phase() {
      return phase;
    },
    get gap() {
      return gap;
    },
    get pendingSpawn() {
      return pendingSpawn;
    },
    get enforcers() {
      return enforcers;
    },
    plan,
    addTime(dt: number): void {
      if (Number.isFinite(dt) && dt > 0) timeAlive += dt;
    },
    noteFrag(): void {
      frags += 1;
    },
    noteEmpty(): void {
      if (phase !== "fighting") return;
      wavesCleared += 1;
      phase = "gap";
      gap = 0;
      pendingSpawn = false;
    },
    stepGap(dt: number): void {
      if (phase !== "gap") return;
      if (Number.isFinite(dt) && dt > 0) gap += dt;
      if (gap + 1e-3 < WAVE_GAP_SECONDS) return;
      wave += 1;
      phase = "fighting";
      gap = 0;
      pendingSpawn = true;
      enforcers = plan().enforcers;
    },
    acknowledgeSpawn(): void {
      pendingSpawn = false;
      enforcers = plan().enforcers;
    },
    restart(): void {
      wave = 1;
      wavesCleared = 0;
      frags = 0;
      timeAlive = 0;
      phase = "fighting";
      gap = 0;
      pendingSpawn = false;
      enforcers = waveSpawnCounts(1, enforcersEnabled).enforcers;
    },
    recap(): DeathRecap {
      return { wave, wavesCleared, frags, timeAlive };
    },
  };
}
