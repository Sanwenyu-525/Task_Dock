/**
 * 文件工作区 · R14 结构化预览（CSV/TSV 表格视图 + JSON 树形视图）Dev 桌面验收。
 *
 * 用法：node scripts/acceptance-files-structured-preview.mjs [--keep]
 *
 * 前置：`src-tauri/target/debug/task-dock.exe` 已包含当前代码。
 *      Vite 1420 **复用**（用户已打开的 dev server）；只有检测不到 1420 时才由本脚本启动，
 *      且只关闭自己启动的进程。
 *
 * 隔离：数据目录 `tmp/acceptance/files-workspace/round14/run-<stamp>/data`，
 *      WebView2 缓存同目录 `webview/`，不触碰真实用户数据。
 * 证据：同目录 `screenshots/*.png`、`summary.md`、`acceptance.log`、`gui.log`。
 *
 * 覆盖（FW-PREVIEW-005 的 Dev 验收清单）：
 *  1) 文件工作区按持久化布局直达目录，6 个夹具文件全部列出
 *  2) CSV 选中 → 预览弹窗 → 表格视图（表头/行数/首格内容）
 *  3) 表头开关：关闭后首行降为数据行
 *  4) 源码模式：结构化视图隐藏、文件内查找出现（CSV 不提供查找）
 *  5) JSON 树形视图：根默认展开、展开全部后行数增长、节点/深度 chip
 *  6) 非法 JSON：回退源码 + 警告 chip + 树形按钮禁用（不留半成品树）
 *  7) TSV：Tab 分隔符嗅探（meta chip 为 Tab）
 *  8) 超大 CSV：渲染上限提示（600 行 × 40 列）且不冻结
 *  9) Markdown 回归：阅读模式保留查找框
 * 10) 控制台/页面错误为空
 *
 * 说明：宽度走查用 CDP 视口（Playwright setViewportSize），与既有验收一致；
 *      系统 DPI / 多显示器 / 真实滚动帧率不在本脚本范围（见 summary「未验证」）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { chromium } from "playwright";

const KEEP = process.argv.includes("--keep");
const REPO = path.resolve(".");
const EXE = path.join(REPO, "src-tauri", "target", "debug", "task-dock.exe");
const ROUND = path.join(REPO, "tmp", "acceptance", "files-workspace", "round14");
const FIXTURES = path.join(ROUND, "fixtures");
const stamp = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
})();
const ROOT = path.join(ROUND, `run-${stamp}`);
const DATA = path.join(ROOT, "data");
const WEBVIEW = path.join(ROOT, "webview");
const SHOTS = path.join(ROOT, "screenshots");
const LOG = path.join(ROOT, "acceptance.log");
const SUMMARY = path.join(ROOT, "summary.md");

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(WEBVIEW, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(FIXTURES, { recursive: true });

const results = [];
let gui = null;
let vite = null;
let viteOwned = false;
let browser = null;
let page = null;
let CDP_PORT = 0;
let viewport = null;
let navInfo = null;

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  fs.appendFileSync(LOG, `${line}\n`);
  console.log(line);
}

function record(name, ok, detail, shot) {
  results.push({ name, ok, detail, shot: shot ?? null });
  log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
}

async function shot(name) {
  if (!page) return null;
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file }).catch(() => null);
  return fs.existsSync(file) ? file : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, { timeout = 20000, interval = 250, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await sleep(interval);
  }
  throw new Error(`waitFor 超时（${label}）${lastErr ? `: ${String(lastErr.message ?? lastErr)}` : ""}`);
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(1500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function freePort(start) {
  for (let port = start; port < start + 40; port += 1) {
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(true));
      });
    });
    if (available) return port;
  }
  throw new Error(`找不到可用端口（从 ${start} 起 40 个）`);
}

// ── 夹具（每次运行重写，保证内容固定）─────────────────────────────────────────
function writeFixtures() {
  const products = [];
  products.push("sku,name,city,price,note,stock");
  for (let i = 1; i <= 12; i += 1) {
    const name = i === 3 ? '"机械键盘, 87 键"' : `"示例商品 ${i}"`;
    const city = i === 5 ? '"杭州, 余杭"' : i % 2 ? "杭州" : "上海";
    const note = i === 7 ? '"含\n换行的备注"' : i === 9 ? "" : `备注${i}`;
    products.push(`${`SKU-${String(i).padStart(3, "0")}`},${name},${city},${i * 19.9},${note},${i * 3}`);
  }
  fs.writeFileSync(path.join(FIXTURES, "01-products.csv"), `${products.join("\n")}\n`, "utf8");

  const metrics = [];
  metrics.push("date\tregion\tp50_ms\tp95_ms\tsamples");
  for (let i = 1; i <= 8; i += 1) {
    metrics.push(`2026-11-${String(i + 10).padStart(2, "0")}\t${i % 2 ? "华东" : "华南"}\t${i * 12}\t${i * 40}\t${i * 100}`);
  }
  fs.writeFileSync(path.join(FIXTURES, "02-metrics.tsv"), `${metrics.join("\n")}\n`, "utf8");

  const config = {
    项目: "task_dock",
    名称: "文件工作区 R14",
    版本: { 主: 0, 次: 5, 修订: 0 },
    开关: { 预览检查器: true, 结构化视图: true, 实验项: false },
    模块: [
      { id: "preview", 语言: ["ts", "css"], 依赖: [], 权重: 1 },
      { id: "csv", 语言: ["ts"], 依赖: ["preview"], 权重: 2 },
      { id: "json", 语言: ["ts"], 依赖: ["preview"], 权重: 3 },
    ],
    空值: null,
    注释: "含中文与 emoji 🎯 的标量",
    深层: { a: { b: { c: { d: [1, 2, 3, { e: "底" }] } } } },
  };
  fs.writeFileSync(
    path.join(FIXTURES, "03-config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );

  fs.writeFileSync(path.join(FIXTURES, "04-broken.json"), '{ "a": 1, "b": [1, 2, }\n', "utf8");

  // 700 行 × 45 列：验证「渲染上限 600×40 + 明确提示」，同时确认不冻结
  const large = [];
  large.push(Array.from({ length: 45 }, (_, c) => `c${c + 1}`).join(","));
  for (let r = 1; r <= 700; r += 1) {
    large.push(Array.from({ length: 45 }, (_, c) => `r${r}v${c + 1}`).join(","));
  }
  fs.writeFileSync(path.join(FIXTURES, "05-large.csv"), `${large.join("\n")}\n`, "utf8");

  fs.writeFileSync(
    path.join(FIXTURES, "06-notes.md"),
    [
      "# 结构化预览验收说明",
      "",
      "- CSV/TSV 走表格视图，JSON 走树形视图",
      "- 两者都不提供文件内查找（切源码视图再查）",
      "",
      "```ts",
      "const x: number = 1;",
      "```",
      "",
      "## 次要标题",
      "",
      "普通段落用于验证 Markdown 阅读模式仍保留查找框。",
      "",
    ].join("\n"),
    "utf8",
  );
  log(`夹具就绪：${FIXTURES}`);
}

// ── 启动 ────────────────────────────────────────────────────────────────────
async function ensureVite() {
  if (await portOpen(1420)) {
    log("复用已运行的 Vite 1420（不启动、不关闭）");
    return;
  }
  const out = fs.openSync(path.join(ROOT, "vite.log"), "a");
  vite = spawn("node", ["node_modules/vite/bin/vite.js", "--port", "1420", "--strictPort"], {
    cwd: REPO,
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  viteOwned = true;
  await waitFor(() => portOpen(1420), { timeout: 90000, label: "Vite 1420" });
  log(`Vite 1420 由本脚本启动 pid=${vite.pid}（结束关闭）`);
}

async function launchGui() {
  CDP_PORT = await freePort(17921);
  const out = fs.openSync(path.join(ROOT, "gui.log"), "a");
  gui = spawn(EXE, [], {
    env: {
      ...process.env,
      TASK_DOCK_DATA_DIR: DATA,
      WEBVIEW2_USER_DATA_FOLDER: WEBVIEW,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
      NO_PROXY: "127.0.0.1,localhost",
    },
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  log(`GUI pid=${gui.pid} cdp=${CDP_PORT}`);

  await waitFor(
    async () => {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => null);
      if (!res || !res.ok) return false;
      const list = await res.json().catch(() => []);
      return (Array.isArray(list) ? list : []).some((t) => t.type === "page");
    },
    { timeout: 180000, interval: 500, label: "CDP /json/list" },
  );

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: 20000 });
  page = await waitFor(
    async () => {
      for (const ctx of browser.contexts()) {
        for (const candidate of ctx.pages()) {
          if (candidate.url().startsWith("devtools://")) continue;
          if (!/1420/.test(candidate.url())) continue;
          const identity = await candidate
            .evaluate(() => ({
              label: window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null,
              mounted: !!document.querySelector("#root")?.childElementCount,
            }))
            .catch(() => null);
          if (identity?.label === "main" && identity.mounted) return candidate;
        }
      }
      return null;
    },
    { timeout: 90000, interval: 500, label: "主窗口页面" },
  );
  log(`主窗口已附加：${page.url()}`);
}

async function invoke(command, args) {
  return page.evaluate(
    async ({ command, args }) => {
      try {
        return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(command, args) };
      } catch (err) {
        return {
          ok: false,
          error: String((err && (err.message || err.error || err.code)) || err),
          raw: typeof err === "object" ? JSON.stringify(err).slice(0, 300) : String(err),
        };
      }
    },
    { command, args },
  );
}

// ── 断言辅助 ────────────────────────────────────────────────────────────────
const PANE_ID = "pane-acceptance";
const TAB_ID = "tab-acceptance";

/** 预览工具栏模式段按钮（纯文本按钮，无 aria-label）。 */
async function clickSegmentByText(pattern) {
  const clicked = await page.evaluate((source) => {
    const re = new RegExp(source);
    const nodes = Array.from(document.querySelectorAll(".fw-preview-segment-btn"));
    const target = nodes.find((el) => re.test((el.textContent ?? "").trim()));
    if (!target) return null;
    target.click();
    return (target.textContent ?? "").trim();
  }, pattern.source);
  await sleep(400);
  return clicked;
}

async function clickByText(text, { exact = true } = {}) {
  const clicked = await page.evaluate(
    ({ text, exact }) => {
      const nodes = Array.from(
        document.querySelectorAll("button, a, [role='tab'], [role='menuitem'], [data-route]"),
      );
      const hit = nodes.find((el) => {
        const value = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        return exact ? value === text : value.includes(text);
      });
      if (!hit) return null;
      const target = hit.closest("button, a, [role='tab'], [role='menuitem']") ?? hit;
      target.click();
      return { text, cls: (target.className ?? "").toString().slice(0, 80), route: target.getAttribute("data-route") };
    },
    { text, exact },
  );
  await sleep(500);
  return clicked;
}

/** 左侧「工作空间」→ rail「文件」；失败不抛错，由调用方判定。 */
async function gotoFilesRoute() {
  if (await page.evaluate(() => !!document.querySelector(".fw-root"))) return "already";
  // 主窗口只有「工作空间」介绍页；完整工作台是独立窗口（label=workspace）。
  // 先按「直达 files 路由」发起（R14 修复后 Rust 白名单已含 files）；
  // 若仍被拒，再退回「home 打开 + rail 点文件工作区」，两条路径都如实记录。
  const requestId = Date.now() * 1000 + 11;
  const direct = await invoke("workbench_open_window", {
    target: { tab: "files" },
    projectId: null,
    requestId,
  });
  const directOk = direct.ok === true;
  log(`workbench_open_window(files) → ${JSON.stringify(direct).slice(0, 240)}`);
  if (!directOk) {
    const fallback = await invoke("workbench_open_window", {
      target: { tab: "home" },
      projectId: null,
      requestId: requestId + 1,
    });
    log(`回退 workbench_open_window(home) → ${JSON.stringify(fallback).slice(0, 200)}`);
  }
  navInfo = { directOk, error: directOk ? null : String(direct.error ?? "") };
  const workbench = await waitFor(
    async () => {
      for (const ctx of browser.contexts()) {
        for (const candidate of ctx.pages()) {
          if (candidate.url().startsWith("devtools://") || !/1420/.test(candidate.url())) continue;
          const label = await candidate
            .evaluate(() => window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null)
            .catch(() => null);
          if (label === "workspace" || label === "workbench") return candidate;
        }
      }
      return null;
    },
    { timeout: 60000, interval: 400, label: "工作台窗口" },
  );
  bindPage(workbench);
  log(`已切换到工作台窗口：${workbench.url()}`);
  if (!directOk) {
    const rail = await clickByText("文件工作区");
    log(`rail「文件工作区」=${rail ? "已点击" : "未找到"}`);
  }
  return page
    .waitForFunction(() => !!document.querySelector(".fw-root"), { timeout: 45000 })
    .then(() => "ok")
    .catch(async () => {
      const diag = await page.evaluate(() => ({
        fwRoot: !!document.querySelector(".fw-root"),
        bodyText: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 400),
        routes: Array.from(document.querySelectorAll("[data-route]")).map((el) => el.getAttribute("data-route")),
      }));
      return `timeout ${JSON.stringify(diag)}`;
    });
}

async function seedLayout() {
  const patch = {
    workbench_layout: {
      version: 1,
      route: "files",
      projectId: null,
      detailOpen: true,
      navWidth: 200,
      detailWidth: 304,
    },
    file_workspace_layouts: {
      version: 1,
      states: {
        global: {
          tree: { type: "pane", paneId: PANE_ID },
          panes: [
            {
              paneId: PANE_ID,
              tabs: [{ tabId: TAB_ID, path: FIXTURES, openedPath: FIXTURES, viewMode: "list", sortField: "name", sortAsc: true }],
              activeTabId: TAB_ID,
            },
          ],
          activePaneId: PANE_ID,
          pinnedDirs: [FIXTURES],
          previewPane: { open: true, width: 360 },
        },
      },
      templates: [],
      recentTemplates: [],
    },
  };
  const seeded = await invoke("update_settings", { patch });
  log(`update_settings → ${JSON.stringify(seeded).slice(0, 160)}`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(() => page.evaluate(() => !!document.querySelector("#root")?.childElementCount), {
    timeout: 60000,
    label: "React 重新挂载",
  });
  // 诊断：确认设置真的落库、路由真的到 files、窗格真的恢复
  const diag = await page.evaluate(async () => {
    const settings = await window.__TAURI_INTERNALS__.invoke("get_settings", {}).catch((err) => ({ error: String(err) }));
    const root = document.querySelector(".fw-root");
    return {
      route: settings?.workbench_layout?.route ?? settings?.error ?? null,
      filesSettingVersion: settings?.file_workspace_layouts?.version ?? null,
      stateKeys: Object.keys(settings?.file_workspace_layouts?.states ?? {}),
      fwRoot: !!root,
      fwRootClass: root?.className ?? null,
      rows: document.querySelectorAll(".fw-row").length,
      panes: document.querySelectorAll("[data-fw-pane-id]").length,
      inspector: !!document.querySelector(".fw-preview-pane"),
      bodyText: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 300),
    };
  });
  log(`诊断：${JSON.stringify(diag)}`);
  const nav = await gotoFilesRoute();
  log(`导航结果：${nav}`);
  viewport = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
    dpr: window.devicePixelRatio,
    scale: window.outerWidth ? Math.round((document.documentElement.clientWidth / window.outerWidth) * 100) / 100 : null,
  }));
  log(`工作台视口：${JSON.stringify(viewport)}`);
  const after = await page.evaluate(() => ({
    fwRoot: !!document.querySelector(".fw-root"),
    rows: document.querySelectorAll(".fw-row").length,
    bodyText: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 260),
  }));
  log(`导航后：${JSON.stringify(after)}`);
  // 0) 导航契约：workbench_open_window 必须直接接受 files（R14 修复项）
  record(
    "0 工作台直达 files 路由",
    navInfo?.directOk === true,
    navInfo?.directOk
      ? "workbench_open_window(target=files) 返回成功"
      : `被拒：${navInfo?.error ?? "unknown"}（已回退 home + rail）`,
    null,
  );
}

async function rowNames() {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".fw-row .fw-row-name")).map((el) => el.textContent ?? ""),
  );
}

async function clickRow(name) {
  const locator = page.locator(".fw-row", { has: page.locator(".fw-row-name", { hasText: name }) }).first();
  await locator.click({ timeout: 15000 });
  await sleep(350);
}

async function openPreviewFor(name) {
  await clickRow(name);
  const selected = await page.evaluate(() => Array.from(document.querySelectorAll(".fw-row.is-selected .fw-row-name")).map((el) => el.textContent));
  if (selected.length !== 1) throw new Error(`选中行数量异常：${JSON.stringify(selected)}`);
  await page.evaluate((path) => {
    window.dispatchEvent(
      new CustomEvent("taskdock-fw-preview-request", { detail: { paneId: "pane-acceptance", path } }),
    );
  }, path.join(FIXTURES, name));
  await waitFor(() => page.evaluate(() => !!document.querySelector(".fw-preview-stage")), {
    timeout: 20000,
    label: `预览弹窗（${name}）`,
  });
  // 弹窗有入场动画（透明度/位移）：等动画结束再断言与截图，避免把「半透明过渡帧」当成样式缺陷
  await sleep(700);
}

async function stageInfo() {
  return page.evaluate(() => {
    const stage = document.querySelector(".fw-preview-stage");
    if (!stage) return null;
    const chips = Array.from(stage.querySelectorAll(".fw-preview-chip")).map((el) => (el.textContent ?? "").trim());
    return {
      kind: stage.getAttribute("data-kind"),
      previewPath: stage.getAttribute("data-preview-path"),
      chips,
      hasCsvTable: !!stage.querySelector(".fw-csv-table"),
      // 序号列 `.fw-csv-index` 是 th，不计入业务列
      csvHead: Array.from(stage.querySelectorAll(".fw-csv-table thead th"))
        .filter((el) => !el.classList.contains("fw-csv-index"))
        .map((el) => (el.textContent ?? "").trim()),
      csvRows: stage.querySelectorAll(".fw-csv-table tbody tr").length,
      csvFirstCell: (stage.querySelector(".fw-csv-table tbody tr td")?.textContent ?? "").trim(),
      csvNotes: !!stage.querySelector(".fw-csv-notes"),
      csvNotesText: (stage.querySelector(".fw-csv-notes")?.textContent ?? "").trim(),
      hasJsonTree: !!stage.querySelector(".fw-json-tree"),
      jsonRows: stage.querySelectorAll(".fw-json-row").length,
      segmentButtons: Array.from(stage.querySelectorAll(".fw-preview-segment-btn")).map((el) => ({
        active: el.classList.contains("is-active"),
        label: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40),
        disabled: el.hasAttribute("disabled"),
      })),
      hasSearch: !!stage.querySelector(".fw-preview-search"),
      warnChips: Array.from(stage.querySelectorAll(".fw-preview-chip.is-warn")).map((el) => (el.textContent ?? "").trim()),
      text: (stage.textContent ?? "").slice(0, 400),
    };
  });
}

async function clickByAria(rePattern, index = 0) {
  const clicked = await page.evaluate(
    ({ source, index }) => {
      const re = new RegExp(source);
      const nodes = Array.from(document.querySelectorAll("button[aria-label]")).filter((el) =>
        re.test(el.getAttribute("aria-label") ?? ""),
      );
      const target = nodes[index];
      if (!target) return null;
      target.click();
      return target.getAttribute("aria-label");
    },
    { source: rePattern.source, index },
  );
  await sleep(350);
  return clicked;
}

async function closeDialog() {
  await page.keyboard.press("Escape");
  await waitFor(() => page.evaluate(() => !document.querySelector(".fw-preview-stage")), {
    timeout: 10000,
    label: "弹窗关闭",
  });
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const pageErrors = [];
const consoleErrors = [];
const boundPages = new WeakSet();

/** 绑定/切换当前页面：后续断言都作用在 `page` 上（主窗口 → 工作台窗口）。 */
function bindPage(target) {
  page = target;
  if (boundPages.has(target)) return;
  boundPages.add(target);
  target.on("pageerror", (err) => pageErrors.push(String(err)));
  target.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
  });
}

try {
  log(`运行目录：${ROOT}`);
  writeFixtures();
  await ensureVite();
  await launchGui();

  bindPage(page);

  const bootStarted = Date.now();  await waitFor(() => page.evaluate(() => !!document.querySelector("#root")?.childElementCount), {
    timeout: 90000,
    interval: 300,
    label: "应用挂载",
  });
  log(`应用挂载耗时 ${Date.now() - bootStarted}ms`);

  await seedLayout();

  // 1) 工作区就绪 + 夹具列全
  const listed = await waitFor(
    async () => {
      const names = await rowNames();
      return names.length >= 6 ? names : null;
    },
    { timeout: 30000, label: "文件列表" },
  ).catch(async () => {
    const names = await rowNames();
    throw new Error(`文件列表未列出夹具：${JSON.stringify(names)}`);
  });
  const expected = ["01-products.csv", "02-metrics.tsv", "03-config.json", "04-broken.json", "05-large.csv", "06-notes.md"];
  const missing = expected.filter((name) => !listed.includes(name));
  record("1 工作区列出夹具", missing.length === 0, `实测 ${listed.length} 项${missing.length ? `，缺 ${missing.join("/")}` : ""}`, await shot("01-workspace"));

  // 1b) 右侧检查器同步预览 → 弹窗打开时挂起（避免双播放器/双解析）
  await clickRow("01-products.csv");
  const inspectorBefore = await waitFor(
    () => page.evaluate(() => !!document.querySelector(".fw-preview-pane-preview .fw-csv-table")),
    { timeout: 25000, label: "检查器 CSV 表格" },
  ).catch(() => false);
  await openPreviewFor("01-products.csv");
  const inspectorSuspended = await waitFor(
    () => page.evaluate(() => !document.querySelector(".fw-preview-pane-preview .fw-csv-table")),
    { timeout: 20000, label: "检查器挂起" },
  ).catch(() => false);
  record(
    "1b 检查器同步 / 弹窗挂起",
    inspectorBefore === true && inspectorSuspended === true,
    `选中后检查器表格=${inspectorBefore}；弹窗打开后检查器仍有表格=${!inspectorSuspended}`,
    await shot("01b-inspector"),
  );
  await closeDialog();

  // 2) CSV 表格视图
  await openPreviewFor("01-products.csv");
  const csv = await waitFor(async () => (await stageInfo())?.hasCsvTable ? stageInfo() : null, {
    timeout: 20000,
    label: "CSV 表格视图",
  });
  const csvText = csv.chips.join(" | ");
  record(
    "2 CSV 表格视图",
    csv.kind === "text" && csv.csvRows === 12 && csv.csvHead.length === 6 && csv.csvFirstCell.includes("SKU-001"),
    `kind=${csv.kind} 表头=${csv.csvHead.join(",")} 行=${csv.csvRows} 首格=${csv.csvFirstCell} chips=[${csvText}]`,
    await shot("02-csv-table"),
  );

  // 3) 表头开关
  const toggled = await clickByAria(/表头|Header/);
  const afterToggle = await stageInfo();
  record(
    "3 表头开关",
    !!toggled && afterToggle.csvRows === 13,
    `按钮=${toggled ?? "未找到"}，关闭表头后数据行=${afterToggle.csvRows}（期望 13）`,
    await shot("03-csv-header-off"),
  );

  // 4) 源码模式：结构化视图隐藏 + 查找出现
  const sourceClicked = await clickSegmentByText(/源码|Source/);
  const afterSource = await stageInfo();
  record(
    "4 CSV 源码模式",
    !!sourceClicked && !afterSource.hasCsvTable && afterSource.hasSearch,
    `按钮=${sourceClicked ?? "未找到"} 表格=${afterSource.hasCsvTable} 查找框=${afterSource.hasSearch} 段=[${afterSource.segmentButtons.map((b) => b.label).join(" | ")}]`,
    await shot("04-csv-source"),
  );
  await closeDialog();

  // 5) JSON 树形视图
  await openPreviewFor("03-config.json");
  const jsonBase = await waitFor(async () => (await stageInfo())?.hasJsonTree ? stageInfo() : null, {
    timeout: 20000,
    label: "JSON 树",
  });
  // 树形工具栏第一个按钮 = 展开全部（纯文本按钮，无 aria-label）
  const expanded = await page.evaluate(() => {
    const button = document.querySelector(".fw-json-toolbar button");
    if (!button) return null;
    button.click();
    return button.textContent?.trim() ?? "";
  });
  await sleep(350);
  const jsonAll = await stageInfo();
  const nodesChip = jsonAll.chips.find((chip) => /节点|nodes/i.test(chip));
  const depthChip = jsonAll.chips.find((chip) => /深度|depth/i.test(chip));
  record(
    "5 JSON 树形视图",
    jsonBase.jsonRows > 1 && !!expanded && jsonAll.jsonRows > jsonBase.jsonRows && !!nodesChip && !!depthChip,
    `默认行=${jsonBase.jsonRows} → 展开全部=${jsonAll.jsonRows}；chips=[${jsonAll.chips.join(" | ")}]`,
    await shot("05-json-tree"),
  );
  await closeDialog();

  // 6) 非法 JSON：回退源码 + 警告 + 按钮禁用
  await openPreviewFor("04-broken.json");
  const broken = await waitFor(async () => (await stageInfo())?.warnChips?.length ? stageInfo() : null, {
    timeout: 20000,
    label: "非法 JSON 回退",
  });
  const treeButtonDisabled = broken.segmentButtons.some((btn) => /树|Tree/i.test(btn.label) && btn.disabled);  record(
    "6 非法 JSON 回退",
    !broken.hasJsonTree && broken.warnChips.length > 0 && treeButtonDisabled,
    `树=${broken.hasJsonTree} 警告=[${broken.warnChips.join(" | ")}] 树按钮禁用=${treeButtonDisabled} 段=[${broken.segmentButtons.map((b) => `${b.label}${b.disabled ? "(禁用)" : ""}`).join(" | ")}]`,
    await shot("06-json-invalid"),
  );
  await closeDialog();

  // 7) TSV 分隔符
  await openPreviewFor("02-metrics.tsv");
  const tsv = await waitFor(async () => (await stageInfo())?.hasCsvTable ? stageInfo() : null, {
    timeout: 20000,
    label: "TSV 表格",
  });
  const tabChip = tsv.chips.find((chip) => /Tab/i.test(chip));
  record(
    "7 TSV 分隔符",
    !!tabChip && tsv.csvRows === 8,
    `chips=[${tsv.chips.join(" | ")}] 行=${tsv.csvRows}`,
    await shot("07-tsv"),
  );
  await closeDialog();

  // 8) 超大 CSV：渲染上限提示
  const largeStart = Date.now();
  await openPreviewFor("05-large.csv");
  const large = await waitFor(async () => (await stageInfo())?.hasCsvTable ? stageInfo() : null, {
    timeout: 25000,
    label: "大 CSV 表格",
  });
  const largeElapsed = Date.now() - largeStart;
  const capped = /600/.test(large.csvNotesText) && large.csvRows === 600;
  record(
    "8 大 CSV 渲染上限",
    capped,
    `${largeElapsed}ms 内出表；行=${large.csvRows}（上限 600）；提示="${large.csvNotesText.slice(0, 120)}"`,
    await shot("08-large-csv"),
  );
  await closeDialog();

  // 9) Markdown 回归：阅读模式保留查找
  await openPreviewFor("06-notes.md");
  const md = await waitFor(async () => (await stageInfo())?.hasSearch ? stageInfo() : null, {
    timeout: 20000,
    label: "Markdown 阅读模式",
  });
  record(
    "9 Markdown 查找回归",
    md.hasSearch === true && !md.hasCsvTable && md.kind === "text",
    `kind=${md.kind} 查找框=${md.hasSearch}`,
    await shot("09-markdown"),
  );
  await closeDialog();

  // 10) 错误采集
  record(
    "10 运行期错误",
    pageErrors.length === 0 && consoleErrors.length === 0,
    `pageerror=${pageErrors.length} console.error=${consoleErrors.length}${consoleErrors.length ? ` 首条=${consoleErrors[0]}` : ""}`,
    null,
  );
} catch (err) {
  record("EXCEPTION", false, String(err?.stack ?? err).slice(0, 600), await shot("99-failure").catch(() => null));
} finally {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const lines = [];
  lines.push(`# R14 结构化预览 · Dev 桌面验收（${stamp}）`);
  lines.push("");
  lines.push("- 结论：**Dev 功能验收" + (failed === 0 ? "通过" : "不通过") + "**（不推进 Release 状态机，不生成 buildId）");
  lines.push(`- 前端来源：复用已运行 Vite 1420（本脚本${viteOwned ? "自行启动，结束关闭" : "未启动也未关闭"}）`);
  lines.push(`- 二进制：\`src-tauri/target/debug/task-dock.exe\`（${fs.statSync(EXE).mtime.toISOString()}）`);
  lines.push(`- 数据目录（隔离）：\`${DATA}\``);
  lines.push(`- CDP 端口：${CDP_PORT || "-"}；窗口：原生 WebView2（非浏览器、非 jsdom）`);
  if (viewport) {
    lines.push(`- 工作台视口：${viewport.width}×${viewport.height} CSS px，devicePixelRatio=${viewport.dpr}`);
  }
  lines.push("");
  lines.push("| 检查项 | 结果 | 证据 |");
  lines.push("|---|---|---|");
  for (const r of results) {
    const shotRel = r.shot ? `\`screenshots/${path.basename(r.shot)}\`` : "-";
    const detail = r.detail.replace(/\|/g, "\\|").slice(0, 400);
    lines.push(`| ${r.name} | ${r.ok ? "PASS" : "FAIL"} | ${detail} ${shotRel} |`);
  }
  lines.push("");
  lines.push("## 未验证（本脚本范围外）");
  lines.push("- 系统 DPI 缩放 / 多显示器 / 真实滚动帧率（需人工真机走查）");
  lines.push("- PDF 内搜索、Office 预览、ZIP、CSV 排序/列宽拖拽/冻结列（本轮未实现）");
  lines.push("- 干净 `npm run build`（构建守卫仍会拦 dist 清理，见 docs/acceptance §14.6）");
  lines.push("");
  fs.writeFileSync(SUMMARY, `${lines.join("\n")}\n`);
  log(`汇总：PASS ${passed} / FAIL ${failed} → ${SUMMARY}`);

  if (KEEP) {
    log("--keep：保留 GUI 与页面连接（不关闭 page/browser），退出后可用探针继续附身");
  } else {
    await page?.close?.().catch(() => {});
    await browser?.close?.().catch(() => {});
    if (gui) {
      try {
        gui.kill();
        log(`已关闭本脚本启动的 GUI pid=${gui.pid}`);
      } catch {
        /* 已退出 */
      }
    }
  }
  if (viteOwned && vite) {
    try {
      vite.kill();
      log(`已关闭本脚本启动的 Vite pid=${vite.pid}`);
    } catch {
      /* 已退出 */
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}
