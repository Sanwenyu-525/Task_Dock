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

const args = process.argv.slice(2);
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const port = Number(opt("port", "9224"));
const outDir = opt("out", "docs/clipboard/evidence/p1-05-ui");
const cycles = Number(opt("cycles", "8"));
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  let seen = [];
  for (let i = 0; i < 60; i += 1) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 });
      seen = browser
        .contexts()
        .flatMap((ctx) => ctx.pages())
        .map((p) => p.url())
        .filter((u) => !u.startsWith("devtools://"));
      // context-menu.html 是右键菜单辅助窗口，启动时也占用一个页面；
      // 主窗口是根页面（http://tauri.localhost/），必须按 URL 选定而不是取第一个。
      const main = browser
        .contexts()
        .flatMap((ctx) => ctx.pages())
        .find((p) => !p.url().startsWith("devtools://") && !/context-menu\.html/.test(p.url()));
      if (main) return { browser, page: main };
      await browser.close();
    } catch {
      // WebView2 还没起好调试端口，继续等
    }
    await sleep(1000);
  }
  throw new Error(`CDP 连接失败：127.0.0.1:${port}（已见页面：${seen.join(", ")}）`);
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

const { browser, page } = await connect();
report.page_url = page.url();
page.on("console", (m) => {
  if (m.type() === "error") report.console_errors.push(m.text().slice(0, 300));
});
page.on("pageerror", (e) => report.console_errors.push(String(e).slice(0, 300)));

const openBtn = page.locator('button[aria-label="打开智能剪贴板"]').first();
const navClipboard = page.locator('nav[aria-label="主导航"] button[aria-label^="剪贴板"]').first();
const navTasks = page.locator('nav[aria-label="主导航"] button[aria-label^="任务"]').first();
const searchInput = page.locator('input[aria-label="搜索剪贴板历史"]').first();
const closeBtn = page.locator('button[aria-label="关闭剪贴板"]').first();
const backBtn = page.locator('button[aria-label="返回列表"]').first();

async function openClipboard() {
  if (await openBtn.isVisible().catch(() => false)) {
    await openBtn.click();
    report.ui_mode = "drawer";
  } else {
    await navClipboard.click();
    report.ui_mode = "full";
  }
  await searchInput.waitFor({ state: "visible", timeout: 5000 });
}

async function closeClipboard() {
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click();
  } else {
    await navTasks.click();
  }
  await searchInput.waitFor({ state: "hidden", timeout: 5000 });
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
  await openBtn
    .waitFor({ state: "visible", timeout: 5000 })
    .catch(() => navClipboard.waitFor({ state: "visible", timeout: 25000 }));
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
    await searchInput.fill("taskdock-p1-05");
    await page
      .locator(".clip-item")
      .first()
      .waitFor({ state: "visible", timeout: 5000 })
      .catch(() => {});
    report.search_ms.push(Date.now() - t0);
    report.search_counts.push(await page.locator(".clip-item").count());

    await searchInput.fill("");
    await sleep(250);

    const imageCard = page.locator('.clip-item[aria-label^="图片："]').first();
    t0 = Date.now();
    await imageCard.click({ timeout: 5000 });
    await backBtn.waitFor({ state: "visible", timeout: 5000 });
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
      return img ? { w: img.naturalWidth, h: img.naturalHeight, complete: img.complete } : null;
    });
    report.preview_pixels.push(pixels);
    if (i === 1) {
      const shot = join(outDir, "p1-05-ui-image-preview.png");
      const shotStart = Date.now();
      await page.screenshot({ path: shot });
      report.screenshot_ms = Date.now() - shotStart;
      report.screenshots.push(shot);
    }

    t0 = Date.now();
    await backBtn.click();
    await page.locator(".clip-item").first().waitFor({ state: "visible", timeout: 5000 });
    report.back_ms.push(Date.now() - t0);

    t0 = Date.now();
    await closeClipboard();
    report.close_ms.push(Date.now() - t0);
  } catch (e) {
    report.failures.push(`第 ${i + 1} 轮失败：${String(e).slice(0, 300)}`);
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(500);
  }
  await sleep(400);
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
