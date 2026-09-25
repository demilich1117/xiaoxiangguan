import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { openCodeUrl, OpenCodeServer, probeOpenCodeServer, discoverOpenCodeServerModels, stopOpenCodeSessions } from "../lib/opencode-server.mjs";
import { generate } from "../lib/providers.mjs";
import { translateChapter } from "../lib/engine.mjs";

const folder = await mkdtemp(join(tmpdir(), "xxg-opencode-server-"));
const password = "local-test-password", authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
const calls = [], sessions = new Map();
let mode = "normal", version = "1.18.30", directoryMismatch = false, arrived, child;
const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost"), path = url.pathname;
  let text = ""; for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : undefined;
  calls.push({ method: req.method, path, body, directory: url.searchParams.get("directory"), authorization: req.headers.authorization });
  const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (req.headers.authorization !== authorization) return json({ private: password }, 401);
  if (path === "/global/health") return json({ healthy: true, version });
  assert.equal(url.searchParams.get("directory"), folder);
  if (path === "/path") return json({ directory: directoryMismatch ? join(folder, "wrong") : folder });
  if (path === "/provider") return json({ connected: ["local"], all: [{ id: "other", models: { hidden: {} }, key: "never-return" }, { id: "local", models: { "test/model": { name: "Test", variants: { high: {}, disabled: { disabled: true } } } } }] });
  if (path === "/session" && req.method === "POST") {
    const id = `ses_test${sessions.size + 1}`, session = { id, permission: mode === "permissions" ? [] : body.permission, mode, title: body.title };
    sessions.set(id, session);
    if (mode === "cancel-create") { arrived?.(); await new Promise((r) => setTimeout(r, 40)); }
    return json(session);
  }
  if (path === "/session/status") return json(Object.fromEntries([...sessions].map(([id, s]) => [id, { type: s.aborted || s.mode !== "pending" ? "idle" : "busy" }])));
  const match = path.match(/^\/session\/(ses_test\d+)\/(prompt_async|message|abort)$/);
  if (!match) return json({}, 404);
  const session = sessions.get(match[1]);
  if (match[2] === "abort") { session.aborted = true; return json(session.mode === "abort-fail" ? false : true); }
  if (match[2] === "prompt_async") { session.body = body; arrived?.(); res.writeHead(204); return res.end(); }
  const message = session.body, user = { info: { id: message.messageID, role: "user", sessionID: session.id }, parts: [] };
  if (["pending", "abort-fail"].includes(session.mode)) return json([user]);
  const paragraphs = message.parts[0].text.match(/原文段落：\n(\[[^\n]+\])/);
  const output = paragraphs ? JSON.stringify({ segments: JSON.parse(paragraphs[1]).map((p) => ({ sourceParagraphIds: [p.id], text: "译文。" })) }) : "连接成功";
  const assistant = { info: { id: "msg_assistant", role: "assistant", parentID: session.mode === "interference" ? "msg_other" : message.messageID, sessionID: session.id, time: { completed: 1 }, finish: session.mode === "truncated" ? "length" : "stop", tokens: { input: 4, output: 5 }, ...(session.mode === "error" ? { error: { message: password } } : {}) }, parts: [{ type: "text", sessionID: session.id, messageID: session.mode === "wrong-part" ? "msg_alien" : "msg_assistant", text: output }] };
  json([user, assistant]);
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const provider = { backend: "opencode", opencodeMode: "server", opencodeServerUrl: `http://127.0.0.1:${mock.address().port}`, opencodeDirectory: folder, opencodeUsername: "opencode", opencodePassword: password, model: "local/test/model", reasoningEffort: "high" };
const run = (extra = {}) => generate({ provider, messages: [{ role: "user", content: "test" }], ...extra });
try {
  for (const url of ["http://example.com:4096", "http://u:p@127.0.0.1:4096", "file:///test", "http://127.0.0.1:4096/path", "http://127.0.0.1:4096?a=b", "http://127.0.0.1"]) assert.throws(() => openCodeUrl(url), /本机 HTTP/);
  assert.equal(openCodeUrl("http://[::1]:4096/"), "http://[::1]:4096");
  assert.equal((await probeOpenCodeServer(provider)).runnable, true);
  version = "2.0.0"; await assert.rejects(run(), /1.x/); version = "1.18.30";
  directoryMismatch = true; await assert.rejects(run(), /目录不匹配/); directoryMismatch = false;
  await assert.rejects(new OpenCodeServer({ ...provider, opencodePassword: "wrong" }).check(), /认证失败/);
  const catalog = await discoverOpenCodeServerModels(provider);
  assert.deepEqual(catalog.models, [{ id: "local/test/model", name: "Test · local", reasoningEfforts: ["high"] }]);
  assert.equal(JSON.stringify(catalog).includes("never-return"), false);
  const normal = await run({ sessionTitle: "瀟湘館 · 测试 · 第 1 章" });
  assert.equal(normal.text, "连接成功"); assert.deepEqual(normal.usage, { inputTokens: 4, outputTokens: 5 });
  const first = sessions.get(normal.runId); assert.equal(first.title, "瀟湘館 · 测试 · 第 1 章");
  assert.deepEqual(first.body.model, { providerID: "local", modelID: "test/model" }); assert.equal(first.body.variant, "high");
  for (const [scenario, message] of [["permissions", /工具禁用/], ["interference", /其他输入/], ["wrong-part", /消息内容/], ["error", /调用失败/], ["truncated", /未完整结束/]]) { mode = scenario; await assert.rejects(run(), message); }
  assert.equal([...sessions.values()].find((s) => s.mode === "permissions").body, undefined);
  for (const scenario of ["pending", "cancel-create"]) {
    mode = scenario; const controller = new AbortController(); arrived = () => controller.abort(new Error("cancelled by test"));
    await assert.rejects(run({ signal: controller.signal }), /cancelled by test/);
    const last = [...sessions.values()].at(-1); assert.equal(last.aborted, true); if (scenario === "cancel-create") assert.equal(last.body, undefined);
  }
  arrived = null; mode = "pending"; await assert.rejects(run({ provider: { ...provider, timeoutMs: 100 } }), /生成超时/);
  assert.equal([...sessions.values()].at(-1).aborted, true);
  mode = "abort-fail"; await assert.rejects(run({ provider: { ...provider, timeoutMs: 100 } }), /未确认停止/);
  mode = "normal";
  const blocks = [];
  await translateChapter({ provider, book: { title: "Test Book", sourceLanguage: "en" }, chapter: { id: "chapter", title: "Test Chapter" }, source: "One.\n\nTwo.", onBlock: (block) => blocks.push(block) });
  assert.ok(blocks.some((b) => b.status === "running" && b.runId)); assert.ok(blocks.at(-1).runId);
  assert.ok([...sessions.values()].some((s) => s.title === "瀟湘館 · Test Book · Test Chapter · 初译 1/1"));
  // HTTP redirects must not receive Basic auth or be followed.
  const redirect = http.createServer((req, res) => { res.writeHead(302, { location: provider.opencodeServerUrl + "/global/health" }); res.end(); });
  await new Promise((r) => redirect.listen(0, "127.0.0.1", r));
  try { await assert.rejects(new OpenCodeServer({ ...provider, opencodeServerUrl: `http://127.0.0.1:${redirect.address().port}` }).check(), /HTTP 302/); } finally { await new Promise((r) => redirect.close(r)); }

  // Exercise saved credentials and the real workbench API in an isolated library.
  const storage = join(folder, "workbench"); await mkdir(join(storage, "secrets"), { recursive: true });
  await writeFile(join(storage, "secrets/provider.json"), JSON.stringify({ ...provider, providerName: "Test", protocol: "openai-chat", baseUrl: "http://127.0.0.1:1/v1" }));
  child = spawn(process.execPath, ["server.mjs"], { cwd: new URL("../", import.meta.url), env: { ...process.env, PORT: "0", TRANSLATION_LIBRARY_DATA_DIR: storage }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit"); let timer;
  const base = await new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error("workbench startup timeout")), 15000); child.stdout.on("data", (data) => { const url = String(data).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (url) resolve(url); }); child.once("exit", () => reject(new Error("workbench exited early"))); }).finally(() => clearTimeout(timer));
  const api = async (path, body, method = "POST") => { const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const data = await res.json(); assert.equal(res.ok, true, JSON.stringify(data)); return data; };
  const publicSettings = await api("/api/provider", undefined, "GET"); assert.equal(publicSettings.hasOpenCodePassword, true); assert.equal(JSON.stringify(publicSettings).includes(password), false);
  assert.equal((await api("/api/provider/probe", { backend: "opencode", opencodeMode: "server" })).runnable, true);
  assert.equal((await api("/api/provider/models", { backend: "opencode", opencodeMode: "server" })).models.length, 1);
  const saved = await api("/api/provider", { ...publicSettings, opencodePassword: "" }, "PUT"); assert.equal(saved.hasOpenCodePassword, true); assert.equal(JSON.stringify(saved).includes(password), false);
  assert.equal((await api("/api/provider/test", { ...publicSettings, save: false })).ok, true);
  const changed = await api("/api/provider", { ...publicSettings, reasoningEffort: "", opencodeServerUrl: "http://127.0.0.1:4097" }, "PUT"); assert.equal(changed.hasOpenCodePassword, false);
  const stored = JSON.parse(await readFile(join(storage, "secrets/provider.json"), "utf8")); assert.equal(stored.opencodePassword, undefined); assert.equal(stored.opencodePasswordProtected, undefined);
  await api("/api/provider", provider, "PUT");
  mode = "pending";
  const accepted = new Promise((resolve) => { arrived = resolve; });
  const pendingTest = fetch(base + "/api/provider/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ backend: "opencode", opencodeMode: "server" }) }).then((r) => r.json()).catch(() => null);
  await accepted; const runningId = [...sessions.keys()].at(-1);
  sessions.set("ses_unrelated", { mode: "pending" });
  await api("/api/shutdown", { confirm: true }); await exited; await pendingTest;
  assert.equal(sessions.get(runningId).aborted, true); assert.equal(sessions.get("ses_unrelated").aborted, undefined);
  assert.equal((await probeOpenCodeServer(provider)).runnable, true);
  assert.ok(calls.every((c) => c.method !== "DELETE" && !c.path.includes("dispose")));
  await stopOpenCodeSessions(); await assert.rejects(run(), /不能创建新的/);
  console.log("OpenCode local server: scoped persistent sessions, auth redaction, connected models/variants, completion validation, interference, cancellation/timeout and shared-server survival passed");
} finally {
  if (child && child.exitCode === null) { const ended = once(child, "exit"); child.kill(); await ended; }
  mock.closeAllConnections(); await new Promise((r) => mock.close(r));
  await rm(folder, { recursive: true, force: true });
}
