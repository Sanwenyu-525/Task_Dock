/** 安全失败关闭（fail-closed）统一异常：所有拒绝路径抛出此类型，由路由层映射为错误码。 */
export class SecurityError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'SecurityError';
  }
}
