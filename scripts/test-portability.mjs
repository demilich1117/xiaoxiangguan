import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { dataRoot, resolveSourceFile } from "../lib/data-paths.mjs";

const root = await mkdtemp(join(tmpdir(), "xiaoxiang-paths-"));
try {
  const app = join(root, "app");
  const home = join(root, "home");
  await mkdir(app, { recursive: true });
  assert.equal(dataRoot({ root: app, env: { LOCALAPPDATA: home }, platform: "win32" }), join(home, "Xiaoxiangguan"));
  assert.equal(dataRoot({ root: app, env: { HOME: home }, platform: "linux" }), join(home, ".local", "share", "xiaoxiangguan"));
  const chosen = join(root, "chosen");
  assert.equal(dataRoot({ root: app, env: { TRANSLATION_LIBRARY_DATA_DIR: chosen }, platform: "win32" }), chosen);
  await mkdir(join(app, "data"));
  await writeFile(join(app, "data", "library.json"), '{"books":[],"exports":[]}');
  assert.equal(dataRoot({ root: app, env: { LOCALAPPDATA: home }, platform: "win32" }), app);
  assert.equal(dataRoot({ root: app, env: { TRANSLATION_LIBRARY_DATA_DIR: chosen, LOCALAPPDATA: home }, platform: "win32" }), chosen);

  const bookRoot = join(chosen, "library", "book-1");
  await mkdir(join(bookRoot, "source"), { recursive: true });
  const source = join(bookRoot, "source", "original.pdf");
  await writeFile(source, "fixture");
  assert.equal(resolveSourceFile({ sourceFile: "source/original.pdf" }, bookRoot), source);
  assert.equal(resolveSourceFile({ sourceFile: join(root, "old-install", "library", "book-1", "source", "original.pdf") }, bookRoot), source);
  assert.equal(existsSync(resolveSourceFile({ sourceFile: "source/original.pdf" }, bookRoot)), true);
  assert.throws(() => resolveSourceFile({ sourceFile: "../../outside.pdf" }, bookRoot), /invalid|无效|outside/i);
} finally { await rm(root, { recursive: true, force: true }); }
console.log("Portable data and source path checks passed");
