import assert from "node:assert/strict";
import test from "node:test";
import { bindHud } from "../src/hud/model.ts";
import { createPlayerState } from "../src/player/state.ts";
import {
  SCORES_KEY,
  applyCopyFeedback,
  createScoreBook,
  readClipboard,
  scoreFromRecap,
  scoreLine,
  writeScoreLine,
} from "../src/scores.ts";

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

function field(text) {
  return { textContent: text ?? "" };
}

function badge() {
  return { hidden: true };
}

function fakeHud() {
  return {
    root: { dataset: {} },
    hp: field(),
    armor: field(),
    ammo: field(),
    armorStat: {
      dataset: {},
      style: { visibility: "" },
      attrs: {},
      setAttribute(name, value) {
        this.attrs[name] = value;
      },
      removeAttribute(name) {
        delete this.attrs[name];
      },
    },
    death: {
      hidden: true,
      inert: false,
      style: { display: "", pointerEvents: "" },
      attrs: {},
      setAttribute(name, value) {
        this.attrs[name] = value;
      },
      removeAttribute(name) {
        delete this.attrs[name];
      },
    },
    recap: {
      wave: field(),
      frags: field(),
      time: field(),
      waveBadge: badge(),
      fragsBadge: badge(),
      timeBadge: badge(),
    },
  };
}

function silence(run) {
  const errors = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args) => {
    errors.push(args.join(" "));
  };
  console.warn = (...args) => {
    errors.push(args.join(" "));
  };
  try {
    run();
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  assert.deepEqual(errors, []);
}

test("bests persist across a reload and nothing is written before the first death", () => {
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
  const book = createScoreBook(host(watched));
  assert.equal(book.bests(), null);
  assert.equal(writes, 0);
  assert.deepEqual(storage.keys(), []);

  const first = book.record({ wave: 4, frags: 19, time: 158 });
  assert.deepEqual(first.fresh, { wave: true, frags: true, time: true });
  assert.equal(writes, 1);
  assert.equal(SCORES_KEY, "frag:scores:v1");
  assert.deepEqual(storage.keys(), [SCORES_KEY]);
  assert.equal(storage.getItem(SCORES_KEY), JSON.stringify({ wave: 4, frags: 19, time: 158 }));

  const reloaded = createScoreBook(host(watched));
  assert.equal(writes, 1, "loading wrote");
  assert.deepEqual(reloaded.bests(), { wave: 4, frags: 19, time: 158 });

  const tie = reloaded.record({ wave: 4, frags: 19, time: 158 });
  assert.deepEqual(tie.fresh, { wave: false, frags: false, time: false });
  const fragsOnly = reloaded.record({ wave: 4, frags: 20, time: 100 });
  assert.deepEqual(fragsOnly.fresh, { wave: false, frags: true, time: false });
  assert.deepEqual(reloaded.bests(), { wave: 4, frags: 20, time: 158 });
});

test("a bad record is ignored and not rewritten", () => {
  const storage = memory();
  for (const raw of ["", "not-json", "null", "42", "[]", "true", JSON.stringify({ wave: 1 })]) {
    storage.setItem(SCORES_KEY, raw);
    const book = createScoreBook(host(storage));
    assert.equal(book.bests(), null, raw);
    assert.equal(storage.getItem(SCORES_KEY), raw);
  }
});

test("getItem, setItem, and localStorage access can throw without a console error", () => {
  silence(() => {
    const denied = {
      get localStorage() {
        throw new Error("denied");
      },
    };
    const blocked = createScoreBook(denied);
    assert.equal(blocked.bests(), null);
    const remembered = blocked.record({ wave: 2, frags: 4, time: 9 });
    assert.deepEqual(remembered.fresh, { wave: true, frags: true, time: true });
    assert.deepEqual(blocked.bests(), { wave: 2, frags: 4, time: 9 });
    const tie = blocked.record({ wave: 2, frags: 4, time: 9 });
    assert.deepEqual(tie.fresh, { wave: false, frags: false, time: false });
    const beat = blocked.record({ wave: 2, frags: 5, time: 9 });
    assert.deepEqual(beat.fresh, { wave: false, frags: true, time: false });
    assert.deepEqual(blocked.bests(), { wave: 2, frags: 5, time: 9 });

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
    const book = createScoreBook(host(broken.localStorage));
    assert.equal(book.bests(), null);
    assert.doesNotThrow(() => book.record({ wave: 1, frags: 0, time: 3 }));
    assert.deepEqual(book.bests(), { wave: 1, frags: 0, time: 3 });
  });
});

test("the recap badges only the stats a death actually beat", () => {
  const storage = memory();
  const book = createScoreBook(host(storage));
  const player = createPlayerState();
  const els = fakeHud();
  let recap = { wave: 1, wavesCleared: 0, frags: 3, timeAlive: 12 };
  let deaths = 0;
  const hud = bindHud(player, els, () => "playing", undefined, {
    getRecap: () => recap,
    onDeath: (died) => {
      deaths += 1;
      return book.record(scoreFromRecap(died)).fresh;
    },
  });
  assert.equal(deaths, 0);
  assert.deepEqual(storage.keys(), []);

  player.set({ hp: 0 });
  assert.equal(deaths, 1);
  assert.equal(els.recap.wave.textContent, "Reached wave 1");
  assert.equal(els.recap.waveBadge.hidden, false);
  assert.equal(els.recap.fragsBadge.hidden, false);
  assert.equal(els.recap.timeBadge.hidden, false);
  assert.deepEqual(storage.keys(), [SCORES_KEY]);

  player.set({ armor: 1 });
  assert.equal(deaths, 1, "a downed player recorded twice");

  player.restart();
  player.set({ hp: 0 });
  assert.equal(els.recap.waveBadge.hidden, true, "a tie badged the wave");
  assert.equal(els.recap.fragsBadge.hidden, true, "a tie badged the frags");
  assert.equal(els.recap.timeBadge.hidden, true, "a tie badged the time");

  player.restart();
  recap = { wave: 2, wavesCleared: 1, frags: 3, timeAlive: 10 };
  player.set({ hp: 0 });
  assert.equal(els.recap.wave.textContent, "Reached wave 2");
  assert.equal(els.recap.waveBadge.hidden, false);
  assert.equal(els.recap.fragsBadge.hidden, true);
  assert.equal(els.recap.timeBadge.hidden, true);
  assert.deepEqual(book.bests(), { wave: 2, frags: 3, time: 12 });

  hud.destroy();
});

test("clipboard writes one score line, and a miss shows that line without an error", async () => {
  const errors = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args) => {
    errors.push(args.join(" "));
  };
  console.warn = (...args) => {
    errors.push(args.join(" "));
  };
  try {
    const line = scoreLine({ wave: 4, frags: 19, time: 158 });
    assert.equal(line, "FRAG — Wave 4 | 19 frags | 02:38");

    let written = "";
    const copied = await writeScoreLine(line, {
      writeText(text) {
        written = text;
        return Promise.resolve();
      },
    });
    assert.equal(copied, "copied");
    assert.equal(written, line);
    const confirmed = { button: { textContent: "Copy score" }, line: { hidden: true, value: "" } };
    applyCopyFeedback(confirmed, "copied", line);
    assert.equal(confirmed.button.textContent, "Copied");
    assert.equal(confirmed.line.hidden, true);

    assert.equal(await writeScoreLine(line, null), "fallback");
    assert.equal(await writeScoreLine(line, {}), "fallback");
    assert.equal(
      readClipboard({
        get clipboard() {
          throw new Error("denied");
        },
      }),
      null,
    );
    assert.equal(
      await writeScoreLine(line, {
        writeText() {
          throw new Error("sync");
        },
      }),
      "fallback",
    );
    assert.equal(
      await writeScoreLine(line, {
        async writeText() {
          throw new Error("async");
        },
      }),
      "fallback",
    );
    const field = { button: { textContent: "Copied" }, line: { hidden: true, value: "" } };
    applyCopyFeedback(field, "fallback", line);
    assert.equal(field.button.textContent, "Copy score");
    assert.equal(field.line.hidden, false);
    assert.equal(field.line.value, line);
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  assert.deepEqual(errors, []);
});
