//! 智能剪贴板抽屉：任务关联与紧凑模式下的临时面板。
//!
//! 业务内容已抽到 ClipboardWorkspace，这里只负责「是否打开」与关闭动作，
//! 因此完整模式的剪贴板页面与抽屉共享同一份加载、订阅与操作逻辑。

import { useUiStore } from "../../store/useUiStore";
import ClipboardWorkspace from "./ClipboardWorkspace";

export default function ClipboardDrawer() {
  const open = useUiStore((s) => s.clipboardOpen);
  const closeClipboard = useUiStore((s) => s.closeClipboard);

  if (!open) return null;

  return <ClipboardWorkspace variant="drawer" active onClose={closeClipboard} />;
}
