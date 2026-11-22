//! 完整模式的「剪贴板」页面：左侧导航第 4 个入口。
//!
//! 只做外壳，业务与抽屉共用 ClipboardWorkspace，保证只有一份数据加载与监听逻辑。

import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { resolveWindowMode } from "../../lib/windowMode";
import ClipboardWorkspace from "./ClipboardWorkspace";

export default function ClipboardPanel() {
  const tab = useUiStore((s) => s.tab);
  const clipboardOpen = useUiStore((s) => s.clipboardOpen);
  // DeferredView 保活下，切到极简/紧凑模式时本页组件仍是挂载态（display:none）：
  // 只有完整模式可见时才算活跃，避免隐藏页面继续订阅实时刷新与列表加载。
  const mode = useSettingsStore((s) => resolveWindowMode(s.settings?.mode));
  // 抽屉打开时让位：同一时刻只存在一个工作区实例，避免重复订阅剪贴板事件
  const active = mode === "full" && tab === "clipboard" && !clipboardOpen;

  return <ClipboardWorkspace variant="page" active={active} />;
}
