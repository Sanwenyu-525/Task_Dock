import { defineConfig } from "vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

// Tauri 开发服务器固定端口（与 tauri.conf.json devUrl 保持一致）
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // 多页入口：index.html（主窗）+ context-menu.html（右键菜单弹窗）
  // + notification.html（六状态桌面通知窗口）+ capture.html（全局快速捕获窗口）
  // + tab-hint.html（极简标签悬停提示：10px 窄窗内的浮层会被原生区域裁掉）
  // + widget.html（桌面微件独立窗口：轻量宿主，不挂载完整 App）
  build: {
    // 多入口时共享 CSS 会被拆成独立 chunk，浏览器按 chunk 顺序加载会让
    // styles-themes.css 排在 styles.css 之前，覆盖关系反转。合并为单文件，
    // 保持 import 顺序（base → themes → ui）。
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        "context-menu": resolve(__dirname, "context-menu.html"),
        notification: resolve(__dirname, "notification.html"),
        capture: resolve(__dirname, "capture.html"),
        "tab-hint": resolve(__dirname, "tab-hint.html"),
        widget: resolve(__dirname, "widget.html"),
      },
    },
  },
  optimizeDeps: {
    // 开发期首屏（2026-11-11）：默认 true 会等整个入口依赖扫描完成才放行请求，
    // 本仓库模块图较大时首屏被拖到 40–100 秒，表现为「窗口在但没有 UI」。
    // 先放行已发现的依赖，后续发现新依赖时由 Vite 客户端自动整页重载补齐。
    holdUntilCrawlEnd: false,
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    // 开发期首屏预热（2026-11-11）：Vite 冷启动的依赖预构建会阻塞入口模块请求，
    // 大模块图能把 `#root` 空白拖到十几秒以上（表现为「窗口在但没有 UI」）。
    // 在 dev server 启动时就预转换各入口及其依赖图，把这段时间挪到前端真正加载前。
    warmup: {
      clientFiles: [
        "./src/main.tsx",
        "./src/App.tsx",
        "./src/capture/main.tsx",
        "./src/context-menu/main.tsx",
        "./src/notifications/main.tsx",
        "./src/tab-hint/main.tsx",
        "./src/widgets/main.tsx",
      ],
    },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    environment: "node",
    // 纯函数测试保持 node；真实 DOM 交互测试文件用 `// @vitest-environment jsdom` 头注释单独指定
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: ["src/test/setup.ts"],
    // 样式守卫测试用 `?raw` 直接读 CSS 原文；默认 Vitest 会把 CSS 桩成空串，
    // 只有显式 include `?raw` 请求才放行（其余 CSS 仍然桩掉，不进 jsdom）。
    css: { include: [/\?raw/] },
  },
});
