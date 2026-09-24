import assert from "node:assert/strict";
import { cleanReaderExplanation } from "../public/reader-notes.js";
import { pageBooks } from "../public/library-index.js";

assert.equal(cleanReaderExplanation("文中涉及制度背景，需统一译名"), "");
assert.equal(cleanReaderExplanation("文中多次出现并作为核心论述术语"), "");
assert.equal(cleanReaderExplanation("文中涉及制度背景，需统一译名。指明治时期的地方行政区划。"), "指明治时期的地方行政区划。");
assert.equal(cleanReaderExplanation("指明治时期的地方行政区划。"), "指明治时期的地方行政区划。");
const books = Array.from({ length: 23 }, (_, index) => ({ id: index + 1 }));
assert.deepEqual(pageBooks(books, 0).map((book) => book.id), [1,2,3,4,5,6,7,8,9,10]);
assert.deepEqual(pageBooks(books, 1).map((book) => book.id), [11,12,13,14,15,16,17,18,19,20]);
assert.deepEqual(pageBooks(books, 2).map((book) => book.id), [21,22,23]);
console.log("Reader note and library index checks passed");
