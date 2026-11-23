import assert from "node:assert/strict";
import test from "node:test";
import { shortBuildId } from "../src/build.ts";

test("the build id is seven hex characters, and a pull-request SHA is only its prefix", () => {
  const merge = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.equal(shortBuildId(merge, "bbbbbbb"), "aaaaaaa");
  assert.equal(shortBuildId("2A02F869c19f20b14ba34b6921ef2d63a41f3cea", null), "2a02f86");
  assert.equal(shortBuildId(undefined, "abc1234"), "abc1234");
  assert.equal(shortBuildId("", "abc1234def9"), "abc1234");
  assert.equal(shortBuildId("not-a-sha", "abc1234"), "abc1234");
  assert.equal(shortBuildId(undefined, undefined), "dev");
  assert.equal(shortBuildId("short", "nope"), "dev");
  assert.equal(shortBuildId("   ", "   "), "dev");
});
