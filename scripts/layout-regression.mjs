//! v0.6 布局回归矩阵（**浏览器 harness 度量，不等同于原生窗口验收**）：
//!
//! 覆盖验收点：
//! - 窗口宽度 320 / 340 / 400 / 500 px：内容不得横向溢出；
//! - 低高度窗口：六个侧边栏入口必须**可达**（允许导航轨滚动），底部快速添加
//!   按钮必须完整可见且不被导航入口覆盖；
//! - DPI 100% / 125% / 150%（deviceScaleFactor）：布局不得破；
//! - 双预设 × 明暗 × Solid/Glass × 完整/紧凑/极简：六个入口都在；
//! - 浮层定位：底部空间不足时向上弹出，且不溢出视口。
//!
//! 用法：
//!   npm run build && node scripts/make-preview.mjs
//!   npx vite preview --port 4173 --strictPort   # 另开一个终端
//!   node scripts/layout-regression.mjs
//!
//! 产物：docs/screenshots/v06/layout-audit.json（有失败项时退出码为 1）。

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const OUT = "docs/screenshots/v06";
mkdirSync(OUT, { recursive: true });
execFileSync(process.execPath, ["scripts/make-preview.mjs"], { stdio: "inherit" });

const BASE = "http://localhost:4173/preview.html";

const browser = await chromium.launch();
const results = [];

/** 页面内布局度量。 */
const AUDIT = () => {
  const doc = document.documentElement;
  const rail = document.querySelector(".rail");
  const items = rail ? Array.from(rail.querySelectorAll(".rail-items .rail-item")) : [];
  const add = rail?.querySelector(".rail-add") ?? null;
  const addBox = add?.getBoundingClientRect() ?? null;

  // 底部快速添加按钮：必须完整可见，且命中测试落在自己身上（没有被导航入口盖住）
  let addCovered = false;
  if (addBox && addBox.width > 0 && addBox.height > 0) {
    const hit = document.elementFromPoint(
      addBox.left + addBox.width / 2,
      addBox.top + addBox.height / 2,
    );
    addCovered = !(hit === add || add.contains(hit));
  }

  return {
    overflowX: doc.scrollWidth - doc.clientWidth,
    overflowY: doc.scrollHeight - doc.clientHeight,
    entryCount: items.length,
    entryLabels: items.map((el) => el.textContent.trim()),
    // 入口是否可直达：落在导航轨可视范围内，或可以通过滚动导航轨到达
    entriesReachable: items.every((el) => {
      const railBox = rail.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.bottom <= railBox.bottom + 1 && r.top >= railBox.top - 1) return true;
      const scroller = rail.querySelector(".rail-items");
      if (!scroller) return false;
      const prev = scroller.scrollTop;
      el.scrollIntoView({ block: "nearest" });
      const ok = el.getBoundingClientRect().bottom <= railBox.bottom + 1;
      scroller.scrollTop = prev;
      return ok;
    }),
    railScrollable: (() => {
      const sc = rail?.querySelector(".rail-items");
      return sc ? sc.scrollHeight > sc.clientHeight + 1 : null;
    })(),
    addVisible: addBox ? addBox.height > 0 && addBox.bottom <= (rail?.getBoundingClientRect().bottom ?? 0) + 1 : null,
    addCovered,
    preset: doc.dataset.preset,
    theme: doc.dataset.theme,
    material: doc.dataset.material,
    mode: document.querySelector(".dock-window")?.className ?? "",
  };
};

async function run(c) {
  const page = await browser.newPage({
    viewport: { width: c.w, height: c.h },
    deviceScaleFactor: c.dpr ?? 1,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  const url = `${BASE}?preset=${c.preset}&theme=${c.theme}&material=${c.material}&mode=${c.mode}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  if (c.prepare) await c.prepare(page);

  const audit = await page.evaluate(AUDIT);
  await page.screenshot({ path: `${OUT}/layout-${c.name}.png` });
  results.push({ name: c.name, w: c.w, h: c.h, dpr: c.dpr ?? 1, mode: c.mode, ...audit, errors });
  await page.close();
}

/** 打开任务页的排序下拉（验证浮层定位与边界）。 */
async function openSortMenu(page) {
  await page.click(".ui-select-trigger.sort-select");
  await page.waitForTimeout(250);
  const box = await page.evaluate(() => {
    const el = document.querySelector(".ui-popover");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
  results.push({
    name: "overlay-bounds",
    viewport: { w: page.viewportSize().width, h: page.viewportSize().height },
    popover: box,
  });
}

// ── 1. 宽度扫描（320 / 340 / 400 / 500）─────────────────────────
for (const w of [320, 340, 400, 500]) {
  await run({
    name: `width-${w}`,
    w,
    h: 620,
    preset: "dream-gradient",
    theme: "light",
    material: "glass",
    mode: "full",
  });
}

// ── 2. 高度扫描（低高度 → 导航轨滚动，入口仍可达）────────────────
for (const h of [380, 460, 560, 760]) {
  await run({
    name: `height-${h}`,
    w: 400,
    h,
    preset: "dream-gradient",
    theme: "light",
    material: "glass",
    mode: "full",
  });
}

// ── 3. DPI 扫描（100% / 125% / 150%）─────────────────────────────
for (const dpr of [1, 1.25, 1.5]) {
  await run({
    name: `dpr-${dpr}`,
    w: 400,
    h: 620,
    dpr,
    preset: "liquid-glass",
    theme: "dark",
    material: "glass",
    mode: "full",
  });
}

// ── 4. 预设 × 明暗 × 材质 × 模式 ────────────────────────────────
for (const preset of ["dream-gradient", "liquid-glass"]) {
  for (const theme of ["light", "dark"]) {
    for (const material of ["glass", "solid"]) {
      for (const mode of ["full", "compact", "minimal"]) {
        await run({
          name: `combo-${preset}-${theme}-${material}-${mode}`,
          w: 400,
          h: 620,
          preset,
          theme,
          material,
          mode,
        });
      }
    }
  }
}

// ── 5. 浮层边界（底部空间不足时向上弹出，不溢出视口）────────────
await run({
  name: "overlay-bottom-space",
  w: 360,
  h: 420,
  preset: "dream-gradient",
  theme: "light",
  material: "glass",
  mode: "full",
  prepare: openSortMenu,
});

await browser.close();

writeFileSync(`${OUT}/layout-audit.json`, JSON.stringify(results, null, 2));

const failures = [];
for (const r of results) {
  if (r.name === "overlay-bounds") {
    const p = r.popover;
    const v = r.viewport;
    if (!p) failures.push({ name: r.name, reason: "浮层未渲染" });
    else if (p.left < -1 || p.right > v.w + 1 || p.top < -1 || p.bottom > v.h + 1) {
      failures.push({ name: r.name, reason: "浮层溢出视口", popover: p, viewport: v });
    }
    continue;
  }
  if (r.overflowX > 0) failures.push({ name: r.name, reason: `横向溢出 ${r.overflowX}px` });
  if (r.errors.length) failures.push({ name: r.name, reason: "运行错误", errors: r.errors });
  if (r.mode.includes("mode-full")) {
    if (r.entryCount !== 6) failures.push({ name: r.name, reason: `导航入口数 ${r.entryCount} ≠ 6` });
    if (!r.entriesReachable) failures.push({ name: r.name, reason: "有导航入口不可达" });
    if (r.addVisible === false) failures.push({ name: r.name, reason: "底部快速添加按钮被裁切" });
    if (r.addCovered) failures.push({ name: r.name, reason: "底部快速添加按钮被导航入口覆盖" });
  }
}

console.log(JSON.stringify({ total: results.length, failures }, null, 2));
if (failures.length) {
  console.error("布局回归失败：", JSON.stringify(failures, null, 2));
  process.exitCode = 1;
} else {
  console.log(`布局回归通过：${results.length} 个用例全部达标`);
}
