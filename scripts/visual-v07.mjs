//! v0.7 P1/P2 浏览器验收（**浏览器 harness 合成图，不等同于原生窗口验收**）。
//!
//! 覆盖：
//! - 两套预设 × 明暗的任务页 / 剪贴板页融合效果；
//! - 320 / 340 / 400 / 500 宽度与 380 / 460 / 560 / 620 / 760 高度；
//! - 排序 Select、设置页配色 Select、日期时间浮层、剪贴板关联抽屉、标题栏菜单；
//! - Escape 只关最上层弹层；菜单/浮层不越出窗口；底部添加入口 hover/focus；
//! - 横向溢出、侧栏入口可达性、剪贴板页是否仍嵌套独立背景。
//!
//!   npm run build && node scripts/make-preview.mjs
//!   node scripts/serve-preview.mjs          # 另开一个终端
//!   node scripts/visual-v07.mjs

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = "http://localhost:4173/preview.html";
const OUT = "docs/screenshots/v07";
mkdirSync(OUT, { recursive: true });

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

/** 审计：页面级溢出、白屏、控制台错误、侧栏可达性、添加按钮、剪贴板融合、弹层边界。 */
async function auditPage(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const rect = (el) => el.getBoundingClientRect();
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
    const list = rail?.querySelector(".rail-items");
    const items = list ? Array.from(list.querySelectorAll(".rail-item")) : [];
    const listBox = list ? rect(list) : null;
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
    const add = rail?.querySelector(".rail-add");
    const addBox = add ? rect(add) : null;
    const addStyle = add ? getComputedStyle(add) : null;
    const addInfo = addBox
      ? {
          visible: addBox.bottom <= (rail ? rect(rail).bottom : 0) + 1 && addBox.height > 0,
          w: Math.round(addBox.width),
          h: Math.round(addBox.height),
          cursor: addStyle?.cursor,
          face: addStyle?.backgroundImage !== "none" ? "gradient" : addStyle?.backgroundColor,
          opacity: addStyle?.opacity,
          color: addStyle?.color,
        }
      : null;

    const railLabels = rail
      ? Array.from(rail.querySelectorAll(".rail-label")).every(
          (el) => getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 0,
        )
      : null;
    // 窄窗（<=384）按设计收成图标轨，但每个入口必须仍有可读名称（aria-label/data-tip）
    const railNamed =
      items.length === 6 &&
      items.every((el) => (el.getAttribute("aria-label") ?? el.getAttribute("data-tip") ?? "").trim() !== "");

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
        labelsVisible: railLabels,
        named: railNamed,
        scrollable,
        lastEntryReachable: reachable,
        add: addInfo,
      },
      clip,
      overlays,
      activeElement: document.activeElement?.className ?? "",
    };
  });
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

/** 底部添加入口 hover / focus-visible 截图。 */
async function addStates(browser, c) {
  const page = await browser.newPage({ viewport: { width: c.w, height: c.h }, deviceScaleFactor: 2 });
  const url = `${BASE}?preset=${c.preset}&theme=${c.theme}&material=${c.material}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: `html{background:${WALL[c.theme]} !important;}` });
  await page.waitForTimeout(400);

  await page.hover(".rail-add");
  await page.waitForTimeout(350);
  const hover = await page.locator(".rail-add").evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, borderColor: s.borderColor, face: s.backgroundImage !== "none" ? "gradient" : s.backgroundColor };
  });
  await saveShot(page, `${OUT}/${c.name}-hover.png`);

  const client = await page.context().newCDPSession(page);
  await client.send("DOM.enable");
  await client.send("CSS.enable");
  const { root } = await client.send("DOM.getDocument");
  const { nodeId } = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".rail-add" });
  await client.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["focus-visible"] });
  await page.waitForTimeout(250);
  const focus = await page.locator(".rail-add").evaluate((el) => {
    const s = getComputedStyle(el);
    return { outline: s.outline, boxShadow: s.boxShadow };
  });
  await saveShot(page, `${OUT}/${c.name}-focus.png`);
  await page.close();
  return { scenario: "add-states", hover, focus };
}

const results = [];
const errors = [];
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
  const bad =
    r.blank ||
    r.overflowX > 0 ||
    r.offscreen.length > 0 ||
    r.errors.length > 0 ||
    r.rail.items !== 6 ||
    !r.rail.named ||
    (r.w > 384 && r.rail.labelsVisible === false) ||
    r.rail.add?.visible === false ||
    r.rail.add?.cursor !== "pointer" ||
    r.overlays.some((o) => !o.inside) ||
    (r.clip && (!r.clip.integrated || !r.clip.footVisible));
  if (bad) errors.push(r.name);
}
for (const i of interactions) {
  if (i.scenario === "escape") {
    if (!(i.dtOpen && i.dtClosed && i.editorKept && i.editorClosed && i.drawerOpen && i.drawerClosed && i.editorKeptAfterDrawer)) {
      errors.push(`escape:${i.preset}/${i.theme}`);
    }
    if (i.drawerZ === null || Number(i.drawerZ) < 70) errors.push(`drawer-z:${i.preset}/${i.theme}=${i.drawerZ}`);
  }
  if (i.scenario === "add-states" && i.focus.boxShadow === "none") errors.push("add-focus-visible");
}

const audit = { generated_at: new Date().toISOString(), base: BASE, results, interactions, failed: errors };
writeFileSync(`${OUT}/audit-v07.json`, JSON.stringify(audit, null, 2));
for (const r of results) {
  console.log(
    `${r.name}  rail=${r.rail.items} labels=${r.rail.labelsVisible} named=${r.rail.named} add=${r.rail.add?.visible}/${r.rail.add?.cursor} ` +
      `reach=${r.rail.lastEntryReachable} overlays=${r.overlays.length} clip=${r.clip ? `${r.clip.integrated}/${r.clip.footVisible}` : "-"} ` +
      `overflow=${r.overflowX} errors=${r.errors.length}`,
  );
}
for (const i of interactions) console.log(JSON.stringify(i));
console.log(errors.length ? `FAILED: ${errors.join(", ")}` : "OK: all browser acceptance checks passed");
process.exit(errors.length ? 1 : 0);
