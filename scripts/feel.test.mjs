import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  ARC_CAP,
  ARC_LIFE_SECONDS,
  ARC_OPACITY_BUDGET,
  HIT_FLASH_SECONDS,
  HIT_MARKER_SECONDS,
  KILL_MARKER_SCALE,
  VIEW_REST,
  arcAnchor,
  arcOpacity,
  seatArcPeak,
  createCombatFeedback,
  damageBearing,
  freshMarker,
  hitFlashAlpha,
  markerView,
  noteMarker,
  paintDamage,
  pushDamage,
  stepDamage,
  stepMarker,
  stepWalkPhase,
  stockCameraZ,
  strafeOf,
  viewmodelInFrame,
  viewmodelOffset,
} from "../src/feel.ts";
import { damagePlayer, subscribePlayerHurt } from "../src/player/hurt.ts";
import { createPlayerState } from "../src/player/state.ts";

const eye = { x: 0, y: 1.45, z: 0 };

/** Distance from a viewport-fraction point to the nearest screen edge. 0 means on the edge. */
function edgeGap(point) {
  return Math.min(point.x, point.y, 1 - point.x, 1 - point.y);
}

const hudCss = fs.readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8");

function cssBlock(selector) {
  const source = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = hudCss.match(new RegExp(`(?:^|\\n)${source}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `${selector} rule missing`);
  return match[1];
}

function cssPx(block, prop) {
  const match = block.match(new RegExp(`${prop}:\\s*(\\d+(?:\\.\\d+)?)px`));
  assert.ok(match, `${prop} missing`);
  return Number(match[1]);
}

function lineBox(block) {
  const size = cssPx(block, "font-size");
  const line = block.match(/line-height:\s*(\d+(?:\.\d+)?)/);
  return size * (line ? Number(line[1]) : 1);
}

/** Laid-out #hud-bar from the stylesheet. Height comes from the stat metrics, not a fixed inset. */
function hudBarPixels(view) {
  const bar = cssBlock("#hud-bar");
  const stat = cssBlock(".hud-stat");
  const label = cssBlock(".hud-label");
  const value = cssBlock(".hud-value");
  const padding = stat.match(/padding:\s*(\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px/);
  assert.ok(padding, "hud-stat padding missing");
  const height = Number(padding[1]) + lineBox(label) + cssPx(label, "margin-bottom") + lineBox(value) + Number(padding[3]);
  const bottom = cssPx(bar, "bottom");
  return {
    left: cssPx(bar, "left"),
    right: view.width - cssPx(bar, "right"),
    top: view.height - bottom - height,
    bottom: view.height - bottom,
  };
}

/** Laid-out #hud-wave from the stylesheet. "WAVE 1" is the live label. */
function hudWavePixels(view) {
  const wave = cssBlock("#hud-wave");
  const padding = wave.match(/padding:\s*(\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px/);
  assert.ok(padding, "hud-wave padding missing");
  const height = Number(padding[1]) * 2 + lineBox(wave);
  const text = "WAVE 1";
  const width = text.length * lineBox(wave) * 0.62 + Number(padding[2]) * 2;
  const top = cssPx(wave, "top");
  return {
    left: (view.width - width) / 2,
    right: (view.width + width) / 2,
    top,
    bottom: top + height,
  };
}

function toFractions(rect, view) {
  return {
    left: rect.left / view.width,
    top: rect.top / view.height,
    right: rect.right / view.width,
    bottom: rect.bottom / view.height,
  };
}

test("a hit marker lasts 80 ms and a kill is a larger flash that a hit cannot downgrade", () => {
  let marker = noteMarker(freshMarker(), false);
  assert.equal(marker.kind, "hit");
  assert.equal(markerView(marker).scale, 1);
  assert.ok(markerView(marker).opacity > 0.99);

  marker = stepMarker(marker, HIT_MARKER_SECONDS / 2);
  assert.ok(Math.abs(markerView(marker).opacity - 0.5) < 1e-6);
  marker = stepMarker(marker, HIT_MARKER_SECONDS / 2 - 0.001);
  assert.equal(marker.kind, "hit");
  marker = stepMarker(marker, 0.002);
  assert.equal(markerView(marker).kind, "none");
  assert.equal(markerView(marker).opacity, 0);

  marker = noteMarker(freshMarker(), true);
  assert.equal(marker.kind, "kill");
  assert.equal(markerView(marker).scale, KILL_MARKER_SCALE);
  marker = noteMarker(marker, false);
  assert.equal(marker.kind, "kill", "a hit replaced the kill confirm");
  marker = stepMarker(marker, HIT_MARKER_SECONDS);
  assert.equal(marker.kind, "none");
  marker = noteMarker(noteMarker(freshMarker(), false), true);
  assert.equal(marker.kind, "kill");
  assert.equal(marker.age, 0);
});

test("enemy hit flash is full at the hit and gone after 60 ms", () => {
  assert.equal(hitFlashAlpha(HIT_FLASH_SECONDS), 1);
  assert.ok(Math.abs(hitFlashAlpha(HIT_FLASH_SECONDS / 2) - 0.5) < 1e-6);
  assert.equal(hitFlashAlpha(0), 0);
  assert.equal(hitFlashAlpha(-1), 0);
});

test("off-center damage places the arc toward the attacker", () => {
  const right = damageBearing(0, eye, { x: 6, y: 1.45, z: 0 });
  assert.ok(Math.abs(right - Math.PI / 2) < 1e-6, `right bearing ${right}`);
  const rightArc = arcAnchor(right);
  assert.ok(rightArc.x > 0.9 && Math.abs(rightArc.y - 0.5) < 1e-6, "right arc is on the right edge");

  const left = damageBearing(0, eye, { x: -5, y: 1, z: 0 });
  assert.ok(Math.abs(left + Math.PI / 2) < 1e-6, `left bearing ${left}`);
  assert.ok(arcAnchor(left).x < 0.1, "left arc is on the left edge");

  const ahead = damageBearing(0, eye, { x: 0, y: 2, z: -8 });
  assert.ok(Math.abs(ahead) < 1e-6, `ahead bearing ${ahead}`);
  assert.ok(arcAnchor(ahead).y < 0.1, "ahead arc is on the top edge");

  const behind = damageBearing(0, eye, { x: 0, y: 1, z: 4 });
  assert.ok(Math.abs(Math.abs(behind) - Math.PI) < 1e-6, `behind bearing ${behind}`);
  assert.ok(arcAnchor(behind).y > 0.9, "behind arc is on the bottom edge");

  const aheadRight = damageBearing(0, eye, { x: 1, y: 1.45, z: -Math.sqrt(3) });
  assert.ok(Math.abs(aheadRight - Math.PI / 6) < 1e-6, `diagonal bearing ${aheadRight}`);
  const diagonal = arcAnchor(aheadRight);
  assert.ok(diagonal.x > 0.5 && diagonal.y < 0.5, `diagonal stays ahead-right (${diagonal.x}, ${diagonal.y})`);
  assert.ok(edgeGap(diagonal) <= 0.02, `diagonal arc floats inside the view (${diagonal.x}, ${diagonal.y})`);

  // Yaw -90 looks toward +X. A threat still on -Z is then to the left.
  const turned = damageBearing(-90, eye, { x: 8, y: 1.45, z: 0 });
  assert.ok(Math.abs(turned) < 1e-6, `looking at the threat should put it ahead, got ${turned}`);
  const flank = damageBearing(-90, eye, { x: 0, y: 1, z: -6 });
  assert.ok(Math.abs(flank + Math.PI / 2) < 1e-6, `flank bearing ${flank}`);
  assert.ok(arcAnchor(flank).x < 0.1);

  assert.ok(Number.isNaN(damageBearing(0, eye, { x: 0.01, y: 4, z: 0 })));
});

test("the damage crescent's outer peak hugs the viewport edge", () => {
  const bearings = [0, Math.PI / 2, -Math.PI / 2, Math.PI, Math.PI / 6, -Math.PI / 5, 1.15, 2.2, -2.2, 2.8];
  for (const bearing of bearings) {
    const arc = arcAnchor(bearing);
    const gap = edgeGap(arc);
    assert.ok(gap <= 0.02, `bearing ${bearing.toFixed(3)} sits inset by ${gap.toFixed(3)} at ${arc.x.toFixed(3)}, ${arc.y.toFixed(3)}`);
    assert.ok(arc.x >= -1e-6 && arc.x <= 1 + 1e-6, `x left the viewport (${arc.x})`);
    assert.ok(arc.y >= -1e-6 && arc.y <= 1 + 1e-6, `y left the viewport (${arc.y})`);
    const reach = Math.hypot(arc.x - 0.5, arc.y - 0.5);
    assert.ok(reach >= 0.5 - 1e-6, `bearing ${bearing.toFixed(3)} reach ${reach.toFixed(3)} stops short of the edge`);
    const dx = arc.x - 0.5;
    const dy = arc.y - 0.5;
    const rayX = Math.sin(bearing);
    const rayY = -Math.cos(bearing);
    const cross = dx * rayY - dy * rayX;
    assert.ok(Math.abs(cross) < 1e-6, `bearing ${bearing.toFixed(3)} left its ray (${cross})`);
  }
});

test("the damage crescent is at least three times the old 4px stroke and hangs inward from its peak", () => {
  const css = fs.readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8");
  const block = css.match(/\.damage-arc\s*\{([^}]+)\}/);
  assert.ok(block, "damage-arc rule missing");
  const border = block[1].match(/border:\s*(\d+(?:\.\d+)?)px/);
  assert.ok(border, "damage-arc border thickness missing");
  const thickness = Number(border[1]);
  const previousThickness = 4;
  assert.ok(
    thickness >= previousThickness * 3,
    `stroke is ${thickness}px, under ${previousThickness * 3}px (3x the previous arc)`,
  );
  assert.match(block[1], /transform-origin:\s*center top/, "crescent does not pivot on its outer peak");

  const hud = fs.readFileSync(new URL("../src/hud/hud.ts", import.meta.url), "utf8");
  assert.match(hud, /translate\(-50%, 0\) rotate/, "arc is still centered on the anchor instead of hanging inward from the edge");
  assert.doesNotMatch(hud, /translate\(-50%, -50%\)/, "arc element is centered, so the ring floats inside the edge");
});

test("a rear arc peak sits on the HUD bar and does not overlap it", () => {
  const view = { width: 1280, height: 720 };
  const bar = hudBarPixels(view);
  const obstacles = [toFractions(bar, view)];
  const peak = seatArcPeak(arcAnchor(Math.PI), obstacles);
  const x = peak.x * view.width;
  const y = peak.y * view.height;
  const overlaps = x > bar.left && x < bar.right && y > bar.top && y < bar.bottom;
  assert.equal(overlaps, false, `rear peak ${x.toFixed(2)},${y.toFixed(2)} overlaps the bar`);
  assert.ok(Math.abs(y - bar.top) <= 0.75, `rear peak y ${y.toFixed(2)} is not on the bar top ${bar.top}`);
  assert.ok(Math.abs(x - view.width / 2) < 2, `rear peak x ${x.toFixed(2)} left the center`);

  const side = seatArcPeak(arcAnchor(Math.PI / 2), obstacles);
  assert.ok(side.x > 0.98, `the bar pulled a side peak off the edge (${side.x})`);

  const wave = hudWavePixels(view);
  const ahead = seatArcPeak(arcAnchor(0), [toFractions(wave, view)]);
  const aheadY = ahead.y * view.height;
  const aheadX = ahead.x * view.width;
  const waveOverlap = aheadX > wave.left && aheadX < wave.right && aheadY > wave.top && aheadY < wave.bottom;
  assert.equal(waveOverlap, false, `forward peak ${aheadX.toFixed(2)},${aheadY.toFixed(2)} overlaps the wave label`);
  assert.ok(Math.abs(aheadY - wave.bottom) <= 0.75, `forward peak y ${aheadY.toFixed(2)} left the wave label`);
});

test("three stacked arcs stay on the opacity cap without raising it", () => {
  assert.equal(ARC_OPACITY_BUDGET, 1.35);
  assert.equal(ARC_CAP, 3);
  assert.equal(ARC_LIFE_SECONDS, 0.4);

  let arcs = pushDamage([], 0);
  arcs = pushDamage(arcs, 1.2);
  arcs = pushDamage(arcs, 2.4);
  assert.equal(arcs.length, 3, "three separated hits did not keep three arcs");
  const painted = paintDamage(arcs);
  assert.equal(painted.length, 3);
  let sum = 0;
  for (const arc of painted) sum += arc.opacity;
  assert.ok(Math.abs(sum - 1.35) < 1e-6, `three fresh arcs summed to ${sum}, cap is 1.35`);
  assert.ok(painted.every((arc) => arc.opacity < 0.7), "stacked arcs were not dimmed under the cap");

  const single = paintDamage(pushDamage([], 0.4));
  assert.equal(single.length, 1);
  assert.ok(single[0].opacity > painted[0].opacity, "a lone arc was dimmed like a stack");
});

test("overlapping damage arcs fade, merge, and stay under the opacity budget", () => {
  let arcs = pushDamage([], 0.2);
  arcs = stepDamage(arcs, 0.2);
  assert.ok(Math.abs(arcOpacity(arcs[0].age) - 0.82 * 0.5) < 1e-6);
  arcs = pushDamage(arcs, 0.35);
  assert.equal(arcs.length, 1, "a nearby hit stacked a second arc");
  assert.equal(arcs[0].age, 0);

  arcs = [];
  arcs = pushDamage(arcs, 0);
  arcs = pushDamage(arcs, 0.1);
  assert.equal(arcs.length, 1);
  arcs = pushDamage(arcs, 1.2);
  arcs = pushDamage(arcs, 2.2);
  arcs = pushDamage(arcs, -2.2);
  assert.equal(arcs.length, ARC_CAP, `cap held ${arcs.length} arcs`);

  const crowded = paintDamage(arcs);
  let sum = 0;
  for (const arc of crowded) sum += arc.opacity;
  assert.ok(sum <= ARC_OPACITY_BUDGET + 1e-6, `opacity sum ${sum}`);
  assert.ok(crowded.every((arc) => arc.opacity < 0.7), "stacked arcs were not dimmed");

  const single = paintDamage(pushDamage([], 0.4));
  assert.equal(single.length, 1);
  assert.ok(Math.abs(single[0].opacity - 0.82) < 1e-6, "one arc was dimmed");

  const faded = stepDamage(pushDamage([], 1), ARC_LIFE_SECONDS);
  assert.equal(faded.length, 0);
  assert.equal(paintDamage(pushDamage([], Number.NaN)).length, 0);
});

test("the feedback clock shows a hit, a kill, and a damage arc, then lets them expire", () => {
  const feedback = createCombatFeedback();
  feedback.noteHit(false);
  feedback.noteDamage(0, eye, { x: 4, y: 1.45, z: 0 });
  const shown = feedback.sample();
  assert.equal(shown.hitsNoted, 1);
  assert.equal(shown.killsNoted, 0);
  assert.equal(shown.marker.kind, "hit");
  assert.equal(shown.marker.scale, 1);
  assert.equal(shown.damageNoted, 1);
  assert.ok(shown.lastBearing !== null && shown.lastBearing > 1);
  assert.equal(shown.arcs.length, 1);
  assert.ok(shown.arcs[0].x > 0.9);

  feedback.noteHit(true);
  const kill = feedback.sample();
  assert.equal(kill.marker.kind, "kill");
  assert.equal(kill.marker.scale, KILL_MARKER_SCALE);
  assert.equal(kill.killsNoted, 1);

  feedback.noteDamage(0, eye, eye);
  assert.equal(feedback.sample().damageNoted, 1, "a source on the eye added an arc");

  feedback.step(1);
  const gone = feedback.sample();
  assert.equal(gone.marker.kind, "none");
  assert.equal(gone.arcs.length, 0);
  feedback.reset();
  assert.equal(feedback.sample().hitsNoted, 0);
  assert.equal(feedback.sample().damageNoted, 0);
});

test("a landed hit reports its source and a downed player does not", () => {
  const player = createPlayerState();
  const sources = [];
  const stop = subscribePlayerHurt((source) => {
    sources.push({ x: source.x, y: source.y, z: source.z });
  });
  try {
    damagePlayer(player, 8, { x: 1, y: 2, z: -3 });
    assert.ok(player.get().hp < 100);
    assert.deepEqual(sources, [{ x: 1, y: 2, z: -3 }]);
    player.set({ hp: 0 });
    damagePlayer(player, 8, { x: 9, y: 0, z: 0 });
    assert.equal(sources.length, 1);
    damagePlayer(player, 0, { x: 4, y: 0, z: 0 });
    assert.equal(sources.length, 1);
  } finally {
    stop();
  }
});

test("viewmodel kick, strafe lean, and walk bob stay smooth and inside the frame", () => {
  const rest = viewmodelOffset({ kick: 0, strafe: 0, planarSpeed: 0, walkPhase: 2 });
  assert.deepEqual(rest, { x: VIEW_REST.x, y: VIEW_REST.y, z: VIEW_REST.z, pitch: 0, roll: 0 });
  assert.equal(viewmodelInFrame(rest), true);

  const kicked = viewmodelOffset({ kick: 1, strafe: 0, planarSpeed: 0, walkPhase: 0 });
  assert.ok(kicked.y > VIEW_REST.y, "the kick did not rise");
  assert.ok(kicked.z > VIEW_REST.z, "the kick did not move back");
  assert.ok(kicked.pitch > 0.04 && kicked.pitch < 0.06);
  assert.equal(viewmodelInFrame(kicked), true);
  assert.ok(stockCameraZ(kicked) < -0.09, `stock crossed the near plane at ${stockCameraZ(kicked)}`);

  const right = viewmodelOffset({ kick: 0, strafe: 8, planarSpeed: 8, walkPhase: 0 });
  const left = viewmodelOffset({ kick: 0, strafe: -8, planarSpeed: 8, walkPhase: 0 });
  assert.ok(right.roll < -0.02 && left.roll > 0.02, "strafe did not lean the carbine");
  assert.ok(right.x > VIEW_REST.x && left.x < VIEW_REST.x);

  const before = viewmodelOffset({ kick: 0.4, strafe: 3, planarSpeed: 6, walkPhase: 0.4 });
  const after = viewmodelOffset({ kick: 0.42, strafe: 3.15, planarSpeed: 6, walkPhase: 0.45 });
  assert.ok(Math.abs(before.x - after.x) < 0.01);
  assert.ok(Math.abs(before.y - after.y) < 0.01);
  assert.ok(Math.abs(before.z - after.z) < 0.01);
  assert.ok(Math.abs(before.pitch - after.pitch) < 0.01);
  assert.ok(Math.abs(before.roll - after.roll) < 0.01);

  assert.equal(strafeOf(0, { x: 4, y: 1, z: -3 }), 4);
  assert.equal(stepWalkPhase(1, 0.1, 0), 1);
  const stepped = stepWalkPhase(0, 0.1, 8);
  assert.ok(stepped > 0.9 && stepped < 1.2, `walk phase ${stepped}`);

  const kicks = [0, 0.5, 1];
  const strafes = [-40, -8, 0, 8, 40];
  const speeds = [0, 4, 8, 30];
  const phases = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2, 4];
  for (const kick of kicks) {
    for (const strafe of strafes) {
      for (const planarSpeed of speeds) {
        for (const walkPhase of phases) {
          const pose = viewmodelOffset({ kick, strafe, planarSpeed, walkPhase });
          assert.equal(
            viewmodelInFrame(pose),
            true,
            `out of frame kick ${kick} strafe ${strafe} speed ${planarSpeed} phase ${walkPhase} ${JSON.stringify(pose)} stock ${stockCameraZ(pose)}`,
          );
        }
      }
    }
  }

  const wild = viewmodelOffset({ kick: Number.NaN, strafe: Number.NaN, planarSpeed: -4, walkPhase: Number.NaN });
  assert.equal(viewmodelInFrame(wild), true);
});
