// expo-modules-core 的 node 测试替身：单测里不应触达真实原生模块。
// 需要 SecureHttp 原为的测试应通过 createSecureFetch 的注入参数传入假实现。
export function requireNativeModule(name: string): unknown {
  throw new Error(
    `测试环境没有原生模块「${name}」：请在被测函数中注入假实现（见 src/lib/sync/secureFetch.ts）`,
  );
}
