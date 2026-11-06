//! v0.6 布局回归矩阵（**浏览器 harness 度量，不等同于原生窗口验收**）：
//!
//! 覆盖验收点：
//! - 窗口宽度 320 / 340 / 400 / 500 px：内容不得横向溢出；
//! - 低高度窗口：侧边栏入口必须**可达**（允许导航轨滚动），顺序与
//!   `rail-contract.mjs` 的 `RAIL_LABELS` 一致；导航轨分三区域采集：
//!   `.rail-items`（可排序入口）+ `.rail-foot`（「更多」与固定入口「设置」），
//!   合并后（剔除动态「更多」）必须等于完整导航清单；
//! - **高度填充**：`.dock-body` / `.full-view` / `.rail` / `.tab-content` 必须真正
//!   填满窗口剩余空间，`.rail-foot` 必须贴住导航轨底部。只断言「元素存在」会把
//!   「DOM 在、内容只占顶部一条」当成通过，这正是历史漏检的形态；
//! - **导航显隐后高度稳定**：切换一个导航入口，内容区高度不得突变，`.full-view`
//!   不得消失；
//! - DPI 100% / 125% / 150%（deviceScaleFactor）：布局不得破；
//! - 双预设 × 明暗 × Solid/Glass × 完整/紧凑/极简：完整模式下入口清单完整；
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
  const footItems = rail ? Array.from(rail.querySelectorAll(".rail-foot .rail-item")) : [];
  // 入口文案取自 `.rail-label`（纯 label）。`data-tip` / `aria-label` 在
  // 有未处理收集时会带计数后缀（如「收集与暂存（3 条待处理收集）」），
  // 直接比对会让顺序断言永久失败——历史脚本就卡在这里。
  const labelOf = (el) => (el.querySelector(".rail-label")?.textContent ?? "").trim();
  const itemLabels = items.map(labelOf);
  // `.rail-foot` 里「更多」是按隐藏项数量动态出现的功能入口，不属于导航契约清单。
  const footLabels = footItems.map(labelOf).filter((label) => label !== expected.moreLabel);
  const entryLabels = [...itemLabels, ...footLabels];
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

  /** 单个元素的布局盒（整数像素，避免子像素抖动影响判据）。 */
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      h: Math.round(r.height),
      clientH: el.clientHeight,
      scrollH: el.scrollHeight,
    };
  };
  // 标题栏是 `.dock-app` 的直接子元素（`.dock-window` 的子元素是 .dock-app / 浮层）。
  const titlebar = box(".dock-app > .titlebar");
  const dockBody = box(".dock-body");
  const fullView = box(".full-view");
  const railHeight = railBox ? Math.round(railBox.height) : null;
  const railFoot = box(".rail-foot");
  const tabContent = box(".tab-content");

  return {
    overflowX: doc.scrollWidth - doc.clientWidth,
    overflowY: doc.scrollHeight - doc.clientHeight,
    entryCount: entryLabels.length,
    entryLabels,
    itemCount: items.length,
    footLabels,
    // 每个入口都必须有可访问名（aria-label）与提示（data-tip）
    entryNamed: items.every((el) => {
      const aria = (el.getAttribute("aria-label") ?? "").trim();
      const tip = (el.getAttribute("data-tip") ?? "").trim();
      return aria !== "" && tip !== "";
    }),
    // 合并后的入口清单必须与共享契约完全一致（顺序 + 标签）
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
    // 高度填充实测（像素）：只用于判定，不作为产物。
    heights: {
      innerH: window.innerHeight,
      titlebarH: titlebar?.h ?? null,
      dockBodyH: dockBody?.h ?? null,
      fullViewH: fullView?.h ?? null,
      railH: railHeight,
      tabContentH: tabContent?.h ?? null,
      railBottom: railBox ? Math.round(railBox.bottom) : null,
      railFootBottom: railFoot?.bottom ?? null,
      railFootH: railFoot?.h ?? null,
      railItemsScrollH: (() => {
        const sc = rail?.querySelector(".rail-items");
        return sc ? sc.scrollHeight : null;
      })(),
      railItemsClientH: (() => {
        const sc = rail?.querySelector(".rail-items");
        return sc ? sc.clientHeight : null;
      })(),
    },
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
    moreLabel: "更多",
  });
  await saveShot(page, `${OUT}/layout-${c.name}.png`);
  results.push({ name: c.name, w: c.w, h: c.h, dpr: c.dpr ?? 1, mode: c.mode, ...audit, errors });
  await page.close();
}

/** 打开任务页的排序下拉（验证浮层定位与边界）。 */
async function openSortMenu(page) {
  // 首次使用引导卡片会在首屏盖住内容区，真实用户也是先关掉它再操作；
  // 不跳过会让点击落到卡片上，用例变成「浮层未渲染」的假失败。
  const skip = page.locator("button", { hasText: "跳过引导" }).first();
  if ((await skip.count()) > 0) {
    await skip.click().catch(() => {});
    await page.waitForTimeout(300);
  }
  await page.click(".ui-select-trigger.sort-select");
  await page.waitForTimeout(250);
  const box = await page.evaluate(() => {
    // 浮层由 floating-ui 定位在 `.ui-popover-host` 上，`.ui-popover` 只是面板本体；
    // 宿主宽度 max-content，取它的矩形才代表用户实际看到的浮层边界。
    const el =
      document.querySelector(".ui-popover-host") ?? document.querySelector(".ui-popover");
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

// ── 6. 导航显隐后的高度稳定性（真实布局，不看「DOM 是否存在」）─────
// 截图形态「内容只占顶部一条 + 下方全空」的成因就是某次重排后内容区不再填满。
// 这里在真实 Chromium 里点一次导航开关，比较切换前后的实测高度。
async function auditCurrent(page) {
  return page.evaluate(AUDIT, {
    expectedCount: RAIL_ITEM_COUNT,
    expectedLabels: [...RAIL_LABELS],
    addSelector: RAIL_ADD_BUTTON.selector,
    moreLabel: "更多",
  });
}

const navPage = await browser.newPage({ viewport: { width: 400, height: 620 } });
const navErrors = [];
navPage.on("pageerror", (e) => navErrors.push(String(e)));
navPage.on("console", (m) => {
  if (m.type() === "error") navErrors.push(m.text());
});
await navPage.goto(
  `${BASE}?preset=dream-gradient&theme=light&material=glass&mode=full`,
  { waitUntil: "networkidle" },
);
await navPage.waitForSelector(".rail", { timeout: 10000 });
await navPage.waitForTimeout(300);
const navBefore = await auditCurrent(navPage);

await navPage.evaluate(() => {
  const btn = Array.from(document.querySelectorAll(".rail-foot .rail-item")).find(
    (b) => (b.getAttribute("data-tip") ?? "").trim() === "设置",
  );
  btn?.click();
});
await navPage.waitForSelector(".settings-panel", { timeout: 8000 });
await navPage.waitForTimeout(300);
await navPage.evaluate(() => {
  if (document.querySelectorAll(".nav-visibility-row").length === 0) {
    document
      .querySelector('[data-collapsible-section="settings-navigation"] .collapsible-toggle')
      ?.click();
  }
});
await navPage.waitForTimeout(300);
const rowCount = await navPage.locator(".nav-visibility-row").count();
await navPage.locator(".nav-visibility-row input[role=switch]").first().click({ force: true });
await navPage.waitForTimeout(700);
const navAfter = await auditCurrent(navPage);
await saveShot(navPage, `${OUT}/layout-nav-toggle-after.png`);

// 点进懒加载页（帮助中心）：Suspense 占位 → 真实面板的换挡过程中，
// 内容区不得因占位高度过小而塌陷（用户报告的形态正是「内容只占顶部一条」）。
await navPage.evaluate(() => {
  const btn = Array.from(document.querySelectorAll(".rail-items .rail-item")).find(
    (b) => (b.querySelector(".rail-label")?.textContent ?? "").trim() === "帮助",
  );
  btn?.click();
});
await navPage.waitForTimeout(1500);
const navLazy = await auditCurrent(navPage);
await saveShot(navPage, `${OUT}/layout-nav-lazy-page.png`);
await navPage.close();
results.push({
  name: "nav-toggle-stability",
  rowCount,
  before: navBefore.heights,
  after: navAfter.heights,
  afterLazy: navLazy.heights,
  beforeEntries: navBefore.entryCount,
  afterEntries: navAfter.entryCount,
  beforeFoot: navBefore.footLabels,
  afterFoot: navAfter.footLabels,
  errors: navErrors,
});

await browser.close();

writeFileSync(`${OUT}/layout-audit.json`, JSON.stringify(results, null, 2));

/**
 * 高度填充判据。
 *
 * 只断言「元素存在」会把「DOM 在、视觉只占顶部一条、下方全是窗口底色」判成通过；
 * 这里直接比较实测像素，把填充关系写成不变量：
 * 1. 内容区 = 视口高度 - 标题栏高度；
 * 2. `.full-view` / `.rail` / `.tab-content` 与内容区等高（横向三段同高）；
 * 3. `.rail-foot` 贴住导航轨底部（允许 10px 内边距）；
 * 4. 导航轨滚动容器的可滚动高度覆盖全部入口（末项可达由上一条 entriesReachable 兜底）。
 */
function fillFailures(r) {
  const out = [];
  const h = r.heights;
  if (!h) return [{ name: r.name, reason: "未采集到高度数据" }];
  const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
  if (h.dockBodyH == null || h.dockBodyH <= 0) {
    out.push({ name: r.name, reason: "内容区高度为 0（布局未撑开）", heights: h });
    return out;
  }
  const expectBody = h.innerH - (h.titlebarH ?? 0);
  if (!near(h.dockBodyH, expectBody)) {
    out.push({
      name: r.name,
      reason: `内容区未填满窗口：.dock-body=${h.dockBodyH} 期望=${expectBody}`,
      heights: h,
    });
  }
  if (h.fullViewH != null && !near(h.fullViewH, h.dockBodyH)) {
    out.push({
      name: r.name,
      reason: `.full-view=${h.fullViewH} 未填满内容区=${h.dockBodyH}`,
      heights: h,
    });
  }
  if (h.railH != null && !near(h.railH, h.dockBodyH)) {
    out.push({ name: r.name, reason: `.rail=${h.railH} 与内容区=${h.dockBodyH} 不等高`, heights: h });
  }
  if (h.tabContentH != null && !near(h.tabContentH, h.dockBodyH)) {
    out.push({
      name: r.name,
      reason: `.tab-content=${h.tabContentH} 与内容区=${h.dockBodyH} 不等高`,
      heights: h,
    });
  }
  if (h.railFootBottom != null && h.railBottom != null) {
    const gap = h.railBottom - h.railFootBottom;
    if (gap < 0 || gap > 16) {
      out.push({
        name: r.name,
        reason: `「设置」固定区未贴底：.rail-foot.bottom=${h.railFootBottom} / .rail.bottom=${h.railBottom}（间距 ${gap}）`,
        heights: h,
      });
    }
  }
  return out;
}

const failures = [];
for (const r of results) {
  if (r.name === "nav-toggle-stability") {
    // 导航显隐只应改变「某入口是否渲染」，不得改变内容区填充与固定区贴底。
    if (r.errors.length) failures.push({ name: r.name, reason: "运行错误", errors: r.errors });
    if (r.rowCount === 0) failures.push({ name: r.name, reason: "导航自定义列表未渲染" });
    if (r.afterEntries !== r.beforeEntries - 1) {
      failures.push({
        name: r.name,
        reason: `切换一个入口后入口数应减 1：${r.beforeEntries} → ${r.afterEntries}`,
      });
    }
    if (r.after?.fullViewH == null || r.after.fullViewH <= 0) {
      failures.push({ name: r.name, reason: "切换后 .full-view 消失（完整面板不可用）", after: r.after });
    }
    for (const key of ["dockBodyH", "fullViewH", "railH", "tabContentH"]) {
      const b = r.before?.[key];
      const a = r.after?.[key];
      if (b == null || a == null || Math.abs(a - b) > 1) {
        failures.push({
          name: r.name,
          reason: `${key} 在导航切换后变化 ${b} → ${a}（内容区不得随之缩放）`,
        });
      }
    }
    const gap = (r.after?.railBottom ?? 0) - (r.after?.railFootBottom ?? 0);
    if (gap < 0 || gap > 16) {
      failures.push({ name: r.name, reason: `切换后「设置」固定区未贴底（间距 ${gap}）`, after: r.after });
    }
    if (!r.afterFoot?.includes("设置")) {
      failures.push({ name: r.name, reason: `切换后固定区缺少「设置」：${JSON.stringify(r.afterFoot)}` });
    }
    // 懒加载页换挡后同样必须填满：Suspense 占位高度小，最容易被误当成「正常」。
    const lazy = r.afterLazy;
    if (!lazy || lazy.fullViewH == null || lazy.fullViewH <= 0) {
      failures.push({ name: r.name, reason: "懒加载页进入后 .full-view 消失", afterLazy: lazy });
    } else if (lazy.dockBodyH != null && Math.abs(lazy.fullViewH - lazy.dockBodyH) > 2) {
      failures.push({
        name: r.name,
        reason: `懒加载页 .full-view=${lazy.fullViewH} 未填满内容区=${lazy.dockBodyH}`,
        afterLazy: lazy,
      });
    }
    if (r.after?.dockBodyH != null && lazy?.dockBodyH != null && Math.abs(lazy.dockBodyH - r.after.dockBodyH) > 1) {
      failures.push({
        name: r.name,
        reason: `进入懒加载页后内容区高度变化 ${r.after.dockBodyH} → ${lazy.dockBodyH}`,
      });
    }
    continue;
  }
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
    // 完整模式下才存在左侧导航轨；紧凑/极简模式无 rail，不做此项校验。
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
    failures.push(...fillFailures(r));
  }
}

console.log(JSON.stringify({ total: results.length, failures }, null, 2));
if (failures.length) {
  console.error("布局回归失败：", JSON.stringify(failures, null, 2));
  process.exitCode = 1;
} else {
  console.log(`布局回归通过：${results.length} 个用例全部达标`);
}
