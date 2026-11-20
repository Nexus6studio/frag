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

  await page.locator("#click-to-play").click();
  await expectPhase(page, errors, "playing", "after click-to-play");
  if (await page.locator("#click-to-play").evaluate((el) => !el.hidden)) {
    errors.push("click-to-play still visible after start");
  }
  if (await page.locator("#content-warning").evaluate((el) => !el.hidden)) {
    errors.push("warning visible after start");
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

  await page.locator("#pause").click();
  await expectPhase(page, errors, "playing", "after resume");
  if (await page.locator("#content-warning").evaluate((el) => !el.hidden)) {
    errors.push("warning returned when resuming");
  }
  if (await page.locator("#pause").evaluate((el) => !el.hidden)) {
    errors.push("pause overlay still visible after resume");
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
        `smoke passed: canvas ${sample.width}x${sample.height}, ${sample.colored} non-background samples, warning -> continue -> click-to-play -> pause -> resume -> reload, no console errors`,
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
