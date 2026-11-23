// Mouse look and the horizontal field of view.
//
// Pointer-lock `movementX` / `movementY` are CSS pixels (Pointer Lock spec
// screen-coordinate deltas). Sensitivity is degrees per one of those pixels.
// Frag does not multiply by `devicePixelRatio`, so the same CSS-pixel travel
// is the same angle at every display scale. OS pointer acceleration is left
// as the browser already applied it.

import { PerspectiveCamera, Vector3 } from "three";

export const MOUSE_SENSITIVITY_DEG_PER_PIXEL = 0.12;
export const PITCH_LIMIT_DEG = 89;
export const SENSITIVITY_STEP = 0.02;
export const MIN_SENSITIVITY = 0.02;
export const MAX_SENSITIVITY = 1;

/**
 * Design FOV, locked at 105° horizontal.
 *
 * three.js `PerspectiveCamera.fov` is the vertical field of view. The
 * vertical angle is derived from this horizontal angle and the viewport
 * aspect (`width / height`), and recomputed on resize:
 *
 *   vertical = 2 * atan(tan(horizontal / 2) / aspect)
 *
 * A square view is 105° vertical. A wider view keeps 105° horizontal and
 * uses a smaller vertical angle.
 */
export const HORIZONTAL_FOV_DEG = 105;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export function clampPitch(pitchDeg: number): number {
  if (pitchDeg > PITCH_LIMIT_DEG) return PITCH_LIMIT_DEG;
  if (pitchDeg < -PITCH_LIMIT_DEG) return -PITCH_LIMIT_DEG;
  return pitchDeg;
}

/** Wrap yaw into (-180, 180]. -180 and 180 are the same heading; 180 is used. */
export function wrapYaw(yawDeg: number): number {
  const wrapped = ((yawDeg % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}

export function verticalFovDeg(horizontalDeg: number, aspect: number): number {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const halfHorizontal = (horizontalDeg * DEG2RAD) / 2;
  const vertical = 2 * Math.atan(Math.tan(halfHorizontal) / safeAspect);
  return vertical * RAD2DEG;
}

export function stepSensitivity(current: number, direction: -1 | 1): number {
  const next = Math.round((current + direction * SENSITIVITY_STEP) * 1000) / 1000;
  if (next < MIN_SENSITIVITY) return MIN_SENSITIVITY;
  if (next > MAX_SENSITIVITY) return MAX_SENSITIVITY;
  return next;
}

/**
 * Yaw and pitch in degrees. Mouse right turns right (yaw decreases: three.js
 * YXZ positive yaw looks toward -X). Mouse down looks down (pitch decreases:
 * positive pitch looks up). Pitch cannot pass ±89°, so the view does not
 * flip over the poles.
 */
export function applyMouseLook(
  yawDeg: number,
  pitchDeg: number,
  movementX: number,
  movementY: number,
  sensitivity: number,
): { yaw: number; pitch: number } {
  return {
    yaw: wrapYaw(yawDeg - movementX * sensitivity),
    pitch: clampPitch(pitchDeg - movementY * sensitivity),
  };
}

export interface LookView {
  readonly verticalFov: number;
  readonly aspect: number;
  readonly yaw: number;
  readonly pitch: number;
}

export interface LookRig {
  apply(movementX: number, movementY: number): void;
  nudgeSensitivity(direction: -1 | 1): void;
  resize(width: number, height: number): void;
  /** Add a transient pitch offset, in degrees, without changing the held aim. */
  setViewPunch(pitchDeg: number): void;
  /** Spawn facing: yaw 0, pitch 0, looking toward -Z. Sensitivity is kept. */
  reset(): void;
  readonly yaw: number;
  readonly pitch: number;
  readonly sensitivity: number;
  readonly view: LookView;
}

export function createLook(camera: PerspectiveCamera): LookRig {
  const direction = new Vector3();
  // Setting euler order rewrites the quaternion from the old angles. Put the
  // lookAt orientation back so the view does not jump, then read yaw/pitch
  // from that direction.
  const orientation = camera.quaternion.clone();
  camera.rotation.order = "YXZ";
  camera.quaternion.copy(orientation);
  camera.getWorldDirection(direction);
  let yaw = wrapYaw(Math.atan2(-direction.x, -direction.z) * RAD2DEG);
  let pitch = clampPitch(Math.asin(clampUnit(direction.y)) * RAD2DEG);
  let sensitivity = MOUSE_SENSITIVITY_DEG_PER_PIXEL;

  function write(): void {
    camera.rotation.x = pitch * DEG2RAD;
    camera.rotation.y = yaw * DEG2RAD;
    camera.rotation.z = 0;
  }

  return {
    apply(movementX: number, movementY: number): void {
      if (movementX === 0 && movementY === 0) return;
      const next = applyMouseLook(yaw, pitch, movementX, movementY, sensitivity);
      yaw = next.yaw;
      pitch = next.pitch;
      write();
    },
    nudgeSensitivity(direction: -1 | 1): void {
      sensitivity = stepSensitivity(sensitivity, direction);
    },
    setViewPunch(pitchDeg: number): void {
      camera.rotation.x = clampPitch(pitch + pitchDeg) * DEG2RAD;
      camera.rotation.y = yaw * DEG2RAD;
      camera.rotation.z = 0;
    },
    reset(): void {
      yaw = 0;
      pitch = 0;
      write();
    },
    resize(width: number, height: number): void {
      const aspect = Math.max(width, 1) / Math.max(height, 1);
      camera.aspect = aspect;
      camera.fov = verticalFovDeg(HORIZONTAL_FOV_DEG, aspect);
      camera.updateProjectionMatrix();
    },
    get yaw() {
      return yaw;
    },
    get pitch() {
      return pitch;
    },
    get sensitivity() {
      return sensitivity;
    },
    view: {
      get verticalFov() {
        return camera.fov;
      },
      get aspect() {
        return camera.aspect;
      },
      get yaw() {
        return yaw;
      },
      get pitch() {
        return pitch;
      },
    },
  };
}

function clampUnit(value: number): number {
  if (value < -1) return -1;
  if (value > 1) return 1;
  return value;
}
