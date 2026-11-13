//! 面板功能一致性契约测试（2026-11-13 专项沉淀）。
//!
//! 目的：把「工具面板（胶囊）与完整面板共享同一业务事实源」从一次性修复变成
//! **可执行契约**——未来重构若把某个能力退回「各面板各写一套」，这里立即失败。
//!
//! 与行为测试的分工：
//! - 行为正确性由各组件测试覆盖（ShelfWorkspace.drop.test / AppsPanel.test /
//!   PlanningWorkspace.focus.test / ClipboardLite.test / CapsulePanels.test 等）；
//! - 本文件只锁**接线关系**：谁引用哪个共享模块/命令，谁不允许重复实现。
//!
//! 新增跨面板能力时：
//! 1. 在 `feature-matrix.md`（tmp/acceptance/panel-consistency-20261113/）登记两面板状态；
//! 2. 若两侧共享 store/bridge/算法，在此追加一条接线断言；
//! 3. 若刻意只在一侧实现，在此写清豁免理由（注释），避免被当作遗漏「修齐」。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/** 读源码原文：接线契约只关心符号引用，不执行组件。 */
function src(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const APPS_PANEL = src("../apps/AppsPanel.tsx");
const APPS_LITE = src("./AppsLite.tsx");
const APP_GRID_ORDER = src("../../lib/appGridOrder.ts");
const SHELF_WORKSPACE = src("../shelf/ShelfWorkspace.tsx");
const SHELF_DELIVER = src("../shelf/shelfDeliver.ts");
const INBOX_DROP_PANE = src("./InboxDropPane.tsx");
const DROP_TARGETS_STORE = src("../../store/useDropTargetsStore.ts");
const CLIPBOARD_LITE = src("./ClipboardLite.tsx");
const CLIPBOARD_STORE = src("../../store/useClipboardStore.ts");
const PLANNING_LITE = src("./PlanningLite.tsx");
const PLANNING_WORKSPACE = src("../roadmap/PlanningWorkspace.tsx");
const UI_STORE = src("../../store/useUiStore.ts");
const CAPSULE_ACTIONS = src("./actions.ts");

describe("契约：应用手动排序跨面板同源（P0-2）", () => {
  it("两个面板都从 lib/appGridOrder 读取手动顺序，不各自维护排序算法", () => {
    expect(APPS_LITE).toContain("lib/appGridOrder");
    expect(APPS_PANEL).toContain("lib/appGridOrder");
    // 手动顺序的持久化键只有 appGridOrder.ts 一处（localStorage 单事实源）
    expect(APP_GRID_ORDER).toContain("taskdock.apps.grid.order.v1");
    expect(APPS_LITE).not.toContain("taskdock.apps.grid.order.v1");
    expect(APPS_PANEL).not.toContain("taskdock.apps.grid.order.v1");
  });

  it("完整面板写入后走同一镜像通道（preferences 备份兼容）", () => {
    expect(APPS_PANEL).toContain("writeAppGridOrder");
    expect(APPS_PANEL).toContain("schedulePreferencesMirror");
  });

  it("收藏/隐藏等目标字段两面板共用 nav_update_target 命令", () => {
    // 命令签名唯一来源在 bridge；组件层只允许经 bridge 导出函数调用
    expect(APPS_PANEL).toContain("navUpdateTarget");
    expect(APPS_LITE).toContain("navUpdateTarget");
    expect(APPS_PANEL).not.toContain('invoke("nav_update_target"');
    expect(APPS_LITE).not.toContain('invoke("nav_update_target"');
  });
});

describe("契约：文件投递到目录与暂存分离（P0-1）", () => {
  it("投递引擎唯一：shelf_drop_to_directory 只允许出现在 store/bridge 层", () => {
    expect(DROP_TARGETS_STORE).toContain("shelfDropToDirectory");
    // 组件不得绕过 store 直接 invoke 投递命令（防第二套引擎）
    for (const component of [SHELF_WORKSPACE, SHELF_DELIVER, INBOX_DROP_PANE]) {
      expect(component).not.toContain('invoke("shelf_drop_to_directory"');
      expect(component).not.toContain("shelfDropToDirectory");
    }
    // 两侧真实投递都经共享 store
    expect(SHELF_DELIVER).toContain("useDropTargetsStore");
    expect(INBOX_DROP_PANE).toContain("useDropTargetsStore");
  });

  it("完整面板投递区按坐标命中目标卡片，未命中才走暂存（两动作互斥）", () => {
    expect(SHELF_WORKSPACE).toContain("dropTargetAt");
    expect(SHELF_WORKSPACE).toContain("addPaths");
    // 一次原生拖放的会话兜底（防同一次拖放被投递与暂存各消费一次）
    expect(SHELF_WORKSPACE).toMatch(/dropSession/);
  });

  it("投递结果条共用 store 报告（计数/逐项原因/重试/诊断）", () => {
    expect(SHELF_DELIVER).toContain("deliverToTarget");
    // 重试 = entries[].source 原路重投，不新建批量接口
    expect(SHELF_WORKSPACE + src("../shelf/DropTargetManager.tsx")).toMatch(/report|entries/);
  });
});

describe("契约：剪贴板分类查询由后端过滤（P1-1）", () => {
  it("lite 查询把 kind/search 交给 clipboard_view，不再先截断再本地过滤", () => {
    expect(CLIPBOARD_STORE).toMatch(/kind/);
    expect(CLIPBOARD_STORE).toContain("clipboardView");
    // 面板通过 loadLite 带筛选参数，不直接拿固定条数自己过滤
    expect(CLIPBOARD_LITE).toMatch(/loadLite\(/);
    expect(CLIPBOARD_LITE).not.toMatch(/clipboardView\(\{\s*limit:\s*20/);
  });

  it("暂停/恢复监听与完整面板同一业务命令（lifecycle setPaused），不本地伪造暂停", () => {
    expect(CLIPBOARD_LITE).toContain("setPaused");
    expect(CLIPBOARD_LITE).toContain('"clipboard"');
  });
});

describe("契约：规划中心精确定位双端接线（P1-2）", () => {
  it("工具面板经 openRoadmapFocus 下发一次性意图，完整面板消费同一意图", () => {
    expect(PLANNING_LITE).toContain("openRoadmapFocus");
    expect(CAPSULE_ACTIONS).toContain("requestRoadmapFocus");
    expect(UI_STORE).toContain("consumeRoadmapFocus");
    expect(PLANNING_WORKSPACE).toContain("consumeRoadmapFocus");
  });

  it("定位意图绑定导航事务（after），不在导航前预写状态", () => {
    // actions.ts 的 openRoadmapFocus 必须经 openFullApp 的 after 通道
    expect(CAPSULE_ACTIONS).toMatch(/openFullApp\("roadmap",\s*\(\)\s*=>/);
  });
});

describe("契约：单消费者与订阅纪律", () => {
  it("原生拖入统一经 lib/fileDrop 仲裁，组件不重复订阅 onDragDropEvent", () => {
    for (const component of [SHELF_WORKSPACE, INBOX_DROP_PANE]) {
      expect(component).toContain("registerFileDropConsumer");
      // 只禁「调用」：注释里说明「不用 onDragDropEvent 直接订阅」是允许的。
      expect(component).not.toMatch(/onDragDropEvent\s*\(/);
    }
  });

  it("剪贴板实时事件只有 store 内一处监听（引用计数），面板不自行 listen", () => {
    expect(CLIPBOARD_STORE).toContain("onClipboardChanged");
    expect(CLIPBOARD_LITE).not.toContain("onClipboardChanged");
  });
});
