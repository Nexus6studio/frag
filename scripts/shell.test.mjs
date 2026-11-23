import assert from "node:assert/strict";
import test from "node:test";
import { unlockShouldPause } from "../src/shell.ts";

test("a pointer-lock release pauses only after the lock has stuck", () => {
  assert.equal(
    unlockShouldPause({ phase: "playing", requestOpen: true, lockStable: false }),
    false,
  );
  assert.equal(
    unlockShouldPause({ phase: "playing", requestOpen: false, lockStable: false }),
    false,
  );
  assert.equal(
    unlockShouldPause({ phase: "playing", requestOpen: false, lockStable: true }),
    true,
  );
  assert.equal(
    unlockShouldPause({ phase: "paused", requestOpen: false, lockStable: true }),
    false,
  );
  assert.equal(
    unlockShouldPause({ phase: "warning", requestOpen: false, lockStable: false }),
    false,
  );
  assert.equal(
    unlockShouldPause({ phase: "playing", requestOpen: false, lockStable: true, hold: true }),
    false,
  );
});
