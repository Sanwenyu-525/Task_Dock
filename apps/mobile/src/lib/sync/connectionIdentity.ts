// 连接身份判定：决定重新配对后是否需要重置增量游标。
//
// 背景（2026-11-13 真机实测）：手机保留旧连接 `sync.cursor.v1=44`，重新配对到
// 一个变更序号只到 3 的新桌面实例后，pull 以旧游标为起点判断「无新变更」，
// 新桌面端的早期变更被永久跳过。服务端变更序号空间按实例/库独立，换桌面实例
// （instanceId）、换地址（baseUrl）或换授权（deviceId）后旧游标不再有意义。
export interface ConnectionIdentity {
  baseUrl: string;
  instanceId: string;
  deviceId: string;
}

/** 首次配对或任一身份字段变化 → 返回 true（调用方应重置游标）。 */
export function connectionIdentityChanged(
  previous: ConnectionIdentity | null,
  next: ConnectionIdentity,
): boolean {
  if (!previous) return true;
  return (
    previous.baseUrl !== next.baseUrl ||
    previous.instanceId !== next.instanceId ||
    previous.deviceId !== next.deviceId
  );
}
