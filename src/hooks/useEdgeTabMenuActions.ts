//! 极简标签右键菜单的动作桥（主窗侧）。
//!
//! 菜单窗口只发命令：后端 `context_menu_action` 把 `tab:expand|full|undock`
//! 转发成一次 `edge-tab-action` 事件到主窗，这里把它交给**唯一的**吸附状态机
//! （`useEdgeSnap` 注入到 store 的恢复/形态切换/解除事务），事务结束后再把
//! **真实结果**回传给后端（`tab_menu_action_result`）。
//!
//! 2026-11-14 形态收敛：同一通道现在还承载托盘/悬浮栏菜单的 `workbench`
//! 动作（打开完整工作台）。本桥因此挂载在 `App`（主窗常驻），不再挂在
//! `CapsuleDock`——托盘动作触发时主窗可能处于任意形态，标签菜单与托盘菜单
//! 共用一条通道与一套去重回执；`workbench` 分支与吸附状态机无关，不抢占互斥区。
//!
//! 为什么需要结果回执：事件 emit 成功只代表主窗收到了请求，不代表窗口真的
//! 进入了目标状态。菜单必须等主窗事务结果才能决定「隐藏（成功）」还是
//! 「保留并显示失败原因」——不能用「请求已发出」冒充「操作已完成」。
//!
//! 请求关联用单调 id：后端等待对应结果，超时/主窗未响应由后端给出明确失败，
//! 迟到的重复事件按 id 去重，不会把同一个动作执行两遍。
//!
//! 生命周期：随组件挂载/卸载成对订阅，不产生悬空监听；**在途回执不受卸载
//! 影响**——undock/full 成功本身会切走本桥所在的胶囊视图，回执必须照常送达。

import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import { invokeCommand } from "../lib/errors";
import { logEvent } from "../lib/diagnostics";
import { useEdgeSnapStore } from "../store/useEdgeSnapStore";
import { openWorkbenchHome } from "../lib/workbenchNav";

/** 与 Rust `context_menu::TAB_ACTION_EVENT` 的转发事件名一致。 */
export const TAB_MENU_ACTION_EVENT = "edge-tab-action";
/** 主窗 → 后端：`{ id, ok, error? }`，必须是本次事务的真实结果。 */
export const TAB_MENU_RESULT_COMMAND = "tab_menu_action_result";

export interface TabMenuActionResult {
  ok: boolean;
  /** 失败时给用户看的可恢复提示（菜单行内反馈直接展示）。 */
  error?: string;
}

/** 后端下发的请求载荷：`id` 用于把结果对回等待中的菜单命令。 */
interface TabActionRequest {
  id?: number;
  action?: string;
}

const OK: TabMenuActionResult = { ok: true };

function unavailable(): TabMenuActionResult {
  return { ok: false, error: "窗口引擎未就绪，操作未执行" };
}

/**
 * 执行一条标签菜单动作；**只有事务真正提交成功才返回 ok**。
 *
 * - 引擎入口不存在（未启用吸附/主窗未挂载）→ 失败；
 * - 引擎忙 / 恢复未完成 / 形态回滚 → 失败并给出可重试的原因；
 * - 解除吸附返回的是「区域 + 相位已解除」，窗口尺寸恢复仍按既有设计在后台
 *   继续（不占用互斥区），不会把「已解除」误报成「未执行」。
 */
export async function runTabMenuAction(action: string): Promise<TabMenuActionResult> {
  const s = useEdgeSnapStore.getState();
  try {
    switch (action) {
      case "expand": {
        if (!s.restoreTab) return unavailable();
        // 与单击同一条事务：恢复轨道 → 展开最近使用的面板
        const ok = await s.restoreTab({ reveal: true });
        return ok
          ? OK
          : { ok: false, error: "展开失败：窗口正在切换或恢复未完成，请稍后重试" };
      }
      case "full": {
        if (!s.formSwitch) return unavailable();
        // 本次停靠会话的临时形态切换，不写持久化的默认吸附方式
        const ok = await s.formSwitch("full");
        return ok
          ? OK
          : { ok: false, error: "切换到完整面板失败，已保持原形态，请重试" };
      }
      case "undock": {
        if (!s.undock) return unavailable();
        const ok = await s.undock();
        return ok
          ? OK
          : { ok: false, error: "退出吸附失败，窗口保持吸附状态，请重试" };
      }
      case "workbench": {
        // 打开完整工作台（托盘/悬浮栏菜单共用本通道）。初始回执上限 7 秒，
        // 略小于后端 8 秒转发超时：先给出可读失败原因，不让通道超时抢答。
        // pending（工作台有草稿确认条）= 窗口已就绪，按成功回执。
        const outcome = await openWorkbenchHome({ timeoutMs: 7000 });
        return outcome.status === "failed"
          ? { ok: false, error: outcome.error ?? "打开完整工作台失败，请重试" }
          : OK;
      }
      default:
        return { ok: false, error: "未知的菜单动作" };
    }
  } catch {
    return { ok: false, error: "窗口操作异常，请重试" };
  }
}

/**
 * 解析事件载荷。
 *
 * 新后端发送 `{ id, action }`；兼容旧版纯字符串载荷（可执行但无结果回执，
 * `id=0`）。对象载荷缺 id / action 视为非法，不执行——无法回执的请求会让
 * 后端一直等到超时，不如直接丢弃。
 */
function parseTabAction(payload: unknown): { id: number; action: string } | null {
  if (typeof payload === "string") {
    return payload ? { id: 0, action: payload } : null;
  }
  if (!payload || typeof payload !== "object") return null;
  const { id, action } = payload as TabActionRequest;
  if (typeof action !== "string" || !action) return null;
  if (typeof id !== "number" || !Number.isFinite(id) || id <= 0) return null;
  return { id, action };
}

export function useEdgeTabMenuActions(): void {
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: UnlistenFn | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // 单调请求 id：重复投递/迟到事件只执行一次（后端每次请求都是新 id）。
    let lastId = 0;
    const onEvent = (event: { payload: unknown }) => {
      const req = parseTabAction(event.payload);
      if (!req) return;
      if (req.id !== 0 && req.id <= lastId) return;
      if (req.id !== 0) lastId = req.id;

      void (async () => {
        const result = await runTabMenuAction(req.action);
        // 旧载荷没有 id，无法（也不需要）回执。
        // **卸载不得吞回执**：undock/full 成功本身就把相位切到 free/docked-full，
        // App 会据此卸载 CapsuleDock（本桥所在组件），恰好发生在回执之前——若这里
        // 因 disposed 丢弃回执，后端只能等满 8s 超时并按失败上报，菜单在已成功
        // 切换的窗口上停留不消失（用户视角是「菜单卡住」）。回执只用捕获的请求
        // id 与无状态 IPC，不依赖组件挂载，在途事务必须送达。
        if (req.id === 0) return;
        try {
          await invokeCommand(TAB_MENU_RESULT_COMMAND, {
            id: req.id,
            ok: result.ok,
            error: result.error ?? null,
          });
        } catch {
          // 回执失败：后端按超时返回明确失败，不会静默当作成功。
        }
      })();
    };
    /**
     * 订阅（每次尝试有超时 + 有界重试）：应用启动极早期的事件 IPC 可能
     * **永久挂起**（invoke 丢失，既不 resolve 也不 reject——2026-11-14 原生
     * 验收实测命中：托盘「打开完整工作台」动作链路整段无应答），单纯依赖
     * catch 重试不够。每次 listen 给 2s 超时，超时按失败处理并退避重试
     * （共 ≤5 次）；迟到兑现的旧订阅立即释放，不留重复监听器。持续失败
     * 写诊断并保持失效——绝不静默假装已订阅。
     */
    const SUBSCRIBE_TIMEOUT_MS = 2_000;
    const handleSubscribeFailure = (attempt: number): void => {
      if (disposed) return;
      if (attempt < 4) {
        retryTimer = setTimeout(() => subscribe(attempt + 1), 400 * (attempt + 1));
        return;
      }
      logEvent({
        level: "WARN",
        module: "edge-tab-menu",
        action: "subscribe",
        event: "subscribe-failed",
        message: "edge-tab-action 订阅持续失败，托盘/标签菜单动作不可用（可重启应用恢复）",
      });
    };
    const subscribe = (attempt: number): void => {
      if (disposed) return;
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        handleSubscribeFailure(attempt);
      }, SUBSCRIBE_TIMEOUT_MS);
      listen<TabActionRequest | string>(TAB_MENU_ACTION_EVENT, onEvent)
        .then((fn) => {
          clearTimeout(timeout);
          if (settled) {
            // 旧尝试在判失败并重试之后才迟到兑现：立即释放，避免重复监听。
            fn();
            return;
          }
          settled = true;
          // 订阅兑现前已卸载：立即释放，避免监听器泄漏
          if (disposed) {
            fn();
            return;
          }
          unlisten = fn;
        })
        .catch(() => {
          clearTimeout(timeout);
          if (settled) return;
          settled = true;
          handleSubscribeFailure(attempt);
        });
    };
    subscribe(0);
    return () => {
      disposed = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      unlisten?.();
      unlisten = null;
    };
  }, []);
}
