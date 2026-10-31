//! P1-05 联合负载期间的可见窗口 UI 驱动（CDP 附加 Tauri WebView2）。
//!
//! 真实操作：打开/关闭剪贴板抽屉、搜索历史、打开图片详情预览、返回、重复多轮；
//! 另外通过真实 Tauri command 创建一条 10 秒后到期的提醒，验证提醒/通知链路。
//! 计时口径：从点击到目标 DOM 可见（含后端查询与渲染），不是帧率。
//!
//! 用法：node scripts/acceptance/joint-ui-drive.mjs --port 9224 --out <dir> --cycles 8

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attachMainWindow } from "./cdp-main-window.mjs";

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const port = Number(opt("port", "9224"));
const outDir = opt("out", "docs/clipboard/evidence/p1-05-ui");
const cycles = Number(opt("cycles", "8"));
const tag = opt("tag", "p1-05");
const probeText = opt("probe-text", "taskdock-p1-05");
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 主窗口识别（P1-01）：
 * 每轮全量枚举 CDP targets，按 URL 排除 context-menu.html，
 * 再用页面内 Tauri 窗口身份（__TAURI_INTERNALS__.metadata.currentWindow.label==="main"）
 * + #root 挂载 + invoke 可用三重验证；有限重试（deadline 默认 20s），
 * 识别失败立即终止并落盘完整枚举记录，绝不取「第一个页面」碰运气。
 */
async function connect() {
  const browser = await withRetry(
    () => chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 }),
    `CDP 连接失败：127.0.0.1:${port}`,
  );
  const targetLog = [];
  const picked = await attachMainWindow({
    port,
    deadlineMs: 20000,
    intervalMs: 500,
    log: (e) => targetLog.push(e),
    probe: async (info) => {
      // 从已连接的 browser 里找对应 target 的页面并读取身份。
      const page = browser
        .contexts()
        .flatMap((ctx) => ctx.pages())
        .find((p) => !p.url().startsWith("devtools://") && p.url() === info.url)
        ?? null;
      if (!page) throw new Error(`target ${info.targetId} 无对应 Playwright 页面`);
      return page.evaluate(() => {
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
  if (!picked.ok) {
    await browser.close().catch(() => {});
    writeFileSync(join(outDir, "target-selection-failure.json"), JSON.stringify({ port, ...picked }, null, 2));
    throw new Error(`主窗口识别失败：${picked.reason}`);
  }
  const page = findPageByUrl(browser, picked.target.url);
  if (!page) {
    await browser.close().catch(() => {});
    throw new Error(`已选中 target ${picked.target.targetId}（${picked.target.url}）但 Playwright 中找不到对应页面`);
  }
  return { browser, page, target: picked.target, targetLog };
}

function findPageByUrl(browser, url) {
  return (
    browser
      .contexts()
      .flatMap((ctx) => ctx.pages())
      .find((p) => !p.url().startsWith("devtools://") && p.url() === url) ?? null
  );
}

async function withRetry(fn, message, attempts = 12) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await sleep(1000);
    }
  }
  throw new Error(`${message}（重试 ${attempts} 次：${String(last).slice(0, 200)}）`);
}

function p95(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * 0.95))];
}

const report = {
  started_at: new Date().toISOString(),
  port,
  cycles,
  open_ms: [],
  search_ms: [],
  preview_ms: [],
  back_ms: [],
  close_ms: [],
  ui_mode: null,
  search_counts: [],
  preview_pixels: [],
  reminder: null,
  monitor_start: null,
  monitor_end: null,
  console_errors: [],
  screenshots: [],
  failures: [],
};

const { browser: browser0, page: page0, target: mainTarget, targetLog } = await connect();
let browser = browser0;
let page = page0;
report.page_url = page.url();
report.target = {
  targetId: mainTarget.targetId,
  url: mainTarget.url,
  title: mainTarget.title,
  identity: mainTarget.identity,
  rationale: mainTarget.rationale ?? null,
};
report.target_selection_log = targetLog;
page.on("console", (m) => {
  if (m.type() === "error") report.console_errors.push(m.text().slice(0, 300));
});
page.on("pageerror", (e) => report.console_errors.push(String(e).slice(0, 300)));

let locs;
function bindLocators() {
  locs = {
    openBtn: page.locator('button[aria-label="打开智能剪贴板"]').first(),
    navClipboard: page.locator('nav[aria-label="主导航"] button[aria-label^="剪贴板"]').first(),
    navTasks: page.locator('nav[aria-label="主导航"] button[aria-label^="任务"]').first(),
    searchInput: page.locator('input[aria-label="搜索剪贴板历史"]').first(),
    closeBtn: page.locator('button[aria-label="关闭剪贴板"]').first(),
    backBtn: page.locator('button[aria-label="返回列表"]').first(),
  };
}
bindLocators();

/** Long Tasks 观测（§4.3 主线程长任务计数）；重新附着后需重装。 */
async function installLongTaskObserver() {
  await page
    .evaluate(() => {
      if (window.__longTasks) return;
      window.__longTasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__longTasks.push({ dur: Math.round(e.duration), at: Math.round(e.startTime) });
          }
        }).observe({ entryTypes: ["longtask"] });
      } catch {
        /* 环境不支持 longtask 时留空数组 */
      }
    })
    .catch(() => {});
}
await installLongTaskObserver();

/**
 * 主窗口 target 在运行中被销毁（窗口重建 / CDP 断开）时，
 * 用同一套识别逻辑重新附着（有界：单次运行最多 3 次，成功或明确失败）。
 */
async function reattachMainWindow(where) {
  report.reattaches = (report.reattaches ?? 0) + 1;
  if (report.reattaches > 3) throw new Error(`主窗口重新识别次数超限（>3），在 ${where} 处终止`);
  const re = await connect();
  await browser.close().catch(() => {});
  browser = re.browser;
  page = re.page;
  report.target = {
    targetId: re.target.targetId,
    url: re.target.url,
    title: re.target.title,
    identity: re.target.identity,
    reattached_at: new Date().toISOString(),
  };
  report.target_selection_log.push(...re.targetLog);
  bindLocators();
  await installLongTaskObserver();
}

const TARGET_GONE_RE = /Target closed|Session closed|context or browser has been closed|Target crashed/i;

async function openClipboard() {
  if (await locs.openBtn.isVisible().catch(() => false)) {
    await locs.openBtn.click();
    report.ui_mode = "drawer";
  } else {
    await locs.navClipboard.click();
    report.ui_mode = "full";
  }
  await locs.searchInput.waitFor({ state: "visible", timeout: 5000 });
}

async function closeClipboard() {
  if (await locs.closeBtn.isVisible().catch(() => false)) {
    await locs.closeBtn.click();
  } else {
    await locs.navTasks.click();
  }
  await locs.searchInput.waitFor({ state: "hidden", timeout: 5000 });
}

async function monitorSnapshot() {
  const status = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("clipboard_status", {})
  );
  return {
    monitoring: status.monitoring,
    capture_allowed: status.captureAllowed,
    config_error: status.configError,
    ...(status.monitor ?? {}),
  };
}

try {
  report.monitor_start = await monitorSnapshot();
} catch (e) {
  report.failures.push(`读取监听计数失败（开始）：${String(e).slice(0, 200)}`);
}

try {
  await locs.openBtn
    .waitFor({ state: "visible", timeout: 5000 })
    .catch(() => locs.navClipboard.waitFor({ state: "visible", timeout: 25000 }));
} catch (e) {
  report.failures.push(`找不到剪贴板入口：${String(e).slice(0, 200)}`);
}

// 真实提醒：10 秒后到期，走 scheduler → notification_history → 系统通知
try {
  const remindAt = new Date(Date.now() + 10000).toISOString();
  const created = await page.evaluate(
    async ({ remindAt }) =>
      window.__TAURI_INTERNALS__.invoke("create_task", {
        input: {
          title: "P1-05 联合负载提醒（验收实例）",
          remind_at: remindAt,
        },
      }),
    { remindAt }
  );
  report.reminder = { created_id: created?.id ?? null, remind_at: remindAt, notified: null };
} catch (e) {
  report.failures.push(`创建提醒失败：${String(e).slice(0, 300)}`);
}

for (let i = 0; i < cycles; i += 1) {
  try {
    let t0 = Date.now();
    await openClipboard();
    report.open_ms.push(Date.now() - t0);

    t0 = Date.now();
    await locs.searchInput.fill(probeText);
    await page
      .locator(".clip-item")
      .first()
      .waitFor({ state: "visible", timeout: 5000 })
      .catch(() => {});
    report.search_ms.push(Date.now() - t0);
    report.search_counts.push(await page.locator(".clip-item").count());

    await locs.searchInput.fill("");
    await sleep(250);

    const imageCard = page.locator('.clip-item[aria-label^="图片："]').first();
    t0 = Date.now();
    await imageCard.click({ timeout: 5000 });
    await locs.backBtn.waitFor({ state: "visible", timeout: 5000 });
    // 大图经 convertFileSrc 异步解码，等 naturalWidth>0 再读像素，避免把「未加载」记成 0×0
    await page
      .waitForFunction(
        () => {
          const img = document.querySelector(".clip-detail img");
          return !!img && img.complete && img.naturalWidth > 0;
        },
        { timeout: 5000 }
      )
      .catch(() => {});
    report.preview_ms.push(Date.now() - t0);
    const pixels = await page.evaluate(() => {
      const img = document.querySelector(".clip-detail img");
      if (!img) return null;
      const base = { w: img.naturalWidth, h: img.naturalHeight, complete: img.complete };
      // 尝试画布采样验证颜色（激励图为确定性 RGBA：左不透明蓝/中半透明绿/右全透明）。
      // asset 协议若不允许跨域读取，这里如实记录 blocked，不伪造像素值。
      try {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const px = (x, y) => {
          const i = (Math.max(0, Math.min(c.height - 1, y | 0)) * c.width + Math.max(0, Math.min(c.width - 1, x | 0))) * 4;
          return [d[i], d[i + 1], d[i + 2], d[i + 3]];
        };
        return {
          ...base,
          canvas: "ok",
          left: px(2, c.height / 2),
          center: px(c.width / 2, c.height / 2),
          right: px(c.width - 3, c.height / 2),
        };
      } catch (err) {
        return { ...base, canvas: `blocked:${String(err).slice(0, 80)}` };
      }
    });
    report.preview_pixels.push(pixels);
    if (i === 1) {
      const shot = join(outDir, `${tag}-ui-image-preview.png`);
      const shotStart = Date.now();
      await page.screenshot({ path: shot });
      report.screenshot_ms = Date.now() - shotStart;
      report.screenshots.push(shot);
    }

    t0 = Date.now();
    await locs.backBtn.click();
    await page.locator(".clip-item").first().waitFor({ state: "visible", timeout: 5000 });
    report.back_ms.push(Date.now() - t0);

    t0 = Date.now();
    await closeClipboard();
    report.close_ms.push(Date.now() - t0);
  } catch (e) {
    report.failures.push(`第 ${i + 1} 轮失败：${String(e).slice(0, 300)}`);
    if (TARGET_GONE_RE.test(String(e))) {
      // 主窗口 target 失效（重建/断开）：用同一识别逻辑重新附着后继续下一轮。
      try {
        await reattachMainWindow(`第 ${i + 1} 轮 catch`);
        report.failures.push(`第 ${i + 1} 轮后已重新识别主窗口：targetId=${report.target.targetId} url=${report.target.url}`);
        continue;
      } catch (e2) {
        report.failures.push(`重新识别失败，终止剩余轮次：${String(e2).slice(0, 200)}`);
        break;
      }
    }
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(500);
  }
  await sleep(400);
}

// ===== 第五轮新增场景（任务书 §4.1-4/8/9：筛选切换、截图分组、展开分组详情）=====
// 先确保剪贴板视图打开且处于历史页。
try {
  await openClipboard();
  report.filter_checks = [];
  const chips = [
    { id: "text", label: "文字" },
    { id: "image", label: "图片" },
    { id: "all", label: "全部" },
  ];
  for (const chip of chips) {
    const t0 = Date.now();
    const btn = page
      .locator('[role="group"][aria-label="类型筛选"] button', { hasText: chip.label })
      .first();
    await btn.click({ timeout: 5000 });
    await page
      .locator(".clip-item")
      .first()
      .waitFor({ state: "visible", timeout: 5000 })
      .catch(() => {});
    report.filter_checks.push({
      kind: chip.id,
      ms: Date.now() - t0,
      pressed: await btn.getAttribute("aria-pressed"),
      items: await page.locator(".clip-item").count(),
    });
  }
} catch (e) {
  report.failures.push(`筛选切换失败：${String(e).slice(0, 200)}`);
}

// 分组视图：切到「分组」tab → 打开第一个分组（截图自动分组）→ 展开详情 → 截图 → 返回。
try {
  const groupsTab = page
    .locator('[role="tablist"][aria-label="剪贴板视图"] button', { hasText: "分组" })
    .first();
  const t0 = Date.now();
  await groupsTab.click({ timeout: 5000 });
  await page
    .locator(".clip-group-card")
    .first()
    .waitFor({ state: "visible", timeout: 5000 });
  report.groups_tab_ms = Date.now() - t0;
  report.group_cards = await page.locator(".clip-group-card").count();

  const t1 = Date.now();
  await page.locator(".clip-group-card").first().click({ timeout: 5000 });
  const backGroup = page.locator('button[aria-label="返回分组列表"]').first();
  await backGroup.waitFor({ state: "visible", timeout: 5000 });
  await page
    .locator(".clip-item")
    .first()
    .waitFor({ state: "visible", timeout: 5000 })
    .catch(() => {});
  report.group_detail_ms = Date.now() - t1;
  const shot = join(outDir, `${tag}-group-detail.png`);
  await page.screenshot({ path: shot });
  report.screenshots.push(shot);

  const t2 = Date.now();
  await backGroup.click({ timeout: 5000 });
  await page
    .locator(".clip-group-card")
    .first()
    .waitFor({ state: "visible", timeout: 5000 });
  report.group_back_ms = Date.now() - t2;
  // 回到历史页，保持后续步骤的初始状态。
  await page
    .locator('[role="tablist"][aria-label="剪贴板视图"] button', { hasText: "历史" })
    .first()
    .click({ timeout: 5000 });
} catch (e) {
  report.failures.push(`分组视图失败：${String(e).slice(0, 200)}`);
}

// 真实历史清理：临时把上限压到 30 条，触发 store::cleanup 删除旧条目/资产，
// 再恢复上限；清理报告与前后统计用于证明「后台清理」在真实数据上执行过。
try {
  const invoke = (cmd, args) =>
    page.evaluate(
      ([cmd, args]) => window.__TAURI_INTERNALS__.invoke(cmd, args),
      [cmd, args ?? {}]
    );
  report.stats_before_cleanup = await invoke("clipboard_stats");
  report.cleanup = await page.evaluate(async () => {
    const call = window.__TAURI_INTERNALS__.invoke;
    await call("update_settings", { patch: { clipboard_max_items: 30 } });
    const res = await call("clipboard_cleanup", {});
    await call("update_settings", { patch: { clipboard_max_items: 1000 } });
    return res;
  });
  report.stats_after_cleanup = await invoke("clipboard_stats");
} catch (e) {
  report.failures.push(`历史清理失败：${String(e).slice(0, 300)}`);
}

// 等提醒到期并被 scheduler 处理（1s 粒度）
await sleep(Math.max(0, 15000 - Math.floor((Date.now() - Date.parse(report.reminder?.remind_at ?? new Date().toISOString())) )));
try {
  const stats = await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("notification_inbox_stats", {})
  );
  report.reminder = { ...(report.reminder ?? {}), notified: stats };
} catch (e) {
  report.failures.push(`读取通知统计失败：${String(e).slice(0, 300)}`);
}

try {
  report.monitor_end = await monitorSnapshot();
} catch (e) {
  report.failures.push(`读取监听计数失败（结束）：${String(e).slice(0, 200)}`);
}

report.finished_at = new Date().toISOString();
// 主线程 Long Tasks（§4.3）：整轮累计 + 最长任务。
try {
  const lt = await page.evaluate(() => window.__longTasks ?? []);
  report.long_tasks = {
    count: lt.length,
    max_duration_ms: lt.length ? Math.max(...lt.map((x) => x.dur)) : 0,
    total_duration_ms: lt.reduce((a, x) => a + x.dur, 0),
  };
} catch (e) {
  report.long_tasks = { error: String(e).slice(0, 120) };
}
for (const key of ["open_ms", "search_ms", "preview_ms", "back_ms", "close_ms"]) {
  const vals = report[key];
  report[`${key}_summary`] = {
    n: vals.length,
    p50: vals.length ? [...vals].sort((a, b) => a - b)[Math.floor((vals.length - 1) * 0.5)] : null,
    p95: p95(vals),
    max: vals.length ? Math.max(...vals) : null,
  };
}
writeFileSync(join(outDir, "p1-05-ui-drive.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
