import "./hud.css";
import { ARC_CAP, seatArcPeak, type FeedbackSample, type ScreenRect } from "../feel.ts";
import type { PlayerStore } from "../player/state";
import type { DeathRecap } from "../waves.ts";
import { acceptRestartClick, bindHud, recapAcceptsInput, recapClickAction, recapEnterAction, recapTargetAt, type HudElements } from "./model";
import { COPY_LABEL, COPIED_LABEL, applyCopyFeedback, createScoreBook, readClipboard, scoreFromRecap, scoreLine, writeScoreLine } from "../scores.ts";
import { isPauseResume } from "../shell";

export function mountHud(
  player: PlayerStore,
  hooks?: {
    onRestart?: () => void;
    getRecap?: () => DeathRecap;
    /** One window mousedown already exists for fire. Death tracking uses that. */
    trackPointer?: (down: () => void, up: () => void) => void;
  },
): { setWave(wave: number): void; setMuted(muted: boolean): void; setCombat(sample: FeedbackSample): void } {
  const root = document.createElement("div");
  root.id = "hud";
  root.dataset.mode = "hidden";

  const crosshair = document.createElement("div");
  crosshair.id = "crosshair";
  crosshair.setAttribute("aria-hidden", "true");
  for (const side of ["n", "e", "s", "w"]) {
    const tick = document.createElement("span");
    tick.className = `crosshair-${side}`;
    crosshair.appendChild(tick);
  }

  const marker = document.createElement("div");
  marker.id = "hitmarker";
  marker.dataset.kind = "none";
  marker.hidden = true;
  marker.setAttribute("aria-hidden", "true");
  marker.append(document.createElement("span"), document.createElement("span"));

  const arcs = document.createElement("div");
  arcs.id = "damage-arcs";
  arcs.setAttribute("aria-hidden", "true");
  const arcEls: HTMLDivElement[] = [];
  for (let i = 0; i < ARC_CAP; i += 1) {
    const arc = document.createElement("div");
    arc.className = "damage-arc";
    arc.hidden = true;
    arcs.append(arc);
    arcEls.push(arc);
  }

  const bar = document.createElement("div");
  bar.id = "hud-bar";
  const hpStat = stat("hud-hp-stat", "HP", "hud-hp");
  const armorStat = stat("hud-armor-stat", "Armor", "hud-armor");
  const ammoStat = stat("hud-ammo-stat", "Ammo", "hud-ammo");
  const cue = document.createElement("span");
  cue.id = "hud-ammo-cue";
  cue.className = "hud-cue";
  cue.hidden = true;
  ammoStat.root.append(cue);
  bar.append(hpStat.root, armorStat.root, ammoStat.root);

  const waveEl = document.createElement("p");
  waveEl.id = "hud-wave";
  waveEl.textContent = "WAVE 1";

  const death = document.createElement("div");
  death.id = "death-recap";
  death.hidden = true;
  const waveStat = recapStat("recap-wave");
  const fragsStat = recapStat("recap-frags");
  const timeStat = recapStat("recap-time");
  const hint = document.createElement("p");
  hint.className = "recap-hint";
  hint.textContent = "click to restart";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.id = "copy-score";
  copy.textContent = COPY_LABEL;
  const fallback = document.createElement("input");
  fallback.id = "copy-score-line";
  fallback.type = "text";
  fallback.readOnly = true;
  fallback.hidden = true;
  fallback.spellcheck = false;
  fallback.autocomplete = "off";
  fallback.setAttribute("aria-label", "Score");
  death.append(waveStat.row, fragsStat.row, timeStat.row, hint, copy, fallback);

  const mute = document.createElement("p");
  mute.id = "hud-mute";
  mute.hidden = true;
  mute.textContent = "MUTE";

  root.append(crosshair, marker, arcs, waveEl, bar, mute, death);

  const els: HudElements = {
    root,
    hp: hpStat.value,
    armor: armorStat.value,
    ammo: ammoStat.value,
    armorStat: armorStat.root,
    death,
    cue,
    recap: {
      wave: waveStat.value,
      frags: fragsStat.value,
      time: timeStat.value,
      waveBadge: waveStat.badge,
      fragsBadge: fragsStat.badge,
      timeBadge: timeStat.badge,
    },
  };

  const shell = document.querySelector<HTMLElement>("#app-shell");

  const syncCursor = (): void => {
    const locked = document.pointerLockElement !== null;
    const playing = root.dataset.mode === "play";
    if (playing || locked) document.documentElement.dataset.cursor = "none";
    else delete document.documentElement.dataset.cursor;
  };

  const scores = createScoreBook();
  const bound = bindHud(player, els, () => shell?.getAttribute("data-phase") ?? null, syncCursor, {
    getRecap: hooks?.getRecap,
    onDeath: (recap) => scores.record(scoreFromRecap(recap)).fresh,
  });

  const observer = new MutationObserver(() => {
    bound.update();
  });
  if (shell) observer.observe(shell, { attributes: true, attributeFilter: ["data-phase"] });

  document.addEventListener("pointerlockchange", syncCursor);
  // A blur can deliver the visibility event and a click in the same turn, before
  // the pause observer hides the recap. That click is not a restart.
  let blurred = false;
  document.addEventListener("visibilitychange", () => {
    blurred = true;
    window.setTimeout(() => {
      blurred = false;
    }, 0);
  });
  let deathAt = 0;
  let heldThroughDeath = false;
  let pointerDown = false;
  let copyTicket = 0;
  player.subscribe(() => {
    const dead = player.get().hp <= 0;
    if (dead && deathAt === 0) {
      deathAt = performance.now();
      heldThroughDeath = pointerDown;
      // Pointer lock retargets every click at the canvas and reports 0,0, so
      // the cursor cannot land on Copy score. Release it. A dead player does
      // not pause on that release. Restart asks for the lock again.
      if (document.pointerLockElement) document.exitPointerLock();
    }
    if (!dead) {
      deathAt = 0;
      heldThroughDeath = false;
      copyTicket += 1;
      copy.textContent = COPY_LABEL;
      fallback.hidden = true;
      fallback.value = "";
    }
  });

  const armed = (): boolean => deathAt !== 0 && recapAcceptsInput((performance.now() - deathAt) / 1000);

  const restartFromRecap = (event: Event): void => {
    const phase = shell?.getAttribute("data-phase") ?? null;
    if (
      !acceptRestartClick({
        mode: root.dataset.mode ?? null,
        phase,
        hidden: document.hidden || blurred,
      })
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (hooks?.onRestart) hooks.onRestart();
    else player.restart();
  };

  hooks?.trackPointer?.(
    () => {
      pointerDown = true;
      if (armed()) heldThroughDeath = false;
    },
    () => {
      pointerDown = false;
    },
  );
  const copyReady = (): boolean => armed() && !heldThroughDeath;

  const confirmCopy = (): void => {
    if (!copyReady() || player.get().hp > 0) return;
    const recap = hooks?.getRecap?.();
    if (!recap) return;
    const line = scoreLine(scoreFromRecap(recap));
    const ticket = ++copyTicket;
    void writeScoreLine(line, readClipboard(navigator)).then(
      (result) => {
        if (ticket !== copyTicket || player.get().hp > 0) return;
        applyCopyFeedback({ button: copy, line: fallback }, result, line);
        if (result === "copied") {
          window.setTimeout(() => {
            if (ticket !== copyTicket) return;
            if (copy.textContent === COPIED_LABEL) copy.textContent = COPY_LABEL;
          }, 2000);
          return;
        }
        try {
          fallback.focus();
          fallback.select();
        } catch {
          // The line is already in the field.
        }
      },
      () => {
        if (ticket !== copyTicket || player.get().hp > 0) return;
        applyCopyFeedback({ button: copy, line: fallback }, "fallback", line);
        try {
          fallback.focus();
          fallback.select();
        } catch {
          // The line is already in the field.
        }
      },
    );
  };

  copy.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    confirmCopy();
  });

  const targetOf = (event: MouseEvent | KeyboardEvent): ReturnType<typeof recapTargetAt> =>
    recapTargetAt(
      event.target,
      "clientX" in event ? event.clientX : Number.NaN,
      "clientY" in event ? event.clientY : Number.NaN,
      (x, y) => document.elementFromPoint(x, y),
      copy,
      fallback,
    );

  window.addEventListener(
    "click",
    (event) => {
      if (root.dataset.mode !== "dead") return;
      const action = recapClickAction({
        armed: copyReady(),
        target: targetOf(event),
        restartable: acceptRestartClick({
          mode: root.dataset.mode ?? null,
          phase: shell?.getAttribute("data-phase") ?? null,
          hidden: document.hidden || blurred,
        }),
      });
      if (action === "keep") {
        event.preventDefault();
        event.stopPropagation();
        confirmCopy();
        return;
      }
      if (action === "restart") {
        restartFromRecap(event);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (event) => {
      const action = recapEnterAction({
        code: event.code,
        repeat: event.repeat,
        pauseResume: isPauseResume(event),
        hp: player.get().hp,
        phase: shell?.getAttribute("data-phase") ?? null,
        armed: armed(),
        target: targetOf(event),
      });
      if (action === "ignore" || action === "keep") return;
      if (action === "swallow") {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      restartFromRecap(event);
    },
    true,
  );

  document.body.appendChild(root);
  return {
    setWave(wave: number): void {
      const n = Math.max(1, Math.floor(Number.isFinite(wave) ? wave : 1));
      const text = `WAVE ${n}`;
      if (waveEl.textContent !== text) waveEl.textContent = text;
    },
    setMuted(muted: boolean): void {
      mute.hidden = !muted;
    },
    setCombat(sample: FeedbackSample): void {
      const flash = sample.marker;
      marker.dataset.kind = flash.kind;
      marker.hidden = flash.kind === "none";
      marker.style.opacity = flash.opacity.toFixed(3);
      let obstacles: ScreenRect[] | null = null;
      for (let i = 0; i < arcEls.length; i += 1) {
        const el = arcEls[i]!;
        const arc = sample.arcs[i];
        if (!arc || arc.opacity <= 0.01) {
          el.hidden = true;
          continue;
        }
        if (!obstacles) obstacles = hudEdgeObstacles([bar, waveEl, mute]);
        const seated = seatArcPeak(arc, obstacles);
        el.hidden = false;
        el.style.left = `${(seated.x * 100).toFixed(2)}%`;
        el.style.top = `${(seated.y * 100).toFixed(2)}%`;
        el.style.opacity = arc.opacity.toFixed(3);
        // seated x/y is the outer peak. translate(-50%, 0) plus center-top origin parks that peak on the edge.
        el.style.transform = `translate(-50%, 0) rotate(${seated.rotation.toFixed(4)}rad)`;
      }
    },
  };
}

/** Live HUD boxes that sit on a screen edge, in viewport fractions. Hidden chrome is skipped. */
function hudEdgeObstacles(elements: readonly HTMLElement[]): ScreenRect[] {
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  const rects: ScreenRect[] = [];
  for (let i = 0; i < elements.length; i += 1) {
    const el = elements[i]!;
    if (el.hidden) continue;
    const box = el.getBoundingClientRect();
    if (!(box.width > 0) || !(box.height > 0)) continue;
    rects.push({
      left: box.left / width,
      top: box.top / height,
      right: box.right / width,
      bottom: box.bottom / height,
    });
  }
  return rects;
}

function recapStat(id: string): {
  row: HTMLParagraphElement;
  value: HTMLSpanElement;
  badge: HTMLSpanElement;
} {
  const row = document.createElement("p");
  row.className = "recap-stat";
  const value = document.createElement("span");
  value.id = id;
  const badge = document.createElement("span");
  badge.className = "recap-badge";
  badge.hidden = true;
  badge.textContent = "NEW BEST";
  row.append(value, badge);
  return { row, value, badge };
}

function stat(
  id: string,
  label: string,
  valueId: string,
): { root: HTMLDivElement; value: HTMLSpanElement } {
  const root = document.createElement("div");
  root.id = id;
  root.className = "hud-stat";
  const labelEl = document.createElement("span");
  labelEl.className = "hud-label";
  labelEl.textContent = label;
  const value = document.createElement("span");
  value.id = valueId;
  value.className = "hud-value";
  root.append(labelEl, value);
  return { root, value };
}
