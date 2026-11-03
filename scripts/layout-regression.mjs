//! v0.6 布局回归矩阵（**浏览器 harness 度量，不等同于原生窗口验收**）：
//!
//! 覆盖验收点：
//! - 窗口宽度 320 / 340 / 400 / 500 px：内容不得横向溢出；
//! - 低高度窗口：八个侧边栏入口必须**可达**（允许导航轨滚动），顺序与
//!   任务 / Agent / 行动 / 剪贴板 / 收集箱 / 历史 / 规划中心 / 设置 一致，
//!   每项 aria-label 与 data-tip 均非空；顶部「新建任务」按钮（`.rail-new-task`）
//!   必须存在、完整可见且不被导航入口覆盖；
//! - DPI 100% / 125% / 150%（deviceScaleFactor）：布局不得破；
//! - 双预设 × 明暗 × Solid/Glass × 完整/紧凑/极简：完整模式下八个入口都在；
//! - 浮层定位：底部空间不足时向上弹出，且不溢出视口。
//!
//! 用法：
//!   npm run build && node scripts/make-preview.mjs
//!   node scripts/serve-preview.mjs          # 另开一个终端
//!   node scripts/layout-regression.mjs
//!
//! 环境变量（可选，默认行为不变）：
//!   LAYOUT_OUT    产物目录，默认 docs/screenshots/v06
//!   PREVIEW_BASE  预览地址，默认 http://localhost:4173/preview.html
//!
//! 产物：<LAYOUT_OUT>/layout-audit.json（有失败项时退出码为 1）。

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { RAIL_ADD_BUTTON, RAIL_ITEM_COUNT, RAIL_LABELS } from "./rail-contract.mjs";

const OUT = process.env.LAYOUT_OUT || "docs/screenshots/v06";
mkdirSync(OUT, { recursive: true });
execFileSync(process.execPath, ["scripts/make-preview.mjs"], { stdio: "inherit" });

const BASE = process.env.PREVIEW_BASE || "http://localhost:4173/preview.html";

const browser = await chromium.launch();
const results = [];

// 截图落盘可能被其它进程（并发构建/走查）短暂锁住，errno -4094 是瞬时的，重试即可。
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

/**
 * 页面内布局度量。
 * 通过 `page.evaluate(AUDIT, expected)` 显式传入共享契约常量（Playwright 会序列化参数），
 * 函数体内不得引用 Node 侧变量。
 */
const AUDIT = (expected) => {
  const doc = document.documentElement;
  const rail = document.querySelector(".rail");
  const railBox = rail?.getBoundingClientRect() ?? null;
  const items = rail ? Array.from(rail.querySelectorAll(".rail-items .rail-item")) : [];
  const entryLabels = items.map((el) => (el.getAttribute("data-tip") ?? "").trim());
  const add = rail ? rail.querySelector(expected.addSelector) : null;
  const addBox = add?.getBoundingClientRect() ?? null;

  // 顶部「新建任务」按钮：必须存在、完整可见，且命中测试落在自己身上（没有被导航入口盖住）。
  // 按钮缺失时显式给出 addExists=false / addVisible=false / addCovered=false，
  // 由 Node 侧失败判定报出明确原因，不再像旧版那样静默变成 null。
  const addExists = Boolean(add);
  const addVisible = Boolean(
    addBox &&
      addBox.width > 0 &&
      addBox.height > 0 &&
      addBox.bottom <= (railBox?.bottom ?? 0) + 1,
  );
  let addCovered = false;
  if (addBox && addBox.width > 0 && addBox.height > 0) {
    const hit = document.elementFromPoint(
      addBox.left + addBox.width / 2,
      addBox.top + addBox.height / 2,
    );
    addCovered = !(hit === add || add?.contains(hit));
  }

  return {
    overflowX: doc.scrollWidth - doc.clientWidth,
    overflowY: doc.scrollHeight - doc.clientHeight,
    entryCount: items.length,
    entryLabels,
    // 每个入口都必须有可访问名（aria-label）与提示（data-tip）
    entryNamed: items.every((el) => {
      const aria = (el.getAttribute("aria-label") ?? "").trim();
      const tip = (el.getAttribute("data-tip") ?? "").trim();
      return aria !== "" && tip !== "";
    }),
    // data-tip 序列必须与共享契约 RAIL_LABELS 完全一致（顺序 + 标签）
    entryOrderOk: JSON.stringify(entryLabels) === JSON.stringify(expected.expectedLabels),
    // 入口是否可直达：落在导航轨可视范围内，或可以通过滚动导航轨到达
    entriesReachable: items.every((el) => {
      if (!railBox) return false;
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
    addExists,
    addVisible,
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

  const audit = await page.evaluate(AUDIT, {
    expectedCount: RAIL_ITEM_COUNT,
    expectedLabels: [...RAIL_LABELS],
    addSelector: RAIL_ADD_BUTTON.selector,
  });
  await saveShot(page, `${OUT}/layout-${c.name}.png`);
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
    // 完整模式下才存在左侧八入口导航轨；紧凑/极简模式无 rail，不做此项校验。
    if (r.entryCount !== RAIL_ITEM_COUNT) {
      failures.push({
        name: r.name,
        reason: `导航入口数 ${r.entryCount} ≠ ${RAIL_ITEM_COUNT}`,
        entryLabels: r.entryLabels,
      });
    }
    if (r.entryOrderOk !== true) {
      failures.push({
        name: r.name,
        reason: `导航入口顺序不符：${JSON.stringify(r.entryLabels)} ≠ ${JSON.stringify(RAIL_LABELS)}`,
      });
    }
    if (r.entryNamed !== true) {
      failures.push({ name: r.name, reason: "有导航入口缺少 aria-label 或 data-tip" });
    }
    if (r.entriesReachable !== true) failures.push({ name: r.name, reason: "有导航入口不可达" });
    if (r.addExists !== true) {
      failures.push({ name: r.name, reason: `未找到 ${RAIL_ADD_BUTTON.selector} 新建任务按钮` });
    }
    if (r.addVisible !== true) failures.push({ name: r.name, reason: "顶部「新建任务」按钮被裁切" });
    if (r.addCovered !== false) failures.push({ name: r.name, reason: "「新建任务」按钮被导航入口覆盖" });
  }
}

console.log(JSON.stringify({ total: results.length, failures }, null, 2));
if (failures.length) {
  console.error("布局回归失败：", JSON.stringify(failures, null, 2));
  process.exitCode = 1;
} else {
  console.log(`布局回归通过：${results.length} 个用例全部达标`);
}
