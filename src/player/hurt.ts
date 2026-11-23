// The only place a WISP-4 bolt changes the player.
//
// Bolts call applyDamage, so armor absorbs min(A, floor(D·2/3)) and the rest
// comes off HP. Armor is 0 in this release, which makes an 8-damage bolt
// remove 8 HP.

import { applyDamage } from "../pickups.ts";
import type { PlayerStore } from "./state.ts";

export function damagePlayer(player: PlayerStore, amount: number): void {
  const vitals = player.get();
  const next = applyDamage(amount, vitals.hp, vitals.armor);
  if (next.hp === vitals.hp && next.armor === vitals.armor) return;
  player.set({ hp: next.hp, armor: next.armor });
}
