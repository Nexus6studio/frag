import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";

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
  assert.doesNotMatch(html, /data:,/);
  assert.doesNotMatch(html, /rel=["']icon["']/i);

  const config = JSON.parse(read("coming-soon/staticwebapp.config.json"));
  assert.equal(config.navigationFallback.rewrite, "/index.html");
  assert.equal(config.responseOverrides["404"].rewrite, "/index.html");
  assert.equal(config.responseOverrides["404"].statusCode, 404);
});

test("coming soon placeholder logs no console messages under its CSP", async () => {
  const html = read("coming-soon/index.html");
  const config = JSON.parse(read("coming-soon/staticwebapp.config.json"));
  const headers = config.globalHeaders;
  const csp = headers["Content-Security-Policy"];
  assert.equal(typeof csp, "string");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'none'/);
  assert.match(csp, /style-src 'unsafe-inline'/);
  assert.match(csp, /img-src 'none'/);
  assert.doesNotMatch(csp, /https?:/i);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...headers });
      res.end(html);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...headers });
    res.end("not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") {
    server.close();
    throw new Error("placeholder server did not bind a TCP port");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const messages = [];
    page.on("console", (message) => {
      messages.push(`${message.type()}: ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      messages.push(`pageerror: ${error.message}`);
    });
    const response = await page.goto(`${origin}/`, { waitUntil: "load", timeout: 15_000 });
    assert.equal(response?.status(), 200);
    assert.equal(await response?.headerValue("content-security-policy"), csp);
    assert.equal(await page.locator("h1").innerText(), "FRAG");
    await page.waitForTimeout(500);
    assert.deepEqual(messages, []);
  } finally {
    await browser?.close();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
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
