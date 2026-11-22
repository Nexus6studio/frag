import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const host = "127.0.0.1";
const port = Number(process.env.FRAG_PREVIEW_PORT ?? 4173);
const origin = `http://${host}:${port}`;

function waitForPort(timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host });
      const finish = (ok) => {
        socket.removeAllListeners();
        socket.destroy();
        if (ok) {
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`vite preview did not listen on ${origin}`));
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

async function hudMode(page) {
  return page.locator("#hud").evaluate((el) => el.getAttribute("data-mode"));
}

// Warning, then acknowledge, then click-to-play. Pointer lock may be denied
// headless, so this asserts overlay phases rather than document.pointerLockElement.
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
    await page.waitForFunction(
      () => document.querySelector("#hud")?.getAttribute("data-mode") === "play",
      undefined,
      { timeout: 2_000 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    errors.push(`hud did not show during play: ${message}`);
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
      debug: Object.prototype.hasOwnProperty.call(window, "__fragPlayer"),
      barFromBottom: window.innerHeight - barBox.bottom,
      hpOnLeft: hpBox.left < window.innerWidth / 2,
      ammoOnRight: ammoBox.right > window.innerWidth / 2,
    };
  });
  if (readout.error) errors.push(readout.error);
  else {
    if (readout.hp !== "100" || !readout.hpShown) errors.push(`hp readout is ${readout.hp}`);
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
    if (!readout.deathHidden || readout.deathText !== "click to restart") {
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
  if ((await hudMode(page)) !== "play") errors.push("hud did not return after resume");

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
    const page = await browser.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
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

    await assertShellFlow(page, errors);

    if (errors.length > 0) {
      console.error(errors.join("\n"));
      if (previewLog.trim()) console.error(previewLog);
      process.exitCode = 1;
    } else {
      console.log(
        `smoke passed: canvas ${sample.width}x${sample.height}, ${sample.colored} non-background samples, warning -> continue -> click-to-play -> hud 100 / hidden armor / 40+40 -> pause -> resume -> reload, no console errors`,
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
