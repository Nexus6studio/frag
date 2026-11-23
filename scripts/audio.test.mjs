import assert from "node:assert/strict";
import test from "node:test";
import { ATRIUM_PADS, ATRIUM_SPAWN, createAtriumHull } from "../src/atrium.ts";
import { createAudio } from "../src/audio.ts";
import {
  LOW_HP,
  cueFor,
  cuePitch,
  heartbeatWanted,
  hurtFromVitals,
} from "../src/cues.ts";
import { createEnforcerSim } from "../src/enforcer.ts";
import { createHitboxWorld } from "../src/hitbox.ts";
import { createPickupSim } from "../src/pickups.ts";
import { createPlayerState } from "../src/player/state.ts";
import { createQuill } from "../src/quill.ts";
import { WISP_TELEGRAPH, WISP_WAVE1_SPAWN_GRACE, createWispSim } from "../src/wisp.ts";

const EVENTS = [
  { type: "quill-shot" },
  { type: "quill-dry" },
  { type: "reload-start" },
  { type: "reload-end" },
  { type: "enemy-hit" },
  { type: "enemy-kill" },
  { type: "wisp-shot" },
  { type: "enforcer-shot" },
  { type: "pickup", kind: "health" },
  { type: "pickup", kind: "armor" },
  { type: "pickup", kind: "ammo" },
  { type: "player-hurt" },
  { type: "jump-pad" },
];

test("the jump-pad whoosh sweeps upward", () => {
  const starts = [];
  const ends = [];
  const ctx = {
    state: "running",
    currentTime: 0,
    destination: {},
    sampleRate: 8000,
    resume() {},
    createGain() {
      return {
        gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        disconnect() {},
      };
    },
    createOscillator() {
      return {
        type: "sine",
        frequency: {
          value: 0,
          setValueAtTime(value) {
            starts.push(value);
          },
          exponentialRampToValueAtTime(value) {
            ends.push(value);
          },
        },
        connect() {},
        start() {},
        stop() {},
        disconnect() {},
        onended: null,
      };
    },
    createBiquadFilter() {
      return {
        type: "lowpass",
        frequency: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} },
        Q: { value: 0 },
        connect() {},
        disconnect() {},
      };
    },
    createBuffer() {
      return { getChannelData: () => new Float32Array(8) };
    },
    createBufferSource() {
      return { buffer: null, connect() {}, start() {}, stop() {}, disconnect() {}, onended: null };
    },
  };
  const audio = createAudio({ AudioContext: class { constructor() { return ctx; } } });
  audio.prime();
  audio.play("whoosh");
  assert.ok(starts.length >= 2, `whoosh tones ${starts.length}`);
  assert.equal(ends.length, starts.length);
  for (let i = 0; i < starts.length; i += 1) {
    assert.ok(ends[i] > starts[i], `whoosh ${starts[i]} did not rise to ${ends[i]}`);
  }
});

test("each sim event maps to its own cue", () => {
  const cues = EVENTS.map((event) => cueFor(event));
  assert.deepEqual(cues, [
    "flechette",
    "dry",
    "reload-slide",
    "reload-lock",
    "hit",
    "kill",
    "wisp",
    "enforcer",
    "health",
    "armor",
    "ammo",
    "hurt",
    "whoosh",
  ]);
  assert.equal(new Set(cues).size, cues.length);
  assert.notEqual(cuePitch("health"), cuePitch("armor"));
  assert.notEqual(cuePitch("armor"), cuePitch("ammo"));
  assert.notEqual(cuePitch("health"), cuePitch("ammo"));
  assert.notEqual(cuePitch("hit"), cuePitch("kill"));
  assert.ok((cuePitch("kill") ?? 0) > 200);
});

test("the heartbeat runs at 25 HP and stops above that, at 0, and on a restart", () => {
  assert.equal(LOW_HP, 25);
  assert.equal(heartbeatWanted(25), true);
  assert.equal(heartbeatWanted(1), true);
  assert.equal(heartbeatWanted(26), false);
  assert.equal(heartbeatWanted(100), false);
  assert.equal(heartbeatWanted(0), false);
  assert.equal(heartbeatWanted(-3), false);
  assert.equal(heartbeatWanted(Number.NaN), false);
  assert.equal(hurtFromVitals(40, 28), true);
  assert.equal(hurtFromVitals(20, 45), false);
  assert.equal(hurtFromVitals(0, 100), false);
  assert.equal(hurtFromVitals(100, 100), false);
});

test("mute toggles the master gain and stays in memory", () => {
  const master = { gain: { value: 1 }, connect() {}, disconnect() {} };
  let gains = 0;
  const ctx = {
    state: "running",
    currentTime: 0,
    destination: {},
    sampleRate: 8000,
    resume() {
      return Promise.resolve();
    },
    createGain() {
      gains += 1;
      if (gains === 1) return master;
      return {
        gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        disconnect() {},
      };
    },
    createOscillator() {
      return {
        type: "sine",
        frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        start() {},
        stop() {},
        disconnect() {},
        onended: null,
      };
    },
    createBiquadFilter() {
      return {
        type: "lowpass",
        frequency: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} },
        Q: { value: 0 },
        connect() {},
        disconnect() {},
      };
    },
    createBuffer() {
      return { getChannelData: () => new Float32Array(8) };
    },
    createBufferSource() {
      return { buffer: null, connect() {}, start() {}, stop() {}, disconnect() {}, onended: null };
    },
  };
  const audio = createAudio({ AudioContext: class { constructor() { return ctx; } } });
  audio.prime();
  assert.equal(audio.muted, false);
  assert.equal(audio.toggleMute(), true);
  assert.equal(audio.muted, true);
  assert.equal(master.gain.value, 0);
  assert.equal(audio.toggleMute(), false);
  assert.equal(master.gain.value > 0, true);
  audio.play("flechette");
  audio.cut();
});

test("a missing or throwing AudioContext stays silent", async () => {
  const logs = [];
  const original = console.error;
  console.error = (...args) => {
    logs.push(args.join(" "));
  };
  try {
    const missing = createAudio({});
    assert.doesNotThrow(() => {
      missing.prime();
      missing.play("hurt");
      missing.setHp(10);
      missing.tick();
      missing.toggleMute();
      missing.cut();
    });
    assert.equal(missing.muted, true);

    const blocked = createAudio({
      AudioContext: class {
        constructor() {
          throw new Error("blocked");
        }
      },
    });
    assert.doesNotThrow(() => {
      blocked.prime();
      blocked.play("flechette");
      blocked.toggleMute();
      blocked.tick();
    });

    let rejected = false;
    const suspended = createAudio({
      AudioContext: class {
        constructor() {
          return {
            state: "suspended",
            currentTime: 0,
            destination: {},
            sampleRate: 8000,
            resume() {
              return Promise.reject(new Error("gesture"));
            },
            createGain() {
              return { gain: { value: 1 }, connect() {}, disconnect() {} };
            },
            createOscillator() {
              throw new Error("no node");
            },
            createBiquadFilter() {
              throw new Error("no node");
            },
            createBuffer() {
              throw new Error("no node");
            },
            createBufferSource() {
              throw new Error("no node");
            },
          };
        }
      },
    });
    suspended.prime();
    suspended.play("dry");
    suspended.setHp(LOW_HP);
    suspended.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    rejected = true;
    assert.equal(rejected, true);
  } finally {
    console.error = original;
  }
  assert.deepEqual(logs, []);
});

test("the heartbeat voice follows the HP band", () => {
  let started = 0;
  let stopped = 0;
  const ctx = {
    state: "running",
    currentTime: 0,
    destination: {},
    sampleRate: 8000,
    resume() {
      return Promise.resolve();
    },
    createGain() {
      return {
        gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        disconnect() {},
      };
    },
    createOscillator() {
      return {
        type: "sine",
        frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect() {},
        start() {
          started += 1;
        },
        stop() {
          stopped += 1;
        },
        disconnect() {},
        onended: null,
      };
    },
    createBiquadFilter() {
      return {
        type: "lowpass",
        frequency: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} },
        Q: { value: 0 },
        connect() {},
        disconnect() {},
      };
    },
    createBuffer() {
      return { getChannelData: () => new Float32Array(8) };
    },
    createBufferSource() {
      return { buffer: null, connect() {}, start() {}, stop() {}, disconnect() {}, onended: null };
    },
  };
  const audio = createAudio({ AudioContext: class { constructor() { return ctx; } } });
  audio.prime();
  audio.setHp(26);
  audio.tick();
  assert.equal(started, 0);
  audio.setHp(LOW_HP);
  audio.tick();
  assert.equal(started, 1);
  audio.tick();
  assert.equal(started, 1);
  ctx.currentTime = 1;
  audio.tick();
  assert.equal(started, 2);
  const mid = started;
  const stops = stopped;
  audio.setHp(0);
  audio.tick();
  assert.equal(started, mid);
  assert.ok(stopped > stops);
  audio.setHp(100);
  audio.tick();
  assert.equal(started, mid);
  audio.setHp(10);
  audio.tick();
  assert.equal(started, mid + 1);
  audio.cut();
  audio.tick();
  ctx.currentTime = 3;
  audio.tick();
  assert.equal(started, mid + 2);
});

test("the quill reports a shot, the reload, and a dry click", () => {
  const events = [];
  const quill = createQuill({
    hitboxes: createHitboxWorld(),
    onEvent: (event) => events.push(event.type),
  });
  const origin = { x: 0, y: 0, z: 0 };
  const direction = { x: 0, y: 0, z: -1 };
  const paced = (fire, presses, reload = false) => ({ fire, presses, reload, origin, direction });
  quill.update(0.02, paced(true, 1));
  assert.deepEqual(events, ["quill-shot"]);
  quill.update(0.02, paced(false, 0, true));
  assert.equal(events.at(-1), "reload-start");
  quill.update(1.4, paced(false, 0));
  assert.equal(events.at(-1), "reload-end");
  // One round was spent, so the reserve can no longer fill a second magazine.
  quill.update(6, paced(true, 0));
  assert.equal(quill.reloading, true);
  quill.update(1.4, paced(false, 0));
  assert.equal(quill.reserve, 0);
  quill.update(6, paced(true, 0));
  assert.equal(quill.mag, 0);
  assert.equal(quill.reserve, 0);
  assert.equal(quill.reloading, false);
  const before = events.length;
  quill.update(0.02, paced(false, 1));
  assert.equal(events[before], "quill-dry");
});

test("pickups, drones, and the enforcer report the cues they cause", () => {
  const picked = [];
  const player = createPlayerState({ hp: 40, armor: 0 });
  const pads = createPickupSim(null, ATRIUM_PADS, (event) => {
    if (event.type === "pickup") picked.push(event.kind);
  });
  for (const kind of ["health", "armor", "ammo"]) {
    const pad = pads.pads.find((entry) => entry.kind === kind);
    assert.ok(pad);
    pads.step(0, { x: pad.x, y: pad.y, z: pad.z }, player);
  }
  assert.deepEqual(picked, ["health", "armor", "ammo"]);

  const quiet = [];
  const full = createPlayerState();
  const untouched = createPickupSim(null, ATRIUM_PADS, (event) => quiet.push(event));
  const health = untouched.pads.find((entry) => entry.kind === "health");
  untouched.step(0, { x: health.x, y: health.y, z: health.z }, full);
  assert.deepEqual(quiet, []);

  const fight = [];
  const hull = createAtriumHull();
  const wisps = createWispSim({
    hull,
    player: createPlayerState(),
    hitboxes: createHitboxWorld(),
    origin: ATRIUM_SPAWN,
    onEvent: (event) => fight.push(event.type),
  });
  let time = 0;
  const feet = { x: ATRIUM_SPAWN.x, y: ATRIUM_SPAWN.y, z: ATRIUM_SPAWN.z };
  while (time < WISP_WAVE1_SPAWN_GRACE + WISP_TELEGRAPH + 0.3 && !fight.includes("wisp-shot")) {
    wisps.update(1 / 120, feet);
    time += 1 / 120;
  }
  assert.ok(fight.includes("wisp-shot"));
  wisps.hurt(0, 9);
  wisps.hurt(0, 100);
  assert.ok(fight.includes("enemy-hit"));
  assert.ok(fight.includes("enemy-kill"));

  const hound = [];
  const enforcers = createEnforcerSim({
    hull,
    player: createPlayerState(),
    hitboxes: createHitboxWorld(),
    onEvent: (event) => hound.push(event.type),
  });
  enforcers.place(0, { x: 4, y: 0, z: 4 });
  enforcers.hurt(0, 9);
  enforcers.hurt(0, 400);
  assert.deepEqual(hound, ["enemy-hit", "enemy-kill"]);
});
