import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Color } from "three";
import { ATRIUM_PADS, ATRIUM_SPAWN, CATWALK_Y, GROUND_Y } from "../src/atrium.ts";
import { buildAtriumView } from "../src/floor.ts";
import { bindHud } from "../src/hud/model.ts";
import { CAPSULE_RADIUS } from "../src/move.ts";
import { createPlayerState } from "../src/player/state.ts";
import {
  AMMO_COLOR,
  AMMO_DORMANT,
  AMMO_PICKUP,
  AMMO_RESPAWN_SECONDS,
  ARMOR_ENABLED,
  HEALTH_COLOR,
  HEALTH_DORMANT,
  HEALTH_PICKUP,
  HEALTH_RESPAWN_SECONDS,
  PAD_TRIGGER_HALF_XZ,
  RESERVE_CAP,
  applyDamage,
  createPickupSim,
  exposeDamageDebug,
  grantHealth,
  grantReserve,
} from "../src/pickups.ts";
import { createQuill } from "../src/quill.ts";
import { createHitboxWorld } from "../src/hitbox.ts";

const idle = {
  fire: false,
  reload: false,
  origin: { x: 0, y: 1.6, z: 0 },
  direction: { x: 0, y: 0, z: -1 },
};

function feetAt(pad) {
  return { x: pad.x, y: pad.y, z: pad.z };
}

function fakeHud() {
  const armorStat = {
    dataset: {},
    style: { visibility: "" },
    attrs: {},
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
    removeAttribute(name) {
      delete this.attrs[name];
    },
  };
  return {
    root: { dataset: {} },
    hp: { textContent: null },
    armor: { textContent: null },
    ammo: { textContent: null },
    armorStat,
    death: {
      hidden: true,
      inert: false,
      style: { display: "", pointerEvents: "" },
      attrs: {},
      setAttribute(name, value) {
        this.attrs[name] = value;
      },
      removeAttribute(name) {
        delete this.attrs[name];
      },
    },
  };
}

function groundHealth(sim) {
  return sim.pads.find((pad) => pad.kind === "health" && pad.y === GROUND_Y);
}

function catwalkHealth(sim) {
  return sim.pads.find((pad) => pad.kind === "health" && pad.y === CATWALK_Y);
}

function wellAmmo(sim) {
  return sim.pads.find((pad) => pad.kind === "ammo" && pad.y === 0);
}

test("applyDamage absorbs floor(D·2/3) and always costs at least 1 HP", () => {
  const armored = applyDamage(30, 100, 15);
  assert.equal(armored.absorbed, 15);
  assert.equal(armored.hpLoss, 15);
  assert.equal(armored.armor, 0);
  assert.equal(armored.hp, 85);

  const bare = applyDamage(30, 100, 0);
  assert.equal(bare.absorbed, 0);
  assert.equal(bare.hpLoss, 30);
  assert.equal(bare.armor, 0);
  assert.equal(bare.hp, 70);

  const tiny = applyDamage(1, 100, 50);
  assert.equal(tiny.absorbed, 0);
  assert.equal(tiny.hpLoss, 1);
  assert.equal(tiny.armor, 50);
  assert.equal(tiny.hp, 99);

  const speck = applyDamage(0.25, 80, 0);
  assert.equal(speck.hpLoss, 1);
  assert.equal(speck.hp, 79);
  assert.equal(speck.armor, 0);

  const zero = applyDamage(0, 100, 15);
  assert.deepEqual(zero, { hp: 100, armor: 15, hpLoss: 0, absorbed: 0 });

  const fatal = applyDamage(30, 10, 0);
  assert.equal(fatal.hp, 0);
  assert.equal(fatal.hpLoss, 30);
});

test("health grant stops at 100 and reserve grant stops at 80 without filling the mag", () => {
  assert.deepEqual(grantHealth(90, HEALTH_PICKUP), { hp: 100, gained: 10 });
  assert.deepEqual(grantHealth(100, HEALTH_PICKUP), { hp: 100, gained: 0 });
  assert.deepEqual(grantReserve(70, AMMO_PICKUP), { reserve: RESERVE_CAP, gained: 10 });
  assert.deepEqual(grantReserve(RESERVE_CAP, AMMO_PICKUP), { reserve: RESERVE_CAP, gained: 0 });
  assert.notEqual(grantReserve(70, AMMO_PICKUP).reserve, 110);
});

test("collecting health at 90 HP gives 100 and the pad waits 20 s", () => {
  const player = createPlayerState({ hp: 90 });
  const sim = createPickupSim();
  const pad = groundHealth(sim);
  assert.ok(pad);

  sim.step(0, feetAt(pad), player);
  assert.equal(player.get().hp, 100);
  assert.equal(pad.cooldown, HEALTH_RESPAWN_SECONDS);

  player.set({ hp: 50 });
  sim.step(HEALTH_RESPAWN_SECONDS - 0.001, feetAt(pad), player);
  assert.equal(player.get().hp, 50);
  assert.ok(pad.cooldown > 0);

  sim.step(0.001, feetAt(pad), player);
  assert.equal(player.get().hp, 75);
  assert.equal(pad.cooldown, HEALTH_RESPAWN_SECONDS);
});

test("a health pad at full HP is not consumed, and a miss does not collect", () => {
  const player = createPlayerState();
  const sim = createPickupSim();
  const pad = groundHealth(sim);
  sim.step(1, feetAt(pad), player);
  assert.equal(player.get().hp, 100);
  assert.equal(pad.cooldown, 0);

  player.set({ hp: 40 });
  const beside = {
    x: pad.x + PAD_TRIGGER_HALF_XZ + CAPSULE_RADIUS + 0.05,
    y: pad.y,
    z: pad.z,
  };
  sim.step(0, beside, player);
  assert.equal(player.get().hp, 40);
  assert.equal(pad.cooldown, 0);

  const touching = {
    x: pad.x + PAD_TRIGGER_HALF_XZ + CAPSULE_RADIUS,
    y: pad.y,
    z: pad.z,
  };
  sim.step(0, touching, player);
  assert.equal(player.get().hp, 65);
  assert.equal(pad.cooldown, HEALTH_RESPAWN_SECONDS);

  const upper = catwalkHealth(sim);
  player.set({ hp: 10 });
  sim.step(0, { x: upper.x, y: GROUND_Y, z: upper.z }, player);
  assert.equal(player.get().hp, 10);
  assert.equal(upper.cooldown, 0);
});

test("spawn does not collect the south concourse health pad", () => {
  const player = createPlayerState({ hp: 50 });
  const sim = createPickupSim();
  sim.step(1, ATRIUM_SPAWN, player);
  assert.equal(player.get().hp, 50);
  assert.ok(sim.pads.every((pad) => pad.cooldown === 0));
});

test("ammo pad fills the Quill reserve to 40+80 and reload spends that reserve", () => {
  const player = createPlayerState();
  const quill = createQuill({ player, hitboxes: createHitboxWorld() });
  assert.equal(quill.grantReserve(30), 30);
  assert.equal(quill.mag, 40);
  assert.equal(quill.reserve, 70);
  assert.equal(player.get().reserve, 70);

  const sim = createPickupSim(quill);
  const pad = wellAmmo(sim);
  assert.ok(pad);
  sim.step(0, feetAt(pad), player);
  assert.equal(quill.mag, 40);
  assert.equal(quill.reserve, 80);
  assert.equal(player.get().mag, 40);
  assert.equal(player.get().reserve, 80);
  assert.notEqual(player.get().reserve, 110);
  assert.equal(pad.cooldown, AMMO_RESPAWN_SECONDS);

  quill.update(0.05, idle);
  assert.equal(quill.reserve, 80);
  assert.equal(player.get().reserve, 80);

  quill.update(0, { ...idle, fire: true });
  assert.equal(quill.mag, 39);
  assert.equal(quill.reserve, 80);
  quill.update(0, { ...idle, reload: true });
  let elapsed = 0;
  while (quill.reloading && elapsed < 3) {
    quill.update(0.05, idle);
    elapsed += 0.05;
  }
  assert.equal(quill.mag, 40);
  assert.equal(quill.reserve, 79);
  assert.equal(player.get().mag, 40);
  assert.equal(player.get().reserve, 79);
});

test("an ammo pad cannot be collected again until 15 s have elapsed", () => {
  let reserve = 0;
  const bank = {
    grantReserve(amount) {
      const room = RESERVE_CAP - reserve;
      const gained = Math.min(amount, Math.max(0, room));
      reserve += gained;
      return gained;
    },
  };
  const player = createPlayerState();
  const sim = createPickupSim(bank);
  const pad = wellAmmo(sim);
  sim.step(0, feetAt(pad), player);
  assert.equal(reserve, AMMO_PICKUP);
  assert.equal(pad.cooldown, AMMO_RESPAWN_SECONDS);

  reserve = 0;
  sim.step(AMMO_RESPAWN_SECONDS - 0.001, feetAt(pad), player);
  assert.equal(reserve, 0);
  assert.ok(pad.cooldown > 0);

  sim.step(0.001, feetAt(pad), player);
  assert.equal(reserve, AMMO_PICKUP);
  assert.equal(pad.cooldown, AMMO_RESPAWN_SECONDS);
});

test("a full reserve does not consume the ammo pad", () => {
  const player = createPlayerState();
  const quill = createQuill({ player, hitboxes: createHitboxWorld() });
  assert.equal(quill.grantReserve(1000), 40);
  assert.equal(quill.reserve, 80);
  const sim = createPickupSim(quill);
  const pad = wellAmmo(sim);
  sim.step(0, feetAt(pad), player);
  assert.equal(quill.reserve, 80);
  assert.equal(quill.mag, 40);
  assert.equal(pad.cooldown, 0);
});

test("the HUD follows a health collect and a damage hit, and death uses the recap", () => {
  const player = createPlayerState({ hp: 90 });
  const els = fakeHud();
  bindHud(player, els, () => "playing");
  assert.equal(els.hp.textContent, "90");
  assert.equal(els.ammo.textContent, "40+40");
  assert.equal(els.armorStat.style.visibility, "hidden");

  const sim = createPickupSim();
  sim.step(0, feetAt(groundHealth(sim)), player);
  assert.equal(els.hp.textContent, "100");
  assert.equal(els.ammo.textContent, "40+40");
  assert.equal(els.root.dataset.mode, "play");

  const quill = createQuill({ player, hitboxes: createHitboxWorld() });
  quill.grantReserve(30);
  assert.equal(els.ammo.textContent, "40+70");
  const ammoSim = createPickupSim(quill);
  ammoSim.step(0, feetAt(wellAmmo(ammoSim)), player);
  assert.equal(els.hp.textContent, "100");
  assert.equal(els.ammo.textContent, "40+80");

  player.set({ armor: 15 });
  const hit = applyDamage(30, player.get().hp, player.get().armor);
  player.set({ hp: hit.hp, armor: hit.armor });
  assert.equal(els.hp.textContent, "85");
  assert.equal(els.armor.textContent, "0");
  assert.equal(els.armorStat.style.visibility, "hidden");
  assert.equal(els.ammo.textContent, "40+80");

  const speck = applyDamage(0.2, player.get().hp, player.get().armor);
  player.set({ hp: speck.hp, armor: speck.armor });
  assert.equal(els.hp.textContent, "84");

  const fatal = applyDamage(200, player.get().hp, 0);
  player.set({ hp: fatal.hp, armor: fatal.armor });
  assert.equal(els.hp.textContent, "0");
  assert.equal(els.root.dataset.mode, "dead");
  assert.equal(els.death.hidden, false);
});

test("armor pads stay out of the sim and out of the scene while ARMOR_ENABLED is false", () => {
  assert.equal(ARMOR_ENABLED, false);
  assert.equal(ATRIUM_PADS.filter((pad) => pad.kind === "armor").length, 2);
  const sim = createPickupSim();
  assert.equal(sim.pads.some((pad) => pad.kind === "armor"), false);
  assert.equal(sim.pads.filter((pad) => pad.kind === "health").length, 2);
  assert.equal(sim.pads.filter((pad) => pad.kind === "ammo").length, 3);

  const player = createPlayerState({ hp: 80 });
  for (const landmark of ATRIUM_PADS) {
    if (landmark.kind !== "armor") continue;
    sim.step(1, { x: landmark.position.x, y: landmark.position.y, z: landmark.position.z }, player);
  }
  assert.equal(player.get().hp, 80);
  assert.equal(player.get().armor, 0);
  assert.ok(sim.pads.every((pad) => pad.cooldown === 0));

  const view = buildAtriumView();
  assert.equal(view.pads.length, 5);
  assert.equal(view.pads.some((pad) => pad.kind === "armor"), false);
  assert.equal(view.meshes.some((mesh) => mesh.name.includes("armor")), false);
  assert.ok(view.meshes.length <= 16, `meshes ${view.meshes.length}`);

  const health = view.pads.find((pad) => pad.kind === "health");
  const ammo = view.pads.find((pad) => pad.kind === "ammo");
  assert.ok(health.mesh.material.color.equals(new Color(HEALTH_COLOR)));
  assert.ok(ammo.mesh.material.color.equals(new Color(AMMO_COLOR)));
  assert.equal(health.mesh.visible, true);
  health.setAvailable(false);
  assert.equal(health.mesh.visible, true);
  assert.ok(health.mesh.material.color.equals(new Color(HEALTH_DORMANT)));
  health.setAvailable(true);
  assert.ok(health.mesh.material.color.equals(new Color(HEALTH_COLOR)));
  ammo.setAvailable(false);
  assert.ok(ammo.mesh.material.color.equals(new Color(AMMO_DORMANT)));
  assert.equal(health.mesh.material.color.getHex(), HEALTH_COLOR);
});

test("the damage debug hook is dev-only and applies the rule", () => {
  const player = createPlayerState({ armor: 15 });
  const els = fakeHud();
  bindHud(player, els, () => "playing");
  const host = {};
  exposeDamageDebug(host, (damage) => {
    const current = player.get();
    const next = applyDamage(damage, current.hp, current.armor);
    player.set({ hp: next.hp, armor: next.armor });
  });
  host.__fragDamage(30);
  assert.equal(player.get().hp, 85);
  assert.equal(player.get().armor, 0);
  assert.equal(els.hp.textContent, "85");

  const source = fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const gated = source.replace(/\s+/g, " ");
  const devAt = gated.indexOf("if (import.meta.env.DEV)");
  const hookAt = gated.indexOf("exposeDamageDebug(window");
  assert.ok(devAt >= 0 && hookAt > devAt);
  assert.equal(gated.indexOf("exposeDamageDebug("), hookAt);
});
