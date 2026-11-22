//! 胶囊内「复制并切换 / 粘贴到目标窗口」二级视图。
//!
//! 只在 `.capsule-panel` 内容区替换列表：不新开弹窗 / Portal、不改面板尺寸与
//! Win32 裁剪区域；返回、Escape、焦点恢复沿用既有二级视图的 overlayStack 机制
//! （一次 Escape 只关当前视图，面板本身保留）。
//!
//! 语义边界与完整面板一致，业务顺序只在共享层实现：
//! - 目标枚举、precheck → copy → focus、单条粘贴任务、竞态与统计口径全部由
//!   `hooks/useClipboardCopySwitch.ts` / `lib/clipboardCopySwitch.ts` 决定；
//! - 本视图不自动选择第一个窗口，粘贴也不自己合成按键（复用后端粘贴队列）；
//! - 结果文案直接使用 hook 的 `feedback`，不在这里自造第二套口径；
//! - 目标列表只在挂载时枚举一次 + 手动刷新，无常驻监听与轮询；
//! - 组件卸载即丢弃在途结果（hook 的存活守卫），重新打开不会重放旧请求。

import { useEffect, useRef } from "react";
import { AppWindow, ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import type { ClipboardItem, PasteTarget } from "../../lib/bridge";
import { useDragRegion } from "../../lib/dragCursorSession";
import { useClipboardCopySwitch } from "../../hooks/useClipboardCopySwitch";
import { useClipboardStore } from "../../store/useClipboardStore";
import CopySwitchTargetRow from "../clipboard/CopySwitchTargetRow";
import { useFocusRestore, useOverlayLayer } from "../ui/overlay";
import { liteTitle } from "./ClipboardLiteViews";
import { EmptyState, PanelCloseButton } from "./PanelKit";

export default function ClipboardTargetView({
  item,
  active,
  onBack,
}: {
  item: ClipboardItem;
  active: boolean;
  onBack: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusRestore(active);
  useOverlayLayer("sublayer", active, onBack, rootRef);

  const {
    targets,
    targetsError,
    loadingTargets,
    busy,
    retrying,
    activeHwnd,
    result,
    feedback,
    itemMissing,
    phase,
    refresh,
    run,
    runPaste,
    retryFocus,
  } = useClipboardCopySwitch(item.id);

  const loadLite = useClipboardStore((s) => s.loadLite);
  /** 本次操作选择的目标与动作：仅用于失败后的「重试」，不参与窗口身份判定。 */
  const lastTarget = useRef<PasteTarget | null>(null);
  const lastAction = useRef<"copy" | "paste">("copy");
  const busyAny = busy || retrying;
  // hook 在「仅重试切换」期间不设置 activeHwnd：让原目标行继续显示处理中，
  // 其余目标照旧禁用，避免重试切换与新的复制并发。
  const busyHwnd = busy ? activeHwnd : retrying ? (result?.precheckTarget?.hwnd ?? null) : null;
  const busyAction: "copy" | "paste" | null = busy
    ? phase === "pasting"
      ? "paste"
      : "copy"
    : retrying
      ? "copy"
      : null;

  // 条目已被删除：只请求一次轻量列表刷新（不自动返回、不轮询）。
  // force 跳过每类缓存：这里要的是服务端最新结果，不是上次查询的复用。
  useEffect(() => {
    if (itemMissing) void loadLite(undefined, { force: true });
  }, [itemMissing, loadLite]);

  const select = (target: PasteTarget) => {
    lastTarget.current = target;
    lastAction.current = "copy";
    void run(target);
  };

  const pasteTo = (target: PasteTarget) => {
    lastTarget.current = target;
    lastAction.current = "paste";
    void runPaste(target);
  };

  const retryLast = () => {
    const target = lastTarget.current;
    if (!target) return;
    if (lastAction.current === "paste") pasteTo(target);
    else select(target);
  };

  const succeeded =
    feedback?.kind === "success" ||
    feedback?.kind === "partial" ||
    feedback?.kind === "paste-sent";
  const retryable =
    feedback?.kind === "copy-failed" || feedback?.kind === "paste-failed";

  // 标题区即窗口拖拽热区（二级页面与一级面板同一套命中规则，见 PanelKit.PanelHead）
  const headRef = useDragRegion<HTMLElement>();

  return (
    <div className="cap-clip-shell" ref={rootRef}>
      <header
        className="cap-head cap-clip-head ui-drag-surface ui-drag-session"
        ref={headRef}
        data-tauri-drag-region
      >
        <button
          type="button"
          className="cap-iconbtn cap-clip-back"
          aria-label="返回"
          data-tip-placement="bottom"
          onClick={onBack}
        >
          <ArrowLeft size={15} strokeWidth={2.2} aria-hidden="true" />
        </button>
        <div className="cap-head-text cap-clip-head-text" data-tauri-drag-region>
          <span className="cap-title cap-clip-title" title="复制或粘贴到…" data-tauri-drag-region>
            复制或粘贴到…
          </span>
          <span className="cap-sub" title={liteTitle(item)} data-tauri-drag-region>
            {liteTitle(item)}
          </span>
        </div>
        <div className="cap-actions">
          <button
            type="button"
            className="cap-iconbtn"
            aria-label="刷新目标窗口列表"
            disabled={loadingTargets || busyAny}
            onClick={() => void refresh()}
          >
            {loadingTargets ? (
              <Loader2 size={15} className="spin" aria-hidden="true" />
            ) : (
              <RefreshCw size={15} strokeWidth={2} aria-hidden="true" />
            )}
          </button>
          {/* 与一级面板同一个关闭入口：返回只退到列表，X 才收起整个工具面板 */}
          <PanelCloseButton label="关闭剪贴板面板" />
        </div>
      </header>

      <div className="cap-clip-body">
        <div className="cap-summary">
          <span>复制并切换只写入剪贴板并激活窗口；粘贴会发送一次 Ctrl+V 并尝试恢复原剪贴板。</span>
        </div>

        {/* 条目已不存在：不显示任何成功口径，也不提供会再次失败的窗口选择。 */}
        {itemMissing ? (
          <div className="cap-item cap-error-row" role="alert">
            <span className="cap-error-text">条目已不存在，正在刷新列表</span>
            <button type="button" className="cap-link" onClick={onBack}>
              返回列表
            </button>
          </div>
        ) : null}

        {!itemMissing && feedback ? (
          <div
            className={succeeded ? "cap-summary" : "cap-item cap-error-row"}
            role={succeeded ? "status" : "alert"}
          >
            <span
              className={succeeded ? undefined : "cap-error-text"}
              title={`${feedback.title}${feedback.detail ? `。${feedback.detail}` : ""}`}
            >
              {feedback.title}
              {feedback.detail ? `。${feedback.detail}` : ""}
            </span>
            {feedback.kind === "focus-failed" ? (
              <button
                type="button"
                className="cap-mini"
                disabled={retrying || busy}
                onClick={() => void retryFocus()}
              >
                {retrying ? "重试中…" : "仅重试切换"}
              </button>
            ) : null}
            {retryable ? (
              <button
                type="button"
                className="cap-mini"
                disabled={busyAny || lastTarget.current === null}
                onClick={retryLast}
              >
                重试
              </button>
            ) : null}
            {succeeded ? (
              <button type="button" className="cap-link" onClick={onBack}>
                返回列表
              </button>
            ) : null}
          </div>
        ) : null}

        {!itemMissing ? (
          targets === null ? (
            loadingTargets || !targetsError ? (
              <div className="cap-clip-state" role="status">
                <Loader2 size={16} className="spin" aria-hidden="true" />
                <span>正在读取可见窗口…</span>
              </div>
            ) : (
              <div className="cap-clip-state is-error" role="alert">
                <span>读取窗口列表失败：{targetsError}</span>
                <button type="button" className="cap-link" onClick={() => void refresh()}>
                  重试
                </button>
              </div>
            )
          ) : targets.length === 0 ? (
            <EmptyState
              icon={<AppWindow size={22} strokeWidth={1.6} aria-hidden="true" />}
              text="没有可切换的窗口，请先打开目标应用"
              actionLabel="刷新"
              onAction={() => void refresh()}
            />
          ) : (
            <>
              {targetsError ? (
                <div className="cap-item cap-error-row" role="alert">
                  <span className="cap-error-text" title={targetsError}>
                    刷新窗口列表失败：{targetsError}
                  </span>
                  <button
                    type="button"
                    className="cap-mini"
                    disabled={loadingTargets || busyAny}
                    onClick={() => void refresh()}
                  >
                    重试
                  </button>
                </div>
              ) : null}
              <div className="cap-clip-scroll">
                {targets.map((target) => (
                  <CopySwitchTargetRow
                    key={target.hwnd}
                    target={target}
                    variant="compact"
                    busy={busyHwnd === target.hwnd ? busyAction : null}
                    disabled={busyAny}
                    onSelect={() => select(target)}
                    onPaste={() => pasteTo(target)}
                  />
                ))}
              </div>
            </>
          )
        ) : null}
      </div>
    </div>
  );
}

