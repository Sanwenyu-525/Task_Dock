//! 完整模式的「暂存架」页面：左侧导航入口外壳。
//! 业务全部在 ShelfWorkspace；本组件只负责挂载与激活语义（对齐 ClipboardPanel）。

import { useUiStore } from "../../store/useUiStore";
import ShelfWorkspace from "./ShelfWorkspace";

export default function ShelfPanel() {
  const tab = useUiStore((s) => s.tab);
  return <ShelfWorkspace active={tab === "shelf"} />;
}
