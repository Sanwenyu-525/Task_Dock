//! 应用面板（胶囊内）：已配置的快捷启动目标 + 管理入口。
//!
//! 复用既有 `nav_list_targets` 缓存与 `nav_navigate`（窗口识别 / 启动 / 聚焦
//! 全在后端），胶囊内不实现第二套启动逻辑。

import { useEffect, type CSSProperties } from "react";
import { LayoutGrid, Settings2 } from "lucide-react";
import { navNavigate, avatarHue } from "../../lib/navigation";
import { useNavigationStore } from "../../store/useNavigationStore";
import { openFullApp } from "./actions";

export default function AppsLite() {
  const targets = useNavigationStore((s) => s.targets);
  const targetsLoaded = useNavigationStore((s) => s.targetsLoaded);
  const loadTargets = useNavigationStore((s) => s.loadTargets);

  useEffect(() => {
    if (!targetsLoaded) void loadTargets();
  }, [targetsLoaded, loadTargets]);

  const list = targets
    .filter((t) => !t.hidden)
    .sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return (b.use_count ?? 0) - (a.use_count ?? 0);
    })
    .slice(0, 6);

  return (
    <>
      <header className="capsule-head">
        <span className="capsule-title">应用</span>
        <span className="capsule-meta">{targetsLoaded ? `${list.length} 个快捷入口` : "读取中"}</span>
      </header>

      <div className="capsule-body">
        {targetsLoaded && list.length === 0 && (
          <div className="capsule-empty">
            <LayoutGrid size={20} strokeWidth={1.6} aria-hidden="true" />
            <p>尚未配置快捷应用</p>
            <button type="button" className="capsule-link" onClick={() => openFullApp("settings")}>
              去配置
            </button>
          </div>
        )}
        <div className="capsule-app-grid">
          {list.map((t) => (
            <button
              type="button"
              key={t.id}
              className="capsule-app"
              aria-label={`启动 ${t.display_name}`}
              onClick={() => void navNavigate(t.id).catch(() => {})}
            >
              <span
                className="capsule-app-avatar"
                style={{ "--app-hue": String(avatarHue(t.app_key || t.display_name)) } as CSSProperties}
                aria-hidden="true"
              >
                {(t.display_name || "?").slice(0, 1)}
              </span>
              <span className="capsule-app-name">{t.display_name}</span>
            </button>
          ))}
        </div>
      </div>

      <footer className="capsule-foot">
        <span className="capsule-hint">点击即启动或聚焦</span>
        <button type="button" className="capsule-link" onClick={() => openFullApp("settings")}>
          <Settings2 size={12} strokeWidth={2} aria-hidden="true" />
          管理
        </button>
      </footer>
    </>
  );
}
