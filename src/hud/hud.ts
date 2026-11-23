import "./hud.css";
import { ARC_CAP, type FeedbackSample } from "../feel.ts";
import type { PlayerStore } from "../player/state";
import type { DeathRecap } from "../waves.ts";
import { acceptRestartClick, bindHud, deathRecapText, recapAcceptsInput, recapEnterAction, type HudElements } from "./model";
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

  const death = document.createElement("button");
  death.type = "button";
  death.id = "death-recap";
  death.tabIndex = -1;
  death.hidden = true;
  death.textContent = deathRecapText({ wavesCleared: 0, frags: 0, timeAlive: 0 });

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
  };

  const shell = document.querySelector<HTMLElement>("#app-shell");

  const syncCursor = (): void => {
    const locked = document.pointerLockElement !== null;
    const playing = root.dataset.mode === "play";
    if (playing || locked) document.documentElement.dataset.cursor = "none";
    else delete document.documentElement.dataset.cursor;
  };

  const bound = bindHud(player, els, () => shell?.getAttribute("data-phase") ?? null, syncCursor, {
    getRecap: hooks?.getRecap,
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
  player.subscribe(() => {
    const dead = player.get().hp <= 0;
    if (dead && deathAt === 0) {
      deathAt = performance.now();
      heldThroughDeath = pointerDown;
    }
    if (!dead) {
      deathAt = 0;
      heldThroughDeath = false;
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
  window.addEventListener(
    "click",
    (event) => {
      if (root.dataset.mode === "dead" && (!armed() || heldThroughDeath)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      restartFromRecap(event);
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
      });
      if (action === "ignore") return;
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
      for (let i = 0; i < arcEls.length; i += 1) {
        const el = arcEls[i]!;
        const arc = sample.arcs[i];
        if (!arc || arc.opacity <= 0.01) {
          el.hidden = true;
          continue;
        }
        el.hidden = false;
        el.style.left = `${(arc.x * 100).toFixed(2)}%`;
        el.style.top = `${(arc.y * 100).toFixed(2)}%`;
        el.style.opacity = arc.opacity.toFixed(3);
        // arc.x/y is the outer peak. translate(-50%, 0) plus center-top origin parks that peak on the edge.
        el.style.transform = `translate(-50%, 0) rotate(${arc.rotation.toFixed(4)}rad)`;
      }
    },
  };
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
