// Combat readability.
//
// A crosshair X, a short white-cyan flash on the enemy that was hit, an arc
// on the screen edge toward whoever just damaged the player, and a small
// Quill viewmodel kick. The kick, the strafe lean, and the walk bob stay
// inside a couple of centimeters so the carbine cannot leave the frame.
// Nothing here is stored.

import type { Vec3 } from "./move.ts";

/** Crosshair X, hit or kill. Long enough to read, gone before the next glance. */
export const HIT_MARKER_SECONDS = 0.08;
/** Kill confirm is the same beat, drawn larger. */
export const KILL_MARKER_SCALE = 1.7;
/** Emissive flash on a drone or an enforcer that just took a flechette. */
export const HIT_FLASH_SECONDS = 0.06;
/** White with a cyan bias. Views multiply by the flash still remaining. */
export const HIT_FLASH_RGB: readonly [number, number, number] = [0.72, 0.95, 1];

/** Edge arc lifetime. */
export const ARC_LIFE_SECONDS = 0.4;
/** Overlapping hits replace the oldest arc past this count. */
export const ARC_CAP = 3;
/** Painted opacities are scaled down so a burst cannot cover the view. */
export const ARC_OPACITY_BUDGET = 1.35;
/** A new hit this close to a live arc refreshes that arc instead of stacking. */
export const ARC_MERGE_RAD = 0.4;
const ARC_PEAK = 0.82;
/** How far from the viewport center an arc sits, as a fraction of the view. */
const ARC_REACH = 0.46;

export const VIEW_REST = { x: 0.2, y: -0.22, z: -0.38 } as const;
/** Rear of the carbine in viewmodel space. +Z points back toward the camera. */
export const VIEW_STOCK_LOCAL_Z = 0.27;
/** Matches the camera near clip. The stock has to stay in front of it. */
export const VIEW_NEAR = 0.08;

export type MarkerKind = "none" | "hit" | "kill";

export interface MarkerState {
  kind: MarkerKind;
  age: number;
}

export interface MarkerView {
  kind: MarkerKind;
  /** 1 when the flash starts, 0 when it is gone. */
  opacity: number;
  scale: number;
}

export function freshMarker(): MarkerState {
  return { kind: "none", age: 0 };
}

/** A kill replaces a hit. A hit does not downgrade a kill that is still showing. */
export function noteMarker(state: MarkerState, killed: boolean): MarkerState {
  if (killed) return { kind: "kill", age: 0 };
  if (state.kind === "kill" && state.age < HIT_MARKER_SECONDS) return state;
  return { kind: "hit", age: 0 };
}

export function stepMarker(state: MarkerState, dt: number): MarkerState {
  if (state.kind === "none" || !(dt > 0)) return state;
  const age = state.age + dt;
  if (age >= HIT_MARKER_SECONDS) return freshMarker();
  return { kind: state.kind, age };
}

export function markerView(state: MarkerState): MarkerView {
  if (state.kind === "none") return { kind: "none", opacity: 0, scale: 1 };
  const left = 1 - state.age / HIT_MARKER_SECONDS;
  return {
    kind: state.kind,
    opacity: left < 0 ? 0 : left,
    scale: state.kind === "kill" ? KILL_MARKER_SCALE : 1,
  };
}

/** 1 at the start of the enemy flash, 0 once the 60 ms are gone. */
export function hitFlashAlpha(remaining: number): number {
  if (!(remaining > 0)) return 0;
  const t = remaining / HIT_FLASH_SECONDS;
  return t > 1 ? 1 : t;
}

export interface DamageArc {
  /** Radians. 0 is ahead, positive is to the player's right, ±π is behind. */
  bearing: number;
  age: number;
}

export interface PaintedArc {
  /** Viewport fractions. The arc is drawn around this point. */
  x: number;
  y: number;
  rotation: number;
  opacity: number;
}

function wrapPi(angle: number): number {
  const tau = Math.PI * 2;
  const wrapped = ((angle + Math.PI) % tau + tau) % tau - Math.PI;
  if (wrapped <= -Math.PI + 1e-12) return Math.PI;
  return wrapped;
}

/**
 * Horizontal bearing from the eye to a damage source.
 * Yaw 0 looks toward -Z. Positive yaw looks toward -X. Positive bearing is right.
 * Returns NaN when the source is on top of the eye, so the caller skips the arc.
 */
export function damageBearing(yawDeg: number, eye: Vec3, source: Vec3): number {
  const dx = source.x - eye.x;
  const dz = source.z - eye.z;
  const dist = Math.hypot(dx, dz);
  if (!(dist > 0.05)) return Number.NaN;
  const yaw = (yawDeg * Math.PI) / 180;
  const forward = (dx * -Math.sin(yaw) + dz * -Math.cos(yaw)) / dist;
  const right = (dx * Math.cos(yaw) + dz * -Math.sin(yaw)) / dist;
  return wrapPi(Math.atan2(right, forward));
}

/** Place the arc on the screen edge in the direction of the attacker. */
export function arcAnchor(bearing: number): { x: number; y: number; rotation: number } {
  const angle = wrapPi(bearing);
  return {
    x: 0.5 + ARC_REACH * Math.sin(angle),
    y: 0.5 - ARC_REACH * Math.cos(angle),
    rotation: angle,
  };
}

export function arcOpacity(age: number): number {
  if (!(age >= 0) || age >= ARC_LIFE_SECONDS) return 0;
  return ARC_PEAK * (1 - age / ARC_LIFE_SECONDS);
}

export function pushDamage(arcs: readonly DamageArc[], bearing: number): readonly DamageArc[] {
  if (!Number.isFinite(bearing)) return arcs.slice();
  const wrapped = wrapPi(bearing);
  const next: DamageArc[] = [];
  let merged = false;
  for (let i = 0; i < arcs.length; i += 1) {
    const arc = arcs[i]!;
    if (!merged && Math.abs(wrapPi(wrapped - arc.bearing)) <= ARC_MERGE_RAD) {
      next.push({ bearing: wrapped, age: 0 });
      merged = true;
    } else {
      next.push(arc);
    }
  }
  if (!merged) next.push({ bearing: wrapped, age: 0 });
  while (next.length > ARC_CAP) next.shift();
  return next;
}

export function stepDamage(arcs: readonly DamageArc[], dt: number): readonly DamageArc[] {
  if (!(dt > 0) || arcs.length === 0) return arcs;
  const next: DamageArc[] = [];
  for (let i = 0; i < arcs.length; i += 1) {
    const arc = arcs[i]!;
    const age = arc.age + dt;
    if (age < ARC_LIFE_SECONDS) next.push({ bearing: arc.bearing, age });
  }
  return next;
}

export function paintDamage(arcs: readonly DamageArc[]): PaintedArc[] {
  const painted: PaintedArc[] = [];
  let sum = 0;
  for (let i = 0; i < arcs.length; i += 1) {
    const arc = arcs[i]!;
    const opacity = arcOpacity(arc.age);
    if (opacity <= 0.01) continue;
    const anchor = arcAnchor(arc.bearing);
    painted.push({ x: anchor.x, y: anchor.y, rotation: anchor.rotation, opacity });
    sum += opacity;
  }
  if (sum > ARC_OPACITY_BUDGET) {
    const scale = ARC_OPACITY_BUDGET / sum;
    for (let i = 0; i < painted.length; i += 1) painted[i]!.opacity *= scale;
  }
  return painted;
}

/** Signed strafe speed in m/s. Positive is to the right of the look direction. */
export function strafeOf(yawDeg: number, velocity: Vec3): number {
  const yaw = (yawDeg * Math.PI) / 180;
  return velocity.x * Math.cos(yaw) + velocity.z * -Math.sin(yaw);
}

/** Walk-cycle phase in radians. A stop does not keep the bob advancing. */
export function stepWalkPhase(phase: number, dt: number, planarSpeed: number): number {
  if (!(dt > 0) || !Number.isFinite(phase)) return Number.isFinite(phase) ? phase : 0;
  const speed = Number.isFinite(planarSpeed) && planarSpeed > 0 ? planarSpeed : 0;
  const rate = 1.7 * Math.min(1, speed / 8);
  return phase + dt * rate * Math.PI * 2;
}

export interface ViewPose {
  x: number;
  y: number;
  z: number;
  pitch: number;
  roll: number;
}

const KICK_UP = 0.012;
const KICK_BACK = 0.012;
const KICK_PITCH = 0.05;
const BOB_Y = 0.008;
const BOB_ROLL = 0.012;
const TILT_ROLL = 0.035;
const TILT_X = 0.012;

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

/**
 * Camera-space pose for the Quill viewmodel.
 * Kick rises and pitches the carbine. Strafe leans it. Walk bobs it.
 * Every offset is clamped so the stock stays off the near plane and inside the view.
 */
export function viewmodelOffset(input: {
  kick: number;
  strafe: number;
  planarSpeed: number;
  walkPhase: number;
}): ViewPose {
  const kick = clamp(Number.isFinite(input.kick) ? input.kick : 0, 0, 1);
  const strafe = Number.isFinite(input.strafe) ? input.strafe : 0;
  const speed = Number.isFinite(input.planarSpeed) && input.planarSpeed > 0 ? input.planarSpeed : 0;
  const gait = Math.min(1, speed / 4);
  const phase = Number.isFinite(input.walkPhase) ? input.walkPhase : 0;
  const lean = clamp(strafe / 8, -1, 1);
  const bobY = Math.sin(phase) * BOB_Y * gait;
  const bobRoll = Math.sin(phase) * BOB_ROLL * gait;
  return {
    x: VIEW_REST.x + clamp(lean * TILT_X, -0.016, 0.016),
    y: VIEW_REST.y + clamp(kick * KICK_UP + bobY, -0.012, 0.016),
    z: VIEW_REST.z + clamp(kick * KICK_BACK, 0, 0.014),
    pitch: clamp(kick * KICK_PITCH, 0, 0.06),
    roll: clamp(-lean * TILT_ROLL + bobRoll, -0.05, 0.05),
  };
}

/** Rear cap of the carbine, in camera space. More negative is farther from the eye. */
export function stockCameraZ(pose: ViewPose): number {
  const pitch = pose.pitch;
  const z = VIEW_STOCK_LOCAL_Z * Math.cos(pitch);
  return pose.z + z;
}

/** The anchor stays in the lower right, and the stock stays in front of the near plane. */
export function viewmodelInFrame(pose: ViewPose): boolean {
  if (!(stockCameraZ(pose) < -VIEW_NEAR - 0.012)) return false;
  if (pose.x < 0.16 || pose.x > 0.26) return false;
  if (pose.y < -0.25 || pose.y > -0.18) return false;
  if (pose.z > -0.36) return false;
  if (pose.pitch < -1e-6 || pose.pitch > 0.06 + 1e-6) return false;
  if (Math.abs(pose.roll) > 0.05 + 1e-6) return false;
  return true;
}

export interface FeedbackSample {
  marker: MarkerView;
  arcs: PaintedArc[];
  hitsNoted: number;
  killsNoted: number;
  damageNoted: number;
  lastBearing: number | null;
}

export interface CombatFeedback {
  noteHit(killed: boolean): void;
  /** Reads the source immediately. Callers may reuse the vector afterward. */
  noteDamage(yawDeg: number, eye: Vec3, source: Vec3): void;
  step(dt: number): void;
  sample(): FeedbackSample;
  reset(): void;
}

export function createCombatFeedback(): CombatFeedback {
  let marker = freshMarker();
  let arcs: readonly DamageArc[] = [];
  let hitsNoted = 0;
  let killsNoted = 0;
  let damageNoted = 0;
  let lastBearing = Number.NaN;

  return {
    noteHit(killed: boolean): void {
      marker = noteMarker(marker, killed);
      hitsNoted += 1;
      if (killed) killsNoted += 1;
    },
    noteDamage(yawDeg: number, eye: Vec3, source: Vec3): void {
      const bearing = damageBearing(yawDeg, eye, source);
      if (!Number.isFinite(bearing)) return;
      arcs = pushDamage(arcs, bearing);
      damageNoted += 1;
      lastBearing = bearing;
    },
    step(dt: number): void {
      marker = stepMarker(marker, dt);
      arcs = stepDamage(arcs, dt);
    },
    sample(): FeedbackSample {
      return {
        marker: markerView(marker),
        arcs: paintDamage(arcs),
        hitsNoted,
        killsNoted,
        damageNoted,
        lastBearing: Number.isFinite(lastBearing) ? lastBearing : null,
      };
    },
    reset(): void {
      marker = freshMarker();
      arcs = [];
      hitsNoted = 0;
      killsNoted = 0;
      damageNoted = 0;
      lastBearing = Number.NaN;
    },
  };
}
