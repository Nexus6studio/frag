import "./hud.css";
import type { PlayerStore } from "../player/state";
import type { DeathRecap } from "../waves.ts";
import { bindHud, deathRecapText, type HudElements } from "./model";

export function mountHud(
  player: PlayerStore,
  hooks?: { onRestart?: () => void; getRecap?: () => DeathRecap },
): void {
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

  const bar = document.createElement("div");
  bar.id = "hud-bar";
  const hpStat = stat("hud-hp-stat", "HP", "hud-hp");
  const armorStat = stat("hud-armor-stat", "Armor", "hud-armor");
  const ammoStat = stat("hud-ammo-stat", "Ammo", "hud-ammo");
  bar.append(hpStat.root, armorStat.root, ammoStat.root);

  const death = document.createElement("button");
  death.type = "button";
  death.id = "death-recap";
  death.tabIndex = -1;
  death.hidden = true;
  death.textContent = deathRecapText({ wavesCleared: 0, frags: 0, timeAlive: 0 });

  root.append(crosshair, bar, death);

  const els: HudElements = {
    root,
    hp: hpStat.value,
    armor: armorStat.value,
    ammo: ammoStat.value,
    armorStat: armorStat.root,
    death,
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
  window.addEventListener(
    "click",
    (event) => {
      if (root.dataset.mode !== "dead") return;
      event.preventDefault();
      event.stopPropagation();
      if (hooks?.onRestart) hooks.onRestart();
      else player.restart();
    },
    true,
  );

  document.body.appendChild(root);
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
