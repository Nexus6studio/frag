import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  loadSettings,
  saveSettings,
} from "../src/settings.ts";

function memory(initial) {
  const values = new Map(initial ?? []);
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    keys() {
      return [...values.keys()];
    },
  };
}

function host(storage) {
  return { localStorage: storage };
}

test("a round trip saves one versioned record and loads it back", () => {
  const storage = memory();
  const next = { sensitivity: 0.2, fov: 100, muted: true, invertY: true };
  saveSettings(next, host(storage));
  assert.deepEqual(storage.keys(), [SETTINGS_KEY]);
  assert.equal(SETTINGS_KEY, "frag:settings:v1");
  assert.deepEqual(loadSettings(host(storage)), next);
});

test("loading does not write, and defaults leave storage empty", () => {
  const storage = memory();
  let writes = 0;
  const watched = {
    getItem(key) {
      return storage.getItem(key);
    },
    setItem(key, value) {
      writes += 1;
      storage.setItem(key, value);
    },
    removeItem(key) {
      writes += 1;
      storage.removeItem(key);
    },
  };
  assert.deepEqual(loadSettings(host(watched)), DEFAULT_SETTINGS);
  assert.equal(writes, 0);
  assert.deepEqual(storage.keys(), []);

  saveSettings({ ...DEFAULT_SETTINGS }, host(watched));
  assert.deepEqual(storage.keys(), [], "defaults were stored");
});

test("out-of-range numbers clamp and bad fields fall back", () => {
  const storage = memory();
  storage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      sensitivity: 4,
      fov: 10,
      muted: "yes",
      invertY: 1,
      extra: true,
    }),
  );
  assert.deepEqual(loadSettings(host(storage)), {
    sensitivity: 0.3,
    fov: 90,
    muted: false,
    invertY: false,
  });

  storage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ sensitivity: 0.01, fov: 200, muted: false, invertY: false }),
  );
  assert.deepEqual(loadSettings(host(storage)), {
    sensitivity: 0.05,
    fov: 115,
    muted: false,
    invertY: false,
  });

  storage.setItem(SETTINGS_KEY, JSON.stringify({ sensitivity: "0.2", fov: null }));
  assert.deepEqual(loadSettings(host(storage)), DEFAULT_SETTINGS);

  for (const raw of ["", "not-json", "null", "42", "[]", "true"]) {
    storage.setItem(SETTINGS_KEY, raw);
    assert.deepEqual(loadSettings(host(storage)), DEFAULT_SETTINGS, raw);
  }
});

test("a missing field keeps that default and does not rewrite storage", () => {
  const storage = memory();
  const raw = JSON.stringify({ fov: 92 });
  storage.setItem(SETTINGS_KEY, raw);
  assert.deepEqual(loadSettings(host(storage)), {
    sensitivity: 0.12,
    fov: 92,
    muted: false,
    invertY: false,
  });
  assert.equal(storage.getItem(SETTINGS_KEY), raw);
});

test("getItem, setItem, and localStorage access can throw without a console error", () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => {
    errors.push(args.join(" "));
  };
  try {
    const denied = {
      get localStorage() {
        throw new Error("denied");
      },
    };
    assert.deepEqual(loadSettings(denied), DEFAULT_SETTINGS);
    assert.doesNotThrow(() => saveSettings({ ...DEFAULT_SETTINGS, fov: 90 }, denied));

    const broken = {
      localStorage: {
        getItem() {
          throw new Error("get");
        },
        setItem() {
          throw new Error("set");
        },
        removeItem() {
          throw new Error("remove");
        },
      },
    };
    assert.deepEqual(loadSettings(host(broken.localStorage)), DEFAULT_SETTINGS);
    assert.doesNotThrow(() => saveSettings({ ...DEFAULT_SETTINGS, muted: true }, host(broken.localStorage)));
  } finally {
    console.error = original;
  }
  assert.deepEqual(errors, []);
});

test("changing a setting and changing it back leaves storage empty", () => {
  const storage = memory();
  saveSettings({ ...DEFAULT_SETTINGS, muted: true }, host(storage));
  assert.equal(loadSettings(host(storage)).muted, true);
  saveSettings({ ...DEFAULT_SETTINGS, muted: false }, host(storage));
  assert.deepEqual(storage.keys(), []);
  assert.deepEqual(loadSettings(host(storage)), DEFAULT_SETTINGS);
});
