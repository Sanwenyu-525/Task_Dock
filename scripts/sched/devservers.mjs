//! 开发服务器与常驻构建进程盘点（**只读**，绝不终止任何进程）。
//!
//! 解决的问题：`npm run tauri dev` 会再起一个 Vite、一个 cargo 编译、一个 tauri 应用进程；
//! 多个会话重复启动时会出现「同一个 Worktree 两套 Vite」「两个 Worktree 抢 5173 端口」
//! 「明明已经有一个 dev server 还在跑，又重新编译一次 Rust」。
//!
//! 判定依据（全部来自真实系统状态，不猜）：
//!   - 进程命令行里的绝对路径（`<workspace>/node_modules/...`）推断所属工作区；
//!   - `Get-NetTCPConnection -State Listen` 的真实监听端口；
//!   - 父子关系串起「npm → tauri cli → vite → esbuild」这一族。
//!
//! 兼容性判定：dev server 服务的是**本工作区**的源码与配置，跨 Worktree 复用等于把
//! 别人的代码暴露给你，因此不同工作区之间一律标记 incompatible，只提示手动确认。

import { listListeners, listProcesses } from "./proc.mjs";

const ROLES = [
  { role: "tauri-dev", test: (p) => /@tauri-apps[/\\]cli[/\\]tauri\.js"?\s+dev/.test(p.commandLine) },
  { role: "vite-dev", test: (p) => /vite[/\\]bin[/\\]vite\.js/.test(p.commandLine) },
  { role: "esbuild-service", test: (p) => /esbuild\.exe/i.test(p.name) && /--service/.test(p.commandLine) },
  { role: "tauri-app", test: (p) => /task-dock.*\.exe$/i.test(p.commandLine) || /target[/\\]debug[/\\]task-dock/i.test(p.commandLine) },
  { role: "cargo-build", test: (p) => /cargo\.exe$/i.test(p.name) && /build|test|check|clippy|run/.test(p.commandLine) },
  { role: "rustc", test: (p) => /rustc\.exe$/i.test(p.name) },
  { role: "npm-wrapper", test: (p) => /npm-cli\.js/.test(p.commandLine) },
];

const RELEVANT_NAMES = ["node.exe", "esbuild.exe", "cargo.exe", "rustc.exe", "task-dock.exe", "task_dock.exe"];

function classifyRole(p) {
  for (const r of ROLES) if (r.test(p)) return r.role;
  return null;
}

/** 从命令行里的绝对路径推断所属工作区（取最靠近 node_modules/src-tauri 的那一段）。 */
export function inferWorkspace(commandLine, { knownRoots = [] } = {}) {
  if (!commandLine) return null;
  const normalized = String(commandLine).replace(/\\/g, "/");
  const tokens = normalized.split(/\s+/).map((t) => t.replace(/^"|"$/g, "")).filter(Boolean);
  for (const tok of tokens) {
    const idx = tok.indexOf("/node_modules/");
    if (idx > 2) return tok.slice(0, idx);
  }
  for (const tok of tokens) {
    const idx = tok.indexOf("/src-tauri/");
    if (idx > 2) return tok.slice(0, idx);
  }
  for (const root of knownRoots) {
    const norm = String(root).replace(/\\/g, "/");
    if (tokens.some((t) => t.startsWith(norm))) return norm;
  }
  return null;
}

/**
 * 扫描开发服务器与常驻构建进程。
 * @returns {{ok:boolean, error?:string, rows:Array, findings:Array}}
 */
export function scanDevServers({ repoRoot, knownRoots = [] } = {}) {
  const procs = listProcesses({ names: RELEVANT_NAMES });
  if (!procs.ok) return { ok: false, error: procs.error ?? "进程枚举失败", rows: [], findings: [] };
  const listeners = listListeners();

  const portByPid = new Map();
  for (const l of listeners.rows ?? []) {
    if (!portByPid.has(l.pid)) portByPid.set(l.pid, []);
    portByPid.get(l.pid).push(l.port);
  }

  const all = procs.rows;
  const byPid = new Map(all.map((p) => [p.pid, p]));

  const rows = [];
  for (const p of all) {
    const role = classifyRole(p);
    if (!role) continue;
    const workspace = inferWorkspace(p.commandLine, { knownRoots });
    const ports = portByPid.get(p.pid) ?? [];
    // 向上追溯 3 层父进程，便于看清「npm run tauri dev → tauri → vite」这一族
    const chain = [];
    let cursor = p.parentPid;
    for (let i = 0; i < 3 && cursor; i++) {
      const parent = byPid.get(cursor);
      if (!parent) break;
      chain.push(`${parent.pid}:${parent.name}`);
      cursor = parent.parentPid;
    }
    rows.push({
      pid: p.pid,
      role,
      name: p.name,
      workspace,
      inRepo: workspace ? normEq(workspace, repoRoot) || knownRoots.some((r) => normEq(workspace, r)) : false,
      ports,
      commandLine: (p.commandLine ?? "").slice(0, 240),
      workingSetMb: p.workingSetBytes ? Math.round(p.workingSetBytes / (1024 * 1024)) : null,
      creationDate: p.creationDate ?? null,
      parentChain: chain,
    });
  }

  const findings = [];

  // npm 包装进程的命令行里没有绝对路径，从子进程继承工作区归属（父进程链已经记下来了）
  for (const r of rows) {
    if (r.workspace) continue;
    const child = rows.find((o) => o.pid !== r.pid && o.workspace &&
      o.parentChain.includes(`${r.pid}:${r.name}`));
    if (child) r.workspace = child.workspace;
  }

  // 1) 同一端口被多个 dev server 声明（实际只可能有一个在 Listen，另一个是启动失败前残留）
  const devRows = rows.filter((r) => r.role === "vite-dev" || r.role === "tauri-dev");
  for (const r of devRows) {
    for (const port of r.ports) {
      const others = devRows.filter((o) => o.pid !== r.pid && o.ports.includes(port));
      if (others.length) {
        findings.push({
          level: "conflict", code: "port-shared",
          text: `端口 ${port} 出现在多个开发服务器上：${[r, ...others].map((x) => `PID ${x.pid}(${x.workspace ?? "未知工作区"})`).join("、")}`,
          hint: "确认哪个是本工作区需要的实例，其余自行关闭；调度器不会代你终止进程",
        });
      }
    }
  }

  // 2) 同一工作区有多个 Vite dev server
  const viteByWorkspace = new Map();
  for (const r of rows.filter((x) => x.role === "vite-dev")) {
    const key = (r.workspace ?? "unknown").toLowerCase();
    if (!viteByWorkspace.has(key)) viteByWorkspace.set(key, []);
    viteByWorkspace.get(key).push(r);
  }
  for (const [ws, list] of viteByWorkspace) {
    if (list.length <= 1) continue;
    findings.push({
      level: "duplicate", code: "duplicate-vite",
      text: `工作区 ${ws} 有 ${list.length} 个 Vite dev server：${list.map((r) => `PID ${r.pid}${r.ports.length ? `@${r.ports.join(",")}` : ""}`).join("、")}`,
      hint: "复用其中一个即可；重复的实例会各占一份内存与文件监听句柄",
    });
  }

  // 3) Tauri dev 的 Rust 编译与独立 cargo 构建并行（最容易把 16GB 打满的组合）
  const cargoRows = rows.filter((r) => r.role === "cargo-build" || r.role === "rustc");
  const tauriRows = rows.filter((r) => r.role === "tauri-dev");
  if (tauriRows.length && cargoRows.length) {
    findings.push({
      level: "info", code: "dev-cargo-concurrent",
      text: `检测到 ${tauriRows.length} 个 tauri dev 与 ${cargoRows.length} 个 cargo/rustc 进程同时存在：dev server 的 Rust 增量编译会与独立构建抢内存`,
      hint: "独立重型构建请走调度器排队；dev server 的常驻占用已体现在可用内存读数中",
    });
  }

  // 4) 不同工作区共享同一端口 → 跨工作区错误复用风险
  for (const r of devRows) {
    for (const port of r.ports) {
      const other = devRows.find((o) => o.pid !== r.pid && o.ports.includes(port) &&
        o.workspace && r.workspace && !normEq(o.workspace, r.workspace));
      if (other) {
        findings.push({
          level: "conflict", code: "cross-worktree-port",
          text: `端口 ${port} 在 ${r.workspace} 与 ${other.workspace} 之间重复占用`,
          hint: "跨 Worktree 的 dev server 不可互相复用（源码与配置不同），必须各自用独立端口",
        });
      }
    }
  }

  return { ok: true, rows, findings, listenerError: listeners.ok ? null : listeners.error };
}

function normEq(a, b) {
  if (!a || !b) return false;
  return String(a).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() ===
    String(b).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** 是否同一族（同一 workspace 且同一 role）——仅用于展示「可复用」判断，不代做决定。 */
export function compatibilityGroup(row) {
  if (!row.workspace) return "unknown-workspace";
  return `${row.role}@${row.workspace.replace(/\\/g, "/").toLowerCase()}`;
}
