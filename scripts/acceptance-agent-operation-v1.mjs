/**
 * Agent 操作可视化 v1.0 · Dev 功能验收（场景 A–G，真实 Tauri 窗口）。
 *
 * 用法：node scripts/acceptance-agent-operation-v1.mjs [--keep]
 *
 * 隔离保证：
 * - 每次运行使用 tmp/acceptance/agent-operation-visualization/run-<stamp>/；
 * - TASK_DOCK_DATA_DIR / WEBVIEW2_USER_DATA_FOLDER 均指向该目录；
 * - REST 端口 17931 起、CDP 端口 17981 起自动探测；
 * - 只操作自建隔离库，不读写真实用户数据。
 *
 * 说明：脚本通过 CDP 驱动真实 WebView2；页面内只调用**既有 store 动作**
 * （setTab / openEditor），不直接写业务数据。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { attachMainWindow } from "./acceptance/cdp-main-window.mjs";

const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const ONLY = (argv.find((a) => a.startsWith("--only=")) ?? "").replace("--only=", "");
const REPO = path.resolve(".");
const BIN = path.join(REPO, "src-tauri", "target", "debug");
const EXE = path.join(BIN, "task-dock.exe");
const CLI = path.join(BIN, "taskdock.exe");
const stamp = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
})();
const ROOT = path.join(REPO, "tmp", "acceptance", "agent-operation-visualization", `run-${stamp}`);
const DATA = path.join(ROOT, "data");
const DB_PATH = path.join(DATA, "task-dock.db");
const LOG_PATH = path.join(ROOT, "acceptance.log");
const SUMMARY = path.join(ROOT, "summary.md");

const PROJECT = "op-vis-project";
const TASK_TITLE = "验收任务（操作可视化）";
const TOKENS = { codex: "tdm_op_codex", claude: "tdm_op_claude" };

const results = [];
const logLines = [];
let gui = null;
let CDP_PORT = 0;
let REST_PORT = 0;
let browser = null;
let page = null;
let mainPage = null;
let workbenchPage = null;

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  logLines.push(line);
  console.log(line);
}

function record(name, ok, detail = "") {
  results.push({ name, ok, detail, at: new Date().toISOString() });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function step(name, fn) {
  try {
    const detail = await fn();
    return record(name, true, detail ?? "");
  } catch (err) {
    // 失败现场必须可复核：截图 + 可见文本 + 关键选择器计数。
    const slug = name.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40);
    try {
      if (page) {
        await page.screenshot({ path: path.join(ROOT, `FAIL-${slug}.png`) });
        const dump = await page.evaluate(() => ({
          body: document.body.innerText.slice(0, 1200),
          seg: document.querySelectorAll("button.seg-btn").length,
          planning: document.querySelectorAll(".planning-workspace").length,
          tasks: document.querySelectorAll("[data-task-id]").length,
        }));
        fs.writeFileSync(path.join(ROOT, `FAIL-${slug}.json`), JSON.stringify(dump, null, 2));
      }
    } catch {
      /* 诊断失败不掩盖原始错误 */
    }
    return record(name, false, `异常：${err && err.stack ? err.stack.split("\n")[0] : err}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// ── 进程 / HTTP / DB ─────────────────────────────────────────────
function runSync(cmd, args, { env = {}, timeout = 120000 } = {}) {
  return spawnSync(cmd, args, {
    cwd: REPO,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
}

function cli(args, { token = "", expectFail = false } = {}) {
  const res = runSync(CLI, [...args, "--json"], {
    env: {
      TASK_DOCK_DATA_DIR: DATA,
      WEBVIEW2_USER_DATA_FOLDER: DATA,
      TASKDOCK_DB_PATH: DB_PATH,
      TASKDOCK_AGENT_TOKEN: token,
    },
  });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    /* 非 JSON */
  }
  if (!expectFail && res.status !== 0) {
    throw new Error(`CLI 失败(${res.status}): ${res.stderr || res.stdout}`.slice(0, 400));
  }
  return { status: res.status, json, stderr: res.stderr, stdout: res.stdout };
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function withDb(fn) {
  const db = new DatabaseSync(DB_PATH);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function dbAll(sql, ...params) {
  return withDb((db) => db.prepare(sql).all(...params));
}

function dbGet(sql, ...params) {
  return withDb((db) => db.prepare(sql).get(...params) ?? null);
}

function dbRun(sql, ...params) {
  return withDb((db) => db.prepare(sql).run(...params));
}

function opsOf(kind, id) {
  return dbAll(
    `SELECT id, agent_id, interface, action, status, phase, resource_kind, resource_id,
            revision, error_code, detail, started_at, finished_at
       FROM agent_operations
      WHERE resource_kind = ? AND resource_id = ?
      ORDER BY started_at ASC`,
    kind,
    id,
  );
}

function freePort(start) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      const srv = net.createServer();
      srv.once("error", () => (p > start + 80 ? reject(new Error("无空闲端口")) : tryPort(p + 1)));
      srv.once("listening", () => srv.close(() => resolve(p)));
      srv.listen(p, "127.0.0.1");
    };
    tryPort(start);
  });
}

function waitPortClosed(port, ms) {
  return (async () => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const open = await new Promise((resolve) => {
        const sock = net.connect({ port, host: "127.0.0.1" });
        const done = (v) => {
          sock.destroy();
          resolve(v);
        };
        sock.once("connect", () => done(true));
        sock.once("error", () => done(false));
        setTimeout(() => done(false), 400);
      });
      if (!open) return true;
      await sleep(250);
    }
    return false;
  })();
}

function waitFile(p, ms) {
  const end = Date.now() + ms;
  return (async () => {
    while (Date.now() < end) {
      if (fs.existsSync(p)) return true;
      await sleep(200);
    }
    return false;
  })();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitHttp(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/status`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.status >= 200 && res.status < 500) return true;
    } catch {
      /* 尚未就绪 */
    }
    await sleep(300);
  }
  return false;
}

async function waitFor(fn, ms, interval = 150) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  return null;
}

// ── MCP stdio ────────────────────────────────────────────────────
function mcpSession(token) {
  const proc = spawn(EXE, ["--mcp-server"], {
    env: {
      ...process.env,
      TASK_DOCK_DATA_DIR: DATA,
      WEBVIEW2_USER_DATA_FOLDER: DATA,
      TASKDOCK_MCP_TOKEN: token,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map();
  let buffer = "";
  let nextId = 1;
  let stderr = "";
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  proc.stderr.on("data", (c) => {
    stderr += c.toString("utf8");
  });
  function request(method, params, timeoutMs = 25000) {
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ timeout: true, stderr });
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  async function open() {
    const init = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "acceptance-op-v1", version: "1" },
    });
    if (!init?.result?.protocolVersion) throw new Error(`MCP initialize 失败: ${JSON.stringify(init).slice(0, 200)}`);
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  }
  function callTool(name, args) {
    return request("tools/call", { name, arguments: args });
  }
  function close() {
    try {
      proc.stdin.end();
    } catch {
      /* 忽略 */
    }
    try {
      proc.kill();
    } catch {
      /* 忽略 */
    }
  }
  return {
    open,
    callTool,
    close,
    get stderr() {
      return stderr;
    },
  };
}

function toolPayload(msg) {
  const text = msg?.result?.content?.find((c) => c.type === "text")?.text;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── GUI / CDP ────────────────────────────────────────────────────
async function launchGui() {
  fs.mkdirSync(DATA, { recursive: true });
  // 重启场景：旧 WebView2 的 CDP 端点可能短暂残留，直接复用会连到正在退出的旧目标。
  if (!(await waitPortClosed(CDP_PORT, 8000))) {
    CDP_PORT = await freePort(CDP_PORT + 1);
    log(`旧 CDP 端口未释放，改用 ${CDP_PORT}`);
  }
  const out = fs.openSync(path.join(ROOT, "gui.log"), "a");
  const err = fs.openSync(path.join(ROOT, "gui.err"), "a");
  gui = spawn(EXE, [], {
    env: {
      ...process.env,
      TASK_DOCK_DATA_DIR: DATA,
      WEBVIEW2_USER_DATA_FOLDER: DATA,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: ["ignore", out, err],
    windowsHide: true,
  });
  log(`GUI pid=${gui.pid} cdp=${CDP_PORT}`);

  const ok = await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, {
        signal: AbortSignal.timeout(1200),
      });
      return res.ok;
    } catch {
      return false;
    }
  }, 60000, 400);
  if (!ok) throw new Error("CDP 端点未就绪");
}

async function attachPage() {
  if (browser) await browser.close().catch(() => {});
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: 20000 });
  const picked = await attachMainWindow({
    port: CDP_PORT,
    deadlineMs: 60000,
    intervalMs: 300,
    probe: async (info) => {
      const p = browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((x) => !x.url().startsWith("devtools://") && x.url() === info.url);
      if (!p) throw new Error(`no page for ${info.url}`);
      return p.evaluate(() => {
        const meta = window.__TAURI_INTERNALS__?.metadata;
        return {
          label: meta?.currentWindow?.label ?? null,
          webviewLabel: meta?.currentWebview?.label ?? null,
          tauri: typeof window.__TAURI_INTERNALS__?.invoke === "function",
          mounted: (document.querySelector("#root")?.childElementCount ?? 0) > 0,
        };
      });
    },
  });
  if (!picked.ok) throw new Error(picked.reason);
  page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url() === picked.target.url);
  if (!page) throw new Error("主窗口页面未找到");
  mainPage = page;
  await page.waitForTimeout(1200);
}

/**
 * 规划中心只在统一工作台窗口提供完整界面（主窗口是移交占位）。
 * 通过公开的 openWorkbench 打开并切到「规划编辑」，后续断言都针对工作台页面。
 */
async function openWorkbenchPlanning() {
  let opened = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // 不传 projectId：该参数校验的是「项目工作空间」，与规划项目不是同一实体。
    opened = await mainPage.evaluate(async () => {
      const m = await import("/src/lib/workbenchNav.ts");
      const outcome = await m.openWorkbench({ tab: "roadmap" });
      return { status: outcome.status, error: outcome.error, created: outcome.created };
    });
    if (opened.status === "succeeded") break;
    await sleep(2500);
  }
  if (opened.status !== "succeeded") {
    throw new Error(`打开工作台失败: ${JSON.stringify(opened)}`);
  }
  const ws = await waitFor(
    async () =>
      browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().includes("workspace.html")) ?? null,
    20000,
    300,
  );
  if (!ws) throw new Error("工作台窗口未出现");
  workbenchPage = ws;
  page = ws;
  await page.waitForTimeout(1500);
  const seg = page.locator("button.seg-btn", { hasText: "规划编辑" }).first();
  if ((await seg.count()) === 0) throw new Error("工作台缺少「规划编辑」入口");
  await seg.click();
  await page.waitForSelector(".planning-workspace", { timeout: 20000 });
  // 默认落在「项目总览」，功能卡片只在「功能列表」视图渲染。
  const listTab = page.getByRole("tab", { name: "功能列表" }).first();
  if (await listTab.count()) {
    await listTab.click();
    await page.waitForTimeout(900);
  }
  await page.waitForTimeout(900);
}

/** 回到主窗口（任务页/编辑器场景）。 */
async function useMainWindow() {
  page = mainPage;
  await page.waitForTimeout(300);
}

async function skipOnboarding() {
  const skip = page.getByRole("button", { name: "跳过引导" });
  if (await skip.count()) {
    await skip.first().click();
    await page.waitForTimeout(400);
  }
}

async function setTab(tab) {
  await page.evaluate(async (t) => {
    const m = await import("/src/store/useUiStore.ts");
    m.useUiStore.getState().setTab(t);
  }, tab);
  await page.waitForTimeout(700);
}

async function openPlanningEditor() {
  await setTab("roadmap");
  const seg = page.locator("button.seg-btn", { hasText: "规划编辑" }).first();
  if ((await seg.count()) === 0) {
    const info = await page.evaluate(() => ({
      tab: document.querySelector(".rail-item.active")?.getAttribute("aria-label"),
      body: document.body.innerText.slice(0, 600),
    }));
    throw new Error(`未找到「规划编辑」分段按钮（当前=${info.tab}）: ${info.body.replace(/\n/g, " | ").slice(0, 300)}`);
  }
  await seg.click();
  await page.waitForSelector(".planning-workspace", { timeout: 15000 });
  await page.waitForTimeout(800);
}

async function shot(name) {
  await page.screenshot({ path: path.join(ROOT, `${name}.png`) });
}

/** 资源宿主的操作徽标快照（不依赖具体业务类名，只看 data 属性 + 统一徽标）。 */
async function chipSnapshot(selector) {
  return page.evaluate((sel) => {
    const hosts = Array.from(document.querySelectorAll(sel));
    return hosts.map((host) => ({
      id: host.getAttribute("data-task-id") || host.getAttribute("data-feature-id") || "",
      surface: host.getAttribute("data-agent-op"),
      className: String(host.className || ""),
      chips: Array.from(host.querySelectorAll(".agent-op-chip")).map((c) => c.textContent.trim()),
    }));
  }, selector);
}

async function storeSnapshot() {
  return page.evaluate(async () => {
    // 优先用应用自身的实例（DEV 句柄）；动态 import 在 HMR 后可能是第二个实例。
    const handle = window.__AGENT_OP_STORE__;
    const s = handle
      ? handle.getState()
      : (await import("/src/store/useAgentOperationsStore.ts")).useAgentOperationsStore.getState();
    return {
      active: s.active.map((o) => ({ id: o.id, agent: o.agentId, status: o.status, resource: o.resourceId })),
      recent: s.recent.map((o) => ({ id: o.id, agent: o.agentId, status: o.status, error: o.errorCode, resource: o.resourceId })),
      activeCount: s.activeCount,
      subscribed: s.subscribed,
      lastSyncAt: s.lastSyncAt,
      cursor: s.cursor,
      error: s.error,
    };
  });
}

// ── 种子 ─────────────────────────────────────────────────────────
function seed() {
  const now = new Date().toISOString();
  dbRun(
    `INSERT OR REPLACE INTO planning_projects
       (id, name, description, status, archived, target_date, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, 'planning', 0, NULL, 1, ?, ?)`,
    PROJECT,
    "操作可视化验收项目",
    "隔离验收项目",
    now,
    now,
  );
  for (const [rowId, agentId, token] of [
    ["op-agent-codex", "codex", TOKENS.codex],
    ["op-agent-claude", "claude", TOKENS.claude],
  ]) {
    dbRun(
      `INSERT OR REPLACE INTO mcp_agents
         (id, agent_id, display_name, token_hash, scope, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'project_rw', ?, ?)`,
      rowId,
      agentId,
      agentId,
      sha256(token),
      now,
      now,
    );
    dbRun(
      `INSERT OR REPLACE INTO mcp_agent_grants (id, agent_row_id, project_id, created_at)
       VALUES (?, ?, ?, ?)`,
      crypto.randomUUID(),
      rowId,
      PROJECT,
      now,
    );
    for (const cap of ["tasks.read", "tasks.write", "plans.read", "projects.read", "knowledge.read"]) {
      dbRun(
        `INSERT OR REPLACE INTO mcp_agent_capabilities
           (id, agent_row_id, capability, resource_id, created_at)
         VALUES (?, ?, ?, '', ?)`,
        crypto.randomUUID(),
        rowId,
        cap,
        now,
      );
    }
  }
  const settings = {
    agent_api_enabled: "true",
    agent_api_port: String(REST_PORT),
    mcp_server_enabled: "true",
    agent_workspace_watch_enabled: "false",
  };
  for (const [key, value] of Object.entries(settings)) {
    dbRun(
      "INSERT OR REPLACE INTO application_settings (key, value, updated_at) VALUES (?, ?, ?)",
      key,
      value,
      now,
    );
  }
}

// ── 场景 ─────────────────────────────────────────────────────────
async function scenarioA() {
  await openWorkbenchPlanning();
  const mcp = mcpSession(TOKENS.codex);
  try {
    await mcp.open();
    const msg = await mcp.callTool("taskdock_create_feature", {
      project_id: PROJECT,
      title: "A · Codex 新建的功能",
      description: "验收场景 A",
      requestId: `a-${Date.now()}`,
    });
    const payload = toolPayload(msg);
    assert(payload && !payload.error, `创建失败: ${JSON.stringify(payload).slice(0, 200)}`);
    const featureId = payload.id;
    assert(featureId, "返回缺少功能 ID");

    const chips = await waitFor(async () => {
      const snap = await chipSnapshot(`[data-feature-id="${featureId}"]`);
      return snap.length && snap[0].chips.length ? snap[0] : null;
    }, 6000);
    await shot("A-feature-highlight");

    const ops = opsOf("feature", featureId);
    const op = ops[ops.length - 1];
    assert(op, "数据库没有对应操作记录");
    assert(op.status === "committed", `操作状态=${op.status}`);
    assert(op.interface === "mcp", `interface=${op.interface}`);
    assert(op.agent_id === "codex", `agent=${op.agent_id}`);
    assert(chips, "功能卡片上未出现操作徽标");
    return `feature=${featureId} chips=${JSON.stringify(chips.chips)} op=${op.status}`;
  } finally {
    mcp.close();
  }
}

async function scenarioB(taskId) {
  await useMainWindow();
  await setTab("tasks");
  await page.waitForSelector(`[data-task-id="${taskId}"]`, { timeout: 15000 });
  const before = dbGet("SELECT updated_at FROM tasks WHERE id = ?", taskId);
  const mcp = mcpSession(TOKENS.claude);
  try {
    await mcp.open();
    const msg = await mcp.callTool("taskdock_update_task", {
      task_id: taskId,
      expected_updated_at: before.updated_at,
      title: "B · Claude 修改后的任务",
      requestId: `b-${Date.now()}`,
    });
    const payload = toolPayload(msg);
    assert(payload && !payload.error, `更新失败: ${JSON.stringify(payload).slice(0, 200)}`);

    const chip = await waitFor(async () => {
      const snap = await chipSnapshot(`[data-task-id="${taskId}"]`);
      return snap.length && snap[0].chips.length ? snap[0] : null;
    }, 6000);
    const title = await waitFor(async () => {
      const text = await page.locator(`[data-task-id="${taskId}"] .task-title`).innerText();
      return text.includes("Claude") ? text : null;
    }, 8000);
    await shot("B-task-highlight");

    const ops = opsOf("task", taskId);
    const op = ops[ops.length - 1];
    assert(op && op.status === "committed" && op.interface === "mcp", `op=${JSON.stringify(op)}`);
    assert(chip, "任务行未出现操作徽标");
    assert(title, "列表未自动刷新为远端标题");
    return `chips=${JSON.stringify(chip.chips)} title=${title}`;
  } finally {
    mcp.close();
  }
}

async function scenarioC(taskId) {
  const current = dbGet("SELECT updated_at FROM tasks WHERE id = ?", taskId);
  const codex = mcpSession(TOKENS.codex);
  const claude = mcpSession(TOKENS.claude);
  try {
    await codex.open();
    await claude.open();
    const okMsg = await codex.callTool("taskdock_update_task", {
      task_id: taskId,
      expected_updated_at: current.updated_at,
      title: "C · Codex 先写成功",
      requestId: `c-ok-${Date.now()}`,
    });
    const okPayload = toolPayload(okMsg);
    assert(okPayload && !okPayload.error, `codex 更新应成功: ${JSON.stringify(okPayload).slice(0, 200)}`);

    // 第二个 Agent 用同一旧基线 → 必须冲突，不能也显示成功。
    const badMsg = await claude.callTool("taskdock_update_task", {
      task_id: taskId,
      expected_updated_at: current.updated_at,
      title: "C · Claude 过期基线",
      requestId: `c-bad-${Date.now()}`,
    });
    const badPayload = toolPayload(badMsg);
    assert(badPayload && badPayload.error === "CONFLICT", `应为 CONFLICT，实际=${JSON.stringify(badPayload).slice(0, 200)}`);

    const snap = await waitFor(async () => {
      const s = await chipSnapshot(`[data-task-id="${taskId}"]`);
      return s.length && s[0].chips.length >= 2 ? s[0] : null;
    }, 6000);
    await shot("C-two-agents");

    const ops = opsOf("task", taskId).slice(-2);
    const committed = ops.filter((o) => o.status === "committed");
    const conflicted = ops.filter((o) => o.status === "conflict");
    assert(committed.length === 1, `committed=${committed.length}`);
    assert(conflicted.length === 1, `conflict=${conflicted.length}`);
    assert(snap, `任务行未同时显示两个主体: ${JSON.stringify(snap)}`);
    const hasConflictChip = snap.chips.some((c) => c.includes("冲突"));
    assert(hasConflictChip, `未显示冲突状态: ${JSON.stringify(snap.chips)}`);
    return `chips=${JSON.stringify(snap.chips)} ops=${ops.map((o) => `${o.agent_id}:${o.status}`).join(",")}`;
  } finally {
    codex.close();
    claude.close();
  }
}

async function scenarioD(taskId) {
  const before = dbGet("SELECT updated_at FROM tasks WHERE id = ?", taskId);
  const res = cli(["task", "update", taskId, "--title", "D · CLI 修改的任务"], {
    token: TOKENS.codex,
  });
  assert(res.status === 0, `CLI 失败: ${res.stderr}`);

  const title = await waitFor(async () => {
    const text = await page.locator(`[data-task-id="${taskId}"] .task-title`).innerText().catch(() => "");
    return text.includes("CLI") ? text : null;
  }, 14000);
  await shot("D-cli-visible");

  const after = dbGet("SELECT updated_at FROM tasks WHERE id = ?", taskId);
  const op = dbGet(
    `SELECT agent_id, interface, status FROM agent_operations
      WHERE resource_kind='task' AND resource_id=? ORDER BY started_at DESC LIMIT 1`,
    taskId,
  );
  assert(after.updated_at !== before.updated_at, "CLI 未写入任务");
  assert(op && op.interface === "cli" && op.status === "committed", `op=${JSON.stringify(op)}`);
  assert(title, "UI 未在无手动刷新下感知 CLI 写入");
  return `title=${title} op=${op.agent_id}/${op.interface}/${op.status}`;
}

async function scenarioE(taskId) {
  await stopGui();
  const res = cli(["task", "update", taskId, "--title", "E · UI 关闭时写入"], {
    token: TOKENS.codex,
  });
  assert(res.status === 0, `CLI 失败: ${res.stderr}`);

  await launchGui();
  await attachPage();
  await skipOnboarding();
  await setTab("tasks");
  await page.waitForSelector(`[data-task-id="${taskId}"]`, { timeout: 20000 });
  const text = await page.locator(`[data-task-id="${taskId}"] .task-title`).innerText();
  assert(text.includes("E · UI 关闭时写入"), `恢复后标题=${text}`);

  // 启动恢复是异步的（首轮游标同步）：等历史真正到达，而不是立刻取样。
  const snap = await waitFor(async () => {
    const s = await storeSnapshot();
    return s.recent.some((o) => o.resource === taskId && o.status === "committed") ? s : null;
  }, 12000, 300);
  if (!snap) {
    const diag = await storeSnapshot();
    log(`E diag: ${JSON.stringify(diag)}`);
    const raw = await page.evaluate(async () => {
      try {
        const r = await window.__TAURI_INTERNALS__.invoke("agent_operations_sync", { cursor: null, limit: 50 });
        return { ok: true, count: r?.operations?.length ?? -1, cursor: r?.cursor ?? null, active: r?.activeCount ?? -1 };
      } catch (err) {
        return { ok: false, error: String(err && err.message ? err.message : err) };
      }
    });
    log(`E invoke diag: ${JSON.stringify(raw)}`);
    const manual = await page.evaluate(async () => {
      const m = await import("/src/store/useAgentOperationsStore.ts");
      m.ensureAgentOperationSync();
      await new Promise((r) => setTimeout(r, 2500));
      const s = m.useAgentOperationsStore.getState();
      return { subscribed: s.subscribed, error: s.error, recent: s.recent.length, lastSyncAt: s.lastSyncAt, cursor: s.cursor };
    });
    log(`E manual diag: ${JSON.stringify(manual)}`);
    const boot = await page.evaluate(() => (window).__AGENT_OP_BOOT__ ?? null);
    log(`E boot marker: ${JSON.stringify(boot)}`);
  }
  assert(snap, "启动恢复后最近操作仍未包含该任务");
  const op = dbGet(
    `SELECT status FROM agent_operations WHERE resource_kind='task' AND resource_id=?
      ORDER BY started_at DESC LIMIT 1`,
    taskId,
  );
  assert(op.status === "committed", `离线操作状态=${op.status}`);
  assert(!snap.active.some((o) => o.resource === taskId), `已结束操作仍显示为运行中: ${JSON.stringify(snap.active)}`);
  const history = snap.recent.find((o) => o.resource === taskId && o.status === "committed");
  assert(history, `最近操作未包含该任务: ${JSON.stringify(snap.recent)}`);
  await shot("E-reopen");
  return `title=${text} active=${snap.activeCount} status=${op.status} history=${history.agent}`;
}

async function scenarioF(taskId) {
  await setTab("tasks");
  await page.waitForSelector(`[data-task-id="${taskId}"]`, { timeout: 15000 });
  await page.evaluate(async (id) => {
    const tasks = await import("/src/store/useTasksStore.ts");
    const ui = await import("/src/store/useUiStore.ts");
    const task = tasks.useTasksStore.getState().tasks.find((t) => t.id === id);
    ui.useUiStore.getState().openEditor(task);
  }, taskId);
  await page.waitForSelector(".task-editor", { timeout: 10000 });

  const input = page.locator(".task-editor input[type=text], .task-editor input:not([type])").first();
  await input.fill("F · 用户未保存的草稿");

  const current = dbGet("SELECT updated_at FROM tasks WHERE id = ?", taskId);
  const mcp = mcpSession(TOKENS.claude);
  try {
    await mcp.open();
    const msg = await mcp.callTool("taskdock_update_task", {
      task_id: taskId,
      expected_updated_at: current.updated_at,
      title: "F · Agent 远端标题",
      requestId: `f-${Date.now()}`,
    });
    const payload = toolPayload(msg);
    assert(payload && !payload.error, `更新失败: ${JSON.stringify(payload).slice(0, 200)}`);

    const banner = await waitFor(async () => {
      const n = await page.locator(".task-editor-remote").count();
      return n > 0 ? true : null;
    }, 8000);
    await shot("F-remote-banner");
    assert(banner, "未提示远端已更新");
    assert((await input.inputValue()) === "F · 用户未保存的草稿", "用户输入被覆盖");

    await page.getByRole("button", { name: "保存" }).first().click();
    const conflict = await waitFor(async () => {
      const text = await page.locator(".task-editor-error").innerText().catch(() => "");
      return text.includes("已被其他来源更新") || text.includes("CONFLICT") ? text : null;
    }, 8000);
    await shot("F-save-conflict");
    assert(conflict, "保存未检测到版本冲突");

    await page.getByRole("button", { name: "重新加载远端数据" }).first().click();
    const reloaded = await waitFor(async () => {
      const v = await input.inputValue();
      return v === "F · Agent 远端标题" ? v : null;
    }, 8000);
    assert(reloaded, "重新加载后未显示远端最新值");
    await shot("F-reloaded");
    return `banner=yes conflict=${conflict.slice(0, 40)} reloaded=${reloaded}`;
  } finally {
    mcp.close();
  }
}

async function scenarioG() {
  await stopGui();
  const past = new Date(Date.now() - 10 * 60_000).toISOString();
  const started = new Date(Date.now() - 11 * 60_000).toISOString();
  dbRun(
    `INSERT INTO agent_operations
       (id, agent_id, actor_kind, interface, action, resource_kind, resource_id, project_id,
        status, phase, revision, request_id, error_code, detail, started_at, updated_at, lease_expires_at)
     VALUES ('op-crash-sim', 'codex', 'agent', 'cli', 'task.update', 'task', 'crash-task', ?,
             'running', 'writing', NULL, '', '', '进程异常退出模拟', ?, ?, ?)`,
    PROJECT,
    started,
    started,
    past,
  );

  await launchGui();
  await attachPage();
  await skipOnboarding();
  await sleep(1500);
  const row = dbGet("SELECT status, error_code FROM agent_operations WHERE id='op-crash-sim'");
  assert(row && row.status === "interrupted", `崩溃恢复后状态=${JSON.stringify(row)}`);
  const active = dbAll("SELECT id FROM agent_operations WHERE status='running'");
  assert(active.length === 0, `仍有运行中操作: ${JSON.stringify(active)}`);
  await shot("G-interrupted");
  return `status=${row.status} code=${row.error_code} running=${active.length}`;
}

// ── 生命周期 ─────────────────────────────────────────────────────
async function stopGui() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    page = null;
  }
  if (gui?.pid) {
    spawnSync("taskkill", ["/PID", String(gui.pid), "/T", "/F"], { windowsHide: true });
    gui = null;
    await sleep(1200);
  }
}

function writeSummary(startedAt) {
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  const lines = [
    "# Agent 操作可视化 · Dev 功能验收结果",
    "",
    `- 时间：${startedAt.toISOString()} → ${new Date().toISOString()}`,
    `- 隔离目录：\`${ROOT}\``,
    `- 二进制：\`${EXE}\`（mtime ${fs.existsSync(EXE) ? fs.statSync(EXE).mtime.toISOString() : "缺失"}）`,
    `- 结果：**${pass} 通过 / ${fail} 失败**`,
    "",
    "| 结果 | 场景 | 细节 |",
    "|---|---|---|",
    ...results.map((r) => `| ${r.ok ? "PASS" : "FAIL"} | ${r.name} | ${String(r.detail).replace(/\|/g, "\\|").slice(0, 220)} |`),
    "",
    "## 数据库终态",
    "",
    "```",
    ...dbAll("SELECT status, interface, COUNT(*) AS n FROM agent_operations GROUP BY status, interface ORDER BY status")
      .map((r) => `${r.status}\t${r.interface}\t${r.n}`),
    "```",
    "",
  ];
  fs.writeFileSync(SUMMARY, lines.join("\n"));
  fs.writeFileSync(LOG_PATH, `${logLines.join("\n")}\n`);
  log(`summary: ${pass} passed / ${fail} failed → ${SUMMARY}`);
  return fail === 0;
}

async function main() {
  const startedAt = new Date();
  fs.mkdirSync(DATA, { recursive: true });
  log(`ROOT=${ROOT}`);

  CDP_PORT = await freePort(17981);
  REST_PORT = await freePort(17931);
  log(`CDP_PORT=${CDP_PORT} REST_PORT=${REST_PORT}`);

  if (!fs.existsSync(EXE) || !fs.existsSync(CLI)) {
    record("环境检查：调试二进制存在", false, `${EXE} / ${CLI}`);
    writeSummary(startedAt);
    return;
  }
  // 二进制必须晚于本次源码改动，避免拿旧产物验收。
  const exeMtime = fs.statSync(EXE).mtime;
  record("环境检查：调试二进制含本次改动", exeMtime > new Date("2026-11-21T02:30:00Z"), `mtime=${exeMtime.toISOString()}`);

  await step("初始化隔离数据库（--agentctl 无头）", async () => {
    const res = runSync(EXE, ["--agentctl", "scan"], {
      env: { TASK_DOCK_DATA_DIR: DATA, WEBVIEW2_USER_DATA_FOLDER: DATA },
    });
    assert(res.status === 0, `exit=${res.status} ${res.stderr}`);
    assert(fs.existsSync(DB_PATH), "数据库未生成");
    return `db=${DB_PATH}`;
  });

  await step("种子：项目 / 两个 Agent / 能力 / 设置", async () => {
    seed();
    const agents = dbAll("SELECT agent_id, scope FROM mcp_agents ORDER BY agent_id");
    assert(agents.length === 2, `agents=${agents.length}`);
    return agents.map((a) => `${a.agent_id}:${a.scope}`).join(",");
  });

  let taskId = null;
  await step("前置：创建验收任务（CLI 本机）", async () => {
    const res = cli(["task", "create", "--title", TASK_TITLE]);
    taskId = res.json?.data?.id;
    assert(taskId, `创建失败: ${JSON.stringify(res.json).slice(0, 200)}`);
    return `task=${taskId}`;
  });

  await step("启动 GUI（Vite dev + CDP + 隔离数据）", async () => {
    await launchGui();
    await attachPage();
    await skipOnboarding();
    await sleep(1500);
    const boot = await page.evaluate(() => (window).__AGENT_OP_BOOT__ ?? null);
    log(`boot marker after launch: ${JSON.stringify(boot)}`);
    const restReady = await waitHttp(REST_PORT, 30000);
    const mcpReady = await waitFile(path.join(DATA, "mcp-transport.json"), 30000);
    assert(restReady, "REST 未就绪");
    assert(mcpReady, "MCP transport 未就绪");
    return `pid=${gui.pid} rest=${REST_PORT} cdp=${CDP_PORT}`;
  });

  // A 先跑：规划编辑页在默认项目下最容易观察。
  const run = (key) => !ONLY || ONLY.split(",").includes(key);

  if (run("A")) await step("A · Codex 新建规划功能（MCP）", scenarioA);

  if (taskId && run("B")) await step("B · Claude 修改现有任务（MCP）", () => scenarioB(taskId));
  if (taskId && run("C")) await step("C · 两个 Agent 改同一资源（一个成功 + 一个冲突）", () => scenarioC(taskId));
  if (taskId && run("D")) await step("D · CLI 在 UI 打开时修改任务（无需刷新）", () => scenarioD(taskId));
  if (taskId && run("E")) await step("E · UI 关闭时写入后重开（历史保留、非运行中）", () => scenarioE(taskId));
  if (taskId && run("F")) await step("F · 用户编辑中 Agent 并发修改（不覆盖 + 冲突 + 重载）", () => scenarioF(taskId));
  if (run("G")) await step("G · 进程异常退出（租约过期 → interrupted）", scenarioG);

  const allPass = writeSummary(startedAt);
  if (!KEEP) await stopGui();
  process.exit(allPass ? 0 : 1);
}

main().catch(async (err) => {
  log(`脚本异常：${err && err.stack ? err.stack : err}`);
  record("脚本执行", false, String(err && err.message ? err.message : err));
  writeSummary(new Date());
  if (!KEEP) await stopGui();
  process.exit(2);
});
