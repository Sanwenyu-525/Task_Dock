//! 真实浏览器渲染性能采样（v0.5）：
//!   npm run build && node scripts/make-preview.mjs && node scripts/render-perf.mjs
//!
//! 用预览 harness（IPC mock + ?perf=300 夹具）在 Chromium 中渲染 300 行任务，
//! 测量：
//!   1) 首屏可见（导航开始 → 300 行出现，含应用启动与 mock IPC）；
//!   2) 全量重渲染提交耗时（搜索开关改变 TasksPanel state → 300 个 TaskItem 重渲染）。
//! 预算：重渲染提交 p50 ≤ 100ms（docs/V05_DESIGN.md）。
//! 结果写入 docs/performance/results/R-render-<时间戳>.json。

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { availableParallelism } from "node:os";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");
const PORT = 4180;
const ROWS = 300;
const BUDGET_MS = 100;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

if (!existsSync(join(DIST, "preview.html"))) {
  console.error("缺少 dist/preview.html：先运行 npm run build && node scripts/make-preview.mjs");
  process.exit(1);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  const file = join(DIST, rel || "index.html");
  if (!file.startsWith(DIST) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(file)] || "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 700 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

const url = `http://127.0.0.1:${PORT}/preview.html?mode=full&theme=light&perf=${ROWS}`;
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForFunction((n) => document.querySelectorAll(".task-item").length >= n, ROWS);
const firstVisibleMs = await page.evaluate(() => performance.now());

/** 搜索开关是纯前端 state 变更：TasksPanel 及其 300 个 TaskItem 全部重渲染。 */
async function measureRender() {
  return page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="搜索任务"], button[aria-label="收起搜索"]');
    if (!btn) throw new Error("搜索按钮不存在");
    const rowCount = document.querySelectorAll(".task-item").length;
    const t0 = performance.now();
    btn.click();
    const commitMs = performance.now() - t0;
    return new Promise((resolve) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          resolve({ commitMs, paintMs: performance.now() - t0, rowCount }),
        ),
      );
    });
  });
}

const samples = [];
let paintMs = 0;
for (let i = 0; i < 5; i++) {
  const r = await measureRender();
  samples.push(r.commitMs);
  paintMs = Math.max(paintMs, r.paintMs);
  if (r.rowCount !== ROWS) errors.push(`重渲染后行数异常：${r.rowCount}`);
  await page.waitForTimeout(120);
}

await browser.close();
server.close();

samples.sort((a, b) => a - b);
const median = samples[Math.floor(samples.length / 2)];
const report = {
  scenario: "frontend-render-300",
  machine: {
    os: process.platform,
    arch: process.arch,
    logical_cpus: availableParallelism(),
    browser: "chromium (playwright)",
  },
  fixture: { rows: ROWS, viewport: "400x700", trigger: "搜索开关 → TasksPanel 全量重渲染" },
  measurements: {
    first_visible_ms: Math.round(firstVisibleMs * 10) / 10,
    rerender_commit_samples_ms: samples.map((v) => Math.round(v * 10) / 10),
    rerender_commit_median_ms: Math.round(median * 10) / 10,
    rerender_to_paint_max_ms: Math.round(paintMs * 10) / 10,
  },
  budget: { rerender_commit_median_ms_max: BUDGET_MS },
  errors,
  pass: errors.length === 0 && median <= BUDGET_MS,
};

const outDir = join(ROOT, "docs/performance/results");
mkdirSync(outDir, { recursive: true });
const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const out = join(outDir, `R-render-${ts}.json`);
writeFileSync(out, JSON.stringify(report, null, 2));

console.log(
  `[渲染] 300 行重渲染提交 ${samples.map((v) => v.toFixed(1)).join("/")}ms · 中位数 ${median.toFixed(1)}ms · 到绘制 ${paintMs.toFixed(1)}ms；首屏可见 ${firstVisibleMs.toFixed(0)}ms`,
);
console.log(`[报告] ${out}`);
if (!report.pass) {
  console.error(`未达标：中位数 ${median.toFixed(1)}ms（预算 ${BUDGET_MS}ms）或存在页面错误`, errors);
  process.exit(1);
}
