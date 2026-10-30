//! 完整模式的「剪贴板」页面：左侧导航第 4 个入口。
//!
//! 只做外壳，业务与抽屉共用 ClipboardWorkspace，保证只有一份数据加载与监听逻辑。

import { useUiStore } from "../../store/useUiStore";
import ClipboardWorkspace from "./ClipboardWorkspace";

export default function ClipboardPanel() {
  const tab = useUiStore((s) => s.tab);
  const clipboardOpen = useUiStore((s) => s.clipboardOpen);
  // 抽屉打开时让位：同一时刻只存在一个工作区实例，避免重复订阅剪贴板事件
  const active = tab === "clipboard" && !clipboardOpen;

  return <ClipboardWorkspace variant="page" active={active} />;
}
