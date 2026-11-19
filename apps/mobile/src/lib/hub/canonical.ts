// Canonical JSON（契约 §1）：对象键按字典序、数组保序、剔除 undefined 值。
//
// **必须与云端 `services/personal-hub-control-plane/src/schema/canonical.ts`
// 逐字节一致**：任何差异都会让 Ed25519 验签在服务端失败。修改本文件时先改云端，
// 同步更新 `tests/hubCanonical.test.ts` 的固定向量，再让三端一起升级。
//
// 与 RFC 8785 的差异（与云端实现保持一致，不擅自扩展）：
// - 只处理 JSON 可表达的值；数字沿用 `JSON.stringify` 的十进制表示；
// - 对象里 `undefined` 的键被剔除；数组里的 `undefined` 序列化为 `null`（与 JSON.stringify 一致）；
// - 不调用 `toJSON()`，避免业务对象隐式改变签名载荷。
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(",")}}`;
}

/** 剔除 signature 字段后的 canonical 字节串；签名覆盖的正是这一段。 */
export function signablePayload(body: Record<string, unknown>): string {
  const { signature: _signature, ...rest } = body;
  return canonicalStringify(rest);
}
