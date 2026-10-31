//! 标题栏：品牌 + Agent 实时状态 + 模式/明暗/视觉预设菜单 + 窗口操作。
//! 状态点订阅 agents store（响应式）；completed 历史轮次不算实时运行状态。
//!
//! v0.6：菜单改用统一的 DropdownMenu 基元（键盘导航、Escape 只关本层、
//! 自动翻转定位），并把剪贴板入口移交给左侧导航——完整模式不再放剪贴板按钮。
//! 紧凑/极简模式没有左侧导航，仍靠标题栏的剪贴板按钮作为临时入口。

import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Minus, PanelsTopLeft, Square, Sun, Moon, Monitor, X, ChevronDown, Palette, Clipboard, Magnet,
} from "lucide-react";
import { useSettingsStore } from "../store/useSettingsStore";
import { useAgentsStore } from "../store/useAgentsStore";
import { useUiStore } from "../store/useUiStore";
import { useEdgeSnapStore } from "../store/useEdgeSnapStore";
import { EDGE_LABELS } from "../lib/edgeSnap";
import { applyMode } from "../lib/bridge";
import { AGENT_STATE_LABELS } from "../lib/format";
import { worstAgentState } from "../lib/agentTree";
import { PRESET_LABELS, VISUAL_PRESETS, resolveVisualPreset } from "../lib/theme";
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

export default function TitleBar() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const snapshot = useAgentsStore((s) => s.snapshot);
  const openClipboard = useUiStore((s) => s.openClipboard);
  const closeClipboard = useUiStore((s) => s.closeClipboard);
  const clipboardOpen = useUiStore((s) => s.clipboardOpen);
  // 停靠状态：低调磁铁图标 + 点击解除吸附（明确操作路径，需求 C/F）
  const snapDockedEdge = useEdgeSnapStore((s) => (s.phase.startsWith("docked-") ? s.dockedEdge : null));
  const snapUndock = useEdgeSnapStore((s) => s.undock);
  const mode = settings?.mode ?? "full";
  const theme = settings?.theme ?? "system";
  const preset = resolveVisualPreset(settings?.visual_preset);

  // 响应式：订阅 snapshot，实时状态不含历史 completed 轮次
  const state = worstAgentState(snapshot);
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

  return (
    <div className="titlebar" data-tauri-drag-region>
      <span className="brand-orb" aria-hidden="true" />
      <span
        className={`agent-dot state-${state}`}
        title={`Agent: ${AGENT_STATE_LABELS[state] ?? state}`}
        aria-label={`Agent 状态：${AGENT_STATE_LABELS[state] ?? state}`}
      />
      <span className="titlebar-title" data-tauri-drag-region>
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
        {/* 停靠状态指示：仅吸附生效时出现；点击解除吸附（隐藏态会先安全展开） */}
        {snapDockedEdge && (
          <button
            className="icon-btn win-btn snap-docked-btn"
            data-tip={`已吸附${EDGE_LABELS[snapDockedEdge]} · 点击解除吸附`}
            aria-label={`已吸附${EDGE_LABELS[snapDockedEdge]}，点击解除吸附`}
            onClick={() => snapUndock?.()}
          >
            <Magnet size={14} />
          </button>
        )}
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
