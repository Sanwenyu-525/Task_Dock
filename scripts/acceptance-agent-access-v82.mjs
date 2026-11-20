/**
 * Agent 共享工作空间 v82 端到端验收脚本（A–F 场景）。
 *
 * 用法：node scripts/acceptance-agent-access-v82.mjs [--bin <目录>] [--keep]
 * 默认二进制目录：src-tauri/target/debug（不使用 release 目录）。
 *
 * 隔离保证：
 * - 每次运行创建唯一目录 tmp/acceptance/agent-access-v82-<yyyyMMdd-HHmmss>/；
 * - data/ 作为 TASK_DOCK_DATA_DIR，TASKDOCK_DB_PATH 指向 data/task-dock.db；
 * - WEBVIEW2_USER_DATA_FOLDER 指向同一隔离目录；
 * - REST 端口从 17831 起探测空闲端口，CDP 端口从 17881 起探测；
 * - 不读写真实用户数据。
 *
 * 退出码：全部通过 0；存在 FAIL 1；脚本异常 2。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// ── 参数与路径 ────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const binIdx = argv.indexOf("--bin");
const BIN = binIdx >= 0 && argv[binIdx + 1]
  ? path.resolve(argv[binIdx + 1])
  : path.resolve("src-tauri/target/debug");
const TASK_DOCK = path.join(BIN, "task-dock.exe");
const TASKDOCK = path.join(BIN, "taskdock.exe");
const REPO_ROOT = path.resolve(".");

function stampLocal(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const ROOT = path.resolve("tmp", "acceptance", `agent-access-v82-${stampLocal()}`);
const DATA = path.join(ROOT, "data");
const WS = path.join(ROOT, "workspace");
const DB_PATH = path.join(DATA, "task-dock.db");
const LOG = path.join(ROOT, "acceptance.log");
const SUMMARY = path.join(ROOT, "summary.md");
const CDP_BRIDGE = path.join(REPO_ROOT, "scripts", "acceptance", "cdp-bridge.mjs");

const PROJECT_A = "v82-proj-a";
const PROJECT_B = "v82-proj-b";

// ── 日志与断言 ────────────────────────────────────────────────────
const lines = [];
const results = [];
const startedAt = new Date();

function log(...parts) {
  const text = parts.join(" ");
  lines.push(`[${new Date().toISOString()}] ${text}`);
  console.log(text);
}

function record(name, ok, detail = "", extra = {}) {
  const entry = { name, ok, detail, at: new Date().toISOString(), ...extra };
  results.push(entry);
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

function scenarioFailure(name, err) {
  record(name, false, `异常：${err?.stack || err}`);
}

// ── 通用工具 ──────────────────────────────────────────────────────
function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function runSync(cmd, args, { env = {}, cwd = REPO_ROOT, timeout = 120000 } = {}) {
  const start = new Date();
  const r = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
  const end = new Date();
  const res = {
    cmd: [cmd, ...args].join(" "),
    status: r.status === null ? -1 : r.status,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
    signal: r.signal,
    error: r.error ? String(r.error.message || r.error) : "",
    start: start.toISOString(),
    end: end.toISOString(),
    ms: end - start,
  };
  log(`$ ${res.cmd}  exit=${res.status} ${res.ms}ms`);
  return res;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** CLI 调用：始终使用隔离数据库；可附带 Agent token。 */
function cli(args, { token, expectFail = false, timeout = 120000 } = {}) {
  const env = {
    ...process.env,
    TASK_DOCK_DATA_DIR: DATA,
    TASKDOCK_DB_PATH: DB_PATH,
    WEBVIEW2_USER_DATA_FOLDER: DATA,
    TASKDOCK_AGENT_TOKEN: token || "",
    TASKDOCK_CLI_TOKEN: "",
  };
  const res = runSync(TASKDOCK, args, { env, timeout });
  res.json = parseJson(res.stdout);
  if (!expectFail && res.status !== 0) {
    log(`  ! CLI 非零退出：stdout=${res.stdout.slice(0, 400)} stderr=${res.stderr.slice(0, 400)}`);
  }
  return res;
}

/** 本机 CLI（无 token，验证现有本机策略）。 */
function cliLocal(args, opts = {}) {
  return cli(args, { ...opts, token: "" });
}

function dbOpen() {
  return new DatabaseSync(DB_PATH);
}

function dbAll(sql, ...params) {
  const d = dbOpen();
  try {
    return d.prepare(sql).all(...params);
  } finally {
    d.close();
  }
}

function dbGet(sql, ...params) {
  const d = dbOpen();
  try {
    return d.prepare(sql).get(...params) ?? null;
  } finally {
    d.close();
  }
}

function dbRun(sql, ...params) {
  const d = dbOpen();
  try {
    return d.prepare(sql).run(...params);
  } finally {
    d.close();
  }
}

function countTable(table) {
  return Number(dbGet(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? -1);
}

function taskById(id) {
  return dbGet("SELECT id, title, status, completed_at FROM tasks WHERE id = ?", id);
}

function revisionOf(kind, id) {
  const row = dbGet(
    "SELECT revision FROM agent_resource_revisions WHERE resource_kind = ? AND resource_id = ?",
    kind,
    id,
  );
  return row ? Number(row.revision) : null;
}

function fileSha(absPath) {
  return sha256(fs.readFileSync(absPath));
}

async function findFreePort(start, attempts = 200) {
  for (let port = start; port < start + attempts; port += 1) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`从 ${start} 起找不到空闲端口`);
}

async function waitHttp(port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/status`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.status) return true;
    } catch {
      /* 尚未监听 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function waitPortClosed(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = net.connect({ port, host: "127.0.0.1" });
      socket.setTimeout(800);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      const done = () => {
        socket.destroy();
        resolve(false);
      };
      socket.once("error", done);
      socket.once("timeout", done);
    });
    if (!open) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function rest(pathname, { method = "GET", token, body, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${REST_PORT}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 无 JSON */
  }
  return { status: res.status, json };
}

function errCode(res) {
  return res?.json?.error?.code ?? res?.json?.error?.message ?? "-";
}

// ── MCP stdio 会话（复用 v81 模式）───────────────────────────────
function mcpSession(token) {
  const proc = spawn(TASK_DOCK, ["--mcp-server"], {
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
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  function notify(method, params) {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
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
    request,
    notify,
    close,
    get stderr() {
      return stderr;
    },
  };
}

function toolText(msg) {
  const text = msg?.result?.content?.find((c) => c.type === "text")?.text;
  return parseJson(text);
}

function mcpDenied(msg) {
  return Boolean(msg?.error) || msg?.result?.isError === true;
}

// ── 数据库 seed ───────────────────────────────────────────────────
function seedProjects() {
  const now = new Date().toISOString();
  const stmt = `INSERT OR REPLACE INTO planning_projects
      (id, name, description, status, archived, target_date, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, 'planning', 0, NULL, ?, ?, ?)`;
  for (const [id, name, order] of [
    [PROJECT_A, "v82 验收项目 A", 1],
    [PROJECT_B, "v82 验收项目 B", 2],
  ]) {
    dbRun(stmt, id, name, "验收用隔离项目", order, now, now);
  }
}

function seedAgents(kbA) {
  const now = new Date().toISOString();
  const agents = [
    {
      row: "v82-agent-a",
      id: "v82-a",
      token: "tdm_v82_a",
      scope: "project_rw",
      caps: [
        ["tasks.read", ""],
        ["tasks.write", ""],
        ["context.read", ""],
        ["handoffs.read", ""],
        ["handoffs.write", ""],
      ],
    },
    {
      row: "v82-agent-b",
      id: "v82-b",
      token: "tdm_v82_b",
      scope: "project_rw",
      caps: [
        ["knowledge.read", ""],
        ["knowledge.write", ""],
        ["decisions.read", ""],
        ["decisions.write", ""],
        ["handoffs.read", ""],
        ["handoffs.write", ""],
        ["context.read", ""],
      ],
    },
    {
      row: "v82-agent-c",
      id: "v82-c",
      token: "tdm_v82_c",
      scope: "project_rw",
      caps: [
        ["tasks.read", ""],
        ["tasks.write", ""],
        ["context.read", ""],
        ["projects.read", ""],
      ],
    },
    {
      row: "v82-agent-d",
      id: "v82-d",
      token: "tdm_v82_d",
      scope: "readonly",
      caps: [
        ["decisions.read", PROJECT_A],
        ["handoffs.read", PROJECT_A],
      ],
    },
    {
      row: "v82-agent-k",
      id: "v82-k",
      token: "tdm_v82_k",
      scope: "readonly",
      caps: [["knowledge.read", kbA]],
    },
    {
      row: "v82-agent-ro",
      id: "v82-ro",
      token: "tdm_v82_ro",
      scope: "readonly",
      caps: [["tasks.read", ""]],
    },
  ];
  const insAgent = `INSERT OR REPLACE INTO mcp_agents
      (id, agent_id, display_name, token_hash, scope, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`;
  const insCap = `INSERT OR REPLACE INTO mcp_agent_capabilities
      (id, agent_row_id, capability, resource_id, created_at)
      VALUES (?, ?, ?, ?, ?)`;
  for (const a of agents) {
    dbRun(insAgent, a.row, a.id, a.id, sha256(a.token), a.scope, now, now);
    for (const [cap, resource] of a.caps) {
      dbRun(insCap, crypto.randomUUID(), a.row, cap, resource, now);
    }
  }
  return Object.fromEntries(agents.map((a) => [a.row.replace("v82-agent-", ""), a]));
}

function setSetting(key, rawJsonText) {
  dbRun(
    "INSERT OR REPLACE INTO application_settings (key, value, updated_at) VALUES (?, ?, ?)",
    key,
    rawJsonText,
    new Date().toISOString(),
  );
}

function getSetting(key) {
  return dbGet("SELECT value FROM application_settings WHERE key = ?", key)?.value ?? null;
}

// ── CDP（真实 Tauri 命令调用）─────────────────────────────────────
function cdpInvoke(command, args = {}) {
  const res = runSync(
    process.execPath,
    [CDP_BRIDGE, "invoke", String(CDP_PORT), command, JSON.stringify(args)],
    { timeout: 90000 },
  );
  const parsed = parseJson(res.stdout);
  return { ...res, json: parsed, ok: res.status === 0 && parsed?.ok === true };
}

// ── 运行状态 ──────────────────────────────────────────────────────
let REST_PORT = null;
let CDP_PORT = null;
let gui = null;
let guiLogs = { out: null, err: null };

function stopGui() {
  if (!gui?.pid) return;
  try {
    spawnSync("taskkill", ["/PID", String(gui.pid), "/T", "/F"], {
      windowsHide: true,
      encoding: "utf8",
    });
  } catch {
    /* 忽略 */
  }
  gui = null;
}

// ── 主流程 ────────────────────────────────────────────────────────
async function main() {
  const scriptStarted = new Date();
  log(`仓库：${REPO_ROOT}`);
  log(`二进制目录：${BIN}`);
  log(`隔离目录：${ROOT}`);
  log(`数据库：${DB_PATH}`);

  if (!fs.existsSync(TASK_DOCK)) {
    log(`BLOCKED：缺少 ${TASK_DOCK}`);
    fs.mkdirSync(ROOT, { recursive: true });
    record("环境检查：task-dock.exe 存在", false, TASK_DOCK);
    return finish(scriptStarted, true);
  }
  if (!fs.existsSync(TASKDOCK)) {
    log(`BLOCKED：缺少 ${TASKDOCK}`);
    fs.mkdirSync(ROOT, { recursive: true });
    record("环境检查：taskdock.exe 存在", false, TASKDOCK);
    return finish(scriptStarted, true);
  }
  const binStat = fs.statSync(TASK_DOCK);
  log(`task-dock.exe mtime=${binStat.mtime.toISOString()} size=${binStat.size}`);

  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(WS, { recursive: true });

  REST_PORT = await findFreePort(17831);
  CDP_PORT = await findFreePort(17881);
  log(`REST_PORT=${REST_PORT} CDP_PORT=${CDP_PORT}`);

  // 0) 初始化隔离数据库（无头，不启动窗口）
  try {
    const t0 = new Date();
    const init = runSync(TASK_DOCK, ["--agentctl", "scan"], {
      env: { ...process.env, TASK_DOCK_DATA_DIR: DATA, WEBVIEW2_USER_DATA_FOLDER: DATA },
    });
    record(
      "S1 隔离数据库初始化（--agentctl 无头）",
      init.status === 0 && fs.existsSync(DB_PATH),
      `exit=${init.status} db=${fs.existsSync(DB_PATH)} ${Date.now() - t0}ms`,
    );
  } catch (err) {
    scenarioFailure("S1 隔离数据库初始化", err);
  }
  if (!fs.existsSync(DB_PATH)) {
    log("数据库未生成，后续场景 BLOCKED");
    return finish(scriptStarted, true);
  }

  // 1) 项目 / 知识库 / 决策 / Agent seed
  let kbA = null;
  let kbB = null;
  let docA = null;
  let docB = null;
  let decisionA = null;
  let decisionB = null;
  let agents = null;
  try {
    seedProjects();
    record(
      "S2a 种子项目 A/B（planning_projects）",
      Boolean(dbGet("SELECT id FROM planning_projects WHERE id = ?", PROJECT_A)) &&
        Boolean(dbGet("SELECT id FROM planning_projects WHERE id = ?", PROJECT_B)),
      `${PROJECT_A},${PROJECT_B}`,
    );
  } catch (err) {
    scenarioFailure("S2a 种子项目", err);
  }

  try {
    const a = cliLocal(["knowledge", "create", "--title", "KB-A 文档", "--content", "项目 A 知识正文", "--kb-name", "V82-KB-A", "--json"]);
    const b = cliLocal(["knowledge", "create", "--title", "KB-B 文档", "--content", "项目 B 知识正文", "--kb-name", "V82-KB-B", "--json"]);
    docA = a.json?.data?.id ?? null;
    docB = b.json?.data?.id ?? null;
    kbA = a.json?.data?.kb_id ?? null;
    kbB = b.json?.data?.kb_id ?? null;
    record(
      "S2b 创建隔离知识库 KB-A/KB-B 与文档",
      a.status === 0 && b.status === 0 && kbA && kbB && docA && docB && kbA !== kbB,
      `KB-A=${kbA} docA=${docA} KB-B=${kbB} docB=${docB}`,
    );
  } catch (err) {
    scenarioFailure("S2b 创建知识库", err);
  }

  try {
    const da = cliLocal(["decision", "create", "--title", "项目 A 决策", "--decision", "只在项目 A 生效", "--project", PROJECT_A, "--json"]);
    const db = cliLocal(["decision", "create", "--title", "项目 B 决策", "--decision", "只在项目 B 生效", "--project", PROJECT_B, "--json"]);
    decisionA = da.json?.data?.id ?? null;
    decisionB = db.json?.data?.id ?? null;
    record(
      "S2c 创建项目 A/B 决策（agent_decisions）",
      da.status === 0 && db.status === 0 && decisionA && decisionB,
      `A=${decisionA} B=${decisionB} total=${countTable("agent_decisions")}`,
    );
  } catch (err) {
    scenarioFailure("S2c 创建决策", err);
  }

  try {
    agents = seedAgents(kbA || "__missing_kb__");
    record(
      "S2d 注册 6 个 Agent（sha256 token + 资源级能力）",
      Object.keys(agents).length === 6,
      Object.values(agents).map((a) => `${a.id}(${a.scope})`).join(","),
    );
  } catch (err) {
    scenarioFailure("S2d 注册 Agent", err);
  }

  // 隔离工作空间
  try {
    const wsInit = cliLocal(["sync", "init", "--path", WS, "--name", "v82 验收工作空间", "--json"]);
    record(
      "S2e 初始化隔离工作空间",
      wsInit.status === 0 && Boolean(dbGet("SELECT id FROM agent_workspaces LIMIT 1")),
      `exit=${wsInit.status} ws=${dbGet("SELECT id FROM agent_workspaces LIMIT 1")?.id ?? "-"}`,
    );
  } catch (err) {
    scenarioFailure("S2e 初始化工作空间", err);
  }

  const tokenA = "tdm_v82_a";
  const tokenB = "tdm_v82_b";
  const tokenC = "tdm_v82_c";
  const tokenD = "tdm_v82_d";
  const tokenK = "tdm_v82_k";
  const tokenRo = "tdm_v82_ro";

  // ── A. CLI 权限与资源副作用 ────────────────────────────────────
  if (!agents) {
    record("A 场景前置（Agent seed）", false, "Agent seed 失败，A 场景 BLOCKED");
  } else {
    try {
      const before = countTable("agent_decisions");
      const denied = cli(["decision", "list", "--json"], { token: tokenA, expectFail: true });
      const after = countTable("agent_decisions");
      record(
        "A1 无 decisions.read 的 Agent 读决策被拒绝且无副作用",
        denied.status === 6 && denied.json?.error?.code === "FORBIDDEN" && before === after,
        `exit=${denied.status} code=${errCode(denied)} decisions ${before}->${after}`,
      );
    } catch (err) {
      scenarioFailure("A1 无 decisions.read 拒绝", err);
    }

    let taskA = null;
    try {
      const create = cli(["task", "create", "--title", "v82 CLI 任务", "--description", "验收", "--json"], { token: tokenA });
      taskA = create.json?.data?.id ?? null;
      const row = taskA ? taskById(taskA) : null;
      record(
        "A2 Agent A 创建任务（落库）",
        create.status === 0 && Boolean(taskA) && row?.status === "pending",
        `exit=${create.status} id=${taskA ?? "-"} db.status=${row?.status ?? "-"} rev=${taskA ? revisionOf("task", taskA) : "-"}`,
      );
    } catch (err) {
      scenarioFailure("A2 创建任务", err);
    }

    if (taskA) {
      try {
        const revBefore = revisionOf("task", taskA);
        const got = cli(["task", "get", taskA, "--json"], { token: tokenA });
        const base = got.json?.data?.revision ?? revBefore;
        const done = cli(["task", "complete", taskA, "--base-revision", String(base), "--json"], { token: tokenA });
        const row = taskById(taskA);
        const revAfter = revisionOf("task", taskA);
        record(
          "A3 Agent A 完成任务（status=completed）",
          done.status === 0 && row?.status === "completed" && Boolean(row?.completed_at),
          `exit=${done.status} db.status=${row?.status} completed_at=${row?.completed_at}`,
        );
        record(
          "A4 完成后 agent_resource_revisions 递增",
          revBefore !== null && revAfter !== null && revAfter > revBefore,
          `revision ${revBefore} -> ${revAfter}`,
        );
      } catch (err) {
        scenarioFailure("A3/A4 完成任务与版本递增", err);
      }
    } else {
      record("A3 Agent A 完成任务", false, "A2 未拿到 taskId");
      record("A4 完成后 revision 递增", false, "A2 未拿到 taskId");
    }

    try {
      const denied = cli(["knowledge", "get", docB, "--json"], { token: tokenK, expectFail: true });
      const allowed = cli(["knowledge", "get", docA, "--json"], { token: tokenK });
      record(
        "A5 仅授权 KB-A 的 Agent 读 KB-B 文档被拒绝",
        denied.status === 6 && denied.json?.error?.code === "FORBIDDEN",
        `B.exit=${denied.status} code=${errCode(denied)}`,
      );
      record(
        "A5b 同一 Agent 读 KB-A 文档仍成功（非一刀切）",
        allowed.status === 0 && allowed.json?.data?.kb_id === kbA,
        `exit=${allowed.status} kb_id=${allowed.json?.data?.kb_id ?? "-"}`,
      );
    } catch (err) {
      scenarioFailure("A5 知识库资源级授权", err);
    }

    try {
      const local = cliLocal(["decision", "list", "--json"]);
      record(
        "A6 本机 CLI（无 token）仍可读取",
        local.status === 0 && Array.isArray(local.json?.data) && local.json.data.length >= 2,
        `exit=${local.status} items=${local.json?.data?.length ?? "-"} token_env=${process.env.TASKDOCK_AGENT_TOKEN ? "set" : "unset"}`,
      );
    } catch (err) {
      scenarioFailure("A6 本机 CLI 读取", err);
    }
  }

  // ── E. 双 Agent 交接 / 报告 ─────────────────────────────────────
  let reportB = null;
  try {
    const create = cli(
      ["agent", "handoff", "create", "--to", agents.b.id, "--summary", "A 交给 B（项目 A）", "--project", PROJECT_A, "--json"],
      { token: tokenA },
    );
    const h = create.json?.data?.handoff;
    const h1 = h?.id ?? null;
    const row = h1 ? dbGet("SELECT status, revision, project_id FROM agent_handoffs WHERE id = ?", h1) : null;
    record(
      "E1 Agent A 创建交接（pending，项目 A）",
      create.status === 0 && Boolean(h1) && row?.status === "pending" && row?.project_id === PROJECT_A,
      `exit=${create.status} id=${h1 ?? "-"} db=${row?.status ?? "-"}/${row?.project_id ?? "-"}`,
    );

    if (!h1) {
      for (const name of ["E2", "E3", "E4", "E5", "E6", "E7"]) record(`${name} 交接状态机`, false, "E1 未拿到交接 ID");
    } else {
      const wrongAccept = cli(["agent", "handoff", "accept", h1, "--base-revision", "999", "--json"], { token: tokenB, expectFail: true });
      const afterWrong = dbGet("SELECT status, revision FROM agent_handoffs WHERE id = ?", h1);
      record(
        "E2 错误 base_revision 接收交接 → CONFLICT 且状态不变",
        wrongAccept.status === 5 && wrongAccept.json?.error?.code === "CONFLICT" && afterWrong?.status === "pending" && afterWrong?.revision === 1,
        `exit=${wrongAccept.status} code=${errCode(wrongAccept)} db=${afterWrong?.status}/rev${afterWrong?.revision}`,
      );

      const aAccept = cli(["agent", "handoff", "accept", h1, "--base-revision", "1", "--json"], { token: tokenA, expectFail: true });
      const afterA = dbGet("SELECT status, revision FROM agent_handoffs WHERE id = ?", h1);
      record(
        "E3 创建方 A 不能替 B 接收（FORBIDDEN）",
        aAccept.status === 6 && aAccept.json?.error?.code === "FORBIDDEN" && afterA?.status === "pending",
        `exit=${aAccept.status} code=${errCode(aAccept)} db.status=${afterA?.status}`,
      );

      const bAccept = cli(["agent", "handoff", "accept", h1, "--base-revision", "1", "--json"], { token: tokenB });
      const afterB = dbGet("SELECT status, revision FROM agent_handoffs WHERE id = ?", h1);
      record(
        "E4 目标 Agent B 接收交接（accepted, rev=2）",
        bAccept.status === 0 && afterB?.status === "accepted" && afterB?.revision === 2,
        `exit=${bAccept.status} db=${afterB?.status}/rev${afterB?.revision}`,
      );

      const aComplete = cli(["agent", "handoff", "complete", h1, "--base-revision", "2", "--json"], { token: tokenA, expectFail: true });
      const afterAComplete = dbGet("SELECT status, revision FROM agent_handoffs WHERE id = ?", h1);
      record(
        "E5 A 不能替 B 完成交接（FORBIDDEN，状态不变）",
        aComplete.status === 6 && aComplete.json?.error?.code === "FORBIDDEN" && afterAComplete?.status === "accepted",
        `exit=${aComplete.status} code=${errCode(aComplete)} db.status=${afterAComplete?.status}`,
      );

      const bWrong = cli(["agent", "handoff", "complete", h1, "--base-revision", "999", "--json"], { token: tokenB, expectFail: true });
      const afterWrongComplete = dbGet("SELECT status, revision FROM agent_handoffs WHERE id = ?", h1);
      record(
        "E6 B 用错误 revision 完成 → CONFLICT 且状态不变",
        bWrong.status === 5 && bWrong.json?.error?.code === "CONFLICT" && afterWrongComplete?.status === "accepted" && afterWrongComplete?.revision === 2,
        `exit=${bWrong.status} code=${errCode(bWrong)} db=${afterWrongComplete?.status}/rev${afterWrongComplete?.revision}`,
      );

      const bComplete = cli(["agent", "handoff", "complete", h1, "--base-revision", "2", "--json"], { token: tokenB });
      const afterDone = dbGet("SELECT status, revision, completed_at FROM agent_handoffs WHERE id = ?", h1);
      record(
        "E7 B 正确完成交接（completed, rev=3）",
        bComplete.status === 0 && afterDone?.status === "completed" && afterDone?.revision === 3 && Boolean(afterDone?.completed_at),
        `exit=${bComplete.status} db=${afterDone?.status}/rev${afterDone?.revision}`,
      );
    }
  } catch (err) {
    scenarioFailure("E1–E7 交接状态机", err);
  }

  try {
    const create = cli(
      ["agent", "handoff", "create", "--to", agents.b.id, "--summary", "A 交给 B（项目 B）", "--project", PROJECT_B, "--json"],
      { token: tokenA },
    );
    const h2 = create.json?.data?.handoff?.id ?? null;
    if (!h2) {
      record("E8 项目 B 交接与报告项目推导", false, `交接创建失败 exit=${create.status}`);
    } else {
      cli(["agent", "handoff", "accept", h2, "--base-revision", "1", "--json"], { token: tokenB });
      const mismatch = cli(
        ["agent", "report", "create", "--summary", "错误声明项目", "--result", "completed", "--handoff", h2, "--project", PROJECT_A, "--json"],
        { token: tokenB, expectFail: true },
      );
      record(
        "E8 报告声明项目与交接不一致 → 拒绝（项目由交接推导）",
        mismatch.status === 4 && mismatch.json?.error?.code === "VALIDATION",
        `exit=${mismatch.status} code=${errCode(mismatch)}`,
      );
      const report = cli(
        ["agent", "report", "create", "--summary", "B 关于项目 B 的报告", "--result", "completed", "--handoff", h2, "--json"],
        { token: tokenB },
      );
      reportB = report.json?.data?.report ?? null;
      const dbReport = reportB?.id
        ? dbGet("SELECT project_id, handoff_id, agent_id FROM agent_work_reports WHERE id = ?", reportB.id)
        : null;
      record(
        "E9 报告项目由交接推导（project_id=项目 B）",
        report.status === 0 && dbReport?.project_id === PROJECT_B && dbReport?.handoff_id === h2,
        `exit=${report.status} report=${reportB?.id ?? "-"} db.project=${dbReport?.project_id ?? "-"} handoff=${dbReport?.handoff_id ?? "-"}`,
      );
      record(
        "E10 项目 A 的读者看不到项目 B 报告",
        (() => {
          if (!reportB?.id) return false;
          const list = cli(["agent", "report", "list", "--json"], { token: tokenD });
          const items = Array.isArray(list.json?.data) ? list.json.data : [];
          const leak = items.some((r) => r.project_id === PROJECT_B || r.id === reportB.id);
          const get = cli(["agent", "report", "get", reportB.id, "--json"], { token: tokenD, expectFail: true });
          return list.status === 0 && !leak && get.status === 6 && get.json?.error?.code === "FORBIDDEN";
        })(),
        `report=${reportB?.id ?? "-"} 项目 B 报告对 Agent D 应不可见/不可读`,
      );
    }
  } catch (err) {
    scenarioFailure("E8–E10 报告项目归属", err);
  }

  // ── F. 并发放障 ────────────────────────────────────────────────
  try {
    const create = cli(["task", "create", "--title", "v82 并发完成任务", "--json"], { token: tokenA });
    const taskF = create.json?.data?.id ?? null;
    if (!taskF) {
      record("F1 并发完成只产生一次完成", false, `创建任务失败 exit=${create.status}`);
    } else {
      const revBefore = revisionOf("task", taskF);
      const env = {
        ...process.env,
        TASK_DOCK_DATA_DIR: DATA,
        TASKDOCK_DB_PATH: DB_PATH,
        WEBVIEW2_USER_DATA_FOLDER: DATA,
        TASKDOCK_AGENT_TOKEN: tokenA,
        TASKDOCK_CLI_TOKEN: "",
      };
      const spawnComplete = () =>
        new Promise((resolve) => {
          const start = new Date();
          const p = spawn(TASKDOCK, ["task", "complete", taskF, "--json"], {
            env,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let out = "";
          let err = "";
          p.stdout.on("data", (c) => (out += c.toString("utf8")));
          p.stderr.on("data", (c) => (err += c.toString("utf8")));
          p.on("close", (code) => {
            resolve({ code, out: out.trim(), err: err.trim(), start: start.toISOString(), end: new Date().toISOString() });
          });
        });
      const [r1, r2] = await Promise.all([spawnComplete(), spawnComplete()]);
      const row = taskById(taskF);
      const revAfter = revisionOf("task", taskF);
      log(`  并发完成结果：p1=${r1.code} p2=${r2.code} ${JSON.stringify([r1.start, r2.start])}`);
      record(
        "F1 两个并发完成请求只产生一次完成",
        row?.status === "completed" && revBefore !== null && revAfter === revBefore + 1,
        `p1=${r1.code} p2=${r2.code} revision ${revBefore} -> ${revAfter} completed_at=${row?.completed_at}`,
      );
      const completedAt = row?.completed_at;

      const oldBase = String((revAfter ?? 1) - 1);
      const stale = cli(["task", "complete", taskF, "--base-revision", oldBase, "--json"], { token: tokenA, expectFail: true });
      const row2 = taskById(taskF);
      record(
        "F2 旧 revision 完成失败（CONFLICT）且状态不变",
        stale.status === 5 && stale.json?.error?.code === "CONFLICT" && row2?.status === "completed" && row2?.completed_at === completedAt,
        `exit=${stale.status} code=${errCode(stale)} status=${row2?.status} completed_at=${row2?.completed_at}`,
      );

      const again = cli(["task", "complete", taskF, "--json"], { token: tokenA });
      const row3 = taskById(taskF);
      record(
        "F3 已完成后重复完成不会重新打开（completed_at 不变）",
        again.status === 0 && row3?.status === "completed" && row3?.completed_at === completedAt,
        `exit=${again.status} status=${row3?.status} completed_at=${row3?.completed_at}`,
      );
    }
  } catch (err) {
    scenarioFailure("F 并发放障", err);
  }

  // ── 文件导入（扫描前置：无策略 → pending）──────────────────────
  const inbox = path.join(WS, "inbox");
  fs.mkdirSync(inbox, { recursive: true });
  const importFile = path.join(inbox, "task-v82.json");
  const importBody = JSON.stringify({
    schema: "taskdock.import/1",
    kind: "task.create",
    payload: { title: "v82 文件导入任务" },
  });
  const importHash = sha256(importBody);
  let importRequestId = null;
  try {
    fs.writeFileSync(importFile, importBody, "utf8");
    const tasksBefore = countTable("tasks");
    const scan = cliLocal(["sync", "scan", "--json"]);
    const s = scan.json?.data ?? {};
    const req = dbGet("SELECT id, status, content_hash FROM agent_import_requests WHERE rel_path = ?", "inbox/task-v82.json");
    importRequestId = req?.id ?? null;
    record(
      "D1 无策略导入进入待审核且不写业务表",
      scan.status === 0 && s.pending_review === 1 && (s.imported ?? 0) === 0 && countTable("tasks") === tasksBefore && req?.status === "pending",
      `exit=${scan.status} pending_review=${s.pending_review} imported=${s.imported} tasks ${tasksBefore}->${countTable("tasks")} request=${req?.id ?? "-"}/${req?.status ?? "-"}`,
    );
  } catch (err) {
    scenarioFailure("D1 无策略导入待审核", err);
  }

  // ── 启动 GUI（REST + MCP bridge + CDP）─────────────────────────
  setSetting("agent_api_enabled", "true");
  setSetting("agent_api_port", String(REST_PORT));
  setSetting("mcp_server_enabled", "true");
  setSetting("agent_workspace_watch_enabled", "false");
  log(`settings: agent_api_enabled=${getSetting("agent_api_enabled")} port=${getSetting("agent_api_port")} mcp=${getSetting("mcp_server_enabled")}`);

  guiLogs.out = fs.openSync(path.join(ROOT, "gui.log"), "a");
  guiLogs.err = fs.openSync(path.join(ROOT, "gui.err"), "a");
  gui = spawn(TASK_DOCK, [], {
    env: {
      ...process.env,
      TASK_DOCK_DATA_DIR: DATA,
      WEBVIEW2_USER_DATA_FOLDER: DATA,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: ["ignore", guiLogs.out, guiLogs.err],
    detached: false,
    windowsHide: true,
  });
  log(`GUI 启动 pid=${gui.pid}`);

  let restReady = false;
  try {
    restReady = await waitHttp(REST_PORT, 60000);
  } catch {
    restReady = false;
  }
  record("S3 REST 监听就绪（真实端口绑定）", restReady, `port=${REST_PORT} pid=${gui?.pid ?? "-"}`);

  let bridgeReady = false;
  {
    const transportFile = path.join(DATA, "mcp-transport.json");
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      try {
        const raw = JSON.parse(fs.readFileSync(transportFile, "utf8"));
        if (raw?.enabled) {
          bridgeReady = true;
          break;
        }
      } catch {
        /* 尚未写出 */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    record("S4 MCP bridge 就绪（mcp-transport.json enabled）", bridgeReady, transportFile);
  }

  // ── C. REST ───────────────────────────────────────────────────
  if (!restReady) {
    for (const name of ["C1", "C2", "C3", "C4", "C5", "C6", "C7"]) {
      record(`${name} REST 场景`, false, "REST 未就绪（BLOCKED）");
    }
  } else {
    try {
      const noAuth = await rest("/api/v1/tasks");
      record("C1 未认证请求返回 401", noAuth.status === 401, `status=${noAuth.status}`);
    } catch (err) {
      scenarioFailure("C1 未认证 401", err);
    }

    try {
      const revokedRow = dbRun("UPDATE mcp_agents SET revoked_at = ? WHERE agent_id = ?", new Date().toISOString(), "v82-c");
      const revoked = await rest("/api/v1/tasks", { token: tokenC });
      record(
        "C2 Token 撤销后返回 401",
        Number(revokedRow.changes) === 1 && revoked.status === 401,
        `revoked_rows=${revokedRow.changes} status=${revoked.status}`,
      );
    } catch (err) {
      scenarioFailure("C2 Token 撤销 401", err);
    }

    try {
      const listB = await rest(`/api/v1/decisions?project=${PROJECT_B}`, { token: tokenD });
      const detailB = await rest(`/api/v1/decisions/${decisionB}`, { token: tokenD });
      const listA = await rest(`/api/v1/decisions?project=${PROJECT_A}`, { token: tokenD });
      record(
        "C3 项目 A 的 Agent 读项目 B 决策 → 403（列表与详情）",
        listB.status === 403 && errCode(listB) === "FORBIDDEN" && detailB.status === 403 && listA.status === 200,
        `listB=${listB.status}/${errCode(listB)} detailB=${detailB.status} listA=${listA.status}`,
      );
    } catch (err) {
      scenarioFailure("C3 项目 B 决策 403", err);
    }

    try {
      const activity = await rest("/api/v1/agents/activity", { token: tokenD });
      const items = Array.isArray(activity.json?.data) ? activity.json.data : [];
      const leak = items.some((i) => i.project_id === PROJECT_B);
      record(
        "C4 项目 A 的 Agent 活动记录不含项目 B（实现为服务端过滤而非 403）",
        activity.status === 200 && !leak,
        `status=${activity.status} items=${items.length} projectB=${items.filter((i) => i.project_id === PROJECT_B).length}`,
      );
    } catch (err) {
      scenarioFailure("C4 活动过滤", err);
    }

    try {
      const sync = await rest("/api/v1/sync/status", { token: tokenRo });
      record("C5 GET /api/v1/sync/status 无 projects.read → 403", sync.status === 403 && errCode(sync) === "FORBIDDEN", `status=${sync.status} code=${errCode(sync)}`);
    } catch (err) {
      scenarioFailure("C5 sync/status 403", err);
    }

    try {
      const before = countTable("tasks");
      const key = `v82-idem-${Date.now()}`;
      const first = await rest("/api/v1/tasks", {
        method: "POST",
        token: tokenA,
        body: { title: "REST 幂等任务 v82" },
        headers: { "idempotency-key": key },
      });
      const replay = await rest("/api/v1/tasks", {
        method: "POST",
        token: tokenA,
        body: { title: "REST 幂等任务 v82" },
        headers: { "idempotency-key": key },
      });
      const conflict = await rest("/api/v1/tasks", {
        method: "POST",
        token: tokenA,
        body: { title: "REST 幂等任务 v82（不同 body）" },
        headers: { "idempotency-key": key },
      });
      const after = countTable("tasks");
      const sameTitle = Number(dbGet("SELECT COUNT(*) AS n FROM tasks WHERE title = ?", "REST 幂等任务 v82")?.n ?? -1);
      record(
        "C6 同 Idempotency-Key 重放只创建 1 条任务",
        first.status === 201 && replay.status === 201 && replay.json?.meta?.replayed === true && sameTitle === 1,
        `first=${first.status} replay=${replay.status} replayed=${replay.json?.meta?.replayed} sameTitle=${sameTitle}`,
      );
      record(
        "C7 同 Key 不同 Body → 409 且不新增任务",
        conflict.status === 409 && after === before + 1 && sameTitle === 1,
        `conflict=${conflict.status} code=${errCode(conflict)} tasks ${before}->${after} sameTitle=${sameTitle}`,
      );
    } catch (err) {
      scenarioFailure("C6/C7 REST 幂等", err);
    }
  }

  // ── B. MCP Tools 与 Resources ─────────────────────────────────
  if (!bridgeReady) {
    for (const name of ["B1", "B2", "B3", "B4", "B5", "B6", "B7"]) {
      record(`${name} MCP 场景`, false, "MCP bridge 未就绪（BLOCKED）");
    }
  } else {
    const mcpB = mcpSession(tokenB);
    try {
      const init = await mcpB.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "acceptance-v82", version: "1" },
      });
      mcpB.notify("notifications/initialized", {});
      record("B0a MCP initialize", Boolean(init?.result?.protocolVersion), `protocolVersion=${init?.result?.protocolVersion ?? "-"} stderr=${mcpB.stderr.slice(0, 160)}`);

      const tools = await mcpB.request("tools/list", {});
      const toolNames = (tools?.result?.tools ?? []).map((t) => t.name);
      const requiredTools = ["taskdock_list_decisions", "taskdock_get_decision", "taskdock_agent_activity"];
      record(
        "B0b tools/list 精确包含三个受测工具",
        tools?.result !== undefined && requiredTools.every((n) => toolNames.includes(n)),
        `tools=${toolNames.length} required=${requiredTools.map((n) => `${n}:${toolNames.includes(n)}`).join(",")}`,
      );

      const resources = await mcpB.request("resources/list", {});
      const uris = (resources?.result?.resources ?? []).map((r) => r.uri);
      record(
        "B0c resources/list 精确包含 decisions 与 knowledge/index",
        uris.includes("taskdock://decisions") && uris.includes("taskdock://knowledge/index"),
        `resources=${uris.length}`,
      );

      const globalList = await mcpB.request("tools/call", {
        name: "taskdock_list_decisions",
        arguments: { limit: 200 },
      });
      const globalItems = toolText(globalList)?.items ?? [];
      const globalProjects = new Set(globalItems.map((d) => d.project_id));
      record(
        "B1 Agent B（全局 decisions.read）可见 A/B 两个项目决策",
        !mcpDenied(globalList) && globalProjects.has(PROJECT_A) && globalProjects.has(PROJECT_B),
        `denied=${mcpDenied(globalList)} items=${globalItems.length} projects=${[...globalProjects].join(",")}`,
      );
    } catch (err) {
      scenarioFailure("B0/B1 MCP 基础调用", err);
    } finally {
      mcpB.close();
    }

    // 无 decisions.read 的 Agent A
    {
      const mcpA = mcpSession(tokenA);
      try {
        await mcpA.request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "acceptance-v82-a", version: "1" },
        });
        mcpA.notify("notifications/initialized", {});
        const call = await mcpA.request("tools/call", { name: "taskdock_list_decisions", arguments: { limit: 10 } });
        record(
          "B2 无 decisions.read 的 Agent 调 taskdock_list_decisions 得到错误",
          mcpDenied(call),
          `error=${Boolean(call?.error)} code=${call?.error?.code ?? "-"} isError=${call?.result?.isError ?? "-"}`,
        );
      } catch (err) {
        scenarioFailure("B2 无 decisions.read MCP 拒绝", err);
      } finally {
        mcpA.close();
      }
    }

    // 项目 A 作用域 Agent D
    {
      const mcpD = mcpSession(tokenD);
      try {
        await mcpD.request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "acceptance-v82-d", version: "1" },
        });
        mcpD.notify("notifications/initialized", {});

        const list = await mcpD.request("tools/call", { name: "taskdock_list_decisions", arguments: { limit: 200 } });
        const items = toolText(list)?.items ?? [];
        record(
          "B3 项目 A 的 Agent 只见项目 A 决策（MCP）",
          !mcpDenied(list) && items.length >= 1 && items.every((d) => d.project_id === PROJECT_A),
          `denied=${mcpDenied(list)} items=${items.length} projects=${[...new Set(items.map((d) => d.project_id))].join(",")}`,
        );

        const detail = await mcpD.request("tools/call", {
          name: "taskdock_get_decision",
          arguments: { decision_id: decisionB },
        });
        record(
          "B4 项目 A 的 Agent 读项目 B 决策详情被拒绝（MCP）",
          mcpDenied(detail),
          `error=${Boolean(detail?.error)} isError=${detail?.result?.isError ?? "-"}`,
        );

        const activity = await mcpD.request("tools/call", { name: "taskdock_agent_activity", arguments: { limit: 100 } });
        const acts = toolText(activity)?.items ?? [];
        record(
          "B5 项目 A 的 Agent 活动记录不含项目 B（MCP）",
          !mcpDenied(activity) && !acts.some((a) => a.project_id === PROJECT_B),
          `denied=${mcpDenied(activity)} items=${acts.length} projectB=${acts.filter((a) => a.project_id === PROJECT_B).length}`,
        );

        const resDecisions = await mcpD.request("resources/read", { uri: "taskdock://decisions" });
        const decisionBody = parseJson(resDecisions?.result?.contents?.[0]?.text);
        const decisions = Array.isArray(decisionBody) ? decisionBody : decisionBody?.decisions ?? [];
        record(
          "B6 资源 taskdock://decisions 只含项目 A 决策",
          !resDecisions?.error && Array.isArray(decisions) && decisions.length >= 1 && decisions.every((d) => d.project_id === PROJECT_A),
          `error=${Boolean(resDecisions?.error)} items=${Array.isArray(decisions) ? decisions.length : "-"} projects=${Array.isArray(decisions) ? [...new Set(decisions.map((d) => d.project_id))].join(",") : "-"}`,
        );
      } catch (err) {
        scenarioFailure("B3–B6 MCP 项目隔离", err);
      } finally {
        mcpD.close();
      }
    }

    // 只有 KB-A 授权的 Agent K 读知识索引资源
    {
      const mcpK = mcpSession(tokenK);
      try {
        const initK = await mcpK.request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "acceptance-v82-k", version: "1" },
        });
        mcpK.notify("notifications/initialized", {});
        log(`  B7 initialize: protocolVersion=${initK?.result?.protocolVersion ?? "-"} error=${JSON.stringify(initK?.error ?? null)}`);
        const res = await mcpK.request("resources/read", { uri: "taskdock://knowledge/index" });
        log(`  B7 resources/read error=${JSON.stringify(res?.error ?? null)}`);
        const body = parseJson(res?.result?.contents?.[0]?.text);
        const bases = Array.isArray(body?.bases) ? body.bases : [];
        const docs = Array.isArray(body?.documents) ? body.documents : [];
        const baseIds = new Set(bases.map((b) => b.id));
        const kbIds = new Set(docs.map((d) => d.kb_id));
        record(
          "B7 知识索引资源只含 KB-A，不含 KB-B（MCP）",
          !res?.error && baseIds.has(kbA) && !baseIds.has(kbB) && !kbIds.has(kbB),
          `error=${Boolean(res?.error)} msg=${res?.error?.message ?? "-"} bases=${[...baseIds].join(",")} docKbs=${[...kbIds].join(",")}`,
        );
      } catch (err) {
        scenarioFailure("B7 知识索引资源隔离", err);
      } finally {
        mcpK.close();
      }
    }
  }

  // ── D. 文件导入：人工批准（真实 Tauri 命令）──────────────────
  let cdpReady = false;
  try {
    const probe = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
    const targets = probe.ok ? await probe.json() : [];
    cdpReady = Array.isArray(targets) && targets.some((t) => t.type === "page");
  } catch {
    cdpReady = false;
  }

  if (!cdpReady) {
    record("D2 人工批准文件导入", false, `CDP 未就绪（port=${CDP_PORT}，BLOCKED）`);
    record("D3 批准后任务 +1", false, "D2 BLOCKED");
    record("D4 租约表与业务一致", false, "D2 BLOCKED");
    record("D5 重复投递同内容不重复创建", false, "D2 BLOCKED");
    record("D6 信任目录扫描为 skipped", false, "D2 BLOCKED");
  } else if (!importRequestId) {
    record("D2 人工批准文件导入", false, "D1 未产生待审核请求");
    record("D3 批准后任务 +1", false, "D2 前置缺失");
    record("D4 租约表与业务一致", false, "D2 前置缺失");
    record("D5 重复投递同内容不重复创建", false, "D2 前置缺失");
    record("D6 信任目录扫描为 skipped", false, "D2 前置缺失");
  } else {
    try {
      const tasksBeforeApprove = countTable("tasks");
      const invoke = cdpInvoke("agent_access_import_approve", { requestId: importRequestId, note: "v82 验收人工批准" });
      const req = dbGet("SELECT status, decided_hash, content_hash FROM agent_import_requests WHERE id = ?", importRequestId);
      const tasksAfter = countTable("tasks");
      const taskRow = dbGet("SELECT id, status FROM tasks WHERE title = ?", "v82 文件导入任务");
      record(
        "D2 人工批准导入（真实 Tauri 命令成功）",
        invoke.ok,
        `cdp.exit=${invoke.status} ok=${invoke.json?.ok} value=${JSON.stringify(invoke.json?.value ?? invoke.json?.error ?? "")?.slice(0, 200)}`,
      );
      record(
        "D3 批准后任务 +1 且请求置 imported",
        req?.status === "imported" && Boolean(taskRow?.id) && tasksAfter === tasksBeforeApprove + 1 && req?.decided_hash === importHash,
        `request=${req?.status} task=${taskRow?.id ?? "-"} decided_hash=${req?.decided_hash?.slice(0, 12) ?? "-"} hash=${importHash.slice(0, 12)} tasks ${tasksBeforeApprove}->${tasksAfter}`,
      );
      const claim = dbGet("SELECT status, owner, expires_at, attempt FROM agent_import_claims WHERE content_hash = ?", importHash);
      record(
        "D4 租约表状态与业务一致（ok / 租约已释放）",
        claim?.status === "ok" && !claim?.owner && claim?.expires_at === null && Number(claim?.attempt ?? 0) >= 1,
        `status=${claim?.status ?? "-"} owner="${claim?.owner ?? "-"}" expires=${claim?.expires_at ?? "null"} attempt=${claim?.attempt ?? "-"}`,
      );

      // 重复投递同内容：先无策略重扫，再信任目录重扫
      const tasksBeforeRescan = countTable("tasks");
      fs.writeFileSync(importFile, importBody, "utf8");
      const scanNoPolicy = cliLocal(["sync", "scan", "--json"]);
      const reqAfter = dbGet("SELECT status, content_hash FROM agent_import_requests WHERE id = ?", importRequestId);
      record(
        "D5 同内容重复投递再扫描不重复创建任务",
        scanNoPolicy.status === 0 && countTable("tasks") === tasksBeforeRescan && reqAfter?.status === "imported",
        `exit=${scanNoPolicy.status} imported=${scanNoPolicy.json?.data?.imported ?? "-"} pending=${scanNoPolicy.json?.data?.pending_review ?? "-"} tasks=${countTable("tasks")} request=${reqAfter?.status ?? "-"}`,
      );

      const wsRow = dbGet("SELECT id FROM agent_workspaces ORDER BY created_at DESC LIMIT 1");
      dbRun(
        `INSERT OR REPLACE INTO agent_import_policies
           (id, workspace_row_id, rel_dir, mode, agent_row_id, capabilities, project_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        crypto.randomUUID(),
        wsRow.id,
        "inbox",
        "trusted",
        null,
        JSON.stringify(["tasks.write"]),
        "",
        new Date().toISOString(),
        new Date().toISOString(),
      );
      const scanTrusted = cliLocal(["sync", "scan", "--json"]);
      const s = scanTrusted.json?.data ?? {};
      record(
        "D6 信任目录重扫为 skipped/已导入（幂等租约生效）",
        scanTrusted.status === 0 && (s.imported ?? 0) === 0 && (s.skipped ?? 0) >= 1 && countTable("tasks") === tasksBeforeRescan,
        `exit=${scanTrusted.status} imported=${s.imported} skipped=${s.skipped} tasks=${countTable("tasks")}`,
      );
    } catch (err) {
      scenarioFailure("D2–D6 文件导入人工批准", err);
    }
  }

  // ── 收尾：停止 GUI 并验证端口释放 ──────────────────────────────
  stopGui();
  try {
    if (restReady) {
      const closed = await waitPortClosed(REST_PORT, 20000);
      record("C8 REST 服务停止后端口释放", closed, `port=${REST_PORT}`);
    } else {
      record("C8 REST 服务停止后端口释放", false, "REST 未就绪（BLOCKED）");
    }
  } catch (err) {
    scenarioFailure("C8 端口释放", err);
  }
  try {
    const cdpClosed = await waitPortClosed(CDP_PORT, 15000);
    log(`CDP 端口 ${CDP_PORT} 释放：${cdpClosed}`);
  } catch {
    /* CDP 端口释放仅记录 */
  }

  // 额外元数据：settings、DB 统计
  log(`最终 DB 统计：tasks=${countTable("tasks")} decisions=${countTable("agent_decisions")} handoffs=${countTable("agent_handoffs")} reports=${countTable("agent_work_reports")} imports=${countTable("agent_import_requests")}`);

  return finish(scriptStarted, false);
}

// ── 汇总输出 ──────────────────────────────────────────────────────
function finish(scriptStarted, blocked) {
  const endedAt = new Date();
  const failed = results.filter((r) => !r.ok);
  log(`\n合计：${results.length - failed.length}/${results.length} 通过；失败 ${failed.length}；日志：${LOG}`);

  fs.writeFileSync(LOG, lines.join("\n"), "utf8");

  const gitHead = runSync("git", ["rev-parse", "HEAD"], { timeout: 15000 });
  const gitStatus = runSync("git", ["status", "--porcelain"], { timeout: 20000 });
  const statusLines = gitStatus.status === 0 ? gitStatus.stdout.split("\n").filter(Boolean) : [];
  const binStat = fs.existsSync(TASK_DOCK) ? fs.statSync(TASK_DOCK) : null;

  const md = [];
  md.push(`# Agent 共享工作空间 v82 验收摘要`);
  md.push("");
  md.push(`- 执行时间（开始）：${startedAt.toISOString()}`);
  md.push(`- 执行时间（结束）：${endedAt.toISOString()}`);
  md.push(`- 命令：\`node scripts/acceptance-agent-access-v82.mjs --bin ${path.relative(REPO_ROOT, BIN) || "."}\``);
  md.push(`- 退出码：${failed.length === 0 && !blocked ? 0 : 1}`);
  md.push(`- Git HEAD：${gitHead.status === 0 ? gitHead.stdout : "（不可用）"}`);
  md.push(`- 工作区 dirty 文件数：${statusLines.length}`);
  md.push(`- 二进制：${TASK_DOCK}${binStat ? `（mtime=${binStat.mtime.toISOString()}，size=${binStat.size}）` : ""}`);
  md.push(`- 隔离数据目录：${DATA}`);
  md.push(`- 数据库：${DB_PATH}`);
  md.push(`- REST 端口：${REST_PORT ?? "-"}；CDP 端口：${CDP_PORT ?? "-"}`);
  md.push(`- 结论：${failed.length === 0 && !blocked ? "Dev 功能验收通过（全部断言通过）" : blocked ? "证据不足 / 环境阻塞" : "Dev 功能验收部分通过（存在失败项）"}`);
  md.push("");
  md.push(`## 结果统计`);
  md.push("");
  md.push(`- 通过：${results.length - failed.length}/${results.length}`);
  md.push(`- 失败：${failed.length}`);
  md.push("");
  if (failed.length > 0) {
    md.push(`## 失败清单`);
    md.push("");
    for (const f of failed) {
      md.push(`- ${f.name}：${f.detail}`);
    }
    md.push("");
  }
  md.push(`## 明细`);
  md.push("");
  md.push(`| 结果 | 检查项 | 证据 |`);
  md.push(`|---|---|---|`);
  for (const r of results) {
    md.push(`| ${r.ok ? "PASS" : "FAIL"} | ${r.name.replaceAll("|", "\\|")} | ${String(r.detail).replaceAll("|", "\\|")} |`);
  }
  md.push("");
  md.push(`## 未覆盖项与边界`);
  md.push("");
  md.push(`- 本次为 Dev 功能验收（Debug 二进制 + 隔离数据目录），不构成 Release 安装包 / 升级 / 性能结论。`);
  md.push(`- 文件导入的"人工批准"通过真实 Tauri 命令（CDP → window.__TAURI_INTERNALS__.invoke）执行，桌面窗口会短暂打开。`);
  md.push(`- REST 活动记录按设计为服务端过滤（返回 200 且不含项目 B），不是 403；决策读取为 403。`);
  md.push(`- 未覆盖：真实安装包、签名、升级链路、性能与内存基线。`);
  md.push("");
  md.push(`## 真实证据路径`);
  md.push("");
  md.push(`- acceptance.log：${LOG}`);
  md.push(`- gui.log / gui.err：${ROOT}`);
  md.push(`- summary.md：${SUMMARY}`);
  fs.writeFileSync(SUMMARY, md.join("\n"), "utf8");

  fs.writeFileSync(LOG, lines.join("\n"), "utf8");
  process.exit(failed.length === 0 && !blocked ? 0 : 1);
}

main().catch((err) => {
  log(`脚本异常：${err?.stack || err}`);
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(LOG, lines.join("\n"), "utf8");
  } catch {
    /* 忽略 */
  }
  stopGui();
  process.exit(2);
});
