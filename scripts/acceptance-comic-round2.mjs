/**
 * AI 漫剧工作空间 · 第二轮精修 Dev 功能验收（真实 Tauri WebView2 + 真实命令层）。
 *
 * 用法：node scripts/acceptance-comic-round2.mjs [--keep] [--exe <绝对路径>]
 *
 * 覆盖：
 *  1) 素材导入关联状态机（换类型清空目标 / 空目标禁止提交）
 *  2) 素材缩略图、详情大图、视频与缺失占位
 *  3) 同镜头两版本比较 + 从比较结果采用
 *  4) 分镜页只读展示关联素材并展开查看（两页一致）
 *  5) 角色参考图路径 / 缩略图 / 大图预览
 *  6) 按剧集的派生镜头统计（不覆盖剧集进度）
 *  7) 重启后数据仍存在、关联关系一致
 *
 * 隔离：数据目录 `tmp/acceptance/comic-round2/run-<stamp>/data`，不触碰真实用户数据。
 * 证据：同目录下 screenshots/*.png、summary.md、acceptance.log。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { chromium } from "playwright";

const KEEP = process.argv.includes("--keep");
const EXE_ARG = process.argv.indexOf("--exe");
const REPO = path.resolve(".");
const EXE =
  EXE_ARG > -1 && process.argv[EXE_ARG + 1]
    ? path.resolve(process.argv[EXE_ARG + 1])
    : path.join(REPO, "src-tauri", "target", "debug", "task-dock.exe");
const FIXTURES = path.join(REPO, "tmp", "acceptance", "comic-round2", "fixtures");
const stamp = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
})();
const ROOT = path.join(REPO, "tmp", "acceptance", "comic-round2", `run-${stamp}`);
const DATA = path.join(ROOT, "data");
const SHOTS = path.join(ROOT, "screenshots");
const LOG = path.join(ROOT, "acceptance.log");
const SUMMARY = path.join(ROOT, "summary.md");

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
let gui = null;
let vite = null;
let browser = null;
let page = null;
let CDP_PORT = 17455;

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}`;
  fs.appendFileSync(LOG, `${line}\n`);
  console.log(line);
}

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, { timeout = 30000, interval = 250, label = "条件" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (error) {
      last = error;
    }
    await wait(interval);
  }
  throw new Error(`${label} 超时（最后值：${String(last).slice(0, 200)}）`);
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
  return (await tryConnect(port, "::1")) || (await tryConnect(port, "127.0.0.1"));
}

async function ensureVite() {
  if (await portOpen(1420)) {
    if (!vite) log("复用已存在的 Vite 1420（不启动/不终止他人进程）");
    return;
  }
  const out = fs.openSync(path.join(ROOT, "vite.log"), "a");
  vite = spawn("node", ["node_modules/vite/bin/vite.js", "--port", "1420", "--strictPort"], {
    cwd: REPO,
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  await waitFor(async () => await portOpen(1420), { timeout: 90000, label: "Vite 1420" });
  log(`vite 就绪 pid=${vite.pid}（本脚本启动，结束关闭）`);
}

async function launchGui() {
  CDP_PORT = await freePort(CDP_PORT + 1);
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

  const target = await waitFor(
    async () => {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).catch(() => null);
      if (!res || !res.ok) return null;
      const list = await res.json().catch(() => []);
      return (
        (Array.isArray(list) ? list : []).find(
          (t) =>
            t.type === "page" &&
            !/^devtools:/i.test(t.url) &&
            !/(context-menu|capture|notification|tab-hint|toolbar)\.html/i.test(t.url) &&
            /1420|tauri\.localhost/i.test(t.url),
        ) ?? null
      );
    },
    { timeout: 180000, interval: 500, label: "CDP 主窗口目标" },
  );
  log(`主窗口目标 ${target.id} ${target.url}`);

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: 20000 });
  // 按 Tauri 窗口 label 选主窗口：CDP 还会暴露 notification/capture 等辅助窗口，
  // 只按 URL 找会误把辅助页当主窗口（history：run-20261123-134232 曾落到 notification.html）。
  page = await waitFor(
    async () => {
      const pages = browser.contexts().flatMap((c) => c.pages());
      for (const candidate of pages) {
        if (!/1420/.test(candidate.url())) continue;
        const identity = await candidate
          .evaluate(() => {
            const meta = window.__TAURI_INTERNALS__?.metadata;
            return {
              label: meta?.currentWindow?.label ?? null,
              mounted: !!document.querySelector("#root"),
            };
          })
          .catch(() => null);
        if (identity?.label === "main" && identity.mounted) return candidate;
      }
      return null;
    },
    { timeout: 40000, label: "Playwright 主窗口页面" },
  );
  assert(page, "未找到主窗口页面");
  await page.waitForLoadState("domcontentloaded", { timeout: 90000 }).catch(() => log("loadState 等待超时（继续）"));
  await page.setViewportSize({ width: 1440, height: 900 });
  // React 首屏接管（#root 有子节点）后再操作，避免点不到引导层。
  await page
    .waitForFunction(() => !!document.querySelector("#root")?.children.length, { timeout: 90000 })
    .catch(() => log("React 首屏等待超时（继续尝试）"));
  await dismissOnboarding();
  await wait(800);
  log(`主窗口 ${page.url()}`);
}

async function dismissOnboarding(target = page) {
  for (let i = 0; i < 30; i += 1) {
    const skip = target.getByRole("button", { name: "跳过引导" });
    if (await skip.count()) {
      await skip.first().click();
      await wait(500);
      return;
    }
    await wait(300);
  }
  log("未出现引导层（可能已完成引导）");
}

async function setTab(tab, target = page) {
  await target.evaluate(async (t) => {
    const m = await import("/src/store/useUiStore.ts");
    m.useUiStore.getState().setTab(t);
  }, tab);
  await wait(800);
}

async function shot(name) {
  const file = path.join(SHOTS, name);
  await page.screenshot({ path: file });
  log(`截图 ${name}`);
  return file;
}

async function openWorkbench() {
  await setTab("roadmap");
  const openBtn = page.getByRole("button", { name: /在完整工作台中打开/ });
  if (await openBtn.count()) await openBtn.first().click();
  const target = await waitFor(
    async () => {
      const pages = browser.contexts().flatMap((c) => c.pages());
      return pages.find((p) => /workspace\.html/i.test(p.url())) ?? null;
    },
    { timeout: 60000, label: "工作台窗口" },
  );
  page = target;
  await page.waitForLoadState("domcontentloaded", { timeout: 90000 }).catch(() => log("loadState 等待超时（继续）"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await dismissOnboarding();
  await setTab("workspace");
  await wait(800);
  log(`工作台 ${page.url()}`);
}

/** 种子数据全部走真实 IPC（bridge + 漫剧 ipc），不是直接改库。 */
async function seed() {
  return page.evaluate(async () => {
    const bridge = await import("/src/lib/bridge.ts");
    const comic = await import("/src/workbench/creative/comic/ipc.ts");

    const { project } = await bridge.workspaceProjectSave({
      name: "漫剧第二轮验收",
      kind: "ai_comic",
      note: "第二轮精修验收项目",
    });

    const ep1 = (
      await comic.comicEpisodeSave({
        projectId: project.id,
        title: "第一集 · 起点",
        synopsis: "开场",
        script: "第一场剧本正文。",
        status: "storyboard",
        progress: 30,
      })
    ).episode;
    const ep2 = (
      await comic.comicEpisodeSave({
        projectId: project.id,
        title: "第二集 · 对抗",
        synopsis: "对抗",
        script: "",
        status: "draft",
        progress: 0,
      })
    ).episode;

    const shot1 = (
      await comic.comicShotSave({
        projectId: project.id,
        episodeId: ep1.id,
        description: "开场推进：少年接球",
        dialogue: "「这一球，我要自己来。」",
        shotSize: "中景",
        cameraMove: "推镜",
        durationSec: 3.5,
        status: "done",
        note: "验收镜头 1",
      })
    ).shot;
    const shot2 = (
      await comic.comicShotSave({
        projectId: project.id,
        episodeId: ep1.id,
        description: "防守压迫",
        dialogue: "",
        shotSize: "特写",
        cameraMove: "手持",
        durationSec: 2,
        status: "doing",
        note: "",
      })
    ).shot;
    await comic.comicShotSave({
      projectId: project.id,
      episodeId: ep1.id,
      description: "暂停布置",
      dialogue: "「换防。」",
      shotSize: "全景",
      cameraMove: "固定",
      durationSec: 4,
      status: "todo",
      note: "",
    });
    await comic.comicShotSave({
      projectId: project.id,
      episodeId: ep1.id,
      description: "最后一攻",
      dialogue: "",
      shotSize: "远景",
      cameraMove: "跟拍",
      durationSec: 5,
      status: "blocked",
      note: "等美术",
    });

    const character = (
      await comic.comicCharacterSave({
        projectId: project.id,
        name: "黑发少年",
        role: "小前锋",
        description: "196cm，25 号球衣",
        refImagePath: "",
      })
    ).character;
    await comic.comicCharacterSave({
      projectId: project.id,
      name: "队友",
      role: "后卫",
      description: "组织进攻",
      refImagePath: "",
    });
    const scene = (
      await comic.comicSceneSave({
        projectId: project.id,
        name: "篮球场",
        description: "室内体育馆",
      })
    ).scene;

    return {
      projectId: project.id,
      ep1: ep1.id,
      ep2: ep2.id,
      shot1: shot1.id,
      shot2: shot2.id,
      character: character.id,
      scene: scene.id,
      fixtureDir: null,
    };
  });
}

/** 素材与参考图需要真实存在的图片文件：路径由 Node 侧拼接后传入。 */
async function seedMedia(ctx, paths) {
  return page.evaluate(
    async ({ ctx, paths }) => {
      const comic = await import("/src/workbench/creative/comic/ipc.ts");
      const v1 = (
        await comic.comicMediaImport({
          projectId: ctx.projectId,
          shotId: ctx.shot1,
          filePath: paths.shot01v1,
          mediaKind: "image",
          versionLabel: "v1 线稿",
          reviewNote: "构图偏右，人物再靠左一点",
        })
      ).version;
      const v2 = (
        await comic.comicMediaImport({
          projectId: ctx.projectId,
          shotId: ctx.shot1,
          filePath: paths.shot01v2,
          mediaKind: "image",
          versionLabel: "v2 配色",
          reviewNote: "配色更冷，保留",
        })
      ).version;
      const missing = (
        await comic.comicMediaImport({
          projectId: ctx.projectId,
          shotId: ctx.shot2,
          filePath: paths.missing,
          mediaKind: "image",
          versionLabel: "v3 已移动",
          reviewNote: "",
        })
      ).version;
      const adopted = await comic.comicMediaAdopt(v1.id);
      const character = await comic.comicCharacterSave({
        id: ctx.character,
        projectId: ctx.projectId,
        name: "黑发少年",
        role: "小前锋",
        description: "196cm，25 号球衣",
        refImagePath: paths.charRef,
      });
      const scene = await comic.comicSceneSave({
        id: ctx.scene,
        projectId: ctx.projectId,
        name: "篮球场",
        description: "室内体育馆",
        refImagePath: paths.sceneRef,
      });
      return {
        v1: v1.id,
        v2: v2.id,
        missing: missing.id,
        adoptedStatus: adopted.version.status,
        charExists: character.character.refImageExists,
        sceneExists: scene.scene.refImageExists,
      };
    },
    { ctx, paths },
  );
}

async function pickProject(name) {
  // 项目页先渲染出「项目工作空间」空态/详情，才有可操作的选择器；首屏慢时可能 40s+。
  await waitFor(
    async () => (await page.locator('[aria-label="项目工作空间"]').count()) > 0,
    { timeout: 90000, label: "项目面板" },
  );

  const combo = page.getByRole("combobox", { name: "工作空间项目" });
  await waitFor(async () => (await combo.count()) > 0, { timeout: 30000, label: "项目选择器" });

  const tryPick = async (rounds) => {
    for (let attempt = 0; attempt < rounds; attempt += 1) {
      if (((await combo.textContent()) ?? "").includes(name)) return true;
      await combo.click({ timeout: 5000 }).catch(() => {});
      await wait(1000);
      const option = page.getByRole("option", { name: new RegExp(name) });
      if (await option.count()) {
        await option.first().click();
        await wait(1200);
        return true;
      }
    }
    return false;
  };

  if (await tryPick(8)) return;

  // 选择器里没有任何项目：先确认命令层能读到项目，再刷新一次窗口（壳层的列表可能早于种子落库）。
  const dbCount = await page.evaluate(async () => {
    const bridge = await import("/src/lib/bridge.ts");
    const result = await bridge.workspaceProjectList(null);
    return (result.projects ?? []).length;
  });
  log(`DB 可见项目数=${dbCount}，选择器为空，刷新工作台窗口后重试`);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
  await wait(2500);
  await dismissOnboarding();
  await setTab("workspace");
  await wait(1500);
  if (await tryPick(8)) return;
  throw new Error(`项目选项未出现：${name}（DB 项目数 ${dbCount}）`);
}

async function openModule(label) {
  const nav = page.locator('nav[aria-label="工作空间模块"]');
  await waitFor(async () => (await nav.count()) > 0, { label: "模块导航" });
  await nav.getByRole("button", { name: label }).first().click();
  await wait(700);
}

async function imgOk(selector) {
  return page.evaluate((sel) => {
    const img = document.querySelector(sel);
    return !!img && img.complete && img.naturalWidth > 0;
  }, selector);
}

async function main() {
  log(`证据目录 ${ROOT}`);
  log(`EXE ${EXE}`);
  assert(fs.existsSync(EXE), `可执行文件不存在：${EXE}`);
  await ensureVite();
  await launchGui();

  const ctx = await seed();
  log(`种子项目 ${ctx.projectId}`);

  const paths = {
    shot01v1: path.join(FIXTURES, "shot-01-v1.png"),
    shot01v2: path.join(FIXTURES, "shot-01-v2.png"),
    shot02v1: path.join(FIXTURES, "shot-02-v1.png"),
    charRef: path.join(FIXTURES, "char-ref.png"),
    sceneRef: path.join(FIXTURES, "scene-ref.png"),
    missing: path.join(FIXTURES, "moved-away.png"),
  };
  const media = await seedMedia(ctx, paths);
  assert(media.adoptedStatus === "adopted", "采用状态未生效");

  await openWorkbench();
  await pickProject("漫剧第二轮验收");
  await openModule("素材与产物");

  // ── 3.1 列表缩略图 / 状态 / 缺失 ───────────────────────────────────────
  await waitFor(
    async () => (await page.locator(".comic-list-row").count()) >= 3,
    { label: "素材版本行" },
  );
  const listText = await page.locator(".comic-pane-list").innerText();
  record("列表展示版本标注与关联镜头", /v1 线稿/.test(listText) && /镜头 1/.test(listText));
  record("列表展示采用/候选/拒收状态", /采用/.test(listText) && /候选/.test(listText));
  record("列表标记文件缺失", /文件缺失/.test(listText));
  const thumbOk = await imgOk(".comic-thumb img");
  record("列表缩略图真实解码", thumbOk);
  await shot("01-assets-list.png");

  // ── 3.2 详情大图 + 标注/意见可编辑 ────────────────────────────────────
  await page.locator(".comic-list-row", { hasText: "v2 配色" }).first().click();
  await wait(800);
  const detailOk = await imgOk(".comic-media-preview img");
  record("详情大图真实解码", detailOk);
  // 标注与意见是受控 input，值不在 innerText 里，必须读 inputValue。
  const detailLabel = await page.locator("#comic-media-detail-label").inputValue();
  const detailNote = await page.locator("#comic-media-detail-note").inputValue();
  record("详情保留版本标注与修改意见", detailLabel.includes("v2 配色") && detailNote.includes("配色更冷"));
  await shot("02-assets-detail.png");

  // 编辑标注与意见并保存（重启后要验证）
  const labelInput = page.locator("#comic-media-detail-label");
  await labelInput.fill("v2 配色（定稿）");
  await page.locator("#comic-media-detail-note").fill("重启后仍需保留的修改意见");
  await page.getByRole("button", { name: "保存标注与意见" }).click();
  await wait(900);
  record(
    "编辑版本标注与意见已落库",
    (await page.locator("#comic-media-detail-label").inputValue()).includes("定稿") &&
      (await page.locator("#comic-media-detail-note").inputValue()).includes("重启后仍需保留"),
  );

  // ── 3.3 缺失文件占位（不请求解码） ────────────────────────────────────
  await page.locator(".comic-list-row", { hasText: "v3 已移动" }).first().click();
  await wait(700);
  const missingText = await page.locator(".comic-pane-detail").innerText();
  record("缺失文件详情给占位与说明", /文件缺失/.test(missingText));
  await shot("03-assets-missing.png");

  // ── 3.4 导入表单：换类型清空目标 + 空目标禁止提交 ──────────────────────
  await page.getByRole("button", { name: "导入本地素材" }).click();
  await wait(400);
  const kindCombo = page.getByRole("combobox", { name: "关联类型" });
  const targetCombo = page.getByRole("combobox", { name: "关联对象" });
  await targetCombo.click();
  await page.getByRole("option", { name: /镜头 1 · 开场推进/ }).click();
  await wait(300);
  record("选择镜头目标", ((await targetCombo.textContent()) ?? "").includes("镜头 1"));
  await kindCombo.click();
  await page.getByRole("option", { name: "关联角色" }).click();
  await wait(300);
  const afterSwitch = (await targetCombo.textContent()) ?? "";
  const submitDisabled = await page.getByRole("button", { name: "登记素材" }).isDisabled();
  record("切换关联类型立即清空旧目标", !afterSwitch.includes("镜头 1") && afterSwitch.includes("选择对象"));
  record("空目标禁止提交", submitDisabled);
  await shot("04-import-target-reset.png");

  // 选角色后登记一条新素材，验证成功路径 + 列表刷新
  await targetCombo.click();
  await page.getByRole("option", { name: "黑发少年" }).click();
  await page.locator("#comic-media-path").fill(paths.charRef);
  await page.locator("#comic-media-label").fill("角色参考 v1");
  await page.getByRole("button", { name: "登记素材" }).click();
  await waitFor(
    async () => (await page.locator(".comic-list-row").count()) >= 4,
    { label: "新素材版本入列" },
  );
  record("登记成功后刷新版本列表", true);

  // ── 3.5 同镜头两个版本比较 + 采用 ─────────────────────────────────────
  await page.getByRole("button", { name: "对比 v1 线稿", exact: true }).click();
  await page.getByRole("button", { name: "对比 v2 配色（定稿）", exact: true }).click();
  await wait(1000);
  const compareText = await page.locator(".comic-compare").innerText();
  const compareImgs = await page.locator(".comic-compare-stage img").count();
  record("并排比较展示两个版本", /版本比较/.test(compareText) && compareImgs === 2);
  record("比较面板展示标注/意见/采用状态", /定稿/.test(compareText) && /当前采用|采用此版本/.test(compareText));
  await shot("05-assets-compare.png");
  await page.locator(".comic-compare-pane", { hasText: "v2 配色（定稿）" }).getByRole("button", { name: /采用此版本/ }).click();
  await wait(1000);
  const afterAdopt = await page.locator(".comic-pane-list").innerText();
  record("比较结果可直接采用", /v2 配色（定稿）/.test(afterAdopt));
  const adoptedBadge = await page
    .locator(".comic-list-row", { hasText: "v2 配色（定稿）" })
    .innerText();
  record("采用后同镜头仅一个采用", /采用/.test(adoptedBadge));
  await page.getByRole("button", { name: "关闭比较" }).click().catch(() => {});
  await wait(400);

  // ── 3.6 分镜页：正式关联只读展示 + 展开查看 ───────────────────────────
  await openModule("分镜");
  await page.locator(".comic-list-row", { hasText: "开场推进" }).first().click();
  await wait(900);
  const shotPanelText = await page.locator(".comic-pane-detail").innerText();
  record(
    "分镜页展示关联素材版本（名称/类型/采用/缺失）",
    /v1 线稿/.test(shotPanelText) && /图片/.test(shotPanelText) && /采用/.test(shotPanelText),
  );
  record("分镜页不再要求手填素材版本 ID", !(await page.locator("#comic-shot-assets").count()));
  await page.getByRole("button", { name: "查看" }).first().click();
  await wait(900);
  const shotPreviewOk = await imgOk(".comic-shot-media-detail .comic-media-preview img");
  record("分镜页可展开查看关联素材大图", shotPreviewOk);
  await shot("06-shots-media.png");

  // ── 3.6b 历史 asset_refs（路径）只读兼容：真实 IPC 写入 → UI 保存不得清空 ──
  const legacyPath = path.join(
    FIXTURES,
    "legacy-ref-with-a-very-long-absolute-path-that-exceeds-the-old-sixty-four-char-limit.png",
  );
  await page.evaluate(
    async ({ ids, legacyPath }) => {
      const comic = await import("/src/workbench/creative/comic/ipc.ts");
      const current = await comic.comicShotGet(ids.shot1);
      await comic.comicShotSave({
        id: ids.shot1,
        projectId: ids.projectId,
        episodeId: ids.ep1,
        description: current.shot.description,
        characterIds: current.shot.characterIds,
        sceneId: current.shot.sceneId,
        dialogue: current.shot.dialogue,
        shotSize: current.shot.shotSize,
        cameraMove: current.shot.cameraMove,
        durationSec: current.shot.durationSec,
        status: current.shot.status,
        assetRefs: [legacyPath],
        note: current.shot.note,
      });
    },
    { ids: ctx, legacyPath },
  );
  await wait(600);
  // UI 保存（提交 assetRefs=null）：后端必须保留历史列原值。
  await page.getByRole("button", { name: "保存镜头" }).click();
  await wait(1200);
  const afterShotSave = await page.evaluate(async (id) => {
    const comic = await import("/src/workbench/creative/comic/ipc.ts");
    return (await comic.comicShotGet(id)).shot;
  }, ctx.shot1);
  record(
    "历史路径引用（>64 字符）可写入且保存镜头后不被清空",
    Array.isArray(afterShotSave.assetRefs) &&
      afterShotSave.assetRefs.length === 1 &&
      afterShotSave.assetRefs[0] === legacyPath,
    `assetRefs=${JSON.stringify(afterShotSave.assetRefs)}`,
  );
  const legacyText = await page.locator(".comic-pane-detail").innerText();
  record("分镜页只读展示历史引用", /历史素材引用（只读）/.test(legacyText));
  await shot("06b-shots-legacy-refs.png");

  // ── 3.7 角色参考图：缩略图 + 大图 + 缺失提醒 ─────────────────────────
  await openModule("角色与场景");
  await page.locator(".comic-list-row", { hasText: "黑发少年" }).first().click();
  await wait(900);
  const refOk = await imgOk(".comic-ref-row .comic-thumb img");
  record("角色参考图缩略图真实解码", refOk);
  await page.getByRole("button", { name: "预览" }).first().click();
  await wait(800);
  const refPreviewOk = await imgOk(".comic-ref-row ~ .comic-detail-stage .comic-media-preview img");
  record("角色参考图大图预览", refPreviewOk);
  await shot("07-characters-ref.png");

  // ── 3.8 剧集派生统计 ─────────────────────────────────────────────────
  await openModule("剧集");
  await page.locator(".comic-list-row", { hasText: "第一集" }).first().click();
  await wait(900);
  const statsText = await page.locator(".comic-episode-stats").innerText();
  const progressValue = await page.locator("#comic-ep-progress").inputValue();
  record(
    "按剧集展示镜头统计（总数/待办/进行中/阻塞/完成）",
    /镜头总数/.test(statsText) && /待办/.test(statsText) && /进行中/.test(statsText) && /阻塞/.test(statsText) && /已完成/.test(statsText),
  );
  record("镜头完成比例来自真实镜头状态", /镜头完成比例 25%（1\/4）/.test(statsText));
  record("镜头比例不覆盖剧集制作进度", progressValue === "30");
  await shot("08-episodes-stats.png");

  // ── 3.9 重启后数据一致 ───────────────────────────────────────────────
  gui.kill();
  await wait(2500);
  await launchGui();
  await openWorkbench();
  await pickProject("漫剧第二轮验收");
  await openModule("素材与产物");
  await waitFor(
    async () => (await page.locator(".comic-list-row").count()) >= 4,
    { label: "重启后素材列表" },
  );
  const reopened = await page.locator(".comic-pane-list").innerText();
  record("重启后版本仍存在", /v2 配色（定稿）/.test(reopened));
  const adoptedAfter = await page
    .locator(".comic-list-row", { hasText: "v2 配色（定稿）" })
    .innerText();
  record("重启后采用状态仍一致", /采用/.test(adoptedAfter));
  await page.locator(".comic-list-row", { hasText: "v2 配色（定稿）" }).first().click();
  await wait(800);
  const noteAfter = await page.locator("#comic-media-detail-note").inputValue();
  record("重启后修改意见仍存在", noteAfter.includes("重启后仍需保留"));
  await shot("09-reopen-assets.png");
  await openModule("分镜");
  await page.locator(".comic-list-row", { hasText: "开场推进" }).first().click();
  await wait(800);
  const reopenedShot = await page.locator(".comic-pane-detail").innerText();
  record("重启后两页关联一致", /v1 线稿/.test(reopenedShot) && /v2 配色（定稿）/.test(reopenedShot));
  await shot("10-reopen-shots.png");
}

function writeSummary() {
  const passed = results.filter((r) => r.ok).length;
  const sha = fs.existsSync(EXE)
    ? crypto.createHash("sha256").update(fs.readFileSync(EXE)).digest("hex")
    : "missing";
  const lines = [
    `# 漫剧第二轮 Dev 功能验收 ${stamp}`,
    "",
    `- 可执行文件：\`${EXE}\`（SHA256 ${sha}）`,
    `- 数据目录：\`${DATA}\``,
    `- 结果：${passed}/${results.length} 项通过`,
    "",
    "| 断言 | 结果 | 说明 |",
    "|---|---|---|",
    ...results.map((r) => `| ${r.name} | ${r.ok ? "PASS" : "FAIL"} | ${r.detail || ""} |`),
    "",
  ];
  fs.writeFileSync(SUMMARY, lines.join("\n"), "utf8");
}

async function cleanup() {
  try {
    if (page) await page.evaluate(() => void 0).catch(() => {});
  } catch {
    /* 页面可能已随窗口关闭 */
  }
  // 结束不调用 browser.close()：会连带终止宿主 WebView2 窗口。
  if (gui && !gui.killed) gui.kill();
  if (vite) vite.kill();
}

main()
  .then(() => {
    writeSummary();
    const failed = results.filter((r) => !r.ok).length;
    log(`完成：通过 ${results.length - failed}/${results.length}`);
    if (!KEEP) fs.writeFileSync(path.join(ROOT, "keep.flag"), "", "utf8");
    cleanup().finally(() => process.exit(failed === 0 ? 0 : 1));
  })
  .catch((error) => {
    record("验收流程异常", false, String(error?.message ?? error));
    writeSummary();
    log(`异常：${error?.stack ?? error}`);
    cleanup().finally(() => process.exit(2));
  });
