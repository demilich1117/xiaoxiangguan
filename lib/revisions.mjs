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

// One resolver is shared by reading, editing, refinement and export. Legacy fallback is explicit.
export function activeRevisionPath(chapter) {
  const id = chapter.activeRevisionId || chapter.revisionId;
  const revision = chapter.revisionHistory?.find((revision) => revision.id === id);
  if (chapter.activeRevisionId && !revision?.path) throw new Error("当前译稿版本不可用，请从历史版本中恢复");
  return revision?.path || chapter.polishedPath || chapter.translationPath || "";
}
export function preserveLegacyRevision(chapter) {
  chapter.revisionHistory ||= [];
  for (const path of [chapter.translationPath, chapter.polishedPath].filter(Boolean)) {
    if (!chapter.revisionHistory.some((revision) => revision.path === path)) chapter.revisionHistory.push({ id: newRevisionId(), path, origin: chapter.draftOrigin || "legacy", reason: "保留已有译文" });
  }
}
