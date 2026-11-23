// Control-table input, sampled once per frame.
//
// Edges are latched on the events themselves, so a tap that starts and ends
// between two frames is still `pressed` and `released`. Left click also
// keeps a count. Several clicks can land before the next sample, and a click
// that is already up still counts. `sample` reads that count and clears it.
// `sample(true)` while the pointer is locked and play is active. A false
// sample (paused or unlocked) returns an empty state: edges are cleared, not
// turned into releases, the click count is dropped, and look deltas are
// dropped. Capturing again adopts keys that are already held as `down`
// without a new `pressed`. Death and restart call `discard` so a click from
// those gates cannot fire once play resumes.

export const ACTIONS = [
  "forward",
  "back",
  "left",
  "right",
  "jump",
  "fire",
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
    reload: false,
    pause: false,
    debug: false,
    sensDown: false,
    sensUp: false,
  };
}

export function buttonsFromCodes(codes: Iterable<string>, fire: boolean): ButtonState {
  const down = buttonState();
  for (const code of codes) {
    const action = KEY_ACTIONS[code];
    if (action) down[action] = true;
  }
  // Left mouse is not a key. Held is the full-auto fire intent.
  down.fire = fire;
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
} {
  const held = new Set<string>();
  let fire = false;
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
    return buttonsFromCodes(held, fire);
  }

  function sync(): void {
    if (!armed || !locked()) return;
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
    if (event.code === "Space" && locked()) event.preventDefault();
    sync();
  }

  function onKeyUp(event: KeyboardEvent): void {
    held.delete(event.code);
    sync();
  }

  function onMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return;
    fire = true;
    // Count only while play owns the pointer. A click on the pause overlay
    // or the recap is not a shot, and `discard` / disarm drop any that slipped in.
    if (armed && locked()) firePresses += 1;
    sync();
    hooks?.onPointerDown?.();
  }
  // Survives minification so the smoke test can tell this handler from the runner's.
  Object.assign(onMouseDown, { fragRole: "fire" });

  function onMouseUp(event: MouseEvent): void {
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

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("blur", onBlur);
  document.addEventListener("pointerlockchange", onLockChange);

  return {
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
      const frame = takeLatch(latch, dx, dy);
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
