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
//! - 隐藏当前所在页时的安全切页由 `FullView` 统一处理（配置变更驱动）；
//!   本区块只负责写配置，避免两处实现用不同快照各自切页；
//! - 写入串行化：写库期间所有开关/排序/恢复按钮一致禁用并显示进行中状态，
//!   不存在「可点击但被静默丢弃」的操作；保存失败就地提示，界面仍显示后端真实配置。

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

  const [surface, setSurface] = useState<NavSurface>("left");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 写入期间**全部**配置操作禁用：旧实现只禁用当前行，其它行仍可点击，
  // 但处理函数在 pendingId 非空时直接返回 —— 点击被静默丢弃。
  // 现在「可点击」与「会被执行」严格等价（串行写入链本身已保证读-改-写不覆盖）。
  const busy = pendingId !== null;

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

  // 隐藏当前所在页的恢复由 `FullView` 统一处理（导航配置变更驱动，唯一实现点）：
  // 这里只负责写入配置，不在局部路径里另做一次切页（旧快照 + 双实现会互相覆盖）。
  async function onToggle(entry: NavEntry, nextVisible: boolean) {
    if (busy || entry.locked) return;
    setPendingId(entry.id);
    setError(null);
    try {
      await setNavigationEntryVisible(surface, entry.id, nextVisible);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPendingId(null);
    }
  }

  async function onMove(entry: NavEntry, delta: -1 | 1) {
    if (busy || entry.locked) return;
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
    if (busy) return;
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

      <div className="nav-visibility-list" aria-busy={busy}>
        {rows.map((entry) => {
          const visible = layout[surface].includes(entry.id);
          const index = visibleEntries.findIndex((item) => item.id === entry.id);
          const current = surface === "left" && entry.id === currentEntryId;
          // 写入期间所有行一致禁用（busy 是整块状态）：不出现「点了但被丢弃」的行间差异。
          // 排序规则与底层 `moveNavigationEntry` 共用同一份元数据：
          // 锁定入口与胶囊 Agent 状态球不提供上移/下移按钮（不暴露无效操作）；
          // 固定入口不是障碍——普通入口可以跨过它排序，因此边界按
          // 「可排序子序列内是否还有前/后邻居」判断，而不是相邻项，
          // 保证按钮可用性与实际可移动性一致。
          const sortable = isEntrySortable(entry, surface);
          const prevSortable =
            index > 0 &&
            visibleEntries.slice(0, index).some((item) => isEntrySortable(item, surface));
          const nextSortable =
            index >= 0 &&
            visibleEntries
              .slice(index + 1)
              .some((item) => isEntrySortable(item, surface));
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
        {settingsReady && busy && (
          <span className="setting-note" role="status">
            {t("nav.saving")}
          </span>
        )}
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
