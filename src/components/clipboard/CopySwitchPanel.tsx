//! 「复制并切换 / 粘贴到目标窗口」完整面板。
//!
//! 只做展示与交互：目标枚举、precheck → copy → focus 顺序、单条粘贴任务、
//! 竞态治理与统计口径全部由 `hooks/useClipboardCopySwitch.ts` 持有
//! （与停靠胶囊共用同一套状态机），本面板不实现第二份窗口选择逻辑。
//!
//! 语义边界：
//! - 「复制并切换」只把条目写入系统剪贴板并激活目标窗口，**不发送 Ctrl+V**；
//! - 「粘贴」复用后端粘贴队列，切换到目标窗口后发送一次 Ctrl+V，并在结束后
//!   尝试恢复原剪贴板；是否被目标应用接收无法自动验证，提示里必须如实说明；
//! - 不自动选择第一个窗口。目标列表只在挂载时读取一次 + 手动刷新，无常驻轮询。
//! 视觉全部复用既有 `.clip-detail*` / `.clip-target-*` 类，不新增 CSS。

import { ArrowLeft, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import type { ClipboardItem } from "../../lib/bridge";
import { kindLabel, objectHint } from "../../lib/clipboardUi";
import { useClipboardCopySwitch } from "../../hooks/useClipboardCopySwitch";
import CopySwitchTargetRow from "./CopySwitchTargetRow";

export default function CopySwitchPanel({
  item,
  onBack,
}: {
  item: ClipboardItem;
  onBack: () => void;
}) {
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

  // hook 在「仅重试切换」期间不设置 activeHwnd：让原目标行继续显示处理中，
  // 其余目标照旧禁用，避免重试切换和新一次复制并发。
  const busyHwnd = busy ? activeHwnd : retrying ? (result?.precheckTarget?.hwnd ?? null) : null;
  const busyAction: "copy" | "paste" | null = busy
    ? phase === "pasting"
      ? "paste"
      : "copy"
    : retrying
      ? "copy"
      : null;
  // 重试切换沿用失败样式（phase 在此期间变成 retrying-focus，不能掉回普通提示色）
  const failed =
    phase === "copy-failed" ||
    phase === "focus-failed" ||
    phase === "retrying-focus" ||
    phase === "paste-failed";
  const busyAny = busy || retrying;

  return (
    <div className="clip-detail">
      <div className="clip-detail-head">
        <button className="icon-btn sm" onClick={onBack} data-tip="返回" aria-label="返回列表">
          <ArrowLeft size={13} />
        </button>
        <span>复制或粘贴到…</span>
      </div>

      <div className="clip-detail-body">
        <div className="clip-hint">
          选择目标后可「复制并切换」，或直接「粘贴」到该窗口。复制并切换只写入剪贴板并激活窗口；
          粘贴会发送一次 Ctrl+V，并在结束后尝试恢复原剪贴板。
        </div>
        <div className="clip-hint">
          将使用：{kindLabel(item.kind)}「{objectHint(item)}」
        </div>

        {itemMissing && (
          <div className="clip-warn" role="alert">
            <TriangleAlert size={12} />
            <span>该条目已不存在，可能已被删除；未复制任何内容。请返回列表刷新后再试。</span>
            <button className="btn sm" onClick={onBack}>
              返回并刷新
            </button>
          </div>
        )}

        <div className="clip-block-head">
          <span>目标窗口</span>
          <button
            className="btn sm"
            onClick={() => void refresh()}
            disabled={loadingTargets || busyAny}
          >
            <RefreshCw size={11} className={loadingTargets ? "spin" : undefined} /> 刷新
          </button>
        </div>

        {targetsError && (
          <div className="clip-warn" role="status">
            <TriangleAlert size={12} />
            <span>读取窗口列表失败：{targetsError}</span>
            <button className="btn sm" onClick={() => void refresh()} disabled={loadingTargets || busyAny}>
              重试
            </button>
          </div>
        )}

        {targets === null ? (
          targetsError ? null : <div className="clip-hint">正在读取可见窗口…</div>
        ) : targets.length === 0 ? (
          <div className="clip-hint">
            未发现其他可见窗口。请先打开目标应用，再点击刷新。本应用自身不能作为目标。
          </div>
        ) : (
          // 每行点下即执行，不是「先选中再确认」：主区域 = 复制并切换，
          // 行尾粘贴按钮 = 切换到该窗口并粘贴。
          <div className="clip-target-list" role="group" aria-label="复制或粘贴到目标窗口">
            {targets.map((t) => (
              <CopySwitchTargetRow
                key={t.hwnd}
                target={t}
                variant="full"
                busy={busyHwnd === t.hwnd ? busyAction : null}
                // 条目已不存在时禁止再次尝试（hook 内也有同步守卫）：避免重复失败
                disabled={busyAny || itemMissing}
                onSelect={() => void run(t)}
                onPaste={() => void runPaste(t)}
              />
            ))}
          </div>
        )}

        {phase === "pasting" && (
          <div className="clip-hint" role="status">
            <Loader2 size={12} className="spin" /> 正在切换到目标窗口并发送一次 Ctrl+V…
          </div>
        )}

        {feedback && !itemMissing && (
          <div
            className={failed || feedback.kind === "partial" ? "clip-warn" : "clip-hint"}
            role={failed ? "alert" : "status"}
          >
            {failed || feedback.kind === "partial" ? <TriangleAlert size={12} /> : null}
            <span>
              {feedback.title}
              {feedback.detail ? `。${feedback.detail}` : ""}
            </span>
            {feedback.kind === "focus-failed" && (
              <button className="btn sm" onClick={() => void retryFocus()} disabled={retrying || busy}>
                {retrying ? <RefreshCw size={11} className="spin" /> : <RefreshCw size={11} />} 仅重试切换
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
