//! 「复制并切换」目标窗口行：完整面板与胶囊共用的唯一展示实现。
//!
//! 只负责展示与点击回调；目标枚举、身份校验、复制与切换顺序全部由
//! `lib/clipboardCopySwitch.ts` / `hooks/useClipboardCopySwitch.ts` 决定，
//! 两个界面不得各自实现一套窗口选择逻辑。
//!
//! 交互契约（两个变体一致）：
//! - 点击窗口信息区域与点击右侧箭头执行**同一个**操作，一次点击只触发一次；
//! - 箭头是真实可点击区域，不存在「只有外观没有事件」的图标；
//! - 没有单选/多选语义：这里不是「先选中再确认」，点下即复制并切换。
//!
//! 视觉复用既有类：
//! - full：`.clip-target-row` / `.clip-target`（与逐项粘贴的目标列表同视觉）；
//! - compact：`.cap-item` / `.cap-tile` / `.cap-main` / `.cap-mini`（与胶囊列表同视觉）。

import { ArrowUpRight, Loader2 } from "lucide-react";
import type { PasteTarget } from "../../lib/bridge";
import { fileBaseName } from "../../lib/clipboardUi";
import TargetIcon from "../clipboard/TargetIcon";

export interface CopySwitchTargetRowProps {
  target: PasteTarget;
  variant: "full" | "compact";
  /** 该行正在执行复制+切换 */
  busy?: boolean;
  /** 其他行执行中/重试中：本行暂不可点 */
  disabled?: boolean;
  onSelect: () => void;
}

export default function CopySwitchTargetRow({
  target,
  variant,
  busy = false,
  disabled = false,
  onSelect,
}: CopySwitchTargetRowProps) {
  const title = target.title || "（无标题窗口）";
  const meta = `${fileBaseName(target.exe_path)} · PID ${target.pid}`;
  const blocked = disabled || busy;

  if (variant === "compact") {
    // 结构与既有列表行一致（div 卡片 + `.cap-main.cap-row-open` 按钮 + `.cap-mini`）。
    // 右侧箭头是独立按钮：胶囊行的既有交互就是「主区域 + 行内动作按钮」，
    // 26px 的既有命中区不会被文字区覆盖，也不与主按钮重复触发。
    return (
      <div className="cap-item cap-copy-target" aria-busy={busy || undefined} data-target-hwnd={target.hwnd}>
        <span className="cap-tile" aria-hidden="true">
          <TargetIcon hwnd={target.hwnd} pid={target.pid} exePath={target.exe_path} size={20} />
        </span>
        <button
          type="button"
          className="cap-main cap-row-open"
          aria-label={`复制并切换到「${title}」`}
          aria-busy={busy || undefined}
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
          {busy ? (
            <Loader2 size={13} className="spin" aria-hidden="true" />
          ) : (
            <ArrowUpRight size={13} strokeWidth={2} aria-hidden="true" />
          )}
        </button>
      </div>
    );
  }

  // full：整行是一个动作按钮，箭头放在按钮内部右侧。这样点击窗口信息或箭头
  // 都命中同一个按钮，既不会出现「图标可见但无事件」，也不会有两个重复的单选。
  return (
    <div className="clip-target-row" data-target-hwnd={target.hwnd}>
      <button
        type="button"
        className="clip-target"
        aria-label={`复制并切换到「${title}」`}
        aria-busy={busy || undefined}
        disabled={blocked}
        onClick={onSelect}
        data-tip={disabled ? undefined : `复制并切换到「${title}」`}
      >
        <TargetIcon hwnd={target.hwnd} pid={target.pid} exePath={target.exe_path} />
        <span className="clip-target-text">
          <span className="clip-target-title">{title}</span>
          <span className="clip-target-meta">{meta}</span>
        </span>
        {/* 状态/跳转图示：全部在按钮内部，纯展示，不单独接收事件。 */}
        <span className="clip-target-state" aria-hidden="true">
          {busy ? (
            <Loader2 size={12} className="spin" />
          ) : (
            <ArrowUpRight size={13} strokeWidth={2.2} />
          )}
        </span>
      </button>
    </div>
  );
}
