//! 视觉走查用的静态服务器：
//!   node scripts/make-preview.mjs && node scripts/serve-preview.mjs
//!
//! 与 `npx vite preview` 的区别：/preview.html 与 /preview-shim.js 从 .preview/ 取，
//! 其余静态资源从 dist/ 取。vite build 会清空 dist/，并发构建期间 dist 里的 harness
//! 副本会消失，导致走查页面退化成 404（无 IPC mock、页面白屏）。.preview/ 不参与构建，
//! 因此这里不依赖 dist 是否刚被重建。

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const previewDir = join(root, ".preview");
const distDir = join(root, "dist");
const PORT = Number(process.env.PREVIEW_PORT ?? 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function resolve(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  // Windows 上 normalize 会把 "/preview.html" 变成 "\preview.html"（前导反斜杠），
  // 直接与 "/preview.html" 比较永远不成立 → harness 永远 404。
  // 因此统一剥掉前导分隔符并忽略大小写后再比较。
  const base = clean.replace(/^[/\\]+/, "").toLowerCase();
  if (base === "preview.html" || base === "preview-shim.js") {
    const p = join(previewDir, base);
    return existsSync(p) ? p : null;
  }
  const rel = base === "" ? "/index.html" : clean;
  const p = join(distDir, rel);
  return existsSync(p) && statSync(p).isFile() ? p : null;
}

createServer((req, res) => {
  const file = resolve(req.url ?? "/");
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`preview server → http://localhost:${PORT}/preview.html`);
});
