//! v0.4 发布前视觉走查：三视图 × 主题 × 320px 窄窗截图。
//! 用预览 harness（IPC mock）渲染真实 dist 产物，不是静态源码推断。
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = "docs/screenshots/v04";
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

  // 布局体检：横向溢出 / 关键元素可见性 / 焦点可达性
  const audit = await page.evaluate(() => {
    const doc = document.documentElement;
    const overflowX = doc.scrollWidth - doc.clientWidth;
    const offscreen = [];
    for (const el of document.querySelectorAll(".task-item, .settings-row, .modal, .target-menu, .compact-agent")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1)) {
        offscreen.push(`${el.className}:${Math.round(r.left)}..${Math.round(r.right)}`);
      }
    }
    const buttons = document.querySelectorAll("button").length;
    const focusable = document.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]'
    ).length;
    const visibleText = (document.body.innerText || "").trim().length;
    return { overflowX, offscreen, buttons, focusable, visibleText };
  });

  results.push({ ...c, ...audit, errors });
  await page.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
