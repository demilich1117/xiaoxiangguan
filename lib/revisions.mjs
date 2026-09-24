export function canAutoRevise(chapter, expectedRevisionId = null) {
  return chapter?.draftOrigin === "ai" && chapter.status === "review" && !chapter.exportedAt && (!expectedRevisionId || chapter.revisionId === expectedRevisionId);
}

export function canAutoReviseFromEvidence(chapter, research) {
  if (!canAutoRevise(chapter) || research?.verdict !== "conflicted" || research.confidence !== "high" || !research.suggestedChinese) return false;
  const domains = new Set((research.sources || []).filter((source) => source.excerpt).map((source) => {
    try { return new URL(source.url).hostname.split(".").slice(-2).join("."); } catch { return ""; }
  }).filter(Boolean));
  return domains.size >= 2;
}

export function newRevisionId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function preserveChapterRevisionState(fresh, old) {
  if (!old) return fresh;
  return { ...old, ...fresh, status: old.status || fresh.status, translationPath: old.translationPath || "", polishedPath: old.polishedPath || "", segments: old.segments || [], usage: old.usage || fresh.usage, lastModel: old.lastModel || "" };
}
