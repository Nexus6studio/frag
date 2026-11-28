import type { PlayerStore, PlayerVitals } from "../player/state";
import { NO_NEW_BESTS, type NewBestFlags } from "../scores.ts";
import { formatClock, reachedWave, type DeathRecap } from "../waves.ts";

export type { DeathRecap };

// The armor readout sits between HP and ammo and uses the same label size.
export const SHOW_ARMOR = true;

export type HudMode = "hidden" | "play" | "dim" | "dead";

export type HudReadout = {
  hp: string;
  armor: string;
  ammo: string;
  showArmor: boolean;
  mode: HudMode;
};

export type RecapFields = {
  wave: HTMLElement;
  frags: HTMLElement;
  time: HTMLElement;
  waveBadge: HTMLElement;
  fragsBadge: HTMLElement;
  timeBadge: HTMLElement;
};

export type HudElements = {
  root: HTMLElement;
  hp: HTMLElement;
  armor: HTMLElement;
  ammo: HTMLElement;
  armorStat: HTMLElement;
  death: HTMLElement;
  cue?: HTMLElement;
  recap?: RecapFields;
};

export type { NewBestFlags };

/** Where a recap click landed. The card restarts. Copy and its line do not. */
export type RecapTarget = "card" | "copy" | "line";

/** The recap ignores input for this long so a held shot cannot skip it. */
export const RECAP_ARM_SECONDS = 1;

export function recapAcceptsInput(elapsedSeconds: number): boolean {
  return Number.isFinite(elapsedSeconds) && elapsedSeconds >= RECAP_ARM_SECONDS - 1e-6;
}

/**
 * What Enter should do to the recap.
 * `ignore` leaves the key alone. `swallow` is the lockout: the player is dead,
 * the recap is up, and the press must not restart. `keep` is Copy score or its
 * line: the press stays on that control and does not restart. `restart` is a
 * real confirm on the rest of the card. A pause resume is `ignore` even when
 * HP is already 0. Esc and the killing blow can land in one turn, and that
 * Enter is the pause overlay, not the recap.
 */
export function recapEnterAction(input: {
  code: string;
  repeat: boolean;
  pauseResume: boolean;
  hp: number;
  phase: string | null;
  armed: boolean;
  target?: RecapTarget;
}): "ignore" | "swallow" | "keep" | "restart" {
  if (input.code !== "Enter" || input.repeat) return "ignore";
  if (input.pauseResume) return "ignore";
  if (!(input.hp <= 0)) return "ignore";
  // Paused, or still on the way there: the shell owns this Enter.
  if (input.phase !== "playing") return "ignore";
  if (!input.armed) return "swallow";
  const target = input.target ?? "card";
  if (target === "copy" || target === "line") return "keep";
  return "restart";
}

export function recapClickAction(input: {
  armed: boolean;
  target: RecapTarget;
  restartable: boolean;
}): "swallow" | "keep" | "restart" {
  if (!input.armed || !input.restartable) return "swallow";
  if (input.target === "copy" || input.target === "line") return "keep";
  return "restart";
}

export function recapTarget(
  target: EventTarget | null,
  copy: { contains(node: Node): boolean } | null,
  line: { contains(node: Node): boolean } | null,
): RecapTarget {
  if (inside(target, copy)) return "copy";
  if (inside(target, line)) return "line";
  return "card";
}

/**
 * Pointer lock retargets the event at the canvas. The coordinates still name
 * the control under the cursor, so a locked click can copy without restarting.
 */
export function recapTargetAt(
  target: EventTarget | null,
  x: number,
  y: number,
  hit: ((x: number, y: number) => EventTarget | null) | null,
  copy: { contains(node: Node): boolean } | null,
  line: { contains(node: Node): boolean } | null,
): RecapTarget {
  const direct = recapTarget(target, copy, line);
  if (direct !== "card" || !hit) return direct;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return direct;
  try {
    const placed = recapTarget(hit(x, y), copy, line);
    return placed;
  } catch {
    return direct;
  }
}

function inside(target: EventTarget | null, control: { contains(node: Node): boolean } | null): boolean {
  if (!target || !control) return false;
  if (target === (control as unknown as EventTarget)) return true;
  try {
    return control.contains(target as Node);
  } catch {
    return false;
  }
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

export function waveLabel(wave: number): string {
  return `Reached wave ${reachedWave(wave)}`;
}

export function fragsLabel(frags: number): string {
  const n = Math.floor(frags);
  const shown = Number.isFinite(n) && n >= 0 ? n : 0;
  return `${shown} frags`;
}

export function deathRecapText(recap: DeathRecap): string {
  return `${waveLabel(recap.wave)}\n${fragsLabel(recap.frags)}\n${formatClock(recap.timeAlive)}\nclick to restart`;
}

export function paintRecap(fields: RecapFields, recap: DeathRecap, fresh: NewBestFlags = NO_NEW_BESTS): void {
  fields.wave.textContent = waveLabel(recap.wave);
  fields.frags.textContent = fragsLabel(recap.frags);
  fields.time.textContent = formatClock(recap.timeAlive);
  fields.waveBadge.hidden = !fresh.wave;
  fields.fragsBadge.hidden = !fresh.frags;
  fields.timeBadge.hidden = !fresh.time;
}

export function applyHud(
  els: HudElements,
  view: HudReadout,
  recap?: DeathRecap | null,
  fresh?: NewBestFlags | null,
): void {
  els.root.dataset.mode = view.mode;
  els.hp.textContent = view.hp;
  els.armor.textContent = view.armor;
  els.ammo.textContent = view.ammo;
  els.armorStat.dataset.visible = view.showArmor ? "true" : "false";
  // An inline visible value paints through a visibility:hidden parent, so the
  // death recap would keep the armor chip. Drop it and let the hidden bar win.
  els.armorStat.style.visibility = !view.showArmor ? "hidden" : view.mode === "dead" ? "" : "visible";
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
  if (recap && els.recap) paintRecap(els.recap, recap, fresh ?? NO_NEW_BESTS);
  else if (recap) els.death.textContent = deathRecapText(recap);
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
  hooks?: { getRecap?: () => DeathRecap; onDeath?: (recap: DeathRecap) => NewBestFlags },
): { update(): void; destroy(): void } {
  let deadNoted = false;
  let fresh: NewBestFlags = NO_NEW_BESTS;
  const update = (): void => {
    const hp = player.get().hp;
    if (hp > 0) {
      deadNoted = false;
      fresh = NO_NEW_BESTS;
    } else if (!deadNoted) {
      deadNoted = true;
      const died = hooks?.getRecap?.();
      if (died && hooks?.onDeath) fresh = hooks.onDeath(died);
    }
    const show = hp <= 0 ? fresh : NO_NEW_BESTS;
    applyHud(els, hudReadout(player.get(), getPhase()), hooks?.getRecap?.() ?? null, show);
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
