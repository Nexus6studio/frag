// Procedural Web Audio cues. No samples, no files, no network.
//
// The context is created on the first gesture (Continue, click-to-play, or M).
// A missing, suspended, or throwing AudioContext stays silent and does not log.
// Mute is a master gain held in memory. One-shots share a cap; the heartbeat
// is a single voice that stops when HP leaves the low band, including death.

import { cuePitch, heartbeatWanted, type CueId } from "./cues.ts";

const MAX_VOICES = 8;
const HEART_GAP = 0.75;
const MASTER = 0.8;

interface Param {
  value: number;
  setValueAtTime?(value: number, time: number): void;
  linearRampToValueAtTime?(value: number, time: number): void;
  exponentialRampToValueAtTime?(value: number, time: number): void;
}

interface NodeLike {
  connect(dest: unknown): void;
  disconnect(): void;
}

interface GainLike extends NodeLike {
  gain: Param;
}

interface OscLike extends NodeLike {
  type: string;
  frequency: Param;
  start(when?: number): void;
  stop(when?: number): void;
  onended: (() => void) | null;
}

interface FilterLike extends NodeLike {
  type: string;
  frequency: Param;
  Q: { value: number };
}

interface NoiseLike extends NodeLike {
  buffer: { getChannelData(channel: number): Float32Array } | null;
  start(when?: number): void;
  stop(when?: number): void;
  onended: (() => void) | null;
}

interface AudioCtx {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  readonly sampleRate: number;
  resume(): Promise<void> | void;
  createGain(): GainLike;
  createOscillator(): OscLike;
  createBiquadFilter(): FilterLike;
  createBuffer(channels: number, length: number, sampleRate: number): { getChannelData(channel: number): Float32Array };
  createBufferSource(): NoiseLike;
}

export interface AudioHost {
  AudioContext?: new () => AudioCtx;
}

interface Tone {
  type: string;
  from: number;
  to: number;
  dur: number;
  gain: number;
  at: number;
}

interface Noise {
  dur: number;
  gain: number;
  freq: number;
  at: number;
}

interface Recipe {
  dur: number;
  tones: readonly Tone[];
  noise: readonly Noise[];
}

interface Live {
  stop: () => void;
  until: number;
}

const RECIPES: Record<CueId, Recipe> = {
  flechette: {
    dur: 0.05,
    tones: [{ type: "square", from: 1760, to: 520, dur: 0.045, gain: 0.12, at: 0 }],
    noise: [{ dur: 0.03, gain: 0.08, freq: 1800, at: 0 }],
  },
  dry: {
    dur: 0.016,
    tones: [{ type: "square", from: 2093, to: 1600, dur: 0.012, gain: 0.05, at: 0 }],
    noise: [],
  },
  "reload-slide": {
    dur: 0.09,
    tones: [],
    noise: [{ dur: 0.08, gain: 0.12, freq: 900, at: 0 }],
  },
  "reload-lock": {
    dur: 0.05,
    tones: [{ type: "triangle", from: 180, to: 90, dur: 0.04, gain: 0.16, at: 0 }],
    noise: [{ dur: 0.018, gain: 0.1, freq: 2400, at: 0 }],
  },
  hit: {
    dur: 0.02,
    tones: [{ type: "square", from: cuePitch("hit") ?? 3100, to: cuePitch("hit") ?? 3100, dur: 0.018, gain: 0.07, at: 0 }],
    noise: [],
  },
  kill: {
    dur: 0.26,
    tones: [
      { type: "sine", from: cuePitch("kill") ?? 740, to: cuePitch("kill") ?? 740, dur: 0.14, gain: 0.12, at: 0 },
      { type: "sine", from: 1174, to: 1174, dur: 0.16, gain: 0.1, at: 0.09 },
    ],
    noise: [],
  },
  wisp: {
    dur: 0.08,
    tones: [{ type: "sawtooth", from: 380, to: 2400, dur: 0.07, gain: 0.07, at: 0 }],
    noise: [],
  },
  enforcer: {
    dur: 0.06,
    tones: [{ type: "sine", from: 110, to: 55, dur: 0.05, gain: 0.18, at: 0 }],
    noise: [{ dur: 0.04, gain: 0.14, freq: 420, at: 0 }],
  },
  health: chirp(cuePitch("health") ?? 523.25),
  armor: chirp(cuePitch("armor") ?? 659.25),
  ammo: chirp(cuePitch("ammo") ?? 880),
  hurt: {
    dur: 0.1,
    tones: [{ type: "sine", from: 96, to: 48, dur: 0.09, gain: 0.22, at: 0 }],
    noise: [{ dur: 0.04, gain: 0.06, freq: 200, at: 0 }],
  },
};

function chirp(root: number): Recipe {
  return {
    dur: 0.1,
    tones: [{ type: "sine", from: root, to: root * 1.5, dur: 0.09, gain: 0.12, at: 0 }],
    noise: [],
  };
}

function hostCtor(host: AudioHost | undefined): (new () => AudioCtx) | null {
  if (host && "AudioContext" in host) return host.AudioContext ?? null;
  const g = globalThis as { AudioContext?: new () => AudioCtx; webkitAudioContext?: new () => AudioCtx };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

function settle(result: Promise<void> | void): void {
  if (result && typeof result.then === "function") void result.then(() => {}, () => {});
}

function at(param: Param, value: number, time: number): void {
  if (param.setValueAtTime) param.setValueAtTime(value, time);
  else param.value = value;
}

function ramp(param: Param, value: number, time: number): void {
  const safe = Math.max(1, value);
  if (param.exponentialRampToValueAtTime) param.exponentialRampToValueAtTime(safe, time);
  else if (param.linearRampToValueAtTime) param.linearRampToValueAtTime(safe, time);
  else param.value = safe;
}

export function createAudio(host?: AudioHost): {
  prime(): void;
  play(cue: CueId): void;
  toggleMute(): boolean;
  readonly muted: boolean;
  setHp(hp: number): void;
  tick(): void;
  cut(): void;
} {
  const Ctor = hostCtor(host);
  let ctx: AudioCtx | null = null;
  let master: GainLike | null = null;
  let noise: { getChannelData(channel: number): Float32Array } | null = null;
  let dead = false;
  let muted = false;
  let beating = false;
  let nextBeat = 0;
  let heartStop: (() => void) | null = null;
  const live: Live[] = [];

  function prime(): void {
    if (dead) return;
    try {
      if (!ctx) {
        if (!Ctor) return;
        ctx = new Ctor();
        master = ctx.createGain();
        master.gain.value = muted ? 0 : MASTER;
        master.connect(ctx.destination);
      }
      if (ctx.state === "suspended") settle(ctx.resume());
    } catch {
      dead = true;
      ctx = null;
      master = null;
    }
  }

  function noiseBuffer(): { getChannelData(channel: number): Float32Array } | null {
    if (!ctx) return null;
    if (noise) return noise;
    const rate = ctx.sampleRate > 0 ? ctx.sampleRate : 44100;
    const buffer = ctx.createBuffer(1, 4096, rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    noise = buffer;
    return buffer;
  }

  function stopper(nodes: NodeLike[], halt: () => void): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      try {
        halt();
      } catch {
        // stop() throws once the node has already ended.
      }
      for (const node of nodes) {
        try {
          node.disconnect();
        } catch {
          // already disconnected
        }
      }
    };
  }

  function tone(spec: Tone, now: number): () => void {
    if (!ctx || !master) return () => {};
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = spec.type;
    filter.type = "lowpass";
    filter.frequency.value = 4200;
    filter.Q.value = 0.7;
    const start = now + spec.at;
    at(osc.frequency, spec.from, start);
    if (spec.to !== spec.from) ramp(osc.frequency, spec.to, start + spec.dur);
    at(gain.gain, spec.gain, start);
    ramp(gain.gain, 0.001, start + spec.dur);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    osc.start(start);
    osc.stop(start + spec.dur + 0.02);
    const stop = stopper([osc, filter, gain], () => osc.stop());
    osc.onended = stop;
    return stop;
  }

  function burst(spec: Noise, now: number): () => void {
    if (!ctx || !master) return () => {};
    const buffer = noiseBuffer();
    if (!buffer) return () => {};
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    source.buffer = buffer;
    filter.type = "bandpass";
    filter.frequency.value = spec.freq;
    filter.Q.value = 0.8;
    const start = now + spec.at;
    at(gain.gain, spec.gain, start);
    ramp(gain.gain, 0.001, start + spec.dur);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(start);
    source.stop(start + spec.dur);
    const stop = stopper([source, filter, gain], () => source.stop());
    source.onended = stop;
    return stop;
  }

  function prune(now: number): void {
    for (let i = live.length - 1; i >= 0; i -= 1) {
      const voice = live[i]!;
      if (voice.until > now) continue;
      voice.stop();
      live.splice(i, 1);
    }
  }

  function play(cue: CueId): void {
    if (dead || !ctx || !master) return;
    try {
      const now = ctx.currentTime;
      prune(now);
      while (live.length >= MAX_VOICES) live.shift()?.stop();
      const recipe = RECIPES[cue];
      const stops: Array<() => void> = [];
      for (const spec of recipe.tones) stops.push(tone(spec, now));
      for (const spec of recipe.noise) stops.push(burst(spec, now));
      live.push({
        until: now + recipe.dur,
        stop() {
          for (const stop of stops) stop();
        },
      });
    } catch {
      // A node op failed. Later cues still try.
    }
  }

  function stopHeart(): void {
    const stop = heartStop;
    heartStop = null;
    if (stop) stop();
  }

  function thump(): void {
    if (!ctx || !master) return;
    stopHeart();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = "sine";
    osc.frequency.value = 58;
    filter.type = "lowpass";
    at(filter.frequency, 90, now);
    if (filter.frequency.linearRampToValueAtTime) filter.frequency.linearRampToValueAtTime(200, now + 0.08);
    filter.Q.value = 0.6;
    at(gain.gain, 0.1, now);
    ramp(gain.gain, 0.001, now + 0.1);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    osc.start(now);
    osc.stop(now + 0.12);
    const stop = stopper([osc, filter, gain], () => osc.stop());
    osc.onended = stop;
    heartStop = stop;
  }

  return {
    prime,
    play,
    toggleMute(): boolean {
      muted = !muted;
      try {
        if (master) master.gain.value = muted ? 0 : MASTER;
      } catch {
        // The flag still flips. The gain node is already gone.
      }
      return muted;
    },
    get muted() {
      return muted;
    },
    setHp(hp: number): void {
      const want = heartbeatWanted(hp);
      if (want && !beating) nextBeat = ctx?.currentTime ?? 0;
      beating = want;
      if (!want) stopHeart();
    },
    tick(): void {
      if (!beating || dead || !ctx || ctx.state !== "running") return;
      try {
        if (ctx.currentTime + 1e-4 < nextBeat) return;
        nextBeat = ctx.currentTime + HEART_GAP;
        thump();
      } catch {
        stopHeart();
      }
    },
    cut(): void {
      for (const voice of live) voice.stop();
      live.length = 0;
      stopHeart();
    },
  };
}
