// License and asset-provenance gate for Frag.
//
// Allowed dependency licenses: MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0,
// and ISC. 0BSD and the Unlicense are also accepted. Both are
// public-domain-equivalent permissive licenses: they grant use without
// copyleft and without a requirement to keep a specific notice attached to
// every file. GPL, AGPL, LGPL, unknown, and missing licenses fail.
// "UNLICENSED" is npm's proprietary marker, not the Unlicense, and fails.
//
// Every installed package is checked, including transitive and dev
// dependencies. Asset binaries under public/ or src/assets/ need a row in
// ASSETS.md with a non-empty source and license. .ts and .css are not assets.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED = new Set([
  "MIT",
  "BSD-2-CLAUSE",
  "BSD-3-CLAUSE",
  "APACHE-2.0",
  "ISC",
  "0BSD",
  "UNLICENSE",
]);

const LICENSE_ALIASES = new Map([
  ["BSD-2", "BSD-2-CLAUSE"],
  ["BSD-3", "BSD-3-CLAUSE"],
  ["BSD-0-CLAUSE", "0BSD"],
  ["APACHE-2", "APACHE-2.0"],
  ["APACHE2", "APACHE-2.0"],
  ["APACHE2.0", "APACHE-2.0"],
  ["APACHE-LICENSE-2.0", "APACHE-2.0"],
  ["THE-UNLICENSE", "UNLICENSE"],
]);

const ASSET_DIRS = ["public", path.join("src", "assets")];

const ASSET_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tga",
  ".svg",
  ".ico",
  ".tif",
  ".tiff",
  ".exr",
  ".hdr",
  ".ktx",
  ".ktx2",
  ".basis",
  ".mp3",
  ".ogg",
  ".wav",
  ".flac",
  ".m4a",
  ".aac",
  ".opus",
  ".mp4",
  ".webm",
  ".mov",
  ".glb",
  ".gltf",
  ".obj",
  ".fbx",
  ".dae",
  ".stl",
  ".usdz",
  ".blend",
  ".md2",
  ".md3",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".eot",
  ".map",
  ".bsp",
  ".wad",
  ".pk3",
]);

function canonicalLicense(id) {
  const key = id.trim().replace(/\s+/g, "-").toUpperCase();
  if (key === "UNLICENSED") return null;
  return LICENSE_ALIASES.get(key) ?? key;
}

function tokenize(input) {
  const tokens = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "(") {
      tokens.push({ kind: "LPAREN" });
      index += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ kind: "RPAREN" });
      index += 1;
      continue;
    }
    if (/[A-Za-z0-9]/.test(char)) {
      let end = index + 1;
      while (end < input.length && /[A-Za-z0-9.+-]/.test(input[end])) end += 1;
      const word = input.slice(index, end);
      const upper = word.toUpperCase();
      if (upper === "OR" || upper === "AND" || upper === "WITH") {
        tokens.push({ kind: upper });
      } else {
        tokens.push({ kind: "ID", value: word });
      }
      index = end;
      continue;
    }
    throw new Error(`unexpected '${char}'`);
  }
  return tokens;
}

function parseLicenseExpression(input) {
  const tokens = tokenize(input);
  let index = 0;

  function peek() {
    return tokens[index];
  }

  function eat(kind) {
    if (peek()?.kind === kind) {
      index += 1;
      return tokens[index - 1];
    }
    return null;
  }

  function parseOr() {
    let left = parseAnd();
    while (eat("OR")) left = { type: "OR", left, right: parseAnd() };
    return left;
  }

  function parseAnd() {
    let left = parseWith();
    while (eat("AND")) left = { type: "AND", left, right: parseWith() };
    return left;
  }

  function parseWith() {
    let left = parsePrimary();
    while (eat("WITH")) left = { type: "WITH", left, right: parsePrimary() };
    return left;
  }

  function parsePrimary() {
    if (eat("LPAREN")) {
      const expression = parseOr();
      if (!eat("RPAREN")) throw new Error("missing ')'");
      return expression;
    }
    const id = eat("ID");
    if (!id) throw new Error("expected a license id");
    return { type: "ID", value: id.value };
  }

  const ast = parseOr();
  if (index !== tokens.length) throw new Error("trailing input");
  return ast;
}

function expressionAllowed(node) {
  if (node.type === "OR") {
    return expressionAllowed(node.left) || expressionAllowed(node.right);
  }
  if (node.type === "AND") {
    return expressionAllowed(node.left) && expressionAllowed(node.right);
  }
  // WITH adds an exception. Only a bare allowlisted license is accepted.
  if (node.type === "WITH") return false;
  if (node.type === "ID") {
    const canon = canonicalLicense(node.value);
    return canon !== null && ALLOWED.has(canon);
  }
  return false;
}

export function licenseAllowed(license) {
  if (license == null) return { ok: false, reason: "missing license" };
  if (Array.isArray(license)) {
    if (license.length === 0) return { ok: false, reason: "missing license" };
    const parts = license.map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object" && typeof entry.type === "string") {
        return entry.type;
      }
      return "";
    });
    return licenseAllowed(parts.join(" OR "));
  }
  if (typeof license === "object") {
    return licenseAllowed(typeof license.type === "string" ? license.type : "");
  }
  if (typeof license !== "string") {
    return { ok: false, reason: "unrecognized license field" };
  }
  const trimmed = license.trim();
  if (!trimmed) return { ok: false, reason: "empty license" };
  try {
    const ast = parseLicenseExpression(trimmed);
    if (!expressionAllowed(ast)) {
      return { ok: false, reason: `license not allowed: ${trimmed}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `unparseable license (${message})` };
  }
  return { ok: true, reason: "" };
}

function isDirectory(entry, full) {
  if (entry.isDirectory()) return true;
  if (entry.isSymbolicLink()) {
    try {
      return fs.statSync(full).isDirectory();
    } catch {
      return false;
    }
  }
  return false;
}

function walkPackages(dir) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".bin" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (!isDirectory(entry, full)) continue;
    if (entry.name.startsWith("@")) {
      for (const sub of fs.readdirSync(full, { withFileTypes: true })) {
        const subFull = path.join(full, sub.name);
        if (!isDirectory(sub, subFull) || sub.name.startsWith(".")) continue;
        found.push(...readPackage(subFull));
      }
      continue;
    }
    found.push(...readPackage(full));
  }
  return found;
}

function readPackage(dir) {
  const found = [];
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    found.push({
      error: `installed directory has no package.json: ${dir}`,
    });
  } else {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      found.push({ error: `unreadable package.json at ${pkgPath}: ${message}` });
      json = null;
    }
    if (json) {
      const decision = licenseAllowed(json.license ?? json.licenses);
      const name = typeof json.name === "string" ? json.name : path.basename(dir);
      const version = typeof json.version === "string" ? json.version : "0.0.0";
      if (!decision.ok) {
        found.push({
          error: `dependency ${name}@${version} ${decision.reason}`,
        });
      } else {
        found.push({ ok: true });
      }
    }
  }
  const nested = path.join(dir, "node_modules");
  if (fs.existsSync(nested)) found.push(...walkPackages(nested));
  return found;
}

function normPath(value) {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function parseProvenanceRows(markdown) {
  const rows = [];
  let header = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length === 0) continue;
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    if (!header) {
      header = cells.map((cell) => cell.toLowerCase());
      continue;
    }
    const row = {};
    header.forEach((name, cellIndex) => {
      row[name] = cells[cellIndex] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

function column(row, prefix) {
  const key = Object.keys(row).find((name) => name === prefix || name.startsWith(`${prefix} `) || name.startsWith(`${prefix}(`));
  return key ? row[key].trim() : "";
}

function collectAssets(root) {
  const assets = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (isDirectory(entry, full)) {
        walk(full);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!ASSET_EXTENSIONS.has(ext)) continue;
      assets.push(normPath(path.relative(root, full)));
    }
  }
  for (const rel of ASSET_DIRS) walk(path.join(root, rel));
  return assets;
}

export function checkRepo(root) {
  const errors = [];
  let packages = 0;
  const nodeModules = path.join(root, "node_modules");
  if (!fs.existsSync(nodeModules)) {
    errors.push("node_modules is missing; run npm ci before the license check");
  } else {
    for (const item of walkPackages(nodeModules)) {
      if (item.error) errors.push(item.error);
      else packages += 1;
    }
  }

  const assetsPath = path.join(root, "ASSETS.md");
  let rows = [];
  if (!fs.existsSync(assetsPath)) {
    errors.push("ASSETS.md is missing");
  } else {
    rows = parseProvenanceRows(fs.readFileSync(assetsPath, "utf8"));
  }

  const rowPaths = new Set();
  for (const row of rows) {
    const assetPath = normPath(column(row, "path"));
    const source = column(row, "source");
    const license = column(row, "license");
    const label = assetPath || "(blank path)";
    if (!source) errors.push(`asset row ${label} has an empty source`);
    if (!license) errors.push(`asset row ${label} has an empty license`);
    if (assetPath) rowPaths.add(assetPath);
  }

  const assets = collectAssets(root);
  for (const asset of assets) {
    if (!rowPaths.has(asset)) {
      errors.push(`asset ${asset} has no ASSETS.md provenance row`);
    }
  }

  return { ok: errors.length === 0, errors, packages, assets: assets.length };
}

function main() {
  const result = checkRepo(process.cwd());
  if (!result.ok) {
    for (const error of result.errors) console.error(error);
    process.exit(1);
  }
  console.log(
    `provenance gate passed (${result.packages} packages, ${result.assets} assets)`,
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
