function plainExcerpt(value) {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 700);
}

function normalized(value) {
  return plainExcerpt(value).normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function matchesWholeTerm(query, entry) {
  const needle = normalized(query);
  return Boolean(needle && normalized(`${entry.title} ${entry.description || ""} ${entry.excerpt || ""}`).includes(needle));
}

export class ResearchSearchError extends Error {
  constructor(reason, message) { super(message); this.name = "ResearchSearchError"; this.code = reason; }
}

export async function searchResearchSources({ query, context = "", apiKey, budget, fetchImpl = fetch }) {
  const term = String(query || "").trim();
  if (!term || term.length > 60) throw new ResearchSearchError("SEARCH_QUERY", "请提供不超过 60 字的原文词条");
  if (!apiKey) throw new ResearchSearchError("SEARCH_KEY_MISSING", "尚未配置独立的搜索 API Key；初译不受影响");
  const suffix = String(context || "").trim().slice(0, 35);
  const searchText = `${term} ${suffix}`.trim();
  return budget.run(searchText, async () => {
    const endpoint = new URL("https://api.search.brave.com/res/v1/web/search");
    endpoint.searchParams.set("q", searchText);
    endpoint.searchParams.set("count", "5");
    let response;
    try { response = await fetchImpl(endpoint, { headers: { "X-Subscription-Token": apiKey, accept: "application/json" }, signal: AbortSignal.timeout(8000) }); }
    catch (error) { throw new ResearchSearchError("SEARCH_NETWORK", `搜索服务无法连接：${error.message || "网络错误"}`); }
    if (response.status === 401 || response.status === 403) throw new ResearchSearchError("SEARCH_AUTH", "搜索 API Key 无效或无权限");
    if (response.status === 429) throw new ResearchSearchError("SEARCH_PROVIDER_LIMIT", "搜索服务商额度或速率限制已触发");
    if (!response.ok) throw new ResearchSearchError("SEARCH_SERVICE", `搜索服务 HTTP ${response.status}`);
    const body = await response.json();
    return (body.web?.results || []).slice(0, 5).map((entry) => ({
      title: plainExcerpt(entry.title), url: String(entry.url || ""), description: plainExcerpt(entry.description), excerpt: plainExcerpt(entry.description), source: "Brave Web Search"
    })).filter((entry) => {
      try { const parsed = new URL(entry.url); return ["http:", "https:"].includes(parsed.protocol) && matchesWholeTerm(term, entry); }
      catch { return false; }
    });
  });
}

export async function verifyIssue({ book, item, kind, apiKey, budget, provider, requestsPerItem = 2, search = searchResearchSources, readPage = readPublicSource, analyze = researchTranslationIssue }) {
  const originalTerm = String(kind === "uncertainty" ? item.text : item.japanese || item.japaneseName || "").trim();
  const unavailable = (reason, code) => ({ verdict: "unavailable", reason, code, sourceUrls: [], sources: [], searchedAt: new Date().toISOString() });
  if (!apiKey) return unavailable("尚未填写独立的搜索 API Key；初译与已有注释不受影响", "SEARCH_KEY_MISSING");
  if (!originalTerm) return { verdict: "insufficient", reason: "没有可检索的原文词条", sourceUrls: [], sources: [], searchedAt: new Date().toISOString() };
  const context = String(item.disambiguator || "").trim().slice(0, 35);
  const queries = context ? [context, ""] : [""];
  const failures = [];
  let pageFailures = 0; let readablePages = 0;
  for (const extra of queries.slice(0, Math.max(0, Math.min(2, requestsPerItem)))) {
    let found;
    try { found = await search({ query: originalTerm, context: extra, apiKey, budget }); }
    catch (error) { failures.push(error.message); if (error.code === "SEARCH_DAILY_LIMIT" || error.code === "SEARCH_AUTH" || error.code === "SEARCH_PROVIDER_LIMIT") break; else continue; }
    const opened = await Promise.allSettled(found.slice(0, 3).map((entry) => readPage(entry.url, { term: originalTerm })));
    pageFailures += opened.filter((result) => result.status === "rejected").length;
    readablePages += opened.filter((result) => result.status === "fulfilled").length;
    const evidence = opened.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])
      .filter((page) => String(page.excerpt || "").includes(originalTerm) && (!context || String(page.excerpt).includes(context)));
    if (!evidence.length) continue;
    try {
      const result = await analyze({ provider, book, item, kind, evidence });
      return { ...result, sources: evidence.filter((entry) => result.sourceUrls.includes(entry.url)) };
    } catch (error) { return unavailable(`资料已读取，但翻译模型分析失败：${error.message}`, "MODEL_FAILURE"); }
  }
  if (failures.length) return unavailable(failures.join("；"), "SEARCH_FAILURE");
  if (pageFailures && !readablePages) return unavailable("搜索已有线索，但公开网页无法读取；稍后可重试", "PAGE_UNAVAILABLE");
  return { verdict: "insufficient", reason: "没有找到同时匹配原文词条与消歧信息的可读公开网页", sourceUrls: [], sources: [], searchedAt: new Date().toISOString() };
}
import { researchTranslationIssue } from "./engine.mjs";
import { readPublicSource } from "./source-reader.mjs";
