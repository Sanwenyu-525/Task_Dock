//! 胶囊内的跨面板动作：快捷操作就地完成，完整功能直达唯一工作台。
//!
//! 三层形态收敛后的分流规则（2026-11-14）：
//! - **快捷操作**（查看任务、快速编辑、Agent 状态、剪贴板、收集/暂存）留在主窗
//!   快捷工具面板完成 → `openFullApp`（主窗这些页面仍是实时面板）；
//! - **完整功能**（应用管理、规划中心、工作流、诊断、开发工作台等）只存在于
//!   唯一大型工作台 → `openWorkbenchPage` 直达目标页，**禁止**再经
//!   「旧完整面板 → 摘要交接页 → 工作台」的二次跳转。
//!
//! 导航事务语义（openFullApp）：返回值表示本次主窗导航事务的结果
//! - switched：已切页并解除吸附，`after` 已执行；
//! - pending：被未保存草稿拦截，`after` 绑定在待确认导航上，确认后才执行；
//! - blocked：保存中等硬拒绝，未切页、不会执行 `after`。
//!
//! `after` 只允许放在导航成功之后执行（包括用户确认离开后的强制导航），
//! 不能先写一次性意图再导航：取消或拒绝时意图会滞留，之后突然弹层。

import { applyMode, type Task } from "../../lib/bridge";
import { openWorkbench, type WorkbenchNavOutcome } from "../../lib/workbenchNav";
import type { WorkbenchRoute } from "../../lib/workbenchLayout";
import { useEdgeSnapStore } from "../../store/useEdgeSnapStore";
import { useUiStore, type Tab, type TabSwitchResult } from "../../store/useUiStore";

/** 主窗快捷面板仍实时承载的页面；完整管理功能一律走 openWorkbenchPage。 */
const QUICK_PANEL_TABS = new Set<Tab>(["tasks", "agents", "actions", "clipboard", "inbox", "shelf"]);

/**
 * 打开主窗快捷工具面板并定位到指定标签（仅限 QUICK_PANEL_TABS）。
 * 解除吸附时把目标模式一起传给引擎，避免"先恢复旧模式再切新模式"的两次缩放。
 *
 * 历史遗留的完整功能调用方（如诊断中心的 `after` 定位意图）传入非快捷页时：
 * 运行时自动改道 `openWorkbenchPage` 直达工作台对应页——宁可降级为页面级落点，
 * 也不回到「摘要交接页 → 再点一次」的二次跳转；`after` 里的主窗意图随迁移
 * 失效（其旧消费者面板已不在主窗渲染），用 console.warn 提醒调用方迁移。
 * 返回值只区分 blocked（主窗硬拒绝提示）/ 其余；改道路径的失败通过 toast
 * 呈现真实原因（工作台导航事务自带失败上报），不在这里静默吞掉。
 */
export function openFullApp(tab: Tab, after?: () => void): TabSwitchResult {
  if (!QUICK_PANEL_TABS.has(tab)) {
    console.warn(
      `[capsule/actions] ${tab} 的完整界面已迁移到唯一工作台，openFullApp 自动改道 openWorkbenchPage（请迁移调用方）`,
    );
    void openWorkbenchPageWithToast(tab);
    return "switched";
  }
  return useUiStore.getState().setTab(tab, {
    after: () => {
      const undock = useEdgeSnapStore.getState().undock;
      if (undock) {
        const result = undock("full");
        // 真实引擎返回 Promise<boolean>：解除停靠完成后再执行 after，避免在
        // Win32 裁剪态里提前打开编辑器/选择器（会被裁掉或夺错焦点）。
        // 既有的同步桩/旧实现返回 void 时保持原同步语义。
        if (isThenable(result)) {
          void result
            .then((ok) => {
              if (ok) after?.();
            })
            .catch(() => {});
        } else {
          after?.();
        }
      } else {
        const result = applyMode("full");
        if (isThenable(result)) {
          void result.then(() => after?.()).catch(() => {});
        } else {
          after?.();
        }
      }
    },
  });
}

function isThenable(value: unknown): value is Promise<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * 打开完整工作台指定页面：**完整功能的唯一入口**（三层形态收敛）。
 *
 * 走 `workbenchNav.openWorkbench` 真实导航事务（唤醒/聚焦唯一 workspace 窗口、
 * 工作台草稿门禁、真实回执）；failed 时由调用方或 toast 呈现原因，不伪造成功。
 * `projectId` 仅工作台支持的项目路由使用；对象级（objectId）与功能级聚焦当前
 * 协议不支持，工作台会明确拒绝，不要在这里传。
 */
export function openWorkbenchPage(tab: WorkbenchRoute, projectId?: string | null): Promise<WorkbenchNavOutcome> {
  return openWorkbench({ tab, projectId: projectId ?? null });
}

/**
 * 直达工作台页面并把**真实失败原因** toast 出来：微件转发、openFullApp 改道等
 * fire-and-forget 场景共用，保证「请求失败」不静默（成功/pending 不打扰）。
 */
export function openWorkbenchPageWithToast(tab: WorkbenchRoute, projectId?: string | null): Promise<WorkbenchNavOutcome> {
  return openWorkbenchPage(tab, projectId).then((outcome) => {
    if (outcome.status === "failed") {
      useUiStore.getState().showToast(outcome.error ?? "打开完整工作台失败", { kind: "error" });
    }
    return outcome;
  });
}

/**
 * 打开完整窗口任务页并打开指定任务的编辑器：**一次导航事务**。
 *
 * 编辑意图放在 `after` 里，只随导航成功（含用户确认放弃草稿后的强制导航）
 * 执行一次；草稿待确认时由 `pendingTab` 携带，取消或保存中拦截时既不切页、
 * 也不打开编辑器，更不会留下「之后突然弹层」的残留意图。
 *
 * 禁止在调用方拆成 `openEditor(task)` + `openFullApp("tasks")` 两次导航：
 * 第二次 setTab 会覆盖 pendingTab.after（编辑意图丢失），保存中则两次都被拒绝。
 */
export function openTaskEditor(task?: Task): TabSwitchResult {
  return openFullApp("tasks", () => useUiStore.getState().openEditorNow(task ?? null));
}

/**
 * 打开「添加应用」：直达唯一工作台的应用管理页。
 *
 * 历史：旧路径向主窗 AppsPanel 下发一次性添加意图；Phase D 后主窗应用页已是
 * 「摘要 + 打开工作台」交接页，意图无处消费（悬空）。工作台导航协议当前不携带
 * 「自动打开添加弹层」意图，因此这里是页面级落点——添加入口在应用页内一眼可见，
 * 不再静默丢失一次性意图。跨窗意图携带待协议扩展后补（见验收报告 P2）。
 */
export function openAppsAdd(): Promise<WorkbenchNavOutcome> {
  return openWorkbenchPage("apps");
}

/** 打开唯一工作台的应用管理页（管理已有快捷应用）。 */
export function openAppsManager(): Promise<WorkbenchNavOutcome> {
  return openWorkbenchPage("apps");
}

/**
 * 打开唯一工作台的规划中心并提交项目级/功能级定位：**一次导航事务**。
 *
 * `featureId` 经跨窗协议 objectId 下发（形态收敛 P2 补全）：工作台外壳校验
 * 「roadmap 必须携带 projectId」后写入工作台窗口的一次性意图，由
 * PlanningWorkspace 消费 token 完成精确定位；目标项目/功能可能已被删除——
 * 由工作台按「尽力定位 + 明确反馈」兜底，不在导航前预改规划 store 状态。
 * 里程碑级聚焦协议暂不支持（objectId 单值无法区分两类对象），不在此传。
 */
export function openRoadmapFocus(target: {
  projectId: string;
  featureId?: string;
}): Promise<WorkbenchNavOutcome> {
  return openWorkbench({
    tab: "roadmap",
    projectId: target.projectId,
    objectId: target.featureId ?? null,
  });
}

/**
 * 打开唯一工作台的诊断中心并定位到指定操作链：objectId 经跨窗协议下发，
 * 由工作台窗口的 DiagnosticsCenterPanel 消费一次性意图（token 语义）。
 */
export function openDiagnosticsOperation(operationId: string): Promise<WorkbenchNavOutcome> {
  return openWorkbench({ tab: "diagnostics", objectId: operationId });
}
