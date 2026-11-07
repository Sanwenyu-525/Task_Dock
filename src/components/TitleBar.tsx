//! 标题栏：品牌 + 模式/明暗/视觉预设菜单 + 停靠形态菜单 + 窗口操作。
//! 标题栏不再展示 Agent 状态点：状态聚合仍由 Agent 面板/紧凑视图/行动页承载。
//!
//! v0.6：菜单改用统一的 DropdownMenu 基元（键盘导航、Escape 只关本层、
//! 自动翻转定位），并把剪贴板入口移交给左侧导航——完整模式不再放剪贴板按钮。
//! 紧凑/极简模式没有左侧导航，仍靠标题栏的剪贴板按钮作为临时入口。

import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Minus, PanelsTopLeft, Square, Sun, Moon, Monitor, X, ChevronDown, Palette, Clipboard,
  Magnet, Columns2, PanelLeftClose, PinOff,
} from "lucide-react";
import { useSettingsStore } from "../store/useSettingsStore";
import { useEdgeSnapStore } from "../store/useEdgeSnapStore";
import { useUiStore } from "../store/useUiStore";
import { applyMode } from "../lib/bridge";
import { attachDragCursorSession } from "../lib/dragCursorSession";
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
 * 结束回到 grab。生命周期（起手守卫、会话序号、原生 `WM_EXITSIZEMOVE`
 * 结束信号、监听成对摘除）统一在 `lib/dragCursorSession` 里实现，
 * 与胶囊轨道、工具面板标题、桌面微件共用同一套——不在这里维护第二份。
 */
function useWindowDragCursor() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const session = attachDragCursorSession(root);
    return () => session.dispose();
  }, []);

  return rootRef;
}

/**
 * 停靠完整面板的双击标题栏 = 收缩为胶囊（本次停靠会话，不写偏好）。
 *
 * Tauri 的 drag-region 脚本对双击（mousedown `detail===2`）的默认行为是
 * `internal_toggle_maximize`：程序化 SW_MAXIMIZE 不受停靠期清除的
 * `WS_MAXIMIZEBOX` 限制，停靠中的窗口会被最大化，随后吸附引擎按巨大法向
 * 偏离判定拖离、自动解除停靠——双击反而把面板顶出停靠态。这里在元素级
 * （先于 Tauri 挂在 document 的监听）拦截：仅 docked-full 相位吃掉双击并走
 * 与边缘箭头同一的 `formSwitch("capsule")`；自由窗口保持 Windows 常规双击
 * 最大化，胶囊态标题栏 `inert` 收不到事件。目标判定沿用 drag-region 的
 * bare 语义（仅直接命中带 data-tauri-drag-region 的拖拽面），双击菜单/
 * 窗口按钮等交互子元素不会误触。
 */
function handleTitleBarMouseDown(e: ReactMouseEvent<HTMLDivElement>): void {
  if (e.button !== 0 || e.detail < 2) return;
  const target = e.target;
  if (!(target instanceof HTMLElement) || !target.hasAttribute("data-tauri-drag-region")) {
    return;
  }
  const { phase, formSwitch } = useEdgeSnapStore.getState();
  if (phase !== "docked-full" || !formSwitch) return;
  // 拦在 React 根容器（原生事件冒泡到 document 之前），Tauri 的
  // internal_toggle_maximize 不会触发。
  e.stopPropagation();
  void formSwitch("capsule");
}

export default function TitleBar({ inert = false }: { inert?: boolean }) {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const openClipboard = useUiStore((s) => s.openClipboard);
  const closeClipboard = useUiStore((s) => s.closeClipboard);
  const clipboardOpen = useUiStore((s) => s.clipboardOpen);
  // 停靠形态菜单：仅「吸附已启用 + 停靠为完整面板」时渲染。自由窗口的
  // 「重新吸附」是独立引擎事务（暂未立项）；胶囊/标签形态下标题栏不可见，
  // 各自的入口在轨道按钮与标签右键菜单，这里不重复。
  const snapPhase = useEdgeSnapStore((s) => s.phase);
  const formSwitch = useEdgeSnapStore((s) => s.formSwitch);
  const undock = useEdgeSnapStore((s) => s.undock);
  const collapseToTab = useEdgeSnapStore((s) => s.collapseToTab);
  const redock = useEdgeSnapStore((s) => s.redock);
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

  // 完整面板 → 极简标签没有直接相位转移（转移表契约：docked-full 只到
  // hidden/visible/free），按既有路径链式执行：先收成胶囊轨道，再收为标签。
  // 两步都是引擎原子事务：中途失败停在合法形态（引擎对形态切换失败有
  // toast 反馈），不会留下坏窗口。
  const collapseToTabFromFull = useCallback(async () => {
    const switched = await formSwitch?.("capsule");
    if (switched === false) return;
    await collapseToTab?.();
  }, [formSwitch, collapseToTab]);

  // 与双击收缩手势（handleTitleBarMouseDown）、贴边箭头（DockFormToggle）
  // 同一引擎入口：这里是可发现性最好的全量入口，含收标签与退出吸附。
  const dockItems: DropdownMenuItem[] = [
    {
      key: "dock-capsule",
      label: "转为胶囊",
      icon: <Columns2 size={13} />,
      onSelect: () => void formSwitch?.("capsule"),
    },
    {
      key: "dock-tab",
      label: "收为极简标签",
      icon: <PanelLeftClose size={13} />,
      onSelect: () => void collapseToTabFromFull(),
    },
    {
      key: "dock-undock",
      label: "退出吸附",
      icon: <PinOff size={13} />,
      onSelect: () => void undock?.(),
    },
  ];

  // 自由窗口：直接给出三个**吸附目标**（用户原诉求「直接变成胶囊/极简态」），
  // 选边由引擎按最近边决定，不经偏好解析；candidate 是拖拽磁吸的瞬态，不设入口。
  const freeDockItems: DropdownMenuItem[] = [
    {
      key: "redock-capsule",
      label: "吸附为胶囊",
      icon: <Columns2 size={13} />,
      onSelect: () => void redock?.("capsule"),
    },
    {
      key: "redock-tab",
      label: "吸附为极简标签",
      icon: <PanelLeftClose size={13} />,
      onSelect: () => void redock?.("tab"),
    },
    {
      key: "redock-full",
      label: "吸附为完整面板",
      icon: <PanelsTopLeft size={13} />,
      onSelect: () => void redock?.("full"),
    },
  ];

  return (
    <div
      ref={titleRef}
      className="titlebar ui-drag-surface ui-drag-session"
      data-tauri-drag-region
      onMouseDown={handleTitleBarMouseDown}
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
        {settings?.snap_enabled === true &&
          (snapPhase === "docked-full" || snapPhase === "free") && (
            <MenuButton
              className="dock-menu"
              label="停靠形态"
              icon={Magnet}
              items={snapPhase === "docked-full" ? dockItems : freeDockItems}
            />
          )}
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
