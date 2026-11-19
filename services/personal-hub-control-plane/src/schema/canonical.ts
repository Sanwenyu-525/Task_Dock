/**
 * 稳定 JSON 序列化（RFC 8785 风格的简化实现）：对象键按字典序排序，
 * 数组保持顺序。用于构造 Ed25519 验签的确定性字节串，避免键序歧义。
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalStringify(record[key])}`,
    )
    .join(',')}}`;
}

/** 从已解析的请求体中剔除 signature 字段，得到签名覆盖的规范化字节串。 */
export function signablePayload(body: Record<string, unknown>): string {
  const { signature: _signature, ...rest } = body;
  return canonicalStringify(rest);
}
