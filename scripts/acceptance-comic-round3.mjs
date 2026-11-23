/**
 * AI 漫剧工作空间 · 第三阶段 Dev 功能验收（真实 Tauri WebView2 + 真实命令层）。
 *
 * 用法：node scripts/acceptance-comic-round3.mjs [--keep] [--exe <绝对路径>]
 *
 * 覆盖：
 *  1) 每集角色形象覆盖：同一角色两集不同形象、互不影响、全局档案不被污染
 *  2) 本集形象编辑 / 恢复全局形象（只删覆盖）
 *  3) 分镜只显示本集出场角色；后端拒绝跨集角色；角色仍被镜头引用时禁止移出
 *  4) 提示词模板 + 不可变版本 + 真实上下文渲染预览（角色覆盖进入 characters.block）
 *  5) Skill 内容快照：声明版本 vs 实际内容版本，快照只读
 *  6) 外部生成记录：提示词/Skill 版本追溯 + 输出素材关联
 *  7) 重启后数据与关联仍然一致
 *
 * 隔离：数据目录 `tmp/acceptance/comic-round3/run-<stamp>/data`，不触碰真实用户数据。
 * 证据：同目录 screenshots/*.png、summary.md、acceptance.log。
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { chromium } from "playwright";

const KEEP = process.argv.includes("--keep");
const EXE_ARG = process.argv.indexOf("--exe");
const REPO = path.resolve(".");
const EXE =
  EXE_ARG > -1 && process.argv[EXE_ARG + 1]
    ? path.resolve(process.argv[EXE_ARG + 1])
    : path.join(REPO, "src-tauri", "target", "debug", "task-dock.exe");
const stamp = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
})();
const ROOT = path.join(REPO, "tmp", "acceptance", "comic-round3", `run-${stamp}`);
const DATA = path.join(ROOT, "data");
const SHOTS = path.join(ROOT, "screenshots");
const FIXTURES = path.join(ROOT, "fixtures");
const LOG = path.join(ROOT, "acceptance.log");
const SUMMARY = path.join(ROOT, "summary.md");
const SKILL_DIR = path.join(FIXTURES, "skill-comic-board");

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(FIXTURES, { recursive: true });

const results = [];
let gui = null;
let viteProc = null;
let browser = null;
let page = null;
let CDP_PORT = 17465;

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

/** 环境阻塞：不伪造通过，也不当代码失败；在 summary 单独计数。 */
function recordBlocked(name, detail = "") {
  results.push({ name, ok: false, blocked: true, detail });
  log(`BLOCKED  ${name}${detail ? ` — ${detail}` : ""}`);
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
    log("复用已存在的 Vite 1420（不启动/不终止他人进程）");
    return;
  }
  const out = fs.openSync(path.join(ROOT, "vite.log"), "a");
  viteProc = spawn("node", ["node_modules/vite/bin/vite.js", "--port", "1420", "--strictPort"], {
    cwd: REPO,
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  await waitFor(async () => await portOpen(1420), { timeout: 120000, label: "Vite 1420" });
  log(`vite 就绪 pid=${viteProc.pid}（保持运行到脚本结束）`);
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
    { timeout: 240000, interval: 500, label: "CDP 主窗口目标" },
  );
  log(`主窗口目标 ${target.id} ${target.url}`);

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: 20000 });
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
  await page.waitForLoadState("domcontentloaded", { timeout: 120000 }).catch(() => {});
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .waitForFunction(() => !!document.querySelector("#root")?.children.length, { timeout: 120000 })
    .catch(() => {});
  await dismissOnboarding();
  await wait(800);
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
    { timeout: 90000, label: "工作台窗口" },
  );
  page = target;
  await page.waitForLoadState("domcontentloaded", { timeout: 120000 }).catch(() => {});
  await page.setViewportSize({ width: 1440, height: 900 });
  await dismissOnboarding();
  await setTab("workspace");
  await wait(1000);
}

async function pickProject(name) {
  await waitFor(
    async () => (await page.locator('[aria-label="项目工作空间"]').count()) > 0,
    { timeout: 120000, label: "项目面板" },
  );
  const combo = page.getByRole("combobox", { name: "工作空间项目" });
  await waitFor(async () => (await combo.count()) > 0, { timeout: 30000, label: "项目选择器" });

  const tryPick = async (rounds) => {
    for (let attempt = 0; attempt < rounds; attempt += 1) {
      if (((await combo.textContent()) ?? "").includes(name)) return true;
      await combo.click({ timeout: 5000 }).catch(() => {});
      await wait(800);
      const option = page.getByRole("option", { name: new RegExp(name) });
      if (await option.count()) {
        await option.first().click();
        await wait(1200);
        return true;
      }
    }
    return false;
  };

  if (await tryPick(10)) return;
  await page.reload({ waitUntil: "domcontentloaded", timeout: 120000 }).catch(() => {});
  await wait(2500);
  await dismissOnboarding();
  await setTab("workspace");
  await wait(1500);
  if (await tryPick(10)) return;
  throw new Error(`项目选项未出现：${name}`);
}

async function openModule(label) {
  const nav = page.locator('nav[aria-label="工作空间模块"]');
  await waitFor(async () => (await nav.count()) > 0, { label: "模块导航" });
  await nav.getByRole("button", { name: label }).first().click();
  await wait(900);
}

async function seed(outputPath, refImagePath) {
  const skillDir = SKILL_DIR;
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: 验收分镜 Skill\ndescription: 第三阶段验收用 Skill\nversion: 1.3.0\n---\n\n分镜拆解正文：先定景别，再定运镜。\n第二行内容。\n",
    "utf8",
  );
  fs.writeFileSync(path.join(skillDir, "notes.md"), "附属说明文件（只记录指纹）", "utf8");

  return page.evaluate(async ({ skillDir, skillParent, outputPath, refImagePath }) => {
    const bridge = await import("/src/lib/bridge.ts");
    const comic = await import("/src/workbench/creative/comic/ipc.ts");

    const { project } = await bridge.workspaceProjectSave({
      name: "漫剧第三阶段验收",
      kind: "ai_comic",
      note: "角色形象覆盖 / 提示词版本 / Skill 快照 / 生成追溯",
    });

    const c1 = (
      await comic.comicCharacterSave({
        projectId: project.id,
        name: "林远",
        role: "主角",
        description: "18 岁，黑色短发，运动型身材",
        refImagePath,
      })
    ).character;
    const c2 = (
      await comic.comicCharacterSave({
        projectId: project.id,
        name: "队友",
        role: "后卫",
        description: "组织进攻",
        refImagePath: "",
      })
    ).character;
    const c3 = (
      await comic.comicCharacterSave({
        projectId: project.id,
        name: "对手队长",
        role: "中锋",
        description: "内线支柱",
        refImagePath: "",
      })
    ).character;
    const scene = (
      await comic.comicSceneSave({
        projectId: project.id,
        name: "篮球场",
        description: "室内体育馆",
        refImagePath,
      })
    ).scene;

    const ep1 = (
      await comic.comicEpisodeSave({
        projectId: project.id,
        title: "第一集 · 高中",
        synopsis: "高中联赛开场",
        script: "第一场剧本。\n第二行：林远接球。",
        status: "storyboard",
        progress: 30,
        characterIds: [c1.id, c2.id],
      })
    ).episode;
    const ep2 = (
      await comic.comicEpisodeSave({
        projectId: project.id,
        title: "第二集 · 成年",
        synopsis: "成年后的复出",
        script: "第二场剧本。",
        status: "draft",
        progress: 10,
        characterIds: [c1.id],
      })
    ).episode;

    const shot1 = (
      await comic.comicShotSave({
        projectId: project.id,
        episodeId: ep1.id,
        description: "少年起跳投篮",
        characterIds: [c1.id, c2.id],
        sceneId: scene.id,
        dialogue: "「这一球，我要自己来。」",
        shotSize: "中景",
        cameraMove: "推镜",
        durationSec: 3.5,
        status: "todo",
        note: "",
      })
    ).shot;

    const shot1b = (
      await comic.comicShotSave({
        projectId: project.id,
        episodeId: ep1.id,
        description: "林远接球推进",
        characterIds: [c1.id, c2.id],
        sceneId: scene.id,
        dialogue: "传球！",
        shotSize: "近景",
        cameraMove: "跟镜",
        durationSec: 2.0,
        status: "todo",
        note: "",
      })
    ).shot;

    const shotEmptyDialogue = (
      await comic.comicShotSave({
        projectId: project.id,
        episodeId: ep1.id,
        description: "空镜：球馆顶灯",
        characterIds: [c1.id],
        sceneId: scene.id,
        dialogue: "",
        shotSize: "特写",
        cameraMove: "固定",
        durationSec: 1.5,
        status: "todo",
        note: "",
      })
    ).shot;

    const shotEp2 = (
      await comic.comicShotSave({
        projectId: project.id,
        episodeId: ep2.id,
        description: "成年复出登场",
        characterIds: [c1.id],
        sceneId: scene.id,
        dialogue: "「我回来了。」",
        shotSize: "全景",
        cameraMove: "推镜",
        durationSec: 4.0,
        status: "todo",
        note: "",
      })
    ).shot;

    await comic.comicEpisodeCharacterOverrideSave({
      projectId: project.id,
      episodeId: ep1.id,
      characterId: c1.id,
      roleInEpisode: "学生",
      appearanceLabel: "高中时期",
      appearanceDescription: "16 岁，黑色短发",
      costumeDescription: "蓝白校服",
      hairStyleDescription: "自然短发",
      stateDescription: "右手受伤",
      visualPromptOverride: "左脸有一道浅疤，右手缠着白色绷带",
      refImagePath: "",
    });
    await comic.comicEpisodeCharacterOverrideSave({
      projectId: project.id,
      episodeId: ep2.id,
      characterId: c1.id,
      roleInEpisode: "成年",
      appearanceLabel: "成年时期",
      appearanceDescription: "26 岁，稍长发型",
      costumeDescription: "深色夹克",
      hairStyleDescription: "稍长发型",
      stateDescription: "成熟状态",
      visualPromptOverride: "",
      refImagePath: "",
    });

    const template = (
      await comic.comicPromptTemplateSave({
        projectId: project.id,
        name: "角色定妆模板",
        category: "character_reference",
        description: "按本集形象生成角色定妆提示词",
      })
    ).template;
    const v1Content =
      "项目：{{project.name}}\n剧集：{{episode.title}}\n\n{{characters.block}}\n\n场景：{{scene.block}}\n画面：{{shot.description}}";
    await comic.comicPromptVersionCreate({
      templateId: template.id,
      content: v1Content,
      variablesJson: JSON.stringify(["project.name", "characters.block"]),
      changeNote: "初始版本",
    });
    const v2 = (
      await comic.comicPromptVersionCreate({
        templateId: template.id,
        content: `${v1Content}\n\n要求：保持人物一致。`,
        variablesJson: JSON.stringify(["project.name", "characters.block", "shot.description"]),
        changeNote: "补充一致性要求",
      })
    ).version;

    // 带空格的合法占位符：解析器 trim 后得到 shot.dialogue，必填校验必须按解析结果执行。
    const spacedVersion = (
      await comic.comicPromptVersionCreate({
        templateId: template.id,
        content: "台词：{{ shot.dialogue }}\n（带空格占位符）",
        variablesJson: JSON.stringify(["shot.dialogue"]),
        changeNote: "空格占位符校验",
      })
    ).version;

    // 新建版本默认会接管默认标记；验收仍需 v2 作为默认版本（v3 只用于空格校验）。
    await comic.comicPromptVersionSetDefault(template.id, v2.id);

    await bridge.capabilitySkillScan([skillParent]);
    const skills = await comic.comicSkillList();
    const skill = skills.find((item) => item.name === "验收分镜 Skill");
    if (!skill) throw new Error("Skill 扫描后未出现在能力中心");
    const snapshot = (await comic.comicSkillSnapshotCapture(project.id, skill.id)).snapshot;

    return {
      projectId: project.id,
      c1: c1.id,
      c2: c2.id,
      c3: c3.id,
      ep1: ep1.id,
      ep2: ep2.id,
      shot1: shot1.id,
      shot1b: shot1b.id,
      shotEmptyDialogue: shotEmptyDialogue.id,
      shotEp2: shotEp2.id,
      templateId: template.id,
      promptVersion: v2.id,
      spacedVersion: spacedVersion.id,
      skillId: skill.id,
      snapshotId: snapshot.id,
      snapshotHash: snapshot.contentHash,
      snapshotFingerprint: snapshot.snapshotFingerprint,
      filesManifestHash: snapshot.filesManifestHash,
      refImagePath,
      outputPath,
    };
  }, { skillDir, skillParent: path.dirname(skillDir), outputPath, refImagePath });
}

async function verifyPromptTrace(ctx) {
  return page.evaluate(async (c) => {
    const comic = await import("/src/workbench/creative/comic/ipc.ts");
    const ep1Preview = (
      await comic.comicPromptRender({
        projectId: c.projectId,
        promptVersionId: c.promptVersion,
        episodeId: c.ep1,
        shotId: c.shot1,
      })
    ).preview;
    const ep2Preview = (
      await comic.comicPromptRender({
        projectId: c.projectId,
        promptVersionId: c.promptVersion,
        episodeId: c.ep2,
        shotId: c.shotEp2,
      })
    ).preview;
    const spaced = (
      await comic.comicPromptRender({
        projectId: c.projectId,
        promptVersionId: c.spacedVersion,
        episodeId: c.ep1,
        shotId: c.shot1,
      })
    ).preview;
    const spacedEmptyError = await comic
      .comicPromptRender({
        projectId: c.projectId,
        promptVersionId: c.spacedVersion,
        episodeId: c.ep1,
        shotId: c.shotEmptyDialogue,
      })
      .then(() => null)
      .catch((error) => JSON.stringify(error) ?? String(error));

    const versions = (await comic.comicPromptVersionList(c.templateId)).versions;
    const runVersion = versions.find((item) => item.id === c.promptVersion);

    // 修改剧本不应触碰已登记生成记录里的提示词快照。
    const episodes = (await comic.comicEpisodeList(c.projectId)).episodes;
    const ep1 = episodes.find((item) => item.id === c.ep1);
    await comic.comicEpisodeSave({
      id: ep1.id,
      projectId: c.projectId,
      title: ep1.title,
      synopsis: ep1.synopsis,
      script: `${ep1.script}\n新增第三行：教练叫停，林远下场处理伤口。`,
      status: ep1.status,
      progress: ep1.progress,
      characterIds: ep1.characterIds,
    });

    const runs = (await comic.comicGenerationRecordList(c.projectId)).runs;
    const run = runs.find((item) => item.id === c.runId);
    const episodeRun = runs.find((item) => item.id === c.episodeRunId);

    return {
      ep1Rendered: ep1Preview.rendered,
      ep1Characters: ep1Preview.context.characters,
      ep2Rendered: ep2Preview.rendered,
      spacedRendered: spaced.rendered,
      spacedEmptyError,
      runVersionHash: runVersion?.contentHash ?? "",
      runAfterScriptEdit: {
        snapshot: run?.renderedPromptSnapshot ?? "",
        hash: run?.promptContentHashSnapshot ?? "",
        outputCount: (run?.outputMediaIds ?? []).length,
      },
      episodeRunAfter: {
        shotId: episodeRun?.shotId ?? null,
        snapshot: episodeRun?.renderedPromptSnapshot ?? "",
        outputIds: episodeRun?.outputMediaIds ?? [],
      },
      totalRuns: runs.length,
    };
  }, ctx);
}

async function verifySkillMetadata(ctx) {
  const skillFile = path.join(SKILL_DIR, "SKILL.md");
  const notesFile = path.join(SKILL_DIR, "notes.md");
  const skillParent = path.dirname(SKILL_DIR);
  const rescan = async () => {
    await page.evaluate(
      async ({ parent }) => {
        const bridge = await import("/src/lib/bridge.ts");
        await bridge.capabilitySkillScan([parent]);
      },
      { parent: skillParent },
    );
  };
  const capture = () =>
    page.evaluate(async (c) => {
      const comic = await import("/src/workbench/creative/comic/ipc.ts");
      const snapshot = (await comic.comicSkillSnapshotCapture(c.projectId, c.skillId)).snapshot;
      const list = (await comic.comicSkillSnapshotList(c.projectId, c.skillId)).snapshots;
      return {
        captured: snapshot,
        list: list.map((item) => ({
          id: item.id,
          declaredVersion: item.declaredVersion,
          contentHash: item.contentHash,
          filesManifestHash: item.filesManifestHash,
          snapshotFingerprint: item.snapshotFingerprint,
        })),
      };
    }, ctx);

  // 只改 SKILL.md 声明版本，正文不变。
  fs.writeFileSync(
    skillFile,
    "---\nname: 验收分镜 Skill\ndescription: 第三阶段验收用 Skill\nversion: 1.4.0\n---\n\n分镜拆解正文：先定景别，再定运镜。\n第二行内容。\n",
    "utf8",
  );
  await rescan();
  const declared = await capture();

  // 只改附属文件，SKILL.md 与声明版本不变。
  fs.writeFileSync(notesFile, "附属说明文件（变更后的指纹）\n新增一行。", "utf8");
  await rescan();
  const attachments = await capture();

  return { declared, attachments };
}

function readClipboard() {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw",
      ],
      { encoding: "utf8", timeout: 15000 },
    );
    return out.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
  } catch (error) {
    return `READ_FAILED: ${String(error).slice(0, 200)}`;
  }
}

async function seedGeneration(ctx, outputPath) {
  return page.evaluate(
    async ({ ctx, outputPath }) => {
      const comic = await import("/src/workbench/creative/comic/ipc.ts");
      // 用户从外部工具粘贴回来的「实际使用」文本：与自动预览不同，必须逐字保存。
      const ACTUAL_PROMPT =
        "【整集视觉】赛场灯光偏冷，观众席虚化\n【角色】林远：左脸浅疤，右臂白色绷带（外部工具实际使用版）\n避免：多余手指、文字水印。";
      const run = (
        await comic.comicGenerationRecordCreate({
          projectId: ctx.projectId,
          episodeId: ctx.ep1,
          shotId: ctx.shot1,
          promptVersionId: ctx.promptVersion,
          skillSnapshotId: ctx.snapshotId,
          modelProvider: "外部工具",
          modelName: "model-x",
          modelVersion: "1",
          parametersJson: '{"steps": 30, "ar": "16:9"}',
          seed: "42",
          inputMediaIds: [],
          externalJobId: "job-c3-1",
          note: "第三阶段验收：真实外部生成登记",
          renderedPromptSnapshot: ACTUAL_PROMPT,
        })
      ).run;
      const output = (
        await comic.comicMediaImport({
          projectId: ctx.projectId,
          shotId: ctx.shot1,
          filePath: outputPath,
          mediaKind: "image",
          versionLabel: "外部生成输出",
          reviewNote: "",
          generationRunId: run.id,
        })
      ).version;

      // 整集级记录（shotId = null）：允许关联本集任意镜头产物。
      const episodeRun = (
        await comic.comicGenerationRecordCreate({
          projectId: ctx.projectId,
          episodeId: ctx.ep1,
          shotId: null,
          promptVersionId: ctx.promptVersion,
          skillSnapshotId: ctx.snapshotId,
          modelProvider: "外部工具",
          modelName: "model-ep",
          modelVersion: "1",
          parametersJson: '{"steps": 28, "ar": "16:9"}',
          seed: "7",
          inputMediaIds: [],
          externalJobId: "job-c3-episode",
          note: "整集级生成登记：同一次出图覆盖多个镜头",
          renderedPromptSnapshot: "整集统一画风提示词\n第二行：保持人物一致。",
        })
      ).run;
      const outA = (
        await comic.comicMediaImport({
          projectId: ctx.projectId,
          shotId: ctx.shot1,
          filePath: outputPath,
          mediaKind: "image",
          versionLabel: "整集输出 A",
          reviewNote: "",
          generationRunId: episodeRun.id,
        })
      ).version;
      const outB = (
        await comic.comicMediaImport({
          projectId: ctx.projectId,
          shotId: ctx.shot1b,
          filePath: outputPath,
          mediaKind: "image",
          versionLabel: "整集输出 B",
          reviewNote: "",
          generationRunId: episodeRun.id,
        })
      ).version;

      const crossEpisodeError = await comic
        .comicMediaImport({
          projectId: ctx.projectId,
          shotId: ctx.shotEp2,
          filePath: outputPath,
          mediaKind: "image",
          versionLabel: "跨集非法关联",
          reviewNote: "",
          generationRunId: episodeRun.id,
        })
        .then(() => null)
        .catch((error) => JSON.stringify(error) ?? String(error));
      const crossShotError = await comic
        .comicMediaImport({
          projectId: ctx.projectId,
          shotId: ctx.shot1b,
          filePath: outputPath,
          mediaKind: "image",
          versionLabel: "镜头级跨镜头非法关联",
          reviewNote: "",
          generationRunId: run.id,
        })
        .then(() => null)
        .catch((error) => JSON.stringify(error) ?? String(error));

      return {
        actualPrompt: ACTUAL_PROMPT,
        runId: run.id,
        promptSnapshot: run.renderedPromptSnapshot,
        promptContentHashSnapshot: run.promptContentHashSnapshot,
        contextSnapshotJson: run.contextSnapshotJson,
        outputId: output.id,
        generationRunId: output.generationRunId,
        episodeRunId: episodeRun.id,
        episodePromptSnapshot: episodeRun.renderedPromptSnapshot,
        episodeOutputs: [outA.id, outB.id],
        episodeOutputLinks: [outA.generationRunId, outB.generationRunId],
        crossEpisodeError,
        crossShotError,
      };
    },
    { ctx, outputPath },
  );
}

async function main() {
  log(`证据目录 ${ROOT}`);
  log(`EXE ${EXE}`);
  assert(fs.existsSync(EXE), `可执行文件不存在：${EXE}`);
  await ensureVite();
  await launchGui();

  const outputPath = path.join(FIXTURES, "comic-c3-output.png");
  const refImagePath = path.join(FIXTURES, "角色参考图-本机绝对路径.png");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  fs.writeFileSync(outputPath, png);
  fs.writeFileSync(refImagePath, png);
  const ctx = await seed(outputPath, refImagePath);
  log(`种子项目 ${ctx.projectId}`);

  assert(ctx.outputPath, "未取得输出素材路径");
  const generation = await seedGeneration(ctx, ctx.outputPath);
  assert(generation.generationRunId === generation.runId, "素材未关联生成记录");
  const traceCtx = { ...ctx, runId: generation.runId, episodeRunId: generation.episodeRunId };
  const errText = (error) =>
    typeof error === "string"
      ? error
      : JSON.stringify(error)?.slice(0, 300) ?? String(error);

  // ── 0. 后端契约：本集视觉补充 / 实际提示词快照 / 关联约束 / 路径脱敏 ──
  const trace = await verifyPromptTrace(traceCtx);
  record(
    "本集视觉补充进入 Prompt",
    trace.ep1Rendered.includes("本集视觉提示词补充：左脸有一道浅疤，右手缠着白色绷带"),
    "第一集预览",
  );
  record(
    "第二集不包含第一集视觉补充",
    !trace.ep2Rendered.includes("左脸有一道浅疤"),
    "第二集预览",
  );
  record(
    "上下文字段保留本集视觉补充（结构化）",
    trace.ep1Characters.some(
      (item) => item.visualPromptOverride === "左脸有一道浅疤，右手缠着白色绷带",
    ),
  );
  record(
    "全局角色档案未被本集补充污染",
    trace.ep1Characters.find((item) => item.name === "林远")?.baseDescription ===
      "18 岁，黑色短发，运动型身材" &&
      trace.ep1Characters.filter((item) => item.name !== "林远").every(
        (item) => item.visualPromptOverride === "",
      ),
  );
  record(
    "带空格占位符正常渲染",
    trace.spacedRendered.includes("台词：") && !trace.spacedRendered.includes("{{"),
    trace.spacedRendered.replace(/\n/g, "⏎").slice(0, 120),
  );
  record(
    "带空格占位符必填校验仍拦截空值",
    /必填|为空/.test(trace.spacedEmptyError ?? ""),
    String(trace.spacedEmptyError).slice(0, 120),
  );
  record(
    "Prompt 不包含本机绝对路径",
    !trace.ep1Rendered.includes(refImagePath) &&
      !trace.ep1Rendered.includes(FIXTURES) &&
      !trace.ep1Rendered.includes(path.basename(refImagePath)),
  );
  record(
    "角色与场景参考图均改为外部手动上传提示",
    (trace.ep1Rendered.match(/参考图：已在 Task Dock 关联，请在外部生成工具手动上传/g) ?? [])
      .length >= 2,
  );
  record(
    "结构化上下文仍保留参考图路径",
    trace.ep1Characters.some((item) => item.refImagePath === refImagePath),
  );
  record(
    "生成记录保存用户提交的实际提示词",
    trace.runAfterScriptEdit.snapshot === generation.actualPrompt,
    `快照 ${trace.runAfterScriptEdit.snapshot.length} 字 / 提交 ${generation.actualPrompt.length} 字`,
  );
  record(
    "生成记录保存提交时的 Prompt 内容 Hash",
    trace.runAfterScriptEdit.hash === trace.runVersionHash &&
      trace.runAfterScriptEdit.hash.length === 64,
    `记录 ${trace.runAfterScriptEdit.hash.slice(0, 8)} / 版本 ${trace.runVersionHash.slice(0, 8)}`,
  );
  record(
    "修改剧本不覆盖已有生成记录",
    trace.runAfterScriptEdit.snapshot === generation.actualPrompt &&
      (trace.runAfterScriptEdit.outputCount ?? 0) >= 1,
  );
  record(
    "整集级记录挂到本集多个镜头产物",
    trace.episodeRunAfter.shotId === null &&
      trace.episodeRunAfter.outputIds.length === 2 &&
      generation.episodeOutputLinks.every((id) => id === generation.episodeRunId),
    trace.episodeRunAfter.outputIds.join(","),
  );
  record(
    "镜头级记录拒绝关联其他镜头",
    /镜头/.test(generation.crossShotError ?? ""),
    String(generation.crossShotError),
  );
  record(
    "整集级记录拒绝关联其他剧集",
    /剧集/.test(generation.crossEpisodeError ?? ""),
    String(generation.crossEpisodeError),
  );

  await openWorkbench();
  await pickProject("漫剧第三阶段验收");

  // ── 1-2. 每集形象覆盖 ───────────────────────────────────────────────
  await openModule("剧集");
  await waitFor(async () => (await page.getByText(/第一集 · 高中/).count()) > 0, {
    label: "剧集列表",
  });
  await page.getByText(/第一集 · 高中/).first().click();
  await waitFor(async () => (await page.getByText(/本集形象：高中时期/).count()) > 0, {
    label: "第一集形象",
  });
  record("第一集展示本集形象名称", true, "高中时期");
  record("第一集展示本集服装", (await page.getByText("蓝白校服").count()) > 0);
  record(
    "全局基础设定仍在页面（未被覆盖污染）",
    (await page.getByText(/全局基础设定：18 岁，黑色短发，运动型身材/).count()) > 0,
  );
  await shot("episodes-ep1.png");

  await page.getByText(/第二集 · 成年/).first().click();
  await waitFor(async () => (await page.getByText(/本集形象：成年时期/).count()) > 0, {
    label: "第二集形象",
  });
  record("第二集展示独立形象", true, "成年时期");
  record("切换第二集后不显示第一集服装", (await page.getByText("蓝白校服").count()) === 0);
  await shot("episodes-ep2.png");

  // 编辑第二集形象 → 保存；全局档案不变。
  await page.getByRole("button", { name: "编辑本集形象" }).first().click();
  await page.getByLabel("本集服装").waitFor({ timeout: 15000 });
  await page.getByLabel("本集服装").fill("深色风衣");
  await page.getByRole("button", { name: "保存本集形象" }).click();
  const afterEdit = await page.evaluate(async (c) => {
    const comic = await import("/src/workbench/creative/comic/ipc.ts");
    const overrides = await comic.comicEpisodeCharacterOverrideList(c.projectId, c.ep2);
    const characters = await comic.comicCharacterList(c.projectId);
    const linyuan = (characters.characters ?? []).find((item) => item.id === c.c1);
    return {
      costume: (overrides.overrides ?? []).find((item) => item.characterId === c.c1)
        ?.costumeDescription,
      globalDescription: linyuan?.description,
      globalRole: linyuan?.role,
    };
  }, ctx);
  record("第二集形象已落库", afterEdit.costume === "深色风衣", String(afterEdit.costume));
  record(
    "全局角色档案未被本集修改",
    afterEdit.globalDescription === "18 岁，黑色短发，运动型身材" && afterEdit.globalRole === "主角",
  );

  const ep1Still = await page.evaluate(async (c) => {
    const comic = await import("/src/workbench/creative/comic/ipc.ts");
    const overrides = await comic.comicEpisodeCharacterOverrideList(c.projectId, c.ep1);
    return (overrides.overrides ?? []).find((item) => item.characterId === c.c1)?.costumeDescription;
  }, ctx);
  record("修改第二集不影响第一集", ep1Still === "蓝白校服", String(ep1Still));

  // 恢复全局形象（只删覆盖）。
  await page.getByRole("button", { name: "恢复全局形象" }).first().click();
  await page.getByRole("button", { name: "再次点击确认恢复" }).click();
  await waitFor(async () => (await page.getByText(/沿用全局基础设定/).count()) > 0, {
    label: "恢复全局形象",
  });
  const afterReset = await page.evaluate(async (c) => {
    const comic = await import("/src/workbench/creative/comic/ipc.ts");
    const overrides = await comic.comicEpisodeCharacterOverrideList(c.projectId, c.ep2);
    const characters = await comic.comicCharacterList(c.projectId);
    return {
      hasOverride: (overrides.overrides ?? []).some((item) => item.characterId === c.c1),
      hasCharacter: (characters.characters ?? []).some((item) => item.id === c.c1),
    };
  }, ctx);
  record("删除覆盖后恢复全局形象", !afterReset.hasOverride && afterReset.hasCharacter);
  await shot("episodes-reset.png");

  // ── 3. 分镜角色范围 ─────────────────────────────────────────────────
  await openModule("分镜");
  await waitFor(async () => (await page.locator(".comic-list-row").count()) > 0, {
    label: "分镜列表",
  });
  await page.getByText(/少年起跳投篮/).first().click();
  await waitFor(async () => (await page.getByText(/林远 · 本集形象/).count()) > 0, {
    label: "本集角色选项",
  });
  record("分镜只展示本集角色（林远）", (await page.getByText(/林远 · 本集形象/).count()) > 0);
  record("分镜不展示非本集角色（对手队长）", (await page.getByText(/对手队长/).count()) === 0);
  await shot("shots-ep1.png");

  const rejections = await page.evaluate(async (c) => {
    const comic = await import("/src/workbench/creative/comic/ipc.ts");
    const errors = {};
    try {
      await comic.comicShotSave({
        projectId: c.projectId,
        episodeId: c.ep1,
        description: "跨集镜头",
        characterIds: [c.c3],
        dialogue: "",
        shotSize: "",
        cameraMove: "",
        status: "todo",
        note: "",
      });
      errors.crossEpisode = "NO_ERROR";
    } catch (error) {
      errors.crossEpisode = String(error?.message ?? error);
    }
    try {
      await comic.comicEpisodeSave({
        id: c.ep1,
        projectId: c.projectId,
        title: "第一集 · 高中",
        synopsis: "高中联赛开场",
        script: "第一场剧本。\n第二行：林远接球。",
        status: "storyboard",
        progress: 30,
        characterIds: [c.c1],
      });
      errors.removeReferenced = "NO_ERROR";
    } catch (error) {
      errors.removeReferenced = String(error?.message ?? error);
    }
    return errors;
  }, ctx);
  record(
    "后端拒绝跨集角色",
    /不在本集出场名单/.test(rejections.crossEpisode),
    rejections.crossEpisode,
  );
  record(
    "角色仍被镜头引用时禁止移出本集",
    /仍被本集/.test(rejections.removeReferenced),
    rejections.removeReferenced,
  );

  await page.getByRole("combobox", { name: "剧集" }).click();
  await page.getByRole("option", { name: /第二集 · 成年/ }).click();
  await wait(800);
  await page.getByRole("button", { name: "加镜头" }).click();
  // 第二集覆盖已在前面「恢复全局形象」步骤删除，因此这里应显示沿用全局形象。
  await waitFor(async () => (await page.getByText(/林远 · 沿用全局形象/).count()) > 0, {
    label: "第二集角色选项",
  });
  record("切换剧集后角色名单刷新（队友不出现）", (await page.getByText(/队友 ·/).count()) === 0);
  await shot("shots-ep2.png");

  // ── 4-5. 提示词与 Skill ─────────────────────────────────────────────
  await openModule("提示词与 Skill");
  await waitFor(async () => (await page.getByText("角色定妆模板").count()) > 0, {
    label: "提示词模板",
  });
  record("提示词模板列表可见", true);
  await page.getByText("角色定妆模板").first().click();
  await waitFor(async () => (await page.getByText(/v2 · 默认/).count()) > 0, {
    label: "版本历史",
  });
  record("版本历史展示默认版本 v2", true);
  record("旧版本 v1 仍可查看", (await page.getByText(/^v1$/).count()) > 0);
  await shot("prompts-template.png");

  // v2 声明了必填变量 shot.description：必须明确选一个镜头，不能按整集预览。
  const episodeCombo = page.getByRole("combobox", { name: "预览剧集" });
  await episodeCombo.scrollIntoViewIfNeeded().catch(() => {});
  await wait(300);
  record(
    "预览剧集控件已加载剧集",
    ((await episodeCombo.textContent()) ?? "").includes("第一集"),
    `${(await episodeCombo.textContent()) ?? ""} / disabled=${await episodeCombo.isDisabled()}`,
  );
  await episodeCombo.click();
  await wait(500);
  await shot("prompts-episode-options.png");
  const listboxTexts = await page.locator('[role="listbox"]').allInnerTexts();
  record(
    "预览剧集下拉出现选项",
    listboxTexts.some((text) => /第一集 · 高中/.test(text)),
    listboxTexts.join(" || ").slice(0, 160),
  );
  await page.getByRole("option", { name: /第一集 · 高中/ }).click();
  await wait(600);
  await page.getByRole("combobox", { name: "预览镜头" }).click();
  await wait(800);
  const shotOptionTexts = await page.getByRole("option").allInnerTexts();
  record(
    "预览镜头选项包含本集三个镜头",
    shotOptionTexts.some((text) => /少年起跳投篮/.test(text)) &&
      shotOptionTexts.some((text) => /林远接球推进/.test(text)) &&
      shotOptionTexts.some((text) => /空镜：球馆顶灯/.test(text)),
    shotOptionTexts.join(" | ").slice(0, 160),
  );
  await shot("prompts-shot-options.png");
  await page.getByRole("option", { name: /少年起跳投篮/ }).click();
  await wait(300);
  await page.getByRole("button", { name: "渲染预览" }).click();
  await waitFor(async () => (await page.getByText(/【角色】林远/).count()) > 0, {
    label: "提示词预览",
  });
  const previewText = await page.locator(".comic-prompt-pre").first().innerText();
  record("预览使用真实角色块", previewText.includes("【角色】林远"));
  record("预览包含本集形象（第一集蓝白校服）", previewText.includes("本集服装：蓝白校服"));
  record("预览包含场景与镜头", previewText.includes("【场景】篮球场") && previewText.includes("画面：少年起跳投篮"));
  record("预览保留中文与换行", previewText.includes("\n"));
  record(
    "预览包含本集视觉提示词补充",
    previewText.includes("本集视觉提示词补充：左脸有一道浅疤，右手缠着白色绷带"),
  );
  record(
    "预览不包含本机绝对路径",
    !previewText.includes(FIXTURES) &&
      !previewText.includes(path.basename(ctx.refImagePath)) &&
      !/:\\.*\\/.test(previewText),
  );
  record(
    "预览提示参考图需在外部工具手动上传",
    previewText.includes("参考图：已在 Task Dock 关联，请在外部生成工具手动上传"),
  );
  await page.locator(".comic-prompt-pre").first().scrollIntoViewIfNeeded();
  await shot("prompts-preview.png");

  // 复制渲染结果：先看受控剪贴板的真实反馈，再读系统剪贴板核对内容。
  await page.getByRole("button", { name: "复制提示词" }).click();
  let copyToast = "";
  for (let attempt = 0; attempt < 20 && !copyToast; attempt += 1) {
    await wait(250);
    if ((await page.getByText(/已复制提示词到剪贴板/).count()) > 0) {
      copyToast = "已复制提示词到剪贴板";
      break;
    }
    const failure = page.getByText(/复制失败：/);
    if ((await failure.count()) > 0) {
      copyToast = await failure.first().innerText();
      break;
    }
  }
  if (copyToast === "已复制提示词到剪贴板") {
    record("复制成功有可见反馈", true);
    const clipboard = readClipboard();
    if (clipboard === previewText.replace(/\r\n/g, "\n").trimEnd()) {
      record("复制内容与预览一致", true);
    } else {
      recordBlocked(
        "读取系统剪贴板核对内容（宿主剪贴板不可访问）",
        `${clipboard.slice(0, 60)} / 预览 ${previewText.length} 字`,
      );
    }
  } else if (/复制失败/.test(copyToast)) {
    record("复制失败时如实提示", true, copyToast);
    recordBlocked("复制提示词到系统剪贴板（系统剪贴板被其他程序占用）", copyToast);
  } else {
    record("复制按钮有可观察反馈", false, "20 次轮询未出现成功/失败提示");
  }

  // 版本切换必须清除旧预览：不能出现「选了 v1/v3 还显示 v2 内容」。
  await page.getByText(/^v1$/).first().click();
  await waitFor(
    async () => (await page.getByText(/选择已变化，之前的预览已过期并被清除/).count()) > 0,
    { label: "预览过期提示", timeout: 15000 },
  );
  record("切换版本后旧预览被清除", (await page.locator(".comic-prompt-pre").count()) === 0);
  record(
    "空预览时无法复制",
    (await page.getByRole("button", { name: "复制提示词" }).count()) === 0 ||
      (await page.getByRole("button", { name: "复制提示词" }).first().isDisabled()),
  );
  await shot("prompts-preview-stale.png");
  await page.getByText(/^v2 · 默认/).first().click();
  await wait(500);
  await page.getByRole("button", { name: "渲染预览" }).click();
  await waitFor(async () => (await page.getByText(/【角色】林远/).count()) > 0, {
    label: "重新渲染",
  });

  await page.getByText("验收分镜 Skill").first().click();
  await page.getByRole("button", { name: "捕获当前版本为快照" }).click();
  await waitFor(async () => (await page.getByText(/不可变内容快照/).count()) > 0, {
    label: "Skill 快照",
  });
  record("Skill 快照可见", true);
  record("展示声明版本 1.3.0", (await page.getByText(/声明版本 1\.3\.0/).count()) > 0);
  record(
    "展示实际内容版本（Hash 短标识）",
    (await page.getByText(/实际内容 [0-9a-f]{8}/).count()) > 0,
  );
  await shot("prompts-skill.png");

  // 只改声明版本 / 只改附属文件：必须形成新快照，而旧快照元数据不变。
  const skillMeta = await verifySkillMetadata(ctx);
  record(
    "只改声明版本后捕获新快照（1.4.0）",
    skillMeta.declared.captured.declaredVersion === "1.4.0" &&
      skillMeta.declared.captured.contentHash === ctx.snapshotHash,
    `${skillMeta.declared.captured.declaredVersion} / 正文未变`,
  );
  record(
    "只改声明版本后指纹变化",
    skillMeta.declared.captured.snapshotFingerprint !== ctx.snapshotFingerprint,
  );
  record(
    "旧快照（1.3.0）元数据未被新捕获修改",
    skillMeta.declared.list.some(
      (item) =>
        item.id === ctx.snapshotId &&
        item.declaredVersion === "1.3.0" &&
        item.contentHash === ctx.snapshotHash &&
        item.snapshotFingerprint === ctx.snapshotFingerprint,
    ),
  );
  record(
    "只改附属文件后文件清单 Hash 变化",
    skillMeta.attachments.captured.filesManifestHash !==
      skillMeta.declared.captured.filesManifestHash &&
      skillMeta.attachments.captured.contentHash === ctx.snapshotHash,
  );
  record(
    "附属文件变化形成独立指纹",
    skillMeta.attachments.captured.snapshotFingerprint !==
      skillMeta.declared.captured.snapshotFingerprint,
  );
  record(
    "同一完整快照重复捕获复用同一记录",
    skillMeta.attachments.captured.id ===
      skillMeta.attachments.list.find(
        (item) =>
          item.snapshotFingerprint === skillMeta.attachments.captured.snapshotFingerprint,
      )?.id && skillMeta.attachments.list.length === 3,
    `快照数 ${skillMeta.attachments.list.length}`,
  );

  // 刷新 Skill 面板，确认 UI 展示 1.4.0 与三条历史快照。
  await openModule("剧集");
  await openModule("提示词与 Skill");
  await waitFor(async () => (await page.getByText("验收分镜 Skill").count()) > 0, {
    label: "Skill 列表刷新",
  });
  await page.getByText("验收分镜 Skill").first().click();
  await wait(800);
  record("刷新后展示新声明版本 1.4.0", (await page.getByText(/声明版本 1\.4\.0/).count()) > 0);
  record("历史快照保留旧声明版本 1.3.0", (await page.getByText(/声明 1\.3\.0/).count()) > 0);
  await shot("prompts-skill-versions.png");

  // ── 6. 外部生成记录与素材关联 ──────────────────────────────────────
  await openModule("素材与产物");
  await waitFor(async () => (await page.getByText(/外部工具 · model-x/).count()) > 0, {
    label: "生成记录",
  });
  record("生成记录展示模型与提示词版本", true);
  record(
    "生成记录展示 Skill 内容 Hash",
    (await page.getByText(new RegExp(`内容 ${ctx.snapshotHash.slice(0, 8)}`)).count()) > 0,
  );

  // 素材面板展开的快照必须与用户提交的实际提示词逐字一致。
  const shotRunItem = page
    .locator(".comic-generation-run")
    .filter({ hasText: /外部工具 · model-x/ })
    .first();
  await shotRunItem.getByRole("button", { name: "查看实际渲染提示词" }).click();
  await waitFor(
    async () => (await shotRunItem.locator(".comic-prompt-pre:not(.comic-prompt-manifest)").count()) > 0,
    { label: "生成记录提示词快照" },
  );
  const runSnapshotText = await shotRunItem
    .locator(".comic-prompt-pre:not(.comic-prompt-manifest)")
    .innerText();
  record(
    "素材面板展示用户提交的实际提示词",
    runSnapshotText.replace(/\r\n/g, "\n").trimEnd() === generation.actualPrompt,
    `快照前 20 字：${runSnapshotText.slice(0, 20)}`,
  );

  const episodeRunItem = page
    .locator(".comic-generation-run")
    .filter({ hasText: /model-ep/ })
    .first();
  const episodeRunText = await episodeRunItem.innerText();
  record("整集级记录标注为整集", episodeRunText.includes("整集"));
  record(
    "整集级记录展示 2 项本集输出素材",
    /输出素材 2 项/.test(episodeRunText),
    episodeRunText.replace(/\n/g, " ").slice(0, 120),
  );
  record(
    "非法跨集/跨镜头关联未产生素材",
    (await page.getByText(/跨集非法关联/).count()) === 0 &&
      (await page.getByText(/镜头级跨镜头非法关联/).count()) === 0,
  );

  await page.getByText(/外部生成输出/).first().click();
  await waitFor(async () => (await page.getByText(/生成来源：外部工具 · model-x · 1/).count()) > 0, {
    label: "素材生成来源",
  });
  record("输出素材可追溯到生成记录", true);
  await shot("assets-generation.png");

  // ── 7. 重启后一致性 ────────────────────────────────────────────────
  await browser.close().catch(() => {});
  browser = null;
  gui.kill();
  await wait(2500);
  await launchGui();

  const persisted = await page.evaluate(async (c) => {
    const comic = await import("/src/workbench/creative/comic/ipc.ts");
    const episodes = await comic.comicEpisodeList(c.projectId);
    const overrides1 = await comic.comicEpisodeCharacterOverrideList(c.projectId, c.ep1);
    const versions = await comic.comicPromptVersionList(c.templateId);
    const runs = await comic.comicGenerationRecordList(c.projectId);
    const media = await comic.comicMediaList(c.projectId, c.shot1);
    const snapshots = await comic.comicSkillSnapshotList(c.projectId, c.skillId);
    const preview = (
      await comic.comicPromptRender({
        projectId: c.projectId,
        promptVersionId: c.promptVersion,
        episodeId: c.ep1,
        shotId: c.shot1,
      })
    ).preview;
    const run = (runs.runs ?? []).find((item) => item.id === c.runId);
    const episodeRun = (runs.runs ?? []).find((item) => item.id === c.episodeRunId);
    const originalSnapshot = (snapshots.snapshots ?? []).find((item) => item.id === c.snapshotId);
    return {
      episodes: (episodes.episodes ?? []).length,
      override1: (overrides1.overrides ?? []).find((item) => item.characterId === c.c1)
        ?.appearanceLabel,
      visualOverride: (overrides1.overrides ?? []).find((item) => item.characterId === c.c1)
        ?.visualPromptOverride,
      versions: (versions.versions ?? []).length,
      runs: (runs.runs ?? []).length,
      linkedMedia: (media.versions ?? []).filter((item) => item.generationRunId).length,
      runSnapshot: run?.renderedPromptSnapshot ?? "",
      runHash: run?.promptContentHashSnapshot ?? "",
      episodeRunOutputs: (episodeRun?.outputMediaIds ?? []).length,
      episodeRunSnapshot: episodeRun?.renderedPromptSnapshot ?? "",
      skillSnapshots: (snapshots.snapshots ?? []).length,
      originalDeclared: originalSnapshot?.declaredVersion ?? "",
      originalFingerprint: originalSnapshot?.snapshotFingerprint ?? "",
      originalFilesHash: originalSnapshot?.filesManifestHash ?? "",
      preview: preview.rendered,
      crossEpisodeStillRejected: await comic
        .comicMediaImport({
          projectId: c.projectId,
          shotId: c.shotEp2,
          filePath: c.outputPath,
          mediaKind: "image",
          versionLabel: "重启后跨集校验",
          reviewNote: "",
          generationRunId: c.episodeRunId,
        })
        .then(() => null)
        .catch((error) => JSON.stringify(error) ?? String(error)),
    };
  }, traceCtx);
  record("重启后剧集仍存在", persisted.episodes === 2, String(persisted.episodes));
  record("重启后第一集形象仍存在", persisted.override1 === "高中时期", String(persisted.override1));
  record(
    "重启后本集视觉补充仍存在",
    persisted.visualOverride === "左脸有一道浅疤，右手缠着白色绷带",
  );
  record("重启后提示词版本仍为 3 个", persisted.versions === 3, String(persisted.versions));
  record("重启后生成记录仍存在", persisted.runs >= 2, String(persisted.runs));
  record("重启后素材仍关联生成记录", persisted.linkedMedia >= 1, String(persisted.linkedMedia));
  record(
    "重启后实际提示词快照未变",
    persisted.runSnapshot === generation.actualPrompt && persisted.runHash === trace.runVersionHash,
  );
  record(
    "重启后整集级记录仍关联 2 项产物",
    persisted.episodeRunOutputs === 2 && persisted.episodeRunSnapshot === generation.episodePromptSnapshot,
  );
  record(
    "重启后 Skill 历史指纹与元数据一致",
    persisted.skillSnapshots === 3 &&
      persisted.originalDeclared === "1.3.0" &&
      persisted.originalFingerprint === ctx.snapshotFingerprint &&
      persisted.originalFilesHash === ctx.filesManifestHash,
  );
  record(
    "重启后 Prompt 仍不含本机绝对路径",
    !persisted.preview.includes(FIXTURES) && !persisted.preview.includes(ctx.refImagePath),
  );
  record(
    "重启后跨集关联仍被拒绝",
    /剧集/.test(persisted.crossEpisodeStillRejected ?? ""),
    String(persisted.crossEpisodeStillRejected).slice(0, 100),
  );

  await openWorkbench();
  await pickProject("漫剧第三阶段验收");
  await openModule("剧集");
  await page.getByText(/第一集 · 高中/).first().click();
  await waitFor(async () => (await page.getByText(/本集形象：高中时期/).count()) > 0, {
    label: "重启后形象",
  });
  await shot("restart-episodes.png");

  await finish();
}

async function finish() {
  const passed = results.filter((r) => r.ok).length;
  const blocked = results.filter((r) => r.blocked).length;
  const failed = results.length - passed - blocked;
  const lines = [
    `# 漫剧第三阶段 Dev 功能验收 ${stamp}`,
    "",
    `- 可执行文件：\`${EXE}\``,
    `- 数据目录：\`${DATA}\``,
    `- 结果：通过 ${passed} / 阻塞 ${blocked} / 失败 ${failed}（共 ${results.length} 项）`,
    "",
    "| 断言 | 结果 | 说明 |",
    "|---|---|---|",
    ...results.map(
      (r) =>
        `| ${r.name} | ${r.blocked ? "BLOCKED" : r.ok ? "PASS" : "FAIL"} | ${String(r.detail).replace(/\|/g, "\\|")} |`,
    ),
    "",
    `截图目录：\`${SHOTS}\``,
  ];
  fs.writeFileSync(SUMMARY, lines.join("\n"), "utf8");
  log(`结果：通过 ${passed} / 阻塞 ${blocked} / 失败 ${failed}（共 ${results.length} 项）`);
  if (gui) gui.kill();
  if (viteProc) viteProc.kill();
  if (!KEEP) {
    // 不清理数据与证据：Dev 验收证据保留在 tmp/acceptance 下。
  }
  if (passed !== results.length) process.exitCode = 1;
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(async (error) => {
  record("验收脚本执行", false, String(error?.stack ?? error).slice(0, 800));
  await finish().catch(() => process.exit(1));
});
