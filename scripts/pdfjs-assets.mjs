//! 把 pdfjs-dist 的运行时静态资源（CMap / 标准字体 / WASM 编解码器）同步到
//! `public/pdfjs/`：PDF 预览必须完全本地化，禁止 CDN，也不把用户文件上传到第三方。
//!
//! 资源由依赖版本决定，带版本戳：版本未变时直接跳过（dev 启动不重复拷 3.7 MiB）。
//! 由 `vite.config.ts` 在配置求值时调用，dev 与 build 走同一条路径。

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const TARGET = join(ROOT, "public", "pdfjs");
const DIRS = ["cmaps", "standard_fonts", "wasm"];

export function syncPdfjsAssets({ quiet = true } = {}) {
  let source;
  let version;
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("pdfjs-dist/package.json");
    source = dirname(pkgPath);
    version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch {
    if (!quiet) console.warn("[pdfjs-assets] pdfjs-dist 未安装，跳过静态资源同步");
    return false;
  }
  const stamp = join(TARGET, ".version");
  if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === version) return true;
  mkdirSync(TARGET, { recursive: true });
  for (const dir of DIRS) {
    const from = join(source, dir);
    if (!existsSync(from)) continue;
    cpSync(from, join(TARGET, dir), { recursive: true, force: true });
  }
  writeFileSync(stamp, `${version}\n`, "utf8");
  return true;
}
