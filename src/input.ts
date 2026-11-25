// Control-table input, sampled once per frame.
//
// Edges are latched on the events themselves, so a tap that starts and ends
// between two frames is still `pressed` and `released`. Left click also
// keeps a count. Several clicks can land before the next sample, and a click
// that is already up still counts. `sample` reads that count and clears it.
// `sample(true)` while play is active, with or without the pointer lock.
// Mouse-look deltas are reported only while the pointer is locked. A false
// sample (warning, click-to-play, pause, or death) returns an empty state:
// edges are cleared, not turned into releases, the click count is dropped,
// and look deltas are dropped. Sampling again adopts keys that are already
// held as `down` without a new `pressed`. Death and restart call `discard`
// so a click from those gates cannot fire once play resumes.

export const ACTIONS = [
  "forward",
  "back",
  "left",
  "right",
  "jump",
  "fire",
  "alt",
  "reload",
  "pause",
  "debug",
  "sensDown",
  "sensUp",
] as const;

export type Action = (typeof ACTIONS)[number];

export type ButtonState = Record<Action, boolean>;

export interface InputState {
  down: ButtonState;
  pressed: ButtonState;
  released: ButtonState;
  /** Pointer-lock `movementX` since the previous sample, in CSS pixels. */
  lookX: number;
  /** Pointer-lock `movementY` since the previous sample. Positive is down. */
  lookY: number;
  /**
   * Left clicks since the previous sample. A tap that ended already still
   * counts, and a slow frame can hold more than one. Zero after a pause,
   * an unlock, `discard`, or the sample that read it.
   */
  firePresses: number;
}

const KEY_ACTIONS: Readonly<Record<string, Action>> = {
  KeyW: "forward",
  KeyA: "left",
  KeyS: "back",
  KeyD: "right",
  Space: "jump",
  KeyR: "reload",
  Escape: "pause",
  Backquote: "debug",
  F1: "debug",
  BracketLeft: "sensDown",
  BracketRight: "sensUp",
};

export function actionForCode(code: string): Action | null {
  return KEY_ACTIONS[code] ?? null;
}

export function buttonState(): ButtonState {
  return {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    fire: false,
    alt: false,
    reload: false,
    pause: false,
    debug: false,
    sensDown: false,
    sensUp: false,
  };
}

export function buttonsFromCodes(codes: Iterable<string>, fire: boolean, alt = false): ButtonState {
  const down = buttonState();
  for (const code of codes) {
    const action = KEY_ACTIONS[code];
    if (action) down[action] = true;
  }
  // Left mouse is full-auto. Right mouse charges the pierce burst.
  down.fire = fire;
  down.alt = alt;
  return down;
}

export function buttonEdges(
  previous: ButtonState,
  next: ButtonState,
): { pressed: ButtonState; released: ButtonState } {
  const pressed = buttonState();
  const released = buttonState();
  for (const action of ACTIONS) {
    const was = previous[action];
    const now = next[action];
    pressed[action] = now && !was;
    released[action] = was && !now;
  }
  return { pressed, released };
}

export interface InputLatch {
  down: ButtonState;
  pressed: ButtonState;
  released: ButtonState;
}

export function emptyInput(): InputState {
  return {
    down: buttonState(),
    pressed: buttonState(),
    released: buttonState(),
    lookX: 0,
    lookY: 0,
    firePresses: 0,
  };
}

export function createLatch(): InputLatch {
  return { down: buttonState(), pressed: buttonState(), released: buttonState() };
}

/** Adopt keys already held. Clears edges so a held key is not a fresh press. */
export function armLatch(latch: InputLatch, physical: ButtonState): void {
  for (const action of ACTIONS) {
    latch.down[action] = physical[action];
    latch.pressed[action] = false;
    latch.released[action] = false;
  }
}

export function clearLatch(latch: InputLatch): void {
  armLatch(latch, buttonState());
}

/** Record one physical transition. A press and release can both stick until read. */
export function latchTransition(latch: InputLatch, next: ButtonState): void {
  const edges = buttonEdges(latch.down, next);
  for (const action of ACTIONS) {
    if (edges.pressed[action]) latch.pressed[action] = true;
    if (edges.released[action]) latch.released[action] = true;
    latch.down[action] = next[action];
  }
}

/** Copy the latch into a frame and clear edges. `down` is left as held. */
export function takeLatch(latch: InputLatch, lookX = 0, lookY = 0): InputState {
  const state: InputState = {
    down: { ...latch.down },
    pressed: { ...latch.pressed },
    released: { ...latch.released },
    lookX,
    lookY,
    firePresses: 0,
  };
  for (const action of ACTIONS) {
    latch.pressed[action] = false;
    latch.released[action] = false;
  }
  return state;
}

export function createInput(
  canvas: HTMLCanvasElement,
  hooks?: { onPointerDown?: () => void; onPointerUp?: () => void },
): {
  sample(captured: boolean): InputState;
  /** Drop latched clicks. Death and restart call this; pause drops them too. */
  discard(): void;
  /** Drop pointer-lock deltas so a restart does not apply the look that killed you. */
  clearLook(): void;
} {
  const held = new Set<string>();
  let fire = false;
  let alt = false;
  let firePresses = 0;
  let lookX = 0;
  let lookY = 0;
  let armed = false;
  const latch = createLatch();
  const state = emptyInput();

  function locked(): boolean {
    return document.pointerLockElement === canvas;
  }

  function physical(): ButtonState {
    return buttonsFromCodes(held, fire, alt);
  }

  function sync(): void {
    if (!armed) return;
    latchTransition(latch, physical());
  }

  function disarm(): void {
    clearLatch(latch);
    firePresses = 0;
    armed = false;
    lookX = 0;
    lookY = 0;
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.repeat) return;
    if (actionForCode(event.code) === null) return;
    held.add(event.code);
    // Space would scroll the page. The shell already handles Esc and the debug keys.
    if (event.code === "Space" && (armed || locked())) event.preventDefault();
    sync();
  }

  function onKeyUp(event: KeyboardEvent): void {
    held.delete(event.code);
    sync();
  }

  function phaseAllowsFire(): boolean {
    if (typeof document.querySelector !== "function") return true;
    const shell = document.querySelector("#app-shell");
    if (!shell) return true;
    return shell.getAttribute("data-phase") === "playing";
  }

  function onContextMenu(event: Event): void {
    event.preventDefault();
  }

  function onMouseDown(event: MouseEvent): void {
    if (event.button === 2) {
      alt = true;
      event.preventDefault();
      sync();
      return;
    }
    if (event.button !== 0) return;
    fire = true;
    // One mousedown is one press. Pause and the warning are not play, so the
    // resume click is not a shot. Without the lock, only a canvas click counts,
    // and that same click is what asks for the pointer again.
    const owned = locked() || event.target === canvas;
    if (armed && phaseAllowsFire() && owned) firePresses += 1;
    sync();
    hooks?.onPointerDown?.();
  }
  // Survives minification so the smoke test can tell this handler from the runner's.
  Object.assign(onMouseDown, { fragRole: "fire" });

  function onMouseUp(event: MouseEvent): void {
    if (event.button === 2) {
      alt = false;
      sync();
      return;
    }
    if (event.button !== 0) return;
    fire = false;
    sync();
    hooks?.onPointerUp?.();
  }

  function onMouseMove(event: MouseEvent): void {
    if (!locked()) return;
    lookX += event.movementX;
    lookY += event.movementY;
  }

  function onBlur(): void {
    // A missed keyup (alt-tab) would otherwise stick a button on.
    held.clear();
    fire = false;
    alt = false;
    disarm();
  }

  function onLockChange(): void {
    if (!locked()) {
      disarm();
      return;
    }
    armLatch(latch, physical());
    armed = true;
  }

  // Headless input tests pass a plain object. The page canvas always has this.
  if (typeof canvas.addEventListener === "function") {
    canvas.addEventListener("contextmenu", onContextMenu);
  }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("blur", onBlur);
  document.addEventListener("pointerlockchange", onLockChange);

  return {
    clearLook(): void {
      lookX = 0;
      lookY = 0;
    },
    sample(captured: boolean): InputState {
      const dx = lookX;
      const dy = lookY;
      lookX = 0;
      lookY = 0;
      if (!captured) {
        disarm();
        copyButtons(state.down, latch.down);
        copyButtons(state.pressed, latch.pressed);
        copyButtons(state.released, latch.released);
        state.lookX = 0;
        state.lookY = 0;
        state.firePresses = 0;
        return state;
      }
      if (!armed) {
        armLatch(latch, physical());
        armed = true;
      }
      const frame = takeLatch(latch, locked() ? dx : 0, locked() ? dy : 0);
      copyButtons(state.down, frame.down);
      copyButtons(state.pressed, frame.pressed);
      copyButtons(state.released, frame.released);
      state.lookX = frame.lookX;
      state.lookY = frame.lookY;
      state.firePresses = firePresses;
      firePresses = 0;
      return state;
    },
    discard(): void {
      firePresses = 0;
    },
  };
}

function copyButtons(target: ButtonState, source: ButtonState): void {
  for (const action of ACTIONS) target[action] = source[action];
}
