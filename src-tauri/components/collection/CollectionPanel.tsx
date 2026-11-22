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

import { Inbox } from "lucide-react";

import { useUiStore } from "../../store/useUiStore";
import CaptureInboxPanel from "../inbox/CaptureInboxPanel";
import ShelfPanel from "../shelf/ShelfPanel";
import NotesPanel from "../notes/NotesPanel";
import ModuleRunControl from "../lifecycle/ModuleRunControl";
import WorkbenchPageHeader from "../../workbench/WorkbenchPageHeader";
import CollectionRail from "./CollectionRail";
import { useLocale } from "../../hooks/useLocale";
import "./collection-page.css";

export default function CollectionPanel() {
  const { t } = useLocale();
  const sub = useUiStore((s) => s.collectionSub);
  const setTab = useUiStore((s) => s.setTab);
  const setCollectionSub = useUiStore((s) => s.setCollectionSub);

  return (
    <div className="collection-panel page-fill">
      <WorkbenchPageHeader
        icon={Inbox}
        title={t("collection.title")}
        subtitle={t("workbench.page.collection.subtitle")}
      />
      <div className="collection-head">
        {/* 标题已由页面级页头承载；这里只保留子页签与模块控制，避免重复标题。 */}
        <div className="seg-group" role="tablist" aria-label={t("collection.subTabs")}>
          <button
            type="button"
            role="tab"
            aria-selected={sub === "inbox"}
            className={`seg-btn ${sub === "inbox" ? "active" : ""}`}
            onClick={() => setTab("inbox")}
          >
            {t("collection.inbox")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sub === "shelf"}
            className={`seg-btn ${sub === "shelf" ? "active" : ""}`}
            onClick={() => setTab("shelf")}
          >
            {t("collection.shelf")}
          </button>
          {/* 笔记是第三个子页，不占用逻辑 Tab / Ctrl+数字，只切子页状态 */}
          <button
            type="button"
            role="tab"
            aria-selected={sub === "notes"}
            className={`seg-btn ${sub === "notes" ? "active" : ""}`}
            onClick={() => setCollectionSub("notes")}
          >
            {t("collection.notes")}
          </button>
        </div>
        {/* 暂存架子页：自动清理的暂停/恢复（手动清理与文件不受影响）。 */}
        {sub === "shelf" && (
          <>
            <span className="flex-spacer" />
            <ModuleRunControl moduleId="shelf_cleanup" />
          </>
        )}
      </div>
      <div className="collection-body">
        {sub === "shelf" ? (
          /* 文件暂存：主区（暂存架）+ 右侧信息栏。窄内容区由容器查询折叠为
             单列（信息栏落到列表下方），不挤压暂存架行宽。 */
          <div className="collection-split">
            <div className="collection-main">
              <ShelfPanel />
            </div>
            <CollectionRail />
          </div>
        ) : sub === "inbox" ? (
          <CaptureInboxPanel />
        ) : (
          <NotesPanel />
        )}
      </div>
    </div>
  );
}
