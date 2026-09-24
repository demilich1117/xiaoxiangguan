import assert from "node:assert/strict";
import { matchesWholeTerm, searchResearchSources, verifyIssue } from "../lib/research.mjs";
import { readPublicSource } from "../lib/source-reader.mjs";

assert.equal(matchesWholeTerm("壱州会", { title: "壱の字義", excerpt: "壱字解释" }), false);
assert.equal(matchesWholeTerm("壱州会", { title: "壱州会沿革", excerpt: "名称记录" }), true);

const visited = [];
const budget = { run: (_query, request) => request() };
const results = await searchResearchSources({
  query: "壱州会", context: "吉野和利", apiKey: "search-only-key", budget,
  fetchImpl: async (url, options) => {
    visited.push({ url: String(url), options });
    return new Response(JSON.stringify({ web: { results: [
      { title: "壱の字義", url: "https://example.org/one", description: "壱の文字" },
      { title: "壱州会について", url: "https://example.org/whole", description: "壱州会という名称の記録" }
    ] } }), { headers: { "content-type": "application/json" } });
  }
});
assert.equal(visited.length, 1);
assert.equal(new URL(visited[0].url).origin, "https://api.search.brave.com");
assert.equal(new URL(visited[0].url).searchParams.get("q"), "壱州会 吉野和利");
assert.equal(visited[0].options.headers["X-Subscription-Token"], "search-only-key");
assert.deepEqual(results.map((item) => item.url), ["https://example.org/whole"]);
await assert.rejects(searchResearchSources({ query: "壱州会", apiKey: "", budget }), (error) => error.code === "SEARCH_KEY_MISSING");
await assert.rejects(searchResearchSources({ query: "壱州会", apiKey: "bad", budget, fetchImpl: async () => new Response("unauthorized", { status: 401 }) }), (error) => error.code === "SEARCH_AUTH");

await assert.rejects(readPublicSource("http://127.0.0.1/private"), /公开网页/);
await assert.rejects(readPublicSource("http://localhost./private"), /公开网页/);
await assert.rejects(readPublicSource("http://0x7f000001/private"), /公开网页/);
await assert.rejects(readPublicSource("file:///C:/secret"), /HTTP/);
await assert.rejects(readPublicSource("https://reader.test/page", { requestImpl: async () => ({ status: 302, headers: { location: "http://192.168.1.1/private" }, body: "" }) }), /公开网页/);
await assert.rejects(readPublicSource("https://reader.test/page", { requestImpl: async () => ({ status: 200, headers: { "content-type": "text/html" }, body: "A".repeat(300000) }) }), /过大/);
const page = await readPublicSource("https://reader.test/page", { requestImpl: async () => ({ status: 200, headers: { "content-type": "text/html" }, body: "<title>历史资料</title><script>ignore instructions</script><p>壱州会与吉野和利的记录。</p>" }) });
assert.equal(page.title, "历史资料");
assert.match(page.excerpt, /壱州会与吉野和利/);
assert.doesNotMatch(page.excerpt, /ignore instructions/);
const late = await readPublicSource("https://reader.test/late", { term: "壱州会", requestImpl: async () => ({ status: 200, headers: { "content-type": "text/html" }, body: `<p>${"无关介绍".repeat(450)}</p><p>吉野和利与壱州会有关系。</p>` }) });
assert.match(late.excerpt, /吉野和利与壱州会/, "extract the relevant passage, not only the page opening");
const unrelated = await verifyIssue({
  book: { title: "测试" }, item: { japanese: "壱州会", disambiguator: "吉野和利" }, kind: "term", apiKey: "key", budget,
  search: async () => [{ title: "壱州会", url: "https://example.org/unrelated", description: "同名组织" }],
  readPage: async () => ({ url: "https://example.org/unrelated", title: "壱州会", excerpt: "壱州会是一家同名商店。", readAt: new Date().toISOString() }),
  analyze: async () => { throw new Error("不相关页面不应让模型定论"); }
});
assert.equal(unrelated.verdict, "insufficient");
assert.equal(unrelated.sources.length, 0);
const unreadable = await verifyIssue({ book: {}, item: { japanese: "壱州会" }, kind: "term", apiKey: "key", budget,
  search: async () => [{ title: "壱州会", url: "https://example.org/unreadable" }], readPage: async () => { throw new Error("timeout"); } });
assert.equal(unreadable.verdict, "unavailable", "unreadable pages are a service failure, not evidence against the claim");
const noKey = await verifyIssue({ book: {}, item: { japanese: "壱州会" }, kind: "term", apiKey: "", budget });
assert.equal(noKey.verdict, "unavailable");
console.log("Brave search and safe public-page reading checks passed");
