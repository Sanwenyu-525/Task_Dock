//! 设置页「导航自定义」展开区（统一导航架构）。
//!
//! 折叠外壳由 `SettingsPanel` 的 `Section` 统一提供，本文件只渲染展开内容，
//! 避免出现第二套「长得像折叠卡」的独立实现。
//!
//! 只做导航元数据的用户偏好：完整面板（left）与停靠胶囊（capsule）**各自一份**
//! 可见性 + 排序，持久化在 SQLite 设置 `navigation_layout`（见 `navVisibility.ts`）。
//!
//! 关键语义：
//! - 隐藏只影响该界面的导航入口，不等于停用功能：页面照常渲染，后台模块、
//!   快捷键（Ctrl+1…0）、通知跳转全部不变；
//! - 「设置」是锁定入口（`locked`）：不可隐藏、不可排序，始终固定在完整面板底部，
//!   保证用户任何时候都能回到本页恢复配置；
//! - 排序使用上下移动按钮（Tab 可达、aria 明确），不引入拖拽系统；
//! - 隐藏当前所在页时自动切到仍可访问的安全页；
//! - 保存失败就地提示，界面仍显示后端真实配置，不出现假成功。

import { useState } from "react";
import { ArrowDown, ArrowUp, RotateCcw } from "lucide-react";
import { Switch } from "../ui";
import { useUiStore } from "../../store/useUiStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { errorMessage } from "../../lib/errors";
import {
  entriesForSurface,
  leftEntryForTab,
  type NavEntry,
  type NavSurface,
} from "../../lib/navigationRegistry";
import { safeTabForHiddenEntry } from "../../lib/navVisibility";
import {
  moveNavigationEntry,
  resetNavigationSurface,
  setNavigationEntryVisible,
  useNavigationLayout,
} from "../../lib/navigationLayout";

const SURFACE_LABELS: Record<NavSurface, string> = {
  left: "完整面板",
  capsule: "停靠胶囊",
};

const SURFACE_HINTS: Record<NavSurface, string> = {
  left: "左侧导航的入口与排列顺序。",
  capsule: "停靠胶囊轨道上的图标与排列顺序；不改变外轮廓、吸附与窗口几何。",
};

export default function NavigationVisibilitySection() {
  const settingsReady = useSettingsStore((s) => !!s.settings);
  const layout = useNavigationLayout();
  const tab = useUiStore((s) => s.tab);
  const setTab = useUiStore((s) => s.setTab);

  const [surface, setSurface] = useState<NavSurface>("left");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentEntryId = leftEntryForTab(tab)?.id;
  const surfaceEntries = entriesForSurface(surface);
  const visibleEntries = layout[surface]
    .map((id) => surfaceEntries.find((entry) => entry.id === id))
    .filter((entry): entry is NavEntry => entry !== undefined);
  // 隐藏项排在可见项之后（默认顺序），恢复显示时按默认顺序插回。
  // 锁定入口（设置）不在隐藏列表里：它始终可见，也不允许被关掉。
  const hiddenEntries = surfaceEntries.filter(
    (entry) => !entry.locked && !layout[surface].includes(entry.id),
  );
  const rows = [...visibleEntries, ...hiddenEntries];

  async function onToggle(entry: NavEntry, nextVisible: boolean) {
    if (pendingId || entry.locked) return;
    setPendingId(entry.id);
    setError(null);
    try {
      await setNavigationEntryVisible(surface, entry.id, nextVisible);
      if (surface === "left" && !nextVisible && currentEntryId === entry.id) {
        // 写入成功后当前页失去入口：切到仍可见的安全页，避免停在无入口页面。
        setTab(
          safeTabForHiddenEntry({
            ...layout,
            left: layout.left.filter((id) => id !== entry.id),
          }),
        );
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPendingId(null);
    }
  }

  async function onMove(entry: NavEntry, delta: -1 | 1) {
    if (pendingId || entry.locked) return;
    setPendingId(entry.id);
    setError(null);
    try {
      await moveNavigationEntry(surface, entry.id, delta);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPendingId(null);
    }
  }

  async function onReset() {
    if (pendingId) return;
    setPendingId("__reset__");
    setError(null);
    try {
      // 恢复默认会重新加入该界面的默认可见入口，当前页不会失去入口，无需切换页面。
      await resetNavigationSurface(surface);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="nav-visibility-body">
      <div className="nav-visibility-tabs" role="group" aria-label="选择要配置的界面">
        {(["left", "capsule"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={`btn sm${surface === value ? " primary" : ""}`}
            aria-pressed={surface === value}
            onClick={() => {
              setSurface(value);
              setError(null);
            }}
          >
            {SURFACE_LABELS[value]}
          </button>
        ))}
      </div>
      <p className="nav-visibility-hint">{SURFACE_HINTS[surface]}</p>

      <div className="nav-visibility-summary">
        <span>
          常驻 {visibleEntries.length} / {surfaceEntries.length} 项
        </span>
        <span className="nav-visibility-preview">
          {visibleEntries.length > 0
            ? visibleEntries.map((entry) => entry.label).join("、")
            : "无（可从下方重新开启）"}
        </span>
      </div>

      <div className="nav-visibility-list">
        {rows.map((entry) => {
          const visible = layout[surface].includes(entry.id);
          const index = visibleEntries.findIndex((item) => item.id === entry.id);
          const current = surface === "left" && entry.id === currentEntryId;
          const busy = pendingId === entry.id || pendingId === "__reset__";
          return (
            <div className="setting-row nav-visibility-row" key={entry.id}>
              <span className="nav-visibility-entry">
                <entry.icon
                  size={14}
                  strokeWidth={1.6}
                  className="nav-visibility-entry-icon"
                  aria-hidden="true"
                />
                <span className="nav-visibility-entry-label">{entry.label}</span>
                {entry.shortcut && (
                  <kbd className="nav-visibility-shortcut">{entry.shortcut}</kbd>
                )}
                {current && <span className="nav-visibility-current">当前页</span>}
                {entry.locked && <span className="nav-visibility-current">固定</span>}
                {!visible && <span className="nav-visibility-hidden">已隐藏</span>}
              </span>
              <span className="nav-visibility-actions">
                {!entry.locked && (
                  <>
                    <button
                      type="button"
                      className="nav-visibility-move"
                      onClick={() => onMove(entry, -1)}
                      disabled={!visible || index <= 0 || busy}
                      aria-label={`上移 ${entry.label}`}
                    >
                      <ArrowUp size={12} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="nav-visibility-move"
                      onClick={() => onMove(entry, 1)}
                      disabled={
                        !visible || index < 0 || index >= visibleEntries.length - 1 || busy
                      }
                      aria-label={`下移 ${entry.label}`}
                    >
                      <ArrowDown size={12} aria-hidden="true" />
                    </button>
                  </>
                )}
                <Switch
                  checked={visible}
                  disabled={!settingsReady || busy || entry.locked}
                  ariaLabel={
                    entry.locked ? `${entry.label}导航入口（固定）` : `${entry.label}导航入口显示`
                  }
                  onChange={(next) => void onToggle(entry, next)}
                />
              </span>
            </div>
          );
        })}
      </div>

      <div className="nav-visibility-footer">
        <button
          type="button"
          className="btn sm"
          onClick={() => void onReset()}
          disabled={!settingsReady || pendingId !== null}
          aria-label={`恢复${SURFACE_LABELS[surface]}默认导航配置`}
        >
          <RotateCcw size={12} /> 恢复「{SURFACE_LABELS[surface]}」默认
        </button>
        {!settingsReady && <span className="setting-note">设置尚未加载，请稍候。</span>}
      </div>

      {surface === "capsule" && visibleEntries.length === 0 && (
        <div className="setting-note">
          胶囊已隐藏全部图标：轨道上的「切换为完整面板」按钮仍可用，也可在此重新开启入口。
        </div>
      )}

      {error && (
        <div className="setting-note nav-visibility-error" role="alert">
          保存失败：{error}（界面仍显示上次保存的配置）
        </div>
      )}
    </div>
  );
}
