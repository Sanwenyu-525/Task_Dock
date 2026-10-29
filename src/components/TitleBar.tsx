//! 标题栏：品牌 + Agent 实时状态 + 模式/主题菜单 + 窗口操作。
//! 状态点订阅 agents store（响应式）；completed 历史轮次不算实时运行状态。

import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Minus, PanelsTopLeft, Square, Sun, Moon, Monitor, X, ChevronDown, Clipboard,
} from "lucide-react";
import { useSettingsStore } from "../store/useSettingsStore";
import { useAgentsStore } from "../store/useAgentsStore";
import { useUiStore } from "../store/useUiStore";
import { applyMode } from "../lib/bridge";
import { AGENT_STATE_LABELS } from "../lib/format";
import { worstAgentState } from "../lib/agentTree";

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

/** 轻量下拉菜单：点击外部/Escape 关闭。 */
function Dropdown({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon: typeof Sun;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="titlebar-menu" ref={ref}>
      <button
        className={`icon-btn menu-trigger ${open ? "active" : ""}`}
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon size={13} />
        <ChevronDown size={9} className="menu-caret" />
      </button>
      {open && <div className="menu-popover" role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

export default function TitleBar() {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  const snapshot = useAgentsStore((s) => s.snapshot);
  const clipboardOpen = useUiStore((s) => s.clipboardOpen);
  const openClipboard = useUiStore((s) => s.openClipboard);
  const closeClipboard = useUiStore((s) => s.closeClipboard);
  const mode = settings?.mode ?? "full";
  const theme = settings?.theme ?? "system";

  // Escape 隐藏窗口（输入框/弹窗/剪贴板抽屉自行处理并阻止冒泡时跳过）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // 次级面板自行消费 Escape，不能顺带把窗口藏进托盘
      if (useUiStore.getState().clipboardOpen || useUiStore.getState().context.open) return;
      getCurrentWindow().hide();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 响应式：订阅 snapshot，实时状态不含历史 completed 轮次
  const state = worstAgentState(snapshot);
  const modeItem = MODES.find((m) => m.id === mode) ?? MODES[2];
  const themeItem = THEMES.find((t) => t.id === theme) ?? THEMES[2];

  return (
    <div className="titlebar" data-tauri-drag-region>
      <span className={`agent-dot state-${state}`} title={`Agent: ${AGENT_STATE_LABELS[state] ?? state}`} />
      <span className="titlebar-title" data-tauri-drag-region>
        Task Dock
      </span>

      <div className="titlebar-actions">
        <Dropdown label={`显示模式（当前：${modeItem.title}）`} icon={modeItem.icon}>
          {(close) =>
            MODES.map((m) => (
              <button
                key={m.id}
                className={`menu-item ${mode === m.id ? "active" : ""}`}
                role="menuitem"
                onClick={() => {
                  close();
                  applyMode(m.id);
                }}
              >
                <m.icon size={13} />
                <span>{m.title}</span>
                <span className="menu-check">{mode === m.id ? "✓" : ""}</span>
              </button>
            ))
          }
        </Dropdown>
        <Dropdown label={`主题（当前：${themeItem.title}）`} icon={themeItem.icon}>
          {(close) =>
            THEMES.map((t) => (
              <button
                key={t.id}
                className={`menu-item ${theme === t.id ? "active" : ""}`}
                role="menuitem"
                onClick={() => {
                  close();
                  update({ theme: t.id });
                }}
              >
                <t.icon size={13} />
                <span>{t.title}</span>
                <span className="menu-check">{theme === t.id ? "✓" : ""}</span>
              </button>
            ))
          }
        </Dropdown>
        <button
          className={`icon-btn ${clipboardOpen ? "active" : ""}`}
          title={clipboardOpen ? "关闭智能剪贴板" : "智能剪贴板"}
          aria-label={clipboardOpen ? "关闭智能剪贴板" : "打开智能剪贴板"}
          aria-expanded={clipboardOpen}
          onClick={() => (clipboardOpen ? closeClipboard() : openClipboard())}
        >
          <Clipboard size={14} />
        </button>
        <span className="titlebar-divider" />
        <button className="icon-btn" title="最小化" aria-label="最小化" onClick={() => getCurrentWindow().minimize()}>
          <Minus size={14} />
        </button>
        <button className="icon-btn" title="隐藏到托盘 (Esc)" aria-label="隐藏到托盘" onClick={() => getCurrentWindow().hide()}>
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
