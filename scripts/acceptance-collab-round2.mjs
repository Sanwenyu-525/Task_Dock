/**
 * 协作中心 · 第二轮架构修复 Dev 功能验收（真实 Tauri WebView2）。
 *
 * 用法：node scripts/acceptance-collab-round2.mjs [--keep]
 *
 * 覆盖：
 *  P 原型：添加组件 / 属性编辑 / 撤销重做 / 拖拽 / 保存 / 预览只读 / AI 按选中页应用
 *  I 图片：预览只读 / 编辑绘制标注 / 保存 / 预览呈现标注
 *  R 重启：关闭应用后重新启动，内容仍一致（持久化）
 *
 * 隔离：数据目录 `tmp/acceptance/collab-round2/run-<stamp>/data`，不触碰真实用户数据。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { chromium } from "playwright";
import { attachMainWindow } from "./acceptance/cdp-main-window.mjs";

const KEEP = process.argv.includes("--keep");
const REPO = path.resolve(".");
const EXE = path.join(REPO, "src-tauri", "target", "debug", "task-dock.exe");
const stamp = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
})();
const ROOT = path.join(REPO, "tmp", "acceptance", "collab-round2", `run-${stamp}`);
const DATA = path.join(ROOT, "data");
const LOG = path.join(ROOT, "acceptance.log");
const SUMMARY = path.join(ROOT, "summary.md");

const results = [];
const logs = [];
let gui = null;
let vite = null;
let browser = null;
let page = null;
let CDP_PORT = 17431;

const PROJECT = "proj-collab-round2";
const PROTOTYPE_TITLE = "验收原型（第二轮）";
const IMAGE_TITLE = "验收标注图（第二轮）";

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  logs.push(line);
  fs.appendFileSync(LOG, `${line}\n`);
  console.log(line);
}

function record(name, ok, detail = "") {
  results.push({ name, ok, detail, at: new Date().toISOString() });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function step(name, fn) {
  try {
    await ensureVite();
    const detail = await fn();
    record(name, true, detail ?? "");
    return true;
  } catch (err) {
    const slug = name.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40);
    try {
      if (page) {
        await shot(`FAIL-${slug}`);
        const dump = await page.evaluate(() => ({
          text: document.body.innerText.slice(0, 1500),
          overlays: document.querySelectorAll('[data-testid="proto-overlay"]').length,
          aiPanel: document.querySelector(".graph-ai-panel")?.innerText ?? null,
          errors: Array.from(document.querySelectorAll(".collab-inline-error"))
            .map((el) => el.innerText)
            .slice(0, 5),
          route: document.querySelector(".wb-route:not([hidden])")?.className ?? null,
        }));
        fs.writeFileSync(path.join(ROOT, `FAIL-${slug}.json`), JSON.stringify(dump, null, 2));
      }
    } catch {
      /* 诊断失败不掩盖原因 */
    }
    record(name, false, `异常：${err?.stack?.split("\n")[0] ?? err}`);
    return false;
  }
}

async function shot(name) {
  if (!page) return;
  await page.screenshot({ path: path.join(ROOT, `${name}.png`), fullPage: false });
}

function freePort(start) {
  return new Promise((resolve) => {
    const tryPort = (port) => {
      const srv = net.createServer();
      srv.once("error", () => tryPort(port + 1));
      srv.once("listening", () => srv.close(() => resolve(port)));
      srv.listen(port, "127.0.0.1");
    };
    tryPort(start);
  });
}

function waitPort(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`端口 ${port} 未就绪`));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

async function waitFor(fn, { timeout = 30000, interval = 250, label = "条件" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`${label} 超时（最后值：${String(last).slice(0, 200)}）`);
}

function tryConnect(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function portOpen(port) {
  // Vite 在 Windows 上通常只监听 IPv6（::1），localhost 可达而 127.0.0.1 拒连。
  return (await tryConnect(port, "::1")) || (await tryConnect(port, "127.0.0.1"));
}

async function ensureVite() {
  // 1420 是共享端口：已有实例就复用（绝不终止他人进程）；空闲时由本脚本临时拉起。
  // 共享实例中途退出时，下一步会自动接管端口，避免整轮验收被外部重启打断。
  if (await portOpen(1420)) {
    if (!vite) log("复用已存在的 Vite 1420（不启动/不终止他人进程）");
    return;
  }
  if (vite) {
    vite = null;
  }
  const out = fs.openSync(path.join(ROOT, "vite.log"), "a");
  vite = spawn("node", ["node_modules/vite/bin/vite.js", "--port", "1420", "--strictPort"], {
    cwd: REPO,
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  await waitFor(async () => await portOpen(1420), { timeout: 60000, label: "Vite 1420" });
  log(`vite 就绪 pid=${vite.pid}（本脚本启动，结束时关闭）`);
}

async function launchGui() {
  CDP_PORT = await freePort(CDP_PORT);
  const out = fs.openSync(path.join(ROOT, "gui.log"), "a");
  gui = spawn(EXE, [], {
    env: {
      ...process.env,
      TASK_DOCK_DATA_DIR: DATA,
      WEBVIEW2_USER_DATA_FOLDER: DATA,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  log(`GUI pid=${gui.pid} cdp=${CDP_PORT}`);
  await waitFor(
    async () => {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => null);
      if (!res || !res.ok) return false;
      const list = await res.json();
      return list.some((t) => t.type === "page");
    },
    { timeout: 60000, label: "CDP 目标" },
  );
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
          tauri: !!window.__TAURI_INTERNALS__,
          mounted: !!document.querySelector("#root"),
        };
      });
    },
  });
  page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((x) => x.url() === picked.target.url);
  assert(page, "未找到主窗口页面");
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 900 });
  await dismissOnboarding();
  await page.waitForTimeout(800);
  log(`主窗口 ${picked.target.url}`);
}

async function dismissOnboarding() {
  // 引导层在 React 首屏之后才挂载，过早点击会点不到；最多等 9s。
  for (let i = 0; i < 30; i += 1) {
    const skip = page.getByRole("button", { name: "跳过引导" });
    if (await skip.count()) {
      await skip.first().click();
      await page.waitForTimeout(500);
      return;
    }
    await page.waitForTimeout(300);
  }
  log("未出现引导层（可能已完成引导）");
}

async function invokeInPage(fn, arg) {
  return page.evaluate(
    async ({ source, arg }) => {
      const mod = await import("/src/lib/bridge.ts");
      const collab = await import("/src/lib/collab.ts");
      // eslint-disable-next-line no-new-func
      const call = new Function("mod", "collab", "arg", `return (${source})(mod, collab, arg);`);
      return call(mod, collab, arg);
    },
    { source: fn.toString(), arg },
  );
}

async function setTab(tab, target = page) {
  await target.evaluate(async (t) => {
    const m = await import("/src/store/useUiStore.ts");
    m.useUiStore.getState().setTab(t);
  }, tab);
  await page.waitForTimeout(700);
}

/** 主窗口只保留入口，真正的协作中心在「完整工作台」窗口（workspace.html）。 */
async function openWorkbench() {
  await setTab("roadmap");
  const openBtn = page.getByRole("button", { name: /在完整工作台中打开/ });
  if (await openBtn.count()) {
    await openBtn.first().click();
  }
  const target = await waitFor(
    async () => {
      const pages = browser.contexts().flatMap((c) => c.pages());
      return pages.find((p) => /workspace\.html/i.test(p.url())) ?? null;
    },
    { timeout: 30000, label: "工作台窗口" },
  );
  page = target;
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 900 });
  await dismissOnboarding();
  await setTab("roadmap");
  await page.waitForTimeout(800);
  log(`工作台 ${page.url()}`);
}

async function openCollabVisuals() {
  await setTab("roadmap");
  await page.locator(".planning-source-switch").getByRole("button", { name: "协作中心" }).click();
  await page.waitForTimeout(900);
  await page
    .locator(".collab-toolbar")
    .getByRole("button", { name: "可视化" })
    .click();
  await page.waitForTimeout(700);
  const select = page.getByRole("combobox", { name: "选择协作项目" });
  if (await select.count()) {
    const text = (await select.textContent()) ?? "";
    if (!text.includes("验收项目")) {
      await select.click();
      await page.getByRole("option", { name: /验收项目/ }).click();
      await page.waitForTimeout(600);
    }
  }
}

async function openVisual(title) {
  const item = page.locator("button.collab-row").filter({ hasText: title }).first();
  await waitFor(async () => (await item.count()) === 1, { label: `可视化条目「${title}」` });
  await item.click();
  await page.waitForTimeout(700);
}

async function seed() {
  const project = await invokeInPage(
    (mod, _collab, arg) =>
      mod.planningCreateProject({
        name: arg.name,
        description: "第二轮验收项目",
        status: "planning",
      }),
    { name: "验收项目（协作第二轮）" },
  );
  log(`项目 ${project.id}`);

  const content = {
    schemaVersion: 1,
    viewport: { width: 400, height: 640 },
    pages: [
      {
        id: "page-1",
        name: "首页",
        components: [
          {
            id: "c1",
            type: "text",
            x: 16,
            y: 24,
            w: 300,
            h: 40,
            props: { text: "说明" },
            style: { bg: "#111111" },
            events: {},
          },
        ],
      },
      { id: "page-2", name: "第二页", components: [] },
    ],
    state: {},
  };
  const doc = await invokeInPage(
    async (_mod, collab, arg) => collab.collabVisualCreate(arg.projectId, arg.input),
    {
      projectId: project.id,
      input: {
        title: PROTOTYPE_TITLE,
        description: "第二轮验收原型",
        kind: "prototype",
        sourceFormat: "json",
        sourceContent: JSON.stringify(content),
        planId: null,
      },
    },
  );

  // 图片：用真实文件导入资产，再创建 bug_annotation 文档（避免依赖原生文件对话框）。
  const png = path.join(ROOT, "fixture.png");
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(400, 7),
  ]);
  fs.writeFileSync(png, bytes);
  const asset = await invokeInPage(
    async (_mod, collab, arg) =>
      collab.collabVisualAssetImport(arg.projectId, { path: arg.path, title: "验收截图" }),
    { projectId: project.id, path: png },
  );
  const imageDoc = await invokeInPage(
    async (_mod, collab, arg) => collab.collabVisualCreate(arg.projectId, arg.input),
    {
      projectId: project.id,
      input: {
        title: IMAGE_TITLE,
        description: "第二轮验收标注",
        kind: "bug_annotation",
        sourceFormat: "json",
        sourceContent: JSON.stringify({
          assetId: asset.id,
          width: 1280,
          height: 720,
          annotations: [],
        }),
        planId: null,
        authoringMode: "imported",
      },
    },
  );
  log(`原型 ${doc.id} / 图片 ${imageDoc.id} / 资产 ${asset.id}`);
  return { project, doc, imageDoc, asset };
}

function viewer() {
  return page.locator(".collab-visual-viewer");
}

async function openPrototypeEditor() {
  await openCollabVisuals();
  await openVisual(PROTOTYPE_TITLE);
  await viewer().getByRole("button", { name: "编辑", exact: true }).click();
  await page.waitForTimeout(600);
  await waitFor(async () => (await page.locator('[data-testid="proto-canvas"]').count()) === 1, {
    label: "原型画布",
  });
}

async function textValue() {
  return page.getByLabel("文案").inputValue();
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(LOG, "");
  await ensureVite();
  await launchGui();
  const seeded = await seed();

  await step("P0 打开完整工作台（协作中心所在窗口）", async () => {
    await openWorkbench();
    return page.url();
  });

  // ── P 原型编辑 ─────────────────────────────────────────────
  await step("P1 打开原型编辑器", async () => {
    await openPrototypeEditor();
    await shot("P1-editor");
    return `overlay=${await page.locator('[data-testid="proto-overlay"]').count()}`;
  });

  await step("P2 添加组件", async () => {
    await page.getByRole("button", { name: "添加 Button" }).click();
    await page.waitForTimeout(300);
    const n = await page.locator('[data-testid="proto-overlay"]').count();
    assert(n === 2, `期望 2 个组件，实际 ${n}`);
    await shot("P2-added");
    return `组件数=${n}`;
  });

  await step("P3 属性编辑 + 撤销 + 重做", async () => {
    await page.locator('[data-testid="proto-overlay"]').first().click();
    await page.waitForTimeout(200);
    const input = page.getByLabel("文案");
    await input.fill("验收文案");
    await page.waitForTimeout(300);
    assert((await textValue()) === "验收文案", "文案未写入");
    await page.getByRole("button", { name: "撤销" }).click();
    await page.waitForTimeout(300);
    assert((await textValue()) === "说明", `撤销后应为「说明」，实际 ${await textValue()}`);
    await page.getByRole("button", { name: "重做" }).click();
    await page.waitForTimeout(300);
    assert((await textValue()) === "验收文案", "重做未恢复");
    await shot("P3-undo-redo");
    return "撤销→说明；重做→验收文案";
  });

  await step("P4 拖拽组件（一次历史）", async () => {
    const overlay = page.locator('[data-testid="proto-overlay"]').first();
    await overlay.hover();
    const box = await overlay.boundingBox();
    assert(box, "未取得组件位置");
    const hit = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el ? `${el.tagName}.${el.className}` : "null";
      },
      [box.x + 10, box.y + 10],
    );
    const isOverlay = hit.includes("proto-overlay");
    if (isOverlay) {
      await page.mouse.move(box.x + 10, box.y + 10);
      await page.mouse.down();
      await page.mouse.move(box.x + 50, box.y + 40, { steps: 8 });
      await page.mouse.up();
    } else {
      // 画布在工作台窄栏里被缩放，鼠标坐标命不中覆盖层：改为在真实 WebView2 内
      // 向覆盖层派发 PointerEvent（仍走真实 React 事件链与真实渲染）。
      log("画布被缩放导致鼠标命中不到覆盖层，改用覆盖层 PointerEvent 派发");
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="proto-overlay"]');
        const r = el.getBoundingClientRect();
        const fire = (type, x, y) =>
          el.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              pointerId: 1,
              pointerType: "mouse",
              buttons: type === "pointerup" ? 0 : 1,
            }),
          );
        fire("pointerdown", r.x + 10, r.y + 10);
        fire("pointermove", r.x + 50, r.y + 40);
        fire("pointerup", r.x + 50, r.y + 40);
      });
    }
    await page.waitForTimeout(400);
    const moved = await overlay.boundingBox();
    assert(
      moved && moved.x > box.x + 10,
      `拖拽未生效：${box.x} → ${moved?.x}（命中元素 ${hit}）`,
    );
    await page.getByRole("button", { name: "撤销" }).click();
    await page.waitForTimeout(300);
    const back = await overlay.boundingBox();
    assert(back && Math.abs(back.x - box.x) < 2, "拖拽撤销未回到原位置");
    await page.getByRole("button", { name: "重做" }).click();
    await page.waitForTimeout(300);
    await shot("P4-drag");
    return `x ${box.x} → 移动 → 撤销回到 ${back.x}`;
  });

  await step("P5 保存生成新版本", async () => {
    await page.locator(".proto-editor-toolbar").getByRole("button", { name: /保存/ }).click();
    await waitFor(async () => {
      const text = await page.locator(".collab-visual-title").innerText();
      return /v2/.test(text);
    }, { label: "版本 v2" });
    await shot("P5-saved");
    return "v2";
  });

  await step("P6 预览只读（无组件面板/保存）", async () => {
    await page.locator(".collab-visual-head").getByRole("button", { name: "预览" }).click();
    await page.waitForTimeout(600);
    assert((await page.getByRole("button", { name: "添加 Button" }).count()) === 0, "预览仍显示组件面板");
    assert(
      (await viewer().getByRole("button", { name: /保存/ }).count()) === 0,
      "预览仍显示保存",
    );
    await shot("P6-preview");
    return "无编辑入口";
  });

  await step("P7 AI 修改作用于当前页并生成 v3", async () => {
    await page.locator(".collab-visual-head").getByRole("button", { name: "编辑", exact: true }).click();
    await page.waitForTimeout(500);
    // 选中第二页的按钮，验证 AI 不会改第一页
    await page.getByRole("tab", { name: /第二页/ }).click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "添加 Button" }).click();
    await page.waitForTimeout(300);
    // AI 修改基于已保存版本：先保存，再针对第二页的选中组件生成建议。
    await page.locator(".proto-editor-toolbar").getByRole("button", { name: /保存/ }).click();
    await waitFor(async () => /v3/.test(await page.locator(".collab-visual-title").innerText()), {
      label: "保存后版本 v3",
    });
    await page.getByRole("button", { name: /AI 修改选中组件/ }).click();
    await page.locator(".graph-ai-panel textarea").waitFor({ timeout: 15000 });
    await page.locator(".graph-ai-panel textarea").fill("补充一句验收说明");
    await page.locator(".graph-ai-panel").getByRole("button", { name: "生成建议" }).click();
    await waitFor(async () => (await page.getByRole("button", { name: "确认应用" }).count()) === 1, {
      label: "AI 提案",
    });
    const hint = await page.locator(".graph-ai-proposal").innerText();
    assert(/page-2|第二页/.test(hint) || hint.includes("第二页"), `提案未标注页面：${hint}`);
    await page.locator(".graph-ai-panel").getByRole("button", { name: "确认应用" }).click();
    await waitFor(async () => /v4/.test(await page.locator(".collab-visual-title").innerText()), {
      label: "AI 应用后版本 v4",
    });
    await shot("P7-ai");
    return "v3";
  });

  await step("P8 重新打开内容一致", async () => {
    await reloadWithRetry();
    await page.waitForTimeout(1500);
    await openPrototypeEditor();
    await page.getByRole("tab", { name: /首页/ }).click();
    await page.waitForTimeout(400);
    await page.locator('[data-testid="proto-overlay"]').first().click();
    await page.waitForTimeout(300);
    const value = await textValue();
    assert(value === "验收文案", `重开后文案=${value}`);
    const doc = await invokeInPage(
      async (_mod, collab, arg) => collab.collabVisualGet(arg.id),
      { id: seeded.doc.id },
    );
    assert(doc.version >= 4, `重开后版本=${doc.version}`);
    assert(doc.sourceContent.includes("验收文案"), "重开后内容缺少文案");
    await shot("P8-reopen");
    return `文案=${value}，版本=v${doc.version}`;
  });

  // ── I 图片预览 / 编辑 ─────────────────────────────────────
  await step("I1 图片预览只读", async () => {
    await openCollabVisuals();
    await openVisual(IMAGE_TITLE);
    await page.waitForTimeout(500);
    assert(
      (await viewer().getByRole("button", { name: /导入图片/ }).count()) === 0,
      "预览出现导入按钮",
    );
    assert(
      (await viewer().locator(".image-annotator-toolbar").count()) === 0,
      "预览出现编辑器工具条",
    );
    assert((await page.locator('[data-testid="annotation-overlay"]').count()) === 0, "预览出现可编辑覆盖层");
    assert((await page.locator('[data-testid="image-renderer"]').count()) === 1, "缺少只读渲染器");
    await shot("I1-image-preview");
    return "只读渲染器";
  });

  await step("I2 编辑图片并绘制标注", async () => {
    await page.locator(".collab-visual-head").getByRole("button", { name: "编辑", exact: true }).click();
    await page.waitForTimeout(700);
    await page.getByRole("button", { name: "矩形" }).click();
    const overlay = page.locator('[data-testid="annotation-overlay"]');
    const box = await overlay.boundingBox();
    assert(box, "未取得标注画布");
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.35, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    assert((await page.locator("[data-testid='annotation-resize-handle']").count()) === 1, "未出现缩放把手");
    await shot("I2-image-edit");
    return "标注 + 缩放把手";
  });

  await step("I3 保存标注并预览呈现", async () => {
    await page.locator(".image-annotator-toolbar").getByRole("button", { name: /保存/ }).click();
    await waitFor(async () => /v2/.test(await page.locator(".collab-visual-title").innerText()), {
      label: "图片文档 v2",
    });
    await page.locator(".collab-visual-head").getByRole("button", { name: "预览" }).click();
    await page.waitForTimeout(700);
    assert((await page.locator('[data-testid="annotation-renderer"]').count()) === 1, "预览未渲染标注层");
    assert((await page.locator('[data-testid="annotation-resize-handle"]').count()) === 0, "预览出现缩放把手");
    const text = await page.locator(".image-annotator").innerText();
    assert(text.includes("1 条标注"), `预览未显示标注数：${text.slice(0, 120)}`);
    await shot("I3-image-saved");
    return "v2，预览 1 条标注";
  });

  // ── R 重启持久化 ─────────────────────────────────────────
  await step("R1 重启后内容与版本保持", async () => {
    await shutdownGui();
    await launchGui();
    await openWorkbench();
    await openPrototypeEditor();
    await page.getByRole("tab", { name: /首页/ }).click();
    await page.waitForTimeout(400);
    await page.locator('[data-testid="proto-overlay"]').first().click();
    await page.waitForTimeout(300);
    const value = await textValue();
    assert(value === "验收文案", `重启后文案=${value}`);
    const doc = await invokeInPage(
      async (_mod, collab, arg) => collab.collabVisualGet(arg.id),
      { id: seeded.doc.id },
    );
    assert(doc.version >= 4, `重启后版本=${doc.version}`);
    await shot("R1-restart");
    return `文案=${value}，版本=v${doc.version}`;
  });

  log(`项目 ${seeded.project.id}`);
}

async function reloadWithRetry() {
  for (let i = 0; i < 5; i += 1) {
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
      return;
    } catch (err) {
      log(`刷新失败（第 ${i + 1} 次）：${String(err).split("\n")[0]}`);
      await ensureVite();
      await page.waitForTimeout(800);
    }
  }
  throw new Error("页面刷新持续失败");
}

async function shutdownGui() {
  if (!gui) return;
  const pid = gui.pid;
  gui = null;
  try {
    await page?.close();
  } catch {
    /* ignore */
  }
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  browser = null;
  page = null;
  try {
    process.kill(pid);
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 2500));
}

function writeSummary() {
  const passed = results.filter((r) => r.ok).length;
  const lines = [
    "# 协作中心第二轮修复 · Dev 功能验收",
    "",
    `- 时间：${new Date().toISOString()}`,
    `- 数据目录：${DATA}`,
    `- 通过：${passed}/${results.length}`,
    "",
    "| 步骤 | 结果 | 说明 |",
    "|---|---|---|",
    ...results.map((r) => `| ${r.name} | ${r.ok ? "通过" : "失败"} | ${String(r.detail).replace(/\|/g, "\\|")} |`),
    "",
    "截图见同目录 `*.png`，应用日志 `gui.log` / `vite.log`，详细日志 `acceptance.log`。",
  ];
  fs.writeFileSync(SUMMARY, `${lines.join("\n")}\n`);
  return { passed, total: results.length };
}

try {
  await main();
} catch (err) {
  record("验收主流程", false, `异常：${err?.stack?.split("\n")[0] ?? err}`);
} finally {
  const { passed, total } = writeSummary();
  console.log(`\n结果：${passed}/${total} 通过，证据目录 ${ROOT}`);
  if (!KEEP) {
    await shutdownGui();
    try {
      vite?.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(passed === total ? 0 : 1);
}
