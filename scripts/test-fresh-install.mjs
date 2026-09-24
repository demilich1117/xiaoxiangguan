import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("..", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "xiaoxiang-fresh-"));
const app = join(temp, "app");
const storage = join(temp, "personal-data");
let child;
try {
  await mkdir(app);
  await cp(join(project, "server.mjs"), join(app, "server.mjs"), { recursive: true });
  await cp(join(project, "lib"), join(app, "lib"), { recursive: true });
  await cp(join(project, "public"), join(app, "public"), { recursive: true });
  const port = await new Promise((resolve, reject) => {
    const probe = createServer(); probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const value = probe.address().port; probe.close(() => resolve(value)); });
  });
  child = spawn(process.execPath, [join(app, "server.mjs")], { env: { ...process.env, PORT: String(port), TRANSLATION_LIBRARY_DATA_DIR: storage }, windowsHide: true });
  let output = ""; child.stderr.on("data", (chunk) => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch { /* startup */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(ready, output || "fresh server did not start");
  assert.deepEqual(await (await fetch(`${base}/api/library`)).json(), { books: [], exports: [] });
  assert.equal((await (await fetch(`${base}/api/capabilities`)).json()).dataDirectory, storage);
  const foreign = await fetch(`${base}/api/import?filename=foreign.epub`, { method: "POST", headers: { Origin: "https://example.invalid" }, body: Buffer.from("blocked") });
  assert.equal(foreign.status, 403, "a foreign web page must not modify the local library");
  const upload = await fetch(`${base}/api/import?filename=sample.epub&title=Sample`, { method: "POST", body: Buffer.from("epub-fixture") });
  assert.equal(upload.status, 201);
  const library = JSON.parse(await readFile(join(storage, "data", "library.json"), "utf8"));
  assert.equal(library.books.length, 1);
  assert.equal(library.books[0].sourceFile, join("source", "sample.epub"));
} finally {
  if (child) { child.kill(); await new Promise((done) => child.once("close", done)); }
  await rm(temp, { recursive: true, force: true });
}
console.log("Fresh install and portable import checks passed");
