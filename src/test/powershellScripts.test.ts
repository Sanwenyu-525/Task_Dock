// Windows PowerShell 脚本可解析性回归。
//
// 真机踩过的坑：`scripts/perf/sampler.ps1` 是 UTF-8 无 BOM，Windows PowerShell 5.1
// 按系统 ANSI（本机 GB2312）解码它，行尾中文标点（如「。」）的字节会被当成半个双字节
// 字符，从而**吞掉换行**，把下一行并进注释里：
//   - 参数声明被并进注释 → 整个脚本 ParseFile 报错，采样器一条样本都产不出来；
//   - 普通代码行被并进注释 → 脚本能解析但运行时缺语句。
// 而采样器「0 样本」曾经以 rc=0 退出，差点被当成「内存平稳」的空结果。
//
// 因此这里直接用 PowerShell 自己的解析器体检仓库里的 .ps1：
//   1. 每个 .ps1 都必须零解析错误；
//   2. 含非 ASCII（中文注释）的 .ps1 必须以 UTF-8 BOM 开头，否则按 ANSI 解码必炸。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..", "..");
const SCAN_DIRS = ["scripts", "src-tauri"];
const SKIP_DIRS = new Set([
  "node_modules",
  "target",
  "target-accept",
  "target-measure",
  "dist",
  ".git",
  "__pycache__",
]);

function collectPs1(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectPs1(full, out);
    else if (entry.toLowerCase().endsWith(".ps1")) out.push(full);
  }
  return out;
}

const ps1Files = SCAN_DIRS.flatMap((d) => collectPs1(join(ROOT, d)));

function parseAll(files: string[]): { ok: string[]; err: string[] } {
  // 文件清单必须内嵌进脚本体：`-Command` 之后的参数会被当成命令的一部分解析，
  // 而仓库里的 .ps1 自带 param 块，会把参数当成自己的入参而报错。
  const fileList = files.map((f) => `'${f.replace(/'/g, "''")}'`).join(",");
  const script = [
    "$ErrorActionPreference='Continue';",
    `$files = @(${fileList});`,
    "foreach ($f in $files) {",
    "  $errs = $null;",
    "  [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$errs);",
    "  if ($errs -and $errs.Count -gt 0) {",
    "    $msg = ($errs | ForEach-Object { $_.Extent.StartLineNumber.ToString() + ':' + $_.Message }) -join ' | ';",
    "    'ERR|' + $f + '|' + $msg",
    "  } else { 'OK|' + $f }",
    "}",
  ].join(" ");
  const stdout = execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", timeout: 120_000, windowsHide: true },
  );
  const ok: string[] = [];
  const err: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("OK|")) ok.push(line.slice(3));
    else if (line.startsWith("ERR|")) err.push(line.slice(4));
  }
  return { ok, err };
}

describe("Windows PowerShell 脚本", () => {
  it.skipIf(process.platform !== "win32")("仓库里存在待体检的 .ps1", () => {
    expect(ps1Files.length).toBeGreaterThan(0);
  });

  it.skipIf(process.platform !== "win32")("全部 .ps1 都能被 PowerShell 解析（零错误）", () => {
    const { err } = parseAll(ps1Files);
    expect(err).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")("含非 ASCII 的 .ps1 必须带 UTF-8 BOM", () => {
    const missing: string[] = [];
    for (const file of ps1Files) {
      const buf = readFileSync(file);
      const nonAscii = buf.some((b) => b > 0x7f);
      if (!nonAscii) continue;
      const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
      if (!hasBom) missing.push(file);
    }
    expect(missing).toEqual([]);
  });

  it("采样器支持按镜像名匹配（测量可用改名副本避免被按名误杀）", () => {
    const sampler = readFileSync(join(ROOT, "scripts", "perf", "sampler.ps1"), "utf8");
    expect(sampler).toContain("$ProcessNamePattern");
    expect(sampler).toContain("-match $ProcessNamePattern");
  });
});
