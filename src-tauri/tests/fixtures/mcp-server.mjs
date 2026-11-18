#!/usr/bin/env node
// 真实 stdio MCP Server 测试夹具（仅测试使用，不打包）。
//
// 模式（MCP_FIXTURE_MODE）：
// - modern（默认）：只支持 2026-07-28（server/discover）；收到 initialize 返回 -32601；
// - legacy：只支持 2025-11-25（不实现 server/discover，回退 initialize）；
// - pagination_limit：tools/list 永远返回 nextCursor，用于验证 64 页上限。
//
// 可选：MCP_FIXTURE_PIDFILE 写入当前 PID，供测试验证超时后进程被回收。

import fs from "node:fs";
import readline from "node:readline";

const mode = process.argv[2] || process.env.MCP_FIXTURE_MODE || "modern";
const pidFile = process.argv[3] || process.env.MCP_FIXTURE_PIDFILE;
if (pidFile) {
  fs.writeFileSync(pidFile, String(process.pid));
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const tools = [
  {
    name: "echo",
    description: "Echo arguments back",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  {
    name: "slow",
    description: "Sleep for a while",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fail",
    description: "Always returns isError",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write_file",
    description: "Write a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    annotations: { destructiveHint: true, readOnlyHint: false },
  },
  {
    name: "search",
    description: "Find something",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  },
];

const resources = [
  { uri: "file:///fixture/readme.md", name: "readme", description: "Fixture readme", mimeType: "text/markdown" },
  { uri: "file:///fixture/data.json", name: "data", description: "Fixture data", mimeType: "application/json" },
];

const prompts = [
  {
    name: "summarize",
    description: "Summarize a text",
    arguments: [{ name: "text", description: "Text to summarize", required: true }],
  },
];

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (!method) return;

  if (method === "server/discover") {
    if (mode === "legacy") {
      error(id, -32601, "Method not found: server/discover");
      return;
    }
    result(id, {
      protocolVersion: "2026-07-28",
      supportedVersions: ["2026-07-28", "2025-06-18"],
      serverInfo: { name: "fixture-server", version: "1.0.0", mode },
    });
    return;
  }

  if (method === "initialize") {
    if (mode === "modern") {
      error(id, -32601, "Method not found: initialize (modern only)");
      return;
    }
    result(id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "fixture-server", version: "1.0.0", mode },
    });
    return;
  }

  if (method.startsWith("notifications/")) return;

  if (method === "tools/list") {
    if (mode === "pagination_limit") {
      result(id, { tools: [tools[0]], nextCursor: "again" });
      return;
    }
    if (!params || !params.cursor) {
      result(id, { tools: tools.slice(0, 4), nextCursor: "page-2" });
      return;
    }
    result(id, { tools: tools.slice(4) });
    return;
  }

  if (method === "resources/list") {
    if (!params || !params.cursor) {
      result(id, { resources: resources.slice(0, 1), nextCursor: "res-2" });
      return;
    }
    result(id, { resources: resources.slice(1) });
    return;
  }

  if (method === "prompts/list") {
    result(id, { prompts });
    return;
  }

  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name === "echo") {
      result(id, { content: [{ type: "text", text: JSON.stringify(args) }], isError: false });
      return;
    }
    if (name === "slow") {
      setTimeout(() => {
        result(id, { content: [{ type: "text", text: "finally" }], isError: false });
      }, 10000);
      return;
    }
    if (name === "fail") {
      result(id, { content: [{ type: "text", text: "boom" }], isError: true });
      return;
    }
    if (name === "write_file") {
      result(id, { content: [{ type: "text", text: "written" }], isError: false });
      return;
    }
    if (name === "search") {
      result(id, { content: [{ type: "text", text: "found" }], isError: false });
      return;
    }
    error(id, -32602, `Unknown tool: ${name}`);
    return;
  }

  error(id, -32601, `Method not found: ${method}`);
});
