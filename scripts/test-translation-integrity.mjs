import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { translateChapter } from "../lib/engine.mjs";
import { sourceParagraphs, validateSegments, translationBlocks } from "../lib/alignment.mjs";
import { generate } from "../lib/providers.mjs";

const storage = await mkdtemp(join(tmpdir(), "xxg-integrity-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let mode = "normal", requests = [], arrived, release, generatedCount = 0;
const mock = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const payload = JSON.parse(body); const content = payload.messages?.[1]?.content || payload.input?.[1]?.content?.[0]?.text || "";
  requests.push(content);
  const paragraphs = content.match(/原文段落：\n(\[[^\n]+\])/);
  if (paragraphs) generatedCount++;
  if ((mode === "slow" || mode === "after-one" && generatedCount > 1) && paragraphs) { arrived?.(); await new Promise((r) => { release = r; }); }
  const segments = paragraphs ? JSON.parse(paragraphs[1]).map((p, i) => ({ sourceParagraphIds: [p.id], text: `新译文${i + 1}。` })) : [];
  const text = paragraphs ? JSON.stringify({ segments }) : content.includes("JSON") ? '{"terms":[],"characters":[],"uncertainties":[]}' : "连接成功";
  const truncated = mode === "truncated";
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(req.url.endsWith("responses") ? { status: truncated ? "incomplete" : "completed", output_text: text } : { choices: [{ message: { content: text }, finish_reason: truncated ? "length" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const provider = { protocol: "openai-chat", baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model: "mock", noAuth: true };
let child;
try {
  mode = "truncated";
  for (const protocol of ["openai-chat", "openai-responses"]) await assert.rejects(generate({ provider: { ...provider, protocol }, messages: [{ role: "user", content: "test" }] }), /未完整结束/);
  mode = "normal";
  const smallSource = ["A", "B", "C", "D"].map((text) => text.repeat(700)).join("\n\n");
  const smallParagraphs = sourceParagraphs(smallSource, "sized");
  const smallDrafts = smallParagraphs.map((p, i) => ({ sourceParagraphIds: [p.id], text: `小段译文${i}` }));
  for (const [translationBlockChars, expectedCalls] of [[undefined, 1], [500, 4], [1000, 4], [2000, 2], [3000, 1], [5000, 1], [6000, 1]]) {
    for (const translationMode of ["draft", "refine"]) {
      requests = [];
      const result = await translateChapter({ provider: { ...provider, translationBlockChars }, book: {}, chapter: { id: "sized" }, source: smallSource, mode: translationMode, draftSegments: smallDrafts });
      assert.equal(requests.length, expectedCalls, "configured size drives draft and refinement calls");
      assert.deepEqual(result.segments.flatMap((s) => s.sourceParagraphIds), smallParagraphs.map((p) => p.id), "smaller blocks preserve complete source coverage");
    }
  }
  await assert.rejects(translateChapter({ provider: { ...provider, translationBlockChars: 2000 }, book: {}, chapter: {}, source: smallSource, mode: "refine", existingDraft: "旧译文" }), /超过当前分块大小/);
  const source = ["A".repeat(4000), "B".repeat(4000), "C".repeat(4000)].join("\n\n");
  const paragraphs = sourceParagraphs(source, "alignment");
  const draftSegments = paragraphs.map((p, i) => ({ sourceParagraphIds: [p.id], text: ["译文甲", "译文乙", "译文丙"][i].repeat(250) }));
  requests = [];
  await translateChapter({ provider, book: {}, chapter: { id: "alignment" }, source, mode: "refine", existingDraft: draftSegments.map((s) => s.text).join("\n\n"), draftSegments });
  assert.equal(requests.length, 3);
  requests.forEach((text, i) => ["译文甲", "译文乙", "译文丙"].forEach((marker, j) => assert.equal(text.includes(marker), i === j, "F2 refine pairs exact source IDs despite length difference")));
  const ids = paragraphs.map((p) => p.id);
  assert.throws(() => validateSegments([{ sourceParagraphIds: [ids[0], ids[2]], text: "缺段" }], ids), /覆盖/);
  assert.throws(() => validateSegments([{ sourceParagraphIds: [ids[1], ids[0], ids[2]], text: "乱序" }], ids), /乱序/);
  assert.throws(() => validateSegments([{ sourceParagraphIds: [...ids, ids[0]], text: "重复" }], ids), /重复/);
  requests = [];
  await translateChapter({ provider, book: {}, chapter: { id: "alignment" }, source, mode: "refine", draftSegments: [{ sourceParagraphIds: ids.slice(0, 2), text: "合段甲乙" }, draftSegments[2]] });
  assert.equal(requests.length, 2); assert.match(requests[0], /合段甲乙/); assert.doesNotMatch(requests[1], /合段甲乙/);
  await assert.rejects(translateChapter({ provider, book: {}, chapter: {}, source, mode: "refine", existingDraft: "旧译文" }), /没有段落映射/);
  const completed = [];
  await assert.rejects(translateChapter({ provider, book: {}, chapter: { id: "alignment" }, source, onBlock: (b) => { if (b.status === "completed") { completed.push(b); mode = "truncated"; } } }), /未完整结束/);
  assert.equal(completed.length, 1);
  mode = "normal"; requests = [];
  const resumed = await translateChapter({ provider, book: {}, chapter: { id: "alignment" }, source, resumeBlocks: completed });
  assert.equal(requests.length, 2); assert.equal(resumed.blocks.length, 3);
  const stable = sourceParagraphs(`intro\n\n${source}`, "alignment"); assert.deepEqual(stable.slice(1).map((p) => p.id), ids);

  for (const dir of ["data", "secrets", "library/book/state", "library/other-book/state"]) await mkdir(join(storage, dir), { recursive: true });
  await writeFile(join(storage, "secrets/provider.json"), JSON.stringify(provider));
  await writeFile(join(storage, "library/book/old.md"), "旧精校版");
  const chapters = ["version", "cancel", "reader", "progress", "restart", "sized", "queued-size"].map((id) => ({ id, title: id, source: ["progress", "restart"].includes(id) ? source : ["sized", "queued-size"].includes(id) ? smallSource : "Source paragraph.", status: "review", ...(id === "version" ? { polishedPath: "old.md" } : {}) }));
  await writeFile(join(storage, "data/library.json"), JSON.stringify({ books: [{ id: "book", title: "fixture", chapters, tasks: [], glossary: [], characters: [], uncertainties: [] }, { id: "other-book", title: "other", chapters: [], tasks: [] }], exports: [] }));
  const boot = async () => {
  child = spawn(process.execPath, ["server.mjs"], { cwd: new URL("../", import.meta.url), env: { ...process.env, PORT: "0", TRANSLATION_LIBRARY_DATA_DIR: storage }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (d) => { stderr += d; });
  return await new Promise((resolve, reject) => { child.stdout.on("data", (d) => { const url = String(d).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (url) resolve(url); }); child.once("exit", () => reject(new Error(stderr))); });
  };
  let base = await boot();
  const api = async (path, method = "GET", body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const v = await r.json(); assert.ok(r.ok, JSON.stringify(v)); return v; };
  await Promise.all([api("/api/books/book", "PATCH", { author: "first-author" }), api("/api/books/other-book", "PATCH", { author: "second-author" })]);
  const concurrent = (await api("/api/library")).books;
  assert.equal(concurrent.find((b) => b.id === "book").author, "first-author");
  assert.equal(concurrent.find((b) => b.id === "other-book").author, "second-author", "cross-book writes cannot overwrite each other");
  const chapter = (id) => api(`/api/books/book/chapters/${id}`);
  const start = (id, body = {}) => api(`/api/books/book/chapters/${id}/translate`, "POST", body);
  const finish = async (id) => { for (let i = 0; i < 150; i++) { const task = (await api("/api/library")).books[0].tasks.find((t) => t.id === id); if (["completed", "failed", "cancelled"].includes(task.status)) return task; await sleep(40); } throw new Error("task timeout"); };
  assert.equal((await api("/api/provider")).translationBlockChars, 3000, "existing configurations inherit the new default");
  for (const invalid of [null, "", 0, 499, 6001, 10000, 1000.5, "invalid"]) {
    const response = await fetch(base + "/api/provider", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ translationBlockChars: invalid }) });
    assert.equal(response.ok, false); assert.match((await response.json()).error, /500 到 6000/);
    assert.equal((await api("/api/provider")).translationBlockChars, 3000, "invalid saves leave the prior value intact");
  }
  for (const backend of ["codex", "opencode", "antigravity", "http"]) {
    const saved = await api("/api/provider", "PUT", { backend, model: backend === "opencode" ? "vendor/mock" : "mock", noAuth: true, translationBlockChars: 1500 });
    assert.equal(saved.translationBlockChars, 1500);
    assert.equal((await api("/api/provider")).translationBlockChars, 1500, "all backends persist and return block size");
  }
  assert.equal((await api("/api/provider", "PUT", { noAuth: true })).translationBlockChars, 1500, "older clients can omit the setting");
  assert.equal((await api("/api/provider", "PUT", { noAuth: true, translationBlockChars: 6000 })).translationBlockChars, 6000, "the upper limit is accepted");
  await api("/api/provider", "PUT", { noAuth: true, translationBlockChars: 2000 });
  mode = "after-one"; generatedCount = 0;
  const sizedPending = new Promise((r) => { arrived = r; }); const sizedTask = await start("sized"); await sizedPending;
  const queuedSize = await start("queued-size"); assert.equal(queuedSize.status, "queued");
  await api("/api/provider", "PUT", { noAuth: true, translationBlockChars: 1000 });
  mode = "normal"; await api(`/api/tasks/${sizedTask.id}/cancel`, "POST"); release();
  assert.equal((await finish(queuedSize.id)).status, "completed");
  assert.equal((await chapter("queued-size")).translationRun.engine.translationBlockChars, 2000, "queued tasks freeze their block size");
  assert.equal((await chapter("queued-size")).translationRun.blocks.length, 2);
  requests = []; const sizedRetry = await start("sized", { retry: true });
  assert.equal((await finish(sizedRetry.id)).status, "completed");
  assert.equal(requests.filter((text) => text.includes("原文段落")).length, 1, "changed settings do not retranslate completed blocks on resume");
  assert.equal((await chapter("sized")).translationRun.engine.translationBlockChars, 2000);
  const newSizedTask = await start("sized"); assert.equal((await finish(newSizedTask.id)).status, "completed");
  assert.equal((await chapter("sized")).translationRun.blocks.length, 4, "new tasks use the changed setting");
  const version = await start("version"); assert.equal((await finish(version.id)).status, "completed");
  const current = await chapter("version"); assert.match(current.translation, /新译文/); assert.equal(current.revisionHistory.length, 2); assert.ok(current.activeRevisionId);
  const exported = await api("/api/books/book/export/epub", "POST", { includeDraft: true, chapterIds: ["version"] });
  const epub = Buffer.from(await (await fetch(base + exported.downloadUrl)).arrayBuffer()); assert.ok(epub.includes(Buffer.from("新译文"))); assert.equal(epub.includes(Buffer.from("旧精校版")), false);
  const secondExport = await api("/api/books/book/export/epub", "POST", { includeDraft: true, chapterIds: ["version"] }); assert.notEqual(secondExport.downloadUrl, exported.downloadUrl);

  mode = "slow"; let pending = new Promise((r) => { arrived = r; }); const cancel = await start("cancel"); await pending;
  await api(`/api/tasks/${cancel.id}/cancel`, "POST"); release(); await sleep(150);
  const cancelled = await chapter("cancel"); assert.equal((await finish(cancel.id)).status, "cancelled"); assert.equal(cancelled.translation, ""); assert.equal(cancelled.translationPath, undefined); assert.equal(cancelled.status, "review"); assert.equal(cancelled.translationRun.status, "cancelled");

  pending = new Promise((r) => { arrived = r; }); const reader = await start("reader"); await pending;
  await api("/api/books/book/chapters/reader", "PATCH", { translation: "读者编辑不可覆盖", status: "review" }); mode = "normal"; release();
  assert.equal((await finish(reader.id)).status, "completed"); const protectedChapter = await chapter("reader"); assert.equal(protectedChapter.translation.trim(), "读者编辑不可覆盖"); assert.equal(protectedChapter.translationRun.adopted, false); assert.equal(protectedChapter.revisionHistory.length, 2);
  mode = "after-one"; generatedCount = 0; pending = new Promise((r) => { arrived = r; }); const progressTask = await start("progress"); await pending;
  let progressChapter = await chapter("progress"); assert.equal(progressChapter.translationRun.blocks.filter((b) => b.status === "completed").length, 1); assert.equal(progressChapter.translation, "");
  const queued = await start("cancel"); assert.equal(queued.status, "queued");
  const duplicate = await start("cancel"); assert.equal(duplicate.id, queued.id, "queued requests deduplicate");
  await api(`/api/tasks/${queued.id}/cancel`, "POST");
  await api(`/api/tasks/${progressTask.id}/pause`, "POST");
  mode = "normal"; release(); await sleep(100);
  progressChapter = await chapter("progress"); assert.equal(progressChapter.translationRun.blocks.filter((b) => b.status === "completed").length, 1, "paused in-flight response waits before persistence");
  await api(`/api/tasks/${progressTask.id}/cancel`, "POST"); await sleep(100);
  assert.equal((await chapter("progress")).translationRun.blocks.filter((b) => b.status === "completed").length, 1, "cancellation retains only previously completed blocks");
  requests = []; const retry = await start("progress", { retry: true }); assert.equal((await finish(retry.id)).status, "completed");
  assert.equal(requests.filter((text) => text.includes("原文段落")).length, 2, "server retry skips completed persisted block");
  mode = "after-one"; generatedCount = 0; pending = new Promise((r) => { arrived = r; });
  const interrupted = await start("restart"); await pending;
  child.kill("SIGKILL"); await once(child, "exit"); release(); mode = "normal";
  // Emulate a pre-setting run, which did not record its fixed 6500-character size.
  const restartLibrary = JSON.parse(await readFile(join(storage, "data/library.json"), "utf8"));
  const oldChapter = restartLibrary.books[0].chapters.find((c) => c.id === "restart");
  const oldParagraphs = sourceParagraphs(oldChapter.source, "restart");
  assert.equal(translationBlocks(oldParagraphs, null, 6500).length, 3);
  delete oldChapter.translationRun.engine.translationBlockChars;
  await writeFile(join(storage, "data/library.json"), JSON.stringify(restartLibrary));
  base = await boot();
  assert.equal((await api("/api/provider")).translationBlockChars, 1000, "block setting survives restart");
  const recovered = await chapter("restart");
  assert.equal((await finish(interrupted.id)).status, "failed");
  assert.equal(recovered.translationRun.status, "failed");
  assert.equal(recovered.translationRun.blocks.filter((b) => b.status === "completed").length, 1);
  requests = []; const continued = await start("restart", { retry: true });
  assert.equal((await finish(continued.id)).status, "completed");
  assert.equal((await chapter("restart")).translationRun.engine.translationBlockChars, 6500, "pre-setting runs retain their historical boundaries");
  assert.equal(requests.filter((text) => text.includes("原文段落")).length, 2, "restart recovery reuses durable blocks");
  console.log("F1–F4, ID alignment, merged/missing/duplicate paragraphs, resumable blocks and restart recovery, immutable exports and reader protection passed");
} finally {
  release?.(); if (child) { child.kill(); await once(child, "exit"); }
  mock.closeAllConnections(); await new Promise((r) => mock.close(r));
  await rm(storage, { recursive: true, force: true });
}
