import { existsSync } from "node:fs";
import { delimiter, dirname, extname, join, resolve } from "node:path";

export function toolCandidates(envName, name, defaults = [], env = process.env, platform = process.platform) {
  const executable = platform === "win32" && !extname(name) ? `${name}.exe` : name;
  const searchPath = String(env.PATH || env.Path || "").split(delimiter).filter(Boolean).map((dir) => join(dir, executable));
  return [...new Set([env[envName], ...defaults, ...searchPath].filter(Boolean).map((path) => resolve(path)))].filter(existsSync);
}

export function tessdataDirectories(executable, env = process.env) {
  const prefix = env.TESSDATA_PREFIX;
  const candidates = [
    prefix, prefix && join(prefix, "tessdata"), join(dirname(executable), "tessdata"),
    "/usr/share/tesseract-ocr/5/tessdata", "/usr/share/tesseract-ocr/4.00/tessdata", "/usr/share/tessdata",
    "/opt/homebrew/share/tessdata", "/usr/local/share/tessdata"
  ];
  return [...new Set(candidates.filter(Boolean).map((path) => resolve(path)))].filter(existsSync);
}
