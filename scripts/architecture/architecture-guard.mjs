#!/usr/bin/env node
//! TaskDock 架构守卫（Phase 2）。
//!
//! 规则驱动、纯 node:fs、零第三方依赖。默认「报告模式」：只统计违规、输出 JSON/Markdown，
//! 退出码恒为 0（不阻断构建）。阶段升级为 staged/enforced 后按规则 severity 决定是否阻断。
//!
//! 用法：
//!   node scripts/architecture/architecture-guard.mjs              # 报告模式（默认）
//!   node scripts/architecture/architecture-guard.mjs --json       # 机器可读 JSON
//!   node scripts/architecture/architecture-guard.mjs --stage staged --changed-file src/lib/x.ts
//!   node scripts/architecture/architecture-guard.mjs --rule LAYER-001  # 只跑一条规则
//!
//! 只读：不修改源码、不发网络请求。基线见 tmp/acceptance/architecture-governance/baseline.json。

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { execSync } from "node:child_process";

function gitHead() {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: process.cwd() }).toString().trim();
  } catch {
    return "unknown";
  }
}

const ROOT = process.cwd();
const RULES_PATH = join(ROOT, "scripts", "architecture", "architecture-rules.json");

// ---------- 参数 ----------
function parseArgs(argv) {
  const a = { json: false, stage: null, rule: null, changedFiles: [], config: RULES_PATH };
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    if (x === "--json") a.json = true;
    else if (x === "--stage") a.stage = argv[++i];
    else if (x === "--rule") a.rule = argv[++i];
    else if (x === "--changed-file") a.changedFiles.push(argv[++i]);
    else if (x === "--config") a.config = argv[++i];
  }
  return a;
}

// ---------- 工具 ----------
function toPosix(p) {
  return p.split(sep).join("/");
}

function walk(dir, out = [], ignoreDirs = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignoreDirs.includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out, ignoreDirs);
    else out.push(full);
  }
  return out;
}

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "").replace(/\*/g, "[^/]*").replace(//g, ".*");
  return new RegExp("^" + escaped + "$");
}

function pathMatches(path, patterns) {
  return patterns.some((p) => globToRegex(p).test(path));
}

function isExempt(rel, rule) {
  return (rule.exceptions || []).some((e) => {
    if (e.path === "ALL") return true;
    if (e.path === rel) return true;
    // 环例外：e.path 含 "->" 时按环关键片段匹配（如 errors->diagnostics->bridge）
    if (e.path.includes("->")) {
      const parts = e.path.split("->");
      return parts.every((p) => rel.includes(p));
    }
    // 目录级例外：e.path 是 rel 的前缀
    return rel.startsWith(e.path.replace(/\/$/, "") + "/");
  });
}

function readSource(abs) {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

// 解析静态 import / require / 动态 import 的模块路径（保守：只取字符串字面量）
function collectImports(src) {
  const out = [];
  const re = /(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1] || m[2] || m[3];
    if (spec) out.push({ spec, index: m.index, line: lineOf(src, m.index) });
  }
  return out;
}

function resolveRelative(fromRel, spec) {
  if (!spec.startsWith(".")) return null;
  const fromDir = fromRel.split("/").slice(0, -1);
  const parts = spec.split("/");
  for (const p of parts) {
    if (p === "." || p === "") continue;
    else if (p === "..") fromDir.pop();
    else fromDir.push(p);
  }
  return fromDir.join("/");
}

// ---------- 规则实现 ----------
function violation(rule, file, line, detail) {
  return { rule: rule.id, name: rule.name, severity: rule.severity, file, line, detail, exempt: isExempt(file, rule) };
}

function runRule(rule, files, ctx) {
  const V = [];
  const relOf = (f) => toPosix(relative(ROOT, f));
  const scoped = files.filter((f) => pathMatches(relOf(f), rule.scope));

  if (rule.check === "no-lib-to-store") {
    for (const f of scoped) {
      const src = readSource(f);
      for (const im of collectImports(src)) {
        if (/store\/use[A-Z].*Store/.test(im.spec) || /\.Store['"]$/.test(im.spec) || im.spec.includes("../store/")) {
          V.push(violation(rule, relOf(f), im.line, `lib 层 import store: ${im.spec}`));
        }
      }
    }
  } else if (rule.check === "ipc-entrypoints") {
    for (const f of scoped) {
      const src = readSource(f);
      const direct = /import\s*\{[^}]*\binvoke\b[^}]*\}\s*from\s*["']@tauri-apps\/api\/core["']/.test(src);
      if (direct) V.push(violation(rule, relOf(f), 1, "直连 @tauri-apps/api/core 的 invoke"));
    }
  } else if (rule.check === "duplicate-error-model") {
    const defs = [];
    for (const f of scoped) {
      const src = readSource(f);
      const m = src.match(/(?:class|enum|interface|struct)\s+(AppError|ErrorCode|AppErrorCode|AppErrorKind)\b/);
      if (m) defs.push({ file: relOf(f), symbol: m[1] });
    }
    const bySymbol = {};
    for (const d of defs) (bySymbol[d.symbol] ||= []).push(d.file);
    for (const [symbol, list] of Object.entries(bySymbol)) {
      if (list.length > 1) V.push(violation(rule, list.join(" | "), 0, `${symbol} 在 ${list.length} 处定义: ${list.join(", ")}`));
    }
  } else if (rule.check === "no-ui-db") {
    for (const f of scoped) {
      const rel = relOf(f);
      if (rel.includes("/db/")) continue;
      const src = readSource(f);
      for (const im of collectImports(src)) {
        if (/expo-sqlite/.test(im.spec)) V.push(violation(rule, rel, im.line, `非 db 层 import expo-sqlite: ${im.spec}`));
      }
    }
  } else if (rule.check === "domain-purity") {
    for (const f of scoped) {
      const src = readSource(f);
      for (const im of collectImports(src)) {
        if (/^(react|react-native|expo|expo-sqlite|@tauri-apps)/.test(im.spec)) {
          V.push(violation(rule, relOf(f), im.line, `domain 依赖平台/框架: ${im.spec}`));
        }
      }
    }
  } else if (rule.check === "duplicate-source-tree") {
    for (const p of rule.monitoredPaths || []) {
      const abs = join(ROOT, p);
      if (existsSync(abs)) {
        const cnt = walk(abs, [], ctx.ignoreDirs).filter((f) => /\.(ts|tsx|js|rs)$/.test(f)).length;
        V.push(violation(rule, p + "/", 0, `检测到平行源码树（${cnt} 个源文件），当前不参与构建，需确认所有权`));
      }
    }
  } else if (rule.check === "doc-number-drift") {
    const readme = join(ROOT, "README.md");
    if (existsSync(readme)) {
      const src = readSource(readme);
      if (/迁移至\s*v33|v33/.test(src)) V.push(violation(rule, "README.md", 0, "README 写迁移 v33，源码实测 v78"));
      if (/43\s*张|43 张/.test(src)) V.push(violation(rule, "README.md", 0, "README 写备份 43 表，源码实测 143"));
    }
  } else if (rule.check === "feature-registry") {
    // 外壳/导航层静态 import 页面组件（简单启发式：import 路径指向 components/*Panel / *Workspace / *View）
    const shellFiles = scoped.filter((f) => /(FullView|WorkbenchShell|App)\.tsx$/.test(relOf(f)));
    for (const f of shellFiles) {
      const src = readSource(f);
      for (const im of collectImports(src)) {
        if (/(Panel|Workspace|View)["']$/.test(im.spec) && !im.spec.includes("feature")) {
          V.push(violation(rule, relOf(f), im.line, `外壳静态 import 页面: ${im.spec}（应经 registry）`));
        }
      }
    }
  } else if (rule.check === "circular-deps") {
    // 文件级保守环检测：只解析同目录相对 import，构建邻接表后找环
    const graph = new Map();
    for (const f of scoped) {
      const rel = relOf(f);
      const key = rel.replace(/\.(ts|tsx)$/, "");
      const deps = [];
      for (const im of collectImports(readSource(f))) {
        const r = resolveRelative(rel, im.spec);
        if (!r) continue;
        for (const cand of [r, r + "/index"]) {
          if (scoped.some((sf) => relOf(sf).replace(/\.(ts|tsx)$/, "") === cand)) deps.push(cand);
        }
      }
      graph.set(key, deps);
    }
    const seen = new Set();
    const cycles = [];
    function dfs(node, stack) {
      if (stack.includes(node)) {
        const cyc = stack.slice(stack.indexOf(node)).concat(node);
        const sig = cyc.slice(0, -1).sort().join("->");
        if (!seen.has(sig)) { seen.add(sig); cycles.push(cyc.join(" -> ")); }
        return;
      }
      for (const d of graph.get(node) || []) dfs(d, stack.concat(node));
    }
    for (const k of graph.keys()) dfs(k, []);
    for (const c of cycles) V.push(violation(rule, c, 0, "检测到静态 import 环"));
  }
  return V;
}

// ---------- 主流程 ----------
function main() {
  const argv = parseArgs(process.argv.slice(2));
  const config = JSON.parse(readFileSync(argv.config, "utf8"));
  const stage = argv.stage || config.stage || "report";

  const allFiles = [
    ...walk(join(ROOT, config.roots.frontend), [], config.ignoreDirs),
    ...walk(join(ROOT, config.roots.backend), [], config.ignoreDirs),
    ...walk(join(ROOT, config.roots.mobile), [], config.ignoreDirs),
  ].filter((f) => config.sourceExtensions.some((e) => f.endsWith(e)))
    // 测试文件不计入架构违规（它们为验证而跨层访问是正常的）
    .filter((f) => !/\.test\.(ts|tsx|js)$/.test(f) && !/\.spec\.(ts|tsx|js)$/.test(f));

  const ctx = { ignoreDirs: config.ignoreDirs };
  const results = [];
  for (const rule of config.rules) {
    if (!rule.enabled) continue;
    if (argv.rule && rule.id !== argv.rule) continue;
    let V = runRule(rule, allFiles, ctx);
    if (argv.changedFiles.length) {
      const changed = new Set(argv.changedFiles.map(toPosix));
      V = V.filter((v) => changed.has(v.file) || v.file.split(" | ").some((p) => changed.has(p)));
    }
    const total = V.length;
    const exempt = V.filter((v) => v.exempt).length;
    results.push({
      rule: rule.id,
      name: rule.name,
      severity: rule.severity,
      stage: rule.stage || stage,
      total,
      exempt,
      active: total - exempt,
      violations: V,
    });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    stage,
    head: gitHead(),
    rules: results.length,
    totalViolations: results.reduce((s, r) => s + r.total, 0),
    activeViolations: results.reduce((s, r) => s + r.active, 0),
    exemptViolations: results.reduce((s, r) => s + r.exempt, 0),
  };

  if (argv.json) {
    process.stdout.write(JSON.stringify({ summary, results }, null, 2) + "\n");
  } else {
    process.stdout.write(`\nTaskDock 架构守卫 · stage=${stage}\n`);
    process.stdout.write(`规则 ${summary.rules} 条 · 违规 ${summary.totalViolations}（有效 ${summary.activeViolations} / 例外 ${summary.exemptViolations}）\n\n`);
    for (const r of results) {
      process.stdout.write(`[${r.severity}] ${r.rule} ${r.name}: ${r.total}（例外 ${r.exempt}，有效 ${r.active}）\n`);
      for (const v of r.violations.slice(0, 8)) {
        process.stdout.write(`   - ${v.file}${v.line ? ":" + v.line : ""} — ${v.detail}${v.exempt ? " [例外]" : ""}\n`);
      }
      if (r.violations.length > 8) process.stdout.write(`   ... 另有 ${r.violations.length - 8} 条\n`);
    }
    process.stdout.write("\n报告模式：不阻断构建。阶段升级见 docs/adr/0005-architecture-guard-phased.md\n");
  }
}

main();
