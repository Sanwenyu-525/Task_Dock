//! 工作篮抽屉：主窗口与窄/未固定工作台共用。
//!
//! 是否渲染只由「面板形态」决定：固定列形态下这里返回 null，保证一个窗口同一时间
//! 只有一个工作篮面板实例（`TransferPanel` 内部还有第二道单实例守卫）。

import { useEffect } from "react";
import { useTransferStore } from "../../store/useTransferStore";
import TransferPanel from "./TransferPanel";

interface TransferDrawerProps {
  /** 宿主：主窗口永远抽屉；工作台由容器宽度 + 固定状态决定。 */
  host?: "main" | "workbench";
}

export default function TransferDrawer({ host = "main" }: TransferDrawerProps) {
  const visible = useTransferStore((s) => s.panel.visible);
  const mode = useTransferStore((s) => s.panelMode);

  useEffect(() => {
    // 主窗口没有工作台内容容器，形态固定为抽屉，不允许残留 dock 状态。
    if (host === "main") useTransferStore.getState().setPanelMode("drawer");
  }, [host]);

  if (!visible) return null;
  if (host === "main" ? false : mode === "dock") return null;
  return (
    <TransferPanel
      variant="drawer"
      host={host}
      onClose={() => useTransferStore.getState().closePanel()}
    />
  );
}
