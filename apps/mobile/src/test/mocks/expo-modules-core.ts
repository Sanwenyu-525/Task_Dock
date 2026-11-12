// expo-modules-core 的 node 测试替身：单测里不应触达真实原生模块。
// 需要 SecureHttp 原为的测试应通过 createSecureFetch 的注入参数传入假实现。
export function requireNativeModule(name: string): unknown {
  throw new Error(
    `测试环境没有原生模块「${name}」：请在被测函数中注入假实现（见 src/lib/sync/secureFetch.ts）`,
  );
}

/**
 * 可选原生模块（share-intent / taskdock-widget 这类增强能力）：测试环境一律视为缺失，
 * 调用方按「原生不可用」分支降级——与用户在旧构建/非 Android 平台的运行结果一致。
 */
export function requireOptionalNativeModule<T>(_name: string): T | null {
  return null;
}
