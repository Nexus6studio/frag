import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("the shipped bundle does not contain blood", { timeout: 180_000 }, () => {
  const root = path.resolve(import.meta.dirname, "..");
  const build = spawnSync("npm", ["run", "build"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  const dist = path.join(root, "dist");
  const files = walk(dist);
  const hits = [];
  let bytes = 0;
  const listed = [];
  for (const file of files) {
    const stat = fs.statSync(file);
    bytes += stat.size;
    const text = fs.readFileSync(file).toString("utf8");
    if (/blood/i.test(text)) hits.push(path.relative(root, file));
    if (/\.(html|js|css)$/.test(file)) listed.push(`${path.relative(dist, file)} ${stat.size}`);
  }
  assert.deepEqual(hits, [], `blood survived into dist: ${hits.join(", ")}`);
  console.log(`bundle ${bytes} bytes\n${listed.join("\n")}`);
});

function walk(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}
