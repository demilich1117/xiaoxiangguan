import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSearchBudget } from "../lib/search-budget.mjs";

const root = await mkdtemp(join(tmpdir(), "reader-search-budget-"));
try {
  const file = join(root, "usage.json");
  const cacheFile = join(root, "cache.json");
  const now = () => new Date("2026-09-24T02:00:00Z");
  const budget = createSearchBudget({ file, cacheFile, dailyLimit: 3, now });
  assert.deepEqual(await budget.run("壱州会 吉野和利", async () => [{ title: "资料" }]), [{ title: "资料" }]);
  assert.deepEqual(await budget.run("壱州会 吉野和利", async () => { throw new Error("缓存未命中"); }), [{ title: "资料" }]);
  assert.equal((await budget.usage()).used, 1, "cache hits must not spend search quota");
  await Promise.all(["甲", "乙"].map((query) => budget.run(query, async () => [])));
  await assert.rejects(budget.run("丙", async () => []), (error) => error.code === "SEARCH_DAILY_LIMIT");
  assert.equal((await createSearchBudget({ file, cacheFile, dailyLimit: 3, now }).usage()).used, 3, "usage survives a process restart");
  const failing = createSearchBudget({ file: join(root, "failed-usage.json"), cacheFile: join(root, "failed-cache.json"), dailyLimit: 1, now });
  await assert.rejects(failing.run("故障", async () => { throw new Error("network down"); }), /network down/);
  assert.equal((await failing.usage()).used, 1, "a dispatched request costs quota even if it fails");
  await assert.rejects(failing.run("新查询", async () => []), (error) => error.code === "SEARCH_DAILY_LIMIT");
  let time = new Date("2026-09-24T02:00:00Z");
  const shortCache = createSearchBudget({ file: join(root, "short-usage.json"), cacheFile: join(root, "short-cache.json"), dailyLimit: 3, now: () => time });
  await shortCache.run("冷门专名", async () => []);
  time = new Date("2026-09-24T04:00:00Z");
  await shortCache.run("冷门专名", async () => []);
  assert.equal((await shortCache.usage()).used, 2, "an empty result must not be cached for a month");
  console.log("Search budget persistence, concurrency, cache and failure accounting checks passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
