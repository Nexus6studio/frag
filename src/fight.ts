// One wave clock for drones and enforcers. The gap starts only when both
// pools are empty, and the next spawn refills both from that same plan.

import type { Hull, Vec3 } from "./move.ts";
import type { HitboxWorld } from "./hitbox.ts";
import type { PlayerStore } from "./player/state.ts";
import { createEnforcerSim, type EnforcerSim } from "./enforcer.ts";
import { createWispSim, type WispSim, type WispSnapshot } from "./wisp.ts";
import { createWaveDirector, type WaveDirector } from "./waves.ts";

export interface Fight {
  readonly wisps: WispSim;
  readonly enforcers: EnforcerSim;
  readonly director: WaveDirector;
  update(dt: number, feet: Vec3): void;
  killAll(): void;
  snapshot(): WispSnapshot & {
    enforcerAlive: number;
    enforcerShots: number;
    enforcerHits: number;
    enforcerFirstShot: number | null;
    enforcerUnits: { x: number; y: number; z: number; alive: boolean; hp: number }[];
  };
}

export function createFight(options: {
  hull: Hull;
  player: PlayerStore;
  hitboxes: HitboxWorld;
  origin?: Vec3;
  enforcersEnabled?: boolean;
}): Fight {
  const director = createWaveDirector({ enforcersEnabled: options.enforcersEnabled });
  let poke = (): void => {};
  const enforcers = createEnforcerSim({
    hull: options.hull,
    player: options.player,
    hitboxes: options.hitboxes,
    director,
    onCleared: () => poke(),
  });
  const wisps = createWispSim({
    hull: options.hull,
    player: options.player,
    hitboxes: options.hitboxes,
    origin: options.origin,
    director,
    alliesAlive: () => enforcers.aliveCount(),
    onWaveSpawn: (plan, feet) => enforcers.spawnCount(plan.enforcers, feet),
  });
  poke = () => wisps.notifyAllies();

  return {
    wisps,
    enforcers,
    director,
    update(dt: number, feet: Vec3): void {
      wisps.update(dt, feet);
      enforcers.update(dt, feet);
    },
    killAll(): void {
      enforcers.killAlive();
      wisps.killAlive();
    },
    snapshot() {
      const drones = wisps.snapshot();
      const hounds = enforcers.snapshot();
      return {
        ...drones,
        enforcerAlive: hounds.alive,
        enforcerShots: hounds.shots,
        enforcerHits: hounds.hits,
        enforcerFirstShot: hounds.firstShot,
        enforcerUnits: hounds.units,
      };
    },
  };
}
