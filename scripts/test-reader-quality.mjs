import assert from "node:assert/strict";
import { summarizeLibraryQuality, searchStatus } from "../public/reader-quality.js";

const summary = summarizeLibraryQuality([{ chapters: [
  { quality: { autoChecks: [{ verdict: "supported", autoRevised: true }, { verdict: "unavailable" }] } },
  { quality: { autoChecks: [{ verdict: "insufficient" }] } }
] }]);
assert.deepEqual(summary, { checked: 3, revised: 1, unresolved: 2 });
assert.match(searchStatus({ hasApiKey: false, remaining: 30 }), /未配置/);
assert.match(searchStatus({ hasApiKey: true, remaining: 0 }), /已用完/);
assert.match(searchStatus({ hasApiKey: true, remaining: 12 }), /12/);
console.log("Reader quality summary and search status checks passed");
