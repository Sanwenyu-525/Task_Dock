#!/usr/bin/env node
//! 候选包构建：唯一 CARGO_TARGET_DIR + 全程构建锁 + 安装包载荷一致性校验。
//!
//! 背景：共享 `target-integration` 被并行构建覆盖时，同一次 `tauri build` 产出的
//! NSIS 与 MSI 可能内嵌不同二进制（2026-11-24 候选包实测）。本脚本让候选包默认
//! 使用 `src-tauri/target-candidate-<时间戳>`，并在构建前后校验载荷。
//!
//! 用法：
//!   node scripts/build-candidate.mjs                     # 构建 + 校验
//!   node scripts/build-candidate.mjs --no-payload-check  # 只构建（仍写 hash）
//!   node scripts/build-candidate.mjs verify --dir <dir>  # 只校验已有候选目录
//!
//! NSIS 载荷无法在无 7-Zip 的机器上无副作用解包：默认跳过并标注 skipped；
//! 传 `--nsis-install-extract` 才用「静默安装到临时目录再卸载」的方式校验（会短暂写注册表/快捷方式）。

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = path.join(repoRoot, ".build-candidate.lock");

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function stampNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase();
}

/**
 * Tauri 在打包前会把 `__TAURI_BUNDLE_TYPE_VAR_<NSIS|MSI|UNK>` 后的 3 字节改成对应 bundle 类型，
 * 打包完成后磁盘上的 exe 又恢复为 `UNK`。因此不同安装包内嵌二进制的完整哈希必然不同，
 * 直接比较哈希会得到假阳性。这里只把那 3 字节归零后再算哈希，用于判断是否真的是不同构建。
 */
export function binaryFingerprint(file) {
  const buf = readFileSync(file);
  const marker = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_");
  // 二进制里可能有两处标记：编译期路径字符串 + 真正被 Tauri 改写的 3/4 字节槽位。
  // 只认后面紧跟 UNK / NSI(S) / MSI 的那一处；槽位连同后一个字节一起归零（5 字节），
  // 这样 UNK./MSI./NSISs 三种写法都会得到同一份归一化内容。
  let slot = -1;
  let bundleType = null;
  let index = buf.indexOf(marker);
  while (index >= 0) {
    const start = index + marker.length;
    const raw = buf.subarray(start, start + 6).toString("latin1");
    const match = /^(UNK|NSIS|NSI|MSI)/.exec(raw);
    if (match) {
      slot = start;
      bundleType = match[1];
      break;
    }
    index = buf.indexOf(marker, index + 1);
  }
  const normalized = Buffer.from(buf);
  if (slot >= 0) normalized.fill(0, slot, slot + 5);
  return {
    size: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex").toUpperCase(),
    neutral: createHash("sha256").update(normalized).digest("hex").toUpperCase(),
    bundleType,
  };
}

function sizeOf(file) {
  return statSync(file).size;
}

function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.error) throw r.error;
  return r;
}

/** 只比较忽略 bundle-type 标记后的指纹，不关心来源；供单测直接调用。 */
export function evaluatePayloads(expected, payloads) {
  const rows = payloads.map((p) => ({ ...p, matchesExpected: expected ? p.neutral === expected : null }));
  const extracted = rows.filter((r) => r.status === "extracted");
  const skipped = rows.filter((r) => r.status !== "extracted");
  const distinct = new Set(extracted.map((r) => r.neutral));
  // 只有一个载荷时无法证明「安装包之间一致」，只能证明它与记录值一致。
  const ok = extracted.length
    ? distinct.size <= 1 && (!expected || extracted.every((r) => r.matchesExpected))
    : !expected;
  const complete = skipped.length === 0 && extracted.length >= 2;
  return { ok, complete, expected: expected ?? null, distinct: distinct.size, extracted: extracted.length, skipped: skipped.length, payloads: rows };
}

function findOne(dir, predicate, recursive = false) {
  if (!existsSync(dir)) return null;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && predicate(entry.name)) return full;
    if (recursive && entry.isDirectory()) {
      const nested = findOne(full, predicate, true);
      if (nested) return nested;
    }
  }
  return null;
}

function findInstaller(dir, ext) {
  return findOne(dir, (name) => name.toLowerCase().endsWith(ext));
}

function sevenZip() {
  const candidates = [
    path.join(process.env.ProgramFiles ?? "C:/Program Files", "7-Zip", "7z.exe"),
    path.join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "7-Zip", "7z.exe"),
    "7z.exe",
    "7za.exe",
  ];
  for (const c of candidates) {
    const probe = spawnSync(c, ["i"], { stdio: "ignore" });
    if (probe.status === 0) return c;
  }
  return null;
}

function hasExistingInstall() {
  const keys = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  return keys.some((key) => {
    const r = spawnSync("reg", ["query", key, "/s", "/f", "Task Dock"], { encoding: "utf8", windowsHide: true });
    return r.status === 0 && /Task Dock/i.test(r.stdout ?? "");
  });
}

function extractNsis(installer, outDir, allowInstall) {
  if (!installer) return { source: "nsis", status: "missing" };
  const z = sevenZip();
  if (z) {
    const temp = path.join(outDir, ".payload-nsis-7z");
    rmSync(temp, { recursive: true, force: true });
    mkdirSync(temp, { recursive: true });
    const r = runSync(z, ["x", installer, `-o${temp}`, "-y"], { stdio: "pipe" });
    const exe = findOne(temp, (n) => n.toLowerCase() === "task-dock.exe", true);
    if (r.status === 0 && exe) {
      const info = binaryFingerprint(exe);
      rmSync(temp, { recursive: true, force: true });
      return { source: "nsis", status: "extracted", method: "7z", file: path.basename(installer), ...info };
    }
    rmSync(temp, { recursive: true, force: true });
    return { source: "nsis", status: "error", method: "7z", detail: (r.stderr || r.stdout || "").trim().slice(0, 400) };
  }
  if (!allowInstall) return { source: "nsis", status: "skipped", reason: "no-7zip（未传 --nsis-install-extract）" };
  if (hasExistingInstall() && !hasFlag("--force-nsis-install")) {
    return {
      source: "nsis",
      status: "skipped",
      reason: "检测到本机已安装 Task Dock，拒绝用静默安装方式解包（会覆盖或卸载真实安装）；仅在干净机器上用 --force-nsis-install",
    };
  }
  const temp = path.join(tmpdir(), `taskdock-nsis-${Date.now()}`);
  rmSync(temp, { recursive: true, force: true });
  const install = runSync(installer, ["/S", `/D=${temp}`]);
  const exe = path.join(temp, "task-dock.exe");
  const payload = existsSync(exe)
    ? { source: "nsis", status: "extracted", method: "install", file: path.basename(installer), ...binaryFingerprint(exe) }
    : { source: "nsis", status: "error", method: "install", detail: `安装后未找到 task-dock.exe（exit ${install.status}）` };
  const uninstaller = path.join(temp, "uninstall.exe");
  if (existsSync(uninstaller)) runSync(uninstaller, ["/S"], { stdio: "ignore" });
  rmSync(temp, { recursive: true, force: true });
  return payload;
}

function extractMsi(installer, outDir) {
  if (!installer) return { source: "msi", status: "missing" };
  const temp = path.join(outDir, ".payload-msi");
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  const r = runSync("msiexec.exe", ["/a", installer, "/qn", `TARGETDIR=${temp}`]);
  const exe = findOne(temp, (n) => n.toLowerCase() === "task-dock.exe", true);
  if (r.status === 0 && exe) {
    const info = binaryFingerprint(exe);
    rmSync(temp, { recursive: true, force: true });
    return { source: "msi", status: "extracted", method: "msiexec-admin", file: path.basename(installer), ...info };
  }
  rmSync(temp, { recursive: true, force: true });
  return { source: "msi", status: "error", method: "msiexec-admin", detail: (r.stderr || r.stdout || "").trim().slice(0, 400) || `exit ${r.status}` };
}

function candidateReport(dir, { allowInstall = false } = {}) {
  const nsis = findInstaller(dir, ".exe");
  const msi = findInstaller(dir, ".msi");
  if (!nsis || !msi) throw new Error(`候选目录缺少安装包：${dir}`);
  const sumsFile = path.join(dir, "SHA256SUMS.txt");
  const sums = existsSync(sumsFile) ? readFileSync(sumsFile, "utf8") : "";
  const verifySums = (file) => {
    const actual = sha256(file);
    const listed = sums
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+\*/))
      .find((parts) => parts[1] === path.basename(file));
    return { file: path.basename(file), sha256: actual, size: sizeOf(file), listed: listed ? listed[0] : null, matches: listed ? listed[0] === actual : null };
  };
  const installers = [verifySums(nsis), verifySums(msi)];
  const expectedFile = path.join(dir, "binary.json");
  const expectedBinary = existsSync(expectedFile) ? JSON.parse(readFileSync(expectedFile, "utf8")) : null;
  const expected = expectedBinary?.neutral ?? null;
  const payloads = [extractNsis(nsis, dir, allowInstall), extractMsi(msi, dir)];
  const verdict = evaluatePayloads(expected, payloads);
  const report = {
    dir,
    installers,
    expected,
    expectedBinary,
    payloads,
    verdict,
    checkedAt: new Date().toISOString(),
    installersIntegrityOk: installers.every((i) => i.matches !== false),
  };
  writeFileSync(path.join(dir, "payload-check.json"), JSON.stringify(report, null, 2));
  return report;
}

function printReport(report) {
  for (const i of report.installers) {
    console.log(`安装包 ${i.file}  ${i.size} 字节  SHA256=${i.sha256}${i.matches === false ? "  ✗ 与 SHA256SUMS 不一致" : i.matches ? "  ✓" : ""}`);
  }
  console.log(`期望二进制指纹（忽略 bundle 标记）：${report.expected ?? "（未记录）"}`);
  for (const p of report.payloads) {
    if (p.status === "extracted") {
      console.log(
        `载荷 ${p.source}（${p.method}）：${p.size} 字节  bundle=${p.bundleType ?? "?"}  ` +
          `指纹=${p.neutral}${p.neutral === report.expected ? "  ✓" : report.expected ? "  ✗" : ""}  （完整 SHA256 ${p.sha256}）`,
      );
    } else {
      console.log(`载荷 ${p.source}：${p.status}${p.reason ? `（${p.reason}）` : ""}${p.detail ? `：${p.detail}` : ""}`);
    }
  }
  console.log(
    report.verdict.ok
      ? report.verdict.complete
        ? "载荷校验通过：两个安装包内嵌二进制一致（已忽略 Tauri bundle-type 3 字节标记）"
        : `载荷校验部分完成：成功 ${report.verdict.extracted} 个、跳过 ${report.verdict.skipped} 个，未跳过的载荷与记录一致`
      : "载荷校验失败：安装包内二进制不一致或与记录不符",
  );
}

function writeBuildInfo({ outDir, targetDir, stamp, installers, payloads, verdict, payloadChecked, expectedBinary }) {
  const head = runSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).stdout?.trim() ?? "unknown";
  const dirty = runSync("git", ["status", "--porcelain"], { cwd: repoRoot }).stdout?.trim().split(/\r?\n/).filter(Boolean).length ?? 0;
  const rows = installers.map((i) => `| ${i.file} | ${i.size} | \`${i.sha256}\` |`).join("\n");
  const payloadRows = payloads
    .map((p) => `| ${p.source} | ${p.status} | ${p.method ?? "-"} | ${p.bundleType ?? "-"} | ${p.neutral ?? "-"} |`)
    .join("\n");
  const checkLine = payloadChecked
    ? verdict.ok
      ? verdict.complete
        ? "通过（NSIS + MSI 载荷均已解包且一致）"
        : `部分完成（跳过 ${verdict.skipped ?? 0} 个载荷，未跳过的与记录一致）`
      : "失败"
    : "未执行（--no-payload-check）";
  writeFileSync(
    path.join(outDir, "BUILD_INFO.md"),
    `# 候选包（${stamp}）\n\n` +
      `- 构建命令：\`node scripts/build-candidate.mjs\`\n` +
      `- HEAD：\`${head}\`（dirty ${dirty} 项）\n` +
      `- CARGO_TARGET_DIR：\`${targetDir}\`（每次构建独立，避免并行构建覆盖）\n` +
      `- 载荷校验：${checkLine}（NSIS skipped 仅表示本机无 7-Zip 且未启用安装解包）\n\n` +
      `## 产物\n\n| 文件 | 字节 | SHA256 |\n|---|---|---|\n${rows}\n\n` +
      `## 安装包载荷\n\n| 来源 | 状态 | 方法 | bundle 标记 | 指纹（忽略 bundle 标记） |\n|---|---|---|---|---|\n${payloadRows}\n\n` +
      `> 二进制指纹：\`${expectedBinary?.neutral ?? "未记录"}\`（完整 SHA256 \`${expectedBinary?.sha256 ?? "-"}\`，size ${expectedBinary?.size ?? "-"}）。\n` +
      `> Tauri 打包时会把 \`__TAURI_BUNDLE_TYPE_VAR_\` 后 3 字节改为 NSIS/MSI，因此完整哈希不同属正常；指纹只归零这 3 字节。\n\n` +
      `> 性质：候选包，不是正式集成 buildId；不可用于 \`integrate accept\`。\n`,
  );
}

function acquireLock(targetDir) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), targetDir }, null, 2), { flag: "wx" });
  } catch (e) {
    if (e.code === "EEXIST") {
      const owner = readFileSync(lockPath, "utf8");
      throw new Error(`已有候选构建在进行（${lockPath}）：\n${owner}\n确认无在跑构建后再删除该锁文件`);
    }
    throw e;
  }
}

function releaseLock() {
  try {
    unlinkSync(lockPath);
  } catch {
    /* 已被删除 */
  }
}

async function build() {
  const stamp = argValue("--label") ?? stampNow();
  const targetDir = path.resolve(argValue("--target-dir") ?? path.join(repoRoot, "src-tauri", `target-candidate-${stamp}`));
  const outDir = path.join(repoRoot, "tmp", "release-candidate", stamp);
  mkdirSync(outDir, { recursive: true });

  console.log(`候选包输出：${outDir}`);
  console.log(`独立 CARGO_TARGET_DIR：${targetDir}`);
  acquireLock(targetDir);
  try {
    const precheck = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "build-guard.mjs"), "precheck"], { stdio: "inherit" });
    if (precheck.status !== 0) throw new Error("build-guard precheck 未通过");

    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    /* Windows 下 .cmd 不能直接 spawn（EINVAL），必须经 shell 解析；参数均为无空格常量。 */
    const child = spawn(npmCmd, ["run", "tauri:raw", "--", "build"], {
      cwd: repoRoot,
      env: { ...process.env, CARGO_TARGET_DIR: targetDir },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true,
    });
    const logPath = path.join(outDir, "build.log");
    writeFileSync(logPath, "");
    const tee = (chunk) => {
      process.stdout.write(chunk);
      writeFileSync(logPath, chunk, { flag: "a" });
    };
    child.stdout.on("data", tee);
    child.stderr.on("data", tee);
    const exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
    if (exitCode !== 0) throw new Error(`tauri build 失败（exit ${exitCode}），日志：${logPath}`);

    const exe = path.join(targetDir, "release", "task-dock.exe");
    if (!existsSync(exe)) throw new Error(`未找到构建产物：${exe}`);
    const binary = binaryFingerprint(exe);
    writeFileSync(path.join(outDir, "binary.json"), JSON.stringify({ file: "task-dock.exe", ...binary }, null, 2));
    writeFileSync(path.join(outDir, "binary.sha256"), `${binary.sha256}  task-dock.exe\n`);
    console.log(`构建二进制：${binary.size} 字节  bundle=${binary.bundleType ?? "?"}  指纹=${binary.neutral}  完整 SHA256=${binary.sha256}`);

    const nsis = findInstaller(path.join(targetDir, "release", "bundle", "nsis"), ".exe");
    const msi = findInstaller(path.join(targetDir, "release", "bundle", "msi"), ".msi");
    for (const file of [nsis, msi]) {
      if (file) copyFileSync(file, path.join(outDir, path.basename(file)));
    }
    if (!nsis || !msi) throw new Error("未找到 NSIS/MSI 安装包");
    writeFileSync(
      path.join(outDir, "SHA256SUMS.txt"),
      `${sha256(nsis)} *${path.basename(nsis)}\n${sha256(msi)} *${path.basename(msi)}\n`,
    );

    let report = null;
    if (!hasFlag("--no-payload-check")) {
      report = candidateReport(outDir, { allowInstall: hasFlag("--nsis-install-extract") });
      printReport(report);
      if (report.verdict.ok && !report.verdict.complete) {
        console.warn("注意：载荷校验部分完成，未解包的安装包内嵌二进制没有被直接验证（结构上已由独立 target 目录 + 构建锁保证）");
      }
    }
    const verdict = report?.verdict ?? { ok: true };
    writeBuildInfo({
      outDir,
      targetDir,
      stamp,
      installers: [nsis, msi].map((file) => ({ file: path.basename(file), sha256: sha256(file), size: sizeOf(file) })),
      payloads: report?.payloads ?? [],
      verdict,
      payloadChecked: Boolean(report),
      expectedBinary: binary,
    });
    if (report && !report.verdict.ok) {
      console.error("候选包载荷不一致：拒绝把该目录当作可验收候选包");
      return 2;
    }
    console.log(`候选包完成：${outDir}`);
    return 0;
  } finally {
    releaseLock();
  }
}

function verifyMode() {
  const dir = path.resolve(argValue("--dir") ?? path.join(repoRoot, "tmp", "release-candidate", "latest"));
  const report = candidateReport(dir, { allowInstall: hasFlag("--nsis-install-extract") });
  printReport(report);
  if (!report.installersIntegrityOk) {
    console.error("安装包 SHA256 与 SHA256SUMS.txt 不一致");
    return 2;
  }
  if (report.payloads.some((p) => p.status === "skipped")) {
    console.log("提示：NSIS 载荷未解包校验（缺 7-Zip）；如需完整校验加 --nsis-install-extract");
  }
  return report.verdict.ok ? 0 : 2;
}

function fingerprintMode() {
  const file = argValue("--file");
  if (!file) throw new Error("fingerprint 模式需要 --file <exe>");
  const info = binaryFingerprint(path.resolve(file));
  const out = argValue("--out");
  if (out) writeFileSync(path.resolve(out), JSON.stringify({ file: path.basename(file), ...info }, null, 2));
  console.log(JSON.stringify(info, null, 2));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] === "verify" ? "verify" : process.argv[2] === "fingerprint" ? "fingerprint" : "build";
  try {
    process.exit(mode === "verify" ? verifyMode() : mode === "fingerprint" ? fingerprintMode() : await build());
  } catch (e) {
    console.error(`失败：${e.stack ?? e.message}`);
    process.exit(1);
  }
}
