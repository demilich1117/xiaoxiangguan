const boilerplate = /^(?:文中涉及制度背景[，,]?需统一译名|文中多次出现(?:并作为核心论述术语)?|需统一译名|需保持全书译名一致|作为核心论述术语|建议统一译名|注意前后译法一致)$/;

export function cleanReaderExplanation(value = "") {
  return String(value).split(/(?<=[。！？；])/u).map((part) => part.trim()).filter((part) => !boilerplate.test(part.replace(/[。！？；]$/u, ""))).join("").trim();
}
