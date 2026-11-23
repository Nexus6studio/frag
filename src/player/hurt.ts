// The only place a WISP-4 bolt or a UNIT-7 stun blast changes the player.
//
// Both call applyDamage, so armor absorbs min(A, floor(D·2/3)) and the rest
// comes off HP. A hit that would remove less than 1 HP still removes 1.

import { applyDamage } from "../pickups.ts";
import type { PlayerStore } from "./state.ts";

export function damagePlayer(player: PlayerStore, amount: number): void {
  const vitals = player.get();
  // A downed player stays at the recap. Later bolts do not chip armor or HP.
  if (vitals.hp <= 0) return;
  const next = applyDamage(amount, vitals.hp, vitals.armor);
  if (next.hp === vitals.hp && next.armor === vitals.armor) return;
  player.set({ hp: next.hp, armor: next.armor });
}
