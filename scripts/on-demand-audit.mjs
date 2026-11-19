#!/usr/bin/env node
//! 按需加载审计：统计每个窗口「首屏必须加载」的 JS 体积与 chunk 清单。
//!
//! 口径（可复现，不依赖手工数文件）：
//! - 入口集合 = `<entry>.html` 里的 `<script src>` + `<link rel="modulepreload">`；
//! - 这些文件由浏览器在首帧前请求（Vite 的 modulepreload 就是静态 import 图闭包），
//!   因此就是「启动时必须下载/解析」的 JS；
//! - lazy chunk（React.lazy / 动态 import）不会出现在 modulepreload 里，
//!   它们只在用户真正进入页面时请求 —— 本脚本因此能直接验证「按需加载是否生效」。
//!
//! 用法：
//!   node scripts/on-demand-audit.mjs dist                 # 审计 dist/
//!   node scripts/on-demand-audit.mjs dist --json          # 机器可读
//!   node scripts/on-demand-audit.mjs dist --entry main    # 只看一个入口
//!
//! 只读：不修改产物、不启动服务、不发网络请求。

import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { gzipSync } from "node:zlib";

const ENTRY_FILES = [
  "index.html",
  "workspace.html",
  "capture.html",
  "notification.html",
  "context-menu.html",
  "tab-hint.html",
  "widget.html",
  "toolbar.html",
];

function parseArgs(argv) {
  const args = { dir: "dist", json: false, entry: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--entry") args.entry = argv[++i] ?? null;
    else if (!arg.startsWith("--")) args.dir = arg;
  }
  return args;
}

function eagerAssets(html) {
  const found = new Set();
  for (const match of html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)) found.add(match[1]);
  for (const match of html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+\.js)"/g)) {
    found.add(match[1]);
  }
  // 属性顺序不保证：再扫一遍 href 在前的 modulepreload。
  for (const match of html.matchAll(/<link[^>]+href="([^"]+\.js)"[^>]+rel="modulepreload"/g)) {
    found.add(match[1]);
  }
  return [...found].map((path) => path.replace(/^\.?\//, ""));
}

function sizeOf(file) {
  if (!existsSync(file)) return null;
  const raw = statSync(file).size;
  const gzip = gzipSync(readFileSync(file)).length;
  return { raw, gzip };
}

function human(bytes) {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir;
  if (!existsSync(dir)) {
    console.error(`目录不存在：${dir}`);
    process.exit(2);
  }

  const entries = ENTRY_FILES.filter((name) => existsSync(join(dir, name))).filter(
    (name) => !args.entry || name.startsWith(args.entry),
  );
  if (entries.length === 0) {
    console.error(`没有找到入口 HTML（${ENTRY_FILES.join(" / ")}）于 ${dir}`);
    process.exit(2);
  }

  const report = { dir, generatedAt: new Date().toISOString(), entries: {} };

  for (const name of entries) {
    const html = readFileSync(join(dir, name), "utf8");
    const assets = eagerAssets(html);
    const rows = [];
    let raw = 0;
    let gzip = 0;
    for (const asset of assets) {
      const size = sizeOf(join(dir, asset));
      if (!size) continue;
      rows.push({ asset: basename(asset), raw: size.raw, gzip: size.gzip });
      raw += size.raw;
      gzip += size.gzip;
    }
    rows.sort((a, b) => b.raw - a.raw);
    report.entries[name] = { count: rows.length, raw, gzip, assets: rows };
  }

  // 全量 chunk 统计（判断拆分是否真的发生）。
  const assetsDir = join(dir, "assets");
  const allJs = existsSync(assetsDir)
    ? readdirSync(assetsDir).filter((file) => file.endsWith(".js"))
    : [];
  let allRaw = 0;
  for (const file of allJs) allRaw += statSync(join(assetsDir, file)).size;
  report.chunkCount = allJs.length;
  report.totalJsRaw = allRaw;

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`审计目录：${report.dir}`);
  for (const [name, entry] of Object.entries(report.entries)) {
    console.log(`\n== ${name} ==`);
    console.log(
      `首屏 JS：${entry.count} 个 chunk，${human(entry.raw)}（gzip ${human(entry.gzip)}）`,
    );
    for (const row of entry.assets.slice(0, 12)) {
      console.log(`  ${human(row.raw).padStart(10)}  gzip ${human(row.gzip).padStart(9)}  ${row.asset}`);
    }
    if (entry.assets.length > 12) console.log(`  … 另有 ${entry.assets.length - 12} 个 chunk`);
  }
  console.log(
    `\n产物 JS 总量：${allJs.length} 个 chunk，${human(allRaw)}（首屏占比见上）`,
  );
}

main();
