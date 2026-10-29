//! v0.5 发布前视觉走查：三视图 × 主题 × 320/400px；完整模式额外走查
//! 行动中心与任务上下文抽屉。用预览 harness（IPC mock）渲染真实 dist 产物，
//! 不是静态源码推断。
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = "docs/screenshots/v05";
mkdirSync(OUT, { recursive: true });

const BASE = "http://localhost:4173/preview.html";
const cases = [
  { name: "full-light-320", mode: "full", theme: "light", w: 320, h: 620 },
  { name: "full-dark-320", mode: "full", theme: "dark", w: 320, h: 620 },
  { name: "compact-light-320", mode: "compact", theme: "light", w: 320, h: 620 },
  { name: "compact-dark-320", mode: "compact", theme: "dark", w: 320, h: 620 },
  { name: "minimal-light-320", mode: "minimal", theme: "light", w: 320, h: 220 },
  { name: "minimal-dark-320", mode: "minimal", theme: "dark", w: 320, h: 220 },
  { name: "full-light-400", mode: "full", theme: "light", w: 400, h: 700 },
  { name: "full-dark-400", mode: "full", theme: "dark", w: 400, h: 700 },
];

function auditPage(page, label) {
  return page.evaluate((label) => {
    const doc = document.documentElement;
    const overflowX = doc.scrollWidth - doc.clientWidth;
    const offscreen = [];
    for (const el of document.querySelectorAll(
      ".task-item, .settings-row, .modal, .target-menu, .compact-agent, .action-item, .snapshot-card, .coverage-strip, .context-section",
    )) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)) {
        offscreen.push(`${el.className}:${Math.round(r.left)}..${Math.round(r.right)}`);
      }
    }
    const drawers = [...document.querySelectorAll(".clipboard-drawer")].map((el) => ({
      className: el.className,
      overflowX: el.scrollWidth - el.clientWidth,
    }));
    const buttons = document.querySelectorAll("button").length;
    const focusable = document.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]',
    ).length;
    const visibleText = (document.body.innerText || "").trim().length;
    return { label, overflowX, offscreen, drawers, buttons, focusable, visibleText };
  }, label);
}

const browser = await chromium.launch();
const results = [];

for (const c of cases) {
  const page = await browser.newPage({
    viewport: { width: c.w, height: c.h },
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`${BASE}?mode=${c.mode}&theme=${c.theme}&material=glass`, {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/${c.name}.png` });
  const audits = [await auditPage(page, "base")];

  if (c.mode === "full") {
    // 行动中心
    await page.locator(".tabs .tab").nth(2).click();
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${OUT}/${c.name}-actions.png` });
    audits.push(await auditPage(page, "actions"));

    // 任务上下文抽屉：回到任务页，点第一张任务卡的上下文按钮
    await page.locator(".tabs .tab").nth(0).click();
    await page.waitForTimeout(250);
    const ctxBtn = page.locator(".task-item .task-context").first();
    await ctxBtn.click({ force: true });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${c.name}-context.png` });
    audits.push(await auditPage(page, "context"));

    // 展开现场明细，验证快照条目与关联素材不溢出
    const snap = page.locator(".snapshot-main").first();
    if (await snap.count()) {
      await snap.click({ force: true });
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${OUT}/${c.name}-context-detail.png` });
      audits.push(await auditPage(page, "context-detail"));
    }
  }

  results.push({ ...c, audits, errors });
  await page.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
