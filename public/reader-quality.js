export function summarizeLibraryQuality(books) {
  const checks = books.flatMap((book) => (book.chapters || []).flatMap((chapter) => chapter.quality?.autoChecks || []));
  return { checked: checks.length, revised: checks.filter((item) => item.autoRevised).length, unresolved: checks.filter((item) => item.verdict !== "supported" || !item.autoRevised && item.verdict === "conflicted").length };
}

export function searchStatus(settings) {
  if (!settings?.hasApiKey) return "搜索 API 未配置；初译照常进行";
  if (settings.remaining <= 0) return "今日联网搜索额度已用完；初译照常进行";
  return `今天还可发起 ${settings.remaining} 次联网搜索`;
}
