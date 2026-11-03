//! v0.7 P1/P2 浏览器验收（**浏览器 harness 合成图，不等同于原生窗口验收**）。
//!
//! 覆盖：
//! - 两套预设 × 明暗的任务页 / 剪贴板页融合效果；
//! - 320 / 340 / 400 / 500 宽度与 380 / 460 / 560 / 620 / 760 高度；
//! - 排序 Select、设置页配色 Select、日期时间浮层、剪贴板关联抽屉、标题栏菜单；
//! - Escape 只关最上层弹层；菜单/浮层不越出窗口；顶部「新建任务」按钮 hover / focus-visible；
//! - 横向溢出、侧栏八入口（任务 / Agent / 行动 / 剪贴板 / 收集箱 / 历史 / 规划中心 / 设置）
//!   的数量、顺序、命名与滚动可达性、新建任务按钮可见/可聚焦/可点击、剪贴板页是否仍嵌套独立背景。
//!
//! 侧栏入口事实源：src/store/useUiStore.ts 的 `TAB_ORDER`；Playwright 脚本无法导入 TS，
//! 故经 scripts/rail-contract.mjs 共享契约（含 RAIL_ADD_BUTTON）取同一份八入口清单。
//!
//!   npm run build && node scripts/make-preview.mjs
//!   node scripts/serve-preview.mjs          # 另开一个终端
//!   node scripts/visual-v07.mjs
//!
//! 环境变量（可选，默认行为不变）：
//!   VISUAL_OUT   产物目录，默认 docs/screenshots/v07
//!   VISUAL_BASE  预览地址，默认 http://localhost:4173/preview.html

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { RAIL_ADD_BUTTON, RAIL_ENTRIES, RAIL_ITEM_COUNT, RAIL_LABELS } from "./rail-contract.mjs";

const OUT = process.env.VISUAL_OUT || "docs/screenshots/v07";
const BASE = process.env.VISUAL_BASE || "http://localhost:4173/preview.html";
mkdirSync(OUT, { recursive: true });

console.log(`预览地址 ${BASE} → 产物 ${OUT}`);
console.log(`八入口契约：${RAIL_LABELS.join(" / ")}（新建任务按钮 ${RAIL_ADD_BUTTON.selector}）`);

const WALL = {
  light: "linear-gradient(135deg,#dfe9ff 0%,#e9e2ff 28%,#ffe6f4 52%,#dfe9ff 78%,#e7f0ff 100%)",
  dark: "linear-gradient(135deg,#151a2e 0%,#221a33 30%,#2c1b2e 55%,#131a2c 80%,#101726 100%)",
};

const TAG = { "dream-gradient": "dream", "liquid-glass": "glass" };
const PRESETS = [
  { preset: "dream-gradient", tag: "dream" },
  { preset: "liquid-glass", tag: "glass" },
];

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

async function openClipboard(page) {
  await page.click('.rail-item[aria-label^="剪贴板"]');
  await page.waitForTimeout(500);
  await page.mouse.move(page.viewportSize().width / 2, 220);
}

async function backToTasks(page) {
  await page.click('.rail-item[aria-label^="任务"]');
  await page.waitForTimeout(300);
}

async function openSortMenu(page) {
  await page.click(".ui-select-trigger.sort-select");
  await page.waitForTimeout(250);
}

async function openThemeSelect(page) {
  await page.click('.rail-item[aria-label="设置"]');
  await page.waitForTimeout(300);
  await page.click('button[aria-label="配色"]');
  await page.waitForTimeout(250);
  await page.mouse.move(page.viewportSize().width / 2, 220);
}

async function openDateTimeOverlay(page) {
  await page.locator(".task-edit").first().click();
  await page.waitForTimeout(400);
  await page.click('button[aria-label="截止时间"]');
  await page.waitForTimeout(300);
  await page.mouse.move(page.viewportSize().width / 2, 100);
}

async function openClipboardLinkDrawer(page) {
  await page.locator(".task-edit").first().click();
  await page.waitForTimeout(400);
  await page.click('button:has-text("从剪贴板选择")');
  await page.waitForTimeout(600);
  await page.mouse.move(page.viewportSize().width / 2, 100);
}

async function openTitleMenu(page) {
  await page.click(".theme-menu .menu-trigger");
  await page.waitForTimeout(250);
  await page.mouse.move(page.viewportSize().width / 2, page.viewportSize().height - 40);
}

/**
 * 审计：页面级溢出、白屏、控制台错误、八入口数量/顺序/命名/可达性、新建任务按钮、
 * 剪贴板融合、弹层边界。
 *
 * `page.evaluate` 的函数体运行在浏览器上下文，**不得**引用 Node 侧变量
 * （旧版直接引用 RAIL_ITEM_COUNT → ReferenceError）；共享契约经第二个参数显式传入。
 */
async function auditPage(page) {
  const expected = {
    expectedCount: RAIL_ITEM_COUNT,
    expectedLabels: [...RAIL_LABELS],
    addButton: { ...RAIL_ADD_BUTTON },
  };
  return page.evaluate((params) => {
    const { expectedCount, expectedLabels, addButton } = params;
    const doc = document.documentElement;
    const rect = (el) => el.getBoundingClientRect();
    const describe = (el) =>
      el
        ? `${el.tagName.toLowerCase()}${
            typeof el.className === "string" && el.className.trim()
              ? `.${el.className.trim().split(/\s+/)[0]}`
              : ""
          }`
        : null;
    const offscreen = [];
    for (const el of document.querySelectorAll(
      ".overview-card,.seg-group,.quick-add-row,.search-box,.task-item,.rail,.rail-item,.settings-section,.preset-card,.clipboard-page,.ui-popover-host,.ui-select-popover,.ui-dtp-popover,.titlebar-menu-popover,.clipboard-layer,.ui-menu",
    )) {
      const r = rect(el);
      if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)) {
        offscreen.push(`${el.className.split(" ")[0]}:${Math.round(r.left)}..${Math.round(r.right)}`);
      }
    }

    const rail = document.querySelector(".rail");
    const railBox = rail ? rect(rail) : null;
    const list = rail?.querySelector(".rail-items");
    const items = list ? Array.from(list.querySelectorAll(".rail-item")) : [];
    const listBox = list ? rect(list) : null;
    const entryLabels = items.map((el) => (el.getAttribute("data-tip") ?? "").trim());
    let reachable = null;
    let scrollable = null;
    if (list && listBox) {
      scrollable = list.scrollHeight > list.clientHeight + 1;
      const prev = list.scrollTop;
      list.scrollTop = list.scrollHeight;
      const last = items[items.length - 1] ? rect(items[items.length - 1]) : null;
      reachable = last ? last.bottom <= listBox.bottom + 1 && last.top >= listBox.top - 1 : null;
      list.scrollTop = prev;
    }

    // 八入口：数量 == 契约；data-tip 序列 == 契约顺序；每项 aria-label / data-tip 均非空。
    const countOk = items.length === expectedCount;
    const orderOk =
      entryLabels.length === expectedLabels.length &&
      entryLabels.every((label, i) => label === expectedLabels[i]);
    const railNamed = items.every((el) => {
      const label = (el.getAttribute("aria-label") ?? "").trim();
      const tip = (el.getAttribute("data-tip") ?? "").trim();
      return label !== "" && tip !== "";
    });

    // 新建任务按钮（.rail-new-task）：存在、完整位于 rail 内、可聚焦、指针命中自身。
    // 任务编辑器 / 剪贴板关联抽屉打开时整窗处于预期遮罩下，此时按钮被遮住属设计预期；
    // 记录 expectedOverlay，由 Node 侧区分「预期遮罩」与真正的意外遮挡。
    const EXPECTED_OVERLAY = ".modal-mask, .modal-backdrop, .clipboard-layer.link-mode";
    const add = rail ? rail.querySelector(addButton.selector) : null;
    let addInfo;
    if (!add) {
      addInfo = {
        exists: false,
        selector: addButton.selector,
        visible: false,
        focusable: false,
        clickable: false,
        covered: false,
        expectedOverlay: false,
        blockedBy: null,
        hit: null,
      };
    } else {
      const addBox = rect(add);
      const addStyle = getComputedStyle(add);
      const fullyInsideRail = Boolean(
        railBox &&
          addBox.width > 0 &&
          addBox.height > 0 &&
          addBox.top >= railBox.top - 1 &&
          addBox.left >= railBox.left - 1 &&
          addBox.bottom <= railBox.bottom + 1 &&
          addBox.right <= railBox.right + 1,
      );
      // 预期整窗遮罩存在时按钮本就不可交互：弹层可能经 portal 渲染在 .modal-mask 之外
      // （如任务编辑器里的日期时间弹层），因此按「页面是否存在预期整窗遮罩」判定，
      // 而不是要求命中元素自身在遮罩祖先链内。实际命中的元素仍写入 hit/blockedBy。
      const overlayOpen = Boolean(document.querySelector(EXPECTED_OVERLAY));
      let hit = null;
      let hitOnSelf = false;
      let expectedOverlay = false;
      if (addBox.width > 0 && addBox.height > 0) {
        hit = document.elementFromPoint(
          addBox.left + addBox.width / 2,
          addBox.top + addBox.height / 2,
        );
        hitOnSelf = Boolean(hit) && (hit === add || add.contains(hit));
        expectedOverlay = Boolean(hit && !hitOnSelf && overlayOpen);
      }
      addInfo = {
        exists: true,
        selector: addButton.selector,
        visible: fullyInsideRail,
        // 可聚焦：tabIndex >= 0 且非 disabled
        focusable: typeof add.tabIndex === "number" && add.tabIndex >= 0 && !add.disabled,
        // 可点击：elementFromPoint 命中自身或子元素；被遮挡时 clickable=false / covered=true
        clickable: hitOnSelf,
        covered: !hitOnSelf,
        expectedOverlay,
        blockedBy: hitOnSelf ? null : expectedOverlay ? `expected-overlay(${describe(hit)})` : describe(hit),
        hit: describe(hit),
        w: Math.round(addBox.width),
        h: Math.round(addBox.height),
        cursor: addStyle?.cursor,
        face: addStyle?.backgroundImage !== "none" ? "gradient" : addStyle?.backgroundColor,
        opacity: addStyle?.opacity,
        color: addStyle?.color,
        tabIndex: add.tabIndex,
        disabled: Boolean(add.disabled),
        ariaLabel: add.getAttribute("aria-label"),
        tip: add.getAttribute("data-tip"),
      };
    }

    const railLabels = rail
      ? Array.from(rail.querySelectorAll(".rail-label")).every(
          (el) => getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0,
        )
      : null;

    const pageEl = document.querySelector(".clipboard-page");
    let clip = null;
    if (pageEl) {
      const tab = pageEl.closest(".tab-content");
      const pr = rect(pageEl);
      const tr = tab ? rect(tab) : null;
      const foot = document.querySelector(".clip-foot");
      const fr = foot ? rect(foot) : null;
      const head = document.querySelector(".clip-head");
      const body = document.querySelector(".clip-body");
      clip = {
        integrated:
          !!tr && Math.abs(pr.left - tr.left) <= 1 && Math.abs(pr.right - tr.right) <= 1 &&
          Math.abs(pr.top - tr.top) <= 1 && Math.abs(pr.bottom - tr.bottom) <= 1,
        bg: getComputedStyle(pageEl).backgroundColor,
        border: getComputedStyle(pageEl).borderTopWidth,
        headBorder: head ? getComputedStyle(head).borderBottomWidth : null,
        footVisible: !!fr && fr.bottom <= window.innerHeight + 1 && fr.height > 0,
        footDivider: foot ? getComputedStyle(foot, "::before").backgroundImage : null,
        bodyScrollable: body ? body.scrollHeight > body.clientHeight + 1 : null,
      };
    }

    const overlays = [];
    for (const sel of [".ui-select-popover", ".ui-dtp-popover", ".titlebar-menu-popover", ".clipboard-layer.link-mode", ".ui-menu"]) {
      for (const el of document.querySelectorAll(sel)) {
        const r = rect(el);
        if (r.width === 0 || r.height === 0) continue;
        overlays.push({
          sel,
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
          inside:
            r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
          z: getComputedStyle(el).zIndex,
        });
      }
    }

    return {
      overflowX: doc.scrollWidth - doc.clientWidth,
      overflowY: doc.scrollHeight - doc.clientHeight,
      offscreen,
      blank: (document.querySelector("#root")?.childElementCount ?? 0) === 0,
      preset: document.documentElement.dataset.preset,
      theme: document.documentElement.dataset.theme,
      material: document.documentElement.dataset.material,
      rail: {
        items: items.length,
        expectedCount,
        countOk,
        entryLabels,
        orderOk,
        named: railNamed,
        labelsVisible: railLabels,
        scrollable,
        lastEntryReachable: reachable,
        add: addInfo,
      },
      clip,
      overlays,
      activeElement: document.activeElement?.className ?? "",
    };
  }, expected);
}

async function shoot(browser, c) {
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
  await page.addStyleTag({ content: `html{background:${WALL[c.theme]} !important;}` });
  await page.waitForTimeout(400);
  if (c.prepare) await c.prepare(page);

  const path = `${OUT}/${c.name}.png`;
  await saveShot(page, path);
  const audit = await auditPage(page);
  await page.close();
  return { name: c.name, path, w: c.w, h: c.h, ...audit, errors };
}

/** Escape 只关闭最上层：日期浮层 → 任务编辑器逐层关闭，关联抽屉同理。 */
async function escapeRegression(browser, c) {
  const page = await browser.newPage({ viewport: { width: c.w, height: c.h }, deviceScaleFactor: 1 });
  await page.goto(`${BASE}?preset=${c.preset}&theme=${c.theme}&material=${c.material}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);

  await page.locator(".task-edit").first().click();
  await page.waitForTimeout(350);
  await page.click('button[aria-label="截止时间"]');
  await page.waitForTimeout(300);
  const dtOpen = await page.locator(".ui-dtp-popover").count();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  const dtClosed = (await page.locator(".ui-dtp-popover").count()) === 0;
  const editorKept = (await page.locator(".modal").count()) === 1;
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  const editorClosed = (await page.locator(".modal").count()) === 0;

  await page.locator(".task-edit").first().click();
  await page.waitForTimeout(350);
  await page.click('button:has-text("从剪贴板选择")');
  await page.waitForTimeout(500);
  const drawerOpen = await page.locator(".clipboard-layer.link-mode").count();
  const drawerZ = drawerOpen
    ? await page.locator(".clipboard-layer.link-mode").evaluate((el) => getComputedStyle(el).zIndex)
    : null;
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const drawerClosed = (await page.locator(".clipboard-layer.link-mode").count()) === 0;
  const editorKept2 = (await page.locator(".modal").count()) === 1;

  await page.close();
  return {
    scenario: "escape",
    preset: c.preset,
    theme: c.theme,
    dtOpen: dtOpen === 1,
    dtClosed,
    editorKept,
    editorClosed,
    drawerOpen: drawerOpen === 1,
    drawerZ,
    drawerClosed,
    editorKeptAfterDrawer: editorKept2,
  };
}

/** 侧栏顶部「新建任务」按钮 hover / focus-visible 截图，并断言可聚焦 / 可点击。 */
async function addStates(browser, c) {
  const page = await browser.newPage({ viewport: { width: c.w, height: c.h }, deviceScaleFactor: 2 });
  const url = `${BASE}?preset=${c.preset}&theme=${c.theme}&material=${c.material}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: `html{background:${WALL[c.theme]} !important;}` });
  await page.waitForTimeout(400);

  // 选择器来自共享契约；缺失/重复都显式抛错（旧版选择器失效后 add 静默变成 null）。
  const addTrigger = page.locator(RAIL_ADD_BUTTON.selector);
  const count = await addTrigger.count();
  if (count !== 1) {
    throw new Error(
      `新建任务按钮 ${RAIL_ADD_BUTTON.selector} 匹配到 ${count} 个元素（期望 1 个）；` +
        `页面 ${url}，期望 aria-label="${RAIL_ADD_BUTTON.ariaLabel}" data-tip="${RAIL_ADD_BUTTON.tip}"`,
    );
  }
  const ariaLabel = await addTrigger.getAttribute("aria-label");
  const tip = await addTrigger.getAttribute("data-tip");

  // 用真实指针悬停（hover 落点 = 按钮中心），避免被预期遮罩挡住时 hover 动作直接超时。
  const box = await addTrigger.boundingBox();
  if (!box) throw new Error(`新建任务按钮 ${RAIL_ADD_BUTTON.selector} 没有可见布局盒：${url}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(350);
  const hover = await page.evaluate(({ selector }) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const s = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    const hitOnSelf = Boolean(hit) && (hit === el || el.contains(hit));
    return {
      color: s.color,
      borderColor: s.borderColor,
      face: s.backgroundImage !== "none" ? "gradient" : s.backgroundColor,
      cursor: s.cursor,
      clickable: hitOnSelf,
      covered: !hitOnSelf,
      w: Math.round(b.width),
      h: Math.round(b.height),
    };
  }, { selector: RAIL_ADD_BUTTON.selector });
  await saveShot(page, `${OUT}/${c.name}-hover.png`);

  const client = await page.context().newCDPSession(page);
  await client.send("DOM.enable");
  await client.send("CSS.enable");
  const { root } = await client.send("DOM.getDocument");
  const { nodeId } = await client.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: RAIL_ADD_BUTTON.selector,
  });
  if (!nodeId) throw new Error(`CDP 未找到 ${RAIL_ADD_BUTTON.selector} 节点：${url}`);
  await client.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["focus-visible"] });
  await page.waitForTimeout(250);
  const focus = await page.evaluate(({ selector }) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const s = getComputedStyle(el);
    return { outline: s.outline, boxShadow: s.boxShadow };
  }, { selector: RAIL_ADD_BUTTON.selector });
  await saveShot(page, `${OUT}/${c.name}-focus.png`);

  // 真实聚焦：forcePseudoState 只伪造 :focus-visible 样式，拿得到焦点才算「可聚焦」。
  const focusable = await page.evaluate(({ selector }) => {
    const el = document.querySelector(selector);
    if (!(el instanceof HTMLElement)) return false;
    el.focus();
    return document.activeElement === el;
  }, { selector: RAIL_ADD_BUTTON.selector });

  await page.close();
  return {
    scenario: "add-states",
    preset: c.preset,
    theme: c.theme,
    selector: RAIL_ADD_BUTTON.selector,
    ariaLabel,
    tip,
    ariaMatches: ariaLabel === RAIL_ADD_BUTTON.ariaLabel,
    tipMatches: tip === RAIL_ADD_BUTTON.tip,
    focusable,
    hover,
    focus,
  };
}

const results = [];
const errors = [];
// 共享契约快照：写进 audit JSON，便于对照「脚本当时用的入口清单」与真实 DOM。
const contract = {
  count: RAIL_ITEM_COUNT,
  labels: [...RAIL_LABELS],
  entries: RAIL_ENTRIES.map((e) => ({ id: e.id, label: e.label, shortcut: e.shortcut })),
  add: {
    selector: RAIL_ADD_BUTTON.selector,
    ariaLabel: RAIL_ADD_BUTTON.ariaLabel,
    tip: RAIL_ADD_BUTTON.tip,
  },
};
const browser = await chromium.launch();

// A. 四个主题组合的任务页 + 剪贴板页
for (const p of PRESETS) {
  for (const theme of ["light", "dark"]) {
    const t = `${p.tag}-${theme}`;
    const common = { preset: p.preset, theme, material: p.preset === "liquid-glass" ? "glass" : "solid", w: 400, h: 620 };
    results.push(await shoot(browser, { ...common, name: `v07-${t}-tasks-400x620` }));
    results.push(await shoot(browser, { ...common, name: `v07-${t}-clip-400x620`, prepare: openClipboard }));
  }
}

// B. 尺寸矩阵（窄、矮、宽）
const sizeCases = [
  { name: "v07-dream-light-tasks-320x560", preset: "dream-gradient", theme: "light", material: "solid", w: 320, h: 560 },
  { name: "v07-dream-light-clip-320x560", preset: "dream-gradient", theme: "light", material: "solid", w: 320, h: 560, prepare: openClipboard },
  { name: "v07-dream-light-tasks-340x460", preset: "dream-gradient", theme: "light", material: "solid", w: 340, h: 460 },
  { name: "v07-dream-light-tasks-380x560", preset: "dream-gradient", theme: "light", material: "solid", w: 380, h: 560 },
  { name: "v07-dream-light-clip-500x760", preset: "dream-gradient", theme: "light", material: "solid", w: 500, h: 760, prepare: openClipboard },
  { name: "v07-dream-dark-clip-320x560", preset: "dream-gradient", theme: "dark", material: "solid", w: 320, h: 560, prepare: openClipboard },
  { name: "v07-glass-light-tasks-320x560", preset: "liquid-glass", theme: "light", material: "glass", w: 320, h: 560 },
  { name: "v07-glass-light-tasks-400x620-solid", preset: "liquid-glass", theme: "light", material: "solid", w: 400, h: 620 },
  { name: "v07-glass-light-clip-340x460", preset: "liquid-glass", theme: "light", material: "glass", w: 340, h: 460, prepare: openClipboard },
  { name: "v07-glass-dark-tasks-340x460", preset: "liquid-glass", theme: "dark", material: "glass", w: 340, h: 460 },
  { name: "v07-glass-dark-clip-320x560", preset: "liquid-glass", theme: "dark", material: "glass", w: 320, h: 560, prepare: openClipboard },
  { name: "v07-glass-dark-clip-500x760", preset: "liquid-glass", theme: "dark", material: "glass", w: 500, h: 760, prepare: openClipboard },
];
for (const c of sizeCases) results.push(await shoot(browser, c));

// C. 弹层（两套预设的代表明暗组合 + 交叉一个）
const overlayCases = [
  { name: "v07-dream-light-sort-menu", preset: "dream-gradient", theme: "light", material: "solid", w: 400, h: 620, prepare: openSortMenu },
  { name: "v07-dream-light-theme-select", preset: "dream-gradient", theme: "light", material: "solid", w: 400, h: 620, prepare: openThemeSelect },
  { name: "v07-dream-light-datetime", preset: "dream-gradient", theme: "light", material: "solid", w: 400, h: 620, prepare: openDateTimeOverlay },
  { name: "v07-dream-light-link-drawer", preset: "dream-gradient", theme: "light", material: "solid", w: 400, h: 620, prepare: openClipboardLinkDrawer },
  { name: "v07-dream-light-titlebar-menu", preset: "dream-gradient", theme: "light", material: "solid", w: 400, h: 620, prepare: openTitleMenu },
  { name: "v07-dream-dark-sort-menu", preset: "dream-gradient", theme: "dark", material: "solid", w: 400, h: 620, prepare: openSortMenu },
  { name: "v07-glass-light-datetime", preset: "liquid-glass", theme: "light", material: "glass", w: 400, h: 620, prepare: openDateTimeOverlay },
  { name: "v07-glass-dark-sort-menu", preset: "liquid-glass", theme: "dark", material: "glass", w: 400, h: 620, prepare: openSortMenu },
  { name: "v07-glass-dark-theme-select", preset: "liquid-glass", theme: "dark", material: "glass", w: 400, h: 620, prepare: openThemeSelect },
  { name: "v07-glass-dark-datetime", preset: "liquid-glass", theme: "dark", material: "glass", w: 400, h: 620, prepare: openDateTimeOverlay },
  { name: "v07-glass-dark-link-drawer", preset: "liquid-glass", theme: "dark", material: "glass", w: 400, h: 620, prepare: openClipboardLinkDrawer },
  { name: "v07-glass-dark-titlebar-menu", preset: "liquid-glass", theme: "dark", material: "glass", w: 400, h: 620, prepare: openTitleMenu },
];
for (const c of overlayCases) results.push(await shoot(browser, c));

// D. Escape 优先级与添加按钮状态
const interactions = [];
interactions.push(await escapeRegression(browser, { preset: "dream-gradient", theme: "light", material: "solid", w: 400, h: 620 }));
interactions.push(await escapeRegression(browser, { preset: "liquid-glass", theme: "dark", material: "glass", w: 400, h: 620 }));
const addLight = await addStates(browser, { name: "v07-dream-light-add", preset: "dream-gradient", theme: "light", material: "solid", w: 400, h: 620 });
const addDark = await addStates(browser, { name: "v07-glass-dark-add", preset: "liquid-glass", theme: "dark", material: "glass", w: 400, h: 620 });
interactions.push(addLight, addDark);

await browser.close();

for (const r of results) {
  const fail = (reason) => errors.push(`${reason}:${r.name}`);
  if (r.blank) fail("blank");
  if (r.overflowX > 0) fail(`overflow-x=${r.overflowX}`);
  if (r.offscreen.length > 0) fail("offscreen");
  if (r.errors.length > 0) fail("page-error");
  // 八入口：数量 / 顺序 / 命名 / 最后入口滚动可达（旧版只测量未断言，且静默放过 null）
  if (r.rail.countOk !== true) fail(`rail-item-count=${r.rail.items}`);
  if (r.rail.orderOk !== true) fail("rail-item-order");
  if (r.rail.named !== true) fail("rail-item-named");
  if (r.rail.lastEntryReachable !== true) fail("rail-last-entry-unreachable");
  if (r.w > 384 && r.rail.labelsVisible === false) fail("rail-labels-hidden");
  // 新建任务按钮：缺失/不可见/不可聚焦/cursor 不对/被意外遮挡都不再静默通过。
  const add = r.rail.add;
  if (!add || add.exists !== true) {
    fail("rail-new-task-missing");
  } else {
    if (add.visible !== true) fail("rail-new-task-not-visible");
    if (add.focusable !== true) fail("rail-new-task-not-focusable");
    if (add.cursor !== "pointer") fail("rail-new-task-cursor");
    // 任务编辑器 / 关联抽屉打开时整窗预期遮罩会盖住按钮，属设计预期；
    // 其余遮挡（入口/浮层/角标等）仍判失败。
    if (!add.expectedOverlay) {
      if (add.clickable !== true) fail("rail-new-task-not-clickable");
      if (add.covered !== false) fail("rail-new-task-covered");
    }
  }
  if (r.overlays.some((o) => !o.inside)) fail("overlay-outside");
  if (r.clip && !r.clip.integrated) fail("clipboard-not-integrated");
  if (r.clip && !r.clip.footVisible) fail("clipboard-foot-hidden");
}
for (const i of interactions) {
  if (i.scenario === "escape") {
    if (!(i.dtOpen && i.dtClosed && i.editorKept && i.editorClosed && i.drawerOpen && i.drawerClosed && i.editorKeptAfterDrawer)) {
      errors.push(`escape:${i.preset}/${i.theme}`);
    }
    if (i.drawerZ === null || Number(i.drawerZ) < 70) errors.push(`drawer-z:${i.preset}/${i.theme}=${i.drawerZ}`);
  }
  if (i.scenario === "add-states") {
    const tag = `${i.preset}/${i.theme}`;
    if (i.ariaMatches !== true) errors.push(`add-aria-label:${tag}=${i.ariaLabel}`);
    if (i.tipMatches !== true) errors.push(`add-data-tip:${tag}=${i.tip}`);
    if (i.focusable !== true) errors.push(`add-not-focusable:${tag}`);
    if (i.hover?.clickable !== true || i.hover?.covered !== false) errors.push(`add-not-clickable:${tag}`);
    if (i.hover?.cursor !== "pointer") errors.push(`add-cursor:${tag}=${i.hover?.cursor}`);
    if (!i.hover?.color || !i.hover?.face) errors.push(`add-hover-face:${tag}`);
    if (!i.focus?.boxShadow || i.focus.boxShadow === "none") errors.push(`add-focus-visible:${tag}`);
  }
}

const audit = {
  generated_at: new Date().toISOString(),
  base: BASE,
  out: OUT,
  contract,
  results,
  interactions,
  failed: errors,
};
writeFileSync(`${OUT}/audit-v07.json`, JSON.stringify(audit, null, 2));
for (const r of results) {
  const add = r.rail.add;
  const addText = add?.exists
    ? `${add.visible}/${add.focusable}/${add.clickable}/${add.covered}${add.expectedOverlay ? "(expected-overlay)" : ""}`
    : "missing";
  console.log(
    `${r.name}  rail=${r.rail.items}/${r.rail.expectedCount} order=${r.rail.orderOk} named=${r.rail.named} ` +
      `labels=${r.rail.labelsVisible} reach=${r.rail.lastEntryReachable} add=${addText} ` +
      `overlays=${r.overlays.length} clip=${r.clip ? `${r.clip.integrated}/${r.clip.footVisible}` : "-"} ` +
      `overflow=${r.overflowX} errors=${r.errors.length}`,
  );
}
for (const i of interactions) console.log(JSON.stringify(i));
console.log(errors.length ? `FAILED: ${errors.join(", ")}` : "OK: all browser acceptance checks passed");
process.exit(errors.length ? 1 : 0);
