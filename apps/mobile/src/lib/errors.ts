// 统一的错误文案：release 构建没有控制台，异常必须能显示到界面上。
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * 业务错误分类：
 * - validation：调用方参数不合法（如空标题、NaN 时间戳），重试没有意义；
 * - conflict：同步乐观锁冲突，需要上层展示「冲突待处理」；
 * - storage：本地 SQLite 读写失败；
 * - network：同步请求失败/超时/被取消，可按退避重试。
 *
 * 只保留四类的原因：上层只需要据此决定「提示、重试还是进冲突队列」，
 * 更细的错误码属于同步协议，不应该泄漏到 UI。
 */
export type AppErrorKind = "validation" | "conflict" | "storage" | "network";

export class AppError extends Error {
  readonly kind: AppErrorKind;

  constructor(kind: AppErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = "AppError";
    this.kind = kind;
    // 注意两点：
    // 1) 不能声明 `declare readonly cause`——Babel 的 TS 转换不认 declare 字段，Metro 打包会失败；
    // 2) 也不能写成裸字段声明——ESNext 下 class field 会在 super() 之后把 cause 覆盖成 undefined。
    // 所以这里直接赋值到 Error 自带的 cause 上。
    if (cause !== undefined) this.cause = cause;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * 把任意异常收敛成 AppError。
 *
 * 默认归为 storage：现有调用点绝大多数是 SQLite 仓储；网络层会显式传 "network"，
 * 不做基于错误文案的猜测分类（文案会随平台/版本变化，猜错会把可重试错误标成不可重试）。
 */
export function toAppError(error: unknown, fallbackKind: AppErrorKind = "storage"): AppError {
  if (isAppError(error)) return error;
  const message = describeError(error) || "未知错误";
  return new AppError(fallbackKind, message, error);
}
