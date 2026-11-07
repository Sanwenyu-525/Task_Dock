//! 「复制并切换 / 粘贴到目标窗口」目标行：完整面板与胶囊共用的唯一展示实现。
//!
//! 只负责展示与点击回调；目标枚举、身份校验、复制/聚焦顺序、粘贴任务与竞态
//! 全部由 `lib/clipboardCopySwitch.ts` / `hooks/useClipboardCopySwitch.ts` 决定，
//! 两个界面不得各自实现一套窗口选择或按键逻辑。
//!
//! 交互契约（两个变体一致）：
//! - 两个动作都是**真实按钮**：切换并复制（↗）、切换到该窗口并粘贴；
//! - 点击窗口信息区域与点击 ↗ 执行**同一个**复制切换操作，一次点击只触发一次；
//! - 没有单选/多选语义：这里不是「先选中再确认」，点下即执行；
//! - 任一动作在途时整行禁用，进行中的按钮显示 spinner，另一个动作不会并发触发。
//!
//! 视觉复用既有类：
//! - full：`.clip-target-row` / `.clip-target` / `.icon-btn.sm`（与逐项粘贴的目标列表同视觉）；
//! - compact：`.cap-item` / `.cap-tile` / `.cap-main` / `.cap-mini`（与胶囊列表同视觉）。

import { ArrowUpRight, ClipboardPaste, Loader2 } from "lucide-react";
import type { PasteTarget } from "../../lib/bridge";
import { fileBaseName } from "../../lib/clipboardUi";
import TargetIcon from "../clipboard/TargetIcon";

export interface CopySwitchTargetRowProps {
  target: PasteTarget;
  variant: "full" | "compact";
  /** 本行正在执行的动作：复制切换或粘贴 */
  busy?: "copy" | "paste" | null;
  /** 其他行执行中：本行暂不可点 */
  disabled?: boolean;
  /** 复制并切换到该窗口（只写剪贴板 + 激活，不发送按键） */
  onSelect: () => void;
  /** 切换到该窗口并粘贴（后端单条粘贴任务，发送一次 Ctrl+V） */
  onPaste: () => void;
}

export default function CopySwitchTargetRow({
  target,
  variant,
  busy = null,
  disabled = false,
  onSelect,
  onPaste,
}: CopySwitchTargetRowProps) {
  const title = target.title || "（无标题窗口）";
  const meta = `${fileBaseName(target.exe_path)} · PID ${target.pid}`;
  const blocked = disabled || busy !== null;

  if (variant === "compact") {
    // 结构与既有列表行一致（div 卡片 + `.cap-main.cap-row-open` 按钮 + `.cap-mini`）。
    // 右侧两个按钮都绑定独立动作：↗ 复制并切换，粘贴图标切换到该窗口并粘贴。
    return (
      <div
        className="cap-item cap-copy-target"
        aria-busy={busy !== null || undefined}
        data-target-hwnd={target.hwnd}
      >
        <span className="cap-tile" aria-hidden="true">
          <TargetIcon hwnd={target.hwnd} pid={target.pid} exePath={target.exe_path} size={20} />
        </span>
        <button
          type="button"
          className="cap-main cap-row-open"
          aria-label={`复制并切换到「${title}」`}
          aria-busy={busy === "copy" || undefined}
          disabled={blocked}
          onClick={onSelect}
          data-tip={`复制并切换到「${title}」`}
        >
          <span className="cap-item-title" data-tip={title}>
            {title}
          </span>
          <span className="cap-item-sub">{meta}</span>
        </button>
        <button
          type="button"
          className="cap-mini is-icon"
          aria-label="复制并切换到该窗口"
          data-tip="复制并切换到该窗口"
          disabled={blocked}
          onClick={onSelect}
        >
          {busy === "copy" ? (
            <Loader2 size={13} className="spin" aria-hidden="true" />
          ) : (
            <ArrowUpRight size={13} strokeWidth={2} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="cap-mini is-icon"
          aria-label="切换到该窗口并粘贴"
          data-tip="切换到该窗口并粘贴"
          disabled={blocked}
          onClick={onPaste}
        >
          {busy === "paste" ? (
            <Loader2 size={13} className="spin" aria-hidden="true" />
          ) : (
            <ClipboardPaste size={13} strokeWidth={2} aria-hidden="true" />
          )}
        </button>
      </div>
    );
  }

  // full：信息区 + ↗ 仍是同一个复制切换按钮（点信息区或箭头命中同一按钮，
  // 一次点击只触发一次）；粘贴是行内第二个独立按钮，不与主按钮嵌套。
  return (
    <div className="clip-target-row" data-target-hwnd={target.hwnd}>
      <button
        type="button"
        className="clip-target"
        aria-label={`复制并切换到「${title}」`}
        aria-busy={busy === "copy" || undefined}
        disabled={blocked}
        onClick={onSelect}
        data-tip={disabled ? undefined : `复制并切换到「${title}」`}
      >
        <TargetIcon hwnd={target.hwnd} pid={target.pid} exePath={target.exe_path} />
        <span className="clip-target-text">
          <span className="clip-target-title">{title}</span>
          <span className="clip-target-meta">{meta}</span>
        </span>
        {/* 状态/复制切换图示：全部在按钮内部，纯展示，不单独接收事件。 */}
        <span className="clip-target-state" aria-hidden="true">
          {busy === "copy" ? (
            <Loader2 size={12} className="spin" />
          ) : (
            <ArrowUpRight size={13} strokeWidth={2.2} />
          )}
        </span>
      </button>
      <button
        type="button"
        className="icon-btn sm clip-target-paste"
        aria-label={`切换到「${title}」并粘贴`}
        aria-busy={busy === "paste" || undefined}
        data-tip="切换到该窗口并粘贴"
        disabled={blocked}
        onClick={onPaste}
      >
        {busy === "paste" ? (
          <Loader2 size={12} className="spin" aria-hidden="true" />
        ) : (
          <ClipboardPaste size={12} aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
