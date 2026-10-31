import { defineConfig } from "vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

// Tauri 开发服务器固定端口（与 tauri.conf.json devUrl 保持一致）
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // 多页入口：index.html（主窗）+ context-menu.html（液态玻璃右键菜单弹窗）
  build: {
    // 多入口时共享 CSS 会被拆成独立 chunk，浏览器按 chunk 顺序加载会让
    // styles-themes.css 排在 styles.css 之前，覆盖关系反转。合并为单文件，
    // 保持 import 顺序（base → themes → ui）。
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        "context-menu": resolve(__dirname, "context-menu.html"),
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
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
