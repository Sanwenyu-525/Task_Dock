//! v0.6 双视觉预设视觉走查：用预览 harness（IPC mock）渲染真实 dist 产物，
//! 两套预设 × 明暗 × 材质 × 320/400px，并输出布局溢出审计。
//!
//! 用途：设计走查与回归（**浏览器合成，不等同于原生窗口验收**；
//! 原生窗口的四角/材质证据见 docs/ui-themes/07-visual-acceptance.md）。
//!
//!   npx vite preview --port 4173 --strictPort   # 另开一个终端
//!   node scripts/visual-themes.mjs

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = "docs/screenshots/v06";
mkdirSync(OUT, { recursive: true });

const BASE = "http://localhost:4173/preview.html";

/** 模拟桌面壁纸：让窗口圆角与玻璃透出可见（仅用于走查，不参与产品逻辑）。 */
const WALLPAPER_LIGHT = `linear-gradient(135deg,#dfe9ff 0%,#e9e2ff 28%,#ffe6f4 52%,#dfe9ff 78%,#e7f0ff 100%)`;
const WALLPAPER_DARK = `linear-gradient(135deg,#151a2e 0%,#221a33 30%,#2c1b2e 55%,#131a2c 80%,#101726 100%)`;

const cases = [
  { name: "dream-light-400", preset: "dream-gradient", theme: "light", material: "glass", w: 400, h: 560 },
  { name: "dream-dark-400", preset: "dream-gradient", theme: "dark", material: "glass", w: 400, h: 560 },
  { name: "glass-light-400", preset: "liquid-glass", theme: "light", material: "glass", w: 400, h: 560 },
  { name: "glass-dark-400", preset: "liquid-glass", theme: "dark", material: "glass", w: 400, h: 560 },
  { name: "dream-light-400-solid", preset: "dream-gradient", theme: "light", material: "solid", w: 400, h: 560 },
  { name: "glass-light-400-solid", preset: "liquid-glass", theme: "light", material: "solid", w: 400, h: 560 },
  { name: "dream-light-340", preset: "dream-gradient", theme: "light", material: "glass", w: 340, h: 560 },
  { name: "glass-light-320", preset: "liquid-glass", theme: "light", material: "glass", w: 320, h: 560 },
  { name: "dream-empty-400", preset: "dream-gradient", theme: "light", material: "glass", w: 400, h: 560, query: "tasks=empty" },
  { name: "glass-empty-400", preset: "liquid-glass", theme: "light", material: "glass", w: 400, h: 560, query: "tasks=empty" },
  { name: "dream-empty-dark", preset: "dream-gradient", theme: "dark", material: "glass", w: 400, h: 560, query: "tasks=empty" },
  { name: "glass-many-400", preset: "liquid-glass", theme: "light", material: "glass", w: 400, h: 560, query: "perf=60" },
  { name: "dream-minimal-280", preset: "dream-gradient", theme: "light", material: "glass", w: 280, h: 140, mode: "minimal" },
  { name: "glass-compact-400", preset: "liquid-glass", theme: "light", material: "glass", w: 400, h: 380, mode: "compact" },
];

const browser = await chromium.launch();
const results = [];

async function shoot(c, opts = {}) {
  const page = await browser.newPage({
    viewport: { width: c.w, height: c.h },
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  const url = `${BASE}?preset=${c.preset}&theme=${c.theme}&material=${c.material}&mode=${c.mode ?? "full"}${c.query ? `&${c.query}` : ""}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.addStyleTag({
    content: `html{background:${c.theme === "dark" ? WALLPAPER_DARK : WALLPAPER_LIGHT} !important;}`,
  });
  await page.waitForTimeout(500);

  if (opts.prepare) await opts.prepare(page);

  const audit = await page.evaluate(() => {
    const doc = document.documentElement;
    const offscreen = [];
    for (const el of document.querySelectorAll(
      ".overview-card,.seg-group,.quick-add-row,.search-box,.task-item,.rail,.rail-item,.settings-section,.preset-card,.clipboard-drawer",
    )) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)) {
        offscreen.push(`${el.className.split(" ")[0]}:${Math.round(r.left)}..${Math.round(r.right)}`);
      }
    }
    const rail = document.querySelector(".rail");
    return {
      overflowX: doc.scrollWidth - doc.clientWidth,
      offscreen,
      railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
      preset: doc.dataset.preset,
      theme: doc.dataset.theme,
      material: doc.dataset.material,
      native: doc.dataset.nativeGlass,
      labelsVisible: rail ? getComputedStyle(rail.querySelector(".rail-label")).display !== "none" : null,
    };
  });

  await page.screenshot({ path: `${OUT}/${c.name}.png` });
  results.push({ ...c, ...audit, errors });
  await page.close();
}

for (const c of cases) {
  await shoot(c);
}

// 设置页（含预设选择卡）
await shoot(
  { name: "settings-presets", preset: "dream-gradient", theme: "light", material: "glass", w: 400, h: 620 },
  {
    prepare: async (page) => {
      await page.click('.rail-item[aria-label="设置"]');
      await page.waitForTimeout(400);
    },
  },
);

// 任务列表（3 条示例任务在 fixture 里）
await shoot(
  { name: "glass-light-tasks", preset: "liquid-glass", theme: "light", material: "glass", w: 400, h: 620 },
  { prepare: async (page) => page.waitForTimeout(200) },
);

// 智能剪贴板：v0.6 起剪贴板是侧边栏第 4 项（页面形态），标题栏不再有入口按钮
await shoot(
  { name: "dream-clipboard-page", preset: "dream-gradient", theme: "light", material: "glass", w: 400, h: 620 },
  {
    prepare: async (page) => {
      await page.click('.rail-item[aria-label="剪贴板"]');
      await page.waitForTimeout(500);
    },
  },
);

await shoot(
  { name: "glass-clipboard-page", preset: "liquid-glass", theme: "light", material: "glass", w: 400, h: 620 },
  {
    prepare: async (page) => {
      await page.click('.rail-item[aria-label="剪贴板"]');
      await page.waitForTimeout(500);
    },
  },
);

await browser.close();

console.log(JSON.stringify(results, null, 2));
const bad = results.filter((r) => r.overflowX > 0 || r.offscreen.length || r.errors.length);
if (bad.length) {
  console.error("布局/运行错误：", JSON.stringify(bad, null, 2));
  process.exitCode = 1;
}
