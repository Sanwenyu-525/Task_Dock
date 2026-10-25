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
    include: ["src/**/*.test.ts"],
  },
});
