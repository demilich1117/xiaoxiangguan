import { readFile, rename, unlink, writeFile } from "node:fs/promises";

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function writeJson(path, value) {
  const temp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try { await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(temp, path); }
  catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

function dayKey(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function createSearchBudget({ file, cacheFile, dailyLimit = 30, now = () => new Date() }) {
  let queue = Promise.resolve();
  const currentLimit = () => Math.max(0, Math.min(30, Math.floor(Number(typeof dailyLimit === "function" ? dailyLimit() : dailyLimit))));
  const usage = async () => {
    await queue;
    const stored = await readJson(file, {});
    const day = dayKey(now());
    const used = stored.day === day ? stored.used || 0 : 0;
    const limit = currentLimit();
    return { day, used, limit, remaining: Math.max(0, limit - used) };
  };
  const run = (query, request) => {
    const operation = queue.then(async () => {
      const normalizedQuery = String(query || "").trim().replace(/\s+/g, " ");
      if (!normalizedQuery || normalizedQuery.length > 100) throw new Error("搜索词须为不超过 100 字的短词条");
      const key = `brave-web-v1:${normalizedQuery}`;
      const cache = await readJson(cacheFile, {});
      const cached = cache[key];
      const ttl = Array.isArray(cached?.value) && !cached.value.length ? 3600_000 : 30 * 86400_000;
      if (cached && now().getTime() - Date.parse(cached.savedAt) < ttl) return cached.value;
      const day = dayKey(now());
      const stored = await readJson(file, {});
      const used = stored.day === day ? stored.used || 0 : 0;
      if (used >= currentLimit()) {
        const error = new Error("今天的联网搜索额度已用完；初译和已有译者注仍可正常阅读");
        error.code = "SEARCH_DAILY_LIMIT";
        throw error;
      }
      await writeJson(file, { day, used: used + 1 });
      const value = await request();
      cache[key] = { savedAt: now().toISOString(), value };
      await writeJson(cacheFile, cache);
      return value;
    });
    queue = operation.catch(() => {});
    return operation;
  };
  return { run, usage };
}
