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
  cue?: HTMLElement;
};

/** The recap ignores input for this long so a held shot cannot skip it. */
export const RECAP_ARM_SECONDS = 1;

export function recapAcceptsInput(elapsedSeconds: number): boolean {
  return Number.isFinite(elapsedSeconds) && elapsedSeconds >= RECAP_ARM_SECONDS - 1e-6;
}

/** A death click restarts only from the live recap. Pause and a blur do not. */
export function acceptRestartClick(input: {
  mode: string | null;
  phase: string | null;
  hidden: boolean;
}): boolean {
  if (input.hidden) return false;
  if (input.phase !== "playing") return false;
  return input.mode === "dead";
}

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
  // Playing used to leave this full-viewport button in the hit-test tree:
  // author `display: flex` beats the user-agent `[hidden]` rule, so a missing
  // author override swallows clicks. Inline `display: none` wins either way.
  const dead = view.mode === "dead";
  els.death.hidden = !dead;
  els.death.inert = !dead;
  els.death.style.display = dead ? "" : "none";
  els.death.style.pointerEvents = dead ? "auto" : "none";
  if (dead) els.death.removeAttribute("aria-hidden");
  else els.death.setAttribute("aria-hidden", "true");
  if (recap) els.death.textContent = deathRecapText(recap);
  if (els.cue) {
    const empty = view.ammo === "0+0";
    const reloading = !empty && view.ammo.startsWith("0+");
    els.cue.hidden = !empty && !reloading;
    els.cue.textContent = empty ? "EMPTY" : "RELOAD";
  }
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
