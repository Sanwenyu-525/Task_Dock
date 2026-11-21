//! 从操作记录定位资源：复用既有导航通道，不重新实现跳转。
//!
//! 只有真实资源 ID 才定位；已删除/不支持的类型返回 false 并给出明确反馈，
//! 绝不「看起来跳过去了」。

import type { AgentOperation } from "../../../lib/bridge";
import { useGlobalSearchStore } from "../../../store/useGlobalSearchStore";
import { useUiStore } from "../../../store/useUiStore";

export function canLocateOperation(op: AgentOperation): boolean {
  if (!op.resourceId) return false;
  if (op.resourceKind === "task" || op.resourceKind === "note") return true;
  if (op.resourceKind === "feature") return Boolean(op.projectId);
  return false;
}

/**
 * 返回是否真的发起了定位。
 * `setTab` 可能因未保存编辑被门禁拦下，此时不投递定位意图。
 */
export function locateAgentOperationResource(op: AgentOperation): boolean {
  const ui = useUiStore.getState();
  const search = useGlobalSearchStore.getState();
  const switchTo = (tab: Parameters<typeof ui.setTab>[0]) => {
    const result = ui.setTab(tab);
    if (result !== "switched") {
      ui.showToast("请先处理当前未保存的编辑，再定位资源", { kind: "warning" });
      return false;
    }
    return true;
  };

  switch (op.resourceKind) {
    case "task": {
      if (!op.resourceId) return false;
      if (!switchTo("tasks")) return false;
      search.requestLocate({
        category: "tasks",
        id: op.resourceId,
        kind: "task",
        parentId: null,
        keyword: "",
      });
      return true;
    }
    case "note": {
      if (!op.resourceId) return false;
      if (!switchTo("inbox")) return false;
      ui.setCollectionSub("notes");
      search.requestLocate({
        category: "notes",
        id: op.resourceId,
        kind: "note",
        parentId: null,
        keyword: "",
      });
      return true;
    }
    case "feature": {
      if (!op.resourceId || !op.projectId) return false;
      if (!switchTo("roadmap")) return false;
      ui.requestRoadmapFocus({ projectId: op.projectId, featureId: op.resourceId });
      return true;
    }
    default:
      return false;
  }
}
