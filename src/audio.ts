// Procedural Web Audio cues. No samples, no files, no network.
//
// The context is created on the first gesture (Continue, click-to-play, or M).
// A missing, suspended, or throwing AudioContext stays silent and does not log.
// Mute is a master gain held in memory. One-shots share a cap of eight.
// Oscillator fundamentals stay at or under 900 Hz, and tones pass a soft lowpass,
// so the short squares are not up in the ear's sensitive 2–5 kHz band.
// The Quill charge is a sawtooth hum that rises across the 0.45 s hold and
// uses that same lowpass. Releasing the charge, or firing it, stops the hum.
// The rusher windup is a short sawtooth from 180 Hz to 540 Hz on that lowpass.
// The low-HP heartbeat is a lub-dub of lowpassed noise. It stops when HP leaves
// the low band, including death, and the beats stay 0.75 s apart.

import { cuePitch, heartbeatWanted, type CueId } from "./cues.ts";

const MAX_VOICES = 8;
const HEART_GAP = 0.75;
const MASTER = 0.8;
// Under the 2–5 kHz range where the old squares and sweeps sat. Harmonics of a
// square still exist, so the tone path also closes above this.
const TONE_CEILING = 900;
const TONE_LOWPASS = 1200;
// A murmur heard through the body, inside the 150–200 Hz window.
const HEART_LOWPASS = 160;

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
    tones: [{ type: "square", from: 640, to: 260, dur: 0.045, gain: 0.12, at: 0 }],
    noise: [{ dur: 0.03, gain: 0.08, freq: 400, at: 0 }],
  },
  dry: {
    dur: 0.016,
    tones: [{ type: "square", from: 520, to: 390, dur: 0.012, gain: 0.05, at: 0 }],
    noise: [],
  },
  // Rising hum for the Quill charge. The fundamental stays under 900 Hz.
  // play() runs this as a voice that can be stopped early.
  charge: {
    dur: 0.45,
    tones: [{ type: "sawtooth", from: 196, to: 880, dur: 0.45, gain: 0.07, at: 0 }],
    noise: [],
  },
  "charge-end": {
    dur: 0.01,
    tones: [],
    noise: [],
  },
  "charge-abort": {
    dur: 0.08,
    tones: [{ type: "sine", from: 480, to: 180, dur: 0.07, gain: 0.06, at: 0 }],
    noise: [],
  },
  "reload-slide": {
    dur: 0.09,
    tones: [],
    noise: [{ dur: 0.08, gain: 0.12, freq: 360, at: 0 }],
  },
  "reload-lock": {
    dur: 0.05,
    tones: [{ type: "triangle", from: 160, to: 80, dur: 0.04, gain: 0.16, at: 0 }],
    noise: [{ dur: 0.018, gain: 0.1, freq: 280, at: 0 }],
  },
  hit: {
    dur: 0.02,
    tones: [{ type: "square", from: cuePitch("hit") ?? 840, to: cuePitch("hit") ?? 840, dur: 0.018, gain: 0.07, at: 0 }],
    noise: [],
  },
  kill: {
    dur: 0.26,
    tones: [
      { type: "sine", from: cuePitch("kill") ?? 466, to: cuePitch("kill") ?? 466, dur: 0.14, gain: 0.12, at: 0 },
      { type: "sine", from: 740, to: 740, dur: 0.16, gain: 0.1, at: 0.09 },
    ],
    noise: [],
  },
  wisp: {
    dur: 0.08,
    tones: [{ type: "sawtooth", from: 280, to: 860, dur: 0.07, gain: 0.07, at: 0 }],
    noise: [],
  },
  enforcer: {
    dur: 0.06,
    tones: [{ type: "sine", from: 90, to: 45, dur: 0.05, gain: 0.18, at: 0 }],
    noise: [{ dur: 0.04, gain: 0.14, freq: 150, at: 0 }],
  },
  // Windup tell. Fundamental stays under 900 Hz and uses the shared tone lowpass.
  rusher: {
    dur: 0.14,
    tones: [{ type: "sawtooth", from: 180, to: 540, dur: 0.12, gain: 0.09, at: 0 }],
    noise: [],
  },
  health: chirp(cuePitch("health") ?? 349.23),
  armor: chirp(cuePitch("armor") ?? 440),
  ammo: chirp(cuePitch("ammo") ?? 523.25),
  hurt: {
    dur: 0.1,
    tones: [{ type: "sine", from: 78, to: 40, dur: 0.09, gain: 0.22, at: 0 }],
    noise: [{ dur: 0.04, gain: 0.06, freq: 130, at: 0 }],
  },
  // Rising sweep, an octave under the old whoosh. The jump pad calls this once per launch.
  whoosh: {
    dur: 0.34,
    tones: [
      { type: "sawtooth", from: 130, to: 460, dur: 0.28, gain: 0.07, at: 0 },
      { type: "sine", from: 220, to: 680, dur: 0.32, gain: 0.09, at: 0.02 },
    ],
    noise: [{ dur: 0.18, gain: 0.05, freq: 320, at: 0 }],
  },
};

function chirp(root: number): Recipe {
  return {
    dur: 0.1,
    tones: [{ type: "sine", from: root, to: root * 1.5, dur: 0.09, gain: 0.12, at: 0 }],
    noise: [],
  };
}

for (const recipe of Object.values(RECIPES)) {
  for (const tone of recipe.tones) {
    if (tone.from > TONE_CEILING || tone.to > TONE_CEILING) {
      throw new Error(`cue above ${TONE_CEILING} Hz`);
    }
  }
  for (const burst of recipe.noise) {
    if (burst.freq > TONE_CEILING) throw new Error(`cue above ${TONE_CEILING} Hz`);
  }
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
  // Exponential ramps reject a target of 0. A floor of 1 turned every decay
  // into a swell to unity, and the stop() after it clicked at full scale.
  const safe = value > 0 ? value : 0.001;
  if (param.exponentialRampToValueAtTime) param.exponentialRampToValueAtTime(safe, time);
  else if (param.linearRampToValueAtTime) param.linearRampToValueAtTime(safe, time);
  else param.value = safe;
}

export function createAudio(host?: AudioHost): {
  prime(): void;
  play(cue: CueId): void;
  toggleMute(): boolean;
  setMuted(muted: boolean): boolean;
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
  let chargeVoice: Live | null = null;
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
    // Long enough for the whoosh noise (0.18 s) and a murmur pulse. A 4096-frame
    // buffer is under 0.1 s at 44.1 kHz, so those voices used to cut off mid-envelope.
    const buffer = ctx.createBuffer(1, Math.ceil(rate * 0.5), rate);
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
    filter.frequency.value = TONE_LOWPASS;
    filter.Q.value = 0.5;
    const start = now + spec.at;
    at(filter.frequency, TONE_LOWPASS, start);
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
    at(filter.frequency, spec.freq, start);
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
      if (voice === chargeVoice) chargeVoice = null;
      live.splice(i, 1);
    }
  }

  function endCharge(): void {
    const voice = chargeVoice;
    chargeVoice = null;
    if (!voice) return;
    voice.stop();
    const index = live.indexOf(voice);
    if (index >= 0) live.splice(index, 1);
  }

  function beginCharge(): void {
    if (!ctx || !master || chargeVoice) return;
    const spec = RECIPES.charge.tones[0];
    if (!spec) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = spec.type;
    filter.type = "lowpass";
    filter.frequency.value = TONE_LOWPASS;
    filter.Q.value = 0.5;
    const now = ctx.currentTime;
    at(filter.frequency, TONE_LOWPASS, now);
    at(osc.frequency, spec.from, now);
    if (spec.to !== spec.from) ramp(osc.frequency, spec.to, now + spec.dur);
    at(gain.gain, spec.gain * 0.35, now);
    if (gain.gain.linearRampToValueAtTime) gain.gain.linearRampToValueAtTime(spec.gain, now + spec.dur * 0.9);
    else gain.gain.value = spec.gain;
    ramp(gain.gain, 0.001, now + spec.dur);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    osc.start(now);
    osc.stop(now + spec.dur + 0.02);
    const stop = stopper([osc, filter, gain], () => osc.stop());
    const voice: Live = { stop, until: now + spec.dur + 0.02 };
    osc.onended = () => {
      stop();
      if (chargeVoice === voice) chargeVoice = null;
    };
    chargeVoice = voice;
    live.push(voice);
  }

  function play(cue: CueId): void {
    if (dead || !ctx || !master) return;
    try {
      if (cue === "charge") {
        beginCharge();
        return;
      }
      if (cue === "charge-end") {
        endCharge();
        return;
      }
      if (cue === "charge-abort") endCharge();
      const now = ctx.currentTime;
      prune(now);
      while (live.length >= MAX_VOICES) {
        const dropped = live.shift();
        dropped?.stop();
        if (dropped && dropped === chargeVoice) chargeVoice = null;
      }
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

  // Lub then dub. White noise into a fixed lowpass has no pitch and no sweep.
  // The old voice was a 58 Hz sine, so it read as a beep. Its lowpass opened
  // from 90 Hz to 200 Hz, and the shared gain ramp swelled to 1, so stop()
  // cut the wave at full scale. That step is the click. The player-hurt sting
  // is a separate falling tone and does not play inside this voice.
  const MURMUR = [
    { at: 0.02, attack: 0.05, dur: 0.16, gain: 2 },
    { at: 0.18, attack: 0.04, dur: 0.12, gain: 1.05 },
  ] as const;

  function pulse(spec: (typeof MURMUR)[number], now: number): () => void {
    if (!ctx || !master) return () => {};
    const buffer = noiseBuffer();
    if (!buffer) return () => {};
    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    source.buffer = buffer;
    filter.type = "lowpass";
    filter.Q.value = 0.5;
    filter.frequency.value = HEART_LOWPASS;
    const start = now + spec.at;
    at(filter.frequency, HEART_LOWPASS, start);
    // Most of the noise is above the cutoff, so the peak sits above 1 to leave
    // a soft thump. It still starts at silence and is gone before stop().
    gain.gain.value = 0;
    at(gain.gain, 0.0008, start);
    const peakAt = start + spec.attack;
    if (gain.gain.linearRampToValueAtTime) gain.gain.linearRampToValueAtTime(spec.gain, peakAt);
    else at(gain.gain, spec.gain, peakAt);
    ramp(gain.gain, 0.001, start + spec.dur);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(start);
    source.stop(start + spec.dur + 0.03);
    const stop = stopper([source, filter, gain], () => source.stop());
    source.onended = stop;
    return stop;
  }

  function murmur(): void {
    if (!ctx || !master) return;
    stopHeart();
    const now = ctx.currentTime;
    const stops: Array<() => void> = [];
    heartStop = () => {
      for (const stop of stops) stop();
    };
    for (const spec of MURMUR) stops.push(pulse(spec, now));
  }

  function setMuted(next: boolean): boolean {
    muted = next;
    try {
      if (master) master.gain.value = muted ? 0 : MASTER;
    } catch {
      // The flag still updates. The gain node is already gone.
    }
    return muted;
  }

  return {
    prime,
    play,
    setMuted,
    toggleMute(): boolean {
      return setMuted(!muted);
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
        murmur();
      } catch {
        stopHeart();
      }
    },
    cut(): void {
      for (const voice of live) voice.stop();
      live.length = 0;
      chargeVoice = null;
      stopHeart();
    },
  };
}
