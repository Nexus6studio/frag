import type { PlayerStore, PlayerVitals } from "../player/state";
import { formatClock, type DeathRecap } from "../waves.ts";

export type { DeathRecap };

// Armor is deferred. The readout stays invisible, and the slot keeps its box
// so turning this on later does not move HP or ammo.
export const SHOW_ARMOR = false;

export type HudMode = "hidden" | "play" | "dim" | "dead";

export type HudReadout = {
  hp: string;
  armor: string;
  ammo: string;
  showArmor: boolean;
  mode: HudMode;
};

export type HudElements = {
  root: HTMLElement;
  hp: HTMLElement;
  armor: HTMLElement;
  ammo: HTMLElement;
  armorStat: HTMLElement;
  death: HTMLElement;
};

export function hudMode(phase: string | null, hp: number): HudMode {
  // Pause stays in front of a death recap so Esc still reaches the pause overlay.
  if (phase === "paused") return "dim";
  if (phase !== "playing") return "hidden";
  if (hp <= 0) return "dead";
  return "play";
}

export function hudReadout(state: PlayerVitals, phase: string | null): HudReadout {
  return {
    hp: String(state.hp),
    armor: String(state.armor),
    ammo: `${state.mag}+${state.reserve}`,
    showArmor: SHOW_ARMOR,
    mode: hudMode(phase, state.hp),
  };
}

export function deathRecapText(recap: DeathRecap): string {
  return `waves ${recap.wavesCleared}\nfrags ${recap.frags}\n${formatClock(recap.timeAlive)}\nclick to restart`;
}

export function applyHud(els: HudElements, view: HudReadout, recap?: DeathRecap | null): void {
  els.root.dataset.mode = view.mode;
  els.hp.textContent = view.hp;
  els.armor.textContent = view.armor;
  els.ammo.textContent = view.ammo;
  els.armorStat.dataset.visible = view.showArmor ? "true" : "false";
  els.armorStat.style.visibility = view.showArmor ? "visible" : "hidden";
  if (view.showArmor) els.armorStat.removeAttribute("aria-hidden");
  else els.armorStat.setAttribute("aria-hidden", "true");
  els.death.hidden = view.mode !== "dead";
  if (recap) els.death.textContent = deathRecapText(recap);
}

export function bindHud(
  player: PlayerStore,
  els: HudElements,
  getPhase: () => string | null,
  onRender?: () => void,
  hooks?: { getRecap?: () => DeathRecap },
): { update(): void; destroy(): void } {
  const update = (): void => {
    applyHud(els, hudReadout(player.get(), getPhase()), hooks?.getRecap?.() ?? null);
    onRender?.();
  };
  const unsubscribe = player.subscribe(update);
  update();
  return {
    update,
    destroy(): void {
      unsubscribe();
    },
  };
}
