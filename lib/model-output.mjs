export function modelRefusalError(reason = "", finishReason = "refusal") {
  const detail = String(reason || "").trim().slice(0, 600);
  const error = new Error(`模型拒绝或内容审核拦截；此块未采用，已完成块已保留${detail ? `：${detail}` : ""}`);
  error.code = "MODEL_REFUSAL";
  error.finishReason = finishReason;
  return error;
}

// Used only for non-JSON responses, never to scan a translated literary passage.
export function isPlainRefusal(text) {
  return /^(?:(?:抱歉|对不起)[，,。\s]*)?(?:我(?:无法|不能|不可以)(?:帮助|协助|提供|翻译|处理|生成|完成)|I\s+(?:cannot|can't|am unable to)\s+(?:help|assist|provide|translate|process|generate|fulfill))/i.test(String(text).trim().replace(/^(?:I'm sorry|I am sorry|Sorry)[,.:\s]*/i, ""));
}
