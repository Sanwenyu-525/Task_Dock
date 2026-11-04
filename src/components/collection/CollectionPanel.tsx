//! 「收集与暂存」合并入口容器（v0.8）。
//!
//! 页面顶部为页面标题 + 双子页签（快速收集 | 文件暂存），下方直接渲染对应子页：
//! - 快速收集 = CaptureInboxPanel（收集箱，未处理/全部、转任务、标记、删除）；
//! - 文件暂存 = ShelfPanel（暂存架，添加/拖入/分组/批量/清理）。
//!
//! 边界：
//! - 只做视觉与交互整合：两套 Store（useCaptureStore / useShelfStore）与后端存储
//!   完全不动，不新增任何全局缓存或第二套列表；
//! - 同一时刻只挂载一个子页（切换即卸载），Store 状态天然保留，不重复拉取全量；
//! - 子页身份 = 既有 Tab id（inbox / shelf），setTab(inbox|shelf) 会同步子页状态，
//!   Ctrl+5 / Ctrl+6 与旧调用方语义不变。

import { useUiStore } from "../../store/useUiStore";
import CaptureInboxPanel from "../inbox/CaptureInboxPanel";
import ShelfPanel from "../shelf/ShelfPanel";

export default function CollectionPanel() {
  const sub = useUiStore((s) => s.collectionSub);
  const setTab = useUiStore((s) => s.setTab);

  return (
    <div className="collection-panel">
      <div className="collection-head">
        <span className="collection-title">收集与暂存</span>
        <div className="seg-group" role="tablist" aria-label="收集与暂存子页">
          <button
            type="button"
            role="tab"
            aria-selected={sub === "inbox"}
            className={`seg-btn ${sub === "inbox" ? "active" : ""}`}
            onClick={() => setTab("inbox")}
          >
            快速收集
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sub === "shelf"}
            className={`seg-btn ${sub === "shelf" ? "active" : ""}`}
            onClick={() => setTab("shelf")}
          >
            文件暂存
          </button>
        </div>
      </div>
      <div className="collection-body">
        {sub === "inbox" ? <CaptureInboxPanel /> : <ShelfPanel />}
      </div>
    </div>
  );
}
