//! 目标快捷菜单：任务卡多目标时的弹出选择（键盘可操作）。

import { useEffect, useMemo, useRef, useState } from "react";
import { Globe, FileText, FolderOpen, Bot, AppWindow, ChevronRight, Rocket } from "lucide-react";
import type { TaskNavLink, NavigationTargetType } from "../../lib/navigation";
import { avatarHue, buildTargetMenuItems, moveMenuIndex, stateBadge } from "../../lib/navigation";
import { useOverlayLayer } from "../ui/overlay";

export function TargetTypeIcon({ type, size = 12 }: { type: NavigationTargetType; size?: number }) {
  switch (type) {
    case "url":
      return <Globe size={size} />;
    case "file":
      return <FileText size={size} />;
    case "directory":
      return <FolderOpen size={size} />;
    case "agent_session":
      return <Bot size={size} />;
    default:
      return <AppWindow size={size} />;
  }
}

/** 单个目标图标按钮（任务卡直列；也用于菜单内条目左侧）。 */
export function TargetAvatar({
  link,
  size = 18,
}: {
  link: TaskNavLink;
  size?: number;
}) {
  const hue = avatarHue(link.target.app_key || link.target.display_name);
  const badge = stateBadge(link.running_state);
  const isApp = link.target.target_type === "application";
  return (
    <span
      // 应用用专属色块 + 白图标；其余类型用主题色淡底 + 强调色图标。
      // 旧实现给非应用类型设了 background: transparent，而 .nav-avatar 的图标是白色
      // ——浅色主题下等于「白底白字」，网址/目录图标完全看不见。
      className={`nav-avatar tone-${badge.tone} ${isApp ? "nav-avatar-app" : "nav-avatar-generic"}`}
      style={{
        width: size,
        height: size,
        ...(isApp ? { background: `hsl(${hue} 55% 45%)` } : {}),
      }}
      title={`${link.target.display_name} · ${badge.label}${link.is_default ? " · 默认" : ""}`}
    >
      <TargetTypeIcon type={link.target.target_type} size={Math.round(size * 0.62)} />
      {badge.tone === "bad" && <span className="nav-avatar-flag" />}
    </span>
  );
}

interface Props {
  links: TaskNavLink[];
  onNavigate: (link: TaskNavLink) => void;
  onClose: () => void;
  /** 存在多个目标时提供「打开工作区」批量入口 */
  onOpenAll?: () => void;
}

export default function TargetMenu({ links, onNavigate, onClose, onOpenAll }: Props) {
  /**
   * 统一条目列表：工作区入口（若有）+ 每个目标。
   *
   * 旧实现把「工作区」按钮单独渲染、索引却只指向 links，于是：
   * 焦点永远跳过工作区入口，Enter 也只会走 onNavigate —— 键盘用户
   * 根本触发不了「打开工作区」。索引必须与 DOM 顺序一一对应。
   */
  const items = useMemo(
    () => buildTargetMenuItems(links, Boolean(onOpenAll)),
    [links, onOpenAll],
  );

  const [index, setIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  // 弹层栈：本菜单属于「下拉菜单」层，Escape 只关它，不会顺手把主窗口藏进托盘。
  useOverlayLayer("menu", true, onClose, ref);

  // 条目集合变化（目标增删）时收敛索引，避免越界后 Enter 无响应
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(items.length - 1, 0)));
  }, [items.length]);

  // 打开即聚焦当前项：键盘用户不需要先 Tab 进来
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(`[data-idx="${index}"]`)?.focus();
  }, [index]);

  function activate(i: number) {
    const it = items[i];
    if (!it) return;
    if (it.kind === "workspace") onOpenAll?.();
    else if (it.link) onNavigate(it.link);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      // Escape 交给全局弹层栈（见 lib/overlayStack）：只关最上层，且主窗口不会被连带隐藏。
      case "ArrowDown":
        e.preventDefault();
        setIndex((i) => moveMenuIndex(i, 1, items.length));
        break;
      case "ArrowUp":
        e.preventDefault();
        setIndex((i) => moveMenuIndex(i, -1, items.length));
        break;
      case "Home":
        e.preventDefault();
        setIndex(0);
        break;
      case "End":
        e.preventDefault();
        setIndex(items.length - 1);
        break;
      case "Enter":
      case " ":
        // preventDefault 阻止按钮的原生 click，否则 Enter 会触发两次
        e.preventDefault();
        activate(index);
        break;
      default:
        break;
    }
  }

  return (
    <div
      ref={ref}
      className="target-menu"
      role="menu"
      aria-label="选择跳转目标"
      onKeyDown={onKeyDown}
    >
      {onOpenAll && (
        <button
          role="menuitem"
          data-idx="0"
          tabIndex={-1}
          className={`target-menu-item target-menu-workspace ${index === 0 ? "active" : ""}`}
          onClick={() => {
            onOpenAll();
            onClose();
          }}
          onMouseEnter={() => setIndex(0)}
        >
          <Rocket size={14} />
          <span className="target-menu-name">打开工作区（全部目标）</span>
        </button>
      )}
      <div className="target-menu-head">跳转到…</div>
      {links.map((l, i) => {
        const badge = stateBadge(l.running_state);
        // 有工作区入口时，目标从索引 1 开始
        const idx = (onOpenAll ? 1 : 0) + i;
        return (
          <button
            key={l.id}
            role="menuitem"
            data-idx={idx}
            tabIndex={-1}
            className={`target-menu-item ${idx === index ? "active" : ""}`}
            onClick={() => {
              onNavigate(l);
              onClose();
            }}
            onMouseEnter={() => setIndex(idx)}
          >
            <TargetAvatar link={l} size={18} />
            <span className="target-menu-name">{l.target.display_name}</span>
            <span className="target-menu-meta">
              {l.target.target_type === "application"
                ? `${badge.label}${l.is_default ? " · 默认" : ""}`
                : l.is_default
                  ? "默认"
                  : ""}
            </span>
            <ChevronRight size={11} className="target-menu-arrow" />
          </button>
        );
      })}
      {links.some((l) => l.target.target_type === "application") && (
        <div className="target-menu-foot">运行状态为实时快照，点击应用 ≠ 任务完成</div>
      )}
    </div>
  );
}
