//! 全局搜索宽度 + 选择型下拉宽度验收（浏览器合成，Chromium）。
//!
//! 前置：
//!   npx vite build && node scripts/make-preview.mjs && node scripts/serve-preview.mjs
//! 运行：
//!   node scripts/search-dropdown-acceptance.mjs
//!
//! 产出：docs/acceptance/capture-search-dropdown-2026-11-19/
//! - search-<width>.png：顶栏 + 展开的搜索结果面板
//! - select-<width>.png：选择型下拉与触发按钮等宽
//! - dropdown-<width>.png：操作菜单按内容宽度（不被压缩）
//! - measurements.json：每个宽度的实测几何与断言结果
//!
//! 说明：这是 Chromium 合成证据（与 WebView2 同引擎），不等同于原生窗口取证；
//! 原生窗口（快速捕获）另有 PowerShell 取证脚本。

import { chromium } from "playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * 走查入口用 **开发服务器 + IPC mock shim**：
 * - dist/ 会被其它并发构建反复替换，harness 里的 hash 随时失效；
 * - 开发服务器直接提供当前源码，测到的就是本次改动本身。
 * shim 只提供 IPC mock（fixture 数据），不注入任何样式或逻辑。
 */
const DEV_BASE =
  process.env.PREVIEW_BASE ?? "http://localhost:1420/workspace.html?preset=dream-gradient&theme=light&material=glass";
const SHIM_PATH = ".preview/preview-shim.js";
const OUT = "docs/acceptance/capture-search-dropdown-2026-11-19";
const WIDTHS = [720, 960, 1200, 1440, 1920];
const SEARCH_FIELD_MAX = 392;
const SEARCH_PANEL_MAX = 472;

mkdirSync(OUT, { recursive: true });

async function saveShot(page, path) {
  const buf = await page.screenshot();
  for (let i = 0; ; i += 1) {
    try {
      writeFileSync(path, buf);
      return;
    } catch (error) {
      if (i >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
}

function box(el) {
  if (!el) return null;
  return el.getBoundingClientRect();
}

// 使用系统 Chrome：本机 Playwright 浏览器版本与 npm 包不同步（1243 vs 1248），
// channel 直接复用已安装的 Chrome，避免为一次验收再下载一份 Chromium。
const browser = await chromium.launch({ channel: "chrome" });
const report = [];

for (const width of WIDTHS) {
  const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    // favicon 之类的资源 404 与本次走查无关，不计入失败
    const where = m.location()?.url ?? "";
    if (m.type() === "error" && !/favicon/.test(where)) errors.push(m.text());
  });
  await page.addInitScript({ content: readFileSync(SHIM_PATH, "utf8") });
  await page.goto(DEV_BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  const entry = { width, search: null, panel: null, select: null, menu: null, errors };
  const topbar = await page.evaluate(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom };
    };
    return {
      field: rect(".wb-search-field"),
      topbar: rect(".wb-topbar"),
      context: rect(".wb-topbar-context"),
      create: rect(".wb-create-btn"),
      controls: rect(".wb-window-controls"),
    };
  });
  entry.search = topbar;

  if (!topbar.field) {
    entry.errors.push("找不到顶栏搜索字段");
  } else {
    const okWidth = topbar.field.width <= SEARCH_FIELD_MAX + 1;
    const noOverflow =
      !topbar.topbar ||
      [topbar.context, topbar.create, topbar.controls]
        .filter(Boolean)
        .every((r) => r.right <= topbar.topbar.right + 1 && r.left >= topbar.topbar.left - 1);
    entry.fieldOk = okWidth;
    entry.topbarActionsOk = noOverflow;
    if (!okWidth) entry.errors.push(`搜索字段 ${topbar.field.width}px 超过上限 ${SEARCH_FIELD_MAX}px`);
    if (!noOverflow) entry.errors.push("顶栏控件越出顶栏范围");
  }

  // 展开搜索结果面板
  const trigger = page.locator(".wb-search-trigger").first();
  if (await trigger.count()) {
    await trigger.click();
    const panel = page.locator(".gs-panel").first();
    await panel.waitFor({ state: "visible", timeout: 3000 }).catch(() => undefined);
    const rect = await panel.boundingBox();
    entry.panel = rect;
    if (!rect) {
      entry.errors.push("搜索结果面板未出现");
    } else if (rect.width > SEARCH_PANEL_MAX + 1) {
      entry.errors.push(`结果面板 ${Math.round(rect.width)}px 超过上限 ${SEARCH_PANEL_MAX}px`);
    }
    await saveShot(page, `${OUT}/search-${width}.png`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }

  // 剪贴板页：选择型下拉必须与触发按钮等宽
  const navClipboard = page.locator(".wb-nav-item", { hasText: "剪贴板" }).first();
  if (await navClipboard.count()) {
    await navClipboard.click();
    await page.waitForTimeout(1200);
    const select = page.locator(".ui-select-trigger").first();
    if (await select.count()) {
      await select.click();
      await page.waitForTimeout(400);
      // 一次性在页面内取几何：弹层每次渲染都是新节点，locator 句柄容易失效
      const measured = await page.evaluate(() => {
        const trigger = document.querySelector(".ui-select-trigger");
        const popover = document.querySelector(".ui-select-popover");
        const rect = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { width: r.width, height: r.height, left: r.left, right: r.right };
        };
        return {
          trigger: rect(trigger),
          popover: rect(popover),
          overflowX: popover ? popover.scrollWidth - popover.clientWidth : -1,
          widthMode: popover?.dataset?.popupWidth ?? null,
        };
      });
      entry.select = {
        trigger: measured.trigger,
        popover: measured.popover,
        widthMode: measured.widthMode,
      };
      if (measured.trigger && measured.popover) {
        const delta = Math.abs(measured.trigger.width - measured.popover.width);
        entry.selectDelta = Math.round(delta * 10) / 10;
        if (delta > 1) {
          entry.errors.push(
            `下拉宽度 ${Math.round(measured.popover.width)} 与按钮 ${Math.round(measured.trigger.width)} 不一致`,
          );
        }
        entry.selectOverflowX = measured.overflowX;
        if (measured.overflowX > 1) {
          entry.errors.push(`下拉出现横向滚动 ${measured.overflowX}px`);
        }
      } else {
        entry.errors.push("下拉弹层未出现");
      }
      await saveShot(page, `${OUT}/select-${width}.png`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    }
  }

  // 操作菜单：默认按内容宽度，不被锁成按钮宽
  const createBtn = page.locator(".wb-create-btn").first();
  if (await createBtn.count()) {
    const triggerBox = await createBtn.boundingBox();
    await createBtn.click();
    const menu = page.locator(".ui-menu-popover").first();
    await menu.waitFor({ state: "visible", timeout: 3000 }).catch(() => undefined);
    const menuBox = await menu.boundingBox();
    const exact = await page
      .evaluate(() => document.querySelector(".ui-menu-popover")?.dataset?.popupWidth ?? null)
      .catch(() => null);
    entry.menu = { trigger: triggerBox, menu: menuBox, widthMode: exact };
    if (exact === "exact") entry.errors.push("操作菜单被错误锁成触发按钮宽度");
    await saveShot(page, `${OUT}/dropdown-${width}.png`);
    await page.keyboard.press("Escape");
  }

  report.push(entry);
  await page.close();
}

await browser.close();
writeFileSync(`${OUT}/measurements.json`, JSON.stringify(report, null, 2));

const failures = report.filter((entry) => entry.errors.length > 0);
console.log(JSON.stringify(report.map((r) => ({
  width: r.width,
  field: r.search?.field ? Math.round(r.search.field.width) : null,
  panel: r.panel ? Math.round(r.panel.width) : null,
  selectDelta: r.selectDelta ?? null,
  menu: r.menu?.menu ? Math.round(r.menu.menu.width) : null,
  errors: r.errors,
})), null, 2));
if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} 个宽度存在断言失败`);
  process.exitCode = 1;
} else {
  console.log("PASS: 所有宽度满足宽度约束");
}
