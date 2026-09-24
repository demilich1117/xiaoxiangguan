export function readerMode({ hasTranslation, editing }) {
  if (editing) return "edit";
  return hasTranslation ? "read" : "empty";
}
