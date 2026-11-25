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
  { type: "quill-charge" },
  { type: "quill-charge-end" },
  { type: "quill-charge-abort" },
  { type: "reload-start" },
  { type: "reload-end" },
  { type: "enemy-hit" },
  { type: "enemy-kill" },
  { type: "wisp-shot" },
  { type: "enforcer-shot" },
  { type: "rusher-windup" },
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
    "charge",
    "charge-end",
    "charge-abort",
    "reload-slide",
    "reload-lock",
    "hit",
    "kill",
    "wisp",
    "enforcer",
    "rusher",
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
  assert.equal(cuePitch("health"), 349.23);
  assert.equal(cuePitch("armor"), 440);
  assert.equal(cuePitch("ammo"), 523.25);
  assert.equal(cuePitch("kill"), 466);
  assert.equal(cuePitch("hit"), 840);
  assert.ok(cuePitch("health") < cuePitch("armor"));
  assert.ok(cuePitch("armor") < cuePitch("ammo"));
  assert.ok((cuePitch("kill") ?? 0) > 200);
  assert.ok((cuePitch("hit") ?? 0) <= 900);
  assert.ok((cuePitch("ammo") ?? 0) * 1.5 <= 900);
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
  assert.equal(audio.setMuted(true), true);
  assert.equal(audio.muted, true);
  assert.equal(master.gain.value, 0);
  assert.equal(audio.setMuted(true), true);
  assert.equal(audio.setMuted(false), false);
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
        gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
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
      return {
        buffer: null,
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
  };
  const audio = createAudio({ AudioContext: class { constructor() { return ctx; } } });
  audio.prime();
  audio.setHp(26);
  audio.tick();
  assert.equal(started, 0);
  audio.setHp(LOW_HP);
  audio.tick();
  // One lub and one dub. The gap below is still one beat.
  assert.equal(started, 2);
  audio.tick();
  assert.equal(started, 2);
  ctx.currentTime = 0.74;
  audio.tick();
  assert.equal(started, 2);
  ctx.currentTime = 0.75;
  audio.tick();
  assert.equal(started, 4);
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
  assert.equal(started, mid + 2);
  audio.cut();
  audio.tick();
  ctx.currentTime = 3;
  audio.tick();
  assert.equal(started, mid + 4);
});

// An octave under the 2–5 kHz band the ear is most sensitive to. The old
// squares sat around 1.7–3.1 kHz and the wisp sweep reached about 2.4 kHz.
const TONE_CEILING_HZ = 900;

function listen(sampleRate = 8000) {
  const osc = [];
  const noise = [];
  const filters = [];
  const gains = [];
  const buffers = [];
  function param(value = 0) {
    return {
      value,
      events: [],
      setValueAtTime(next, time) {
        this.events.push({ op: "set", value: next, time });
      },
      linearRampToValueAtTime(next, time) {
        this.events.push({ op: "linear", value: next, time });
      },
      exponentialRampToValueAtTime(next, time) {
        this.events.push({ op: "expo", value: next, time });
      },
    };
  }
  const ctx = {
    state: "running",
    currentTime: 0,
    destination: {},
    sampleRate,
    resume() {},
    createGain() {
      const node = { gain: param(1), connect() {}, disconnect() {} };
      gains.push(node);
      return node;
    },
    createOscillator() {
      const node = {
        type: "sine",
        frequency: param(0),
        connect() {},
        started: 0,
        stopped: 0,
        stopCount: 0,
        start(when) {
          node.started = when;
        },
        stop(when) {
          node.stopped = when ?? node.stopped;
          if (when === undefined) node.stopCount += 1;
        },
        disconnect() {},
        onended: null,
      };
      osc.push(node);
      return node;
    },
    createBiquadFilter() {
      const node = {
        type: "lowpass",
        frequency: param(350),
        Q: { value: 1 },
        connect() {},
        disconnect() {},
      };
      filters.push(node);
      return node;
    },
    createBuffer(_channels, length, rate) {
      buffers.push({ length, rate });
      return { getChannelData: () => new Float32Array(length) };
    },
    createBufferSource() {
      const node = {
        buffer: null,
        started: 0,
        stopped: 0,
        stopCount: 0,
        connect() {},
        start(when) {
          node.started = when;
        },
        stop(when) {
          node.stopped = when;
          node.stopCount += 1;
        },
        disconnect() {},
        onended: null,
      };
      noise.push(node);
      return node;
    },
  };
  const audio = createAudio({
    AudioContext: class {
      constructor() {
        return ctx;
      }
    },
  });
  audio.prime();
  return { audio, osc, noise, filters, gains, buffers };
}

test("cues stay under 900 Hz, decay instead of swelling, and keep their timing", () => {
  const voices = {
    flechette: { wave: ["square"], from: [640], to: [260], at: [0], toneDur: [0.065], noise: [400], noiseDur: [0.03] },
    dry: { wave: ["square"], from: [520], to: [390], at: [0], toneDur: [0.032], noise: [], noiseDur: [] },
    "reload-slide": { wave: [], from: [], to: [], at: [], toneDur: [], noise: [360], noiseDur: [0.08] },
    "reload-lock": { wave: ["triangle"], from: [160], to: [80], at: [0], toneDur: [0.06], noise: [280], noiseDur: [0.018] },
    hit: { wave: ["square"], from: [840], to: [840], at: [0], toneDur: [0.038], noise: [], noiseDur: [] },
    kill: { wave: ["sine", "sine"], from: [466, 740], to: [466, 740], at: [0, 0.09], toneDur: [0.16, 0.18], noise: [], noiseDur: [] },
    wisp: { wave: ["sawtooth"], from: [280], to: [860], at: [0], toneDur: [0.09], noise: [], noiseDur: [] },
    enforcer: { wave: ["sine"], from: [90], to: [45], at: [0], toneDur: [0.07], noise: [150], noiseDur: [0.04] },
    rusher: { wave: ["sawtooth"], from: [180], to: [540], at: [0], toneDur: [0.14], noise: [], noiseDur: [] },
    health: { wave: ["sine"], from: [349.23], to: [349.23 * 1.5], at: [0], toneDur: [0.11], noise: [], noiseDur: [] },
    armor: { wave: ["sine"], from: [440], to: [660], at: [0], toneDur: [0.11], noise: [], noiseDur: [] },
    ammo: { wave: ["sine"], from: [523.25], to: [523.25 * 1.5], at: [0], toneDur: [0.11], noise: [], noiseDur: [] },
    hurt: { wave: ["sine"], from: [78], to: [40], at: [0], toneDur: [0.11], noise: [130], noiseDur: [0.04] },
    whoosh: { wave: ["sawtooth", "sine"], from: [130, 220], to: [460, 680], at: [0, 0.02], toneDur: [0.3, 0.34], noise: [320], noiseDur: [0.18] },
  };
  const master = listen();
  assert.equal(master.gains[0].gain.value, 0.8);
  const seen = [];
  for (const [cue, expect] of Object.entries(voices)) {
    const heard = listen();
    heard.audio.play(cue);
    assert.equal(heard.osc.length, expect.wave.length, cue);
    assert.equal(heard.noise.length, expect.noise.length, cue);
    const tones = heard.filters.filter((filter) => filter.type === "lowpass");
    const bursts = heard.filters.filter((filter) => filter.type === "bandpass");
    assert.equal(tones.length, expect.wave.length, cue);
    assert.equal(bursts.length, expect.noise.length, cue);
    const sig = [];
    for (let i = 0; i < expect.wave.length; i += 1) {
      const node = heard.osc[i];
      assert.equal(node.type, expect.wave[i], cue);
      const sets = node.frequency.events.filter((event) => event.op === "set");
      const expos = node.frequency.events.filter((event) => event.op === "expo");
      assert.equal(sets.length, 1, cue);
      assert.ok(Math.abs(sets[0].value - expect.from[i]) < 1e-6, `${cue} from ${sets[0].value}`);
      assert.ok(sets[0].value > 0 && sets[0].value <= TONE_CEILING_HZ, cue);
      if (expect.from[i] === expect.to[i]) assert.equal(expos.length, 0, cue);
      else {
        assert.equal(expos.length, 1, cue);
        assert.ok(Math.abs(expos[0].value - expect.to[i]) < 1e-4, `${cue} to ${expos[0].value}`);
        assert.ok(expos[0].value > 0 && expos[0].value <= TONE_CEILING_HZ, cue);
      }
      assert.ok(Math.abs(node.started - expect.at[i]) < 1e-6, cue);
      assert.ok(Math.abs(node.stopped - node.started - expect.toneDur[i]) < 1e-6, `${cue} dur`);
      assert.ok(tones[i].frequency.value <= 1600 && tones[i].frequency.value >= 800, cue);
      assert.ok(tones[i].Q.value <= 0.7, cue);
      sig.push(expect.from[i], expect.to[i]);
    }
    for (let i = 0; i < expect.noise.length; i += 1) {
      assert.ok(Math.abs(bursts[i].frequency.value - expect.noise[i]) < 1e-6, cue);
      assert.ok(bursts[i].frequency.value <= TONE_CEILING_HZ, cue);
      assert.ok(Math.abs(heard.noise[i].stopped - heard.noise[i].started - expect.noiseDur[i]) < 1e-6, cue);
      sig.push(expect.noise[i]);
    }
    for (const node of heard.gains.slice(1)) {
      const set = node.gain.events.find((event) => event.op === "set");
      const expo = node.gain.events.find((event) => event.op === "expo");
      assert.ok(set && expo, cue);
      assert.ok(expo.value > 0 && expo.value <= 0.002, `${cue} tail ${expo.value}`);
      assert.ok(expo.value < set.value, `${cue} swelled to ${expo.value}`);
    }
    seen.push(sig.join(","));
  }
  assert.equal(new Set(seen).size, seen.length);
  assert.ok(voices.whoosh.to[0] > voices.whoosh.from[0]);
  assert.ok(voices.whoosh.to[1] > voices.whoosh.from[1]);
  assert.ok(voices.wisp.to[0] > voices.wisp.from[0]);

  const cap = listen();
  for (let i = 0; i < 8; i += 1) cap.audio.play("dry");
  assert.equal(cap.osc.filter((node) => node.stopCount > 0).length, 0);
  cap.audio.play("dry");
  assert.ok(cap.osc.some((node) => node.stopCount > 0));
});

test("the low-HP heartbeat is a soft lub-dub under 180 Hz with no tone", () => {
  const heard = listen(48000);
  assert.equal(heard.osc.length, 0);
  heard.audio.setHp(LOW_HP);
  heard.audio.tick();
  assert.equal(heard.osc.length, 0);
  assert.equal(heard.noise.length, 2);
  assert.ok(heard.buffers.length >= 1);
  assert.ok(heard.buffers[0].length >= 48000 * 0.2);
  const gap = heard.noise[1].started - heard.noise[0].started;
  assert.ok(gap >= 0.12 && gap <= 0.22, `lub-dub gap ${gap}`);
  assert.equal(heard.filters.length, 2);
  const peaks = [];
  for (const filter of heard.filters) {
    assert.equal(filter.type, "lowpass");
    assert.ok(filter.Q.value <= 0.7, `Q ${filter.Q.value}`);
    assert.ok(filter.frequency.value >= 120 && filter.frequency.value <= 180);
    for (const event of filter.frequency.events) {
      assert.equal(event.op, "set");
      assert.ok(event.value <= 180 && event.value >= 120);
    }
  }
  const pulses = heard.gains.slice(1);
  assert.equal(pulses.length, 2);
  for (const node of pulses) {
    assert.equal(node.gain.value, 0);
    const set = node.gain.events.find((event) => event.op === "set");
    const rise = node.gain.events.find((event) => event.op === "linear");
    const tail = node.gain.events.find((event) => event.op === "expo");
    assert.ok(set && rise && tail);
    assert.ok(set.value <= 0.01, `attack starts at ${set.value}`);
    assert.ok(rise.time - set.time >= 0.03, "soft attack");
    assert.ok(tail.time > rise.time);
    assert.ok(tail.value > 0 && tail.value <= 0.002);
    assert.ok(tail.value < rise.value);
    peaks.push(rise.value);
  }
  // White noise through a 160 Hz lowpass is quiet, so the lub peak sits above 1.
  assert.ok(peaks[0] >= 1.5 && peaks[0] <= 3);
  assert.ok(peaks[1] >= 0.8 && peaks[1] < peaks[0]);
});

test("the quill charge hum rises under 900 Hz through the 1200 Hz lowpass", () => {
  const heard = listen();
  heard.audio.play("charge");
  assert.equal(heard.osc.length, 1);
  const node = heard.osc[0];
  assert.equal(node.type, "sawtooth");
  assert.equal(node.stopCount, 0);
  const from = node.frequency.events.find((event) => event.op === "set");
  const to = node.frequency.events.find((event) => event.op === "expo");
  assert.ok(from && to);
  assert.ok(to.value > from.value, `hum ${from.value} did not rise to ${to.value}`);
  assert.ok(from.value > 0 && from.value <= 900, `hum start ${from.value}`);
  assert.ok(to.value <= 900, `hum peak ${to.value}`);
  assert.ok(Math.abs(to.time - from.time - 0.45) < 1e-6, "hum does not follow the 0.45 s charge");
  const toneFilter = heard.filters.find((filter) => filter.type === "lowpass");
  assert.ok(toneFilter);
  assert.equal(toneFilter.frequency.value, 1200);
  assert.ok(toneFilter.Q.value <= 0.7);
  for (const event of toneFilter.frequency.events) {
    assert.ok(event.value <= 1200, `lowpass opened to ${event.value}`);
  }
  heard.audio.play("charge-abort");
  assert.ok(node.stopCount > 0, "the abort left the hum running");
  assert.equal(heard.osc.length, 2);
  const blip = heard.osc[1];
  const blipFrom = blip.frequency.events.find((event) => event.op === "set");
  const blipTo = blip.frequency.events.find((event) => event.op === "expo");
  assert.ok(blipFrom && blipTo);
  assert.ok(blipTo.value < blipFrom.value);
  assert.ok(blipFrom.value <= 900 && blipTo.value <= 900);

  const ended = listen();
  ended.audio.play("charge");
  ended.audio.play("charge-end");
  assert.equal(ended.osc.length, 1);
  assert.ok(ended.osc[0].stopCount > 0, "firing the burst left the hum running");
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
