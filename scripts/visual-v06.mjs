//! v0.6 视觉验收截图（**浏览器 harness 合成图，不等同于原生窗口验收**）：
//! 两套视觉预设 × 明暗，覆盖任务页排序菜单、设置页配色下拉、日期时间浮层、
//! 剪贴板主页面、剪贴板关联抽屉、深色主题菜单与 320px 窄布局，
//! 并输出横向溢出审计（内容不得溢出窗口、六个侧边栏入口不得被裁掉）。
//!
//!   npm run build && node scripts/make-preview.mjs
//!   node scripts/serve-preview.mjs          # 另开一个终端
//!   node scripts/visual-v06.mjs

import { chromium } from "playwright";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * 截图落盘。并发构建/索引器会偶发占住目标文件（Windows 返回 errno -4094），
 * 因此先取缓冲区再带重试写盘。
 */
async function saveShot(page, path) {
  const buf = await page.screenshot();
  for (let i = 0; ; i++) {
    try {
      writeFileSync(path, buf);
      return;
    } catch (e) {
      if (i >= 4) throw e;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

const OUT = "docs/screenshots/v06";
mkdirSync(OUT, { recursive: true });

// vite build 会清空 dist，preview harness 必须在每次截图前重建，
// 否则 /preview.html 会被 SPA 回退成 index.html，页面拿不到 Tauri mock。
if (!existsSync("dist/index.html")) {
  console.log("dist/index.html 不存在，先执行 npm run build …");
  execFileSync("npm", ["run", "build"], { stdio: "inherit" });
}
execFileSync(process.execPath, ["scripts/make-preview.mjs"], { stdio: "inherit" });

const BASE = "http://localhost:4173/preview.html";

/** 模拟桌面壁纸：让窗口圆角与玻璃透出可见（仅用于走查，不参与产品逻辑）。 */
const WALLPAPER_LIGHT = `linear-gradient(135deg,#dfe9ff 0%,#e9e2ff 28%,#ffe6f4 52%,#dfe9ff 78%,#e7f0ff 100%)`;
const WALLPAPER_DARK = `linear-gradient(135deg,#151a2e 0%,#221a33 30%,#2c1b2e 55%,#131a2c 80%,#101726 100%)`;

const PRESETS = [
  { id: "dream-gradient", tag: "dream" },
  { id: "liquid-glass", tag: "glass" },
];

const browser = await chromium.launch();
const results = [];

/**
 * 打开一页并截图。
 * @param {object} c 用例定义
 * @param {(page: import("playwright").Page) => Promise<void>} [c.prepare] 截图前的交互
 */
async function shoot(c) {
  const page = await browser.newPage({
    viewport: { width: c.w, height: c.h },
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  const url = `${BASE}?preset=${c.preset}&theme=${c.theme}&material=${c.material ?? "glass"}&mode=${c.mode ?? "full"}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.addStyleTag({
    content: `html{background:${c.theme === "dark" ? WALLPAPER_DARK : WALLPAPER_LIGHT} !important;}`,
  });
  await page.waitForTimeout(400);

  if (c.prepare) await c.prepare(page);

  const audit = await page.evaluate(() => {
    const doc = document.documentElement;
    const offscreen = [];
    for (const el of document.querySelectorAll(
      ".overview-card,.seg-group,.quick-add-row,.search-box,.task-item,.rail,.rail-item,.settings-section,.preset-card,.clipboard-page,.ui-popover,.ui-dialog",
    )) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)) {
        offscreen.push(`${el.className.split(" ")[0]}:${Math.round(r.left)}..${Math.round(r.right)}`);
      }
    }
    const rail = document.querySelector(".rail");
    const items = rail ? Array.from(rail.querySelectorAll(".rail-item")) : [];
    const railBox = rail ? rail.getBoundingClientRect() : null;
    const clipped = items
      .filter((el) => {
        const r = el.getBoundingClientRect();
        // 入口必须完全落在导航轨的可视范围内（窄高度时靠滚动到达，不允许被裁掉）
        return railBox && (r.bottom > railBox.bottom + 1 || r.top < railBox.top - 1);
      })
      .map((el) => el.textContent.trim());
    const add = rail?.querySelector(".rail-add");
    const addBox = add?.getBoundingClientRect();
    return {
      overflowX: doc.scrollWidth - doc.clientWidth,
      overflowY: doc.scrollHeight - doc.clientHeight,
      offscreen,
      clippedEntries: clipped,
      railScrollable: rail ? rail.querySelector(".rail-items").scrollHeight > rail.querySelector(".rail-items").clientHeight + 1 : null,
      addVisible: addBox ? addBox.bottom <= (railBox?.bottom ?? 0) + 1 && addBox.height > 0 : null,
      preset: doc.dataset.preset,
      theme: doc.dataset.theme,
      material: doc.dataset.material,
      labelsVisible: rail ? getComputedStyle(rail.querySelector(".rail-label")).display !== "none" : null,
      // 白屏守卫：IPC mock 缺失时页面只剩空 #root，截图会变成废图而断言仍然全绿
      blank: (document.querySelector("#root")?.childElementCount ?? 0) === 0,
    };
  });

  await saveShot(page, `${OUT}/${c.name}.png`);
  results.push({ name: c.name, ...audit, errors });
  await page.close();
}

/** 展开任务页的排序下拉（Select 基元）。 */
async function openSortMenu(page) {
  await page.click(".ui-select-trigger.sort-select");
  await page.waitForTimeout(250);
}

/** 展开设置页的配色下拉。 */
async function openThemeSelect(page) {
  await page.click('.rail-item[aria-label="设置"]');
  await page.waitForTimeout(300);
  await page.click('button[aria-label="配色"]');
  await page.waitForTimeout(250);
}

/** 打开任务编辑器并展开「截止时间」日期时间浮层。 */
async function openDateTimeOverlay(page) {
  await page.locator(".task-edit").first().click();
  await page.waitForTimeout(400);
  await page.click('button[aria-label="截止时间"]');
  await page.waitForTimeout(300);
}

/** 打开任务编辑器里的剪贴板关联抽屉。 */
async function openClipboardLinkDrawer(page) {
  await page.locator(".task-edit").first().click();
  await page.waitForTimeout(400);
  await page.click('button:has-text("从剪贴板选择")');
  await page.waitForTimeout(600);
}

/** 剪贴板主页面（左侧导航第 4 个入口）。 */
async function openClipboardPage(page) {
  await page.click('.rail-item[aria-label="剪贴板"]');
  await page.waitForTimeout(500);
}

/** 标题栏明暗菜单展开。 */
async function openTitleMenu(page) {
  await page.click(".theme-menu .menu-trigger");
  await page.waitForTimeout(250);
}

for (const p of PRESETS) {
  for (const theme of ["light", "dark"]) {
    const t = theme === "dark" ? "dark" : "light";
    await shoot({
      name: `${p.tag}-${t}-tasks-sort-menu`,
      preset: p.id,
      theme: t,
      w: 400,
      h: 620,
      prepare: openSortMenu,
    });

    await shoot({
      name: `${p.tag}-${t}-settings-theme-select`,
      preset: p.id,
      theme: t,
      w: 400,
      h: 620,
      prepare: openThemeSelect,
    });

    await shoot({
      name: `${p.tag}-${t}-datetime-overlay`,
      preset: p.id,
      theme: t,
      w: 400,
      h: 620,
      prepare: openDateTimeOverlay,
    });

    await shoot({
      name: `${p.tag}-${t}-clipboard-page`,
      preset: p.id,
      theme: t,
      w: 400,
      h: 620,
      prepare: openClipboardPage,
    });

    await shoot({
      name: `${p.tag}-${t}-clipboard-link-drawer`,
      preset: p.id,
      theme: t,
      w: 400,
      h: 620,
      prepare: openClipboardLinkDrawer,
    });

    await shoot({
      name: `${p.tag}-${t}-titlebar-menu`,
      preset: p.id,
      theme: t,
      w: 400,
      h: 620,
      prepare: openTitleMenu,
    });
  }

  // 320px 窄布局：六个入口 + 底部快捷添加必须都可达
  await shoot({
    name: `${p.tag}-light-320-narrow`,
    preset: p.id,
    theme: "light",
    w: 320,
    h: 560,
  });
}

await browser.close();

writeFileSync(`${OUT}/audit.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
const bad = results.filter(
  (r) => r.blank || r.overflowX > 0 || r.offscreen.length || r.errors.length || r.clippedEntries.length || r.addVisible === false,
);
if (bad.length) {
  console.error("布局/运行错误：", JSON.stringify(bad, null, 2));
  process.exitCode = 1;
}
