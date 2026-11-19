//! architecture-guard 与配套工具的自测（node:test）。
//! 验证：规则配置有效、守卫能跑通并产出稳定结构、重复源码检测识别未跟踪树、依赖图产出合法 JSON。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const ROOT = process.cwd();
const ARCH = join(ROOT, "scripts", "architecture");

function run(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
}

test("规则配置结构合法", () => {
  const cfg = JSON.parse(readFileSync(join(ARCH, "architecture-rules.json"), "utf8"));
  assert.ok(cfg.version, "缺少 version");
  assert.ok(["report", "staged", "enforced"].includes(cfg.stage), "stage 非法");
  assert.ok(Array.isArray(cfg.rules) && cfg.rules.length > 0, "规则为空");
  const ids = new Set();
  for (const r of cfg.rules) {
    assert.ok(r.id && r.name && r.check, `规则字段缺失: ${JSON.stringify(r)}`);
    assert.ok(!ids.has(r.id), `重复规则 id: ${r.id}`);
    ids.add(r.id);
    for (const e of r.exceptions || []) {
      assert.ok(e.reason, `例外 ${r.id} 缺少 reason`);
      assert.ok(e.exitWhen, `例外 ${r.id} 缺少 exitWhen`);
    }
  }
});

test("每个例外都有退出条件（禁无理由忽略）", () => {
  const cfg = JSON.parse(readFileSync(join(ARCH, "architecture-rules.json"), "utf8"));
  for (const r of cfg.rules) {
    for (const e of r.exceptions || []) {
      assert.ok(e.reason.length >= 4, `例外理由过短: ${r.id}`);
      assert.ok(e.exitWhen.length >= 4, `退出条件过短: ${r.id}`);
    }
  }
});

test("守卫 --json 产出稳定结构且退出码 0", () => {
  const out = run("node scripts/architecture/architecture-guard.mjs --json");
  const data = JSON.parse(out);
  assert.ok(data.summary, "缺少 summary");
  assert.ok(Array.isArray(data.results), "缺少 results");
  assert.ok(data.summary.rules >= 8, "规则数异常");
  assert.ok(typeof data.summary.activeViolations === "number", "activeViolations 非数字");
  assert.ok(data.summary.head && data.summary.head !== "", "head 为空");
});

test("守卫报告模式包含关键规则", () => {
  const out = run("node scripts/architecture/architecture-guard.mjs");
  for (const id of ["LAYER-001", "ERROR-001", "DUP-001", "DOC-001"]) {
    assert.ok(out.includes(id), `报告缺少规则 ${id}`);
  }
  assert.ok(out.includes("不阻断构建"), "未声明报告模式");
});

test("--rule 只跑指定规则", () => {
  const out = run("node scripts/architecture/architecture-guard.mjs --json --rule DUP-001");
  const data = JSON.parse(out);
  assert.equal(data.results.length, 1, "应只返回一条规则");
  assert.equal(data.results[0].rule, "DUP-001");
});

test("重复源码检测识别未跟踪平行树", () => {
  const out = run("node scripts/architecture/duplicate-source-check.mjs --json");
  const data = JSON.parse(out);
  assert.ok(Array.isArray(data.findings), "缺少 findings");
  const comp = data.findings.find((f) => f.pathA === "src-tauri/components");
  assert.ok(comp, "未检测到 src-tauri/components");
  assert.equal(comp.trackedInA, 0, "平行树不应被 git 跟踪");
});

test("依赖图产出合法 JSON 与图结构", () => {
  const out = run("node scripts/architecture/dependency-graph.mjs --json");
  const data = JSON.parse(out);
  assert.ok(data.graph && typeof data.graph === "object", "缺少 graph");
  assert.ok(data.moduleCount > 0, "模块数为 0");
  assert.ok(Array.isArray(data.cycles), "缺少 cycles");
});

test("所有脚本为只读（不含写源码调用）", () => {
  for (const name of ["architecture-guard.mjs", "dependency-graph.mjs", "module-boundary-check.mjs", "duplicate-source-check.mjs"]) {
    const src = readFileSync(join(ARCH, name), "utf8");
    assert.ok(!/writeFileSync\([^,]+,\s*['"][^'"]*src\//.test(src), `${name} 疑似写源码目录`);
  }
});
