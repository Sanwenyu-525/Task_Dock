import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 开发服务器固定端口（与 tauri.conf.json devUrl 保持一致）
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
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
