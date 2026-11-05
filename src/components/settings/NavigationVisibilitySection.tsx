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
  isEntrySortable,
  leftEntryForTab,
  navLabel,
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
import { useLocale } from "../../hooks/useLocale";

export default function NavigationVisibilitySection() {
  const { t } = useLocale();
  const surfaceLabel = (surface: NavSurface) =>
    surface === "left" ? t("nav.surface.left") : t("nav.surface.capsule");
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
      <div className="nav-visibility-tabs" role="group" aria-label={t("nav.surfaceAria")}>
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
            {surfaceLabel(value)}
          </button>
        ))}
      </div>
      <p className="nav-visibility-hint">
        {surface === "left" ? t("nav.hint.left") : t("nav.hint.capsule")}
      </p>

      <div className="nav-visibility-summary">
        <span>{t("nav.summary", { visible: visibleEntries.length, total: surfaceEntries.length })}</span>
        <span className="nav-visibility-preview">
          {visibleEntries.length > 0
            ? visibleEntries.map((entry) => navLabel(entry, t)).join(t("nav.listSeparator"))
            : t("nav.previewEmpty")}
        </span>
      </div>

      <div className="nav-visibility-list">
        {rows.map((entry) => {
          const visible = layout[surface].includes(entry.id);
          const index = visibleEntries.findIndex((item) => item.id === entry.id);
          const current = surface === "left" && entry.id === currentEntryId;
          const busy = pendingId === entry.id || pendingId === "__reset__";
          // 排序规则与渲染层共用一份元数据：锁定入口与胶囊 Agent 状态球
          // 不提供上移/下移按钮（不暴露无效操作）；末位可排序入口也不能越过
          // 其后方的固定入口，因此「下移」边界按下一个可排序邻居判断。
          const sortable = isEntrySortable(entry, surface);
          const prevSortable = index > 0 && isEntrySortable(visibleEntries[index - 1], surface);
          const nextSortable =
            index >= 0 &&
            index < visibleEntries.length - 1 &&
            isEntrySortable(visibleEntries[index + 1], surface);
          return (
            <div className="setting-row nav-visibility-row" key={entry.id}>
              <span className="nav-visibility-entry">
                <entry.icon
                  size={14}
                  strokeWidth={1.6}
                  className="nav-visibility-entry-icon"
                  aria-hidden="true"
                />
                <span className="nav-visibility-entry-label">{navLabel(entry, t)}</span>
                {entry.shortcut && (
                  <kbd className="nav-visibility-shortcut">{entry.shortcut}</kbd>
                )}
                {current && <span className="nav-visibility-current">{t("nav.current")}</span>}
                {entry.locked && <span className="nav-visibility-current">{t("nav.locked")}</span>}
                {!sortable && !entry.locked && (
                  <span className="nav-visibility-fixed">{t("nav.fixedPosition")}</span>
                )}
                {!visible && <span className="nav-visibility-hidden">{t("nav.hidden")}</span>}
              </span>
              <span className="nav-visibility-actions">
                {sortable && (
                  <>
                    <button
                      type="button"
                      className="nav-visibility-move"
                      onClick={() => onMove(entry, -1)}
                      disabled={!visible || !prevSortable || busy}
                      aria-label={t("nav.moveUp", { label: navLabel(entry, t) })}
                    >
                      <ArrowUp size={12} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="nav-visibility-move"
                      onClick={() => onMove(entry, 1)}
                      disabled={!visible || !nextSortable || busy}
                      aria-label={t("nav.moveDown", { label: navLabel(entry, t) })}
                    >
                      <ArrowDown size={12} aria-hidden="true" />
                    </button>
                  </>
                )}
                <Switch
                  checked={visible}
                  disabled={!settingsReady || busy || entry.locked}
                  ariaLabel={
                    entry.locked
                      ? t("nav.lockedAria", { label: navLabel(entry, t) })
                      : t("nav.toggleAria", { label: navLabel(entry, t) })
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
          aria-label={t("nav.resetAria", { surface: surfaceLabel(surface) })}
        >
          <RotateCcw size={12} /> {t("nav.reset", { surface: surfaceLabel(surface) })}
        </button>
        {!settingsReady && <span className="setting-note">{t("nav.settingsNotLoaded")}</span>}
      </div>

      {surface === "capsule" && visibleEntries.length === 0 && (
        <div className="setting-note">{t("nav.capsuleAllHidden")}</div>
      )}

      {error && (
        <div className="setting-note nav-visibility-error" role="alert">
          {t("nav.saveFailed", { error })}
        </div>
      )}
    </div>
  );
}
