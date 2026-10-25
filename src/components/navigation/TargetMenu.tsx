//! 目标快捷菜单：任务卡多目标时的弹出选择（键盘可操作）。

import { useEffect, useRef, useState } from "react";
import { Globe, FileText, FolderOpen, Bot, AppWindow, ChevronRight, Rocket } from "lucide-react";
import type { TaskNavLink, NavigationTargetType } from "../../lib/navigation";
import { avatarHue, stateBadge } from "../../lib/navigation";

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
  return (
    <span
      className={`nav-avatar tone-${badge.tone}`}
      style={{
        width: size,
        height: size,
        background:
          link.target.target_type === "application"
            ? `hsl(${hue} 55% 45%)`
            : "transparent",
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
  const [index, setIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-idx="${index}"]`);
    el?.focus();
  }, [index]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, links.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onNavigate(links[index]);
      onClose();
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
          data-idx="all"
          className="target-menu-item target-menu-workspace"
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
        return (
          <button
            key={l.id}
            role="menuitem"
            data-idx={i}
            className={`target-menu-item ${i === index ? "active" : ""}`}
            onClick={() => {
              onNavigate(l);
              onClose();
            }}
            onMouseEnter={() => setIndex(i)}
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
