import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import {
  WISP_BOLT_DAMAGE,
  WISP_BOLT_GAP,
  WISP_WAVE1_BURST_GAP,
  WISP_WAVE1_SPAWN_GRACE,
} from "../src/wisp.ts";

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

function noteConsole(page, errors, label) {
  const prefix = label ? `${label} ` : "";
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error") errors.push(`${prefix}console: ${text}`);
    if (message.type() === "warning") errors.push(`${prefix}console warning: ${text}`);
  });
  page.on("pageerror", (error) => {
    errors.push(`${prefix}pageerror: ${error.message}`);
  });
}

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

const WARNING_TITLE = "Content warning";
const WARNING_BODY =
  "Contains fast-paced combat against fictional enemies, with blood, gibs, explosions, sparks and debris. Includes flashing lights and rapid motion.";

function expectedBuildId() {
  const env = process.env.GITHUB_SHA?.trim() ?? "";
  if (/^[0-9a-f]{7,40}$/i.test(env)) return env.toLowerCase().slice(0, 7);
  try {
    return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .toLowerCase()
      .slice(0, 7);
  } catch {
    return "dev";
  }
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
  if (drones.enforcerAlive !== 0) {
    errors.push(`${label}: expected no wave 1 enforcer, saw ${drones.enforcerAlive}`);
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

async function assertWarningCopy(page, errors, label) {
  const measured = await page.evaluate(() => {
    const title = document.querySelector("#content-warning-title");
    const body = document.querySelector("#content-warning .copy");
    const panel = document.querySelector("#content-warning .panel");
    const button = document.querySelector("#content-warning-continue");
    const px = (el) => (el instanceof HTMLElement ? Number.parseFloat(getComputedStyle(el).fontSize) : null);
    const style = (el) => (el instanceof HTMLElement ? getComputedStyle(el) : null);
    return {
      title: title?.textContent ?? "",
      body: body?.textContent ?? "",
      button: button?.textContent ?? "",
      hash: document.querySelector("#build-hash")?.textContent ?? "",
      hashPx: px(document.querySelector("#build-hash")),
      eyebrow: document.querySelector("#content-warning .eyebrow") !== null,
      titlePx: px(title),
      bodyPx: px(body),
      titleColor: style(title)?.color ?? "",
      bodyColor: style(body)?.color ?? "",
      panel: style(panel)?.backgroundColor ?? "",
      height: window.innerHeight,
      width: window.innerWidth,
    };
  });
  if (measured.title !== WARNING_TITLE) {
    errors.push(`${label}: warning title is ${JSON.stringify(measured.title)}`);
  }
  if (measured.body.trim() !== WARNING_BODY) {
    errors.push(`${label}: warning body is ${JSON.stringify(measured.body)}`);
  }
  if (measured.button.trim() !== "Continue") {
    errors.push(`${label}: warning button is ${JSON.stringify(measured.button)}`);
  }
  const buildId = expectedBuildId();
  if (measured.hash !== `build ${buildId}`) {
    errors.push(`${label}: build id is ${JSON.stringify(measured.hash)}, expected build ${buildId}`);
  }
  if (!(measured.hashPx > 0) || measured.hashPx > 14) {
    errors.push(`${label}: build id is ${measured.hashPx}px`);
  }
  if (measured.body.includes(buildId)) {
    errors.push(`${label}: build id was written into the warning body`);
  }
  if (measured.eyebrow) errors.push(`${label}: content warning eyebrow is still shown`);
  if (!(measured.titlePx >= 16)) errors.push(`${label}: warning title is ${measured.titlePx}px`);
  if (!(measured.bodyPx >= 16)) errors.push(`${label}: warning body is ${measured.bodyPx}px`);
  const titleContrast = contrastRatio(measured.titleColor, measured.panel);
  const bodyContrast = contrastRatio(measured.bodyColor, measured.panel);
  if (!(titleContrast >= 4.5)) {
    errors.push(`${label}: warning title contrast ${titleContrast} (${measured.titleColor} on ${measured.panel})`);
  }
  if (!(bodyContrast >= 4.5)) {
    errors.push(`${label}: warning body contrast ${bodyContrast} (${measured.bodyColor} on ${measured.panel})`);
  }
  console.log(
    `warning ${label}: title ${measured.titlePx}px contrast ${titleContrast?.toFixed(2) ?? "?"} (${measured.titleColor} on ${measured.panel}), body ${measured.bodyPx}px contrast ${bodyContrast?.toFixed(2) ?? "?"} (${measured.bodyColor} on ${measured.panel}) at ${measured.width}x${measured.height}`,
  );
}

async function assertCanvasAspect(page, errors, label) {
  const view = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) return { error: "canvas missing" };
    return {
      cssW: canvas.clientWidth,
      cssH: canvas.clientHeight,
      bufW: canvas.width,
      bufH: canvas.height,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
    };
  });
  if (view.error) {
    errors.push(`${label}: ${view.error}`);
    return;
  }
  const cssAspect = view.cssW / Math.max(view.cssH, 1);
  const bufAspect = view.bufW / Math.max(view.bufH, 1);
  const viewAspect = view.innerW / Math.max(view.innerH, 1);
  if (Math.abs(cssAspect - viewAspect) > 0.02) {
    errors.push(`${label}: canvas css aspect ${cssAspect.toFixed(4)} stretched vs viewport ${viewAspect.toFixed(4)}`);
  }
  if (Math.abs(bufAspect - cssAspect) > 0.02) {
    errors.push(`${label}: canvas buffer aspect ${bufAspect.toFixed(4)} stretched vs css ${cssAspect.toFixed(4)}`);
  }
}

async function assertHiddenTabDoesNotSpike(page, errors) {
  const dropped = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const canvas = document.querySelector("canvas");
        const before = canvas instanceof HTMLCanvasElement ? canvas.fragPose : null;
        document.dispatchEvent(new Event("visibilitychange"));
        const start = performance.now();
        while (performance.now() - start < 1500) {
          // Block the frame so the next animation callback sees a multi-second gap.
        }
        requestAnimationFrame(() => {
          const live = document.querySelector("canvas");
          resolve({
            simDt: live instanceof HTMLCanvasElement ? live.fragPose?.simDt ?? null : null,
            before,
            after: live instanceof HTMLCanvasElement ? live.fragPose : null,
          });
        });
      }),
  );
  if (dropped.simDt !== 0) errors.push(`hidden tab resume simulated ${dropped.simDt}s`);
  if (!dropped.after || !Number.isFinite(dropped.after.x) || !Number.isFinite(dropped.after.vx)) {
    errors.push(`pose after hide is ${JSON.stringify(dropped.after)}`);
  } else if (dropped.before) {
    const jump = Math.hypot(dropped.after.x - dropped.before.x, dropped.after.z - dropped.before.z);
    if (jump > 0.35) errors.push(`hidden tab moved the player ${jump.toFixed(2)} m`);
  }

  // lastSimDt is one slot. The callback after this wait often runs on the
  // following 16.7 ms frame, so read the clamp the sim keeps until cleared.
  const clamped = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const canvas = document.querySelector("canvas");
        if (canvas instanceof HTMLCanvasElement) canvas.fragStall = 0;
        const start = performance.now();
        while (performance.now() - start < 800) {
          // A stall that is not a tab hide still has to clamp, not drop.
        }
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const live = document.querySelector("canvas");
            resolve(live instanceof HTMLCanvasElement ? live.fragStall ?? null : null);
          }),
        );
      }),
  );
  if (!(clamped === 0.25)) errors.push(`non-hidden stall simulated ${clamped}s, expected 0.25`);
}

async function assertContextLoss(page, errors) {
  // A software-GL frame can occupy the thread for longer than the loss event
  // needs. Stop scheduling another one, then wait out any frame already running.
  const lost = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const canvas = document.querySelector("canvas");
        if (!(canvas instanceof HTMLCanvasElement)) {
          resolve({ error: "canvas missing" });
          return;
        }
        const gl = canvas.getContext("webgl2");
        if (!gl) {
          resolve({ error: "webgl2 missing" });
          return;
        }
        const ext = gl.getExtension("WEBGL_lose_context");
        if (!ext) {
          resolve({ error: "WEBGL_lose_context missing" });
          return;
        }
        let saw = false;
        canvas.addEventListener(
          "webglcontextlost",
          () => {
            saw = true;
          },
          { once: true },
        );
        window.requestAnimationFrame = () => 0;
        ext.loseContext();
        const start = performance.now();
        const check = () => {
          const panel = document.querySelector("#context-lost");
          if (panel instanceof HTMLElement && !panel.hidden) {
            resolve({ ok: true, saw, waited: performance.now() - start });
            return;
          }
          if (performance.now() - start > 15_000) {
            resolve({ error: `overlay stayed hidden (event ${saw ? "fired" : "did not fire"})` });
            return;
          }
          setTimeout(check, 50);
        };
        setTimeout(check, 0);
      }),
  );
  if (lost.error) {
    errors.push(`context loss did not show a message: ${lost.error}`);
    return;
  }
  console.log(`context loss overlay in ${Math.round(lost.waited)} ms`);
  const text = (await page.locator("#context-lost").innerText()).replace(/\s+/g, " ").trim();
  if (!/graphics|display/i.test(text) || !/reload/i.test(text)) {
    errors.push(`context loss message is not recoverable: ${text}`);
  }
  const reloadVisible = await page.locator("#context-lost-reload").isVisible();
  if (!reloadVisible) errors.push("context loss overlay has no reload button");
  await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement)) return;
    canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.restoreContext();
  });
  try {
    // Poll on a timer. The loss check replaced requestAnimationFrame, so an
    // rAF poll would never run.
    await page.waitForFunction(
      () => {
        const panel = document.querySelector("#context-lost");
        return panel instanceof HTMLElement && panel.hidden;
      },
      undefined,
      { timeout: 10_000, polling: 50 },
    );
  } catch {
    const reloadVisible = await page.locator("#context-lost-reload").isVisible();
    if (!reloadVisible) errors.push("context restore did not recover or offer a reload");
  }
}

async function readRendererMemory(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!(canvas instanceof HTMLCanvasElement) || canvas.fragStats == null) return { error: "fragStats missing" };
    const memory = performance.memory;
    return {
      geometries: canvas.fragStats.geometries,
      textures: canvas.fragStats.textures,
      calls: canvas.fragStats.calls,
      triangles: canvas.fragStats.triangles,
      heap: memory && Number.isFinite(memory.usedJSHeapSize) ? memory.usedJSHeapSize : null,
    };
  });
}

async function assertLongRun(page, errors) {
  const samples = [];
  const first = await readRendererMemory(page);
  if (first.error) {
    errors.push(first.error);
    return;
  }
  samples.push(first);
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    samples.push(await readRendererMemory(page));
  }
  console.log(`long-run renderer.info and heap: ${JSON.stringify(samples)}`);
  const warm = samples[1];
  const end = samples[samples.length - 1];
  if (warm.error || end.error) {
    errors.push(warm.error || end.error);
    return;
  }
  if (!(warm.geometries > 0) || !(warm.textures > 0)) {
    errors.push(`renderer memory did not allocate (geometries ${warm.geometries}, textures ${warm.textures})`);
  }
  // The first sample is before every pooled mesh has been drawn once.
  // WebGLRenderer counts a geometry when it is uploaded, so the warm sample
  // is the one that must stay flat.
  for (const sample of samples.slice(1)) {
    if (sample.geometries !== warm.geometries || sample.textures !== warm.textures) {
      errors.push(
        `renderer memory grew after warm-up geometries ${warm.geometries}->${sample.geometries} textures ${warm.textures}->${sample.textures}`,
      );
      break;
    }
  }
}

async function assertReadableType(page, errors, label) {
  const fonts = await page.evaluate(() => {
    const px = (el) => (el instanceof HTMLElement ? Number.parseFloat(getComputedStyle(el).fontSize) : null);
    const ink = (el, style) => {
      const probe = document.createElement("canvas").getContext("2d");
      if (!probe) return null;
      probe.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return probe.measureText(el.textContent ?? "").actualBoundingBoxAscent;
    };
    const labels = [
      ...document.querySelectorAll(
        "#hud-hp-stat .hud-label, #hud-armor-stat .hud-label, #hud-ammo-stat .hud-label, #hud-wave",
      ),
    ].map((el) => {
      const style = getComputedStyle(el);
      const stat = el.parentElement instanceof HTMLElement ? getComputedStyle(el.parentElement) : null;
      const backing = el.id === "hud-wave" ? style.backgroundColor : (stat?.backgroundColor ?? "");
      return {
        text: el.textContent,
        stat: el.id !== "hud-wave",
        size: px(el),
        rendered: ink(el, style),
        box: el.getBoundingClientRect().height,
        color: style.color,
        backing,
      };
    });
    return {
      copy: px(document.querySelector(".copy")),
      labels,
      height: window.innerHeight,
      width: window.innerWidth,
    };
  });
  if (!(fonts.copy >= 16)) errors.push(`${label}: body text is ${fonts.copy}px at ${fonts.height}px tall`);
  if (fonts.labels.length < 4) {
    errors.push(`${label}: expected HP, ARMOR, AMMO, and WAVE, found ${fonts.labels.length}`);
  }
  for (const hudLabel of fonts.labels) {
    if (!(hudLabel.size >= 12)) {
      errors.push(`${label}: ${hudLabel.text} computed ${hudLabel.size}px at ${fonts.height}px tall`);
    }
    if (hudLabel.stat && !(hudLabel.size >= 24)) {
      errors.push(`${label}: ${hudLabel.text} computed ${hudLabel.size}px, expected a 24px label`);
    }
    if (!(hudLabel.rendered >= 12)) {
      errors.push(`${label}: ${hudLabel.text} rendered ink ${hudLabel.rendered}px (computed ${hudLabel.size}px)`);
    }
    if (hudLabel.box > 0 && !(hudLabel.box >= 12)) {
      errors.push(`${label}: ${hudLabel.text} box ${hudLabel.box}px`);
    }
    console.log(
      `hud ${label} ${hudLabel.text}: computed ${hudLabel.size}px, rendered ${Number(hudLabel.rendered).toFixed(2)}px, box ${hudLabel.box.toFixed(2)}px, contrast pending at ${fonts.width}x${fonts.height}`,
    );
    const ratio = contrastRatio(hudLabel.color, hudLabel.backing);
    if (!(ratio >= 4.5)) {
      errors.push(
        `${label}: ${hudLabel.text} contrast ${ratio ?? "unreadable"} (${hudLabel.color} on ${hudLabel.backing})`,
      );
    } else {
      console.log(`hud ${label} ${hudLabel.text} contrast ${ratio.toFixed(2)}`);
    }
  }
}

async function assertLabelGlyphs(page, errors) {
  const measured = await page.evaluate(() => {
    const box = (selector) => {
      const el = document.querySelector(selector);
      if (!(el instanceof HTMLElement) || el.firstChild === null) return null;
      const range = document.createRange();
      range.selectNodeContents(el);
      const rect = range.getBoundingClientRect();
      return {
        text: el.textContent ?? "",
        height: rect.height,
        css: Number.parseFloat(getComputedStyle(el).fontSize),
      };
    };
    return {
      hp: box("#hud-hp-stat .hud-label"),
      armor: box("#hud-armor-stat .hud-label"),
      ammo: box("#hud-ammo-stat .hud-label"),
      hpValue: box("#hud-hp"),
      armorValue: box("#hud-armor"),
      ammoValue: box("#hud-ammo"),
      width: window.innerWidth,
      height: window.innerHeight,
    };
  });
  console.log(
    `label glyphs at ${measured.width}x${measured.height}: HP ${measured.hp?.height ?? "missing"}px (css ${measured.hp?.css ?? "?"}px) vs number ${measured.hpValue?.height ?? "?"}px, ARMOR ${measured.armor?.height ?? "missing"}px (css ${measured.armor?.css ?? "?"}px) vs number ${measured.armorValue?.height ?? "?"}px, AMMO ${measured.ammo?.height ?? "missing"}px (css ${measured.ammo?.css ?? "?"}px) vs number ${measured.ammoValue?.height ?? "?"}px`,
  );
  if (measured.width !== 1280 || measured.height !== 800) {
    errors.push(`label glyphs measured at ${measured.width}x${measured.height}, expected 1280x800`);
  }
  for (const label of [measured.hp, measured.armor, measured.ammo]) {
    if (!label || !(label.height >= 12)) {
      errors.push(`label ${label?.text ?? "missing"} text box is ${label?.height ?? "missing"}px`);
    }
    if (!label || !(label.css >= 24)) {
      errors.push(`label ${label?.text ?? "missing"} css size is ${label?.css ?? "missing"}px`);
    }
  }
  if (!measured.hp || !measured.hpValue || !(measured.hp.height >= measured.hpValue.height * 0.5)) {
    errors.push(
      `HP label ${measured.hp?.height ?? "?"}px is under half of the number ${measured.hpValue?.height ?? "?"}px`,
    );
  }
  if (!measured.armor || !measured.armorValue || !(measured.armor.height >= measured.armorValue.height * 0.5)) {
    errors.push(
      `ARMOR label ${measured.armor?.height ?? "?"}px is under half of the number ${measured.armorValue?.height ?? "?"}px`,
    );
  }
  if (!measured.ammo || !measured.ammoValue || !(measured.ammo.height >= measured.ammoValue.height * 0.5)) {
    errors.push(
      `AMMO label ${measured.ammo?.height ?? "?"}px is under half of the number ${measured.ammoValue?.height ?? "?"}px`,
    );
  }
}

async function assertHudLayout(page, errors, label) {
  const layout = await page.evaluate(() => {
    const stat = (id) => {
      const el = document.querySelector(id);
      if (!(el instanceof HTMLElement)) return null;
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const labelEl = el.querySelector(".hud-label");
      const labelStyle = labelEl instanceof HTMLElement ? getComputedStyle(labelEl) : null;
      return {
        text: el.querySelector(".hud-value")?.textContent ?? "",
        visibility: style.visibility,
        display: style.display,
        labelSize: labelStyle ? Number.parseFloat(labelStyle.fontSize) : 0,
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      };
    };
    const overlaps = (a, b) =>
      a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const hp = stat("#hud-hp-stat");
    const armor = stat("#hud-armor-stat");
    const ammo = stat("#hud-ammo-stat");
    return {
      mode: document.querySelector("#hud")?.getAttribute("data-mode") ?? "",
      hp,
      armor,
      ammo,
      overlap: hp && armor && ammo ? overlaps(hp, armor) || overlaps(armor, ammo) || overlaps(hp, ammo) : true,
      between: hp && armor && ammo ? armor.left >= hp.right - 1 && armor.right <= ammo.left + 1 : false,
    };
  });
  if (!layout.armor || !layout.hp || !layout.ammo) {
    errors.push(`${label}: hud stats missing`);
    return;
  }
  if (!(layout.armor.width > 0) || !(layout.armor.height > 0) || layout.overlap || !layout.between) {
    errors.push(`${label}: armor readout overlaps HP or AMMO`);
  }
  if (layout.mode !== "play") return;
  if (layout.armor.visibility !== "visible" || layout.armor.display === "none") {
    errors.push(`${label}: armor readout is hidden (${layout.armor.visibility})`);
  }
  if (!(layout.armor.labelSize >= 24)) {
    errors.push(`${label}: ARMOR label is ${layout.armor.labelSize}px`);
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
  const refilled = (previous) =>
    page.waitForFunction(
      (prior) => {
        const text = document.querySelector("#hud-ammo")?.textContent ?? "";
        return text.startsWith("40+") && text !== prior;
      },
      previous,
      { timeout: 15_000, polling: 50 },
    );
  try {
    await refilled(mid);
  } catch (error) {
    // A lost pointer lock pauses the sim, so the first R never starts the reload.
    await page.keyboard.press("KeyR");
    try {
      await refilled(mid);
    } catch (retryError) {
      const message = retryError instanceof Error ? retryError.message.split("\n")[0] : String(retryError);
      const snap = await page.evaluate(() => ({
        text: document.querySelector("#hud-ammo")?.textContent ?? "",
        phase: document.querySelector("#app-shell")?.getAttribute("data-phase") ?? "",
        hp: document.querySelector("#hud-hp")?.textContent ?? "",
        mode: document.querySelector("#hud")?.getAttribute("data-mode") ?? "",
      }));
      errors.push(
        `reload did not refill the magazine (now ${snap.text}, hp ${snap.hp}, hud ${snap.mode}, phase ${snap.phase}): ${message}`,
      );
    }
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
  await assertWarningCopy(page, errors, "shell");
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
    const marker = document.querySelector("#hitmarker");
    const arcNodes = document.querySelectorAll("#damage-arcs .damage-arc");
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
      !(marker instanceof HTMLElement) ||
      arcNodes.length !== 3 ||
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
      armorVisibility: getComputedStyle(armorStat).visibility,
      armorShown: shown(armorStat) && shown(armor),
      armorLabelSize: Number.parseFloat(getComputedStyle(armorStat.querySelector(".hud-label")).fontSize),
      armorWidth: armorBox.width,
      armorHeight: armorBox.height,
      armorBetween: armorBox.left >= hpBox.right - 1 && armorBox.right <= ammoBox.left + 1,
      hpShown: shown(hp),
      ammoShown: shown(ammo),
      crossDx: Math.abs(box.left + box.width / 2 - window.innerWidth / 2),
      crossDy: Math.abs(box.top + box.height / 2 - window.innerHeight / 2),
      crossShown: shown(crosshair),
      markerKind: marker.getAttribute("data-kind"),
      markerHidden: marker.hidden,
      arcCount: arcNodes.length,
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
    if (readout.armorText !== "0" || !readout.armorShown || readout.armorVisibility !== "visible") {
      errors.push(`armor readout is ${readout.armorText} (${readout.armorVisibility})`);
    }
    if (!(readout.armorLabelSize >= 24)) errors.push(`armor label is ${readout.armorLabelSize}px`);
    if (readout.armorWidth <= 0 || readout.armorHeight <= 0 || !readout.armorBetween) {
      errors.push("armor slot is missing from the hud layout");
    }
    if (!readout.crossShown) errors.push("crosshair hidden during play");
    if (readout.markerKind !== "none" || readout.markerHidden !== true || readout.arcCount !== 3) {
      errors.push(
        `hit feedback markup marker ${readout.markerKind} hidden ${readout.markerHidden} arcs ${readout.arcCount}`,
      );
    }
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

  // Fire and reload while spawn grace still holds. The weapon sim stops at
  // 0 HP, and the shell stays in "playing", so a later R cannot refill a
  // magazine the fight has already frozen.
  await assertQuillFire(page, errors);

  const recapHit = await page.evaluate(() => {
    const death = document.querySelector("#death-recap");
    const style = death instanceof HTMLElement ? getComputedStyle(death) : null;
    const points = [
      [window.innerWidth / 2, window.innerHeight / 2],
      [1, 1],
      [window.innerWidth - 2, 2],
      [2, window.innerHeight - 2],
      [window.innerWidth - 2, window.innerHeight - 2],
    ];
    return {
      display: style?.display ?? "",
      pointerEvents: style?.pointerEvents ?? "",
      hidden: death instanceof HTMLElement ? death.hidden : null,
      aria: death?.getAttribute("aria-hidden") ?? "",
      inert: death instanceof HTMLElement ? death.inert : null,
      hits: points.map(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return {
          id: el?.id ?? "",
          tag: el?.tagName ?? "",
          recap: el === death || (death instanceof HTMLElement && death.contains(el)),
        };
      }),
    };
  });
  if (recapHit.display !== "none" || recapHit.hidden !== true || recapHit.inert !== true) {
    errors.push(`recap stays in play (${JSON.stringify(recapHit)})`);
  }
  if (recapHit.pointerEvents !== "none" || recapHit.aria !== "true") {
    errors.push(`recap can take play input (${recapHit.pointerEvents}, aria ${recapHit.aria})`);
  }
  for (const hit of recapHit.hits) {
    if (hit.recap || hit.id === "death-recap") {
      errors.push(`recap is the hit target at play (${hit.tag}#${hit.id})`);
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
          const moved = startZ - Number(match[3]) > 1;
          // Release in this turn. The well ammo pad is a few meters north, and
          // a 200 ms frame would otherwise keep W down until the runner
          // notices and walk the body onto that pad before the fire check.
          if (moved) {
            window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW", bubbles: true }));
          }
          return moved;
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

  await page.keyboard.press("KeyM");
  const muted = await page.locator("#hud-mute").evaluate((el) => ({
    hidden: el.hidden,
    text: (el.textContent ?? "").trim(),
  }));
  if (muted.hidden || muted.text !== "MUTE") {
    errors.push(`M did not show the mute indicator (${JSON.stringify(muted)})`);
  }
  await page.keyboard.press("KeyM");
  if (!(await page.locator("#hud-mute").evaluate((el) => el.hidden))) {
    errors.push("M did not clear the mute indicator");
  }
  try {
    await page.waitForFunction(
      () => {
        const hp = Number(document.querySelector("#hud-hp")?.textContent ?? "");
        const dead = document.querySelector("#hud")?.getAttribute("data-mode") === "dead";
        return dead || (Number.isFinite(hp) && hp < 100);
      },
      undefined,
      { timeout: 12_000, polling: 100 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    const hp = await page.locator("#hud-hp").innerText();
    errors.push(`play did not take damage (hp ${hp.trim()}): ${message}`);
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

  await page.locator("#pause-resume").click();
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
  if (process.env.FRAG_SLOW_FRAMES === "1") await installSlowFrames(page);
  try {
    noteConsole(page, errors, "dev");
    page.on("request", (request) => {
      const url = request.url();
      if (url.startsWith(`${devOrigin}/`) || url === devOrigin || url.startsWith("data:")) return;
      errors.push(`dev unexpected network request: ${url}`);
    });
    await waitForPort(20_000, devPort, devOrigin);
    await page.goto(`${devOrigin}/`, { waitUntil: "load", timeout: 30_000 });
    try {
      // The first dev request compiles three.js. A cold runner needs longer than the static preview.
      await page.waitForSelector("canvas", { timeout: 45_000 });
    } catch (error) {
      const snap = await page
        .evaluate(() => ({
          ready: document.readyState,
          text: (document.body?.innerText ?? "").slice(0, 300),
        }))
        .catch(() => ({ ready: "unavailable", text: "" }));
      errors.push(`dev canvas missing (${JSON.stringify(snap)})`);
      throw error;
    }
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

    const raced = await page.evaluate(() => {
      window.__fragDamage(500);
      const death = document.querySelector("#death-recap");
      const before = death?.textContent ?? "";
      const shown = death instanceof HTMLElement && death.hidden === false;
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", bubbles: true, cancelable: true }));
      window.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      return {
        shown,
        hp: document.querySelector("#hud-hp")?.textContent ?? "",
        phase: document.querySelector("#app-shell")?.getAttribute("data-phase") ?? "",
        text: document.querySelector("#death-recap")?.textContent ?? "",
        before,
        count: document.querySelectorAll("#death-recap").length,
        warningHidden: document.querySelector("#content-warning")?.hidden ?? false,
      };
    });
    if (!raced.shown) errors.push("death during pause did not show the recap before the blur");
    if (raced.hp !== "0") errors.push(`death during pause/blur restarted (hp ${raced.hp})`);
    if (raced.phase !== "paused") errors.push(`death during pause left phase ${raced.phase}`);
    if (raced.count !== 1) errors.push(`death recap elements ${raced.count}`);
    if (raced.text !== raced.before) errors.push("death during pause rewrote the recap");
    if (!raced.warningHidden) errors.push("warning returned when dying during pause");
    if (raced.phase === "paused") await page.locator("#pause-resume").click();
    const resumedDead = await page.evaluate(() => {
      const death = document.querySelector("#death-recap");
      return {
        hp: document.querySelector("#hud-hp")?.textContent ?? "",
        mode: document.querySelector("#hud")?.getAttribute("data-mode") ?? "",
        hidden: death instanceof HTMLElement ? death.hidden : true,
        count: document.querySelectorAll("#death-recap").length,
        warningHidden: document.querySelector("#content-warning")?.hidden ?? false,
      };
    });
    if (resumedDead.hp !== "0" || resumedDead.mode !== "dead" || resumedDead.hidden || resumedDead.count !== 1) {
      errors.push(`resume after a paused death did not keep one recap (${JSON.stringify(resumedDead)})`);
    }
    if (!resumedDead.warningHidden) errors.push("warning returned when resuming a paused death");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await page.locator("#death-recap").click({ force: true });
    const afterRace = await page.evaluate(() => ({
      hp: document.querySelector("#hud-hp")?.textContent ?? "",
      armor: document.querySelector("#hud-armor")?.textContent ?? "",
      warningHidden: document.querySelector("#content-warning")?.hidden ?? false,
      phase: document.querySelector("#app-shell")?.getAttribute("data-phase") ?? "",
    }));
    if (afterRace.hp !== "100") errors.push(`restart after a paused death hp is ${afterRace.hp}`);
    if (afterRace.armor !== "0") errors.push(`restart after a paused death armor is ${afterRace.armor}`);
    if (!afterRace.warningHidden || afterRace.phase === "warning") {
      errors.push(`warning returned after restart from a paused death (${afterRace.phase})`);
    }
    if (afterRace.phase === "paused") await page.locator("#pause-resume").click();
    try {
      await page.waitForFunction(() => document.pointerLockElement != null, undefined, {
        timeout: 4_000,
        polling: 50,
      });
    } catch {
      await page.locator("canvas").click({ force: true });
    }

    const pitched = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      return canvas instanceof HTMLCanvasElement ? { yaw: canvas.fragView?.yaw, pitch: canvas.fragView?.pitch } : null;
    });
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 640,
      y: 400,
      movementX: 80,
      movementY: -400,
    });
    await session.detach();
    let looked = null;
    try {
      await page.waitForFunction(
        () => {
          const canvas = document.querySelector("canvas");
          if (!(canvas instanceof HTMLCanvasElement) || canvas.fragView == null) return false;
          return Math.abs(canvas.fragView.pitch) > 15 || Math.abs(canvas.fragView.yaw) > 5;
        },
        undefined,
        { timeout: 3_000, polling: 50 },
      );
      looked = await page.evaluate(() => {
        const canvas = document.querySelector("canvas");
        return canvas instanceof HTMLCanvasElement
          ? { yaw: canvas.fragView?.yaw ?? null, pitch: canvas.fragView?.pitch ?? null }
          : null;
      });
    } catch {
      looked = await page.evaluate(() => {
        const canvas = document.querySelector("canvas");
        return canvas instanceof HTMLCanvasElement
          ? { yaw: canvas.fragView?.yaw ?? null, pitch: canvas.fragView?.pitch ?? null }
          : null;
      });
    }
    console.log(`restart facing before death: spawn ${JSON.stringify(pitched)} looked ${JSON.stringify(looked)}`);
    if (!looked || !(Math.abs(looked.pitch ?? 0) > 15 || Math.abs(looked.yaw ?? 0) > 5)) {
      errors.push(`mouse did not leave spawn facing before restart (${JSON.stringify(looked)})`);
    }

    const granted = await page.evaluate(() => {
      const player = window.__fragPlayer;
      if (!player || typeof player.set !== "function") return { error: "player debug missing" };
      player.set({ armor: 25 });
      const stat = document.querySelector("#hud-armor-stat");
      const value = document.querySelector("#hud-armor");
      const style = stat instanceof HTMLElement ? getComputedStyle(stat) : null;
      return {
        text: value?.textContent ?? "",
        visibility: style?.visibility ?? "",
      };
    });
    if (granted.error) errors.push(granted.error);
    else if (granted.text !== "25" || granted.visibility !== "visible") {
      errors.push(`dev armor grant readout is ${granted.text} (${granted.visibility})`);
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

    const held = await page.evaluate(() => {
      window.__fragPlayer.set({ armor: 40 });
      return document.querySelector("#hud-armor")?.textContent ?? "";
    });
    if (held !== "40") errors.push(`dev armor readout did not track a grant (${held})`);

    await page.keyboard.press("Enter");
    const earlyRestart = await page.evaluate(() => document.querySelector("#hud-hp")?.textContent ?? "");
    if (earlyRestart !== "0") errors.push(`enter during the recap lockout restarted (hp ${earlyRestart})`);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await page.keyboard.press("Enter");
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
        enforcerAlive: run?.enforcerAlive,
        frags: run?.frags,
        wavesCleared: run?.wavesCleared,
        phaseRun: run?.phase,
        stored: Object.keys(localStorage),
        yaw: canvas instanceof HTMLCanvasElement ? canvas.fragView?.yaw : null,
        pitch: canvas instanceof HTMLCanvasElement ? canvas.fragView?.pitch : null,
        vx: canvas instanceof HTMLCanvasElement ? canvas.fragPose?.vx : null,
        vz: canvas instanceof HTMLCanvasElement ? canvas.fragPose?.vz : null,
      };
    });
    if (restarted.hp !== "100") errors.push(`dev restart hp is ${restarted.hp}`);
    if (restarted.ammo !== "40+40") errors.push(`dev restart ammo is ${restarted.ammo}`);
    if (restarted.armor !== "0") errors.push(`dev restart armor is ${restarted.armor}`);
    if (!restarted.warningHidden || restarted.phase === "warning") {
      errors.push(`dev warning returned on restart (${restarted.phase})`);
    }
    if (
      restarted.wave !== 1 ||
      restarted.count !== 2 ||
      restarted.enforcerAlive !== 0 ||
      restarted.phaseRun !== "fighting"
    ) {
      errors.push(
        `dev restart wave is ${restarted.wave} count ${restarted.count} enforcers ${restarted.enforcerAlive} phase ${restarted.phaseRun}`,
      );
    }
    if (restarted.frags !== 0 || restarted.wavesCleared !== 0) {
      errors.push(`dev restart counters frags ${restarted.frags} waves ${restarted.wavesCleared}`);
    }
    if (restarted.stored.length > 0) {
      errors.push(`dev localStorage was written: ${restarted.stored.join(", ")}`);
    }
    if (!(Math.abs(restarted.yaw ?? 99) < 1) || !(Math.abs(restarted.pitch ?? 99) < 1)) {
      errors.push(`restart kept the old facing yaw ${restarted.yaw} pitch ${restarted.pitch}`);
    }
    if (restarted.vx !== 0 || restarted.vz !== 0) {
      errors.push(`restart kept velocity ${restarted.vx}, ${restarted.vz}`);
    }

    if (restarted.phase === "paused") await page.locator("#pause-resume").click();
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
          if (
            !(
              snap.wave >= 3 &&
              snap.count === 4 &&
              snap.enforcerAlive === 2 &&
              snap.bolts > 0 &&
              stats &&
              stats.calls > 0
            )
          ) {
            return false;
          }
          return {
            calls: stats.calls,
            triangles: stats.triangles,
            lines: stats.lines,
            points: stats.points,
            geometries: stats.geometries,
            textures: stats.textures,
            wave: snap.wave,
            count: snap.count,
            enforcerAlive: snap.enforcerAlive,
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
      errors.push(`dev wave 3 did not field 4 drones and 2 enforcers (${JSON.stringify(snap)}): ${message}`);
    }
    if (report) {
      console.log(
        `renderer.info at wave ${report.wave} with ${report.count} drones and ${report.enforcerAlive} enforcers firing: calls ${report.calls}, triangles ${report.triangles}, lines ${report.lines}, points ${report.points}, geometries ${report.geometries}, textures ${report.textures}, live bolts ${report.bolts}`,
      );
      if (!(report.calls > 0 && report.calls <= 80)) {
        errors.push(`wave 3 draw calls ${report.calls} outside 1..80`);
      }
      if (!(report.triangles > 0 && report.triangles <= 50_000)) {
        errors.push(`wave 3 triangles ${report.triangles} outside 1..50000`);
      }
      if (report.enforcerAlive !== 2 || report.count !== 4) {
        errors.push(`wave 3 roster drones ${report.count} enforcers ${report.enforcerAlive}`);
      }
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

function installFireProbe(page) {
  return page.addInitScript(() => {
    const names = [];
    const details = [];
    const orig = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (type === "mousedown" || type === "mouseup") {
        const id = this === window ? "window" : this === document ? "document" : this.id || this.tagName || "node";
        const role = typeof listener.fragRole === "string" ? listener.fragRole : "";
        const label = role || listener.name || "anon";
        const src = typeof listener === "function" ? Function.prototype.toString.call(listener).replace(/\s+/g, " ").slice(0, 160) : "";
        names.push(`${id}:${type}:${label}`);
        details.push({ id, type, label, role, src });
      }
      return orig.call(this, type, listener, options);
    };
    window.__fireListenerNames = names;
    window.__fireListenerDetails = details;
    // Every waiting callback runs when the 200 ms gate opens. Letting only the
    // first one through starves the page's other animation-frame waits.
    const native = window.requestAnimationFrame.bind(window);
    let last = 0;
    let scheduled = false;
    const queue = [];
    function pump(time) {
      scheduled = false;
      if (last !== 0 && time - last < 200) {
        scheduled = true;
        native(pump);
        return;
      }
      last = time;
      const batch = queue.splice(0, queue.length);
      for (let i = 0; i < batch.length; i += 1) batch[i](time);
    }
    window.requestAnimationFrame = (callback) => {
      queue.push(callback);
      if (!scheduled) {
        scheduled = true;
        native(pump);
      }
      return 0;
    };
  });
}

async function readFire(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const sim = canvas instanceof HTMLCanvasElement ? canvas.fragSim : null;
    const names = window.__fireListenerNames ?? [];
    return {
      ammo: document.querySelector("#hud-ammo")?.textContent ?? "",
      sim: sim?.sim ?? null,
      shots: sim?.shots ?? null,
      firstShot: sim?.firstShot ?? null,
      lastShot: sim?.lastShot ?? null,
      frames: sim?.frames ?? null,
      wall: performance.now(),
      mouseDown: names.filter((name) => name.startsWith("window:mousedown:")).length,
      mouseDownNames: names.filter((name) => name.startsWith("window:mousedown:")),
      mouseDownDetails: (window.__fireListenerDetails ?? []).filter((row) => row.id === "window" && row.type === "mousedown"),
    };
  });
}

function installSlowFrames(page) {
  return page.addInitScript(() => {
    const native = window.requestAnimationFrame.bind(window);
    let last = 0;
    let scheduled = false;
    const queue = [];
    function pump(time) {
      scheduled = false;
      if (last !== 0 && time - last < 200) {
        scheduled = true;
        native(pump);
        return;
      }
      last = time;
      const batch = queue.splice(0, queue.length);
      for (let i = 0; i < batch.length; i += 1) batch[i](time);
    }
    window.requestAnimationFrame = (callback) => {
      queue.push(callback);
      if (!scheduled) {
        scheduled = true;
        native(pump);
      }
      return 0;
    };
  });
}

async function readFight(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const drones = canvas instanceof HTMLCanvasElement ? canvas.fragDrones : null;
    return {
      hp: document.querySelector("#hud-hp")?.textContent ?? "",
      time: drones?.time ?? null,
      fired: drones?.fired ?? null,
      hits: drones?.hits ?? null,
      damageEvents: drones?.damageEvents ?? null,
      firstBolt: drones?.firstBolt ?? null,
      live: drones?.bolts ?? null,
      enforcerShots: drones?.enforcerShots ?? null,
      enforcerHits: drones?.enforcerHits ?? null,
      enforcerFirstShot: drones?.enforcerFirstShot ?? null,
      enforcerUnits: drones?.enforcerUnits ?? null,
      phase: document.querySelector("#app-shell")?.getAttribute("data-phase") ?? "",
    };
  });
}

async function readPauseProbe(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    const drones = canvas instanceof HTMLCanvasElement ? canvas.fragDrones : null;
    const sim = canvas instanceof HTMLCanvasElement ? canvas.fragSim : null;
    const pause = document.querySelector("#pause");
    const title = document.querySelector("#pause-title");
    const copy = document.querySelector("#pause .copy");
    const panel = document.querySelector("#pause .panel");
    const px = (el) => (el instanceof HTMLElement ? Number.parseFloat(getComputedStyle(el).fontSize) : null);
    const style = (el) => (el instanceof HTMLElement ? getComputedStyle(el) : null);
    const labels = [...document.querySelectorAll("#pause-settings .setting-label, #pause-settings .setting-value")].map(
      (el) => {
        const computed = getComputedStyle(el);
        return {
          text: (el.textContent ?? "").trim(),
          px: Number.parseFloat(computed.fontSize),
          color: computed.color,
        };
      },
    );
    return {
      hp: document.querySelector("#hud-hp")?.textContent ?? "",
      time: drones?.time ?? null,
      sim: sim?.sim ?? null,
      phase: document.querySelector("#app-shell")?.getAttribute("data-phase") ?? "",
      hidden: pause instanceof HTMLElement ? pause.hidden : null,
      display: pause instanceof HTMLElement ? getComputedStyle(pause).display : "",
      text: pause instanceof HTMLElement ? (pause.textContent ?? "") : "",
      titlePx: px(title),
      copyPx: px(copy),
      titleColor: style(title)?.color ?? "",
      copyColor: style(copy)?.color ?? "",
      panel: style(panel)?.backgroundColor ?? "",
      labels,
      locked: document.pointerLockElement != null,
    };
  });
}

function assertPauseReadable(probe, errors, label) {
  if (probe.hidden !== false || probe.display === "none") {
    errors.push(`${label}: pause overlay is hidden (${probe.hidden}, ${probe.display})`);
  }
  const text = probe.text.replace(/\s+/g, " ");
  if (!text.includes("Paused") || !text.includes("Press Enter or Resume")) {
    errors.push(`${label}: pause copy is ${JSON.stringify(probe.text)}`);
  }
  if (!Array.isArray(probe.labels) || probe.labels.length < 6) {
    errors.push(`${label}: pause settings labels missing`);
  } else {
    for (const row of probe.labels) {
      if (!(row.px >= 12)) errors.push(`${label}: ${row.text} is ${row.px}px`);
      const ratio = contrastRatio(row.color, probe.panel);
      if (!(ratio >= 4.5)) {
        errors.push(`${label}: ${row.text} contrast ${ratio} (${row.color} on ${probe.panel})`);
      }
    }
  }
  if (!(probe.titlePx >= 16)) errors.push(`${label}: pause title is ${probe.titlePx}px`);
  if (!(probe.copyPx >= 16)) errors.push(`${label}: pause body is ${probe.copyPx}px`);
  const titleContrast = contrastRatio(probe.titleColor, probe.panel);
  const copyContrast = contrastRatio(probe.copyColor, probe.panel);
  if (!(titleContrast >= 4.5)) {
    errors.push(`${label}: pause title contrast ${titleContrast} (${probe.titleColor} on ${probe.panel})`);
  }
  if (!(copyContrast >= 4.5)) {
    errors.push(`${label}: pause body contrast ${copyContrast} (${probe.copyColor} on ${probe.panel})`);
  }
}

async function assertSimHeld(page, errors, label) {
  const before = await readPauseProbe(page);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const after = await readPauseProbe(page);
  if (before.time == null || after.time == null || before.sim == null || after.sim == null) {
    errors.push(`${label}: sim probe missing (${JSON.stringify(before)})`);
    return before;
  }
  if (after.time !== before.time || after.sim !== before.sim || after.hp !== before.hp) {
    errors.push(
      `${label}: sim advanced while paused (hp ${before.hp}->${after.hp}, drones ${before.time}->${after.time}, sim ${before.sim}->${after.sim})`,
    );
  }
  return after;
}

async function assertSimAdvances(page, errors, label) {
  const before = await readPauseProbe(page);
  try {
    await page.waitForFunction(
      (start) => {
        const canvas = document.querySelector("canvas");
        if (!(canvas instanceof HTMLCanvasElement)) return false;
        const drones = canvas.fragDrones;
        const sim = canvas.fragSim;
        if (!drones || !sim) return false;
        return drones.time > start.time && sim.sim > start.sim;
      },
      { time: before.time, sim: before.sim },
      { timeout: 8_000, polling: 50 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    const after = await readPauseProbe(page);
    errors.push(`${label}: sim did not advance (${JSON.stringify(before)} -> ${JSON.stringify(after)}): ${message}`);
  }
}

async function assertPauseResume(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  noteConsole(page, errors, "pause resume");
  try {
    await page.goto(`${origin}/`, { waitUntil: "load", timeout: 20_000 });
    await page.waitForSelector("canvas", { timeout: 30_000 });
    await page.locator("#content-warning-continue").click();
    await page.locator("#click-to-play").click();
    await page.waitForFunction(
      () => document.querySelector("#app-shell")?.getAttribute("data-phase") === "playing",
      undefined,
      { timeout: 8_000, polling: 50 },
    );

    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => {
        const pause = document.querySelector("#pause");
        return (
          pause instanceof HTMLElement &&
          !pause.hidden &&
          document.querySelector("#app-shell")?.getAttribute("data-phase") === "paused"
        );
      },
      undefined,
      { timeout: 3_000, polling: 50 },
    );
    assertPauseReadable(await readPauseProbe(page), errors, "escape");
    await assertSimHeld(page, errors, "escape");

    const slider = await page.locator("#setting-sensitivity").boundingBox();
    if (!slider) errors.push("sensitivity slider has no box");
    else {
      await page.mouse.move(slider.x + 6, slider.y + slider.height / 2);
      await page.mouse.down();
      await page.mouse.move(slider.x + slider.width - 6, slider.y + slider.height / 2, { steps: 5 });
      await page.mouse.up();
    }
    await page.locator("#setting-invert-y").click();
    const afterControls = await page.evaluate(() => ({
      phase: document.querySelector("#app-shell")?.getAttribute("data-phase") ?? "",
      hidden: document.querySelector("#pause") instanceof HTMLElement ? document.querySelector("#pause").hidden : null,
      locked: document.pointerLockElement != null,
    }));
    if (afterControls.phase !== "paused" || afterControls.hidden !== false || afterControls.locked) {
      errors.push(`settings controls left pause (${JSON.stringify(afterControls)})`);
    }

    await page.locator("#pause-resume").click();
    await page.waitForFunction(
      () => {
        const pause = document.querySelector("#pause");
        return (
          pause instanceof HTMLElement &&
          pause.hidden &&
          document.querySelector("#app-shell")?.getAttribute("data-phase") === "playing"
        );
      },
      undefined,
      { timeout: 3_000, polling: 50 },
    );
    await assertSimAdvances(page, errors, "click resume");

    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => {
        const pause = document.querySelector("#pause");
        return pause instanceof HTMLElement && !pause.hidden;
      },
      undefined,
      { timeout: 3_000, polling: 50 },
    );
    assertPauseReadable(await readPauseProbe(page), errors, "escape before enter");
    await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      if (!(canvas instanceof HTMLCanvasElement)) return;
      canvas.requestPointerLock = () => Promise.reject(new DOMException("cooldown", "SecurityError"));
    });
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => {
        const pause = document.querySelector("#pause");
        return (
          pause instanceof HTMLElement &&
          pause.hidden &&
          document.querySelector("#app-shell")?.getAttribute("data-phase") === "playing" &&
          document.pointerLockElement == null
        );
      },
      undefined,
      { timeout: 3_000, polling: 50 },
    );
    const resumed = await readPauseProbe(page);
    if (resumed.locked) errors.push("enter resume took the pointer during the cooldown");
    if (resumed.hidden !== true) errors.push("pause overlay still visible after enter");
    await assertSimAdvances(page, errors, "enter resume without pointer lock");
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    errors.push(`pause resume failed: ${message}`);
  } finally {
    await page.evaluate(() => localStorage.removeItem("frag:settings:v1")).catch(() => {});
    await page.close();
  }
}

async function assertStationaryDamage(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  noteConsole(page, errors, "damage probe");
  try {
    await page.addInitScript(() => {
      window.__fragBenchHp = 500;
    });
    await installSlowFrames(page);
    await page.goto(`${origin}/`, { waitUntil: "load", timeout: 20_000 });
    await page.waitForSelector("canvas", { timeout: 10_000 });
    await page.locator("#content-warning-continue").click();
    await page.locator("#click-to-play").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#hud")?.getAttribute("data-mode") === "play" && document.pointerLockElement != null,
      undefined,
      { timeout: 8_000, polling: 50 },
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => document.querySelector("#app-shell")?.getAttribute("data-phase") === "paused",
      undefined,
      { timeout: 3_000 },
    );
    const frozen = await readFight(page);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const held = await readFight(page);
    console.log(`paused drones: ${JSON.stringify(frozen)} -> ${JSON.stringify(held)}`);
    const heldUnits = JSON.stringify(held.enforcerUnits);
    const frozenUnits = JSON.stringify(frozen.enforcerUnits);
    if (
      held.time !== frozen.time ||
      held.fired !== frozen.fired ||
      held.hits !== frozen.hits ||
      held.enforcerShots !== frozen.enforcerShots ||
      heldUnits !== frozenUnits
    ) {
      errors.push(`enemies kept simulating while paused (${JSON.stringify(frozen)} -> ${JSON.stringify(held)})`);
    }
    await page.locator("#pause-resume").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#hud")?.getAttribute("data-mode") === "play" && document.pointerLockElement != null,
      undefined,
      { timeout: 8_000, polling: 50 },
    );
    await page.evaluate(() => {
      window.__graceOk = true;
    });
    const stationaryUntil = WISP_WAVE1_SPAWN_GRACE + 4 * WISP_WAVE1_BURST_GAP;
    try {
      await page.waitForFunction(
        ({ grace, until }) => {
          const canvas = document.querySelector("canvas");
          const drones = canvas instanceof HTMLCanvasElement ? canvas.fragDrones : null;
          if (!drones) return false;
          if (drones.time < grace && (drones.fired !== 0 || drones.enforcerShots !== 0)) window.__graceOk = false;
          return drones.time >= until;
        },
        { grace: WISP_WAVE1_SPAWN_GRACE, until: stationaryUntil },
        { timeout: 40_000, polling: 50 },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      const snap = await readFight(page);
      errors.push(`stationary fight did not reach ${stationaryUntil.toFixed(1)} s sim (${JSON.stringify(snap)}): ${message}`);
      return;
    }
    const report = await readFight(page);
    const graceOk = await page.evaluate(() => window.__graceOk !== false);
    const loss = Number(frozen.hp) - Number(report.hp);
    const cadence = (2 * 2 * WISP_BOLT_DAMAGE) / (WISP_BOLT_GAP + WISP_WAVE1_BURST_GAP);
    const enforcerHits = Number(report.enforcerHits ?? 0);
    console.log(
      `stationary 200 ms frames: hp ${frozen.hp} -> ${report.hp} (${loss} HP), fired ${report.fired}, hits ${report.hits}, damage events ${report.damageEvents}, first bolt ${report.firstBolt}, enforcer shots ${report.enforcerShots}, enforcer hits ${enforcerHits}, first enforcer ${report.enforcerFirstShot}, sim ${report.time}, live bolts ${report.live}, cadence max ${cadence.toFixed(2)} HP/s`,
    );
    if (!graceOk || !(report.firstBolt >= WISP_WAVE1_SPAWN_GRACE)) {
      errors.push(`a drone fired during spawn grace (first ${report.firstBolt}, graceOk ${graceOk})`);
    }
    if (report.enforcerShots !== 0 || report.enforcerFirstShot != null || enforcerHits !== 0) {
      errors.push(
        `wave 1 enforcer fired (shots ${report.enforcerShots}, hits ${enforcerHits}, first ${report.enforcerFirstShot})`,
      );
    }
    if (report.hits !== report.damageEvents) {
      errors.push(`bolts that hit ${report.hits}, damage events ${report.damageEvents}`);
    }
    if (loss !== report.hits * 8) {
      errors.push(`HP loss ${loss} did not match ${report.hits} drone bolts (hp ${report.hp})`);
    }
    const ceiling = cadence * Math.max(Number(report.time) || 0, 0);
    if (!(loss <= ceiling + 1e-6)) {
      errors.push(`HP loss ${loss} exceeded the cadence maximum ${ceiling.toFixed(2)}`);
    }
    const feedback = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      return canvas instanceof HTMLCanvasElement ? canvas.fragFeedback : null;
    });
    if (!feedback) {
      errors.push("fragFeedback missing");
    } else {
      console.log(
        `damage arcs noted ${feedback.damageNoted}, last bearing ${feedback.lastBearing}, hits ${feedback.hitsNoted}`,
      );
      // A bolt that stops on top of the eye has no horizontal bearing, so the
      // arc count can be lower than the hit count. One finite arc is enough
      // to prove the indicator still tracks incoming damage.
      if (report.hits > 0 && !(feedback.damageNoted >= 1)) {
        errors.push(`directional damage noted ${feedback.damageNoted}, bolt hits ${report.hits}`);
      }
      if (
        feedback.damageNoted > 0 &&
        (typeof feedback.lastBearing !== "number" || !Number.isFinite(feedback.lastBearing))
      ) {
        errors.push(`last damage bearing was ${feedback.lastBearing}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    errors.push(`stationary damage probe failed: ${message}`);
  } finally {
    await page.close();
  }
}

async function assertThrottledFire(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  noteConsole(page, errors, "fire probe");
  try {
    await page.addInitScript(() => {
      window.__fragBenchHp = 500;
    });
    await installFireProbe(page);
    await page.goto(`${origin}/`, { waitUntil: "load", timeout: 20_000 });
    await page.waitForSelector("canvas", { timeout: 10_000 });
    await page.locator("#content-warning-continue").click();
    await page.locator("#click-to-play").click();
    await page.waitForFunction(
      () => document.querySelector("#hud")?.getAttribute("data-mode") === "play" && document.pointerLockElement != null,
      undefined,
      { timeout: 8_000, polling: 50 },
    );
    const before = await readFire(page);
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await new Promise((resolve) => setTimeout(resolve, 6000));
    await page.mouse.up();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const after = await readFire(page);
    const wall = (after.wall - before.wall) / 1000;
    const sim = after.sim - before.sim;
    const shots = after.shots - before.shots;
    const ratio = wall > 0 ? sim / wall : 0;
    const start = before.shots > 0 ? before.lastShot : after.firstShot;
    const intervals = before.shots > 0 ? shots : Math.max(0, shots - 1);
    const span = after.lastShot - start;
    const rate = intervals > 0 && Number.isFinite(span) && span > 0 ? intervals / span : null;
    console.log(
      `throttled hold: wall ${wall.toFixed(3)}s sim ${sim.toFixed(3)}s ratio ${ratio.toFixed(3)} (below 1 is the 250 ms stall clamp) shots ${shots} ${rate == null ? "rate n/a" : `${rate.toFixed(3)} shots/sim s`} ammo ${before.ammo} -> ${after.ammo} frames ${after.frames - before.frames}`,
    );
    if (ratio > 1.35) errors.push(`sim time ran ${ratio.toFixed(2)}× wall time during a 5 fps hold`);
    if (shots > 56) errors.push(`5 fps hold fired ${shots} shots in ${wall.toFixed(2)}s wall (ammo ${after.ammo})`);
    if (rate != null && Math.abs(rate - 8) > 0.05) {
      errors.push(`shots per sim second ${rate.toFixed(3)}, expected about 8`);
    }
    if (after.ammo === "0+0") errors.push("5 fps hold emptied 40+40 inside 6 s");
    const fireHandlers = after.mouseDownNames.filter((name) => name.endsWith(":fire"));
    for (const row of after.mouseDownDetails) {
      const kind = row.role === "fire" ? "game fire handler" : "test runner, not a game handler";
      console.log(`throttled listener ${row.label} (${kind}): ${row.src}`);
    }
    if (fireHandlers.length !== 1) {
      errors.push(`game fire mousedown handlers ${fireHandlers.length}: ${after.mouseDownNames.join(", ")}`);
    }
    for (const row of after.mouseDownDetails) {
      if (row.role === "fire") continue;
      if (!row.src.includes("_hitTargetInterceptor")) {
        errors.push(`window mousedown is not the tagged fire handler or the test runner: ${row.label} ${row.src}`);
      }
    }

    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => document.querySelector("#app-shell")?.getAttribute("data-phase") === "paused",
      undefined,
      { timeout: 3_000 },
    );
    await page.locator("#pause-resume").click();
    await page.waitForFunction(() => document.pointerLockElement != null, undefined, {
      timeout: 4_000,
      polling: 50,
    });
    const relocked = await readFire(page);
    if (relocked.mouseDown !== after.mouseDown) {
      errors.push(`fire listeners grew after pointer re-lock (${after.mouseDown} -> ${relocked.mouseDown})`);
    }
    // The hold stops at whatever the slow sim reached (CI left 4+40). The
    // burst has to start from a full magazine, or the later clicks land in
    // the reload and the latch correctly throws them away.
    await page.waitForFunction(
      () => {
        const canvas = document.querySelector("canvas");
        const sim = canvas instanceof HTMLCanvasElement ? canvas.fragSim : null;
        return !!sim && sim.reloading === false;
      },
      undefined,
      { timeout: 15_000, polling: 50 },
    );
    let armed = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      const sim = canvas instanceof HTMLCanvasElement ? canvas.fragSim : null;
      return { mag: sim?.mag ?? null, reserve: sim?.reserve ?? null };
    });
    if (armed.mag !== 40) {
      if (!(armed.reserve > 0)) {
        errors.push(`cannot refill ${armed.mag}+${armed.reserve} before the burst`);
      } else {
        await page.keyboard.press("KeyR");
        await page.waitForFunction(
          () => {
            const canvas = document.querySelector("canvas");
            const sim = canvas instanceof HTMLCanvasElement ? canvas.fragSim : null;
            return !!sim && sim.reloading === false && sim.mag === 40;
          },
          undefined,
          { timeout: 15_000, polling: 50 },
        );
      }
    }
    const burstBefore = await readFire(page);
    const ready = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      const sim = canvas instanceof HTMLCanvasElement ? canvas.fragSim : null;
      return { mag: sim?.mag ?? null, reserve: sim?.reserve ?? null, reloading: sim?.reloading ?? null };
    });
    if (ready.mag !== 40 || ready.reloading) {
      errors.push(`burst mag is ${ready.mag}+${ready.reserve} (reloading ${ready.reloading}), expected 40`);
    }
    // One click per simulated frame. The rAF cap is 200 ms, so the clicks
    // stay at least 125 ms of sim time apart. A software-GL frame can block
    // the page for longer than 2 s of wall time, so the deadline is generous
    // and the condition is the sim clock, not a fixed sleep.
    const clicks = 8;
    if (ready.mag === 40 && !ready.reloading) {
      for (let i = 0; i < clicks; i += 1) {
        const mark = await page.evaluate(() => {
          window.dispatchEvent(new MouseEvent("mousedown", { button: 0, buttons: 1, bubbles: true }));
          window.dispatchEvent(new MouseEvent("mouseup", { button: 0, buttons: 0, bubbles: true }));
          const canvas = document.querySelector("canvas");
          const sim = canvas instanceof HTMLCanvasElement ? canvas.fragSim : null;
          return { frames: sim?.frames ?? -1, sim: sim?.sim ?? -1 };
        });
        await page.waitForFunction(
          (seen) => {
            const canvas = document.querySelector("canvas");
            const sim = canvas instanceof HTMLCanvasElement ? canvas.fragSim : null;
            if (!sim || typeof sim.frames !== "number" || typeof sim.sim !== "number") return false;
            return sim.frames > seen.frames && sim.sim > seen.sim;
          },
          mark,
          { timeout: 15_000, polling: 50 },
        );
      }
      const burstAfter = await readFire(page);
      const burstShots = burstAfter.shots - burstBefore.shots;
      console.log(
        `throttled bursts: ${burstShots} shots from ${clicks} clicks spaced >=125 ms apart, ammo ${burstBefore.ammo} -> ${burstAfter.ammo}`,
      );
      if (burstShots !== clicks) {
        errors.push(`${clicks} clicks spaced >=125 ms apart fired ${burstShots} shots`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    errors.push(`throttled fire probe failed: ${message}`);
  } finally {
    await page.close();
  }
}

async function sampleOptInFrame(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  noteConsole(page, errors, "pixels");
  try {
    // The play pages leave the drawing buffer unpreserved. This load is the
    // harness asking for the copy, so one drawImage can see the frame.
    await page.addInitScript(() => {
      window.__fragKeepDrawingBuffer = true;
    });
    await page.goto(`${origin}/`, { waitUntil: "load", timeout: 15_000 });
    await page.waitForSelector("canvas", { timeout: 5_000 });
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
        }),
    );
    return await page.evaluate(() => {
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
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { error: `pixel sample failed: ${message}` };
  } finally {
    await page.close();
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
      "--enable-precise-memory-info",
    ],
  });
  try {
    const sample = await sampleOptInFrame(browser, errors);
    if (sample.error) errors.push(sample.error);
    else if (!sample.width || !sample.height) errors.push("canvas has no pixels");
    else if (sample.colored < 8) {
      errors.push(
        `canvas does not show a rendered object (${sample.colored} non-background samples)`,
      );
    }

    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    if (process.env.FRAG_SLOW_FRAMES === "1") await installSlowFrames(page);
    noteConsole(page, errors, "");
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

    assertHorizontalFov(await readView(page), errors, "initial viewport");
    await assertCanvasAspect(page, errors, "initial viewport");
    await assertReadableType(page, errors, "720p");
    await assertWarningCopy(page, errors, "720p");
    await page.setViewportSize({ width: 1920, height: 1080 });
    await assertWarningCopy(page, errors, "1080p");
    await page.setViewportSize({ width: 1280, height: 480 });
    await assertWarningCopy(page, errors, "480p");
    await page.setViewportSize({ width: 1280, height: 720 });

    await assertShellFlow(page, errors);
    await assertReadableType(page, errors, "720p");
    await assertHudLayout(page, errors, "720p");

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
        }),
    );
    await assertReadableType(page, errors, "1280x800");
    await assertHudLayout(page, errors, "1280x800");
    await assertLabelGlyphs(page, errors);
    await assertCanvasAspect(page, errors, "after resize 1280x800");

    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
        }),
    );
    await assertReadableType(page, errors, "1080p");
    await assertHudLayout(page, errors, "1080p");
    assertHorizontalFov(await readView(page), errors, "after resize 1920x1080");
    await assertCanvasAspect(page, errors, "after resize 1920x1080");

    await page.setViewportSize({ width: 1280, height: 480 });
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
        }),
    );
    await assertReadableType(page, errors, "480p");
    await assertHudLayout(page, errors, "480p");
    await assertCanvasAspect(page, errors, "after resize 1280x480");

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

    // No page.screenshot here. On software GL the bloom frame occupies the
    // compositor, and Playwright's capture waits for that frame until it times out.
    // The opt-in buffer page already counted the canvas colors. This play page
    // does not preserve the drawing buffer and does not read pixels.

    await page.setViewportSize({ width: 900, height: 700 });
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
        }),
    );
    assertHorizontalFov(await readView(page), errors, "after resize 900x700");
    await assertCanvasAspect(page, errors, "after resize 900x700");

    await page.setViewportSize({ width: 700, height: 900 });
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)));
        }),
    );
    assertHorizontalFov(await readView(page), errors, "after resize 700x900");
    await assertCanvasAspect(page, errors, "after resize 700x900");

    await assertHiddenTabDoesNotSpike(page, errors);
    await assertPauseResume(browser, errors);
    await assertLongRun(page, errors);
    await assertContextLoss(page, errors);
    await assertStationaryDamage(browser, errors);
    await assertThrottledFire(browser, errors);

    await runDevSmoke(browser, errors);

    if (errors.length > 0) {
      console.error(errors.join("\n"));
      if (previewLog.trim()) console.error(previewLog);
      process.exitCode = 1;
    } else {
      console.log(
        `smoke passed: canvas ${sample.width}x${sample.height}, ${sample.colored} non-background samples, draw calls ${stats.calls}, triangles ${stats.triangles}, lines ${stats.lines}, points ${stats.points}, 105° horizontal fov, warning -> continue -> click-to-play -> hud 100 / 0 armor / 40+40 -> W moves forward -> fire drops ammo -> R reloads -> M mutes -> damage arcs -> pause -> resume -> reload, readable type at 480p, 720p, 1280x800, and 1080p, death recap -> click restart -> 100/0/40+40 wave 1, hitmarker mounted, no console warnings, no ReadPixels stall, no third-party requests, localStorage empty`,
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
