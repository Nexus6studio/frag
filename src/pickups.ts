// Health and ammo pickups, and the damage rule the drone will call.
//
// A pad is collected when the player capsule touches its trigger box. Health
// adds 25 and stops at 100. Ammo adds 40 flechettes to the Quill Driver reserve
// and does not move rounds into the magazine; reserve stops at 80, so a full
// magazine and 70 in reserve becomes 40+80. A pad that cannot add anything is
// left alone. After a collection the pad stays dark until its timer elapses
// (20 s health, 15 s ammo), then it can be taken again.
//
// Armor pads stay in the atrium landmark list. ARMOR_ENABLED is false for this
// release, so they are not simulated and not drawn. The armor HUD slot stays
// hidden. Flipping the flag is the later armor ticket.
//
// Damage for D against armor A: the armor absorbs min(A, floor(D·2/3)), and
// the rest comes off HP. A positive hit that would remove less than 1 HP still
// removes 1. HP is clamped at 0, which is the existing click-to-restart death.

import { ATRIUM_PADS, type AtriumPad, type PadKind } from "./atrium.ts";
import { CAPSULE_HEIGHT, CAPSULE_RADIUS, type Vec3 } from "./move.ts";
import type { PlayerStore } from "./player/state.ts";

export const ARMOR_ENABLED = false;

export const HP_CAP = 100;
export const HEALTH_PICKUP = 25;
export const HEALTH_RESPAWN_SECONDS = 20;
export const AMMO_PICKUP = 40;
export const RESERVE_CAP = 80;
export const AMMO_RESPAWN_SECONDS = 15;

export const HEALTH_COLOR = 0xc8ff3d;
export const AMMO_COLOR = 0xff2e9f;
/** Dim acid and dim magenta. The pad stays in the scene, unlit, until it returns. */
export const HEALTH_DORMANT = 0x384711;
export const AMMO_DORMANT = 0x470d2c;

/** Horizontal half-extent of a pad trigger, meters. */
export const PAD_TRIGGER_HALF_XZ = 0.6;
/** Trigger height above the pad's feet-level mark. */
export const PAD_TRIGGER_HEIGHT = 1.05;

const DAMAGE_DEBUG_KEY = "__fragDamage";

export interface DamageResult {
  hp: number;
  armor: number;
  hpLoss: number;
  absorbed: number;
}

export interface ReserveGrant {
  reserve: number;
  gained: number;
}

export interface HealthGrant {
  hp: number;
  gained: number;
}

/** Quill Driver, or any other reserve the ammo pad should fill. */
export interface ReserveBank {
  grantReserve(amount: number): number;
}

export interface PickupPad {
  kind: PadKind;
  x: number;
  y: number;
  z: number;
  /** Seconds until the pad can be collected. Zero means it is available. */
  cooldown: number;
}

export interface PickupSim {
  readonly pads: readonly PickupPad[];
  step(dt: number, feet: Vec3, player: PlayerStore): void;
  /** Pads are available again. A death restart calls this. */
  reset(): void;
}

export function applyDamage(damage: number, hp: number, armor: number): DamageResult {
  if (!Number.isFinite(damage) || damage <= 0) {
    return { hp, armor, hpLoss: 0, absorbed: 0 };
  }
  const wanted = Math.floor((damage * 2) / 3);
  const armorNow = Number.isFinite(armor) ? Math.max(0, armor) : 0;
  const absorbed = Math.min(armorNow, Math.max(0, wanted));
  let hpLoss = damage - absorbed;
  if (hpLoss < 1) hpLoss = 1;
  const nextHp = Math.max(0, (Number.isFinite(hp) ? hp : 0) - hpLoss);
  return {
    hp: nextHp,
    armor: armorNow - absorbed,
    hpLoss,
    absorbed,
  };
}

export function grantHealth(hp: number, amount = HEALTH_PICKUP): HealthGrant {
  const current = Number.isFinite(hp) ? hp : 0;
  const add = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const room = Math.max(0, HP_CAP - current);
  const gained = Math.min(add, room);
  return { hp: current + gained, gained };
}

/** Reserve only. The magazine is filled by reload, not by the pad. */
export function grantReserve(reserve: number, amount = AMMO_PICKUP, cap = RESERVE_CAP): ReserveGrant {
  const current = Number.isFinite(reserve) ? reserve : 0;
  const add = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const room = Math.max(0, cap - current);
  const gained = Math.min(add, room);
  return { reserve: current + gained, gained };
}

export function capsuleOverlapsAabb(
  feet: Vec3,
  min: Vec3,
  max: Vec3,
  radius = CAPSULE_RADIUS,
  height = CAPSULE_HEIGHT,
): boolean {
  const bottom = feet.y + radius;
  const top = feet.y + height - radius;
  let y = bottom;
  if (top < min.y) y = top;
  else if (bottom > max.y) y = bottom;
  else y = Math.min(Math.max(bottom, min.y), top);

  const cx = clamp(feet.x, min.x, max.x);
  const cy = clamp(y, min.y, max.y);
  const cz = clamp(feet.z, min.z, max.z);
  const dx = feet.x - cx;
  const dy = y - cy;
  const dz = feet.z - cz;
  return dx * dx + dy * dy + dz * dz <= radius * radius + 1e-8;
}

export function padTrigger(pad: PickupPad): { min: Vec3; max: Vec3 } {
  return {
    min: { x: pad.x - PAD_TRIGGER_HALF_XZ, y: pad.y, z: pad.z - PAD_TRIGGER_HALF_XZ },
    max: {
      x: pad.x + PAD_TRIGGER_HALF_XZ,
      y: pad.y + PAD_TRIGGER_HEIGHT,
      z: pad.z + PAD_TRIGGER_HALF_XZ,
    },
  };
}

export function createPickupSim(bank: ReserveBank | null = null, source: readonly AtriumPad[] = ATRIUM_PADS): PickupSim {
  const pads: PickupPad[] = [];
  for (const pad of source) {
    if (pad.kind === "armor" && !ARMOR_ENABLED) continue;
    pads.push({
      kind: pad.kind,
      x: pad.position.x,
      y: pad.position.y,
      z: pad.position.z,
      cooldown: 0,
    });
  }

  return {
    pads,
    reset(): void {
      for (let i = 0; i < pads.length; i += 1) pads[i]!.cooldown = 0;
    },
    step(dt: number, feet: Vec3, player: PlayerStore): void {
      const stepDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
      for (const pad of pads) {
        if (pad.cooldown <= 0) continue;
        pad.cooldown = Math.max(0, pad.cooldown - stepDt);
        if (pad.cooldown < 1e-9) pad.cooldown = 0;
      }

      let hp = player.get().hp;
      let hpDirty = false;
      for (const pad of pads) {
        if (pad.cooldown > 0 || pad.kind === "armor") continue;
        const box = padTrigger(pad);
        if (!capsuleOverlapsAabb(feet, box.min, box.max)) continue;
        if (pad.kind === "health") {
          const granted = grantHealth(hp);
          if (granted.gained <= 0) continue;
          hp = granted.hp;
          hpDirty = true;
          pad.cooldown = HEALTH_RESPAWN_SECONDS;
          continue;
        }
        const gained = giveReserve(player, bank, AMMO_PICKUP);
        if (gained <= 0) continue;
        pad.cooldown = AMMO_RESPAWN_SECONDS;
      }
      if (hpDirty) player.set({ hp });
    },
  };
}

export function exposeDamageDebug(target: object, apply: (damage: number) => void): void {
  Object.defineProperty(target, DAMAGE_DEBUG_KEY, {
    configurable: true,
    enumerable: true,
    value: apply,
  });
}

function giveReserve(player: PlayerStore, bank: ReserveBank | null, amount: number): number {
  if (bank) return bank.grantReserve(amount);
  const granted = grantReserve(player.get().reserve, amount);
  if (granted.gained <= 0) return 0;
  player.set({ reserve: granted.reserve });
  return granted.gained;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
