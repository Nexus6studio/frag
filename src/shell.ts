// Click-to-play shell for the prototype.
// Flow on every fresh load: content warning, then click-to-play, then pointer lock.
// Esc pauses. Resuming stays in the session and does not show the warning again.
// Nothing here is written to localStorage.

type Phase = "warning" | "ready" | "playing" | "paused";

const FPS_SAMPLE_MS = 250;

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
  onFrame(time: number, pose?: DebugPose): void;
} {
  const root = required<HTMLElement>("#app-shell");
  const warning = required<HTMLElement>("#content-warning");
  const ready = required<HTMLElement>("#click-to-play");
  const pauseOverlay = required<HTMLElement>("#pause");
  const continueButton = required<HTMLButtonElement>("#content-warning-continue");
  const fps = required<HTMLElement>("#fps-readout");

  let phase: Phase = "warning";
  let showFps = false;
  let lockRequest = 0;
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
    const finish = (): void => {
      if (lockRequest === request) lockRequest = 0;
    };
    try {
      // Headless runs and dismissed prompts reject. Overlay state already moved.
      void canvas.requestPointerLock().then(finish, finish);
    } catch {
      finish();
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
    const locked = document.pointerLockElement !== null;
    if (locked) {
      lockRequest = 0;
      // A lock during the warning would skip the acknowledge step. Drop it.
      if (phase === "warning") {
        document.exitPointerLock();
        return;
      }
      if (phase === "ready" || phase === "paused") setPhase("playing");
      return;
    }
    // Ignore the unlock from a lock that is still being requested, so a late
    // release cannot bounce a resume straight back to pause.
    if (lockRequest !== 0) return;
    if (phase === "playing") setPhase("paused");
  });

  setPhase("warning");

  return {
    get phase() {
      return phase;
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
