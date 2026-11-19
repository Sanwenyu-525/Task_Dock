#!/usr/bin/env node
//! TaskDock 重复源码检测（Phase 2）。
//! 检测平行源码树（如 src-tauri/components vs src/components）与疑似重复源文件。
//! 未跟踪目录由 git ls-files 判定，只报告不删除。
//!
//!   node scripts/architecture/duplicate-source-check.mjs [--json]

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, relative, basename, sep } from "node:path";
import { execSync } from "node:child_process";

const ROOT = process.cwd();
function parseArgs(argv) { return { json: argv.includes("--json") }; }
function toPosix(p) { return p.split(sep).join("/"); }

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "target", ".expo", "android"].includes(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|rs)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(full);
  }
  return out;
}

function trackedSet() {
  try {
    const out = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" });
    return new Set(out.split("\n").filter(Boolean).map(toPosix));
  } catch { return new Set(); }
}

function main() {
  const argv = parseArgs(process.argv.slice(2));
  const tracked = trackedSet();
  const pairs = [
    ["src-tauri/components", "src/components"],
    ["src-tauri/boot", "src/boot"],
  ];
  const findings = [];

  for (const [a, b] of pairs) {
    const absA = join(ROOT, a);
    const absB = join(ROOT, b);
    if (!existsSync(absA)) continue;
    const filesA = walk(absA).map((f) => toPosix(relative(ROOT, f)));
    const filesB = walk(absB).map((f) => toPosix(relative(ROOT, f)));
    const baseB = new Set(filesB.map((f) => basename(f)));
    let sameName = 0, onlyA = 0;
    for (const f of filesA) {
      if (baseB.has(basename(f))) sameName++;
      else onlyA++;
    }
    const trackedA = filesA.filter((f) => tracked.has(f)).length;
    findings.push({
      pathA: a,
      pathB: b,
      filesA: filesA.length,
      filesB: filesB.length,
      trackedInA: trackedA,
      sameBasename: sameName,
      onlyInA: onlyA,
      verdict: trackedA === 0 ? "未跟踪的平行树，当前不参与构建，需确认所有权" : "已跟踪，需人工比对",
    });
  }

  const result = { generatedAt: new Date().toISOString(), findings };
  if (argv.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else {
    process.stdout.write("\n重复源码检测\n");
    for (const f of findings) {
      process.stdout.write(`   ${f.pathA} vs ${f.pathB}: A=${f.filesA} B=${f.filesB} 同名=${f.sameName} 仅A=${f.onlyA} git跟踪(A)=${f.trackedInA}\n`);
      process.stdout.write(`      ${f.verdict}\n`);
    }
    if (!findings.length) process.stdout.write("   （未检测到配置的平行源码树）\n");
    process.stdout.write("只读报告：不删除任何文件。\n");
  }
}

main();
