import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { toolCandidates, tessdataDirectories } from "../lib/tool-paths.mjs";

const root = await mkdtemp(join(tmpdir(), "xiaoxiang-tools-"));
try {
  const install = join(root, "ocr");
  const pathBin = join(root, "path-bin");
  const models = join(root, "models");
  await mkdir(install); await mkdir(pathBin); await mkdir(models);
  await writeFile(join(install, "tesseract.exe"), "fixture");
  await writeFile(join(pathBin, "tesseract.exe"), "fixture");
  const env = { TESSERACT_PATH: join(install, "tesseract.exe"), PATH: [pathBin].join(delimiter), TESSDATA_PREFIX: models };
  assert.deepEqual(toolCandidates("TESSERACT_PATH", "tesseract", [], env, "win32"), [join(install, "tesseract.exe"), join(pathBin, "tesseract.exe")]);
  assert.equal(tessdataDirectories(join(install, "tesseract.exe"), env)[0], models);
  assert.equal(toolCandidates("PDFTOPPM_PATH", "pdftoppm", [], { PATH: "" }, "win32").length, 0);
} finally { await rm(root, { recursive: true, force: true }); }
console.log("External tool path checks passed");
