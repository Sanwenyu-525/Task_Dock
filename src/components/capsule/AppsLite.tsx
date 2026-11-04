//! 应用面板（胶囊内，对照 `docs/design-refs/v07/停靠效果图/04-apps.png`）。
//!
//! 复用既有 `nav_list_targets` 缓存与 `nav_navigate`（窗口识别 / 启动 / 聚焦
//! 全在后端），胶囊内不实现第二套启动逻辑。
//!
//! 真实性约束：
//! - 列表只来自用户**已配置**的快捷目标，不预置微信 / Chrome / VS Code；
//! - 应用图标走统一的 `AppIcon`（后端按需提取 Windows 真实图标），
//!   网址/文件夹没有可执行文件，仍用「稳定色相 + 首字母」圆点；
//! - 搜索框做的是对已加载目标的本地过滤（真实可用），不是装饰；
//! - 启动失败如实提示后端返回的 `reason`，不显示「已启动」。

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { LayoutGrid, Plus, Search, Settings2 } from "lucide-react";
import { navNavigate, avatarHue, type NavTarget } from "../../lib/navigation";
import { searchApps } from "../../lib/appSearch";
import AppIcon from "../ui/AppIcon";
import { useNavigationStore } from "../../store/useNavigationStore";
import { openAppsConfig } from "./actions";
import { EmptyState, PanelHead } from "./PanelKit";

export default function AppsLite() {
  const targets = useNavigationStore((s) => s.targets);
  const targetsLoaded = useNavigationStore((s) => s.targetsLoaded);
  const targetsError = useNavigationStore((s) => s.targetsError);
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

  // 只展示普通应用快捷方式：网址/文件夹单独分区，Agent 会话不进入应用网格。
  const visible = useMemo(
    () => targets.filter((t) => !t.hidden && t.target_type === "application"),
    [targets],
  );

  const extras = useMemo(
    () =>
      targets.filter(
        (t) => !t.hidden && (t.target_type === "url" || t.target_type === "directory"),
      ),
    [targets],
  );

  // 默认顺序沿用应用中心的规则：收藏优先 → 最近使用 → 名称。
  // `last_used_at` / `use_count` 仍来自后端真实计数，这里只做展示排序。
  const ranked = useMemo(
    () =>
      [...visible].sort(
        (a, b) =>
          Number(b.favorite) - Number(a.favorite) ||
          (b.last_used_at ?? "").localeCompare(a.last_used_at ?? "") ||
          a.display_name.localeCompare(b.display_name, "zh"),
      ),
    [visible],
  );

  const grid = useMemo(() => {
    const q = query.trim();
    // 与选择器/应用中心共用同一套搜索规则（中文连续子串、英文大小写、身份绑定别名），
    // 数据范围是「已配置集合」，不是扫描到的全部应用。
    let base = ranked;
    if (q) {
      const byId = new Map(ranked.map((t) => [t.id, t]));
      base = searchApps(
        ranked.map((t) => ({
          key: t.id,
          displayName: t.display_name,
          category: t.category,
          exePath: t.exe_path || t.url || t.path,
          identity: t.app_key,
        })),
        q,
      )
        .map((s) => byId.get(s.key))
        .filter((t): t is NavTarget => !!t);
    }
    // 非搜索态留一格给「添加」按钮；添加按钮任何情况下都可见，
    // 超出的目标通过「管理」进入完整设置页处理。
    return base.slice(0, q ? 7 : 6);
  }, [ranked, query]);

  const launch = async (id: string, name: string) => {
    if (busyId) return;
    setBusyId(id);
    try {
      const res = await navNavigate(id);
      if (!res.success) {
        flash(`${name}：${res.reason || "启动失败"}`);
      } else {
        // 成功后刷新共享目标，让网格的「最近使用优先」排序反映真实后端计数。
        void loadTargets(true);
        if (res.actual_action === "focus_window") {
          flash(`已聚焦 ${name}`);
        } else if (res.fallback_used) {
          flash(`${name}：已用备用方式打开`);
        }
      }
    } catch {
      flash(`${name}：启动失败`);
    } finally {
      setBusyId(null);
    }
  };

  // 「没有配置」与「读取失败」必须分开：targetsError 存在时绝不把旧清单/空清单
  // 伪装成「尚未配置快捷应用」。读取失败且从未成功 → 错误空态（可重试）；
  // 失败但已有旧清单 → 旧清单保留 + 错误提示条。
  const loadError = targetsError !== null;
  const empty = targetsLoaded && !loadError && ranked.length === 0 && extras.length === 0;
  const loadFailedFresh = loadError && !targetsLoaded;
  const loadFailedStale = loadError && targetsLoaded;

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
            onClick={() => openAppsConfig("manage")}
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
        {loadFailedFresh && (
          <EmptyState
            icon={<LayoutGrid size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="快捷应用读取失败"
            actionLabel="重试"
            onAction={() => void loadTargets()}
          />
        )}

        {loadFailedStale && (
          <div className="cap-item cap-error-row" role="alert">
            <span className="cap-error-text">刷新失败，显示的是上次结果</span>
            <button type="button" className="cap-mini" aria-label="重试读取快捷应用" onClick={() => void loadTargets()}>
              重试
            </button>
          </div>
        )}

        {empty && (
          <EmptyState
            icon={<LayoutGrid size={22} strokeWidth={1.6} aria-hidden="true" />}
            text="尚未配置快捷应用"
            actionLabel="去配置"
            onAction={() => openAppsConfig("picker")}
          />
        )}

        {!empty && !loadFailedFresh && (
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
                <AppIcon targetId={t.id} name={t.display_name} size={34} />
                <span className="cap-app-name" data-tip={t.display_name}>
                  {t.display_name}
                </span>
              </button>
            ))}
            <button
              type="button"
              className="cap-app cap-app-add"
              aria-label="添加应用"
              onClick={() => openAppsConfig("picker")}
            >
              <span className="cap-app-avatar is-add" aria-hidden="true">
                <Plus size={16} strokeWidth={2.4} />
              </span>
              <span className="cap-app-name">添加应用</span>
            </button>
          </div>
        )}

        {extras.length > 0 && !loadFailedFresh && !query.trim() && (
          <div className="cap-recent">
            <span className="cap-recent-title">网址 / 文件夹</span>
            <span className="cap-recent-list">
              {extras.slice(0, 4).map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className="cap-recent-chip"
                  aria-label={`打开 ${t.display_name}`}
                  data-tip={t.url || t.path}
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

        {query.trim() && grid.length === 0 && !loadFailedFresh && (
          <EmptyState
            icon={<Search size={20} strokeWidth={1.6} aria-hidden="true" />}
            text="没有匹配的应用"
          />
        )}
      </div>

      <div className="cap-foot">
        <span className="cap-foot-note">{notice ?? "点击即启动或聚焦已有窗口"}</span>
        <button type="button" className="cap-link" onClick={() => openAppsConfig("manage")}>
          管理
        </button>
      </div>
    </>
  );
}
