#!/usr/bin/env node
//! TaskDock 依赖图生成工具（Phase 2）。
//! 扫描 TS/TSX 静态 import，输出模块级依赖邻接表（JSON）与 Mermaid 图。
//!
//! 用法：
//!   node scripts/architecture/dependency-graph.mjs                  # 输出 Mermaid 到 stdout
//!   node scripts/architecture/dependency-graph.mjs --json           # 邻接表 JSON
//!   node scripts/architecture/dependency-graph.mjs --out <file>     # 写入文件
//!
//! 只读：不修改源码。

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const IGNORE = ["node_modules", "dist", "target", ".expo", "android", "ios", "__tests__", "test", "tests"];

function parseArgs(argv) {
  const a = { json: false, out: null, roots: ["src"] };
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    if (x === "--json") a.json = true;
    else if (x === "--out") a.out = argv[++i];
    else if (x === "--root") a.roots = [argv[++i]];
  }
  return a;
}

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

function moduleOf(rel) {
  // 归到二级模块：src/<area>/<module>/... -> area/module；src/<area>/<file> -> area/<file无扩展>
  const p = rel.replace(/^src\//, "").replace(/\.(ts|tsx)$/, "");
  const parts = p.split("/");
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function importsOf(src) {
  const out = [];
  const re = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(src))) { const s = m[1] || m[2]; if (s && s.startsWith(".")) out.push(s); }
  return out;
}

function resolve(fromRel, spec) {
  const dir = fromRel.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") dir.pop(); else dir.push(part);
  }
  return dir.join("/");
}

function main() {
  const argv = parseArgs(process.argv.slice(2));
  const files = argv.roots.flatMap((r) => walk(join(ROOT, r)));
  const edges = new Map();
  const modFiles = new Map();

  for (const f of files) {
    const rel = toPosix(relative(ROOT, f));
    const from = moduleOf(rel);
    if (!edges.has(from)) edges.set(from, new Set());
    if (!modFiles.has(from)) modFiles.set(from, []);
    modFiles.get(from).push(rel);
    for (const spec of importsOf(readFileSync(f, "utf8"))) {
      const target = resolve(rel, spec);
      const to = moduleOf(target + ".ts");
      if (to && to !== from) edges.get(from).add(to);
    }
  }

  const graph = {};
  for (const [from, tos] of edges) graph[from] = [...tos].sort();

  // 找环（Tarjan 简化版：DFS）
  const cycles = [];
  const state = new Map();
  const stack = [];
  function dfs(node) {
    state.set(node, 1); stack.push(node);
    for (const nxt of graph[node] || []) {
      if (!state.has(nxt)) dfs(nxt);
      else if (state.get(nxt) === 1) {
        const cyc = stack.slice(stack.indexOf(nxt)).concat(nxt);
        cycles.push(cyc.join(" -> "));
      }
    }
    stack.pop(); state.set(node, 2);
  }
  for (const k of Object.keys(graph)) if (!state.has(k)) dfs(k);

  const result = {
    generatedAt: new Date().toISOString(),
    moduleCount: Object.keys(graph).length,
    edgeCount: Object.values(graph).reduce((s, v) => s + v.length, 0),
    cycles: [...new Set(cycles)],
    graph,
  };

  let output;
  if (argv.json) {
    output = JSON.stringify(result, null, 2);
  } else {
    const lines = ["flowchart LR"];
    const safe = (s) => s.replace(/[^a-zA-Z0-9_]/g, "_");
    for (const [from, tos] of Object.entries(graph)) {
      for (const to of tos) lines.push(`  ${safe(from)} --> ${safe(to)}`);
    }
    lines.push("", `%% 模块数 ${result.moduleCount} · 依赖边 ${result.edgeCount} · 环 ${result.cycles.length}`);
    output = lines.join("\n");
  }

  if (argv.out) { writeFileSync(argv.out, output); process.stdout.write(`written: ${argv.out}\n`); }
  else process.stdout.write(output + "\n");
}

main();
