import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const folder = await mkdtemp(join(tmpdir(), "xxg-lifecycle-"));
let child, exitPromise, secondArrived, calls = 0;
const secondBlock = new Promise((resolve) => { secondArrived = resolve; });
const mock = http.createServer(async (req, res) => {
  let body = ""; for await (const part of req) body += part;
  const prompt = JSON.parse(body).messages[1].content;
  const match = prompt.match(/原文段落：\n(\[[^\n]+\])/);
  if (++calls > 1) { secondArrived(); return; }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ segments: JSON.parse(match[1]).map((p) => ({ sourceParagraphIds: [p.id], text: "已保存的译文。" })) }) } }] }));
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const source = ["a", "b", "c"].map((s) => s.repeat(4000)).join("\n\n");
async function boot() {
  const entry = new URL("../server.mjs", import.meta.url).href;
  child = spawn(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(entry)}); process.stdin.setEncoding('utf8'); process.stdin.on('data', signal => process.emit(signal.trim()));`], { env: { ...process.env, PORT: "0", TRANSLATION_LIBRARY_DATA_DIR: folder }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  exitPromise = once(child, "exit");
  let stderr = ""; child.stderr.on("data", (data) => { stderr += data; });
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (data) => { const url = String(data).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (url) resolve(url); });
    child.once("exit", () => reject(new Error(stderr || "server exited before startup")));
  });
}
const stopped = async () => {
  let timer;
  try { const [code] = await Promise.race([exitPromise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("shutdown timeout")), 6000); })]); assert.equal(code, 0); }
  finally { clearTimeout(timer); }
};
try {
  for (const dir of ["data", "secrets", "library/book/state"]) await mkdir(join(folder, dir), { recursive: true });
  await writeFile(join(folder, "data/library.json"), JSON.stringify({ books: [{ id: "book", title: "Shutdown fixture", chapters: ["working", "queued"].map((id) => ({ id, title: id, source, status: "extracted" })), tasks: [], glossary: [], characters: [], uncertainties: [] }], exports: [] }));
  await writeFile(join(folder, "secrets/provider.json"), JSON.stringify({ backend: "http", protocol: "openai-chat", baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: "mock", noAuth: true }));
  const base = await boot();
  const post = (path, body = {}) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await fetch(base + "/api/health").then((r) => r.json())).pid, child.pid);
  assert.equal((await fetch(base + "/api/shutdown")).status, 404);
  assert.equal((await post("/api/shutdown")).status, 400);
  assert.equal((await fetch(base + "/api/shutdown", { method: "POST", headers: { origin: "https://example.invalid", "content-type": "application/json" }, body: '{"confirm":true}' })).status, 403);
  assert.equal((await post("/api/books/book/chapters/working/translate")).status, 202);
  await secondBlock;
  assert.equal((await post("/api/books/book/chapters/queued/translate")).status, 202);
  assert.equal((await fetch(base + "/api/lifecycle").then((r) => r.json())).activeTasks, 2);
  assert.equal((await post("/api/shutdown", { confirm: true })).status, 200);
  await stopped();
  const state = JSON.parse(await readFile(join(folder, "data/library.json"), "utf8"));
  assert.ok(state.books[0].tasks.every((task) => task.status === "cancelled"));
  const chapter = state.books[0].chapters[0];
  assert.equal(chapter.translationRun.status, "cancelled");
  assert.equal(chapter.translationRun.blocks.filter((block) => block.status === "completed").length, 1);
  assert.equal(chapter.activeRevisionId, undefined);
  await assert.rejects(fetch(base + "/api/health"));
  for (const signal of ["SIGINT", "SIGHUP"]) {
    await boot(); child.stdin.write(`${signal}\n`); await stopped();
  }
  console.log("Graceful shutdown: explicit local request, running/queued cancellation, durable blocks, restart, Ctrl+C and window-close handlers passed");
} finally {
  if (child && child.exitCode === null) { child.kill("SIGKILL"); await exitPromise; }
  mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve));
  await rm(folder, { recursive: true, force: true });
}
