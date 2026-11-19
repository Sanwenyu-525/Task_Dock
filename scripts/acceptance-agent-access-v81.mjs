/**
 * Agent 共享工作空间 v81 端到端验收脚本（A–F 场景）。
 *
 * 用法：node scripts/acceptance-agent-access-v81.mjs [--bin <目录>] [--keep]
 * 依赖：构建产物 task-dock.exe / taskdock.exe；使用独立的 TASK_DOCK_DATA_DIR 与
 * 独立工作空间目录，不触碰真实用户数据。
 */
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.resolve(
  process.env.ACC_ROOT || (() => {
    const i = args.indexOf("--root");
    return i >= 0 ? args[i + 1] : "tmp/acceptance/agent-access-v81";
  })(),
);
const DATA = path.join(ROOT, "data");
const WS = path.join(ROOT, "workspace");
const DB_PATH = path.join(DATA, "task-dock.db");
const LOG = path.join(ROOT, "acceptance.log");

const args = process.argv.slice(2);
const binIdx = args.indexOf("--bin");
const BIN = binIdx >= 0 ? path.resolve(args[binIdx + 1]) : path.resolve("src-tauri/target/release");
const TASK_DOCK = path.join(BIN, "task-dock.exe");
const TASKDOCK = path.join(BIN, "taskdock.exe");

const lines = [];
function log(...parts) {
  const text = parts.join(" ");
  lines.push(text);
  console.log(text);
}
function record(name, ok, detail) {
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  results.push({ name, ok, detail: detail ?? "" });
}
const results = [];

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function cli(argsList, { env = {}, expectFail = false } = {}) {
  const r = spawnSync(TASKDOCK, argsList, {
    env: { ...process.env, TASKDOCK_DB_PATH: DB_PATH, ...env },
    encoding: "utf8",
    windowsHide: true,
  });
  const out = (r.stdout || "").trim();
  let json = null;
  try {
    json = JSON.parse(out);
  } catch {
    /* 非 JSON 输出 */
  }
  if (!expectFail && r.status !== 0) {
    log(`  ! cli ${argsList.join(" ")} 退出码 ${r.status}\n    stdout=${out.slice(0, 300)}\n    stderr=${(r.stderr || "").slice(0, 300)}`);
  }
  return { code: r.status, stdout: out, stderr: r.stderr || "", json };
}

function db() {
  return new DatabaseSync(DB_PATH);
}

function seedAgentsSafe() {
  const d = db();
  const now = new Date().toISOString();
  const agents = [
    { row: "agent-a", id: "acc-a", token: "tdm_acc_a", scope: "project_rw", caps: ["tasks.read", "tasks.write", "context.read", "handoffs.read", "handoffs.write"] },
    { row: "agent-b", id: "acc-b", token: "tdm_acc_b", scope: "project_rw", caps: ["knowledge.read", "knowledge.write", "decisions.read", "decisions.write", "handoffs.read", "handoffs.write", "context.read"] },
    { row: "agent-c", id: "acc-c", token: "tdm_acc_c", scope: "project_rw", caps: ["tasks.read", "tasks.write", "knowledge.read", "decisions.read", "handoffs.read", "context.read", "projects.read", "plans.read"] },
    { row: "agent-ro", id: "acc-ro", token: "tdm_acc_ro", scope: "readonly", caps: ["tasks.read", "context.read"] },
  ];
  const ins = d.prepare(
    `INSERT OR REPLACE INTO mcp_agents (id, agent_id, display_name, token_hash, scope, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const cap = d.prepare(
    `INSERT OR REPLACE INTO mcp_agent_capabilities (id, agent_row_id, capability, resource_id, created_at)
     VALUES (?, ?, ?, '', ?)`,
  );
  for (const a of agents) {
    ins.run(a.row, a.id, a.id, sha256(a.token), a.scope, now, now);
    for (const c of a.caps) cap.run(crypto.randomUUID(), a.row, c, now);
  }
  d.close();
  return agents;
}

function taskCount() {
  const d = db();
  const n = d.prepare("SELECT COUNT(*) AS n FROM tasks").get().n;
  d.close();
  return n;
}
function decisionCount() {
  const d = db();
  const n = d.prepare("SELECT COUNT(*) AS n FROM agent_decisions").get().n;
  d.close();
  return n;
}
function activityRows(agentId) {
  const d = db();
  const rows = d
    .prepare("SELECT action, resource_kind, success, error_code FROM agent_activity_logs WHERE agent_id = ? ORDER BY created_at")
    .all(agentId);
  d.close();
  return rows;
}

function setSetting(key, value) {
  const d = db();
  d.prepare("INSERT OR REPLACE INTO application_settings (key, value, updated_at) VALUES (?, ?, ?)").run(key, value, new Date().toISOString());
  d.close();
}
function getSetting(key) {
  const d = db();
  const row = d.prepare("SELECT value FROM application_settings WHERE key = ?").get(key);
  d.close();
  return row?.value ?? null;
}

async function waitForPort(port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/status`);
      if (res.status) return true;
    } catch {
      /* 等待 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function rest(pathname, { method = "GET", token, body, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${REST_PORT}${pathname}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 无 JSON */
  }
  return { status: res.status, json };
}

const REST_PORT = 47933;


/** MCP stdio 客户端：按 id 匹配 JSON-RPC 响应。 */
function mcpSession(token) {
  const proc = spawn(TASK_DOCK, ["--mcp-server"], {
    env: { ...process.env, TASK_DOCK_DATA_DIR: DATA, TASKDOCK_MCP_TOKEN: token },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const pending = new Map();
  let buffer = "";
  let nextId = 1;
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let stderr = "";
  proc.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
  function request(method, params, timeoutMs = 20000) {
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ timeout: true, stderr });
      }, timeoutMs);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  function notify(method, params) {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  function close() {
    try { proc.stdin.end(); } catch { /* 忽略 */ }
    try { proc.kill(); } catch { /* 忽略 */ }
  }
  return { request, notify, close, get stderr() { return stderr; } };
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(WS, { recursive: true });

  // 0) 初始化独立数据库（无头模式，只开库不启窗口）
  const init = spawnSync(TASK_DOCK, ["--agentctl", "scan"], {
    env: { ...process.env, TASK_DOCK_DATA_DIR: DATA },
    encoding: "utf8",
    windowsHide: true,
  });
  record(
    "隔离数据库初始化（--agentctl 无头）",
    init.status === 0 && fs.existsSync(DB_PATH),
    `exit=${init.status} db=${fs.existsSync(DB_PATH)}`,
  );
  if (!fs.existsSync(DB_PATH)) {
    log("数据库未生成，终止");
    return;
  }
  const agents = seedAgentsSafe();
  record("注册 4 个测试 Agent（含 token 与能力授权）", agents.length === 4, agents.map((a) => a.id).join(","));

  // ── A. CLI Agent ─────────────────────────────────────────────
  const create = cli(["task", "create", "--title", "验收任务A", "--description", "端到端验收", "--json"], {
    env: { TASKDOCK_AGENT_TOKEN: "tdm_acc_a" },
  });
  const created = create.json?.data;
  record(
    "A1 CLI 以 Agent 身份创建任务",
    create.code === 0 && created?.id,
    `exit=${create.code} id=${created?.id ?? "-"} rev=${created?.revision ?? "-"}`,
  );
  const taskId = created?.id;

  const got = cli(["task", "get", taskId, "--json"], { env: { TASKDOCK_AGENT_TOKEN: "tdm_acc_a" } });
  const revision = got.json?.data?.revision;
  record("A2 CLI 查询任务与 revision", got.code === 0 && typeof revision === "number", `rev=${revision}`);

  const updated = cli(["task", "update", taskId, "--base-revision", String(revision), "--title", "验收任务A-已更新", "--json"], {
    env: { TASKDOCK_AGENT_TOKEN: "tdm_acc_a" },
  });
  record(
    "A3 CLI 带 base-revision 更新任务",
    updated.code === 0 && updated.json?.data?.title === "验收任务A-已更新",
    `exit=${updated.code} title=${updated.json?.data?.title ?? "-"}`,
  );

  const stale = cli(["task", "update", taskId, "--base-revision", String(revision), "--title", "过期版本写入", "--json"], {
    env: { TASKDOCK_AGENT_TOKEN: "tdm_acc_a" },
    expectFail: true,
  });
  record(
    "A4 CLI 过期 revision 被拒绝（CONFLICT）",
    stale.code === 5 && stale.json?.error?.code === "CONFLICT",
    `exit=${stale.code} code=${stale.json?.error?.code ?? "-"}`,
  );

  const done = cli(["task", "complete", taskId, "--base-revision", String(updated.json?.data?.revision), "--json"], {
    env: { TASKDOCK_AGENT_TOKEN: "tdm_acc_a" },
  });
  record("A5 CLI 完成任务", done.code === 0, `exit=${done.code} status=${done.json?.data?.status ?? "-"}`);

  const denied = cli(["task", "create", "--title", "只读 Agent 不能建任务", "--json"], {
    env: { TASKDOCK_AGENT_TOKEN: "tdm_acc_ro" },
    expectFail: true,
  });
  record(
    "A6 只读 Agent 写操作被拒绝（FORBIDDEN）",
    denied.code === 6 && denied.json?.error?.code === "FORBIDDEN",
    `exit=${denied.code} code=${denied.json?.error?.code ?? "-"}`,
  );

  const acts = activityRows("acc-a");
  record(
    "A7 操作审计已写入（区分 Agent 与来源）",
    acts.length >= 3 && acts.some((r) => r.action === "task.create"),
    `审计条数=${acts.length}`,
  );

  // ── B. File Agent ────────────────────────────────────────────
  const wsInit = cli(["sync", "init", "--path", WS, "--name", "验收工作空间", "--json"]);
  record("B1 初始化隔离工作空间", wsInit.code === 0, `exit=${wsInit.code}`);

  const inbox = path.join(WS, "inbox");
  fs.mkdirSync(inbox, { recursive: true });
  const writeInboxFiles = () => {
  fs.writeFileSync(
    path.join(inbox, "task.json"),
    JSON.stringify({ schema: "taskdock.import/1", kind: "task.create", payload: { title: "文件导入任务B" } }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(inbox, "decision.json"),
    JSON.stringify({ schema: "taskdock.import/1", kind: "decision.create", payload: { title: "越权决策B", decision: "x" } }),
    "utf8",
  );
  };
  writeInboxFiles();
  const before = taskCount();
  const scan1 = cli(["sync", "scan", "--json"]);
  const s1 = scan1.json?.data;
  record(
    "B2 默认策略下文件导入进入待审核（不写业务表）",
    scan1.code === 0 && s1?.pending_review === 2 && s1?.imported === 0 && taskCount() === before,
    `pending_review=${s1?.pending_review} imported=${s1?.imported} tasks=${taskCount()}`,
  );

  // 目录策略：trusted + tasks.write
  const d = db();
  const wsRow = d.prepare("SELECT id FROM agent_workspaces WHERE enabled = 1 LIMIT 1").get();
  d.prepare(
    `INSERT OR REPLACE INTO agent_import_policies (id, workspace_row_id, rel_dir, mode, agent_row_id, capabilities, project_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
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
  d.close();
  const beforeTrusted = taskCount();
  const decisionsBefore = decisionCount();
  const scan2 = cli(["sync", "scan", "--json"]);
  const s2 = scan2.json?.data;
  record(
    "B3 受信任目录导入任务成功",
    scan2.code === 0 && s2?.imported === 1 && taskCount() === beforeTrusted + 1,
    `imported=${s2?.imported} tasks=${taskCount()}`,
  );
  record(
    "B4 目录策略只含 tasks.write 时，决策导入被拒绝",
    decisionCount() === decisionsBefore && (s2?.failed ?? 0) >= 1,
    `failed=${s2?.failed} decisions=${decisionCount()}`,
  );

  const scan3 = cli(["sync", "scan", "--json"]);
  record(
    "B5 重复扫描不产生重复任务（幂等）",
    (scan3.json?.data?.imported ?? 0) === 0 && taskCount() === beforeTrusted + 1,
    `imported=${scan3.json?.data?.imported} tasks=${taskCount()}`,
  );

  const exportRun = cli(["sync", "export", "--json"]);
  record("B6 导出快照成功", exportRun.code === 0, `exit=${exportRun.code}`);

  // ── F. 并发写入 ──────────────────────────────────────────────
  const revF = cli(["task", "get", taskId, "--json"], { env: { TASKDOCK_AGENT_TOKEN: "tdm_acc_c" } })?.json?.data?.revision;
  const updC = cli(["task", "update", taskId, "--base-revision", String(revF), "--title", "AgentC 更新", "--json"], {
    env: { TASKDOCK_AGENT_TOKEN: "tdm_acc_c" },
  });
  const staleB = cli(["task", "update", taskId, "--base-revision", String(revF), "--title", "过期覆盖", "--json"], {
    env: { TASKDOCK_AGENT_TOKEN: "tdm_acc_a" },
    expectFail: true,
  });
  const finalTask = cli(["task", "get", taskId, "--json"], { env: { TASKDOCK_AGENT_TOKEN: "tdm_acc_c" } })?.json?.data;
  record(
    "F1 两个 Agent 并发：先到者成功、后到者被拒（CONFLICT）",
    updC.code === 0 && staleB.code === 5 && finalTask?.title === "AgentC 更新",
    `c=${updC.code} b=${staleB.code} title=${finalTask?.title}`,
  );

  // ── D. REST Agent ────────────────────────────────────────────
  setSetting("agent_api_enabled", "true");
  setSetting("agent_api_port", String(REST_PORT));
  setSetting("mcp_server_enabled", "true");
  const gui = spawn(TASK_DOCK, [], {
    env: { ...process.env, TASK_DOCK_DATA_DIR: DATA },
    stdio: ["ignore", fs.openSync(path.join(ROOT, "gui.log"), "a"), fs.openSync(path.join(ROOT, "gui.err"), "a")],
    detached: true,
    windowsHide: true,
  });
  let restReady = false;
  try {
    restReady = await waitForPort(REST_PORT, 40000);
  } catch {
    restReady = false;
  }
  record("D1 REST 监听就绪（真实端口绑定）", restReady, `port=${REST_PORT}`);

  if (restReady) {
    const noAuth = await rest("/api/v1/tasks");
    record("D2 未认证返回 401", noAuth.status === 401, `status=${noAuth.status}`);

    const noPerm = await rest("/api/v1/tasks", { token: "tdm_acc_b" });
    record("D3 无任务权限返回 403", noPerm.status === 403, `status=${noPerm.status}`);

    const okList = await rest("/api/v1/tasks", { token: "tdm_acc_c" });
    record("D4 授权查询成功", okList.status === 200 && Array.isArray(okList.json?.data), `status=${okList.status}`);

    const createdRest = await rest("/api/v1/tasks", {
      method: "POST",
      token: "tdm_acc_c",
      body: { title: "REST 任务D" },
      headers: { "idempotency-key": "acc-key-1" },
    });
    const restId = createdRest.json?.data?.id;
    record("D5 REST 创建任务成功", createdRest.status === 201 && restId, `status=${createdRest.status} id=${restId ?? "-"}`);

    const replay = await rest("/api/v1/tasks", {
      method: "POST",
      token: "tdm_acc_c",
      body: { title: "REST 任务D" },
      headers: { "idempotency-key": "acc-key-1" },
    });
    record(
      "D6 幂等重放返回同一结果且标记 replayed",
      replay.status === 201 && replay.json?.meta?.replayed === true,
      `status=${replay.status} replayed=${replay.json?.meta?.replayed}`,
    );

    const conflict = await rest(`/api/v1/tasks/${restId}`, {
      method: "PATCH",
      token: "tdm_acc_c",
      body: { base_revision: 999, title: "过期写入" },
    });
    record("D7 版本冲突返回 409", conflict.status === 409, `status=${conflict.status}`);

    // Token 撤销
    const d2 = db();
    d2.prepare("UPDATE mcp_agents SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), "agent-c");
    d2.close();
    const revoked = await rest("/api/v1/tasks", { token: "tdm_acc_c" });
    record("D8 Token 撤销后返回 401", revoked.status === 401, `status=${revoked.status}`);
  }


  // ── C. MCP Agent ─────────────────────────────────────────────
  if (restReady) {
    // MCP bridge 比 REST 晚就绪：等待 mcp-transport.json 写出 enabled=true
    const transportFile = path.join(DATA, "mcp-transport.json");
    const bridgeReady = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 30000) {
        try {
          const raw = JSON.parse(fs.readFileSync(transportFile, "utf8"));
          if (raw?.enabled) return true;
        } catch { /* 尚未写出 */ }
        await new Promise((r) => setTimeout(r, 300));
      }
      return false;
    })();
    record("C0 MCP bridge 已就绪（transport enabled）", bridgeReady, transportFile);
    // D8 已撤销 agent-c：MCP 场景前恢复该身份（撤销证据已在 D8 记录）
    const d3 = db();
    d3.prepare("UPDATE mcp_agents SET revoked_at = NULL WHERE id = ?").run("agent-c");
    d3.close();
    const mcp = mcpSession("tdm_acc_c");
    const init = await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "acceptance", version: "1" } });
    const transport = fs.existsSync(path.join(DATA, "mcp-transport.json"))
      ? fs.readFileSync(path.join(DATA, "mcp-transport.json"), "utf8")
      : "(无)";
    record(
      "C1 MCP initialize",
      Boolean(init?.result?.protocolVersion),
      `protocolVersion=${init?.result?.protocolVersion ?? "-"} transport=${transport} stderr=${(mcp.stderr || "").slice(0, 200)}`,
    );
    mcp.notify("notifications/initialized", {});
    const tools = await mcp.request("tools/list", {});
    const toolNames = (tools?.result?.tools ?? []).map((t) => t.name);
    record("C2 MCP tools/list", Array.isArray(toolNames) && toolNames.length > 0, `工具数=${toolNames.length}`);
    const resources = await mcp.request("resources/list", {});
    record(
      "C3 MCP resources/list",
      Array.isArray(resources?.result?.resources),
      `资源数=${resources?.result?.resources?.length ?? "-"}`,
    );
    const prompts = await mcp.request("prompts/list", {});
    record("C4 MCP prompts/list", prompts?.result !== undefined, `prompts=${prompts?.result?.prompts?.length ?? "-"}`);

    const createTool = toolNames.find((n) => n.includes("task") && n.includes("create"));
    if (createTool) {
      const call = await mcp.request("tools/call", {
        name: createTool,
        arguments: { title: "MCP 创建的任务" },
      });
      record("C5 MCP 创建任务", Boolean(call?.result), `tool=${createTool}`);
    } else {
      record("C5 MCP 创建任务", false, `未找到创建任务工具：${toolNames.join(",")}`);
    }

    const deniedMcp = mcpSession("tdm_acc_ro");
    const deniedTools = await deniedMcp.request("tools/list", {});
    const roNames = (deniedTools?.result?.tools ?? []).map((t) => t.name);
    const writeTool = roNames.find((n) => n.includes("task") && n.includes("create"));
    let deniedResult = null;
    if (writeTool) {
      deniedResult = await deniedMcp.request("tools/call", {
        name: writeTool,
        arguments: { title: "只读 MCP 不应能创建" },
      });
    }
    record(
      "C6 只读 Agent 的 MCP 写操作被拒绝",
      Boolean(deniedResult?.result?.isError) || Boolean(deniedResult?.error),
      `tool=${writeTool ?? "-"} isError=${deniedResult?.result?.isError ?? "-"}`,
    );
    deniedMcp.close();
    mcp.close();
  }

  // ── E. 双 Agent 交接 ─────────────────────────────────────────
  const handoff = cli(
    ["agent", "handoff", "create", "--to", "acc-b", "--summary", "交接给 B", "--json"],
    { env: { TASKDOCK_AGENT_TOKEN: "tdm_acc_a" } },
  );
  const handoffId = handoff.json?.data?.handoff?.id;
  record("E1 Agent A 创建交接", handoff.code === 0 && handoffId, `exit=${handoff.code} id=${handoffId ?? "-"}`);

  if (handoffId) {
    const acceptWrong = cli(["agent", "handoff", "accept", handoffId, "--base-revision", "1", "--json"], {
      env: { TASKDOCK_AGENT_TOKEN: "tdm_acc_c" },
      expectFail: true,
    });
    record(
      "E2 无关 Agent C 不能接收交接",
      acceptWrong.code === 6 || acceptWrong.code === 4,
      `exit=${acceptWrong.code} code=${acceptWrong.json?.error?.code ?? "-"}`,
    );
    const acceptRight = cli(["agent", "handoff", "accept", handoffId, "--base-revision", "1", "--json"], {
      env: { TASKDOCK_AGENT_TOKEN: "tdm_acc_b" },
    });
    record("E3 目标 Agent B 可以接收交接", acceptRight.code === 0, `exit=${acceptRight.code}`);
    const report = cli(
      ["agent", "report", "create", "--summary", "B 的工作报告", "--result", "completed", "--handoff", handoffId, "--json"],
      { env: { TASKDOCK_AGENT_TOKEN: "tdm_acc_b" } },
    );
    record("E4 Agent B 提交工作报告", report.code === 0, `exit=${report.code}`);
    const list = cli(["agent", "report", "list", "--handoff", handoffId, "--json"], {
      env: { TASKDOCK_AGENT_TOKEN: "tdm_acc_a" },
    });
    record(
      "E5 Agent C 可查看授权范围内的报告",
      list.code === 0 && Array.isArray(list.json?.data) && list.json.data.length >= 1,
      `exit=${list.code} count=${list.json?.data?.length ?? "-"}`,
    );
  }

  // 收尾：关闭 GUI 进程
  try {
    if (gui?.pid) process.kill(-gui.pid);
  } catch {
    /* 忽略 */
  }

  fs.writeFileSync(LOG, lines.join("\n"), "utf8");
  const failed = results.filter((r) => !r.ok);
  log(`\n合计：${results.length - failed.length}/${results.length} 通过；日志：${LOG}`);
  if (!args.includes("--keep")) {
    /* 保留目录以便复核证据 */
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  log(`脚本异常：${err?.stack || err}`);
  fs.writeFileSync(LOG, lines.join("\n"), "utf8");
  process.exit(2);
});
