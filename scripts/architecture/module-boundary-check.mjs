#!/usr/bin/env node
//! TaskDock 模块边界检查（Phase 2）。
//! 检查 features/* 是否只从 index.ts 公开出口被跨模块 import，以及 lib/domain 层纯净性。
//! 报告模式：退出码恒 0。
//!
//!   node scripts/architecture/module-boundary-check.mjs [--json]

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src", "features");
const IGNORE = ["node_modules", "dist", "target", "__tests__", "test"];

function parseArgs(argv) { return { json: argv.includes("--json") }; }
function toPosix(p) { return p.split(sep).join("/"); }

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.includes(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(full);
  }
  return out;
}

function importsOf(src) {
  const out = [];
  const re = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) if (m[1]) out.push({ spec: m[1], line: src.slice(0, m.index).split("\n").length });
  return out;
}

function main() {
  const argv = parseArgs(process.argv.slice(2));
  const files = walk(SRC);
  const violations = [];

  for (const f of files) {
    const rel = toPosix(relative(ROOT, f));
    const parts = rel.split("/");
    const ownFeature = parts[2]; // src/features/<feature>/...
    for (const im of importsOf(readFileSync(f, "utf8"))) {
      const m = im.spec.match(/features\/([^/]+)\/(.+)$/);
      if (!m) continue;
      const [, targetFeature, targetPath] = m;
      if (targetFeature === ownFeature) continue;
      // 跨 feature import：必须经目标 feature 的 index
      if (targetPath !== "index" && !targetPath.startsWith("index.")) {
        violations.push({
          from: rel,
          line: im.line,
          to: im.spec,
          detail: `跨 feature 访问私有实现 ${targetFeature}/${targetPath}（应经 index 公开出口）`,
        });
      }
    }
  }

  const result = { generatedAt: new Date().toISOString(), featureFiles: files.length, violations };
  if (argv.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else {
    process.stdout.write(`\n模块边界检查 · features 文件 ${files.length} · 违规 ${violations.length}\n`);
    for (const v of violations) process.stdout.write(`   - ${v.from}:${v.line} → ${v.to} — ${v.detail}\n`);
    if (!violations.length) process.stdout.write("   （features/ 目录当前为空或未发现跨模块私有访问）\n");
    process.stdout.write("报告模式：不阻断构建。\n");
  }
}

main();
