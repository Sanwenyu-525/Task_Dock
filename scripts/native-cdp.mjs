//! 原生窗口取证（CDP 附加到 WebView2）：
//! 通过 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 打开远程调试端口，用 Playwright
//! 附加到真实运行中的 Tauri WebView2，读取控制台错误、DOM 状态并截图。
//!
//! 用法：
//!   1) 先用 scripts/native-verify.ps1 启动应用（带远程调试端口）
//!   2) node scripts/native-cdp.mjs [输出前缀]
//!
//! 说明：这是**真实运行**的应用（不是预览 harness），用于抓取运行时错误与原生渲染证据。

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const prefix = process.argv[2] || "docs/screenshots/v06/native-cdp";
const PORT = process.env.CDP_PORT || "9222";

mkdirSync(prefix.replace(/\/[^/]+$/, ""), { recursive: true });

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const contexts = browser.contexts();
let page = null;
for (const ctx of contexts) {
  for (const p of ctx.pages()) {
    if (!page) page = p;
    console.log("page:", p.url());
  }
}
if (!page) {
  console.error("no page attached");
  process.exit(1);
}

const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForTimeout(2500);

const state = await page.evaluate(() => {
  const root = document.getElementById("root");
  const win = document.querySelector(".dock-window");
  return {
    url: location.href,
    rootChildren: root ? root.children.length : -1,
    rootHtmlLength: root ? root.innerHTML.length : -1,
    dataset: {
      theme: document.documentElement.dataset.theme,
      preset: document.documentElement.dataset.preset,
      material: document.documentElement.dataset.material,
      nativeGlass: document.documentElement.dataset.nativeGlass,
    },
    dockWindowClass: win ? win.className : null,
    bodyText: (document.body.innerText || "").slice(0, 200),
    hasWebviewBackground: getComputedStyle(document.body).backgroundColor,
  };
});

console.log(JSON.stringify({ state, errors }, null, 2));

await page.screenshot({ path: `${prefix}-webview.png` });
await browser.close();
