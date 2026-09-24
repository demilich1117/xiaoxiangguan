import assert from "node:assert/strict";
import { readerMode } from "../public/reader-mode.js";

assert.equal(readerMode({ hasTranslation: true, editing: false }), "read");
assert.equal(readerMode({ hasTranslation: true, editing: true }), "edit");
assert.equal(readerMode({ hasTranslation: false, editing: false }), "empty");
console.log("Reader mode checks passed");
