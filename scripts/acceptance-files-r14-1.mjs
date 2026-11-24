/** * 文件工作区 · R14.1 预览缺陷修复 Dev 桌面验收（真实 WebView2 + CDP）。 * * 用法：node scripts/acceptance-files-r14-1.mjs [--keep] *       FW_EXE=<release 或已安装的 task-dock.exe> node scripts/acceptance-files-r14-1.mjs * * 前置：dev 模式要求 `src-tauri/target/debug/task-dock.exe` 可用，Vite 1420 复用（未运行时由本脚本启动并只关闭自启进程）； *       设置 `FW_EXE` 后进入 release 模式：使用生产 `dist/`，不依赖 Vite，验收候选包/已安装副本。 * * 覆盖： *  1) 工作区就绪：夹具列全 *  2) 检查器读取文本（版本 V1） *  3) 外部改写同路径文件（size 变化）→ 工具栏刷新 → 预览显示 V2 *  4) 音频预览在页面切走后释放（元素消失 + 未激活占位），切回恢复 *  5) 页面切走期间外部改写 → 切回自动重列，预览显示 V3（无需手动刷新） *  6) 预览弹窗与检查器互斥：同一时刻只有一个音频实例 *  7) 检查器拖拽改变宽度并持久化 *  8) 运行期 pageerror / console.error 为空 * * 不做：系统 DPI/多显示器、真实滚动帧率、生产构建（保持 ENVIRONMENT BLOCKED 口径）。 */ import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { chromium } from "playwright";
const KEEP = process.argv.includes("--keep");
const REPO = path.resolve(".");
const RELEASE = !!process.env.FW_EXE;
const EXE = RELEASE
  ? path.resolve(process.env.FW_EXE)
  : path.join(REPO, "src-tauri", "target", "debug", "task-dock.exe");
const ROUND = path.join(
  REPO,
  "tmp",
  "acceptance",
  "files-workspace",
  "round14-1",
);
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
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  fs.appendFileSync(LOG, `${line}\n`);
  console.log(line);
}
function record(name, ok, detail, shotPath) {
  results.push({ name, ok, detail, shot: shotPath ?? null });
  log(`${ok ? "PASS" : "FAIL"} ${name} :: ${detail}`);
}
async function shot(name) {
  if (!page) return null;
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file }).catch(() => null);
  return fs.existsSync(file) ? file : null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 应用页面 URL：dev 走 Vite 1420，release 走打包后的 tauri origin。 */ function isAppUrl(
  url,
) {
  if (url.startsWith("devtools://")) return false;
  return RELEASE
    ? /^(http:\/\/tauri\.localhost|https:\/\/tauri\.localhost|tauri:\/\/localhost)/.test(
        url,
      )
    : /1420/.test(url);
}
async function waitFor(
  fn,
  { timeout = 20000, interval = 250, label = "condition" } = {},
) {
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
  throw new Error(
    `waitFor 超时（${label}）${lastErr ? `: ${String(lastErr.message ?? lastErr)}` : ""}`,
  );
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
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error(`找不到可用端口（从 ${start} 起 40 个）`);
}
// ── 夹具 ────────────────────────────────────────────────────────────────────
function wav(seconds = 1.2, freq = 440) {
  const sampleRate = 22050;
  const count = Math.round(sampleRate * seconds);
  const data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i += 1) {
    data.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 8000),
      i * 2,
    );
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
function writeLive(version) {
  fs.writeFileSync(
    path.join(FIXTURES, "09-live.txt"),
    [
      `VERSION=${version}`,
      "本文件由验收脚本原地覆盖，用来验证预览在 size 变化后刷新。",
      version === 1
        ? "第一版正文。"
        : `第 ${version} 版正文：${"扩展内容 ".repeat(version * 6)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  // 保证 mtime 至少前进 1 秒，避免粗粒度文件系统把两次写入判成同一版本。
  const future = new Date(Date.now() + version * 1000);
  fs.utimesSync(path.join(FIXTURES, "09-live.txt"), future, future);
}
function writeFixtures() {
  writeLive(1);
  fs.writeFileSync(path.join(FIXTURES, "07-tone.wav"), wav());
  const long = Array.from({ length: 6000 }, (_, index) =>
    index === 5499
      ? "needle-out-of-range"
      : `第 ${index + 1} 行：用于渲染上限与搜索范围一致性的人工走查。`,
  );
  fs.writeFileSync(
    path.join(FIXTURES, "08-long.txt"),
    `${long.join("\n")}\n`,
    "utf8",
  );
  // R14.2：真实视频播放（沿用 round5 的可解码样例，避免现场编码依赖 ffmpeg）。
  const sampleMp4 = path.join(
    REPO,
    "tmp",
    "acceptance",
    "files-workspace",
    "round5",
    "sample.mp4",
  );
  if (fs.existsSync(sampleMp4)) {
    fs.copyFileSync(sampleMp4, path.join(FIXTURES, "10-clip.mp4"));
  } else {
    log(`缺少视频夹具 ${sampleMp4}，视频播放检查将标记 FAIL`);
  }
  log(`夹具就绪：${FIXTURES}`);
}
// ── 启动 ────────────────────────────────────────────────────────────────────
async function ensureVite() {
  if (RELEASE) {
    log("release 模式：使用打包后的 dist，不启动、不依赖 Vite 1420");
    return;
  }
  if (await portOpen(1420)) {
    log("复用已运行的 Vite 1420（不启动、不关闭）");
    return;
  }
  const out = fs.openSync(path.join(ROOT, "vite.log"), "a");
  vite = spawn(
    "node",
    ["node_modules/vite/bin/vite.js", "--port", "1420", "--strictPort"],
    {
      cwd: REPO,
      env: { ...process.env, BROWSER: "none" },
      stdio: ["ignore", out, out],
      windowsHide: true,
    },
  );
  viteOwned = true;
  await waitFor(() => portOpen(1420), { timeout: 90000, label: "Vite 1420" });
  log(`Vite 1420 由本脚本启动 pid=${vite.pid}`);
}
async function launchGui() {
  CDP_PORT = await freePort(18021);
  const out = fs.openSync(path.join(ROOT, "gui.log"), "a");
  gui = spawn(EXE, [], {
    env: {
      ...process.env,
      TASK_DOCK_DATA_DIR: DATA,
      WEBVIEW2_USER_DATA_FOLDER: WEBVIEW,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT} --autoplay-policy=no-user-gesture-required`,
      NO_PROXY: "127.0.0.1,localhost",
    },
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  log(`GUI pid=${gui.pid} cdp=${CDP_PORT}`);
  await waitFor(
    async () => {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(
        () => null,
      );
      if (!res || !res.ok) return false;
      const list = await res.json().catch(() => []);
      return (Array.isArray(list) ? list : []).some((t) => t.type === "page");
    },
    { timeout: 180000, interval: 500, label: "CDP /json/list" },
  );
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, {
    timeout: 20000,
  });
  page = await waitFor(
    async () => {
      for (const ctx of browser.contexts()) {
        for (const candidate of ctx.pages()) {
          if (!isAppUrl(candidate.url())) continue;
          const identity = await candidate
            .evaluate(() => ({
              label:
                window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ??
                null,
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
        return {
          ok: true,
          value: await window.__TAURI_INTERNALS__.invoke(command, args),
        };
      } catch (err) {
        return {
          ok: false,
          error: String((err && (err.message || err.error || err.code)) || err),
        };
      }
    },
    { command, args },
  );
}
const PANE_ID = "pane-acceptance";
const TAB_ID = "tab-acceptance";
async function clickByText(text, { exact = true } = {}) {
  const clicked = await page.evaluate(
    ({ text, exact }) => {
      const nodes = Array.from(
        document.querySelectorAll("button, a, [role='tab'], [role='menuitem']"),
      );
      const hit = nodes.find((el) => {
        const value = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        return exact ? value === text : value.includes(text);
      });
      if (!hit) return null;
      hit.click();
      return { text, cls: (hit.className ?? "").toString().slice(0, 80) };
    },
    { text, exact },
  );
  await sleep(500);
  return clicked;
}
/** 完整工作台左侧 rail：按标签文本点击真正执行路由切换的按钮（不是拖拽行容器）。 */ async function clickNav(
  label,
) {
  const clicked = await page.evaluate((label) => {
    const items = Array.from(document.querySelectorAll(".wb-nav-item"));
    const item = items.find((row) => {
      const text = (
        row.querySelector(".wb-nav-label")?.textContent ?? ""
      ).trim();
      return text === label || text.startsWith(label);
    });
    if (!item) return null;
    const button =
      item.querySelector(".wb-nav-label")?.closest("button") ??
      item.querySelector("button.wb-nav-link, button") ??
      item;
    button.click();
    return {
      label: (item.querySelector(".wb-nav-label")?.textContent ?? "").trim(),
      tag: button.tagName,
      cls: (button.className ?? "").toString().slice(0, 60),
    };
  }, label);
  await sleep(700);
  return clicked;
}
async function gotoFilesRoute() {
  if (await page.evaluate(() => !!document.querySelector(".fw-root")))
    return "already";
  const requestId = Date.now() * 1000 + 21;
  const direct = await invoke("workbench_open_window", {
    target: { tab: "files" },
    projectId: null,
    requestId,
  });
  log(`workbench_open_window(files) → ${JSON.stringify(direct).slice(0, 200)}`);
  if (!direct.ok) {
    await invoke("workbench_open_window", {
      target: { tab: "home" },
      projectId: null,
      requestId: requestId + 1,
    });
  }
  const workbench = await waitFor(
    async () => {
      for (const ctx of browser.contexts()) {
        for (const candidate of ctx.pages()) {
          if (!isAppUrl(candidate.url())) continue;
          const label = await candidate
            .evaluate(
              () =>
                window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ??
                null,
            )
            .catch(() => null);
          if (label === "workspace" || label === "workbench") return candidate;
        }
      }
      return null;
    },
    { timeout: 60000, interval: 400, label: "工作台窗口" },
  );
  bindPage(workbench);
  if (!direct.ok) {
    const rail = await clickByText("文件工作区");
    log(`rail「文件工作区」=${rail ? "已点击" : "未找到"}`);
  }
  return page
    .waitForFunction(() => !!document.querySelector(".fw-root"), {
      timeout: 45000,
    })
    .then(() => "ok")
    .catch(() => "timeout");
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
              tabs: [
                {
                  tabId: TAB_ID,
                  path: FIXTURES,
                  openedPath: FIXTURES,
                  viewMode: "list",
                  sortField: "name",
                  sortAsc: true,
                },
              ],
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
  await invoke("update_settings", { patch });
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(
    () =>
      page.evaluate(() => !!document.querySelector("#root")?.childElementCount),
    { timeout: 60000, label: "React 重新挂载" },
  );
  const nav = await gotoFilesRoute();
  log(`导航结果：${nav}`);
  viewport = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
    dpr: window.devicePixelRatio,
  }));
  log(`工作台视口：${JSON.stringify(viewport)}`);
}
async function rowNames() {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".fw-row .fw-row-name")).map(
      (el) => el.textContent ?? "",
    ),
  );
}
async function clickRow(name) {
  const locator = page
    .locator(".fw-row", {
      has: page.locator(".fw-row-name", { hasText: name }),
    })
    .first();
  // 检查器面板可能浮在行尾上方，点行中心会被拦截；点名称区域与真实用户操作一致。
  await locator.locator(".fw-row-name").first().click({ timeout: 15000 });
  await sleep(350);
}
async function panelText() {
  return page.evaluate(() =>
    (
      document.querySelector(".fw-preview-pane-preview")?.textContent ?? ""
    ).replace(/\s+/g, " "),
  );
}
async function openDialogFor(name) {
  await page.evaluate(
    (p) => {
      window.dispatchEvent(
        new CustomEvent("taskdock-fw-preview-request", {
          detail: { paneId: "pane-acceptance", path: p },
        }),
      );
    },
    path.join(FIXTURES, name),
  );
  await waitFor(
    () => page.evaluate(() => !!document.querySelector(".fw-preview-stage")),
    { timeout: 20000, label: `预览弹窗（${name}）` },
  );
  await sleep(700);
}
async function closeDialog() {
  await page.keyboard.press("Escape");
  await waitFor(
    () => page.evaluate(() => !document.querySelector(".fw-preview-stage")),
    { timeout: 10000, label: "弹窗关闭" },
  );
}
/** 记录媒体 IPC，用于证明切页/关闭后确实调用了 token 释放。 */ async function installInvokeLog() {
  return page.evaluate(() => {
    const w = window;
    w.__fwMediaCalls = [];
    const internals = w.__TAURI_INTERNALS__;
    const diag = {
      hasInternals: !!internals,
      hasInvoke: typeof internals?.invoke === "function",
      frozen: internals ? Object.isFrozen(internals) : null,
      descriptor: internals
        ? Object.getOwnPropertyDescriptor(internals, "invoke")
        : null,
    };
    if (!internals?.invoke) return diag;
    if (w.__fwInvokeWrapped) return { ...diag, already: true };
    const original = internals.invoke;
    const wrapper = (...args) => {
      const [command, params] = args;
      if (
        command === "fs_preview_media_url" ||
        command === "fs_release_preview_url"
      ) {
        w.__fwMediaCalls.push({ command, params });
      }
      return original.apply(internals, args);
    };
    try {
      internals.invoke = wrapper;
      diag.assigned = internals.invoke === wrapper;
    } catch (err) {
      diag.assignError = String(err?.message ?? err);
    }
    if (!diag.assigned) {
      try {
        Object.defineProperty(internals, "invoke", {
          configurable: true,
          writable: true,
          value: wrapper,
        });
        diag.defined = internals.invoke === wrapper;
      } catch (err) {
        diag.defineError = String(err?.message ?? err);
      }
    }
    w.__fwInvokeWrapped = internals.invoke === wrapper;
    w.__fwInvokeDiag = diag;
    return diag;
  });
}
/** 通过自定义控制条按钮触发音频播放（真实用户手势，不受自动播放策略影响）。 */ async function clickPlayAudio(
  scope,
  refName,
) {
  await page.evaluate(
    ({ scope, refName }) => {
      window[refName] = document.querySelector(`${scope} .fw-preview-audio-el`);
    },
    { scope, refName },
  );
  await page
    .locator(`${scope} .fw-preview-audio-play`)
    .click({ timeout: 20000 });
  await sleep(600);
  return page.evaluate(
    ({ refName }) => {
      const el = window[refName];
      if (!el) return { ok: false, error: "missing element" };
      return {
        ok: !el.paused,
        paused: el.paused,
        src: el.src,
        error: el.paused ? "still paused" : null,
      };
    },
    { refName },
  );
}
/** 点击原生控制条播放按钮启动视频（真实用户手势）。 */ async function clickPlayVideo(
  scope,
  refName,
) {
  await page.evaluate(
    ({ scope, refName }) => {
      window[refName] = document.querySelector(`${scope} .fw-preview-video`);
    },
    { scope, refName },
  );
  const video = page.locator(`${scope} .fw-preview-video`).first();
  const box = await video.boundingBox();
  if (!box) return { ok: false, error: "video not visible" };
  // 原生控制条左下角的播放按钮区域。
  await page.mouse.click(box.x + 22, box.y + box.height - 22);
  await sleep(900);
  let state = await page.evaluate(
    ({ refName }) => {
      const el = window[refName];
      return el ? { paused: el.paused, src: el.src } : null;
    },
    { refName },
  );
  if (state && state.paused) {
    // 个别 WebView2 版本点击只聚焦不播放：在用户手势的有效期内补一次 play()。
    await page.evaluate(
      ({ refName }) => window[refName]?.play().catch(() => undefined),
      { refName },
    );
    await sleep(700);
    state = await page.evaluate(
      ({ refName }) => {
        const el = window[refName];
        return el ? { paused: el.paused, src: el.src } : null;
      },
      { refName },
    );
  }
  return state
    ? { ...state, ok: !state.paused }
    : { ok: false, error: "missing element" };
}
/** 旧媒体元素在卸载后的真实状态（token 释放用独立探针证明）。 */ async function oldMediaState(
  refName,
  token,
) {
  return page.evaluate(
    ({ refName }) => {
      const el = window[refName];
      return {
        present: !!el,
        paused: el ? el.paused : null,
        srcAttr: el ? el.getAttribute("src") : null,
        srcProp: el ? el.src : null,
      };
    },
    { refName },
  );
}
/** * 用一次性媒体元素探测 token 是否仍被后端接受： * 释放前应能加载元数据，释放后自定义协议应返回错误。 */ async function probeMediaToken(
  url,
) {
  if (!url) return { ok: false, error: "no token" };
  return page.evaluate(
    (targetUrl) =>
      new Promise((resolve) => {
        const probe = new Audio();
        let settled = false;
        const finish = (ok, error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          probe.onloadedmetadata = null;
          probe.onerror = null;
          try {
            probe.removeAttribute("src");
            probe.load();
          } catch {
            /* jsdom/WebView 兜底 */
          }
          resolve({ ok, error: error ?? null });
        };
        const timer = window.setTimeout(() => finish(false, "timeout"), 5000);
        probe.onloadedmetadata = () => finish(true, null);
        probe.onerror = () =>
          finish(false, `media-error-${probe.error?.code ?? "unknown"}`);
        probe.preload = "metadata";
        // query 只用于绕开媒体缓存；协议层按 path 取 token，不改变 token 语义。
        probe.src = `${targetUrl}?probe=${Date.now()}`;
        probe.load();
      }),
    url,
  );
}
async function clickRefresh() {
  const clicked = await page.evaluate(() => {
    const button = document.querySelector(".fw-refresh-btn");
    if (!button) return null;
    button.click();
    return button.getAttribute("aria-label");
  });
  await sleep(900);
  return clicked;
}
// ── 主流程 ──────────────────────────────────────────────────────────────────
const pageErrors = [];
const consoleErrors = [];
const boundPages = new WeakSet();
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
  await waitFor(
    () =>
      page.evaluate(() => !!document.querySelector("#root")?.childElementCount),
    { timeout: 90000, interval: 300, label: "应用挂载" },
  );
  log(`invoke 日志包装：${JSON.stringify(await installInvokeLog())}`);
  await seedLayout();
  // 1) 工作区就绪
  const listed = await waitFor(
    async () => {
      const names = await rowNames();
      return names.length >= 3 ? names : null;
    },
    { timeout: 30000, label: "文件列表" },
  ).catch(async () => rowNames());
  record(
    "1 工作区列出夹具",
    ["07-tone.wav", "08-long.txt", "09-live.txt", "10-clip.mp4"].every((name) =>
      listed.includes(name),
    ),
    `实测 ${listed.length} 项：${listed.join(" / ")}`,
    await shot("01-workspace"),
  );
  // 2) 检查器读取文本 V1
  await clickRow("09-live.txt");
  const v1 = await waitFor(
    async () => {
      const text = await panelText();
      return text.includes("VERSION=1") ? text : null;
    },
    { timeout: 25000, label: "检查器 V1" },
  ).catch(() => panelText());
  record(
    "2 检查器读取文本",
    String(v1).includes("VERSION=1"),
    `预览正文包含 VERSION=1：${String(v1).slice(0, 120)}`,
    await shot("02-inspector-v1"),
  );
  // 3) 外部改写（size 变化）→ 工具栏刷新 → V2
  writeLive(2);
  const refreshed = await clickRefresh();
  const v2 = await waitFor(
    async () => {
      const text = await panelText();
      return text.includes("VERSION=2") ? text : null;
    },
    { timeout: 25000, label: "刷新后 V2" },
  ).catch(() => panelText());
  record(
    "3 外部改写 + 刷新 → V2",
    !!refreshed && String(v2).includes("VERSION=2"),
    `刷新按钮=${refreshed ?? "未找到"}；预览=${String(v2).slice(0, 120)}`,
    await shot("03-inspector-v2"),
  );
  // 3b) 等长改写（size 不变，仅 mtime 变化）→ 刷新也必须换版本
  const livePath = path.join(FIXTURES, "09-live.txt");
  const beforeStat = fs.statSync(livePath);
  const sameSizeText = fs
    .readFileSync(livePath, "utf8")
    .replace("第 2 版", "第 9 版");
  fs.writeFileSync(livePath, sameSizeText, "utf8");
  const bump = new Date(Date.now() + 15_000);
  fs.utimesSync(livePath, bump, bump);
  const afterStat = fs.statSync(livePath);
  const refreshed2 = await clickRefresh();
  const v2b = await waitFor(
    async () => {
      const text = await panelText();
      return text.includes("第 9 版") ? text : null;
    },
    { timeout: 25000, label: "等长改写后 V2b" },
  ).catch(() => panelText());
  record(
    "3b 等长改写（size 不变 / mtime 变）→ V2b",
    !!refreshed2 &&
      beforeStat.size === afterStat.size &&
      String(v2b).includes("第 9 版"),
    `size ${beforeStat.size}→${afterStat.size}（相等=${beforeStat.size === afterStat.size}）；预览=${String(v2b).slice(0, 120)}`,
    await shot("03b-inspector-v2b"),
  );
  // 4) 音频：页面切走释放，切回恢复
  await clickRow("07-tone.wav");
  const audioBefore = await waitFor(
    () =>
      page.evaluate(
        () =>
          !!document.querySelector(
            ".fw-preview-pane-preview .fw-preview-audio",
          ),
      ),
    { timeout: 25000, label: "检查器音频" },
  ).catch(() => false);
  const away = await clickNav("任务");
  let awayState = null;
  try {
    awayState = await waitFor(
      () =>
        page.evaluate(() => {
          const root = document.querySelector(".fw-root");
          const route = document.querySelector(".tab-content-files, .wb-route");
          return {
            fwRootPresent: !!root,
            fwRootHidden:
              !root ||
              root.closest(".wb-route")?.hasAttribute("hidden") === true,
            audio: document.querySelectorAll(".fw-preview-audio").length,
            inactive: /未激活/.test(
              document.querySelector(".fw-preview-pane-empty")?.textContent ??
                "",
            ),
            activeRoute:
              document.querySelector(".wb-nav-item.is-active .wb-nav-label")
                ?.textContent ?? null,
            routeHiddenFlags: Array.from(
              document.querySelectorAll(".wb-route"),
            ).map((el) => ({
              id: el.className,
              hidden: el.hasAttribute("hidden"),
            })),
          };
        }),
      { timeout: 20000, label: "页面切走" },
    );
  } catch (err) {
    log(`页面切走诊断失败：${String(err.message ?? err)}`);
    awayState = await page
      .evaluate(() => ({
        bodyText: (document.body.innerText || "")
          .replace(/\s+/g, " ")
          .slice(0, 300),
        routes: Array.from(document.querySelectorAll(".wb-route")).map(
          (el) => ({ cls: el.className, hidden: el.hasAttribute("hidden") }),
        ),
        audio: document.querySelectorAll(".fw-preview-audio").length,
      }))
      .catch(() => null);
  }
  const back = await clickNav("文件工作区");
  const audioAfter = await waitFor(
    () =>
      page.evaluate(
        () =>
          !!document.querySelector(
            ".fw-preview-pane-preview .fw-preview-audio",
          ),
      ),
    { timeout: 25000, label: "切回恢复音频" },
  ).catch(() => false);
  record(
    "4 页面切换释放/恢复音频",
    audioBefore === true &&
      !!awayState &&
      awayState.audio === 0 &&
      (awayState.inactive === true || awayState.fwRootHidden === true) &&
      audioAfter === true,
    `切换前音频=${audioBefore}；切到「${away?.label ?? away}」后 ${JSON.stringify(awayState)}；切回=${back?.label ?? back} 音频恢复=${audioAfter}`,
    await shot("04-page-inactive"),
  );
  // 5) 页面切走期间外部改写 → 切回自动重列 → V3
  await clickNav("任务");
  writeLive(3);
  await sleep(600);
  await clickNav("文件工作区");
  // 切回时 FilePane 的 pageActive 由 false→true，会强制重列一次当前目录；
  // 重新选中 09-live.txt：若没有重列，entry 仍是旧的 V2 版本，预览会停在 V2。
  await clickRow("09-live.txt");
  const v3 = await waitFor(
    async () => {
      const text = await panelText();
      return text.includes("VERSION=3") ? text : null;
    },
    { timeout: 25000, label: "切回自动重列 V3" },
  ).catch(() => panelText());
  record(
    "5 切回自动重列 → V3",
    String(v3).includes("VERSION=3"),
    `预览=${String(v3).slice(0, 140)}`,
    await shot("05-inspector-v3"),
  );
  // 6) 弹窗与检查器互斥：同一时刻只有一个音频实例
  await clickRow("07-tone.wav");
  await waitFor(
    () =>
      page.evaluate(
        () =>
          !!document.querySelector(
            ".fw-preview-pane-preview .fw-preview-audio",
          ),
      ),
    { timeout: 20000, label: "检查器音频" },
  ).catch(() => false);
  await openDialogFor("07-tone.wav");
  const exclusivity = await page.evaluate(() => ({
    dialogAudio: document.querySelectorAll(
      ".fw-preview-stage .fw-preview-audio",
    ).length,
    panelAudio: document.querySelectorAll(
      ".fw-preview-pane-preview .fw-preview-audio",
    ).length,
    panelSuspended: /快速预览窗口已打开|预览已释放/.test(
      document.querySelector(".fw-preview-pane-empty")?.textContent ?? "",
    ),
  }));
  record(
    "6 弹窗与检查器互斥",
    exclusivity.dialogAudio === 1 && exclusivity.panelAudio === 0,
    `弹窗音频=${exclusivity.dialogAudio} 检查器音频=${exclusivity.panelAudio} 检查器挂起=${exclusivity.panelSuspended}`,
    await shot("06-dialog-exclusive"),
  );
  await closeDialog();
  // 7) 检查器拖拽：宽度变化并持久化
  const widthBefore = await page.evaluate(() => {
    const aside = document.querySelector(".fw-preview-pane");
    return aside ? Math.round(aside.getBoundingClientRect().width) : 0;
  });
  const separator = page.locator(".fw-preview-resizer");
  const overlayMode = await page.evaluate(
    () =>
      document
        .querySelector(".fw-preview-pane")
        ?.classList.contains("is-overlay") ?? false,
  );
  const box = overlayMode ? null : await separator.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 90, box.y + box.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await sleep(500);
  }
  const afterDrag = await page.evaluate(() => ({
    width: Math.round(
      document.querySelector(".fw-preview-pane")?.getBoundingClientRect()
        .width ?? 0,
    ),
    dragging: document.body.classList.contains("ui-resizer-dragging"),
    resizeAxis: document.body.dataset.resizeAxis ?? null,
  }));
  const settingsAfter = await invoke("get_settings", {});
  const readPersistedWidth = () =>
    settingsAfter?.value?.file_workspace_layouts?.states?.global?.previewPane
      ?.width ?? null;
  let persistedWidth = readPersistedWidth();
  if (persistedWidth !== afterDrag.width) {
    // 布局持久化走 store → update_settings 的节流写回，等它落库再做断言。
    persistedWidth = await waitFor(
      async () => {
        const now = await invoke("get_settings", {});
        const width =
          now?.value?.file_workspace_layouts?.states?.global?.previewPane
            ?.width ?? null;
        return width !== persistedWidth ? width : null;
      },
      { timeout: 8000, label: "宽度持久化" },
    ).catch(() => readPersistedWidth());
  }
  const widthOk = overlayMode
    ? afterDrag.width > 0 && afterDrag.width <= 380
    : !!box && afterDrag.width !== widthBefore;
  const persistOk = overlayMode
    ? true
    : Math.abs((persistedWidth ?? 0) - afterDrag.width) <= 4;
  record(
    "7 检查器宽度模式",
    widthOk && afterDrag.dragging === false && persistOk,
    `${overlayMode ? "窄窗浮层（无拖拽条，按 380px 上限校验）" : "内联拖拽"}：拖动前=${widthBefore}px 拖动后=${afterDrag.width}px 持久化=${persistedWidth} 拖动残留=${afterDrag.dragging}`,
    await shot("07-drag"),
  );
  // 9) 音频真实播放：切页后旧元素 paused=true、src 清空、token 释放
  const audioPlay = await clickPlayAudio(
    ".fw-preview-pane-preview",
    "__fwOldAudio",
  );
  const audioToken = audioPlay.ok ? audioPlay.src : null;
  const audioProbeBefore = await probeMediaToken(audioToken);
  await clickNav("任务");
  await sleep(500);
  const audioOld = audioToken
    ? await oldMediaState("__fwOldAudio", audioToken)
    : null;
  const audioProbeAfter = await probeMediaToken(audioToken);
  await clickNav("文件工作区");
  await sleep(500);
  record(
    "9 音频真实播放 → 切页暂停并释放",
    audioPlay.ok === true &&
      audioPlay.paused === false &&
      audioOld?.paused === true &&
      audioOld?.srcAttr === null &&
      audioProbeBefore.ok === true &&
      audioProbeAfter.ok === false,
    `播放=${JSON.stringify(audioPlay)}；token 释放前=${JSON.stringify(audioProbeBefore)} 释放后=${JSON.stringify(audioProbeAfter)}；切页后=${JSON.stringify(audioOld)}`,
    await shot("09-audio-paused"),
  );
  // 10) 视频真实播放：同样在切页时停止并释放
  let videoPlay = { ok: false, error: "video fixture missing" };
  let videoOld = null;
  let videoTokenProbe = null;
  if (fs.existsSync(path.join(FIXTURES, "10-clip.mp4"))) {
    await clickRow("10-clip.mp4");
    await waitFor(
      () =>
        page.evaluate(
          () =>
            !!document.querySelector(
              ".fw-preview-pane-preview .fw-preview-video",
            ),
        ),
      { timeout: 20000, label: "检查器视频" },
    ).catch(() => false);
    videoPlay = await clickPlayVideo(
      ".fw-preview-pane-preview",
      "__fwOldVideo",
    );
    const videoToken = videoPlay.ok ? videoPlay.src : null;
    const videoBefore = await probeMediaToken(videoToken);
    await clickNav("任务");
    await sleep(500);
    videoOld = videoToken
      ? await oldMediaState("__fwOldVideo", videoToken)
      : null;
    const videoAfter = await probeMediaToken(videoToken);
    await clickNav("文件工作区");
    await sleep(500);
    videoTokenProbe = { before: videoBefore, after: videoAfter };
  }
  record(
    "10 视频真实播放 → 切页暂停并释放",
    videoPlay.ok === true &&
      videoPlay.paused === false &&
      videoOld?.paused === true &&
      videoOld?.srcAttr === null &&
      videoTokenProbe?.before?.ok === true &&
      videoTokenProbe?.after?.ok === false,
    `播放=${JSON.stringify(videoPlay)}；token=${JSON.stringify(videoTokenProbe)}；切页后=${JSON.stringify(videoOld)}`,
    await shot("10-video-paused"),
  );
  // 11) 弹窗关闭：正在播放的音频停止并释放
  await clickRow("07-tone.wav");
  await waitFor(
    () =>
      page.evaluate(
        () =>
          !!document.querySelector(
            ".fw-preview-pane-preview .fw-preview-audio",
          ),
      ),
    { timeout: 20000, label: "弹窗关闭前音频" },
  ).catch(() => false);
  await openDialogFor("07-tone.wav");
  const dialogPlay = await clickPlayAudio(
    ".fw-preview-stage",
    "__fwOldDialogAudio",
  );
  const dialogToken = dialogPlay.ok ? dialogPlay.src : null;
  const dialogBefore = await probeMediaToken(dialogToken);
  await closeDialog();
  await sleep(400);
  const dialogOld = dialogToken
    ? await oldMediaState("__fwOldDialogAudio", dialogToken)
    : null;
  const dialogAfter = await probeMediaToken(dialogToken);
  record(
    "11 弹窗关闭 → 音频暂停并释放",
    dialogPlay.ok === true &&
      dialogOld?.paused === true &&
      dialogOld?.srcAttr === null &&
      dialogBefore.ok === true &&
      dialogAfter.ok === false,
    `播放=${JSON.stringify(dialogPlay)}；token 释放前=${JSON.stringify(dialogBefore)} 释放后=${JSON.stringify(dialogAfter)}；关闭后=${JSON.stringify(dialogOld)}`,
    await shot("11-dialog-closed"),
  );
  // 12) Tab 键盘导航：ArrowRight / Home 与 aria-selected、tabpanel 显示一致
  await clickRow("09-live.txt");
  await waitFor(
    () =>
      page.evaluate(() => !!document.querySelector(".fw-preview-pane-tabs")),
    { timeout: 15000, label: "检查器 tabs" },
  );
  await page.evaluate(() =>
    document.getElementById("fw-preview-tab-preview")?.focus(),
  );
  await page.keyboard.press("ArrowRight");
  await sleep(300);
  const afterRight = await page.evaluate(() => ({
    selected:
      document.querySelector(
        '.fw-preview-pane [role="tab"][aria-selected="true"]',
      )?.id ?? null,
    detailsHidden:
      document.getElementById("fw-preview-pane-panel-details")?.hidden ?? null,
    previewHidden:
      document.getElementById("fw-preview-pane-panel-preview")?.hidden ?? null,
    focused: document.activeElement?.id ?? null,
  }));
  await page.keyboard.press("Home");
  await sleep(300);
  const afterHome = await page.evaluate(() => ({
    selected:
      document.querySelector(
        '.fw-preview-pane [role="tab"][aria-selected="true"]',
      )?.id ?? null,
    previewHidden:
      document.getElementById("fw-preview-pane-panel-preview")?.hidden ?? null,
    focused: document.activeElement?.id ?? null,
  }));
  record(
    "12 Tab 键盘导航",
    afterRight.selected === "fw-preview-tab-details" &&
      afterRight.detailsHidden === false &&
      afterRight.previewHidden === true &&
      afterRight.focused === "fw-preview-tab-details" &&
      afterHome.selected === "fw-preview-tab-preview" &&
      afterHome.previewHidden === false &&
      afterHome.focused === "fw-preview-tab-preview",
    `ArrowRight=${JSON.stringify(afterRight)}；Home=${JSON.stringify(afterHome)}`,
    await shot("12-tab-keyboard"),
  );
  // 13) 弹窗内文件版本变化：先提示、显式刷新后加载新版本
  await clickRow("09-live.txt");
  await openDialogFor("09-live.txt");
  const dialogV3 = await page.evaluate(() =>
    (document.querySelector(".fw-preview-stage")?.textContent ?? "").replace(
      /\s+/g,
      " ",
    ),
  );
  writeLive(5);
  const staleUp = await waitFor(
    () =>
      page.evaluate(
        () => !!document.querySelector(".fw-preview-layout .fw-preview-stale"),
      ),
    { timeout: 12000, interval: 300, label: "弹窗版本提示" },
  )
    .then(() => true)
    .catch(() => false);
  const dialogBeforeRefresh = await page.evaluate(() =>
    (document.querySelector(".fw-preview-stage")?.textContent ?? "").replace(
      /\s+/g,
      " ",
    ),
  );
  const refreshClicked = await clickByText("刷新预览");
  const dialogV5 = await waitFor(
    async () => {
      const text = await page.evaluate(() =>
        (
          document.querySelector(".fw-preview-stage")?.textContent ?? ""
        ).replace(/\s+/g, " "),
      );
      return text.includes("VERSION=5") ? text : null;
    },
    { timeout: 20000, label: "弹窗刷新 V5" },
  ).catch(async () =>
    page.evaluate(() =>
      (document.querySelector(".fw-preview-stage")?.textContent ?? "").replace(
        /\s+/g,
        " ",
      ),
    ),
  );
  const stageCount = await page.evaluate(
    () => document.querySelectorAll(".fw-preview-stage").length,
  );
  await closeDialog();
  record(
    "13 弹窗文件版本刷新",
    dialogV3.includes("VERSION=3") &&
      staleUp === true &&
      dialogBeforeRefresh.includes("VERSION=3") &&
      !dialogBeforeRefresh.includes("VERSION=5") &&
      !!refreshClicked &&
      String(dialogV5).includes("VERSION=5") &&
      stageCount === 1,
    `初始 V3=${dialogV3.includes("VERSION=3")}；提示=${staleUp}；刷新前仍 V3=${dialogBeforeRefresh.includes("VERSION=3")}；刷新按钮=${JSON.stringify(refreshClicked)}；刷新后 V5=${String(dialogV5).includes("VERSION=5")}；播放器/舞台数=${stageCount}`,
    await shot("13-dialog-refresh"),
  );
  // 14) 运行期错误（全部操作后）
  // token 探针会故意请求已释放的 URL，WebView2 会打印 404 资源错误；只保留其余错误。
  const probe404 = consoleErrors.filter((message) =>
    /Failed to load resource:.*404/.test(message),
  ).length;
  const unexpectedConsole = consoleErrors.filter(
    (message) => !/Failed to load resource:.*404/.test(message),
  );
  record(
    "14 运行期错误",
    pageErrors.length === 0 && unexpectedConsole.length === 0,
    `pageerror=${pageErrors.length} 非预期 console.error=${unexpectedConsole.length}（另有 token 探针预期 404 ${probe404} 条）${unexpectedConsole.length ? ` 首条=${unexpectedConsole[0]}` : ""}`,
    null,
  );
} catch (err) {
  record(
    "EXCEPTION",
    false,
    String(err?.stack ?? err).slice(0, 600),
    await shot("99-failure").catch(() => null),
  );
} finally {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const lines = [];
  lines.push(
    RELEASE
      ? `# R14.1 预览缺陷修复 · 候选 Release 包桌面验收（${stamp}）`
      : `# R14.1 预览缺陷修复 · Dev 桌面验收（${stamp}）`,
  );
  lines.push("");
  lines.push(
    RELEASE
      ? `- 结论：**候选包功能验收${failed === 0 ? "通过" : "不通过"}**（基于候选包，非正式 buildId；不推进 Release 状态机）`
      : `- 结论：**Dev 功能验收${failed === 0 ? "通过" : "不通过"}**（不推进 Release 状态机，不生成 buildId）`,
  );
  lines.push(
    RELEASE
      ? "- 前端来源：生产 `dist/`（release 包内置，无 Vite）"
      : `- 前端来源：复用已运行 Vite 1420（本脚本${viteOwned ? "自行启动，结束关闭" : "未启动也未关闭"}）`,
  );
  lines.push(
    `- 二进制：\`${path.relative(REPO, EXE)}\`（${fs.statSync(EXE).mtime.toISOString()}）`,
  );
  if (RELEASE) {
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256")
      .update(fs.readFileSync(EXE))
      .digest("hex")
      .toUpperCase();
    lines.push(`- 二进制 SHA256：\`${sha}\``);
  }
  lines.push(`- 数据目录（隔离）：\`${DATA}\``);
  lines.push(
    `- CDP 端口：${CDP_PORT || "-"}；窗口：原生 WebView2（非浏览器、非 jsdom）`,
  );
  if (viewport)
    lines.push(
      `- 工作台视口：${viewport.width}×${viewport.height} CSS px，devicePixelRatio=${viewport.dpr}`,
    );
  lines.push("");
  lines.push("| 检查项 | 结果 | 证据 |");
  lines.push("|---|---|---|");
  for (const r of results) {
    const shotRel = r.shot ? `\`screenshots/${path.basename(r.shot)}\`` : "-";
    lines.push(
      `| ${r.name} | ${r.ok ? "PASS" : "FAIL"} | ${r.detail.replace(/\|/g, "\\|").slice(0, 400)} ${shotRel} |`,
    );
  }
  lines.push("");
  lines.push("## 未验证（本脚本范围外）");
  lines.push("- 系统 DPI 缩放 / 多显示器 / 真实滚动帧率（需人工真机走查）");
  lines.push("- 弹窗错误 toast（需构造默认程序不可用场景，已由单测覆盖）");
  lines.push(
    "- 干净 `npm run build`（构建守卫仍会拦截，见 docs/acceptance §14.6）",
  );
  lines.push("");
  fs.writeFileSync(SUMMARY, `${lines.join("\n")}\n`);
  log(`汇总：PASS ${passed} / FAIL ${failed} → ${SUMMARY}`);
  if (KEEP) {
    log("--keep：保留 GUI 与页面连接");
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
    } catch {
      /* 已退出 */
    }
  }
  process.exit(failed === 0 ? 0 : 1);
}
