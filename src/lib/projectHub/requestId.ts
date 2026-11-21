/**
 * 创建请求幂等键：同一份草案重试必须复用同一个 `clientRequestId`。
 *
 * 规则（`docs/project-hub/07-迭代计划.md` S5 缺陷收敛）：
 * - 同一草案的重试复用相同请求 ID（后端据此返回既有项目，不重复创建）；
 * - 请求成功后清理请求 ID（下次创建是新的语义，必须用新 ID）；
 * - 请求参数变化时生成新的请求 ID（参数变了就不是同一个请求）；
 * - 幂等性由后端摘要校验兜底，按钮禁用只是交互提示，不作为唯一防重手段。
 */

/** 当前请求 ID 状态：ID + 产生它的参数签名。 */
export interface RequestIdState {
  id: string;
  signature: string;
}

/** 空状态：还没有任何请求 ID。 */
export function emptyRequestIdState(): RequestIdState {
  return { id: "", signature: "" };
}

/**
 * 生成请求 ID：优先用 `crypto.randomUUID`；
 * 运行环境缺少该 API 时退回时间戳 + 随机串（仍保证同一进程内不重复）。
 */
export function createRequestId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") {
    return cryptoRef.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 取本次提交使用的请求 ID：
 * - 参数签名不变 → 复用旧 ID（重试幂等）；
 * - 参数签名变化 → 生成新 ID（不同的请求）。
 */
export function resolveRequestId(
  state: RequestIdState,
  signature: string,
  generate: () => string,
): { state: RequestIdState; id: string } {
  if (state.id && state.signature === signature) {
    return { state, id: state.id };
  }
  const next: RequestIdState = { id: generate(), signature };
  return { state: next, id: next.id };
}

/** 创建成功：清理请求 ID。 */
export function clearRequestIdState(): RequestIdState {
  return emptyRequestIdState();
}

/**
 * 参数签名：只包含真正影响写入结果的字段，排除 `clientRequestId` 自身。
 * 同一份草案无论重试多少次都得到同一签名。
 */
export function requestSignature(payload: Record<string, unknown>): string {
  const { clientRequestId: _ignored, ...rest } = payload;
  return JSON.stringify(rest, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = record[key];
          return acc;
        }, {});
    }
    return value;
  });
}
