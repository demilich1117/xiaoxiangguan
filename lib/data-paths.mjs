import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export function dataRoot({ root, env = process.env, platform = process.platform }) {
  if (env.TRANSLATION_LIBRARY_DATA_DIR) {
    if (!isAbsolute(env.TRANSLATION_LIBRARY_DATA_DIR)) throw new Error("TRANSLATION_LIBRARY_DATA_DIR 必须是绝对路径");
    return resolve(env.TRANSLATION_LIBRARY_DATA_DIR);
  }
  if (existsSync(join(root, "data", "library.json"))) return root;
  if (platform === "win32") return join(env.LOCALAPPDATA || env.APPDATA || env.USERPROFILE || homedir(), "Xiaoxiangguan");
  if (platform === "darwin") return join(env.HOME || homedir(), "Library", "Application Support", "Xiaoxiangguan");
  return join(env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"), "xiaoxiangguan");
}

export function resolveSourceFile(book, bookRoot) {
  const saved = String(book.sourceFile || "");
  if (!saved) return "";
  if (isAbsolute(saved)) {
    const moved = join(bookRoot, "source", basename(saved));
    return existsSync(moved) ? moved : saved;
  }
  const source = resolve(bookRoot, saved);
  const inside = relative(resolve(bookRoot), source);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error("原文件路径无效");
  return source;
}
