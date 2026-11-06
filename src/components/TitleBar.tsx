//! 标题栏：品牌 + 模式/明暗/视觉预设菜单 + 窗口操作。
//! 标题栏不再展示 Agent 状态点：状态聚合仍由 Agent 面板/紧凑视图/行动页承载。
//!
//! v0.6：菜单改用统一的 DropdownMenu 基元（键盘导航、Escape 只关本层、
//! 自动翻转定位），并把剪贴板入口移交给左侧导航——完整模式不再放剪贴板按钮。
//! 紧凑/极简模式没有左侧导航，仍靠标题栏的剪贴板按钮作为临时入口。

import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Minus, PanelsTopLeft, Square, Sun, Moon, Monitor, X, ChevronDown, Palette, Clipboard,
} from "lucide-react";
import { useSettingsStore } from "../store/useSettingsStore";
import { useUiStore } from "../store/useUiStore";
import { applyMode } from "../lib/bridge";
import { PRESET_LABELS, VISUAL_PRESETS, resolveVisualPreset } from "../lib/theme";
import { resolveWindowMode } from "../lib/windowMode";
import DropdownMenu, { type DropdownMenuItem } from "./ui/DropdownMenu";

const MODES = [
  { id: "minimal", icon: Minus, title: "极简模式" },
  { id: "compact", icon: Square, title: "紧凑模式" },
  { id: "full", icon: PanelsTopLeft, title: "完整模式" },
] as const;

const THEMES = [
  { id: "light", icon: Sun, title: "浅色" },
  { id: "dark", icon: Moon, title: "深色" },
  { id: "system", icon: Monitor, title: "跟随系统" },
] as const;

/** 标题栏菜单按钮：图标 + 下拉箭头，菜单本体由统一的 DropdownMenu 承载。
 *  菜单相对触发按钮水平居中；宽度由最长选项文本自然撑宽（不设固定下限）。 */
function MenuButton({
  label,
  icon: Icon,
  items,
  className,
}: {
  label: string;
  icon: typeof Sun;
  items: DropdownMenuItem[];
  className?: string;
}) {
  return (
    <div className={`titlebar-menu ${className ?? ""}`}>
      <DropdownMenu
        items={items}
        menuLabel={label}
        placement="bottom"
        className="titlebar-menu-popover"
        trigger={({ ref, expanded, onClick, onKeyDown }) => (
          <button
            ref={ref}
            className={`icon-btn menu-trigger ${expanded ? "active" : ""}`}
            data-tip={label}
            aria-label={label}
            aria-haspopup="menu"
            aria-expanded={expanded}
            onClick={onClick}
            onKeyDown={onKeyDown}
          >
            <Icon size={13} />
            <ChevronDown size={9} className="menu-caret" />
          </button>
        )}
      />
    </div>
  );
}

/**
 * 窗口拖拽光标会话：标题栏拖拽区按下时进入 `is-dragging`（grabbing），
 * 结束后回到 grab。
 *
 * Tauri 的 drag region 在 mousedown 里调用原生 `startDragging`，进入 Win32 的
 * 模态移动循环；循环期间 WebView2 收不到指针事件（`useEdgeSnap` 同一条实测
 * 结论），所以松手后**不会有 pointerup**。结束信号取「指针事件恢复」：
 * - `pointermove` 只认 `buttons === 0`：拖拽开始前的最后几毫秒仍可能收到
 *   按住状态的移动事件，不能据此提前复位；
 * - `pointerup` / `pointercancel` 覆盖没走到原生循环的普通点击与中断；
 * - `visibilitychange` 覆盖页面隐藏；`blur` 只在「非起始扰动」时结束，
 *   起始 120ms 内的 blur 是原生拖动启动时的激活扰动（见 TooltipLayer
 *   实测注释：startDragging 会激活窗口并引发 focus 扰动），若在此处
 *   立即 stop，会把 `grabbing` 切掉造成闪烁。
 *
 * 起始守卫（120ms）只拦截 blur / buttons=0 的合成移动，pointerup/cancel
 * 始终可结束（真实点击/中断不受影响）；会话序号保证旧会话的迟到事件
 * 不会清理新会话。任一信号先到即摘掉本次会话的全部监听，不会累积。
 * 原生拖动在 mousedown 即进入循环，DOM 无位移可用于 pressed/dragging
 * 区分，故此处不设视觉 pressed 阶段；pressed→dragging 的阈值语义保留给
 * EdgeTab（4px）与应用网格（dragstart）等非原生拖动。
 */
function useWindowDragCursor() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let endSession: (() => void) | null = null;
    let sessionSeq = 0;

    const stop = () => {
      root.classList.remove("is-dragging");
      endSession?.();
      endSession = null;
    };

    const start = () => {
      stop(); // 上一条会话若因事件缺失没收尾，先清掉再开新的
      const mySeq = ++sessionSeq;
      const startedAt = Date.now();
      const isStale = () => mySeq !== sessionSeq;
      const inStartChurn = () => Date.now() - startedAt < 120;
      root.classList.add("is-dragging");
      const end = () => {
        if (isStale()) return;
        stop();
      };
      const endIfLate = () => {
        if (isStale() || inStartChurn()) return;
        stop();
      };
      const onMove = (event: PointerEvent) => {
        if (event.buttons === 0) endIfLate();
      };
      const onBlur = () => endIfLate();
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
      window.addEventListener("blur", onBlur);
      document.addEventListener("visibilitychange", end);
      endSession = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        window.removeEventListener("blur", onBlur);
        document.removeEventListener("visibilitychange", end);
      };
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element) || !root.contains(target)) return;
      // 与 Tauri 一致：只认事件 target 自身的 data-tauri-drag-region
      //（父级属性不向下传递，按钮/操作区不在这里起拖）。
      if (!target.hasAttribute("data-tauri-drag-region")) return;
      start();
    };

    // 捕获阶段：Tauri 的 drag.js 在 mousedown 里 stopImmediatePropagation，
    // pointerdown 先于 mousedown，且捕获阶段不受其影响。
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      // 卸载先使在途会话失效，旧会话的迟到事件不再触碰新状态。
      sessionSeq += 1;
      stop();
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);

  return rootRef;
}

export default function TitleBar({ inert = false }: { inert?: boolean }) {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const openClipboard = useUiStore((s) => s.openClipboard);
  const closeClipboard = useUiStore((s) => s.closeClipboard);
  const clipboardOpen = useUiStore((s) => s.clipboardOpen);
  // 与 App 共用同一归一化：损坏/未知的模式值下，菜单不能显示「无选中项」。
  const mode = resolveWindowMode(settings?.mode);
  const theme = settings?.theme ?? "system";
  const preset = resolveVisualPreset(settings?.visual_preset);

  const modeItem = MODES.find((m) => m.id === mode) ?? MODES[2];
  const themeItem = THEMES.find((t) => t.id === theme) ?? THEMES[2];

  const modeItems: DropdownMenuItem[] = MODES.map((m) => ({
    key: m.id,
    label: m.title,
    icon: <m.icon size={13} />,
    radio: true,
    checked: mode === m.id,
    onSelect: () => applyMode(m.id),
  }));

  const themeItems: DropdownMenuItem[] = THEMES.map((t) => ({
    key: t.id,
    label: t.title,
    icon: <t.icon size={13} />,
    radio: true,
    checked: theme === t.id,
    onSelect: () => update({ theme: t.id }),
  }));

  const presetItems: DropdownMenuItem[] = VISUAL_PRESETS.map((id) => ({
    key: id,
    label: PRESET_LABELS[id].name,
    description: PRESET_LABELS[id].tagline,
    icon: <span className={`preset-swatch swatch-${id}`} aria-hidden="true" />,
    radio: true,
    checked: preset === id,
    onSelect: () => update({ visual_preset: id }),
  }));

  const titleRef = useWindowDragCursor();

  return (
    <div
      ref={titleRef}
      className="titlebar ui-drag-surface ui-drag-session"
      data-tauri-drag-region
      inert={inert}
    >
      {/* 品牌球也作为窗口拖拽热区：Tauri 的 drag-region 只认事件 target 自身的
          data-tauri-drag-region，父级标题栏的属性不会向下传递。 */}
      <span className="brand-orb ui-drag-surface" aria-hidden="true" data-tauri-drag-region />
      <span className="titlebar-title ui-drag-surface" data-tauri-drag-region>
        Task Dock
      </span>

      <div className="titlebar-actions">
        <MenuButton className="mode-menu" label={`显示模式（当前：${modeItem.title}）`} icon={modeItem.icon} items={modeItems} />
        <MenuButton className="theme-menu" label={`明暗（当前：${themeItem.title}）`} icon={themeItem.icon} items={themeItems} />
        <MenuButton
          className="preset-menu"
          label={`视觉主题（当前：${PRESET_LABELS[preset].name}）`}
          icon={Palette}
          items={presetItems}
        />
        <span className="titlebar-divider" />
        {/* 完整模式的剪贴板入口在左侧导航；紧凑/极简没有侧栏，这里保留临时入口 */}
        {mode !== "full" && (
          <button
            className={`icon-btn win-btn ${clipboardOpen ? "active" : ""}`}
            data-tip="智能剪贴板 (Ctrl+Shift+C)"
            aria-label="打开智能剪贴板"
            aria-expanded={clipboardOpen}
            onClick={() => (clipboardOpen ? closeClipboard() : openClipboard())}
          >
            <Clipboard size={14} />
          </button>
        )}
        <button className="icon-btn win-btn" data-tip="最小化" aria-label="最小化" onClick={() => getCurrentWindow().minimize()}>
          <Minus size={14} />
        </button>
        <button className="icon-btn win-btn" data-tip="隐藏到托盘 (Esc)" aria-label="隐藏到托盘" onClick={() => getCurrentWindow().hide()}>
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
