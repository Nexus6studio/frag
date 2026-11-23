// One restart for a death click. The content warning is a shell phase and is
// not touched here, so the same page load does not show it again.

import type { Vec3 } from "./move.ts";
import type { PlayerStore } from "./player/state.ts";

export interface CombatRestart {
  reset(): void;
}

export interface WaveRestart {
  restart(origin: Vec3): void;
}

export function restartCombat(input: {
  player: PlayerStore;
  quill: CombatRestart;
  pickups: CombatRestart;
  wisps: WaveRestart;
  origin: Vec3;
}): void {
  input.quill.reset();
  input.pickups.reset();
  input.wisps.restart(input.origin);
  input.player.restart();
}
