/**
 * `npm run tauri` 入口：dev 请求先复用本仓库已运行的调试实例，其他情况直接执行 Tauri CLI。
 * 仅匹配本仓库的调试程序路径，避免误唤醒正式安装版；不会终止已有进程。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const TAURI_CLI = path.join(REPO_ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js");
/** 调试程序的默认位置；设置绝对 `CARGO_TARGET_DIR` 时以它为根（与 cargo 一致）。 */
const DEFAULT_TARGET_DIR = path.join(REPO_ROOT, "src-tauri", "target");
const DEBUG_EXE_NAME = "task-dock.exe";

function debugTargetDir() {
  const override = process.env.CARGO_TARGET_DIR;
  if (override) {
    if (path.isAbsolute(override)) return override;
    // 相对路径会随 cwd 漂移（历史事故见 docs/DEVELOPMENT.md），这里按 cargo 的实际
    // 调用目录（src-tauri）解析，而不是静默忽略。
    return path.resolve(REPO_ROOT, "src-tauri", override);
  }
  return DEFAULT_TARGET_DIR;
}

const DEBUG_EXE = path.join(debugTargetDir(), "debug", DEBUG_EXE_NAME);

/** 唤醒等待上限：第二实例在单实例回调后应在一秒内退出，20s 只是防挂死。 */
const WAKE_TIMEOUT_MS = 20_000;

/**
 * 解析 `Get-Process ... "$($_.Id)|$($_.Path)"` 的输出为 { pid, path } 列表。
 * 纯函数：便于单测（不依赖本机是否真的跑着 TaskDock）。
 */
export function parseProcessList(stdout) {
  const rows = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf("|");
    if (sep <= 0) continue;
    const pid = Number(trimmed.slice(0, sep));
    const exePath = trimmed.slice(sep + 1).trim();
    if (!Number.isInteger(pid) || pid <= 0 || !exePath) continue;
    rows.push({ pid, path: exePath });
  }
  return rows;
}

/** 该进程是否就是本仓库的调试程序（大小写与分隔符不敏感）。 */
export function isOwnDebugExe(candidate, debugExe = DEBUG_EXE) {
  if (!candidate) return false;
  const normalize = (value) => path.resolve(value).replace(/\\/g, "/").toLowerCase();
  return normalize(candidate) === normalize(debugExe);
}

/** 正在运行的本仓库调试程序（没有则 null）。只读探测，不改任何状态。 */
function findRunningDebugApp() {
  if (process.platform !== "win32") return null;
  if (!existsSync(DEBUG_EXE)) return null;
  const script =
    'Get-Process -Name task-dock -ErrorAction SilentlyContinue | ' +
    'ForEach-Object { "$($_.Id)|$($_.Path)" }';
  const probe = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 15_000 },
  );
  if (probe.error) {
    if (process.env.TASKDOCK_DEV_LAUNCH_DEBUG === "1") {
      console.error(`[dev-launch] 进程探测失败，按未运行处理：${probe.error.message}`);
    }
    return null;
  }
  const running = parseProcessList(probe.stdout).find((row) => isOwnDebugExe(row.path));
  return running ?? null;
}

/** 唤醒已运行的调试实例：再启动一次同一个 exe，由单实例回调聚焦工作台后退出。 */
function wakeRunningInstance(running) {
  const wake = spawnSync(DEBUG_EXE, [], {
    stdio: "ignore",
    windowsHide: true,
    timeout: WAKE_TIMEOUT_MS,
  });
  if (wake.error) {
    console.error(`已发现开发实例（PID ${running.pid}），但唤醒失败：${wake.error.message}`);
    console.error("请手动点任务栏的「Task Dock · 工作台」，或关闭该实例后重新执行 npm run tauri dev。");
    return 1;
  }
  console.log(
    `已唤醒运行中的开发实例（PID ${running.pid}，${running.path}）：大型工作台已聚焦。`,
  );
  console.log("本次没有启动第二个实例，也没有重新初始化业务服务。");
  return 0;
}

/** 直接执行本地 Tauri CLI，参数按数组原样传递。 */
function runTauri(tailArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TAURI_CLI, ...tailArgs], {
      stdio: "inherit", cwd: REPO_ROOT, windowsHide: false,
    });
    child.on("error", (error) => {
      console.error(`[dev-launch] 无法启动 Tauri CLI：${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

async function main(argv) {
  const isDev = argv[0] === "dev";
  if (isDev) {
    const running = findRunningDebugApp();
    if (running) {
      process.exit(wakeRunningInstance(running));
    }
  }
  const code = await runTauri(argv);
  process.exit(code);
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  void main(process.argv.slice(2));
}
