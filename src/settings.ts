// Pause-card preferences. One localStorage key, written only when a setting
// changes. A load never writes, including when the stored record is bad.
// Defaults remove the key so an untouched session leaves storage empty.
// A throwing or missing localStorage stays in memory and does not log.

export const SETTINGS_KEY = "frag:settings:v1";

export const SENSITIVITY_MIN = 0.05;
export const SENSITIVITY_MAX = 0.3;
export const FOV_MIN = 90;
export const FOV_MAX = 115;

export interface PlayerSettings {
  sensitivity: number;
  fov: number;
  muted: boolean;
  invertY: boolean;
}

export const DEFAULT_SETTINGS: PlayerSettings = {
  sensitivity: 0.12,
  fov: 105,
  muted: false,
  invertY: false,
};

export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SettingsHost {
  readonly localStorage: SettingsStorage;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function sanitizeSettings(input: unknown): PlayerSettings {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ...DEFAULT_SETTINGS };
  }
  const record = input as {
    sensitivity?: unknown;
    fov?: unknown;
    muted?: unknown;
    invertY?: unknown;
  };
  const sensitivity = finite(record.sensitivity);
  const fov = finite(record.fov);
  return {
    sensitivity:
      sensitivity === null ? DEFAULT_SETTINGS.sensitivity : clamp(sensitivity, SENSITIVITY_MIN, SENSITIVITY_MAX),
    fov: fov === null ? DEFAULT_SETTINGS.fov : clamp(fov, FOV_MIN, FOV_MAX),
    muted: typeof record.muted === "boolean" ? record.muted : DEFAULT_SETTINGS.muted,
    invertY: typeof record.invertY === "boolean" ? record.invertY : DEFAULT_SETTINGS.invertY,
  };
}

function storageOf(store: SettingsHost): SettingsStorage | null {
  try {
    return store.localStorage;
  } catch {
    return null;
  }
}

export function loadSettings(store: SettingsHost = window): PlayerSettings {
  try {
    const storage = storageOf(store);
    if (!storage) return { ...DEFAULT_SETTINGS };
    const raw = storage.getItem(SETTINGS_KEY);
    if (raw == null || raw === "") return { ...DEFAULT_SETTINGS };
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function matchesDefault(settings: PlayerSettings): boolean {
  return (
    settings.sensitivity === DEFAULT_SETTINGS.sensitivity &&
    settings.fov === DEFAULT_SETTINGS.fov &&
    settings.muted === DEFAULT_SETTINGS.muted &&
    settings.invertY === DEFAULT_SETTINGS.invertY
  );
}

export function saveSettings(settings: PlayerSettings, store: SettingsHost = window): void {
  try {
    const storage = storageOf(store);
    if (!storage) return;
    const clean = sanitizeSettings(settings);
    if (matchesDefault(clean)) {
      storage.removeItem(SETTINGS_KEY);
      return;
    }
    storage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        sensitivity: clean.sensitivity,
        fov: clean.fov,
        muted: clean.muted,
        invertY: clean.invertY,
      }),
    );
  } catch {
    // The caller keeps the in-memory settings. Storage is optional.
  }
}
