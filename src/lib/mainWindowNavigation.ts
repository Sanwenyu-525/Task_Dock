//! 主窗口跨窗口导航（P0-02 / P0-A，2026-11-13）：把「在开发工作台打开」真正落地。
//!
//! ## 历史缺陷
//! 专业窗口只发一个事件，主窗口收到后直接 `setTab("workbench")`。如果主窗口仍停在
//! 贴边胶囊（Win32 `SetWindowRgn` 只露出轨道），完整视图处于隐藏状态——标签切了，
//! 用户什么也看不到；命令却已经把「已发送」当成成功返回。
//!
//! 后来又出现两个更隐蔽的问题：
//! 1. Rust 命令在**发出事件之前**就写了 `workbench_current_project`；主窗口不存在、
//!    用户取消、导航失败时，开发项目上下文已经被换掉；
//! 2. 被未保存草稿拦截时只回一条 `pending`，用户确认/取消后没有最终回执，专业窗口
//!    只能一直等或超时。
//!
//! ## 本模块的完整事务
//! 1. 唤醒主窗口（show / unminimize，失败不阻断但记录）；
//! 2. **走既有吸附状态机**退出胶囊/Edge Tab（`undock("full")`），不碰窗口尺寸/区域；
//! 3. 自由窗口若不是完整模式（compact/minimal），用既有 `applyMode("full")` 切回；
//! 4. 预检导航门禁：保存中直接失败（不改上下文）；有未保存草稿则挂起等用户选择；
//! 5. 提交开发项目上下文（`workbench_current_project`）——**只在这里提交**；
//! 6. 走既有导航门禁 `setTab("workbench")`，不 force；
//! 7. 校验最终标签确实是 workbench，聚焦窗口；
//! 8. 返回真实结果：`succeeded` / `pending` / `cancelled` / `failed`。
//!
//! 任何失败都会把上下文回滚到旧值；`pending` 的最终态由用户确认/取消后通过
//! `hooks.onSettled` 再回传一次。
//!
//! ## 并发
//! 事务串行执行（`navChain`）。新的请求会取代仍停在 pending 的旧事务（旧事务按
//! `cancelled` 收敛），不会被旧的回执覆盖，也不会出现两个事务同时写上下文。

import { getCurrentWindow } from "@tauri-apps/api/window";

import { applyMode } from "./bridge";
import { logEvent } from "./diagnostics";
import { isDockedPhase } from "./edgeSnap";
import { errorMessage } from "./errors";
import { activeTabGuard } from "./tabGuard";
import { resolveWindowMode } from "./windowMode";
import { useEdgeSnapStore } from "../store/useEdgeSnapStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { useUiStore } from "../store/useUiStore";

export type MainWindowNavigationStatus = "succeeded" | "pending" | "cancelled" | "failed";

export interface MainWindowNavigationOutcome {
  /** 已切到开发工作台、窗口可见且开发项目上下文已提交（pending 时 false）。 */
  ok: boolean;
  /** 被未保存草稿拦截，等待用户在主窗口确认（不是失败，也还不是成功）。 */
  pending: boolean;
  status: MainWindowNavigationStatus;
  /** 非 succeeded / pending 时的可读原因。 */
  error: string | null;
  /** 已执行的步骤（诊断/测试用）。 */
  steps: string[];
}

export interface MainWindowNavigationRequest {
  /** 专业窗口在发命令之前生成的请求编号（回执可能先于命令响应到达）。 */
  requestId: number;
  /** 要打开的开发项目（不是工作空间项目 ID）。 */
  devProjectId: string;
}

export interface MainWindowNavigationHooks {
  /** `pending` 之后用户确认/取消时回传最终结果（只调用一次）。 */
  onSettled?: (outcome: MainWindowNavigationOutcome) => void;
}

const SETTING_KEY = "workbench_current_project";

function makeOutcome(
  status: MainWindowNavigationStatus,
  error: string | null,
  steps: string[],
): MainWindowNavigationOutcome {
  return {
    ok: status === "succeeded",
    pending: status === "pending",
    status,
    error,
    steps,
  };
}

interface ParkedTx {
  requestId: number;
  resolver: (result: "confirmed" | "cancelled") => void;
  /** 把仍属于本次事务的待确认导航收掉（新请求取代时使用）。 */
  cancel: (reason: string) => void;
}

/** 串行链：不同请求不能交错执行 undock / 提交上下文 / 切页。 */
let navChain: Promise<unknown> = Promise.resolve();
/** 仍停在 pending 的事务（同一时刻最多一个）。 */
let parked: ParkedTx | null = null;

/** 测试用：清空模块级队列与挂起状态。 */
export function __resetMainWindowNavigationForTests(): void {
  navChain = Promise.resolve();
  parked = null;
}

/**
 * 在主窗口内打开开发工作台。只应在主窗口（App 根组件）调用。
 */
export function openDevWorkbenchInMainWindow(
  req: MainWindowNavigationRequest,
  hooks: MainWindowNavigationHooks = {},
): Promise<MainWindowNavigationOutcome> {
  // 新请求取代仍停在 pending 的旧事务：旧事务按「已取消」收敛，
  // 避免用户在旧确认条上再点一次时把新请求的目标覆盖掉。
  if (parked) {
    const old = parked;
    parked = null;
    old.cancel("已被新的导航请求取代");
  }
  const task = () => runTransaction(req, hooks);
  const run = navChain.then(task, task);
  navChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function runTransaction(
  req: MainWindowNavigationRequest,
  hooks: MainWindowNavigationHooks,
): Promise<MainWindowNavigationOutcome> {
  const steps: string[] = [];
  /** pending 的最终结果只回调一次（重复确认/取消不重复回执）。 */
  let resolvedPending = false;
  let committed = false;

  const complete = (
    status: MainWindowNavigationStatus,
    error: string | null,
  ): MainWindowNavigationOutcome => makeOutcome(status, error, steps);

  const previousDevProject =
    useSettingsStore.getState().settings?.[SETTING_KEY] ?? "";

  const writeDevProject = async (value: string): Promise<string | null> => {
    try {
      await useSettingsStore.getState().update({ [SETTING_KEY]: value });
      return null;
    } catch (e) {
      return errorMessage(e);
    }
  };

  const rollbackDevProject = async (): Promise<void> => {
    if (!committed) return;
    committed = false;
    const err = await writeDevProject(previousDevProject);
    if (err) {
      logEvent({
        level: "WARN",
        module: "workspace-nav",
        action: "rollback-dev-project",
        event: "rollback-failed",
        message: err,
      });
      steps.push("rollback-failed");
    } else {
      steps.push("rollback");
    }
  };

  // 1) 唤醒窗口：胶囊/极简标签/最小化都可能让窗口不可见
  try {
    const win = getCurrentWindow();
    await win.unminimize();
    const visible = await win.isVisible().catch(() => true);
    if (!visible) await win.show();
    steps.push("window-awake");
  } catch (e) {
    // 唤醒失败不是致命：窗口可能已可见，后续 undock/setTab 仍能完成
    logEvent({
      level: "WARN",
      module: "workspace-nav",
      action: "wake-main-window",
      event: "wake-failed",
      message: errorMessage(e),
    });
    steps.push("window-awake-failed");
  }

  // 2) 退出胶囊 / Edge Tab：必须走既有状态机（区域 + 相位 + 几何恢复）
  const snap = useEdgeSnapStore.getState();
  if (isDockedPhase(snap.phase)) {
    const undock = snap.undock;
    if (!undock) {
      return complete(
        "failed",
        "窗口引擎未就绪，无法退出胶囊模式；请手动切换为完整窗口后重试",
      );
    }
    let ok = false;
    try {
      ok = await undock("full");
    } catch (e) {
      return complete("failed", `退出胶囊模式失败：${errorMessage(e)}`);
    }
    if (!ok) {
      return complete("failed", "退出胶囊模式失败（原生区域未恢复）；胶囊仍可用，请重试");
    }
    steps.push("undock");
  } else {
    steps.push("not-docked");
  }

  // 3) 已解除吸附但仍是紧凑/极简模式：完整页在该模式下不渲染，必须切回 full
  const settings = useSettingsStore.getState().settings;
  if (resolveWindowMode(settings?.mode) !== "full") {
    try {
      await applyMode("full");
      steps.push("mode-full");
    } catch (e) {
      return complete("failed", `切换为完整窗口失败：${errorMessage(e)}`);
    }
  }

  // 4) 预检门禁：保存中直接失败（此时还没写上下文）；草稿在下面进入 pending
  const guard = activeTabGuard();
  if (guard?.isBusy()) {
    return complete("failed", "主窗口正在保存，请稍后重试");
  }

  const previousTab = useUiStore.getState().tab;

  const focusMainWindow = async () => {
    try {
      const win = getCurrentWindow();
      await win.show();
      await win.setFocus();
      steps.push("focused");
    } catch (e) {
      logEvent({
        level: "WARN",
        module: "workspace-nav",
        action: "focus-main-window",
        event: "focus-failed",
        message: errorMessage(e),
      });
      steps.push("focus-failed");
    }
  };

  /** 校验标签 + 聚焦；succeeded/failed 由调用方决定是否作为最终态。 */
  const verifyAndFinish = async (): Promise<MainWindowNavigationOutcome> => {
    if (useUiStore.getState().tab !== "workbench") {
      await rollbackDevProject();
      return complete("failed", "页面切换未生效（当前标签不是开发工作台）");
    }
    await focusMainWindow();
    return complete("succeeded", null);
  };

  /** pending 的最终态：只回调一次（重复确认/取消不会重复回执）。 */
  const settlePending = (status: "succeeded" | "cancelled" | "failed", error: string | null) => {
    if (resolvedPending) return;
    resolvedPending = true;
    parked = null;
    hooks.onSettled?.(complete(status, error));
  };

  const onPendingResolved = (resolution: "confirmed" | "cancelled") => {
    if (resolvedPending) return;
    if (resolution === "cancelled") {
      steps.push("pending-cancelled");
      settlePending("cancelled", null);
      return;
    }
    steps.push("pending-confirmed");
    void (async () => {
      // confirmPendingTab 已经切到 workbench；此时才提交开发项目上下文。
      const writeErr = await writeDevProject(req.devProjectId);
      if (writeErr) {
        // 上下文没写成功：把标签退回原页，避免用户看着「开发工作台」却是旧项目。
        useUiStore.getState().setTab(previousTab, { force: true });
        steps.push("tab-restored");
        settlePending("failed", `写入开发项目上下文失败：${writeErr}`);
        return;
      }
      committed = true;
      const outcome = await verifyAndFinish();
      if (!outcome.ok) {
        // 标签校验失败：退回原页，避免「看着工作台却是旧上下文」。
        useUiStore.getState().setTab(previousTab, { force: true });
        steps.push("tab-restored");
        settlePending("failed", outcome.error);
        return;
      }
      settlePending("succeeded", null);
    })();
  };

  /** 挂起本次事务：不提交上下文，等用户在主窗口确认/取消。 */
  const park = (): MainWindowNavigationOutcome => {
    const tx: ParkedTx = {
      requestId: req.requestId,
      resolver: onPendingResolved,
      cancel: (reason: string) => {
        // 清掉仍属于本次事务的确认条（onResolve 会因 resolvedPending 标记不再重复回执）。
        const st = useUiStore.getState();
        if (st.pendingTab && st.pendingTab.onResolve === onPendingResolved) {
          st.cancelPendingTab();
        }
        if (!resolvedPending) {
          steps.push("pending-superseded");
          settlePending("cancelled", reason);
        }
      },
    };
    parked = tx;
    return complete("pending", null);
  };

  // 5) 已知有未保存草稿：**先不写上下文**，只登记待决导航。
  //    这样用户取消时数据库里没有任何「已切换」痕迹，不依赖回滚是否成功。
  if (guard?.isDirty()) {
    const result = useUiStore.getState().setTab("workbench", { onResolve: onPendingResolved });
    steps.push(`tab-${result}`);
    if (result === "blocked") {
      return complete("failed", "主窗口正在保存，请稍后重试");
    }
    if (result === "pending") return park();
    // 预检后草稿已被保存/丢弃且已切页：此时才提交上下文；提交失败要把标签退回，
    // 避免「页面是开发工作台、项目上下文仍是旧值」。
    const writeErr = await writeDevProject(req.devProjectId);
    if (writeErr) {
      useUiStore.getState().setTab(previousTab, { force: true });
      steps.push("tab-restored");
      return complete("failed", `写入开发项目上下文失败：${writeErr}`);
    }
    committed = true;
    steps.push("context-committed");
  } else {
    // 6) 提交上下文：**在导航事务里**，不是 Rust 命令里
    const writeErr = await writeDevProject(req.devProjectId);
    if (writeErr) {
      return complete("failed", `写入开发项目上下文失败：${writeErr}`);
    }
    committed = true;
    steps.push("context-committed");

    // 7) 导航门禁：不 force，草稿由用户确认（pending）
    const result = useUiStore.getState().setTab("workbench", { onResolve: onPendingResolved });
    steps.push(`tab-${result}`);
    if (result === "blocked") {
      await rollbackDevProject();
      return complete("failed", "主窗口正在保存，请稍后重试");
    }
    if (result === "pending") {
      // 预检后出现新草稿：回滚上下文，等用户确认后再重新提交。
      await rollbackDevProject();
      return park();
    }
  }

  // 8) 真实结果校验：store 的 tab 必须是 workbench，而不是「调用过 setTab」
  const outcome = await verifyAndFinish();
  if (outcome.ok) return complete("succeeded", null);
  return outcome;
}
