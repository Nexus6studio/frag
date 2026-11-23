import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const host = "127.0.0.1";
const port = Number(process.env.FRAG_PREVIEW_PORT ?? 4173);
const origin = `http://${host}:${port}`;

function waitForPort(timeoutMs, listenPort = port, label = origin) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port: listenPort, host });
      const finish = (ok) => {
        socket.removeAllListeners();
        socket.destroy();
        if (ok) {
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`server did not listen on ${label}`));
          return;
        }
        setTimeout(attempt, 200);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    };
    attempt();
  });
}

const preview = spawn(
  process.execPath,
  [
    path.join(root, "node_modules/vite/bin/vite.js"),
    "preview",
    "--host",
    host,
    "--port",
    String(port),
    "--strictPort",
  ],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
);

let previewLog = "";
preview.stdout.on("data", (chunk) => {
  previewLog += chunk;
});
preview.stderr.on("data", (chunk) => {
  previewLog += chunk;
});

function stopPreview() {
  if (preview.exitCode == null && !preview.killed) preview.kill("SIGTERM");
}

async function previewExited() {
  if (preview.exitCode != null || preview.signalCode != null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      preview.kill("SIGKILL");
      resolve();
    }, 3000);
    preview.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const errors = [];

// Chrome's OpenGL backend prints this four times while compositing WebGL, then
// adds "(this message will no longer repeat)". The page never calls readPixels.
const warningAllowlist = [
  {
    pattern: /GPU stall due to ReadPixels/,
    reason:
      "Chrome/ANGLE logs a driver stall four times on load when its OpenGL backend copies the WebGL canvas to the screen. Frag does not read pixels there, and page script cannot silence the driver notice.",
  },
];

function phaseOf(page) {
  return page.locator("#app-shell").getAttribute("data-phase");
}

async function expectPhase(page, errors, expected, label) {
  const actual = await phaseOf(page);
  if (actual !== expected) {
    errors.push(`${label}: expected phase ${expected}, got ${actual ?? "missing"}`);
  }
}

async function visibleText(page, selector) {
  return page.locator(selector).innerText();
}

function horizontalFov(verticalDeg, aspect) {
  const vertical = (verticalDeg * Math.PI) / 180;
  return (2 * Math.atan(Math.tan(vertical / 2) * aspect) * 180) / Math.PI;
}

async function readDrones(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement) || canvas.fragDrones == null) {
      return { error: "fragDrones missing" };
    }
    return canvas.fragDrones;
  });
}

async function assertDrones(page, errors, label) {
  const drones = await readDrones(page);
  if (drones.error) {
    errors.push(`${label}: ${drones.error}`);
    return;
  }
  const alive = (drones.drones ?? []).filter((drone) => drone.alive);
  if (drones.count !== 2 || alive.length !== 2) {
    errors.push(`${label}: expected 2 WISP-4 drones, saw ${drones.count}`);
    return;
  }
  for (const drone of alive) {
    if (!drone.alive) errors.push(`${label}: a WISP-4 is already dead`);
    if (!drone.aggro) errors.push(`${label}: a WISP-4 is not aggro`);
    if (![drone.x, drone.y, drone.z].every((value) => Number.isFinite(value))) {
      errors.push(`${label}: a WISP-4 has a non-finite position`);
    }
  }
}

async function readView(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement) || canvas.fragView == null) {
      return { error: "fragView missing" };
    }
    const { verticalFov, aspect } = canvas.fragView;
    return {
      verticalFov,
      aspect,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
    };
  });
}

function assertHorizontalFov(view, errors, label) {
  if (!view || view.error) {
    errors.push(`${label}: ${view?.error ?? "missing view"}`);
    return;
  }
  if (!Number.isFinite(view.verticalFov) || !Number.isFinite(view.aspect)) {
    errors.push(`${label}: non-finite fov ${view.verticalFov} aspect ${view.aspect}`);
    return;
  }
  const expectedAspect = view.innerWidth / Math.max(view.innerHeight, 1);
  if (Math.abs(view.aspect - expectedAspect) > 1e-4) {
    errors.push(`${label}: aspect ${view.aspect} != viewport ${expectedAspect}`);
  }
  const horizontal = horizontalFov(view.verticalFov, view.aspect);
  if (Math.abs(horizontal - 105) > 0.02) {
    errors.push(`${label}: horizontal fov ${horizontal.toFixed(4)}°, expected 105°`);
  }
}

function contrastRatio(foreground, background) {
  const channel = (hex) => {
    const value = hex / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (rgb) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  const parse = (color) => {
    const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const fg = parse(foreground);
  const bg = parse(background);
  if (!fg || !bg) return null;
  const lighter = Math.max(luminance(fg), luminance(bg));
  const darker = Math.min(luminance(fg), luminance(bg));
  return (lighter + 0.05) / (darker + 0.05);
}

async function assertReadableType(page, errors, label) {
  const fonts = await page.evaluate(() => {
    const px = (el) => (el instanceof HTMLElement ? Number.parseFloat(getComputedStyle(el).fontSize) : null);
    const labels = [...document.querySelectorAll("#hud-hp-stat .hud-label, #hud-ammo-stat .hud-label")].map((el) => {
      const style = getComputedStyle(el);
      const stat = el.parentElement instanceof HTMLElement ? getComputedStyle(el.parentElement) : null;
      return {
        text: el.textContent,
        size: px(el),
        color: style.color,
        backing: stat?.backgroundColor ?? "",
      };
    });
    return {
      copy: px(document.querySelector(".copy")),
      eyebrow: px(document.querySelector(".eyebrow")),
      labels,
      height: window.innerHeight,
    };
  });
  if (!(fonts.copy >= 16)) errors.push(`${label}: body text is ${fonts.copy}px at ${fonts.height}px tall`);
  if (!(fonts.eyebrow >= 12)) errors.push(`${label}: eyebrow is ${fonts.eyebrow}px at ${fonts.height}px tall`);
  if (fonts.labels.length < 2) errors.push(`${label}: expected HP and AMMO labels, found ${fonts.labels.length}`);
  for (const hudLabel of fonts.labels) {
    if (!(hudLabel.size >= 12)) {
      errors.push(`${label}: ${hudLabel.text} label is ${hudLabel.size}px at ${fonts.height}px tall`);
    }
    const ratio = contrastRatio(hudLabel.color, hudLabel.backing);
    if (!(ratio >= 4.5)) {
      errors.push(
        `${label}: ${hudLabel.text} contrast ${ratio ?? "unreadable"} (${hudLabel.color} on ${hudLabel.backing})`,
      );
    }
  }
}

async function hudMode(page) {
  return page.locator("#hud").evaluate((el) => el.getAttribute("data-mode"));
}

// Warning, then acknowledge, then click-to-play. Pointer lock may be denied
// headless, so this asserts overlay phases rather than document.pointerLockElement.
async function dispatchMouse(page, type) {
  await page.evaluate((eventType) => {
    window.dispatchEvent(
      new MouseEvent(eventType, { button: 0, buttons: eventType === "mousedown" ? 1 : 0, bubbles: true }),
    );
  }, type);
}

async function assertQuillFire(page, errors) {
  const ammoText = () => page.locator("#hud-ammo").innerText();
  const before = (await ammoText()).trim();
  if (before !== "40+40") errors.push(`ammo before fire is ${before}`);
  await dispatchMouse(page, "mousedown");
  let stats = null;
  try {
    await page.waitForFunction(
      () => {
        const mag = Number((document.querySelector("#hud-ammo")?.textContent ?? "").split("+")[0]);
        return Number.isFinite(mag) && mag <= 34;
      },
      undefined,
      { timeout: 15_000, polling: 50 },
    );
    stats = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      if (!(canvas instanceof HTMLCanvasElement) || canvas.fragStats == null) return { error: "fragStats missing" };
      return canvas.fragStats;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    errors.push(`holding fire did not drop ammo from 40 (now ${await ammoText()}): ${message}`);
  } finally {
    await dispatchMouse(page, "mouseup");
  }
  const mid = (await ammoText()).trim();
  const mag = Number(mid.split("+")[0]);
  if (!(mag < 40)) errors.push(`ammo digits did not drop from 40 (now ${mid})`);
  await page.keyboard.press("KeyR");
  try {
    await page.waitForFunction(
      (previous) => {
        const text = document.querySelector("#hud-ammo")?.textContent ?? "";
        return text.startsWith("40+") && text !== previous;
      },
      mid,
      { timeout: 15_000, polling: 50 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    errors.push(`reload did not refill the magazine (now ${await ammoText()}): ${message}`);
  }
  const drones = await readDrones(page);
  if (drones.error) errors.push(drones.error);
  if (stats && !stats.error) {
    if (!(stats.calls > 0 && stats.calls <= 80)) {
      errors.push(`renderer draw calls during fire ${stats.calls} outside 1..80`);
    }
    if (!(stats.triangles > 0 && stats.triangles <= 50_000)) {
      errors.push(`renderer triangles during fire ${stats.triangles} outside 1..50000`);
    }
    console.log(
      `renderer.info during fire: calls ${stats.calls}, triangles ${stats.triangles}, lines ${stats.lines}, points ${stats.points}, drones ${drones.count ?? "?"}, live bolts ${drones.bolts ?? "?"}`,
    );
  } else if (stats?.error) {
    errors.push(stats.error);
  }
}

async function assertShellFlow(page, errors) {
  const lockHeld = () => page.evaluate(() => document.pointerLockElement != null);

  await expectPhase(page, errors, "warning", "fresh load");
  const warningText = (await visibleText(page, "#content-warning")).toLowerCase();
  for (const phrase of ["frag", "blood and gibs", "fictional violence", "flashing lights"]) {
    if (!warningText.includes(phrase)) errors.push(`warning text missing "${phrase}"`);
  }
  if (await page.locator("#click-to-play").evaluate((el) => !el.hidden)) {
    errors.push("click-to-play visible before the warning is acknowledged");
  }
  if (await page.locator("#fps-readout").evaluate((el) => !el.hidden)) {
    errors.push("fps readout is visible by default");
  }
  if (await lockHeld()) errors.push("pointer locked on fresh load");
  if ((await hudMode(page)) !== "hidden") errors.push("hud visible during the warning");

  await page.locator("#content-warning").click({ position: { x: 12, y: 12 } });
  await page.locator("canvas").click({ force: true });
  await page.keyboard.press("KeyF");
  await expectPhase(page, errors, "warning", "after canvas click and scrim click");
  if (await lockHeld()) errors.push("pointer locked without acknowledging the warning");

  await page.locator("#content-warning-continue").click();
  await expectPhase(page, errors, "ready", "after continue");
  if (await page.locator("#content-warning").evaluate((el) => !el.hidden)) {
    errors.push("warning still visible after continue");
  }
  if (await page.locator("#click-to-play").evaluate((el) => el.hidden)) {
    errors.push("click-to-play hidden after continue");
  }
  const startText = (await visibleText(page, "#click-to-play")).toLowerCase();
  if (!startText.includes("frag") || !startText.includes("prototype")) {
    errors.push(`click-to-play copy missing title or prototype line: ${startText}`);
  }
  if (await lockHeld()) errors.push("pointer locked before click-to-play");
  if ((await hudMode(page)) !== "hidden") errors.push("hud visible on the start overlay");

  await page.locator("#click-to-play").click();
  await expectPhase(page, errors, "playing", "after click-to-play");
  if (await page.locator("#click-to-play").evaluate((el) => !el.hidden)) {
    errors.push("click-to-play still visible after start");
  }
  if (await page.locator("#content-warning").evaluate((el) => !el.hidden)) {
    errors.push("warning visible after start");
  }

  try {
    // Poll from the test runner. The default rAF poll stalls behind a software-GL
    // frame, so a HUD that is already in play mode can miss a 2s rAF budget.
    await page.waitForFunction(
      () => document.querySelector("#hud")?.getAttribute("data-mode") === "play",
      undefined,
      { timeout: 2_000, polling: 50 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    const snap = await page.evaluate(() => ({
      phase: document.querySelector("#app-shell")?.getAttribute("data-phase"),
      mode: document.querySelector("#hud")?.getAttribute("data-mode"),
      locked: document.pointerLockElement != null,
    }));
    errors.push(`hud did not show during play (${JSON.stringify(snap)}): ${message}`);
  }
  const readout = await page.evaluate(() => {
    const hp = document.querySelector("#hud-hp");
    const ammo = document.querySelector("#hud-ammo");
    const armor = document.querySelector("#hud-armor");
    const armorStat = document.querySelector("#hud-armor-stat");
    const hpStat = document.querySelector("#hud-hp-stat");
    const ammoStat = document.querySelector("#hud-ammo-stat");
    const crosshair = document.querySelector("#crosshair");
    const tick = document.querySelector("#crosshair span");
    const death = document.querySelector("#death-recap");
    const bar = document.querySelector("#hud-bar");
    const canvas = document.querySelector("canvas");
    if (
      !(hp instanceof HTMLElement) ||
      !(ammo instanceof HTMLElement) ||
      !(armor instanceof HTMLElement) ||
      !(armorStat instanceof HTMLElement) ||
      !(hpStat instanceof HTMLElement) ||
      !(ammoStat instanceof HTMLElement) ||
      !(crosshair instanceof HTMLElement) ||
      !(tick instanceof HTMLElement) ||
      !(death instanceof HTMLElement) ||
      !(bar instanceof HTMLElement)
    ) {
      return { error: "hud markup missing" };
    }
    const box = crosshair.getBoundingClientRect();
    const armorBox = armorStat.getBoundingClientRect();
    const hpBox = hpStat.getBoundingClientRect();
    const ammoBox = ammoStat.getBoundingClientRect();
    const barBox = bar.getBoundingClientRect();
    const tickStyle = getComputedStyle(tick);
    const shown = (el) => {
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && el.getClientRects().length > 0;
    };
    return {
      hp: hp.textContent,
      ammo: ammo.textContent,
      armorText: armor.textContent,
      armorVisibility: getComputedStyle(armor).visibility,
      armorWidth: armorBox.width,
      armorHeight: armorBox.height,
      armorBetween: armorBox.left >= hpBox.right - 1 && armorBox.right <= ammoBox.left + 1,
      hpShown: shown(hp),
      ammoShown: shown(ammo),
      crossDx: Math.abs(box.left + box.width / 2 - window.innerWidth / 2),
      crossDy: Math.abs(box.top + box.height / 2 - window.innerHeight / 2),
      crossShown: shown(crosshair),
      tickBackground: tickStyle.backgroundColor,
      tickShadow: tickStyle.boxShadow,
      deathHidden: death.hidden,
      deathText: death.textContent,
      cursor: canvas instanceof HTMLElement ? getComputedStyle(canvas).cursor : "missing",
      debug:
        Object.prototype.hasOwnProperty.call(window, "__fragPlayer") ||
        Object.prototype.hasOwnProperty.call(window, "__fragMove") ||
        Object.prototype.hasOwnProperty.call(window, "__fragDamage") ||
        Object.prototype.hasOwnProperty.call(window, "__fragRun"),
      barFromBottom: window.innerHeight - barBox.bottom,
      hpOnLeft: hpBox.left < window.innerWidth / 2,
      ammoOnRight: ammoBox.right > window.innerWidth / 2,
    };
  });
  if (readout.error) errors.push(readout.error);
  else {
    if (readout.hp !== "100" || !readout.hpShown) errors.push(`hp readout is ${readout.hp}`);
    await assertDrones(page, errors, "at play start");
    if (readout.ammo !== "40+40" || !readout.ammoShown) errors.push(`ammo readout is ${readout.ammo}`);
    if (readout.armorText !== "0") errors.push(`armor value is ${readout.armorText}`);
    if (readout.armorVisibility !== "hidden") {
      errors.push(`armor readout is visible (${readout.armorVisibility})`);
    }
    if (readout.armorWidth <= 0 || readout.armorHeight <= 0 || !readout.armorBetween) {
      errors.push("armor slot is missing from the hud layout");
    }
    if (!readout.crossShown) errors.push("crosshair hidden during play");
    if (readout.crossDx > 2 || readout.crossDy > 2) {
      errors.push(`crosshair off center by ${readout.crossDx}px, ${readout.crossDy}px`);
    }
    if (readout.tickBackground !== "rgb(247, 248, 255)" || !readout.tickShadow.includes("7, 8, 13")) {
      errors.push(`crosshair contrast is ${readout.tickBackground} / ${readout.tickShadow}`);
    }
    const deathCopy = (readout.deathText ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!readout.deathHidden || !deathCopy.includes("click to restart") || !deathCopy.includes("waves")) {
      errors.push(`death recap is ${readout.deathHidden ? "hidden" : "shown"}: ${readout.deathText}`);
    }
    if (readout.cursor !== "none") errors.push(`play cursor is ${readout.cursor}`);
    if (readout.debug) errors.push("player debug hook is active in the production build");
    if (readout.barFromBottom < 0 || readout.barFromBottom > 48 || !readout.hpOnLeft || !readout.ammoOnRight) {
      errors.push("hud is not along the bottom corners");
    }
  }

  await page.keyboard.press("Backquote");
  if (await page.locator("#fps-readout").evaluate((el) => el.hidden)) {
    errors.push("backquote did not show the fps readout");
  }
  try {
    // Poll on a timer, not requestAnimationFrame. Bloom on software GL can
    // occupy the frame callback for longer than a display tick, and an rAF
    // poll never runs until that callback returns.
    await page.waitForFunction(
      () => {
        const readout = document.querySelector("#fps-readout");
        const text = readout?.textContent ?? "";
        return (
          readout?.hidden === false &&
          text.includes("fps") &&
          text.includes("pos") &&
          text.includes("sens") &&
          text.includes("m/s") &&
          text.includes("ground")
        );
      },
      undefined,
      { timeout: 15_000, polling: 250 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    errors.push(`fps readout did not show position, speed, and ground: ${message}`);
  }

  const poseOf = (text) => {
    const match = /pos (-?\d+\.\d+) (-?\d+\.\d+) (-?\d+\.\d+)/.exec(text ?? "");
    if (!match) return null;
    return { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
  };
  const beforeMove = poseOf(await page.locator("#fps-readout").innerText());
  if (!beforeMove) {
    errors.push("debug readout has no position before moving");
  } else {
    const locked = await page.evaluate(() => document.pointerLockElement != null);
    if (!locked) errors.push("pointer did not lock; movement keys are not sampled");
    await page.keyboard.down("KeyW");
    try {
      await page.waitForFunction(
        (startZ) => {
          const text = document.querySelector("#fps-readout")?.textContent ?? "";
          const match = /pos (-?\d+\.\d+) (-?\d+\.\d+) (-?\d+\.\d+)/.exec(text);
          if (!match) return false;
          return startZ - Number(match[3]) > 1;
        },
        beforeMove.z,
        { timeout: 20_000, polling: 250 },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      errors.push(`holding W did not move forward within 20s: ${message}`);
    } finally {
      await page.keyboard.up("KeyW");
    }
    const afterMove = poseOf(await page.locator("#fps-readout").innerText());
    if (!afterMove) errors.push("debug readout has no position after moving");
    else if (!(beforeMove.z - afterMove.z > 1)) {
      errors.push(
        `holding W did not move forward (z ${beforeMove.z.toFixed(2)} -> ${afterMove.z.toFixed(2)})`,
      );
    }
  }

  await assertQuillFire(page, errors);

  await page.keyboard.press("F1");
  if (await page.locator("#fps-readout").evaluate((el) => !el.hidden)) {
    errors.push("f1 did not hide the fps readout");
  }

  await page.keyboard.press("Escape");
  try {
    await page.waitForFunction(
      () => {
        const shell = document.querySelector("#app-shell");
        return shell?.getAttribute("data-phase") === "paused" && document.pointerLockElement == null;
      },
      undefined,
      { timeout: 2_000 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    errors.push(`escape did not pause and release the pointer: ${message}`);
  }
  await expectPhase(page, errors, "paused", "after escape");
  if (await page.locator("#content-warning").evaluate((el) => !el.hidden)) {
    errors.push("warning returned when pausing");
  }
  if (await lockHeld()) errors.push("pointer still locked while paused");
  const pausedHud = await page.locator("#hud").evaluate((el) => ({
    mode: el.getAttribute("data-mode"),
    opacity: Number(getComputedStyle(el).opacity),
  }));
  if (pausedHud.mode !== "dim") errors.push(`hud not dimmed on pause (${pausedHud.mode ?? "missing"})`);
  else if (!(pausedHud.opacity < 1)) errors.push(`pause hud opacity is ${pausedHud.opacity}`);

  await page.locator("#pause").click();
  await expectPhase(page, errors, "playing", "after resume");
  if (await page.locator("#content-warning").evaluate((el) => !el.hidden)) {
    errors.push("warning returned when resuming");
  }
  if (await page.locator("#pause").evaluate((el) => !el.hidden)) {
    errors.push("pause overlay still visible after resume");
  }
  const resumedHud = await hudMode(page);
  // A WISP-4 bolt can drop the player during the readout. Death is the
  // click-to-restart recap; pause still returns to that or to play.
  if (resumedHud !== "play" && resumedHud !== "dead") {
    errors.push(`hud did not return after resume (${resumedHud ?? "missing"})`);
  }

  const stored = await page.evaluate(() => Object.keys(localStorage));
  if (stored.length > 0) errors.push(`localStorage was written: ${stored.join(", ")}`);

  await page.reload({ waitUntil: "load", timeout: 15_000 });
  await page.waitForSelector("canvas", { timeout: 5_000 });
  await expectPhase(page, errors, "warning", "after reload");
  if (await page.locator("#content-warning").evaluate((el) => el.hidden)) {
    errors.push("warning hidden after reload");
  }

  await page.keyboard.press("Enter");
  await expectPhase(page, errors, "ready", "after enter on the reloaded warning");
  if (await lockHeld()) errors.push("enter locked the pointer from the warning");
  await page.keyboard.press("Space");
  await expectPhase(page, errors, "playing", "after space on click-to-play");
}

const devPort = Number(process.env.FRAG_DEV_PORT ?? 5174);
const devOrigin = `http://${host}:${devPort}`;

async function runDevSmoke(browser, errors) {
  const dev = spawn(
    process.execPath,
    [
      path.join(root, "node_modules/vite/bin/vite.js"),
      "--host",
      host,
      "--port",
      String(devPort),
      "--strictPort",
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  let devLog = "";
  dev.stdout.on("data", (chunk) => {
    devLog += chunk;
  });
  dev.stderr.on("data", (chunk) => {
    devLog += chunk;
  });
  const stopDev = () => {
    if (dev.exitCode == null && !dev.killed) dev.kill("SIGTERM");
  };
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    page.on("console", (message) => {
      const text = message.text();
      if (message.type() === "error") errors.push(`dev console: ${text}`);
      if (message.type() === "warning") {
        const allowed = warningAllowlist.find((entry) => entry.pattern.test(text));
        if (!allowed) errors.push(`dev console warning: ${text}`);
      }
    });
    page.on("pageerror", (error) => {
      errors.push(`dev pageerror: ${error.message}`);
    });
    page.on("request", (request) => {
      const url = request.url();
      if (url.startsWith(`${devOrigin}/`) || url === devOrigin || url.startsWith("data:")) return;
      errors.push(`dev unexpected network request: ${url}`);
    });
    await waitForPort(20_000, devPort, devOrigin);
    await page.goto(`${devOrigin}/`, { waitUntil: "load", timeout: 20_000 });
    await page.waitForSelector("canvas", { timeout: 5_000 });
    const storedOnLoad = await page.evaluate(() => Object.keys(localStorage));
    if (storedOnLoad.length > 0) {
      errors.push(`dev localStorage was not empty on load: ${storedOnLoad.join(", ")}`);
    }
    const hook = await page.evaluate(() => typeof window.__fragDamage === "function" && !!window.__fragRun);
    if (!hook) errors.push("dev damage hook is missing");

    await page.locator("#content-warning-continue").click();
    await page.locator("#click-to-play").click();
    try {
      await page.waitForFunction(
        () => document.querySelector("#hud")?.getAttribute("data-mode") === "play",
        undefined,
        { timeout: 5_000, polling: 50 },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      errors.push(`dev hud did not enter play: ${message}`);
      return;
    }

    await page.evaluate(() => window.__fragDamage(500));
    try {
      await page.waitForFunction(
        () => document.querySelector("#hud")?.getAttribute("data-mode") === "dead",
        undefined,
        { timeout: 2_000, polling: 50 },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      errors.push(`dev fatal damage did not show the recap: ${message}`);
      return;
    }
    const recap = await page.evaluate(() => {
      const death = document.querySelector("#death-recap");
      const bar = document.querySelector("#hud-bar");
      const warning = document.querySelector("#content-warning");
      const text = (death?.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      return {
        hidden: death instanceof HTMLElement ? death.hidden : true,
        text,
        bar: bar instanceof HTMLElement ? getComputedStyle(bar).visibility : "missing",
        warningHidden: warning instanceof HTMLElement ? warning.hidden : false,
        phase: document.querySelector("#app-shell")?.getAttribute("data-phase") ?? "",
      };
    });
    if (recap.hidden) errors.push("dev death recap stayed hidden");
    if (!/waves\s+\d+/.test(recap.text)) errors.push(`dev recap missing waves: ${recap.text}`);
    if (!/frags\s+\d+/.test(recap.text)) errors.push(`dev recap missing frags: ${recap.text}`);
    if (!/\d{2}:\d{2}/.test(recap.text)) errors.push(`dev recap missing time: ${recap.text}`);
    if (!recap.text.includes("click to restart")) errors.push(`dev recap missing restart hint: ${recap.text}`);
    if (recap.bar !== "hidden") errors.push(`dev combat hud stayed visible (${recap.bar})`);
    if (!recap.warningHidden || recap.phase === "warning") {
      errors.push(`dev warning returned on death (${recap.phase})`);
    }

    await page.locator("#death-recap").click({ force: true });
    const restarted = await page.evaluate(() => {
      const warning = document.querySelector("#content-warning");
      const canvas = document.querySelector("canvas");
      const run = window.__fragRun?.snapshot;
      return {
        hp: document.querySelector("#hud-hp")?.textContent ?? "",
        ammo: document.querySelector("#hud-ammo")?.textContent ?? "",
        armor: document.querySelector("#hud-armor")?.textContent ?? "",
        warningHidden: warning instanceof HTMLElement ? warning.hidden : false,
        phase: document.querySelector("#app-shell")?.getAttribute("data-phase") ?? "",
        wave: run?.wave,
        count: run?.count,
        frags: run?.frags,
        wavesCleared: run?.wavesCleared,
        phaseRun: run?.phase,
        stored: Object.keys(localStorage),
      };
    });
    if (restarted.hp !== "100") errors.push(`dev restart hp is ${restarted.hp}`);
    if (restarted.ammo !== "40+40") errors.push(`dev restart ammo is ${restarted.ammo}`);
    if (restarted.armor !== "0") errors.push(`dev restart armor is ${restarted.armor}`);
    if (!restarted.warningHidden || restarted.phase === "warning") {
      errors.push(`dev warning returned on restart (${restarted.phase})`);
    }
    if (restarted.wave !== 1 || restarted.count !== 2 || restarted.phaseRun !== "fighting") {
      errors.push(
        `dev restart wave is ${restarted.wave} count ${restarted.count} phase ${restarted.phaseRun}`,
      );
    }
    if (restarted.frags !== 0 || restarted.wavesCleared !== 0) {
      errors.push(`dev restart counters frags ${restarted.frags} waves ${restarted.wavesCleared}`);
    }
    if (restarted.stored.length > 0) {
      errors.push(`dev localStorage was written: ${restarted.stored.join(", ")}`);
    }

    if (restarted.phase === "paused") await page.locator("#pause").click();
    try {
      await page.waitForFunction(() => document.pointerLockElement != null, undefined, {
        timeout: 4_000,
        polling: 50,
      });
    } catch {
      await page.locator("canvas").click({ force: true });
    }

    let report = null;
    try {
      const handle = await page.waitForFunction(
        () => {
          const run = window.__fragRun;
          const player = window.__fragPlayer;
          const canvas = document.querySelector("canvas");
          if (!run || !player || !(canvas instanceof HTMLCanvasElement)) return false;
          player.set({ hp: 100, armor: 0 });
          let snap = run.snapshot;
          if (snap.wave < 3 && snap.phase === "fighting" && snap.count > 0) {
            run.killAlive();
            snap = run.snapshot;
          }
          const stats = canvas.fragStats;
          if (!(snap.wave >= 3 && snap.count === 4 && snap.bolts > 0 && stats && stats.calls > 0)) {
            return false;
          }
          return {
            calls: stats.calls,
            triangles: stats.triangles,
            lines: stats.lines,
            points: stats.points,
            wave: snap.wave,
            count: snap.count,
            bolts: snap.bolts,
          };
        },
        undefined,
        { timeout: 25_000, polling: 50 },
      );
      report = await handle.jsonValue();
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      const snap = await page.evaluate(() => window.__fragRun?.snapshot ?? null);
      errors.push(`dev wave 3 did not field 4 firing drones (${JSON.stringify(snap)}): ${message}`);
    }
    if (report) {
      console.log(
        `renderer.info at wave ${report.wave} with ${report.count} drones firing: calls ${report.calls}, triangles ${report.triangles}, lines ${report.lines}, points ${report.points}, live bolts ${report.bolts}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    errors.push(`dev smoke failed: ${message}`);
    if (devLog.trim()) errors.push(devLog.trim().slice(-500));
  } finally {
    await page.close();
    stopDev();
    if (dev.exitCode == null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          dev.kill("SIGKILL");
          resolve();
        }, 3000);
        dev.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

try {
  await waitForPort(20_000);
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
    ],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on("console", (message) => {
      const text = message.text();
      if (message.type() === "error") errors.push(`console: ${text}`);
      if (message.type() === "warning") {
        const allowed = warningAllowlist.find((entry) => entry.pattern.test(text));
        if (!allowed) errors.push(`console warning: ${text}`);
      }
    });
    page.on("pageerror", (error) => {
      errors.push(`pageerror: ${error.message}`);
    });
    page.on("request", (request) => {
      const url = request.url();
      if (url.startsWith(`${origin}/`) || url === origin || url.startsWith("data:")) return;
      errors.push(`unexpected network request: ${url}`);
    });

    await page.goto(`${origin}/`, { waitUntil: "load", timeout: 15_000 });
    await page.waitForSelector("canvas", { timeout: 5_000 });
    await assertDrones(page, errors, "at load");
    const storedOnLoad = await page.evaluate(() => Object.keys(localStorage));
    if (storedOnLoad.length > 0) {
      errors.push(`localStorage was not empty on load: ${storedOnLoad.join(", ")}`);
    }
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
        }),
    );

    const sample = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      if (!(canvas instanceof HTMLCanvasElement)) return { error: "canvas missing" };
      const probe = document.createElement("canvas");
      probe.width = canvas.width;
      probe.height = canvas.height;
      const context = probe.getContext("2d", { willReadFrequently: true });
      if (!context) return { error: "2d context missing" };
      context.drawImage(canvas, 0, 0);
      const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
      let colored = 0;
      for (let index = 0; index < pixels.length; index += 32) {
        const red = pixels[index] ?? 0;
        const green = pixels[index + 1] ?? 0;
        const blue = pixels[index + 2] ?? 0;
        const alpha = pixels[index + 3] ?? 0;
        if (alpha < 250) continue;
        if (Math.abs(red - 0x11) + Math.abs(green - 0x11) + Math.abs(blue - 0x18) > 48) {
          colored += 1;
        }
      }
      return { width: canvas.width, height: canvas.height, colored };
    });

    if (sample.error) errors.push(sample.error);
    else if (!sample.width || !sample.height) errors.push("canvas has no pixels");
    else if (sample.colored < 8) {
      errors.push(
        `canvas does not show a rendered object (${sample.colored} non-background samples)`,
      );
    }

    assertHorizontalFov(await readView(page), errors, "initial viewport");
    await assertReadableType(page, errors, "720p");

    await assertShellFlow(page, errors);

    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
        }),
    );
    await assertReadableType(page, errors, "1080p");
    assertHorizontalFov(await readView(page), errors, "after resize 1920x1080");

    await page.setViewportSize({ width: 1280, height: 480 });
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
        }),
    );
    await assertReadableType(page, errors, "480p");

    const stats = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      if (!(canvas instanceof HTMLCanvasElement) || canvas.fragStats == null) {
        return { error: "fragStats missing" };
      }
      return canvas.fragStats;
    });
    if (stats.error) errors.push(stats.error);
    else {
      if (!(stats.triangles > 0 && stats.triangles <= 50_000)) {
        errors.push(`renderer triangles ${stats.triangles} outside 1..50000`);
      }
      if (!(stats.calls > 0 && stats.calls <= 80)) {
        errors.push(`renderer draw calls ${stats.calls} outside 1..80`);
      }
    }

    const shotDir = path.join(root, "test-results");
    fs.mkdirSync(shotDir, { recursive: true });
    const shot = path.join(shotDir, "atrium-smoke.png");
    await page.screenshot({ path: shot });
    const artifacts = "/opt/cursor/artifacts";
    if (fs.existsSync(artifacts)) fs.copyFileSync(shot, path.join(artifacts, "atrium-smoke.png"));

    await page.setViewportSize({ width: 900, height: 700 });
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
        }),
    );
    assertHorizontalFov(await readView(page), errors, "after resize 900x700");

    await page.setViewportSize({ width: 700, height: 900 });
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
        }),
    );
    assertHorizontalFov(await readView(page), errors, "after resize 700x900");

    await runDevSmoke(browser, errors);

    if (errors.length > 0) {
      console.error(errors.join("\n"));
      if (previewLog.trim()) console.error(previewLog);
      process.exitCode = 1;
    } else {
      console.log(
        `smoke passed: canvas ${sample.width}x${sample.height}, ${sample.colored} non-background samples, draw calls ${stats.calls}, triangles ${stats.triangles}, lines ${stats.lines}, points ${stats.points}, 105° horizontal fov, warning -> continue -> click-to-play -> hud 100 / hidden armor / 40+40 -> W moves forward -> fire drops ammo -> R reloads -> pause -> resume -> reload, readable type at 480p, 720p, and 1080p, death recap -> click restart -> 100/0/40+40 wave 1, no console warnings outside the allowlist, no third-party requests, localStorage empty`,
      );
    }
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  if (errors.length > 0) console.error(errors.join("\n"));
  if (previewLog.trim()) console.error(previewLog);
  process.exitCode = 1;
} finally {
  stopPreview();
  await previewExited();
}
