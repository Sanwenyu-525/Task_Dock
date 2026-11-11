// 手机端单测配置：node 环境，不用 jsdom（被测对象是纯函数 + 数据层 + 协议客户端）。
// Expo 原生模块用 src/test/mocks 下的替身替换：业务代码原样运行，只有原生边界被替换，
// 不允许为了测试重写任何业务逻辑。
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const mock = (name: string) => fileURLToPath(new URL(`./src/test/mocks/${name}.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "expo-sqlite": mock("expo-sqlite"),
      "expo-secure-store": mock("expo-secure-store"),
      "expo-crypto": mock("expo-crypto"),
      "expo-modules-core": mock("expo-modules-core"),
      "expo-notifications": mock("expo-notifications"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // 单文件默认各起独立 worker，模块级单例（database.ts 的 handle）互不串扰。
  },
});
