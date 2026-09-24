import http from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createEpub } from "./lib/epub.mjs";
import { analyzeChapterEntities, extractDocument, identifyHighRisk, japaneseOcrPath, ocrStatus, readChapterText, testProviderConnection, translateChapter, writeTranslation } from "./lib/engine.mjs";
import { SOURCE_LANGUAGES, sourceLanguage } from "./public/languages.js";
import { searchResearchSources, verifyIssue } from "./lib/research.mjs";
import { createSearchBudget } from "./lib/search-budget.mjs";
import { canAutoRevise, canAutoReviseFromEvidence, newRevisionId, preserveChapterRevisionState } from "./lib/revisions.mjs";
import { dataRoot } from "./lib/data-paths.mjs";
import { toolCandidates } from "./lib/tool-paths.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");
const DATA_ROOT = dataRoot({ root: ROOT });
const DATA = join(DATA_ROOT, "data");
const DATA_FILE = join(DATA, "library.json");
const SECRETS = join(DATA_ROOT, "secrets");
const PROVIDER_FILE = join(SECRETS, "provider.json");
const SEARCH_FILE = join(SECRETS, "search.json");
const SEARCH_CACHE_FILE = join(DATA, "search-cache.json");
const EXPORTS = join(DATA_ROOT, "exports");
const LIBRARY = join(DATA_ROOT, "library");
const PORT = Number(process.env.PORT || 4327);
const MAX_UPLOAD = 512 * 1024 * 1024;
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".epub": "application/epub+zip" };

await mkdir(DATA, { recursive: true });
if (!existsSync(DATA_FILE)) await writeFile(DATA_FILE, '{"books":[],"exports":[]}\n', { encoding: "utf8", flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
await mkdir(EXPORTS, { recursive: true });
await mkdir(LIBRARY, { recursive: true });
await mkdir(SECRETS, { recursive: true });

try {
  const startupData = JSON.parse(await readFile(DATA_FILE, "utf8")); let changed = false;
  for (const book of startupData.books || []) for (const task of book.tasks || []) if (task.status === "running") { task.status = "failed"; task.error = "应用在任务执行期间重启，请重新发起该步骤"; changed = true; }
  if (changed) await writeFile(DATA_FILE, `${JSON.stringify(startupData, null, 2)}\n`, "utf8");
} catch { /* library initialization will report a useful error later */ }

async function readLibrary() { return JSON.parse(await readFile(DATA_FILE, "utf8")); }
let libraryWriteQueue = Promise.resolve();
async function saveLibrary(data) {
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const operation = libraryWriteQueue.then(async () => {
    const temp = `${DATA_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await writeFile(temp, payload, "utf8");
      for (let attempt = 0; ; attempt++) {
        try { await rename(temp, DATA_FILE); break; }
        catch (error) {
          if (!['EPERM', 'EACCES'].includes(error.code) || attempt >= 7) throw error;
          await new Promise((resolveWait) => setTimeout(resolveWait, 25 * (attempt + 1)));
        }
      }
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  });
  libraryWriteQueue = operation.catch(() => {});
  return operation;
}
function json(res, status, payload) { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(payload)); }
function safeName(value) { return basename(value).replace(/[^\p{L}\p{N}._ -]/gu, "-").slice(0, 160) || "book"; }
const providerDefaults = { providerName: "OpenAI · Luna", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1", model: "gpt-6-luna", maxOutputTokens: 8192, inputPrice: 0.1, outputPrice: 0.5, noAuth: false };
const searchDefaults = { dailyLimit: 30, autoItemsPerChapter: 3, requestsPerItem: 2 };
let searchDailyLimit = 30;
const searchBudget = createSearchBudget({ file: join(DATA, "search-usage.json"), cacheFile: SEARCH_CACHE_FILE, dailyLimit: () => searchDailyLimit });
function secretOperation(mode, value) {
  return new Promise((resolveSecret, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "scripts", "secret.ps1"), "-Mode", mode], { windowsHide: true });
    let stdout = ""; let stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolveSecret(stdout) : reject(new Error(stderr || "Windows credential protection failed"))); child.stdin.end(value);
  });
}
async function readProvider() {
  if (!existsSync(PROVIDER_FILE)) return { ...providerDefaults };
  const stored = JSON.parse(await readFile(PROVIDER_FILE, "utf8"));
  const apiKey = stored.apiKeyProtected ? await secretOperation("Unprotect", stored.apiKeyProtected) : (stored.apiKey || "");
  delete stored.apiKeyProtected; delete stored.apiKey;
  if (!stored.providerName && !stored.baseUrl && !stored.model) return { ...providerDefaults, apiKey };
  const merged = { ...providerDefaults, ...stored, apiKey };
  for (const key of ["providerName", "baseUrl", "model"]) if (!merged[key]) merged[key] = providerDefaults[key];
  return merged;
}
async function readSearchSettings() {
  if (!existsSync(SEARCH_FILE)) return { ...searchDefaults, apiKey: "" };
  const stored = JSON.parse(await readFile(SEARCH_FILE, "utf8"));
  const apiKey = stored.apiKeyProtected ? await secretOperation("Unprotect", stored.apiKeyProtected) : (stored.apiKey || "");
  searchDailyLimit = stored.dailyLimit ?? searchDefaults.dailyLimit;
  return { ...searchDefaults, dailyLimit: searchDailyLimit, autoItemsPerChapter: stored.autoItemsPerChapter ?? 3, requestsPerItem: stored.requestsPerItem ?? 2, apiKey, keyProtection: stored.keyProtection };
}
async function publicSearchSettings(settings) {
  const { apiKey, apiKeyProtected, ...safe } = settings;
  return { ...safe, hasApiKey: Boolean(apiKey), keyHint: apiKey ? `••••${apiKey.slice(-4)}` : "", ...(await searchBudget.usage()) };
}
async function saveSearchSettings(body) {
  const previous = await readSearchSettings();
  const within = (value, old, max) => {
    const next = value === undefined ? old : Number(value);
    if (!Number.isInteger(next) || next < 0 || next > max) throw new Error(`搜索额度必须是 0 到 ${max} 的整数`);
    return next;
  };
  const apiKey = body.clearKey ? "" : String(body.apiKey || "").trim() || previous.apiKey;
  const next = { dailyLimit: within(body.dailyLimit, previous.dailyLimit, 30), autoItemsPerChapter: within(body.autoItemsPerChapter, previous.autoItemsPerChapter, 3), requestsPerItem: within(body.requestsPerItem, previous.requestsPerItem, 2) };
  if (apiKey) {
    try { next.apiKeyProtected = await secretOperation("Protect", apiKey); next.keyProtection = "windows-dpapi"; }
    catch { next.apiKey = apiKey; next.keyProtection = "local-file-fallback"; }
  } else next.keyProtection = "none";
  const temp = `${SEARCH_FILE}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(temp, SEARCH_FILE);
  await chmod(SEARCH_FILE, 0o600).catch(() => {});
  if (apiKey !== previous.apiKey) await unlink(SEARCH_CACHE_FILE).catch((error) => { if (error.code !== "ENOENT") throw error; });
  searchDailyLimit = next.dailyLimit;
  return publicSearchSettings({ ...next, apiKey });
}
function publicProvider(settings) {
  const { apiKey, apiKeyProtected, ...safe } = settings;
  return { ...safe, hasApiKey: Boolean(apiKey), keyHint: apiKey ? `••••${apiKey.slice(-4)}` : "" };
}
async function saveProvider(body) {
  const existing = await readProvider();
  const protocol = String(body.protocol || existing.protocol);
  if (!["openai-chat", "openai-responses"].includes(protocol)) throw new Error("不支持的接口协议");
  const baseUrl = String(body.baseUrl ?? existing.baseUrl).trim().replace(/\/+$/, "");
  if (baseUrl) {
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("API 地址必须使用 HTTP 或 HTTPS");
  }
  const incomingKey = String(body.apiKey || "").trim();
  const previousOrigin = (() => { try { return new URL(existing.baseUrl).origin; } catch { return ""; } })();
  const nextOrigin = (() => { try { return new URL(baseUrl).origin; } catch { return ""; } })();
  const providerChanged = Boolean(previousOrigin && nextOrigin && previousOrigin !== nextOrigin);
  const next = {
    providerName: String(body.providerName ?? existing.providerName).trim(), protocol, baseUrl,
    model: String(body.model ?? existing.model).trim(),
    maxOutputTokens: Math.min(131072, Math.max(256, Number(body.maxOutputTokens || existing.maxOutputTokens || 8192))),
    inputPrice: Math.max(0, Number(body.inputPrice ?? existing.inputPrice ?? 0)),
    outputPrice: Math.max(0, Number(body.outputPrice ?? existing.outputPrice ?? 0)),
    noAuth: Boolean(body.noAuth),
    apiKey: incomingKey || (body.clearKey || providerChanged ? "" : (existing.apiKey || "")), updatedAt: new Date().toISOString()
  };
  const temp = `${PROVIDER_FILE}.tmp`;
  const { apiKey, ...stored } = next;
  if (apiKey) {
    try { stored.apiKeyProtected = await secretOperation("Protect", apiKey); stored.keyProtection = "windows-dpapi"; }
    catch { stored.apiKey = apiKey; stored.keyProtection = "local-file-fallback"; }
  } else stored.keyProtection = "none";
  await writeFile(temp, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
  await rename(temp, PROVIDER_FILE);
  await chmod(PROVIDER_FILE, 0o600).catch(() => {}); next.keyProtection = stored.keyProtection;
  return publicProvider(next);
}
async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error("请求数据过大"); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function calibrePath() {
  const candidates = ["C:\\Program Files\\Calibre2\\ebook-convert.exe", "C:\\Program Files (x86)\\Calibre2\\ebook-convert.exe"];
  return toolCandidates("CALIBRE_PATH", "ebook-convert", candidates)[0] || null;
}
function tesseractPath() {
  return japaneseOcrPath();
}
function bookRoot(book) { return join(LIBRARY, book.id); }
async function initializeProject(root, book, sourceFile) {
  for (const path of ["extracted", "chapters", "translations/working", "translations/polished", "state"]) await mkdir(join(root, path), { recursive: true });
  const state = join(root, "state"); const now = new Date().toISOString();
  await writeFile(join(state, "project.json"), `${JSON.stringify({ schemaVersion: 1, title: book.title, author: book.author, sourceLanguage: sourceLanguage(book), targetLanguage: "zh-CN", translationProfile: book.profile, sourceFile, createdAt: now }, null, 2)}\n`, "utf8");
  await writeFile(join(state, "progress.json"), `${JSON.stringify({ schemaVersion: 1, currentUnit: null, units: [], lastUpdated: now }, null, 2)}\n`, "utf8");
  await writeFile(join(state, "style-guide.md"), `# 翻译风格指南\n\n- 翻译模式：${book.profile}\n- 使用中文全角标点。\n- 专名、称谓和术语以书库术语表为准。\n- 不擅自补充原文没有的信息。\n`, "utf8");
  await writeFile(join(state, "glossary.csv"), "japanese,reading,chinese,category,first_occurrence,context_notes,status,verification,source_url,verification_note,verified_at\n", "utf8");
  await writeFile(join(state, "characters.csv"), "japanese_name,reading,chinese_name,identity,forms_of_address,relationships,first_occurrence,notes,status,verification,source_url,verification_note,verified_at\n", "utf8");
  await writeFile(join(state, "source-map.csv"), "unit_id,paragraph_id,source_file,source_type,source_locator,pdf_page_index,printed_page,chapter,notes\n", "utf8");
  await writeFile(join(state, "uncertainties.md"), "# 疑难与待确认事项\n\n暂无。\n", "utf8");
}
function csvCell(value) { const text = String(value ?? ""); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
async function saveGlossaryState(book) {
  if (book.demo) return;
  const header = "japanese,reading,chinese,category,first_occurrence,context_notes,status,verification,source_url,verification_note,verified_at,definition,translator_note";
  const rows = (book.glossary || []).map((item) => [item.japanese, item.reading, item.chinese, item.category, item.firstOccurrence, item.notes, item.status, item.verification, item.sourceUrl, item.verificationNote, item.verifiedAt, item.definition, item.translatorNote].map(csvCell).join(","));
  await writeFile(join(bookRoot(book), "state", "glossary.csv"), `${[header, ...rows].join("\n")}\n`, "utf8");
}
async function saveCharactersState(book) {
  if (book.demo) return;
  const header = "japanese_name,reading,chinese_name,identity,forms_of_address,relationships,first_occurrence,notes,status,verification,source_url,verification_note,verified_at,definition,translator_note";
  const rows = (book.characters || []).map((item) => [item.japanese || item.japaneseName, item.reading, item.chinese || item.chineseName, item.identity, item.formsOfAddress, item.relationships, item.firstOccurrence, item.notes, item.status, item.verification, item.sourceUrl, item.verificationNote, item.verifiedAt, item.definition, item.translatorNote].map(csvCell).join(","));
  await writeFile(join(bookRoot(book), "state", "characters.csv"), `${[header, ...rows].join("\n")}\n`, "utf8");
}
async function saveUncertaintiesState(book) {
  if (book.demo) return;
  const items = book.uncertainties || [];
  const lines = ["# 疑难与待确认事项", "", ...items.flatMap((item) => [
    `## ${item.chapter || "未知章节"} · ${item.text || "未命名问题"}`,
    "",
    `- 状态：${item.status === "resolved" ? "已解决" : "待处理"}`,
    `- 类型：${item.type || "其他"}`,
    `- 疑点：${item.note || ""}`,
    `- 最终判断：${item.resolution || ""}`,
    `- 核实来源：${item.sourceUrl || "未附来源"}`,
    `- 核实说明：${item.verificationNote || ""}`,
    ""
  ])];
  await writeFile(join(bookRoot(book), "state", "uncertainties.md"), `${lines.join("\n")}\n`, "utf8");
}
function checkedSourceUrl(value) {
  const sourceUrl = String(value || "").trim();
  if (sourceUrl) {
    let parsed;
    try { parsed = new URL(sourceUrl); } catch { throw new Error("核实来源不是有效网址"); }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("核实来源必须是 HTTP 或 HTTPS 地址");
  }
  return sourceUrl;
}
function verifiedByResearch(item, sourceUrl) {
  return Boolean(sourceUrl && item?.research?.verdict === "supported" && item.research.sourceUrls?.includes(sourceUrl));
}
async function syncProjectState(book) {
  if (book.demo) return;
  const stateDir = join(bookRoot(book), "state"); await mkdir(stateDir, { recursive: true });
  const units = (book.chapters || []).filter((chapter) => !chapter.id.endsWith("-pending")).map((chapter) => ({ id: chapter.id, title: chapter.title, status: chapter.status, sourceLocator: chapter.sourceLocator || "", sourcePath: chapter.sourcePath || "", translationPath: chapter.translationPath || "", polishedPath: chapter.polishedPath || "", updatedAt: chapter.updatedAt || null }));
  const current = units.find((unit) => ["extracting", "translating"].includes(unit.status))?.id || null;
  await writeFile(join(stateDir, "progress.json"), `${JSON.stringify({ schemaVersion: 1, currentUnit: current, units, lastUpdated: new Date().toISOString() }, null, 2)}\n`, "utf8");
  const header = "unit_id,paragraph_id,source_file,source_type,source_locator,pdf_page_index,printed_page,chapter,notes";
  const rows = (book.chapters || []).filter((chapter) => chapter.sourcePath).map((chapter) => [chapter.id, "", book.sourceFile, book.format, chapter.sourceLocator, "", "", chapter.title, chapter.sourcePath].map(csvCell).join(","));
  await writeFile(join(stateDir, "source-map.csv"), `${[header, ...rows].join("\n")}\n`, "utf8");
}
async function syncProjectMetadata(book) {
  if (book.demo) return;
  const path = join(bookRoot(book), "state", "project.json");
  let project = {};
  try { project = JSON.parse(await readFile(path, "utf8")); } catch { /* repair missing metadata file */ }
  Object.assign(project, { schemaVersion: 1, title: book.title, author: book.author, sourceLanguage: sourceLanguage(book), targetLanguage: "zh-CN", translationProfile: book.profile, updatedAt: new Date().toISOString() });
  await writeFile(path, `${JSON.stringify(project, null, 2)}\n`, "utf8");
}
const taskControls = new Map();
let taskQueue = Promise.resolve();
const bookMutationQueues = new Map();
function withBookMutation(bookId, operation) {
  const next = (bookMutationQueues.get(bookId) || Promise.resolve()).then(operation);
  bookMutationQueues.set(bookId, next.catch(() => {}));
  return next;
}
async function updateTask(taskId, changes) {
  const data = await readLibrary();
  for (const book of data.books) { const task = (book.tasks || []).find((item) => item.id === taskId); if (task) { Object.assign(task, changes, { updatedAt: new Date().toISOString() }); await saveLibrary(data); return task; } }
  return null;
}
async function startTask(bookId, type, detail, runner) {
  const data = await readLibrary(); const book = data.books.find((item) => item.id === bookId); if (!book) throw new Error("作品不存在");
  const duplicate = (book.tasks || []).find((item) => item.status === "running" && item.type === type && item.detail === detail);
  if (duplicate) return duplicate;
  const task = { id: `task-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`, type, status: "running", progress: 0, detail, createdAt: new Date().toISOString() };
  book.tasks ||= []; book.tasks.unshift(task); await saveLibrary(data);
  const control = { paused: false, cancelled: false }; taskControls.set(task.id, control);
  taskQueue = taskQueue.then(async () => {
    try { await runner(task, control); if (!control.cancelled) await updateTask(task.id, { status: "completed", progress: 100 }); }
    catch (error) { await updateTask(task.id, { status: control.cancelled ? "cancelled" : "failed", error: error.message, detail: `${detail} · ${error.message}` }); }
    finally { taskControls.delete(task.id); }
  });
  return task;
}
async function extractBookTask(bookId) {
  return startTask(bookId, "章节提取", "识别目录和正文", async (task) => {
    const data = await readLibrary(); const book = data.books.find((item) => item.id === bookId); await updateTask(task.id, { progress: 8, detail: book.format === "AZW3" ? "Calibre 正在转换 AZW3；大型合集可能需要数分钟" : "正在读取原文件" });
    const result = await extractDocument({ book, bookRoot: bookRoot(book), calibrePath: calibrePath() });
    const fresh = await readLibrary(); const target = fresh.books.find((item) => item.id === bookId); const previous = new Map((target.chapters || []).map((chapter) => [chapter.id, chapter]));
    target.chapters = result.chapters.map((chapter) => {
      const old = previous.get(chapter.id); if (!old) return chapter;
      return preserveChapterRevisionState(chapter, old);
    });
    const validIds = new Set(target.chapters.map((chapter) => chapter.id));
    target.works = (result.works || []).map((work) => ({ ...work, chapterIds: work.chapterIds.filter((id) => validIds.has(id)) })).filter((work) => work.chapterIds.length);
    target.scopes = (target.scopes || []).filter((scope) => !scope.auto).map((scope) => ({ ...scope, kind: "custom", chapterIds: (scope.chapterIds || []).filter((id) => validIds.has(id)) })).filter((scope) => scope.chapterIds.length);
    target.extractionManifest = result.manifestPath; target.extractedAt = new Date().toISOString();
    const importedStem = basename(target.sourceFile, extname(target.sourceFile));
    if (result.metadata.title && (!target.title || target.title === importedStem)) target.title = result.metadata.title;
    if (result.metadata.creator && !target.author) target.author = result.metadata.creator;
    if (result.pagesNeedingOcr.length) target.uncertainties.push({ id: `ocr-${Date.now()}`, chapter: "PDF", type: "OCR", text: `${result.pagesNeedingOcr.length} 页未提取到足够文本`, note: `可能需要 OCR：${result.pagesNeedingOcr.slice(0, 40).join("、")}`, status: "open" });
    await saveLibrary(fresh); await syncProjectState(target); await updateTask(task.id, { progress: 96, detail: `已整理 ${target.works.length || 1} 部作品、${result.chapters.length} 个正文单元` });
  });
}
function selectSourceRange(source, range = { type: "whole" }) {
  const type = range?.type || "whole";
  if (type === "whole") return { source, label: "整章", partial: false };
  if (type === "paragraphs") {
    const paragraphs = source.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
    const start = Math.max(1, Number(range.start || 1)); const end = Math.min(paragraphs.length, Number(range.end || start));
    if (!paragraphs.length || end < start) throw new Error("段落范围无效");
    return { source: paragraphs.slice(start - 1, end).join("\n\n"), label: `第 ${start}–${end} 段`, partial: true, range: { type, start, end } };
  }
  if (type === "pages") {
    const start = Math.max(1, Number(range.start || 1)); const end = Math.max(start, Number(range.end || start));
    const blocks = [...source.matchAll(/\[\[PDF_PAGE_(\d+)\]\]\s*([\s\S]*?)(?=\[\[PDF_PAGE_\d+\]\]|$)/g)]
      .filter((match) => Number(match[1]) >= start && Number(match[1]) <= end)
      .map((match) => match[2].trim()).filter(Boolean);
    if (!blocks.length) throw new Error("所选页码没有可翻译文本；请确认 PDF 页码范围");
    return { source: blocks.join("\n\n"), label: `PDF 第 ${start}–${end} 页`, partial: true, range: { type, start, end } };
  }
  throw new Error("不支持的翻译范围");
}
async function translateBookChapter(bookId, chapterId, mode, range) {
  const rangeLabel = range?.type === "paragraphs" ? `第 ${range.start}–${range.end} 段` : range?.type === "pages" ? `PDF 第 ${range.start}–${range.end} 页` : "整章";
  return startTask(bookId, mode === "refine" ? "译文精校" : "章节翻译", `${chapterId} · ${rangeLabel}`, async (task, control) => {
    let data = await readLibrary(); let book = data.books.find((item) => item.id === bookId); let chapter = book?.chapters.find((item) => item.id === chapterId); if (!chapter) throw new Error("章节不存在");
    const root = bookRoot(book); const fullSource = await readChapterText(root, chapter, "source"); if (!fullSource.trim()) throw new Error("本章没有可翻译原文");
    const selected = selectSourceRange(fullSource, range);
    if (selected.partial && mode === "refine") throw new Error("节选当前仅支持初译；译后可在节选卡片中编辑和批准");
    const chapterIndex = book.chapters.findIndex((item) => item.id === chapterId); const previous = chapterIndex > 0 ? book.chapters[chapterIndex - 1] : null;
    const previousText = previous ? await readChapterText(root, previous, previous.polishedPath ? "polished" : "translation") : "";
    const existingDraft = await readChapterText(root, chapter, chapter.polishedPath ? "polished" : "translation");
    const startingRevisionId = chapter.revisionId || null;
    if (mode === "refine" && !existingDraft.trim()) throw new Error("请先完成本章初译");
    if (!selected.partial) await withBookMutation(bookId, async () => {
      const latest = await readLibrary(); const currentBook = latest.books.find((entry) => entry.id === bookId); const current = currentBook?.chapters.find((entry) => entry.id === chapterId);
      if (current && (current.revisionId || null) === startingRevisionId) { current.status = "translating"; await saveLibrary(latest); }
    });
    const provider = await readProvider();
    let result;
    try {
      result = await translateChapter({ provider, book, chapter, source: selected.source, previousTail: previousText.slice(-1200), glossary: book.glossary || [], characters: book.characters || [], existingDraft, mode, control, onProgress: (progress, detailText) => updateTask(task.id, { progress, detail: `${chapter.title} · ${selected.label} · ${detailText}` }) });
    } catch (error) {
      if (!selected.partial) await withBookMutation(bookId, async () => {
        const failedData = await readLibrary(); const failedBook = failedData.books.find((item) => item.id === bookId); const failedChapter = failedBook?.chapters.find((item) => item.id === chapterId);
        if (failedChapter && (failedChapter.revisionId || null) === startingRevisionId) { failedChapter.status = "failed"; failedChapter.updatedAt = new Date().toISOString(); await saveLibrary(failedData); await syncProjectState(failedBook); }
      });
      throw error;
    }
    const segmentId = selected.partial ? `segment-${Date.now()}-${Math.random().toString(16).slice(2, 6)}` : "";
    const revisionId = newRevisionId();
    const outputPath = await writeTranslation(root, chapter, result.text, mode === "refine", selected.partial ? segmentId : `ai-${revisionId}`);
    const adopted = await withBookMutation(bookId, async () => {
      data = await readLibrary(); book = data.books.find((item) => item.id === bookId); chapter = book?.chapters.find((item) => item.id === chapterId);
      if (!chapter) return false;
      chapter.revisionHistory ||= [];
      if (!selected.partial && (chapter.revisionId || null) !== startingRevisionId) {
        chapter.revisionHistory.push({ id: revisionId, path: outputPath, origin: "ai", createdAt: new Date().toISOString(), reason: "AI 完成时读者已有新版本；未自动采用" });
        await saveLibrary(data);
        return false;
      }
      if (selected.partial) {
        chapter.segments ||= []; chapter.segments.unshift({ id: segmentId, label: selected.label, range: selected.range, source: selected.source, translationPath: outputPath, status: "review", createdAt: new Date().toISOString(), usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, estimatedCost: result.estimatedCost }, lastModel: provider.model });
      } else {
        if (mode === "refine") chapter.polishedPath = outputPath; else chapter.translationPath = outputPath;
        chapter.status = "review";
        chapter.draftOrigin = existingDraft && mode === "refine" && chapter.draftOrigin === "reader" ? "reader" : "ai";
        chapter.revisionId = revisionId;
        chapter.exportedAt = null;
        chapter.revisionHistory.push({ id: revisionId, path: outputPath, origin: chapter.draftOrigin, createdAt: new Date().toISOString(), reason: mode === "refine" ? "AI 精校" : "AI 初译" });
      }
      chapter.updatedAt = new Date().toISOString(); chapter.usage ||= { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
      chapter.usage.inputTokens += result.inputTokens; chapter.usage.outputTokens += result.outputTokens; chapter.usage.estimatedCost += result.estimatedCost;
      chapter.lastModel = provider.model; await saveLibrary(data); await syncProjectState(book);
      return true;
    });
    if (!adopted) { await updateTask(task.id, { detail: `${chapter.title} · AI 译稿已留存为历史版本；读者修改未覆盖` }); return; }
    if (mode === "draft" && !selected.partial) {
      try {
        const analysis = await analyzeChapterEntities({ provider, book, chapter, source: selected.source });
        await storeChapterAnalysis(bookId, chapterId, analysis, provider.model);
        const settings = await readSearchSettings();
        const risks = identifyHighRisk({ source: selected.source, draft: result.text, analysis, glossary: book.glossary || [], characters: book.characters || [] }).slice(0, settings.autoItemsPerChapter);
        const autoChecks = [];
        for (const risk of risks) {
          const researched = await verifyIssue({ book, item: { japanese: risk.originalTerm, disambiguator: risk.disambiguator, chinese: risk.proposed, chapter: chapter.title }, kind: "term", apiKey: settings.apiKey, budget: searchBudget, provider, requestsPerItem: settings.requestsPerItem });
          const autoRevised = await maybeAutoReviseChapter({ bookId, chapterId, source: selected.source, provider, risk, research: researched });
          autoChecks.push({ ...risk, verdict: researched.verdict, reason: researched.reason || "", sources: researched.sources || [], researchedAt: researched.searchedAt, autoRevised });
        }
        await withBookMutation(bookId, async () => {
          const latest = await readLibrary(); const current = latest.books.find((entry) => entry.id === bookId)?.chapters.find((entry) => entry.id === chapterId);
          if (current) { current.quality = { analyzedAt: new Date().toISOString(), autoChecks, unresolved: autoChecks.filter((entry) => entry.verdict !== "supported").length }; await saveLibrary(latest); }
        });
      } catch (error) {
        await withBookMutation(bookId, async () => {
          const latest = await readLibrary(); const current = latest.books.find((entry) => entry.id === bookId)?.chapters.find((entry) => entry.id === chapterId);
          if (current) { current.analysisError = `初译已保存，术语分析暂不可用：${error.message}`; await saveLibrary(latest); }
        });
      }
    }
  });
}
async function storeChapterAnalysis(bookId, chapterId, result, model) {
  return withBookMutation(bookId, async () => {
    const fresh = await readLibrary(); const targetBook = fresh.books.find((item) => item.id === bookId); const targetChapter = targetBook.chapters.find((item) => item.id === chapterId);
    targetBook.termCandidates ||= []; targetBook.characterCandidates ||= []; targetBook.uncertainties ||= [];
    const existingTerms = new Set([...(targetBook.glossary || []), ...targetBook.termCandidates].map((item) => item.japanese));
    for (const item of result.terms) if (item.japanese && item.chinese && !existingTerms.has(item.japanese)) { targetBook.termCandidates.push({ ...item, id: `term-candidate-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, chapter: targetChapter.title, chapterId, status: "suggested", verification: "AI 建议，未联网核实" }); existingTerms.add(item.japanese); }
    const existingPeople = new Set([...(targetBook.characters || []), ...targetBook.characterCandidates].map((item) => item.japanese || item.japaneseName));
    for (const item of result.characters) if (item.japanese && item.chinese && !existingPeople.has(item.japanese)) { targetBook.characterCandidates.push({ ...item, id: `character-candidate-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, chapter: targetChapter.title, chapterId, status: "suggested", verification: "AI 建议，未联网核实" }); existingPeople.add(item.japanese); }
    const candidateNames = [...(targetBook.glossary || []), ...(targetBook.characters || []), ...result.terms, ...result.characters].map((item) => item.japanese || item.japaneseName).filter(Boolean);
    const existingQuestions = new Set(targetBook.uncertainties.map((item) => `${item.chapterId || item.chapter}|${item.text}`));
    for (const item of result.uncertainties) {
      if (candidateNames.includes(item.text)) continue;
      const key = `${chapterId}|${item.text}`; if (!existingQuestions.has(key)) { targetBook.uncertainties.push({ ...item, id: `uncertainty-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, chapter: targetChapter.title, chapterId, status: "open", source: "AI 分析，待人工确认" }); existingQuestions.add(key); }
    }
    targetChapter.analysis = { analyzedAt: new Date().toISOString(), model, analyzedCharacters: result.analyzedCharacters, sourceCharacters: result.sourceCharacters, termSuggestions: result.terms.length, characterSuggestions: result.characters.length, uncertaintyCount: result.uncertainties.length };
    await saveLibrary(fresh); await syncProjectState(targetBook); await saveUncertaintiesState(targetBook);
    return { book: targetBook, chapter: targetChapter };
  });
}
async function maybeAutoReviseChapter({ bookId, chapterId, source, provider, risk, research }) {
  const snapshot = await readLibrary(); const book = snapshot.books.find((entry) => entry.id === bookId); const chapter = book?.chapters.find((entry) => entry.id === chapterId);
  if (!chapter || !canAutoReviseFromEvidence(chapter, research) || research.suggestedChinese === risk.proposed) return false;
  const expectedRevisionId = chapter.revisionId;
  const polished = Boolean(chapter.polishedPath);
  const existingDraft = await readChapterText(bookRoot(book), chapter, polished ? "polished" : "translation");
  let revised;
  try {
    revised = await translateChapter({ provider, book, chapter, source, existingDraft, mode: "refine", correction: { originalTerm: risk.originalTerm, currentChinese: risk.proposed, suggestedChinese: research.suggestedChinese, evidence: research.sources.map((entry) => `${entry.title || entry.url}：${entry.excerpt}`).join("；").slice(0, 1500) }, control: { paused: false, cancelled: false } });
  } catch { return false; }
  if (!revised.text.includes(research.suggestedChinese) || revised.text.includes(risk.proposed)) return false;
  return withBookMutation(bookId, async () => {
    const latest = await readLibrary(); const currentBook = latest.books.find((entry) => entry.id === bookId); const current = currentBook?.chapters.find((entry) => entry.id === chapterId);
    if (!canAutoRevise(current, expectedRevisionId)) return false;
    const revisionId = newRevisionId();
    const outputPath = await writeTranslation(bookRoot(currentBook), current, revised.text, polished, `verified-${revisionId}`);
    if (polished) current.polishedPath = outputPath; else current.translationPath = outputPath;
    current.revisionId = revisionId; current.updatedAt = new Date().toISOString();
    current.revisionHistory ||= [];
    current.revisionHistory.push({ id: revisionId, path: outputPath, origin: "ai", createdAt: current.updatedAt, reason: `AI 联网纠正 ${risk.originalTerm}：${risk.proposed} → ${research.suggestedChinese}`, sources: research.sources });
    await saveLibrary(latest); await syncProjectState(currentBook);
    return true;
  });
}
async function analyzeBookChapter(bookId, chapterId) {
  return startTask(bookId, "术语人物分析", chapterId, async (task) => {
    const data = await readLibrary(); const book = data.books.find((item) => item.id === bookId); const chapter = book?.chapters.find((item) => item.id === chapterId);
    if (!chapter) throw new Error("章节不存在");
    const source = await readChapterText(bookRoot(book), chapter, "source"); if (!source.trim()) throw new Error("本章没有可分析的原文");
    await updateTask(task.id, { progress: 12, detail: `${chapter.title} · 正在识别术语、人名和疑难点` });
    const provider = await readProvider();
    const result = await analyzeChapterEntities({ provider, book, chapter, source });
    await storeChapterAnalysis(bookId, chapterId, result, provider.model);
    await updateTask(task.id, { progress: 96, detail: `${chapter.title} · 找到 ${result.terms.length} 个术语、${result.characters.length} 个人名、${result.uncertainties.length} 个疑难点` });
  });
}
async function upload(req, res, url) {
  const original = safeName(url.searchParams.get("filename") || "book");
  const extension = extname(original).toLowerCase();
  if (![".pdf", ".epub", ".azw3"].includes(extension)) return json(res, 400, { error: "仅支持 PDF、EPUB 和 AZW3" });
  const selectedLanguage = url.searchParams.get("sourceLanguage") || "ja";
  if (!SOURCE_LANGUAGES.some((entry) => entry.code === selectedLanguage)) return json(res, 400, { error: "不支持的原文语种" });
  const id = `book-${Date.now()}`;
  const sourceDir = join(LIBRARY, id, "source");
  await mkdir(sourceDir, { recursive: true });
  const output = join(sourceDir, original);
  const stream = (await import("node:fs")).createWriteStream(output, { flags: "wx" });
  let size = 0;
  try {
    for await (const chunk of req) { size += chunk.length; if (size > MAX_UPLOAD) throw new Error("文件超过 512MB"); if (!stream.write(chunk)) await new Promise((resolve) => stream.once("drain", resolve)); }
    stream.end(); await new Promise((resolve, reject) => { stream.once("finish", resolve); stream.once("error", reject); });
  } catch (error) { stream.destroy(); return json(res, 400, { error: error.message }); }
  const data = await readLibrary();
  const book = { id, title: url.searchParams.get("title") || original.replace(extension, ""), author: url.searchParams.get("author") || "", format: extension.slice(1).toUpperCase(), profile: url.searchParams.get("profile") || "自动判断", sourceLanguage: selectedLanguage, demo: false, sourceFile: join("source", original), createdAt: new Date().toISOString(), chapters: [{ id: `${id}-pending`, title: "等待章节识别", status: "not_started", source: "文件已安全导入，尚未执行提取。", translation: "", paragraphCount: 0 }], glossary: [], characters: [], uncertainties: [], tasks: [{ id: `task-${Date.now()}`, type: "书籍导入", status: "completed", progress: 100, detail: original }] };
  await initializeProject(join(LIBRARY, id), book, book.sourceFile); data.books.unshift(book);
  await saveLibrary(data);
  json(res, 201, { id, title: data.books[0].title });
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true });
  if (req.method === "GET" && url.pathname === "/api/search-settings") return json(res, 200, await publicSearchSettings(await readSearchSettings()));
  if (req.method === "PUT" && url.pathname === "/api/search-settings") return json(res, 200, await saveSearchSettings(await readJson(req)));
  if (req.method === "POST" && url.pathname === "/api/search-settings/test") {
    const settings = await readSearchSettings();
    if (!settings.apiKey) return json(res, 400, { error: "请先填写独立的搜索 API Key" });
    const started = Date.now();
    try {
      const results = await searchResearchSources({ query: "OpenAI", apiKey: settings.apiKey, budget: searchBudget });
      return json(res, 200, { ok: true, resultCount: results.length, latencyMs: Date.now() - started, usage: await searchBudget.usage() });
    } catch (error) { return json(res, error.code === "SEARCH_DAILY_LIMIT" ? 429 : 502, { error: error.message, code: error.code || "SEARCH_SERVICE" }); }
  }
  if (req.method === "GET" && url.pathname === "/api/provider") return json(res, 200, publicProvider(await readProvider()));
  if (req.method === "PUT" && url.pathname === "/api/provider") return json(res, 200, await saveProvider(await readJson(req)));
  if (req.method === "POST" && url.pathname === "/api/provider/test") return json(res, 200, await testProviderConnection(await readProvider()));
  if (req.method === "GET" && url.pathname === "/api/library") return json(res, 200, await readLibrary());
  if (req.method === "DELETE" && url.pathname === "/api/tasks" && url.searchParams.get("finished") === "1") {
    const data = await readLibrary(); let deleted = 0;
    for (const book of data.books) { const before = (book.tasks || []).length; book.tasks = (book.tasks || []).filter((task) => ["running", "paused"].includes(task.status)); deleted += before - book.tasks.length; }
    await saveLibrary(data); return json(res, 200, { deleted });
  }
  const taskDeleteMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === "DELETE" && taskDeleteMatch) {
    const data = await readLibrary();
    for (const book of data.books) {
      const index = (book.tasks || []).findIndex((task) => task.id === taskDeleteMatch[1]); if (index < 0) continue;
      if (["running", "paused"].includes(book.tasks[index].status)) return json(res, 409, { error: "运行中或暂停的任务不能删除，请先取消" });
      book.tasks.splice(index, 1); await saveLibrary(data); return json(res, 200, { deleted: true });
    }
    return json(res, 404, { error: "任务不存在" });
  }
  if (req.method === "GET" && url.pathname === "/api/capabilities") return json(res, 200, { dataDirectory: DATA_ROOT, calibre: Boolean(calibrePath()), calibrePath: calibrePath(), ocr: Boolean(tesseractPath()), ocrPath: tesseractPath(), ocrLanguages: Object.fromEntries(SOURCE_LANGUAGES.map((entry) => [entry.code, ocrStatus(entry.code)])), epubExport: true, localOnly: true });
  if (req.method === "POST" && url.pathname === "/api/import") return upload(req, res, url);
  const extractMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/extract$/);
  if (req.method === "POST" && extractMatch) return json(res, 202, await extractBookTask(extractMatch[1]));
  const bookMatch = url.pathname.match(/^\/api\/books\/([^/]+)$/);
  if (req.method === "PATCH" && bookMatch) {
    const body = await readJson(req); const data = await readLibrary(); const book = data.books.find((item) => item.id === bookMatch[1]);
    if (!book) return json(res, 404, { error: "作品不存在" });
    const title = String(body.title ?? book.title).trim(); if (!title) return json(res, 400, { error: "书名不能为空" });
    book.title = title; book.author = String(body.author ?? book.author ?? "").trim();
    if (["自动判断", "现代文学", "古典文学", "学术文献"].includes(body.profile)) book.profile = body.profile;
    if (body.sourceLanguage !== undefined) {
      if (!SOURCE_LANGUAGES.some((entry) => entry.code === body.sourceLanguage)) return json(res, 400, { error: "不支持的原文语种" });
      book.sourceLanguage = body.sourceLanguage;
    }
    book.updatedAt = new Date().toISOString(); await saveLibrary(data); await syncProjectMetadata(book); return json(res, 200, book);
  }
  if (req.method === "DELETE" && bookMatch) {
    const data = await readLibrary(); const index = data.books.findIndex((item) => item.id === bookMatch[1]); if (index < 0) return json(res, 404, { error: "作品不存在" });
    const book = data.books[index]; const target = resolve(bookRoot(book)); const allowedRoot = `${resolve(LIBRARY)}${sep}`;
    if (!target.startsWith(allowedRoot)) throw new Error("作品目录不在书库范围内，已停止删除");
    for (const task of book.tasks || []) { const control = taskControls.get(task.id); if (control) control.cancelled = true; }
    let trashedTo = "";
    if (existsSync(target)) { const trash = join(LIBRARY, ".trash"); await mkdir(trash, { recursive: true }); trashedTo = join(trash, `${book.id}-${Date.now()}`); await rename(target, trashedTo); }
    data.books.splice(index, 1);
    try { await saveLibrary(data); } catch (error) { if (trashedTo) await rename(trashedTo, target).catch(() => {}); throw error; }
    return json(res, 200, { deleted: true, recoverable: Boolean(trashedTo), title: book.title });
  }
  const chapterMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/chapters\/([^/]+)$/);
  if (req.method === "GET" && chapterMatch) {
    const data = await readLibrary(); const book = data.books.find((item) => item.id === chapterMatch[1]); const chapter = book?.chapters.find((item) => item.id === chapterMatch[2]);
    if (!chapter) return json(res, 404, { error: "章节不存在" });
    const root = bookRoot(book); const source = await readChapterText(root, chapter, "source"); const translation = await readChapterText(root, chapter, chapter.polishedPath ? "polished" : "translation");
    const segments = [];
    for (const segment of chapter.segments || []) {
      let segmentTranslation = "";
      try { segmentTranslation = await readFile(join(root, segment.translationPath), "utf8"); } catch { /* keep missing segment visible */ }
      segments.push({ ...segment, translation: segmentTranslation });
    }
    return json(res, 200, { ...chapter, source, translation, segments });
  }
  if (req.method === "PATCH" && chapterMatch) {
    return withBookMutation(chapterMatch[1], async () => {
    const body = await readJson(req); const data = await readLibrary(); const book = data.books.find((item) => item.id === chapterMatch[1]); const chapter = book?.chapters.find((item) => item.id === chapterMatch[2]);
    if (!chapter) return json(res, 404, { error: "章节不存在" });
    if (!book.demo && body.translation !== undefined) {
      const polished = Boolean(chapter.polishedPath); const revisionId = newRevisionId(); const savedPath = await writeTranslation(bookRoot(book), chapter, body.translation, polished, `reader-${revisionId}`);
      if (polished) chapter.polishedPath = savedPath; else chapter.translationPath = savedPath;
      chapter.draftOrigin = "reader"; chapter.revisionId = revisionId; chapter.exportedAt = null;
      chapter.revisionHistory ||= []; chapter.revisionHistory.push({ id: revisionId, path: savedPath, origin: "reader", createdAt: new Date().toISOString(), reason: "读者修改" });
    } else if (body.translation !== undefined) chapter.translation = body.translation;
    Object.assign(chapter, { status: body.status ?? chapter.status, updatedAt: new Date().toISOString() }); await saveLibrary(data); await syncProjectState(book); return json(res, 200, { ...chapter, translation: body.translation });
    });
  }
  const restoreMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/chapters\/([^/]+)\/revisions\/([^/]+)\/restore$/);
  if (req.method === "POST" && restoreMatch) return withBookMutation(restoreMatch[1], async () => {
    const data = await readLibrary(); const book = data.books.find((entry) => entry.id === restoreMatch[1]); const chapter = book?.chapters.find((entry) => entry.id === restoreMatch[2]);
    const selected = chapter?.revisionHistory?.find((entry) => entry.id === restoreMatch[3]);
    if (!selected) return json(res, 404, { error: "译稿版本不存在" });
    const root = resolve(bookRoot(book)); const target = resolve(root, selected.path);
    if (!target.startsWith(`${root}${sep}`) || !existsSync(target)) return json(res, 409, { error: "历史译稿文件不可用，未进行恢复" });
    if (selected.path.replaceAll("\\", "/").includes("/polished/")) chapter.polishedPath = selected.path;
    else { chapter.translationPath = selected.path; chapter.polishedPath = ""; }
    chapter.draftOrigin = "reader"; chapter.exportedAt = null; chapter.status = "review"; chapter.revisionId = newRevisionId(); chapter.updatedAt = new Date().toISOString();
    chapter.revisionHistory.push({ id: chapter.revisionId, path: selected.path, origin: "reader", createdAt: chapter.updatedAt, reason: `读者恢复版本 ${selected.id}` });
    await saveLibrary(data); await syncProjectState(book); return json(res, 200, chapter);
  });
  const translateMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/chapters\/([^/]+)\/translate$/);
  if (req.method === "POST" && translateMatch) { const body = await readJson(req); return json(res, 202, await translateBookChapter(translateMatch[1], translateMatch[2], body.mode === "refine" ? "refine" : "draft", body.range || { type: "whole" })); }
  const analyzeMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/chapters\/([^/]+)\/analyze$/);
  if (req.method === "POST" && analyzeMatch) return json(res, 202, await analyzeBookChapter(analyzeMatch[1], analyzeMatch[2]));
  const segmentMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/chapters\/([^/]+)\/segments\/([^/]+)$/);
  if (req.method === "PATCH" && segmentMatch) {
    const body = await readJson(req); const data = await readLibrary(); const book = data.books.find((item) => item.id === segmentMatch[1]); const chapter = book?.chapters.find((item) => item.id === segmentMatch[2]); const segment = chapter?.segments?.find((item) => item.id === segmentMatch[3]);
    if (!segment) return json(res, 404, { error: "节选译文不存在" });
    if (body.translation !== undefined) await writeFile(join(bookRoot(book), segment.translationPath), `${String(body.translation).trim()}\n`, "utf8");
    if (["review", "approved"].includes(body.status)) segment.status = body.status;
    segment.updatedAt = new Date().toISOString(); await saveLibrary(data); return json(res, 200, segment);
  }
  const scopeMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/scopes$/);
  if (req.method === "POST" && scopeMatch) {
    const body = await readJson(req); const data = await readLibrary(); const book = data.books.find((item) => item.id === scopeMatch[1]); if (!book) return json(res, 404, { error: "作品不存在" });
    const chapterIds = [...new Set((body.chapterIds || []).filter((id) => book.chapters.some((chapter) => chapter.id === id)))];
    if (!String(body.name || "").trim() || !chapterIds.length) return json(res, 400, { error: "请填写选集名称并至少选择一个章节" });
    book.scopes ||= []; const scope = { id: `scope-${Date.now()}`, name: String(body.name).trim(), chapterIds, createdAt: new Date().toISOString() }; book.scopes.push(scope); await saveLibrary(data); return json(res, 201, scope);
  }
  const scopeItemMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/scopes\/([^/]+)$/);
  if (req.method === "DELETE" && scopeItemMatch) {
    const data = await readLibrary(); const book = data.books.find((item) => item.id === scopeItemMatch[1]); if (!book) return json(res, 404, { error: "作品不存在" });
    const before = (book.scopes || []).length; book.scopes = (book.scopes || []).filter((scope) => scope.id !== scopeItemMatch[2] || scope.auto);
    if (book.scopes.length === before) return json(res, 404, { error: "选集不存在" });
    await saveLibrary(data); return json(res, 200, { ok: true });
  }
  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(pause|resume|cancel)$/);
  if (req.method === "POST" && taskMatch) {
    const control = taskControls.get(taskMatch[1]); if (!control) return json(res, 409, { error: "任务当前不在运行；应用重启后的任务请重新发起" });
    const action = taskMatch[2]; if (action === "pause") control.paused = true; if (action === "resume") control.paused = false; if (action === "cancel") control.cancelled = true;
    const status = action === "pause" ? "paused" : action === "resume" ? "running" : "cancelled"; return json(res, 200, await updateTask(taskMatch[1], { status }));
  }
  const researchMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/research\/(term|character|glossary|characters|uncertainty)\/([^/]+)$/);
  if (req.method === "DELETE" && researchMatch) {
    const [, bookId, kind, itemId] = researchMatch;
    const data = await readLibrary(); const book = data.books.find((entry) => entry.id === bookId);
    const listName = { term: "termCandidates", character: "characterCandidates", glossary: "glossary", characters: "characters", uncertainty: "uncertainties" }[kind];
    const item = (book?.[listName] || []).find((entry) => entry.id === itemId);
    if (!item) return json(res, 404, { error: "考证条目不存在" });
    delete item.research;
    if (item.verification === "AI 已检索资料，待译者确认") item.verification = item.status === "approved" ? "人工批准，未附来源" : "AI 建议，未联网核实";
    await saveLibrary(data); return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && researchMatch) {
    const [, bookId, kind, itemId] = researchMatch;
    const initial = await readLibrary(); const book = initial.books.find((entry) => entry.id === bookId);
    if (!book) return json(res, 404, { error: "作品不存在" });
    const listName = { term: "termCandidates", character: "characterCandidates", glossary: "glossary", characters: "characters", uncertainty: "uncertainties" }[kind];
    const item = (book[listName] || []).find((entry) => entry.id === itemId);
    if (!item) return json(res, 404, { error: "考证条目不存在" });
    const settings = await readSearchSettings();
    const research = await verifyIssue({ book, item, kind, apiKey: settings.apiKey, budget: searchBudget, provider: await readProvider(), requestsPerItem: settings.requestsPerItem });
    research.searchedAt ||= new Date().toISOString();
    const fresh = await readLibrary(); const currentBook = fresh.books.find((entry) => entry.id === bookId);
    const currentItem = (currentBook?.[listName] || []).find((entry) => entry.id === itemId);
    if (!currentItem) return json(res, 409, { error: "考证期间该条目已被修改，请刷新后重试" });
    currentItem.research = research; currentItem.verification = research.verdict === "supported" ? "资料支持" : research.verdict === "conflicted" ? "资料冲突" : research.verdict === "unavailable" ? "搜索不可用" : "证据不足";
    await saveLibrary(fresh); return json(res, 200, research);
  }
  const glossaryMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/glossary$/);
  if (req.method === "POST" && glossaryMatch) {
    const body = await readJson(req); if (!String(body.japanese || "").trim() || !String(body.chinese || "").trim()) return json(res, 400, { error: "原文词条和中文译名不能为空" });
    const data = await readLibrary(); const book = data.books.find((item) => item.id === glossaryMatch[1]); if (!book) return json(res, 404, { error: "作品不存在" });
    const category = String(body.category || "术语").trim();
    const term = { id: `term-${Date.now()}`, japanese: String(body.japanese).trim(), reading: String(body.reading || "").trim(), chinese: String(body.chinese).trim(), category, definition: String(body.definition || body.translatorNote || "").trim(), status: "approved", verification: "人工添加" };
    if (category === "人物") { book.characters ||= []; term.identity = term.definition; book.characters.push(term); await saveLibrary(data); await saveCharactersState(book); }
    else { book.glossary ||= []; book.glossary.push(term); await saveLibrary(data); await saveGlossaryState(book); }
    return json(res, 201, term);
  }
  const candidateMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/(term|character)-candidates\/([^/]+)\/(approve|reject)$/);
  if (req.method === "POST" && candidateMatch) {
    const body = await readJson(req); const [, bookId, kind, candidateId, action] = candidateMatch; const data = await readLibrary(); const book = data.books.find((item) => item.id === bookId);
    if (!book) return json(res, 404, { error: "作品不存在" });
    const key = kind === "term" ? "termCandidates" : "characterCandidates"; const index = (book[key] || []).findIndex((item) => item.id === candidateId);
    if (index < 0) return json(res, 404, { error: "建议项不存在" });
    let sourceUrl = "";
    if (action === "approve") {
      try { sourceUrl = checkedSourceUrl(body.sourceUrl); } catch (error) { return json(res, 400, { error: error.message }); }
      if (!String(body.chinese || book[key][index].chinese || "").trim()) return json(res, 400, { error: "中文译名不能为空" });
    }
    const [candidate] = book[key].splice(index, 1);
    if (action === "approve") {
      const verified = verifiedByResearch(candidate, sourceUrl);
      const verification = verified ? "资料支持" : sourceUrl ? "人工提供来源，未由 AI 核实" : "人工批准，未附来源";
      const chinese = String(body.chinese || candidate.chinese).trim();
      const approved = { ...candidate, chinese, status: "approved", firstOccurrence: candidate.chapter, notes: candidate.note, definition: String(body.definition ?? candidate.research?.definition ?? candidate.research?.translatorNote ?? (kind === "character" ? candidate.identity : candidate.note) ?? "").trim(), verification, sourceUrl, verificationNote: String(body.verificationNote || "").trim(), verifiedAt: verified ? new Date().toISOString() : null };
      delete approved.translatorNote;
      if (kind === "term") { book.glossary ||= []; book.glossary.push(approved); await saveGlossaryState(book); }
      else { book.characters ||= []; book.characters.push(approved); await saveCharactersState(book); }
    }
    await saveLibrary(data); return json(res, 200, { ok: true, action, kind });
  }
  const approvedMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/(glossary|characters)\/([^/]+)$/);
  if (req.method === "PATCH" && approvedMatch) {
    const body = await readJson(req); const data = await readLibrary(); const book = data.books.find((entry) => entry.id === approvedMatch[1]);
    const list = approvedMatch[2] === "glossary" ? book?.glossary : book?.characters;
    const item = list?.find((entry) => entry.id === approvedMatch[3]); if (!item) return json(res, 404, { error: "固定译名不存在" });
    const chinese = String(body.chinese ?? item.chinese ?? item.chineseName ?? "").trim(); if (!chinese) return json(res, 400, { error: "中文译名不能为空" });
    let sourceUrl;
    try { sourceUrl = checkedSourceUrl(body.sourceUrl ?? item.sourceUrl); } catch (error) { return json(res, 400, { error: error.message }); }
    item.chinese = chinese; item.sourceUrl = sourceUrl; item.definition = String(body.definition ?? item.definition ?? item.translatorNote ?? "").trim(); item.verificationNote = String(body.verificationNote ?? item.verificationNote ?? "").trim();
    const verified = verifiedByResearch(item, sourceUrl);
    item.verification = verified ? "资料支持" : sourceUrl ? "人工提供来源，未由 AI 核实" : "人工批准，未附来源"; item.verifiedAt = verified ? new Date().toISOString() : null;
    item.updatedAt = new Date().toISOString(); await saveLibrary(data);
    if (approvedMatch[2] === "glossary") await saveGlossaryState(book); else await saveCharactersState(book);
    return json(res, 200, item);
  }
  const uncertaintyMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/uncertainties\/([^/]+)$/);
  if (req.method === "PATCH" && uncertaintyMatch) {
    const body = await readJson(req); const data = await readLibrary(); const book = data.books.find((item) => item.id === uncertaintyMatch[1]); const item = book?.uncertainties?.find((entry) => entry.id === uncertaintyMatch[2]);
    if (!item) return json(res, 404, { error: "疑难项不存在" });
    if (["open", "resolved"].includes(body.status)) item.status = body.status;
    if (body.resolution !== undefined) item.resolution = String(body.resolution).trim();
    if (body.sourceUrl !== undefined) { try { item.sourceUrl = checkedSourceUrl(body.sourceUrl); } catch (error) { return json(res, 400, { error: error.message }); } }
    if (body.verificationNote !== undefined) item.verificationNote = String(body.verificationNote).trim();
    if (body.translatorNote !== undefined) item.translatorNote = String(body.translatorNote).trim();
    if (item.status === "resolved" && !item.resolution) return json(res, 400, { error: "请写明最终判断后再标记为已解决" });
    const verified = verifiedByResearch(item, item.sourceUrl);
    item.verification = verified ? "资料支持" : item.sourceUrl ? "人工提供来源，未由 AI 核实" : "人工判断，未附来源";
    item.verifiedAt = verified ? new Date().toISOString() : null;
    item.updatedAt = new Date().toISOString(); await saveLibrary(data); await saveUncertaintiesState(book); return json(res, 200, item);
  }
  const exportMatch = url.pathname.match(/^\/api\/books\/([^/]+)\/export\/epub$/);
  if (req.method === "POST" && exportMatch) {
    return withBookMutation(exportMatch[1], async () => {
    const body = await readJson(req); const data = await readLibrary(); const book = data.books.find((item) => item.id === exportMatch[1]);
    if (!book) return json(res, 404, { error: "作品不存在" });
    const hydrated = [];
    if (body.selectionOnly) {
      for (const chapter of book.chapters) for (const segment of chapter.segments || []) if (segment.status === "approved") {
        let translation = ""; try { translation = await readFile(join(bookRoot(book), segment.translationPath), "utf8"); } catch { /* skipped by exporter */ }
        hydrated.push({ ...segment, id: segment.id, title: `${chapter.title} · ${segment.label}`, translation, status: "approved" });
      }
    } else for (const chapter of book.chapters) if (!body.chapterIds?.length || body.chapterIds.includes(chapter.id)) hydrated.push({ ...chapter, source: await readChapterText(bookRoot(book), chapter, "source"), translation: await readChapterText(bookRoot(book), chapter, chapter.polishedPath ? "polished" : "translation") });
    const selectionSuffix = body.selectionOnly ? "selections" : body.chapterIds?.length ? "selected" : (body.includeDraft ? "draft" : "approved");
    const filename = hydrated.length === 1 ? `${safeName(hydrated[0].title)}${body.includeDraft ? "-草稿" : ""}.epub` : `${safeName(book.title)}-${selectionSuffix}.epub`; const outputPath = join(EXPORTS, filename);
    const result = await createEpub({ book, chapters: hydrated, outputPath, includeDraft: Boolean(body.includeDraft) });
    const included = new Set(result.chapterIds);
    if (!body.selectionOnly) for (const chapter of book.chapters) if (included.has(chapter.id)) chapter.exportedAt = new Date().toISOString();
    data.exports.unshift({ id: `export-${Date.now()}`, bookId: book.id, bookTitle: book.title, filename, chapterCount: result.chapterCount, createdAt: new Date().toISOString(), includesDraft: Boolean(body.includeDraft) }); await saveLibrary(data);
    return json(res, 200, { ...result, downloadUrl: `/api/exports/${encodeURIComponent(filename)}` });
    });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/exports/")) {
    const filename = safeName(decodeURIComponent(url.pathname.slice("/api/exports/".length))); const path = join(EXPORTS, filename);
    if (!existsSync(path)) return json(res, 404, { error: "导出文件不存在" });
    const info = await stat(path); res.writeHead(200, { "content-type": "application/epub+zip", "content-length": info.size, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` }); return createReadStream(path).pipe(res);
  }
  return json(res, 404, { error: "API 不存在" });
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host;
  if (!new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]).has(host) || (req.headers.origin && req.headers.origin !== `http://${host}`)) return json(res, 403, { error: "仅接受本机页面请求" });
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const path = normalize(join(PUBLIC, requested));
    if (!path.startsWith(PUBLIC) || !existsSync(path)) { res.writeHead(404); return res.end("Not found"); }
    const info = await stat(path); if (!info.isFile()) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "content-type": mime[extname(path)] || "application/octet-stream" }); createReadStream(path).pipe(res);
  } catch (error) { console.error(error); json(res, 500, { error: error.message || "服务器错误" }); }
});

server.listen(PORT, "127.0.0.1", () => console.log(`翻译书库已启动：http://127.0.0.1:${PORT}`));
