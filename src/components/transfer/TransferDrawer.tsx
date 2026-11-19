//! 工作篮抽屉：主窗口与窄工作台共用。仅负责「是否打开」与关闭动作。

import { useTransferStore } from "../../store/useTransferStore";
import TransferPanel from "./TransferPanel";

export default function TransferDrawer() {
  const visible = useTransferStore((s) => s.panel.visible);
  if (!visible) return null;
  return (
    <TransferPanel
      variant="drawer"
      onClose={() => useTransferStore.getState().closePanel()}
    />
  );
}
