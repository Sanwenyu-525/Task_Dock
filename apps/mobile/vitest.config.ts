// vitest 配置：只跑 apps/mobile 内的纯函数单测。
// 必须单独存在——否则 vitest 会向上找到仓库根的 vite.config.ts（桌面端 Web 配置），
// 在移动端上下文里加载失败（React 插件/依赖不在移动端依赖树内）。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
