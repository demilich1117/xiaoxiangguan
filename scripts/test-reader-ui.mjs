import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readerSourceParagraphs, paragraphRevealDelta } from "../public/reader.js";

const viewport = { top: 100, bottom: 700 };
assert.equal(paragraphRevealDelta({ top: 240, bottom: 400 }, viewport), 0, "visible counterparts stay put");
assert.equal(paragraphRevealDelta({ top: 50, bottom: 220 }, viewport), 0, "partly visible text keeps its context");
assert.equal(paragraphRevealDelta({ top: 600, bottom: 850 }, viewport), 0, "partly visible paragraph below does not jump");
assert.equal(paragraphRevealDelta({ top: 800, bottom: 960 }, viewport), 276, "off-screen paragraph below moves only enough to reveal it with a small margin");
assert.equal(paragraphRevealDelta({ top: -100, bottom: 80 }, viewport), -216, "off-screen paragraph above gets a small top margin");
assert.equal(paragraphRevealDelta({ top: 50, bottom: 1500 }, viewport), 0, "long paragraph already in view stays put");
assert.equal(paragraphRevealDelta({ top: 800, bottom: 1900 }, viewport), 684, "long off-screen paragraph reveals its beginning");
assert.equal(paragraphRevealDelta({ top: 200, bottom: 300 }, { top: 0, bottom: 0 }), 0, "hidden pane is not scrolled");

const legacySource = "已经提取的第一段。\r\n\r\n已经提取的第二段。";
assert.deepEqual(readerSourceParagraphs({ source: legacySource, paragraphCount: 2 }), [{ text: "已经提取的第一段。" }, { text: "已经提取的第二段。" }], "old server responses retain readable source without fabricated alignment IDs");
assert.equal(readerSourceParagraphs({ source: legacySource, sourceParagraphs: [] }).length, 2, "empty metadata cannot hide existing original text");
assert.deepEqual(readerSourceParagraphs({ source: "", sourceParagraphs: [] }), []);
const mappedSource = [{ id: "stable-paragraph", text: "原文" }];
assert.equal(readerSourceParagraphs({ source: "原文", sourceParagraphs: mappedSource }), mappedSource, "new source IDs remain unchanged");

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8") + await readFile(new URL("../public/reader.js", import.meta.url), "utf8");
const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const themeCss = await readFile(new URL("../public/themes.css", import.meta.url), "utf8");
const css = themeCss + await readFile(new URL("../public/styles.css", import.meta.url), "utf8") + await readFile(new URL("../public/reader.css", import.meta.url), "utf8");

assert.match(page, /rel="icon"[^>]*butterfly-peony-logo\.svg/, "the supplied logo is the favicon");
assert.match(page, /class="brand-logo"/, "the brand rail shows the supplied logo");
assert.match(css, /--blue:\s*#0D3B78/i, "the museum-inspired blue is a design token");
assert.match(css, /prefers-reduced-motion/, "reduced motion is respected");
assert.match(app, /继续阅读/, "library prioritizes a continuation action");
assert.match(app, /book-index/, "the books are presented as an index");
assert.match(app, /chapter-catalog/, "the chapter catalog has its own region");
assert.match(css, /overflow-wrap:\s*anywhere/, "long titles wrap safely");
assert.match(app, /正在运行/, "active tasks are named plainly");
assert.match(app, /导出可阅读版/, "readable export remains primary");
assert.match(app, /翻译 API/, "translation settings are distinct");
assert.match(app, /联网搜索/, "search settings are distinct");
assert.match(app, /settings-advanced/, "technical settings are progressively disclosed");
assert.match(css, /@media\s*\(max-width:\s*1024px\)/, "the medium viewport has an explicit layout");
assert.match(css, /@media\s*\(max-width:\s*760px\)/, "the narrow viewport has an explicit layout");
assert.match(css, /:focus-visible/, "keyboard focus is visible");
assert.match(css, /min-height:\s*44px/, "controls have comfortable targets");
assert.match(page, /app\.js\?v=1\.10\.0/, "the release busts old browser assets");
assert.match(app, /function confirmDiscardReaderEdit/, "navigation protects unsaved edits");
assert.match(app, /保存翻译 API 失败/, "translation settings errors are inline");
assert.match(app, /保存搜索设置失败/, "search settings errors are inline");
assert.match(app, /手工写入译文/, "an untranslated chapter can still be edited manually");
assert.match(app, /searchInput\.addEventListener\("input",[\s\S]*?confirmDiscardReaderEdit\(\)/, "search navigation protects unsaved edits");

assert.match(page, /阅读质量/, "reader quality has one main navigation entry");
assert.match(app, /\/api\/search-settings/, "search settings have a separate API");
assert.match(app, /测试搜索连接/, "reader can test the search connection");
assert.match(app, /今日剩余/, "search budget is visible before use");
assert.match(app, /查证此处/, "uncertain facts have a reader-facing verification action");
assert.match(app, /查看依据与网页片段/, "evidence is available but not forced into the reading flow");
assert.match(app, /你可以直接阅读/, "unapproved AI notes do not block reading");
console.log("Reader-first interface entry and copy checks passed");
assert.match(app, /parallel-pages/, "source and translation share a parallel reader");
