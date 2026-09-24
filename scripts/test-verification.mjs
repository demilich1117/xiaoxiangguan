import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = await mkdtemp(join(tmpdir(), "japanese-library-verification-"));
let child;
let childError = "";
try {
  await copyFile(join(sourceRoot, "server.mjs"), join(fixtureRoot, "server.mjs"));
  await cp(join(sourceRoot, "lib"), join(fixtureRoot, "lib"), { recursive: true });
  await cp(join(sourceRoot, "public"), join(fixtureRoot, "public"), { recursive: true });
  await mkdir(join(fixtureRoot, "data"));
  const ocrRoot = join(fixtureRoot, "tools", "Tesseract-OCR");
  await mkdir(join(ocrRoot, "tessdata"), { recursive: true });
  await writeFile(join(ocrRoot, "tesseract.exe"), "fixture");
  await writeFile(join(ocrRoot, "tessdata", "jpn.traineddata"), "fixture");
  await writeFile(join(ocrRoot, "tessdata", "eng.traineddata"), "fixture");
  await mkdir(join(fixtureRoot, "library", "test-book", "state"), { recursive: true });
  await writeFile(join(fixtureRoot, "data", "library.json"), JSON.stringify({ books: [{ id: "test-book", title: "测试作品", chapters: [], glossary: [{ id: "term-1", japanese: "洛中", chinese: "洛中", category: "地名", status: "approved" }], characters: [], termCandidates: [{ id: "candidate-1", japanese: "大極殿", chinese: "大极殿", category: "制度/组织", status: "suggested" }], characterCandidates: [], uncertainties: [{ id: "question-1", chapter: "第一章", type: "典故", text: "犬痴性", note: "确认典故", status: "open" }], tasks: [] }], exports: [] }));
  const port = await new Promise((resolvePort, reject) => {
    const probe = createServer(); probe.once("error", reject); probe.listen(0, "127.0.0.1", () => { const chosen = probe.address().port; probe.close(() => resolvePort(chosen)); });
  });
  child = spawn(process.execPath, [join(fixtureRoot, "server.mjs")], { cwd: fixtureRoot, env: { ...process.env, PORT: String(port), TESSERACT_PATH: join(ocrRoot, "tesseract.exe") }, windowsHide: true });
  child.stderr.on("data", (chunk) => { childError += chunk; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch { /* startup pending */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.ok(ready, `test server failed to start: ${childError}`);
  assert.equal((await (await fetch(`${base}/api/library`)).json()).books[0].sourceLanguage ?? "ja", "ja", "existing books stay Japanese");
  const initialCapabilities = await (await fetch(`${base}/api/capabilities`)).json();
  assert.equal(initialCapabilities.ocr, true, "Japanese OCR requires both the executable and language models");
  assert.deepEqual(Object.keys(initialCapabilities.ocrLanguages).sort(), ["de", "en", "es", "fr", "ja"]);
  assert.equal(initialCapabilities.ocrLanguages.fr.model, "fra");
  await unlink(join(ocrRoot, "tessdata", "jpn.traineddata"));
  const fallbackOcr = await (await fetch(`${base}/api/capabilities`)).json();
  assert.notEqual(fallbackOcr.ocrPath, join(ocrRoot, "tesseract.exe"), "missing Japanese model must not select the broken override");
  assert.equal(fallbackOcr.ocr, Boolean(fallbackOcr.ocrPath));
  if (fallbackOcr.ocrPath) {
    assert.ok(existsSync(join(dirname(fallbackOcr.ocrPath), "tessdata", "jpn.traineddata")));
    assert.ok(existsSync(join(dirname(fallbackOcr.ocrPath), "tessdata", "eng.traineddata")));
  }
  async function patch(path, body, method = "PATCH") {
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const missingSearchTest = await fetch(`${base}/api/search-settings/test`, { method: "POST" });
  assert.equal(missingSearchTest.status, 400);
  assert.match((await missingSearchTest.json()).error, /搜索 API Key/);
  const noKeyResearch = await patch("/api/books/test-book/research/term/candidate-1", {}, "POST");
  assert.equal(noKeyResearch.status, 200, "missing search Key must not crash reader research");
  assert.equal(noKeyResearch.body.verdict, "unavailable");
  const searchSaved = await patch("/api/search-settings", { apiKey: "search-secret-1234", dailyLimit: 4 }, "PUT");
  assert.equal(searchSaved.status, 200);
  assert.equal(searchSaved.body.hasApiKey, true);
  assert.equal(searchSaved.body.dailyLimit, 4);
  assert.ok(!JSON.stringify(searchSaved.body).includes("search-secret-1234"), "search Key is not returned");
  assert.equal(Object.hasOwn(searchSaved.body, "apiKeyProtected"), false, "encrypted secret is not returned either");
  const searchRead = await (await fetch(`${base}/api/search-settings`)).json();
  assert.equal(searchRead.keyHint, "••••1234");
  assert.equal(searchRead.used, 0);
  assert.equal((await (await fetch(`${base}/api/provider`)).json()).hasApiKey, false, "search Key cannot become translation Key");
  const cachePath = join(fixtureRoot, "data", "search-cache.json");
  await writeFile(cachePath, JSON.stringify({ old: { value: [{ title: "过时缓存" }] } }));
  await patch("/api/search-settings", { apiKey: "new-search-key-5678" }, "PUT");
  assert.equal(existsSync(cachePath), false, "switching search Keys discards cached results without resetting usage");
  const updatedLanguage = await patch("/api/books/test-book", { sourceLanguage: "fr" });
  assert.equal(updatedLanguage.status, 200);
  assert.equal(updatedLanguage.body.sourceLanguage, "fr");
  assert.equal(JSON.parse(await readFile(join(fixtureRoot, "library", "test-book", "state", "project.json"), "utf8")).sourceLanguage, "fr");
  const invalidLanguage = await patch("/api/books/test-book", { sourceLanguage: "it" });
  assert.equal(invalidLanguage.status, 400);
  const imported = await fetch(`${base}/api/import?filename=spanish.epub&title=Spanish%20test&sourceLanguage=es`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.from("fixture") });
  assert.equal(imported.status, 201);
  const importedBook = await imported.json();
  assert.equal(JSON.parse(await readFile(join(fixtureRoot, "library", importedBook.id, "state", "project.json"), "utf8")).sourceLanguage, "es");
  const approved = await patch("/api/books/test-book/glossary/term-1", { chinese: "洛中", sourceUrl: "https://example.org/term", verificationNote: "核对地名" });
  assert.equal(approved.status, 200); assert.equal(approved.body.verification, "人工提供来源，未由 AI 核实");
  const addedPerson = await patch("/api/books/test-book/glossary", { japanese: "足利高氏", chinese: "足利高氏", category: "人物", definition: "本书主角", translatorNote: "后改名足利尊氏。" }, "POST");
  assert.equal(addedPerson.status, 201);
  assert.equal(addedPerson.body.definition, "本书主角");
  assert.equal(Object.hasOwn(addedPerson.body, "translatorNote"), false, "new entries should store one reader-facing explanation");
  const candidate = await patch("/api/books/test-book/term-candidates/candidate-1/approve", { chinese: "大极殿", sourceUrl: "https://example.org/hall" }, "POST");
  assert.equal(candidate.status, 200);
  const unresolved = await patch("/api/books/test-book/uncertainties/question-1", { status: "resolved", sourceUrl: "https://example.org/history" });
  assert.equal(unresolved.status, 400);
  const resolved = await patch("/api/books/test-book/uncertainties/question-1", { status: "resolved", resolution: "保留原文修辞", sourceUrl: "https://example.org/history" });
  assert.equal(resolved.status, 200); assert.equal(resolved.body.status, "resolved");
  assert.equal(resolved.body.verification, "人工提供来源，未由 AI 核实");
  const state = JSON.parse(await readFile(join(fixtureRoot, "data", "library.json"), "utf8"));
  assert.equal(state.books.find((entry) => entry.id === "test-book").glossary.length, 2);
  assert.equal(state.books.find((entry) => entry.id === "test-book").characters.length, 1);
  assert.match(await readFile(join(fixtureRoot, "library", "test-book", "state", "glossary.csv"), "utf8"), /example.org\/hall/);
  assert.match(await readFile(join(fixtureRoot, "library", "test-book", "state", "uncertainties.md"), "utf8"), /保留原文修辞/);
  const terms = Array.from({ length: 10 }, (_, index) => ({ japanese: `原詞${index}`, chinese: `译词${index}`, category: "历史术语", confidence: "medium", note: `供读者阅读的释义${index}` }));
  const source = terms.map((item) => item.japanese).join("、");
  const mockProvider = http.createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    if (body.includes("并发源文")) await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    const text = body.includes("术语、人名与疑难项") ? JSON.stringify({ terms, characters: [], uncertainties: [] }) : terms.map((item) => item.chinese).join("、");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 20, completion_tokens: 20 } }));
  });
  await new Promise((resolveListen) => mockProvider.listen(0, "127.0.0.1", resolveListen));
  try {
    const providerSaved = await patch("/api/provider", { providerName: "test", protocol: "openai-chat", baseUrl: `http://127.0.0.1:${mockProvider.address().port}/v1`, model: "test", noAuth: true }, "PUT");
    assert.equal(providerSaved.status, 200);
    await patch("/api/search-settings", { clearKey: true, dailyLimit: 0 }, "PUT");
    const current = JSON.parse(await readFile(join(fixtureRoot, "data", "library.json"), "utf8"));
    const testBook = current.books.find((entry) => entry.id === "test-book");
    testBook.chapters.push({ id: "chapter-auto", title: "自动初译", source, status: "not_started" });
    await writeFile(join(fixtureRoot, "data", "library.json"), JSON.stringify(current));
    const started = await patch("/api/books/test-book/chapters/chapter-auto/translate", { mode: "draft", range: { type: "whole" } }, "POST");
    assert.equal(started.status, 202);
    let finished;
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      const snapshot = await (await fetch(`${base}/api/library`)).json();
      finished = snapshot.books.find((entry) => entry.id === "test-book");
      const task = finished.tasks.find((entry) => entry.id === started.body.id);
      if (task?.status === "completed" || task?.status === "failed") break;
    }
    assert.equal(finished.chapters.find((entry) => entry.id === "chapter-auto").status, "review");
    assert.equal(finished.termCandidates.length, 10, "initial translation generates reader notes without using search quota");
    assert.equal((await (await fetch(`${base}/api/search-settings`)).json()).used, 0);
    const quality = finished.chapters.find((entry) => entry.id === "chapter-auto").quality;
    assert.ok(quality, "the reader receives a chapter quality summary");
    assert.ok(quality.autoChecks.length <= 3, "only a few high-risk claims enter automatic verification");
    assert.ok(quality.autoChecks.every((entry) => entry.verdict === "unavailable"), "no Key leaves checks unverified without failing translation");
    const generated = finished.chapters.find((entry) => entry.id === "chapter-auto");
    assert.equal(generated.draftOrigin, "ai");
    const generatedPath = join(fixtureRoot, "library", "test-book", generated.translationPath);
    const generatedText = await readFile(generatedPath, "utf8");
    const edited = await patch("/api/books/test-book/chapters/chapter-auto", { translation: "读者修改后的正文", status: "review" });
    assert.equal(edited.body.draftOrigin, "reader");
    assert.notEqual(edited.body.translationPath, generated.translationPath, "reader edits write a new version");
    assert.equal(await readFile(generatedPath, "utf8"), generatedText, "the AI draft remains recoverable");
    const exported = await patch("/api/books/test-book/export/epub", { includeDraft: true, chapterIds: ["chapter-auto"] }, "POST");
    assert.equal(exported.status, 200);
    const afterExport = (await (await fetch(`${base}/api/library`)).json()).books.find((entry) => entry.id === "test-book").chapters.find((entry) => entry.id === "chapter-auto");
    assert.ok(afterExport.exportedAt, "an exported chapter cannot be silently revised later");
    const restored = await patch(`/api/books/test-book/chapters/chapter-auto/revisions/${generated.revisionId}/restore`, {}, "POST");
    assert.equal(restored.status, 200);
    assert.equal(restored.body.draftOrigin, "reader", "reader-triggered restoration is never eligible for automatic overwriting");
    assert.equal(restored.body.translationPath, generated.translationPath);
    const concurrentLibrary = JSON.parse(await readFile(join(fixtureRoot, "data", "library.json"), "utf8"));
    concurrentLibrary.books.find((entry) => entry.id === "test-book").chapters.push({ id: "chapter-race", title: "并发测试", source: "并发源文", status: "not_started" });
    await writeFile(join(fixtureRoot, "data", "library.json"), JSON.stringify(concurrentLibrary));
    const raceTask = await patch("/api/books/test-book/chapters/chapter-race/translate", { mode: "draft", range: { type: "whole" } }, "POST");
    assert.equal(raceTask.status, 202);
    await new Promise((resolveWait) => setTimeout(resolveWait, 80));
    const readerEdit = await patch("/api/books/test-book/chapters/chapter-race", { translation: "读者正在写的译文", status: "review" });
    assert.equal(readerEdit.status, 200);
    let raceBook;
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      raceBook = (await (await fetch(`${base}/api/library`)).json()).books.find((entry) => entry.id === "test-book");
      if (raceBook.tasks.find((entry) => entry.id === raceTask.body.id)?.status !== "running") break;
    }
    const raceChapter = raceBook.chapters.find((entry) => entry.id === "chapter-race");
    assert.equal(raceChapter.draftOrigin, "reader", "a late AI response cannot replace an edit made during translation");
    assert.equal((await (await fetch(`${base}/api/books/test-book/chapters/chapter-race`)).json()).translation.trim(), "读者正在写的译文");
  } finally { mockProvider.close(); }
  console.log("Verification API and durable state checks passed");
} finally {
  if (child && !child.killed) child.kill();
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  await rm(fixtureRoot, { recursive: true, force: true });
}
