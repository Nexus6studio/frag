// Names for the procedural cues. The sim reports these events. The audio
// module turns them into tones. Nothing here touches the Web Audio API, so
// the mapping stays unit-testable without a browser.

export const LOW_HP = 25;

export type SimEvent =
  | { type: "quill-shot" }
  | { type: "quill-dry" }
  | { type: "quill-charge" }
  | { type: "quill-charge-end" }
  | { type: "quill-charge-abort" }
  | { type: "reload-start" }
  | { type: "reload-end" }
  | { type: "enemy-hit" }
  | { type: "enemy-kill" }
  | { type: "wisp-shot" }
  | { type: "enforcer-shot" }
  | { type: "rusher-windup" }
  | { type: "pickup"; kind: "health" | "armor" | "ammo" }
  | { type: "player-hurt" }
  | { type: "jump-pad" };

export type CueId =
  | "flechette"
  | "dry"
  | "charge"
  | "charge-end"
  | "charge-abort"
  | "reload-slide"
  | "reload-lock"
  | "hit"
  | "kill"
  | "wisp"
  | "enforcer"
  | "rusher"
  | "health"
  | "armor"
  | "ammo"
  | "hurt"
  | "whoosh";

export type CueListener = (event: SimEvent) => void;

export function cueFor(event: SimEvent): CueId {
  switch (event.type) {
    case "quill-shot":
      return "flechette";
    case "quill-dry":
      return "dry";
    case "quill-charge":
      return "charge";
    case "quill-charge-end":
      return "charge-end";
    case "quill-charge-abort":
      return "charge-abort";
    case "reload-start":
      return "reload-slide";
    case "reload-end":
      return "reload-lock";
    case "enemy-hit":
      return "hit";
    case "enemy-kill":
      return "kill";
    case "wisp-shot":
      return "wisp";
    case "enforcer-shot":
      return "enforcer";
    case "rusher-windup":
      return "rusher";
    case "pickup":
      return event.kind;
    case "player-hurt":
      return "hurt";
    case "jump-pad":
      return "whoosh";
  }
}

/**
 * Fundamental in hertz for the cues that are pitched on purpose.
 * Health, armor, and ammo do not share one. The kill chime is not the hit tick.
 * Each one sits under 900 Hz, below the band the short cues used to pierce.
 */
export function cuePitch(cue: CueId): number | null {
  if (cue === "health") return 349.23;
  if (cue === "armor") return 440;
  if (cue === "ammo") return 523.25;
  if (cue === "kill") return 466;
  if (cue === "hit") return 840;
  return null;
}

/** True while the low-HP pulse should run. Off at 0 and above 25. */
export function heartbeatWanted(hp: number): boolean {
  return Number.isFinite(hp) && hp > 0 && hp <= LOW_HP;
}

/** A real HP drop. Healing, a flat update, and the 0 → 100 restart are not hits. */
export function hurtFromVitals(previousHp: number, nextHp: number): boolean {
  return previousHp > 0 && nextHp < previousHp;
}
