// Click-to-play shell for the prototype.
// Flow on every fresh load: content warning, then click-to-play, then pointer lock.
// Esc pauses. Resuming stays in the session and does not show the warning again.
// Nothing here is written to localStorage.

type Phase = "warning" | "ready" | "playing" | "paused";

const FPS_SAMPLE_MS = 250;
/**
 * Pointer lock has to survive this long before a later release counts as the
 * player leaving. Headless Chromium can grant the lock from the click and drop
 * it on the next beat; that used to flip play back to paused before the HUD
 * observer's "play" mode was what the smoke test sampled.
 */
const LOCK_STABLE_MS = 1000;

export function unlockShouldPause(input: {
  phase: string;
  requestOpen: boolean;
  lockStable: boolean;
  /** A death-restart click releases the lock. That release is not a pause. */
  hold?: boolean;
}): boolean {
  if (input.hold) return false;
  if (input.phase !== "playing") return false;
  if (input.requestOpen) return false;
  return input.lockStable;
}

export interface DebugPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  sensitivity: number;
  planarSpeed: number;
  grounded: boolean;
}

export function mountShell(canvas: HTMLCanvasElement): {
  readonly phase: Phase;
  /** True while the FPS readout (and the dev target volume) is showing. */
  readonly debug: boolean;
  onFrame(time: number, pose?: DebugPose): void;
  /** Keep playing across the unlock a restart click causes. Does not show the warning. */
  holdLock(): void;
} {
  const root = required<HTMLElement>("#app-shell");
  const warning = required<HTMLElement>("#content-warning");
  const ready = required<HTMLElement>("#click-to-play");
  const pauseOverlay = required<HTMLElement>("#pause");
  const continueButton = required<HTMLButtonElement>("#content-warning-continue");
  const fps = required<HTMLElement>("#fps-readout");

  let phase: Phase = "warning";
  let showFps = false;
  let restartHold = false;
  let lockRequest = 0;
  let lockEpoch = 0;
  let lockStable = false;
  let stableTimer = 0;
  let lastTime = 0;
  let sampleMs = 0;
  let sampleFrames = 0;
  let fpsLabel = "— fps";

  function setPhase(next: Phase): void {
    phase = next;
    root.dataset.phase = next;
    warning.hidden = next !== "warning";
    ready.hidden = next !== "ready";
    pauseOverlay.hidden = next !== "paused";
    if (next === "warning") continueButton.focus();
    else if (next === "ready") ready.focus();
    else if (next === "paused") pauseOverlay.focus();
  }

  function acknowledge(): void {
    if (phase !== "warning") return;
    setPhase("ready");
  }

  function requestLock(): void {
    const request = ++lockRequest;
    lockEpoch += 1;
    lockStable = false;
    // Clear the in-flight token on a later turn. A rejected or instantly
    // dropped lock fires pointerlockchange after the promise, and zeroing the
    // token in the promise itself made that event look like the player left.
    const settle = (): void => {
      setTimeout(() => {
        if (lockRequest === request) lockRequest = 0;
      }, 0);
    };
    try {
      void canvas.requestPointerLock().then(settle, settle);
    } catch {
      settle();
    }
  }

  function beginPlay(): void {
    if (phase !== "ready" && phase !== "paused") return;
    setPhase("playing");
    requestLock();
  }

  function pause(): void {
    if (phase !== "playing") return;
    setPhase("paused");
    if (document.pointerLockElement !== null) document.exitPointerLock();
  }

  function toggleFps(): void {
    showFps = !showFps;
    fps.hidden = !showFps;
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.repeat) return;

    if (event.code === "F1" || event.code === "Backquote") {
      event.preventDefault();
      event.stopPropagation();
      toggleFps();
      return;
    }

    if (event.code === "Escape") {
      event.preventDefault();
      pause();
      return;
    }

    if (phase === "warning" && (event.code === "Enter" || event.code === "Space")) {
      if (event.target instanceof Node && warning.contains(event.target)) {
        event.preventDefault();
        acknowledge();
      }
      return;
    }

    if (phase === "ready" && !isModifier(event)) {
      event.preventDefault();
      beginPlay();
    }
  }

  continueButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    acknowledge();
  });

  warning.addEventListener("click", (event) => {
    event.preventDefault();
  });

  ready.addEventListener("click", (event) => {
    event.preventDefault();
    beginPlay();
  });

  pauseOverlay.addEventListener("click", (event) => {
    event.preventDefault();
    beginPlay();
  });

  window.addEventListener("keydown", onKeyDown, true);

  document.addEventListener("pointerlockchange", () => {
    const locked = document.pointerLockElement === canvas;
    if (locked) {
      const epoch = ++lockEpoch;
      window.clearTimeout(stableTimer);
      stableTimer = window.setTimeout(() => {
        if (epoch === lockEpoch && document.pointerLockElement === canvas) lockStable = true;
      }, LOCK_STABLE_MS);
      // A lock during the warning would skip the acknowledge step. Drop it.
      if (phase === "warning") {
        document.exitPointerLock();
        return;
      }
      if (phase === "ready" || phase === "paused") setPhase("playing");
      return;
    }
    const requestOpen = lockRequest !== 0;
    const wasStable = lockStable;
    const held = restartHold;
    restartHold = false;
    lockEpoch += 1;
    lockStable = false;
    window.clearTimeout(stableTimer);
    if (requestOpen) lockRequest = 0;
    if (unlockShouldPause({ phase, requestOpen, lockStable: wasStable, hold: held })) {
      setPhase("paused");
    } else if (held && phase === "playing") {
      requestLock();
    }
  });

  setPhase("warning");

  return {
    get phase() {
      return phase;
    },
    get debug() {
      return showFps;
    },
    holdLock(): void {
      if (phase === "warning" || phase === "ready") return;
      restartHold = document.pointerLockElement === canvas;
      setPhase("playing");
      requestLock();
    },
    onFrame(time: number, pose?: DebugPose): void {
      if (lastTime !== 0) {
        const delta = time - lastTime;
        // A software-GL frame can run past a second. Still count it, so the
        // readout moves instead of sticking on the placeholder. A background
        // tab can sit for much longer than five seconds; that gap is not a frame.
        if (delta > 0 && delta < 5000) {
          sampleMs += delta;
          sampleFrames += 1;
          if (sampleMs >= FPS_SAMPLE_MS) {
            fpsLabel = `${Math.round((sampleFrames * 1000) / sampleMs)} fps`;
            sampleMs = 0;
            sampleFrames = 0;
          }
        }
      }
      lastTime = time;
      if (showFps) {
        if (!pose) {
          fps.textContent = fpsLabel;
        } else {
          const pos = `${pose.x.toFixed(2)} ${pose.y.toFixed(2)} ${pose.z.toFixed(2)}`;
          const angles = `yaw ${pose.yaw.toFixed(1)}  pitch ${pose.pitch.toFixed(1)}`;
          const stance = pose.grounded ? "ground" : "air";
          fps.textContent = `${fpsLabel}  pos ${pos}  ${angles}  sens ${pose.sensitivity.toFixed(2)}  ${pose.planarSpeed.toFixed(2)} m/s  ${stance}`;
        }
      }
    },
  };
}

function isModifier(event: KeyboardEvent): boolean {
  return (
    event.code === "ShiftLeft" ||
    event.code === "ShiftRight" ||
    event.code === "ControlLeft" ||
    event.code === "ControlRight" ||
    event.code === "AltLeft" ||
    event.code === "AltRight" ||
    event.code === "MetaLeft" ||
    event.code === "MetaRight"
  );
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}
