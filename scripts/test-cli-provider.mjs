import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliEventParser, cliInvocation, runCliProcess } from "../lib/cli-provider.mjs";
import { assertFinished } from "../lib/providers.mjs";
import { discoverCodexModels, parseOpenCodeModels, parseAntigravityModels, validateCliChoice } from "../lib/cli-models.mjs";

const events = {
  codex: [{ type: "thread.started", thread_id: "codex-1" }, { type: "item.completed", item: { type: "agent_message", text: "译文正文" } }, { type: "turn.completed", usage: { input_tokens: 8, output_tokens: 4 } }],
  opencode: [{ type: "text", sessionID: "oc-1", part: { text: "译文正文" } }, { type: "step_finish", part: { reason: "stop", tokens: { input: 8, output: 4 } } }],
  antigravity: [{ event: "result", result: { conversation_id: "agy-1", status: "SUCCESS", response: "译文正文", usage: { input_tokens: 8, output_tokens: 4 } } }]
};
for (const [backend, stream] of Object.entries(events)) {
  const parser = cliEventParser(backend); stream.forEach((event) => parser.push(event));
  const result = assertFinished(parser.result()); assert.equal(result.text, "译文正文"); assert.equal(result.usage.inputTokens, 8); assert.ok(result.runId);
  const invocation = cliInvocation(backend, { model: "mock", reasoningEffort: "high", folder: "C:/temp/safe", schemaPath: "C:/temp/schema.json", prompt: '书籍正文 $(malicious) `shell` "quote"', runId: "request-1", timeoutMs: 1000 });
  assert.ok(invocation.input.includes("书籍正文")); assert.equal(invocation.args.some((arg) => arg.includes("书籍正文")), false); assert.equal(invocation.args.some((arg) => /dangerously|full-access/.test(arg)), false);
  assert.ok(invocation.args.includes(backend === "codex" ? 'model_reasoning_effort="high"' : "high"));
}
const catalog = { models: parseOpenCodeModels('vendor/model\n{\n"name":"Example",\n"variants":{"low":{},"high":{"disabled":true},"custom-deep":{}}\n}\nvendor/unknown\n') };
assert.deepEqual(catalog.models[0].reasoningEfforts, ["low", "custom-deep"]);
assert.equal(catalog.models[1].reasoningEfforts, undefined);
validateCliChoice({ backend: "opencode", model: "vendor/model", reasoningEffort: "custom-deep" }, catalog);
assert.throws(() => validateCliChoice({ backend: "opencode", model: "vendor/model", reasoningEffort: "high" }, catalog), /未提供/);
assert.throws(() => validateCliChoice({ backend: "codex", model: "--bad" }), /模型 ID/);
assert.throws(() => validateCliChoice({ backend: "antigravity", model: "gemini", reasoningEffort: "ultra" }, catalog), /强度无效/);
assert.deepEqual(parseAntigravityModels('MODEL NAME\ngemini-test Gemini Test\n')[0].reasoningEfforts, ["low", "medium", "high"]);
for (const [backend, event] of [["codex", { type: "turn.failed" }], ["opencode", { type: "step_finish", part: { reason: "length" } }], ["antigravity", { event: "result", result: { status: "WAITING", response: "半句" } }]]) {
  const parser = cliEventParser(backend); parser.push(event); assert.throws(() => assertFinished(parser.result()), /未完整结束/);
}
const empty = cliEventParser("codex"); empty.push({ type: "item.completed", item: { type: "agent_message", text: "partial" } }); assert.throws(() => assertFinished(empty.result()), /未完整结束/);
const failed = cliEventParser("codex"); failed.push({ type: "error" }); events.codex.forEach((e) => failed.push(e)); assert.throws(() => assertFinished(failed.result()), /未完整结束/);
for (const [backend, stream] of Object.entries(events)) {
  const parser = cliEventParser(backend); stream.forEach((event) => parser.push(event));
  const alien = backend === "codex" ? { type: "thread.started", thread_id: "other-run" } : backend === "opencode" ? { type: "text", sessionID: "other-run" } : { event: "result", result: { conversation_id: "other-run" } };
  assert.throws(() => parser.push(alien), /其他会话/);
}
const folder = await mkdtemp(join(tmpdir(), "xxg-cli-test-"));
try {
  const fixture = join(folder, "fixture.mjs");
  await writeFile(fixture, `let input = ''; for await (const chunk of process.stdin) input += chunk; process.stderr.write('诊断不应进入正文'); const text = Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: input } }) + '\\n'); process.stdout.write(text.subarray(0, 70)); setTimeout(() => { process.stdout.write(text.subarray(70)); process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n'); }, 10);`);
  const parser = cliEventParser("codex"); await runCliProcess({ executable: process.execPath, args: [fixture], cwd: folder, input: "多字节中文正文", onLine: (line) => parser.push(JSON.parse(line)) });
  assert.equal(assertFinished(parser.result()).text, "多字节中文正文"); assert.equal(parser.result().usage.inputTokens, null);
  const controller = new AbortController();
  const pending = runCliProcess({ executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: folder, signal: controller.signal }); setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, /abort/i);
  await assert.rejects(runCliProcess({ executable: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: folder, timeoutMs: 100 }), /超时/);
  await assert.rejects(runCliProcess({ executable: process.execPath, args: ["-e", "process.stderr.write('login required');process.exit(3)"], cwd: folder }), /CLI 登录/);
  const rpcFixture = join(folder, "rpc.mjs");
  await writeFile(rpcFixture, `import readline from 'node:readline'; for await (const line of readline.createInterface({input:process.stdin})) { const m=JSON.parse(line); if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}})); else if(m.method==='model/list') console.log(JSON.stringify({id:m.id,result:{data:[{model:m.params.cursor?'model-b':'model-a',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],secret:'not-returned'}],nextCursor:m.params.cursor?null:'page2'}})); else if(m.method!=='initialized') process.exit(4); }`);
  const models = await discoverCodexModels("fixture", folder, (options) => runCliProcess({ ...options, executable: process.execPath, args: [rpcFixture] }), 2000);
  assert.deepEqual(models.map((m) => m.id), ["model-a", "model-b"]); assert.equal(JSON.stringify(models).includes("not-returned"), false);
  assert.deepEqual(models[0].reasoningEfforts, ["low", "high"]);
  console.log("CLI contracts: final events, failure/truncation, stdin, UTF-8, stderr isolation, cancellation and timeout passed");
} finally { await rm(folder, { recursive: true, force: true }); }
