//! v0.6 主题性能走查（Chromium / 预览 harness）：
//! 1. 空闲 3 秒内的主线程耗时、布局与样式重算次数（应接近 0，且不随预设变化）；
//! 2. 页面上 `backdrop-filter` 元素数、常驻 CSS 动画数、合成层数量；
//! 3. 主题连续切换 20 次的耗时（验证切换路径无同步重排爆炸）。
//!
//!   node scripts/serve-preview.mjs
//!   node scripts/theme-perf.mjs

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

// vite build 会清空 dist，harness 必须在每次走查前重建
execFileSync(process.execPath, ["scripts/make-preview.mjs"], { stdio: "inherit" });

const BASE = "http://localhost:4173/preview.html";
const IDLE_MS = 3000;
// 首屏渲染与 Agent 面板首次轮询会落在测量窗口里，必须等它跑完再开始计时
const SETTLE_MS = 1500;

const cases = [
  { name: "dream-gradient", preset: "dream-gradient", theme: "light" },
  { name: "liquid-glass", preset: "liquid-glass", theme: "light" },
  { name: "dream-dark", preset: "dream-gradient", theme: "dark" },
  { name: "glass-dark", preset: "liquid-glass", theme: "dark" },
];

const browser = await chromium.launch();
const out = [];

for (const c of cases) {
  const page = await browser.newPage({ viewport: { width: 400, height: 560 }, deviceScaleFactor: 2 });
  const client = await page.context().newCDPSession(page);
  await client.send("Performance.enable");
  await page.goto(`${BASE}?preset=${c.preset}&theme=${c.theme}&material=glass&mode=full`, {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(SETTLE_MS);

  const before = Object.fromEntries((await client.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  await page.waitForTimeout(IDLE_MS);
  const after = Object.fromEntries((await client.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));

  const staticInfo = await page.evaluate(() => {
    const all = [...document.querySelectorAll("*")];
    const backdrop = all.filter((el) => {
      const s = getComputedStyle(el);
      return s.backdropFilter && s.backdropFilter !== "none";
    }).length;
    const filter = all.filter((el) => {
      const s = getComputedStyle(el);
      return s.filter && s.filter !== "none";
    }).length;
    const animations = document.getAnimations().filter((a) => a.playState === "running").length;
    return {
      elements: all.length,
      backdropFilter: backdrop,
      cssFilter: filter,
      runningAnimations: animations,
    };
  });

  // 连续切换预设 20 次（走真实 store 路径：DOM 变量重赋值）
  const switchMs = await page.evaluate(async () => {
    const root = document.documentElement;
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) {
      root.dataset.preset = i % 2 === 0 ? "liquid-glass" : "dream-gradient";
      root.dataset.theme = i % 4 === 0 ? "dark" : "light";
      // 强制读取一次布局，模拟真实切换后立刻测量
      void document.querySelector(".dock-window")?.getBoundingClientRect();
    }
    return performance.now() - t0;
  });

  out.push({
    case: c.name,
    idleTaskDurationMs: +((after.TaskDuration - before.TaskDuration) * 1000).toFixed(1),
    idleLayoutCount: after.LayoutCount - before.LayoutCount,
    idleRecalcStyleCount: after.RecalcStyleCount - before.RecalcStyleCount,
    idleScriptDurationMs: +((after.ScriptDuration - before.ScriptDuration) * 1000).toFixed(1),
    ...staticInfo,
    switch20Ms: +switchMs.toFixed(1),
  });

  await page.close();
}

await browser.close();
console.table(out);
