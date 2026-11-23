import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

test("coming soon placeholder stays offline and has no script sources", () => {
  const html = read("coming-soon/index.html");
  assert.match(html, /<h1>FRAG<\/h1>/);
  assert.match(html, /Coming soon/);
  assert.match(html, /A Nexus6 Studio browser FPS/);
  assert.doesNotMatch(html, /https?:/i);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(html, /localStorage/);

  const config = JSON.parse(read("coming-soon/staticwebapp.config.json"));
  assert.equal(config.navigationFallback.rewrite, "/index.html");
  assert.equal(config.responseOverrides["404"].rewrite, "/index.html");
  assert.equal(config.responseOverrides["404"].statusCode, 404);
});

test("deploy prod stays approval-gated on main", () => {
  const yml = read(".github/workflows/deploy-prod.yml");
  assert.match(yml, /^ {4}environment: production$/m);
  assert.match(yml, /if \[ "\$GITHUB_REF" != "refs\/heads\/main" \]; then/);
  assert.match(yml, /production_branch: main/);
  assert.match(yml, /secrets\.AZURE_STATIC_WEB_APPS_API_TOKEN/);
  assert.match(yml, /default: coming-soon/);
  assert.match(
    yml,
    /app_location: \$\{\{ inputs\.target == 'game' && 'dist' \|\| 'coming-soon' \}\}/,
  );
  assert.match(yml, /if: inputs\.target == 'game'/);
});
