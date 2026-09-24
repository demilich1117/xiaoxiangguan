export const SOURCE_LANGUAGES = Object.freeze([
  { code: "ja", label: "日语", ocrModel: "jpn+eng", researchCode: "ja" },
  { code: "en", label: "英语", ocrModel: "eng", researchCode: "en" },
  { code: "fr", label: "法语", ocrModel: "fra", researchCode: "fr" },
  { code: "de", label: "德语", ocrModel: "deu", researchCode: "de" },
  { code: "es", label: "西班牙语", ocrModel: "spa", researchCode: "es" }
]);

export function sourceLanguage(book) {
  return SOURCE_LANGUAGES.some((entry) => entry.code === book?.sourceLanguage) ? book.sourceLanguage : "ja";
}

export function languageDetails(book) {
  return SOURCE_LANGUAGES.find((entry) => entry.code === sourceLanguage(book));
}
