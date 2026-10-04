/* Coherencia entre index.html y sw.js: todos los archivos que index.html
   carga con "?v=N" deben estar en la lista del Service Worker (si falta
   alguno, el modo sin conexión fallaría en silencio) y usar la misma N. */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");

const versioned = [...html.matchAll(/(?:src|href)="([^"?]+)\?v=([^"]+)"/g)]
  .map(([, file, version]) => ({ file, version }));

test("index.html usa la misma versión (?v=N) en todos sus archivos", () => {
  assert.ok(versioned.length > 0);
  const versions = new Set(versioned.map((v) => v.version));
  assert.equal(versions.size, 1, `versiones distintas: ${[...versions].join(", ")}`);
});

test("sw.js guarda para uso sin conexión todos los archivos versionados", () => {
  const list = sw.match(/const VERSIONED_FILES = \[([\s\S]*?)\];/)[1];
  const swFiles = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(swFiles, versioned.map((v) => v.file).sort());
});

test("todos los archivos referenciados existen", () => {
  for (const { file } of versioned) {
    assert.ok(fs.existsSync(path.join(root, file)), `falta ${file}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.webmanifest"), "utf8"));
  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(path.join(root, icon.src)), `falta ${icon.src}`);
  }
});
