import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

const MAX_BYTES = 256 * 1024;

export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && c === 0))) ||
      (a === 198 && (b === 18 || b === 19)));
  }
  if (isIP(address) === 6) {
    if (address.toLowerCase().includes("::ffff:")) return false;
    const first = parseInt(address.split(":")[0] || "0", 16);
    return first >= 0x2000 && first < 0x4000;
  }
  return false;
}

function checkedUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("资料地址不是有效 HTTP(S) URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("资料地址必须使用 HTTP 或 HTTPS");
  if (parsed.username || parsed.password || !parsed.hostname || /(^|\.)(localhost|local|internal)$/i.test(parsed.hostname) || (isIP(parsed.hostname) && !isPublicAddress(parsed.hostname))) {
    throw new Error("只能读取公开网页，不能访问本机或内网地址");
  }
  return parsed;
}

async function fetchPage(url) {
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = requester(url, {
      method: "GET", timeout: 8000, autoSelectFamily: false, headers: { "user-agent": "ReaderTranslationLibrary/1.5", accept: "text/html,text/plain" },
      lookup: (hostname, _options, callback) => {
        lookup(hostname, { all: true }).then((addresses) => {
          const selected = addresses.find((entry) => isPublicAddress(entry.address));
          if (!selected) return callback(new Error("只能读取公开网页，不能访问本机或内网地址"));
          callback(null, selected.address, selected.family);
        }, callback);
      }
    }, (res) => {
      const chunks = []; let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) { req.destroy(new Error("网页内容过大")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("网页读取超时")));
    req.on("error", reject);
    req.end();
  });
}

function textFromHtml(html) {
  return String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos);/gi, (entity) => ({ "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity.toLowerCase()] || entity)
    .replace(/\s+/g, " ").trim();
}

export async function readPublicSource(value, { requestImpl = fetchPage, term = "" } = {}) {
  let url = checkedUrl(value);
  for (let redirects = 0; redirects <= 2; redirects++) {
    const response = await requestImpl(url);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 2) throw new Error("网页重定向次数过多");
      url = checkedUrl(new URL(response.headers.location || "", url).href);
      continue;
    }
    if (response.status !== 200) throw new Error(`网页 HTTP ${response.status}`);
    if (!/^text\/(?:html|plain)/i.test(String(response.headers["content-type"] || ""))) throw new Error("网页不是可读取的文本内容");
    if (Buffer.byteLength(response.body || "") > MAX_BYTES) throw new Error("网页内容过大");
    const title = textFromHtml(String(response.body).match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || "").slice(0, 180);
    const pageText = textFromHtml(response.body);
    const position = term ? pageText.indexOf(term) : -1;
    const excerpt = pageText.slice(position < 0 ? 0 : Math.max(0, position - 300), position < 0 ? 1400 : position + 1100);
    if (!excerpt) throw new Error("网页没有可用文字");
    return { url: url.href, title, excerpt, readAt: new Date().toISOString() };
  }
  throw new Error("网页重定向次数过多");
}
