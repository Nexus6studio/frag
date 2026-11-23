// The only place a WISP-4 bolt or a UNIT-7 stun blast changes the player.
//
// Both call applyDamage, so armor absorbs min(A, floor(D·2/3)) and the rest
// comes off HP. A hit that would remove less than 1 HP still removes 1.

import type { Vec3 } from "../move.ts";
import { applyDamage } from "../pickups.ts";
import type { PlayerStore } from "./state.ts";

export type HurtSource = (source: Vec3) => void;

const hurtSources = new Set<HurtSource>();

/** The listener runs before damagePlayer returns. It must not keep the vector. */
export function subscribePlayerHurt(listener: HurtSource): () => void {
  hurtSources.add(listener);
  return () => {
    hurtSources.delete(listener);
  };
}

export function damagePlayer(player: PlayerStore, amount: number, source?: Vec3): void {
  const vitals = player.get();
  // A downed player stays at the recap. Later bolts do not chip armor or HP.
  if (vitals.hp <= 0) return;
  const next = applyDamage(amount, vitals.hp, vitals.armor);
  if (next.hp === vitals.hp && next.armor === vitals.armor) return;
  player.set({ hp: next.hp, armor: next.armor });
  if (!source) return;
  for (const listener of hurtSources) listener(source);
}
