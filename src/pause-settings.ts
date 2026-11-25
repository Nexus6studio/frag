// DOM controls on the pause card. Reads and paints the settings record.
// Does not resume play, and does not touch localStorage itself.

import { sanitizeSettings, type PlayerSettings } from "./settings.ts";

export function mountPauseSettings(
  initial: PlayerSettings,
  onChange: (next: PlayerSettings) => void,
): { setMuted(muted: boolean): void } {
  const root = required<HTMLElement>("#pause-settings");
  const sensitivity = required<HTMLInputElement>("#setting-sensitivity");
  const sensitivityValue = required<HTMLElement>("#setting-sensitivity-value");
  const fov = required<HTMLInputElement>("#setting-fov");
  const fovValue = required<HTMLElement>("#setting-fov-value");
  const mute = required<HTMLInputElement>("#setting-mute");
  const invert = required<HTMLInputElement>("#setting-invert-y");

  function paint(settings: PlayerSettings): void {
    sensitivity.value = settings.sensitivity.toFixed(2);
    sensitivityValue.textContent = settings.sensitivity.toFixed(2);
    fov.value = String(Math.round(settings.fov));
    fovValue.textContent = String(Math.round(settings.fov));
    mute.checked = settings.muted;
    invert.checked = settings.invertY;
  }

  function commit(): void {
    const next = sanitizeSettings({
      sensitivity: Number(sensitivity.value),
      fov: Number(fov.value),
      muted: mute.checked,
      invertY: invert.checked,
    });
    sensitivityValue.textContent = next.sensitivity.toFixed(2);
    fovValue.textContent = String(Math.round(next.fov));
    onChange(next);
  }

  function hold(event: Event): void {
    event.stopPropagation();
  }

  paint(initial);
  root.addEventListener("pointerdown", hold);
  root.addEventListener("mousedown", hold);
  root.addEventListener("click", hold);
  sensitivity.addEventListener("input", commit);
  fov.addEventListener("input", commit);
  mute.addEventListener("change", commit);
  invert.addEventListener("change", commit);

  return {
    setMuted(muted: boolean): void {
      mute.checked = muted;
    },
  };
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}
