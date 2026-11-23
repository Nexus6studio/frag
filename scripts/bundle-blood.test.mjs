import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { WISP_FLUID_COLOR, WISP_GIB_METAL, WISP_GIB_PLASTIC } from "../src/wisp.ts";

const WARNING =
  "Contains fast-paced combat against fictional enemies, with blood, gibs, explosions, sparks and debris. Includes flashing lights and rapid motion.";

test("the shipped bundle warns about blood and keeps drone gore mechanical", { timeout: 180_000 }, () => {
  assert.equal(readsAsBlood(WISP_FLUID_COLOR), false);
  assert.equal(readsAsBlood(WISP_GIB_METAL), false);
  assert.equal(readsAsBlood(WISP_GIB_PLASTIC), false);

  const root = path.resolve(import.meta.dirname, "..");
  const build = spawnSync("npm", ["run", "build"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  const dist = path.join(root, "dist");
  const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
  assert.ok(html.includes("Content warning"), "warning title missing");
  assert.ok(html.includes('id="build-hash"'), "build hash missing");
  assert.ok(html.includes(WARNING), `warning copy missing from dist/index.html`);

  const js = walk(dist)
    .filter((file) => file.endsWith(".js"))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  assert.match(js, /wisp-sparks/);
  assert.match(js, /wisp-gibs/);
  assert.match(js, /wisp-fluid/);
  assert.doesNotMatch(js, /wisp-blood/);
  assert.match(js, /enforcer-blood/);
  assert.match(js, /enforcer-gibs/);
  assert.match(js, /enforcer-decals/);
  for (const color of [WISP_FLUID_COLOR, WISP_GIB_METAL, WISP_GIB_PLASTIC]) {
    assert.ok(js.includes(String(color)), `drone color ${color.toString(16)} missing from the bundle`);
  }
  assert.doesNotMatch(js, /dismember|corpse|intestine/);
  assert.doesNotMatch(js, /__fragPlayer|__fragMove|__fragDamage|__fragRun/);
  assert.doesNotMatch(js, /exposePlayerDebug|exposeMoveDebug|exposeDamageDebug|exposeRunDebug/);
  assert.doesNotMatch(js, /god-?mode|wave-?skip|skipWave|quill-debug-target/i);
});

function readsAsBlood(hex) {
  const red = (hex >> 16) & 255;
  const green = (hex >> 8) & 255;
  const blue = hex & 255;
  return red > 90 && red > green * 1.7 && red > blue * 1.7;
}

function walk(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}
