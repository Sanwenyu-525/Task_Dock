//! 胶囊面板的通用外壳与基元（**纯展示**，不含业务逻辑）。
//!
//! 五个面板（任务 / Agent / 剪贴板 / 收集箱 / 应用）共用同一套标题、摘要、分段筛选、
//! 空状态与底栏，避免出现五套圆角、边框、间距。样式全部落在 `styles.css`
//! 的 `cap-*` 类上，组件这里只做结构，不内联颜色。
//!
//! 设计口径（对照 `docs/design-refs/v07/停靠效果图/01..04`）：
//! - 标题 19px / 说明 11.5px，右侧 30px 玻璃图标按钮；
//! - 分段筛选是内凹容器 + 白色凸起药丸；
//! - 列表项是单层白玻璃卡（14px 圆角），层级只靠内高光与极轻投影。

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useDragRegion } from "../../lib/dragCursorSession";
import { usePanelClose } from "./panelClose";

/**
 * 面板标题（五个工具面板共用）。
 *
 * 标题区域同时是**窗口拖拽热区**：胶囊与工具面板在同一个原生窗口里，
 * 从标题背景或标题文字起拖 = 拖动整个窗口（轨道与面板因此天然保持相对位置，
 * 不需要任何 CSS transform 跟随，也不引入第二套定位引擎）。
 *
 * 命中范围按 Tauri 的语义精确划分：`data-tauri-drag-region` **只对事件 target
 * 自身生效**，不会向下传给子元素。所以只有背景（`<header>`）与两段文字挂这个属性；
 * 右侧 `actions` 里的返回/刷新/新建/筛选/搜索等控件不挂，永不误触发拖动。
 * `sub` 允许传入按钮（例如重试入口），因此文字容器只作为背景命中，不吞掉子按钮。
 *
 * 关闭按钮（`X`）永远在最右侧、且**不带** drag-region：点击它只收起面板，
 * 绝不会被当成窗口拖拽手柄。它由 `PanelCloseProvider` 提供动作，脱离胶囊时
 *（无 provider）不渲染，避免影响其他复用场景。
 */
/**
 * 统一的右上角关闭按钮（一级面板标题与本面板的二级页面共用）。
 *
 * - 只在 `PanelCloseProvider` 作用域内渲染；脱离胶囊（单测 / 其他复用）时返回 null。
 * - 按钮与其内部 `svg` 都不带 `data-tauri-drag-region`：点击只收起面板，
 *   不会被当成窗口拖拽手柄。
 * - `label` 由调用方给出面板名，读屏与自动化都能区分是哪一个面板的关闭入口。
 */
export function PanelCloseButton({ label = "关闭面板" }: { label?: string }) {
  const onClose = usePanelClose();
  if (!onClose) return null;
  return (
    <button type="button" className="cap-close" aria-label={label} onClick={() => onClose()}>
      <X size={15} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}

export function PanelHead({
  title,
  sub,
  actions,
  layout = "stack",
}: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
  /**
   * `stack`（默认）：标题在上、说明在下，五个面板既有结构不变；
   * `inline`：说明移到标题右侧同一行，用于标题区需要压缩高度、且说明只是
   * 一句话补充的面板（当前只有应用面板）。窄窗下说明省略，不挤压标题。
   */
  layout?: "stack" | "inline";
}) {
  const headRef = useDragRegion<HTMLElement>();
  const onClose = usePanelClose();

  return (
    <header
      ref={headRef}
      className="cap-head ui-drag-surface ui-drag-session"
      data-tauri-drag-region
    >
      <div
        className={`cap-head-text ui-drag-surface${layout === "inline" ? " cap-head-text--inline" : ""}`}
        data-tauri-drag-region
      >
        <span className="cap-title" data-tauri-drag-region>
          {title}
        </span>
        {sub ? (
          <span className="cap-sub" data-tauri-drag-region>
            {sub}
          </span>
        ) : null}
      </div>
      {actions || onClose ? (
        <div className="cap-actions">
          {actions}
          <PanelCloseButton label={`关闭${title}面板`} />
        </div>
      ) : null}
    </header>
  );
}

export interface SegOption<T extends string> {
  value: T;
  label: string;
}

/**
 * 分段筛选。`role="tablist"` + `aria-selected` 让读屏能读出当前筛选，
 * 视觉上只用白色药丸表达选中（不加粗边框，避免「四个按钮四个框」）。
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly SegOption<T>[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="cap-seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          className="cap-seg-btn"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  icon,
  text,
  actionLabel,
  onAction,
  className,
}: {
  icon: ReactNode;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}) {
  return (
    <div className={`cap-empty${className ? ` ${className}` : ""}`}>
      {icon}
      <p>{text}</p>
      {actionLabel && onAction ? (
        <button type="button" className="cap-link" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

/** 字节数 → 紧凑文案（1.2 MB / 320 KB / 800 B）。仅展示，不参与判定。 */
export function sizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
