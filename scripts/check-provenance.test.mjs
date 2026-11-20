import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkRepo, licenseAllowed } from "./check-provenance.mjs";

const ASSETS_HEADER = `# Asset provenance

| path | type | source (AI tool name + version, or CC0 source URL) | license | author/creator | date added |
| --- | --- | --- | --- | --- | --- |
`;

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frag-provenance-"));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  return root;
}

function pkg(name, license) {
  return JSON.stringify({ name, version: "1.0.0", license });
}

test("license expressions accept only the permissive allowlist", () => {
  for (const ok of [
    "MIT",
    "mit",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "Apache-2.0",
    "ISC",
    "0BSD",
    "Unlicense",
    "MIT OR GPL-3.0-only",
    "Apache-2.0 AND MIT",
    "(BSD-3-Clause OR MIT)",
  ]) {
    assert.equal(licenseAllowed(ok).ok, true, ok);
  }

  for (const bad of [
    "",
    "GPL-3.0-only",
    "GPL-2.0-or-later",
    "AGPL-3.0-only",
    "LGPL-2.1-only",
    "LGPL-3.0-or-later",
    "UNKNOWN",
    "WTFPL",
    "MIT AND GPL-3.0-only",
    "GPL-3.0-only OR AGPL-3.0-only",
    "UNLICENSED",
  ]) {
    assert.equal(licenseAllowed(bad).ok, false, bad);
  }

  assert.equal(licenseAllowed({ type: "ISC" }).ok, true);
  assert.equal(licenseAllowed(["MIT", "Apache-2.0"]).ok, true);
});

test("fails on an installed GPL package, including a nested one", () => {
  const root = makeRepo({
    "ASSETS.md": ASSETS_HEADER,
    "node_modules/ok-lib/package.json": pkg("ok-lib", "MIT"),
    "node_modules/evil-gpl/package.json": pkg("evil-gpl", "GPL-3.0-only"),
    "node_modules/wrapper/package.json": pkg("wrapper", "Apache-2.0"),
    "node_modules/wrapper/node_modules/nested-lgpl/package.json": pkg(
      "nested-lgpl",
      "LGPL-2.1-only",
    ),
  });

  const result = checkRepo(root);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /evil-gpl/);
  assert.match(result.errors.join("\n"), /GPL-3\.0-only/);
  assert.match(result.errors.join("\n"), /nested-lgpl/);
});

test("fails when an asset has no provenance row or an empty source or license", () => {
  const root = makeRepo({
    "ASSETS.md": `${ASSETS_HEADER}| public/ok.png | texture | generated in-house | CC0-1.0 | Nexus6 Studio | 2026-11-20 |
| public/blank-license.png | texture | generated in-house |  | Nexus6 Studio | 2026-11-20 |
| src/assets/blank-source.wav | audio |  | CC0-1.0 | Nexus6 Studio | 2026-11-20 |
`,
    "node_modules/ok-lib/package.json": pkg("ok-lib", "MIT"),
    "public/ok.png": "not-a-real-png",
    "public/orphan.png": "not-a-real-png",
    "public/blank-license.png": "not-a-real-png",
    "src/assets/blank-source.wav": "not-a-real-wav",
    "src/assets/notes.ts": "export const x = 1;\n",
    "src/assets/theme.css": "body { color: black; }\n",
  });

  const result = checkRepo(root);
  assert.equal(result.ok, false);
  const text = result.errors.join("\n");
  assert.match(text, /public\/orphan\.png/);
  assert.match(text, /public\/blank-license\.png/);
  assert.match(text, /src\/assets\/blank-source\.wav/);
  assert.doesNotMatch(text, /notes\.ts/);
  assert.doesNotMatch(text, /theme\.css/);
  assert.doesNotMatch(text, /public\/ok\.png/);
});

test("passes a clean tree and the real repository when it is clean", () => {
  const root = makeRepo({
    "ASSETS.md": `${ASSETS_HEADER}| public/ok.png | texture | generated in-house | CC0-1.0 | Nexus6 Studio | 2026-11-20 |
`,
    "node_modules/ok-lib/package.json": pkg("ok-lib", "0BSD"),
    "node_modules/@scope/util/package.json": pkg("@scope/util", "BSD-2-Clause"),
    "public/ok.png": "not-a-real-png",
    "src/main.ts": "export {}\n",
  });

  const clean = checkRepo(root);
  assert.deepEqual(clean.errors, []);
  assert.equal(clean.ok, true);

  const repoRoot = path.resolve(import.meta.dirname, "..");
  const real = checkRepo(repoRoot);
  assert.equal(
    real.ok,
    true,
    `clean repo should pass provenance gate:\n${real.errors.join("\n")}`,
  );
});
