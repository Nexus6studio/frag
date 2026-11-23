// The only place a WISP-4 bolt changes the player.
//
// FRAG-012's applyDamage(amount, hp, armor) absorbs armor and clamps HP.
// It is not on main yet. The line marked below is the whole switch: replace
// it with applyDamage(amount, vitals.hp, vitals.armor) and leave the write.

import type { PlayerStore } from "./state.ts";

export interface HurtResult {
  hp: number;
  armor: number;
}

export function damagePlayer(player: PlayerStore, amount: number): void {
  const vitals = player.get();
  // FRAG-012 seam: applyDamage(amount, vitals.hp, vitals.armor)
  const next = hurtDirect(amount, vitals.hp, vitals.armor);
  if (next.hp === vitals.hp && next.armor === vitals.armor) return;
  player.set({ hp: next.hp, armor: next.armor });
}

function hurtDirect(amount: number, hp: number, armor: number): HurtResult {
  const dealt = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const base = Number.isFinite(hp) ? hp : 0;
  return { hp: Math.max(0, base - dealt), armor };
}
