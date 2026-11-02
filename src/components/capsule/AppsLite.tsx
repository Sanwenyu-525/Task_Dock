//! 应用面板（胶囊内，对照 `停靠效果图/04-apps.png`）。
//!
//! 复用既有 `nav_list_targets` 缓存与 `nav_navigate`（窗口识别 / 启动 / 聚焦
//! 全在后端），胶囊内不实现第二套启动逻辑。
//!
//! 真实性约束：
//! - 列表只来自用户**已配置**的快捷目标，不预置微信 / Chrome / VS Code；
//! - 当前后端不提供应用图标资源，因此用「稳定色相 + 首字母」方块（`avatarHue`
//!   是纯函数，同一 app_key 恒得同色），而不是伪造的品牌图标；
//! - 搜索框做的是对已加载目标的本地过滤（真实可用），不是装饰；
//! - 启动失败如实提示后端返回的 `reason`，不显示「已启动」。

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { LayoutGrid, Plus, Search, Settings2 } from "lucide-react";
import { navNavigate, avatarHue } from "../../lib/navigation";
import { useNavigationStore } from "../../store/useNavigationStore";
import { openFullApp } from "./actions";
import { EmptyState, PanelHead } from "./PanelKit";

export default function AppsLite() {
  const targets = useNavigationStore((s) => s.targets);
  const targetsLoaded = useNavigationStore((s) => s.targetsLoaded);
  const loadTargets = useNavigationStore((s) => s.loadTargets);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    if (!targetsLoaded) void loadTargets();
  }, [targetsLoaded, loadTargets]);

  useEffect(() => {
    const list = timers.current;
    return () => {
      list.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  const flash = (msg: string) => {
    setNotice(msg);
    const t = window.setTimeout(() => setNotice((n) => (n === msg ? null : n)), 2600);
    timers.current.push(t);
  };

  const visible = useMemo(
    () => targets.filter((t) => !t.hidden),
    [targets],
  );

  const ranked = useMemo(
    () =>
      [...visible].sort((a, b) => {
        if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
        return (b.use_count ?? 0) - (a.use_count ?? 0);
      }),
    [visible],
  );

  const grid = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? ranked.filter((t) => t.display_name.toLowerCase().includes(q))
      : ranked;
    return base.slice(0, 7);
  }, [ranked, query]);

  const recent = useMemo(
    () =>
      [...visible]
        .filter((t) => t.last_used_at)
        .sort((a, b) => (b.last_used_at ?? "").localeCompare(a.last_used_at ?? ""))
        .slice(0, 3),
    [visible],
  );

  const launch = async (id: string, name: string) => {
    if (busyId) return;
    setBusyId(id);
    try {
      const res = await navNavigate(id);
      if (!res.success) {
        flash(`${name}：${res.reason || "启动失败"}`);
      } else if (res.actual_action === "focus_window") {
        flash(`已聚焦 ${name}`);
      } else if (res.fallback_used) {
        flash(`${name}：已用备用方式打开`);
      }
    } catch {
      flash(`${name}：启动失败`);
    } finally {
      setBusyId(null);
    }
  };

  const empty = targetsLoaded && ranked.length === 0;

  return (
    <>
      <PanelHead
        title="应用"
        sub="常用应用、快捷启动与窗口切换"
        actions={
          <button
            type="button"
            className="cap-iconbtn"
            aria-label="管理快捷应用"
            onClick={() => openFullApp("settings")}
          >
            <Settings2 size={15} strokeWidth={2} aria-hidden="true" />
          </button>
        }
      />

      <div className="cap-input cap-search">
        <Search size={13} strokeWidth={2} aria-hidden="true" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索已配置的快捷应用…"
          aria-label="搜索快捷应用"
          maxLength={60}
        />
      </div>

      <div className="cap-list">
        {empty && (
          <EmptyState
            icon={<LayoutGrid size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="尚未配置快捷应用"
            actionLabel="去配置"
            onAction={() => openFullApp("settings")}
          />
        )}

        {!empty && (
          <div className="cap-app-grid">
            {grid.map((t) => (
              <button
                type="button"
                key={t.id}
                className="cap-app"
                aria-label={`启动 ${t.display_name}`}
                aria-busy={busyId === t.id}
                onClick={() => void launch(t.id, t.display_name)}
              >
                <span
                  className="cap-app-avatar"
                  style={{ "--app-hue": String(avatarHue(t.app_key || t.display_name)) } as CSSProperties}
                  aria-hidden="true"
                >
                  {(t.display_name || "?").slice(0, 1).toUpperCase()}
                </span>
                <span className="cap-app-name" title={t.display_name}>
                  {t.display_name}
                </span>
              </button>
            ))}
            {grid.length < 8 && !query.trim() && (
              <button
                type="button"
                className="cap-app"
                aria-label="添加或管理快捷应用"
                onClick={() => openFullApp("settings")}
              >
                <span className="cap-app-avatar is-add" aria-hidden="true">
                  <Plus size={16} strokeWidth={2.4} />
                </span>
                <span className="cap-app-name">添加</span>
              </button>
            )}
          </div>
        )}

        {grid.length === 0 && !empty && (
          <EmptyState
            icon={<Search size={20} strokeWidth={1.6} aria-hidden="true" />}
            text="没有匹配的应用"
          />
        )}

        {recent.length > 0 && (
          <div className="cap-recent">
            <span className="cap-recent-title">最近使用</span>
            <span className="cap-recent-list">
              {recent.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className="cap-recent-chip"
                  aria-label={`启动 ${t.display_name}`}
                  onClick={() => void launch(t.id, t.display_name)}
                >
                  <i
                    className="cap-recent-dot"
                    style={{ "--app-hue": String(avatarHue(t.app_key || t.display_name)) } as CSSProperties}
                    aria-hidden="true"
                  >
                    {(t.display_name || "?").slice(0, 1).toUpperCase()}
                  </i>
                  <span>{t.display_name}</span>
                </button>
              ))}
            </span>
          </div>
        )}
      </div>

      <div className="cap-foot">
        <span className="cap-foot-note">{notice ?? "点击即启动或聚焦已有窗口"}</span>
        <button type="button" className="cap-link" onClick={() => openFullApp("settings")}>
          管理
        </button>
      </div>
    </>
  );
}
