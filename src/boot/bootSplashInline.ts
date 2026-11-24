import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/**
 * 启动占位样式的单一来源收口（2026-11-24）。
 *
 * `index.html`（主窗口）与 `workspace.html`（工作台窗口）的 `<style>` 里只保留
 * {@link BOOT_SPLASH_MARKER}；Vite 在 dev 与 build 的 `transformIndexHtml` 阶段把
 * `bootSplashCss.css` 内联进去。这样既保住「启动界面零外部样式依赖、资源失败时恢复卡
 * 仍有样式」这条硬约束，也不再需要两份 519 行的手抄副本。
 *
 * 契约由 `src/test/bootSplash.test.ts` 锁定：HTML 里只允许出现标记（不得再写回具体规则）、
 * 注入结果必须包含完整布局契约、缺标记必须抛错而不是静默产出无样式占位。
 */
export const BOOT_SPLASH_MARKER = "/* boot-splash-shared:inject */";

/** 只在两个宿主窗口注入；其它多页入口（通知/浮层/微件）没有启动占位。 */
const HOST_PAGES = new Set(["index.html", "workspace.html"]);

export const BOOT_SPLASH_CSS_FILE = fileURLToPath(new URL("./bootSplashCss.css", import.meta.url));

export function readBootSplashCss(): string {
  return readFileSync(BOOT_SPLASH_CSS_FILE, "utf8");
}

/** 把样式块替换进标记位置；缺标记时抛错（宁可构建失败，也不产出无样式占位）。 */
export function injectBootSplashCss(html: string, css: string): string {
  const at = html.indexOf(BOOT_SPLASH_MARKER);
  if (at < 0) {
    throw new Error(`启动占位样式注入失败：HTML 缺少标记 ${BOOT_SPLASH_MARKER}`);
  }
  return html.slice(0, at) + css.trimEnd() + html.slice(at + BOOT_SPLASH_MARKER.length);
}

export function bootSplashInline(): Plugin {
  return {
    name: "taskdock-boot-splash-inline",
    enforce: "pre",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const page = ctx.filename.split(/[\\/]/).pop() ?? "";
        if (!HOST_PAGES.has(page)) return html;
        return injectBootSplashCss(html, readBootSplashCss());
      },
    },
  };
}
