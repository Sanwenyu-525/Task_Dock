import { defineConfig } from "vite";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { syncPdfjsAssets } from "./scripts/pdfjs-assets.mjs";
import { bootSplashInline } from "./src/boot/bootSplashInline";

// PDF 预览的 CMap/字体/WASM 必须随包本地提供（禁止 CDN）：配置求值时同步到 public/pdfjs。
syncPdfjsAssets();

// Tauri 开发服务器固定端口（与 tauri.conf.json devUrl 保持一致）
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // 启动占位样式单一来源：把 src/boot/bootSplashCss.css 内联进 index.html / workspace.html
  // 的 <style>（两处只留注入标记）。先于其它插件执行，避免 HTML 处理顺序影响标记位置。
  plugins: [bootSplashInline(), react()],
  clearScreen: false,
  // 多页入口：index.html（主窗）+ context-menu.html（右键菜单弹窗）
  // + notification.html（六状态桌面通知窗口）+ capture.html（全局快速捕获窗口）
  // + tab-hint.html（极简标签悬停提示：10px 窄窗内的浮层会被原生区域裁掉）
  // + widget.html（桌面微件独立窗口：轻量宿主，不挂载完整 App）
  // + toolbar.html（投屏控制栏独立窗口：只装载 ProjectionToolbar）
  build: {
    // 多入口时共享 CSS 会被拆成独立 chunk，浏览器按 chunk 顺序加载会让
    // styles-themes.css 排在 styles.css 之前，覆盖关系反转。合并为单文件，
    // 保持 import 顺序（base → themes → ui）。
    cssCodeSplit: false,
    rollupOptions: {
      // 2026-11-20：多入口 + 大量动态页面时，Rollup 默认会把「没有导出」的
      // 入口模块（src/main.tsx）并进共享 chunk；页面 import 触到该 chunk
      // 就会执行主窗的 createRoot，把 #root 覆盖成主窗 App（工作台窗口
      // 打开后实际显示主窗）。strict 强制每个 HTML 入口独立成 chunk，
      // 入口副作用只在各自窗口执行一次。
      preserveEntrySignatures: "strict",
      input: {
        main: resolve(__dirname, "index.html"),
        "context-menu": resolve(__dirname, "context-menu.html"),
        notification: resolve(__dirname, "notification.html"),
        capture: resolve(__dirname, "capture.html"),
        "tab-hint": resolve(__dirname, "tab-hint.html"),
        widget: resolve(__dirname, "widget.html"),
        workspace: resolve(__dirname, "workspace.html"),
        toolbar: resolve(__dirname, "toolbar.html"),
      },
    },
  },
  optimizeDeps: {
    // Vite 7 即使 holdUntilCrawlEnd=false，裸导入解析仍会 await scanProcessing。
    // 禁止冷启动扫描整个多页面业务图：CJS/大型 UI 依赖显式预构建；Tauri 与 PDF
    // 等原生 ESM 保持按需加载。新增 CJS 依赖时须同步加入 include。
    noDiscovery: true,
    include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "lucide-react", "@floating-ui/react", "zustand"],
    holdUntilCrawlEnd: false,
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    // 只预热零业务依赖的启动入口。预热所有窗口会递归转换各自的静态图，
    // 与真正的首屏请求争抢转换资源，延后首屏模块转换。
    // 业务入口按实际窗口请求转换，不在启动时主动展开全部模块图。
    warmup: {
      clientFiles: [
        "./src/workspace/bootstrap.ts",
      ],
    },
    watch: {
      // 桌面 Dev 不监听移动端构建与验收产物：Android 的 HTML 报告曾触发整页重载，
      // 大量缓存目录的监听也会与首屏文件读取争抢 I/O。
      ignored: ["**/src-tauri/**", "**/apps/mobile/**", "**/tmp/**", "**/dist/**", "**/dist-*/**", "**/.preview*/**"],
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
