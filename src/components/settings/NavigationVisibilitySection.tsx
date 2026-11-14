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
//! - 隐藏当前所在页时的安全切页由 `FullView` 统一处理（配置变更驱动）；
//!   本区块只负责写配置，避免两处实现用不同快照各自切页；
//! - 写入串行化：写库期间开关/恢复按钮一致禁用并显示进行中状态，不存在
//!   「可点击但被静默丢弃」的操作；保存失败就地提示，界面仍显示后端真实配置。
//!
//! 排序交互（2026-11-13 全面优化，状态仍只有 `navigation_layout` 一份真源）：
//! - **拖拽**：左侧手柄或行内非交互区起拖，其它行平滑让位，靠近边缘自动滚动，
//!   Esc 取消；拖拽期间不改顺序数组，松手才落库一次（无中途写库/无重排抖动）；
//! - **上/下箭头**：单击移动一格；按住 400ms 后每 140ms 连续移动，会话锁定
//!   稳定入口 ID，行移动后按钮仍被指针捕获，不会「丢失操作目标」；
//! - **固定调整条**：任一入口进入调整态后，列表下方出现位置固定的上/下按钮，
//!   连续微调时鼠标不必追随移动的箭头；不遮挡名称、快捷键与开关；
//! - **键盘**：行内 Alt+↑ / Alt+↓ 调整，排序后焦点按稳定 ID 回到同一逻辑按钮；
//!   `aria-live` 播报新位置，手柄按钮提供键盘可达的调整入口；
//! - **滚动**：只滚排序列表自身；目标项仍在可视区时不改变滚动位置，越界才
//!   做最小必要滚动，绝不每移动一次就居中。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowDown, ArrowUp, GripVertical, RotateCcw } from "lucide-react";
import { Switch } from "../ui";
import { useUiStore } from "../../store/useUiStore";
import { useSettingsStore } from "../../store/useSettingsStore";
import { errorMessage } from "../../lib/errors";
import {
  entriesForSurface,
  isEntrySortable,
  leftEntryForTab,
  navEntry,
  navLabel,
  type NavEntry,
  type NavSurface,
} from "../../lib/navigationRegistry";
import { resetNavigationSurface, setNavigationEntryVisible, useNavigationLayout } from "../../lib/navigationLayout";
import { useNavOrderDraft } from "../../hooks/useNavOrderDraft";
import { useNavStepRepeat } from "../../hooks/useNavStepRepeat";
import { useNavDragSort } from "../../hooks/useNavDragSort";
import { useLocale } from "../../hooks/useLocale";

export default function NavigationVisibilitySection() {
  const { t } = useLocale();
  // `t` 每次渲染可能是新函数；播报/拖拽回调读取最新值但不进入 effect 依赖，
  // 避免语言切换时反复重置播报定时器。
  const tRef = useRef(t);
  tRef.current = t;
  const surfaceLabel = (surface: NavSurface) =>
    surface === "left" ? t("nav.surface.left") : t("nav.surface.capsule");
  const settingsReady = useSettingsStore((s) => !!s.settings);
  const layout = useNavigationLayout();
  const tab = useUiStore((s) => s.tab);

  const [surface, setSurface] = useState<NavSurface>("left");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 连续调整态：被选中的入口（稳定 ID），无值时列表下方不显示固定调整条。
  const [activeId, setActiveId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // 写入期间**全部**配置操作禁用：旧实现只禁用当前行，其它行仍可点击，
  // 但处理函数在 pendingId 非空时直接返回 —— 点击被静默丢弃。
  // 现在「可点击」与「会被执行」严格等价（串行写入链本身已保证读-改-写不覆盖）。
  const busy = pendingId !== null;

  const listRef = useRef<HTMLDivElement | null>(null);
  const adjustRef = useRef<HTMLDivElement | null>(null);
  const adjustScrolledIdRef = useRef<string | null>(null);
  // 长按会话的「离开即停止」边界用整个区块：固定调整条在列表之外，
  // 若只按列表判定，按下调整条按钮后的轻微移动会立刻中断连续移动。
  const sectionRef = useRef<HTMLDivElement | null>(null);
  // 拖拽/长按结束后需要保持可见、也要保持焦点：都按稳定 ID 定位，不依赖索引。
  const lastMovedRef = useRef<string | null>(null);
  const focusTargetRef = useRef<{ id: string; action: string } | null>(null);
  // 拖拽结束后浏览器仍会补一个 click：用它避免「刚拖完就进入调整态」的误触发。
  const dragEndedAtRef = useRef(0);
  const [moveTick, setMoveTick] = useState(0);

  const isFixed = useCallback(
    (id: string) => {
      const entry = navEntry(id);
      return !entry || !isEntrySortable(entry, surface);
    },
    [surface],
  );
  const onDraftError = useCallback((message: string) => setError(message), []);

  const {
    ids: orderIds,
    move,
    moveTo,
    flush,
  } = useNavOrderDraft(surface, layout[surface], isFixed, onDraftError);

  const currentEntryId = leftEntryForTab(tab)?.id;
  const surfaceEntries = entriesForSurface(surface);
  const visibleEntries = orderIds
    .map((id) => surfaceEntries.find((entry) => entry.id === id))
    .filter((entry): entry is NavEntry => entry !== undefined);
  // 隐藏项排在可见项之后（默认顺序），恢复显示时按默认顺序插回。
  // 锁定入口（设置）不在隐藏列表里：它始终可见，也不允许被关掉。
  const hiddenEntries = surfaceEntries.filter(
    (entry) => !entry.locked && !orderIds.includes(entry.id),
  );
  const rows = [...visibleEntries, ...hiddenEntries];

  /** 一步移动：长按重复、单击、键盘与拖拽共用同一入口。 */
  const step = useCallback(
    (id: string, delta: -1 | 1) => {
      const activeElement = document.activeElement as HTMLElement | null;
      const action = activeElement?.closest<HTMLElement>("[data-nav-action]")?.dataset.navAction;
      const inSameRow = !!activeElement?.closest(`[data-nav-entry="${id}"]`);
      const moved = move(id, delta);
      if (!moved) return false;
      // 行会随排序移动，DOM 节点被 React 搬走后焦点会落到 body：
      // 记录「同一行 + 同一逻辑按钮」，渲染完成后按稳定 ID 还原焦点。
      if (inSameRow && action) focusTargetRef.current = { id, action };
      lastMovedRef.current = id;
      setActiveId(id);
      setMoveTick((tick) => tick + 1);
      return true;
    },
    [move],
  );

  const repeat = useNavStepRepeat({ step, disabled: busy, boundsRef: sectionRef });

  const drag = useNavDragSort({
    listRef,
    orderIds,
    isFixed,
    disabled: busy,
    onDrop: (id, toIndex) => {
      dragEndedAtRef.current = Date.now();
      if (!moveTo(id, toIndex)) return;
      lastMovedRef.current = id;
      setMoveTick((tick) => tick + 1);
    },
    onCancel: () => {
      dragEndedAtRef.current = Date.now();
      setAnnouncement(tRef.current("nav.dragCancelled"));
    },
  });

  /** 拖拽收尾后浏览器补发的 click 不再当作「选中该行」。 */
  function swallowPostDragClick(): boolean {
    return Date.now() - dragEndedAtRef.current < 300;
  }

  // 排序后按稳定 ID 还原焦点（React 搬动节点会让焦点回落到 body）。
  useLayoutEffect(() => {
    const target = focusTargetRef.current;
    if (!target) return;
    focusTargetRef.current = null;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-nav-entry="${target.id}"]`);
    if (!row) return;
    const fallback = target.action === "up" ? "down" : "up";
    for (const action of [target.action, fallback, "handle"]) {
      const element = row.querySelector<HTMLButtonElement>(`[data-nav-action="${action}"]`);
      if (element && !element.disabled) {
        element.focus({ preventScroll: true });
        return;
      }
    }
    row.focus({ preventScroll: true });
  }, [orderIds]);

  // 最小必要滚动：目标仍在可视区不动；越出上下边缘才补足差额，绝不居中。
  useLayoutEffect(() => {
    if (moveTick === 0) return;
    const id = lastMovedRef.current;
    const container = listRef.current;
    if (!id || !container) return;
    const row = container.querySelector<HTMLElement>(`[data-nav-entry="${id}"]`);
    if (!row) return;
    const padding = 6;
    const rowRect = row.getBoundingClientRect();
    const box = container.getBoundingClientRect();
    // 折叠 / 隐藏时分组的尺寸为 0：不做任何滚动补偿，避免把 scrollTop 拉负。
    if (box.height <= 0) return;
    if (rowRect.top < box.top + padding) {
      container.scrollTop -= box.top + padding - rowRect.top;
    } else if (rowRect.bottom > box.bottom - padding) {
      container.scrollTop += rowRect.bottom - (box.bottom - padding);
    }
  }, [moveTick, orderIds]);

  // 位置播报：连续长按 120–160ms 一步，逐格朗读会互相打断；
  // 统一在最后一次移动后 220ms 播报一次最终位置。
  useEffect(() => {
    if (moveTick === 0) return;
    const id = lastMovedRef.current;
    if (!id) return;
    const index = orderIds.indexOf(id);
    const entry = navEntry(id);
    if (index < 0 || !entry) return;
    const timer = window.setTimeout(() => {
      const translate = tRef.current;
      setAnnouncement(
        translate("nav.movedTo", {
          label: navLabel(entry, translate),
          index: index + 1,
          total: orderIds.length,
        }),
      );
    }, 220);
    return () => window.clearTimeout(timer);
  }, [moveTick, orderIds]);

  // 调整条首次出现时保证可见：长列表里它可能刚好落在视口外（操作目标反而不可见）。
  // 只在进入某个入口的调整态时做一次最小必要滚动，不随每次上移/下移滚动页面，
  // 更不会为了固定按钮把整个列表反复居中。
  useLayoutEffect(() => {
    if (!activeId) {
      adjustScrolledIdRef.current = null;
      return;
    }
    if (adjustScrolledIdRef.current === activeId) return;
    adjustScrolledIdRef.current = activeId;
    const bar = adjustRef.current;
    if (bar && typeof bar.scrollIntoView === "function") {
      bar.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activeId]);

  // 调整态目标失效（被隐藏 / 切到另一界面 / 恢复默认）时自动收起调整条。
  useEffect(() => {
    if (!activeId) return;
    const entry = navEntry(activeId);
    if (!entry || !orderIds.includes(activeId) || !isEntrySortable(entry, surface)) {
      setActiveId(null);
    }
  }, [activeId, orderIds, surface]);

  // 隐藏当前所在页的恢复由 `FullView` 统一处理（导航配置变更驱动，唯一实现点）：
  // 这里只负责写入配置，不在局部路径里另做一次切页（旧快照 + 双实现会互相覆盖）。
  async function onToggle(entry: NavEntry, nextVisible: boolean) {
    if (busy || entry.locked) return;
    setPendingId(entry.id);
    setError(null);
    try {
      // 先把未落库的排序写完，显隐写入才不会用旧顺序覆盖用户刚做的调整。
      await flush();
      await setNavigationEntryVisible(surface, entry.id, nextVisible);
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
      await flush();
      await resetNavigationSurface(surface);
      setActiveId(null);
      if (listRef.current) listRef.current.scrollTop = 0;
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPendingId(null);
    }
  }

  async function onSurfaceChange(next: NavSurface) {
    if (next === surface) return;
    // 拖拽/长按正在进行的会话属于旧界面，先收尾再切换，避免把 A 的顺序落到 B。
    drag.cancel();
    repeat.stop();
    setActiveId(null);
    setError(null);
    try {
      await flush();
    } catch {
      // flush 内部已就地反馈失败；切换界面本身不受影响
    }
    setSurface(next);
  }

  /** 行内 Alt+↑ / Alt+↓ 与 Esc 退出调整态（拖拽的 Esc 由拖拽会话自行处理）。 */
  function onListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      if (drag.draggingId) return;
      if (!activeId) return;
      event.stopPropagation();
      setActiveId(null);
      return;
    }
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-nav-entry]");
    const id = row?.dataset.navEntry;
    if (!id || !orderIds.includes(id) || isFixed(id)) return;
    event.preventDefault();
    step(id, event.key === "ArrowUp" ? -1 : 1);
  }

  const activeEntry = activeId
    ? surfaceEntries.find((entry) => entry.id === activeId && orderIds.includes(entry.id))
    : undefined;
  const activeSortable = !!activeEntry && isEntrySortable(activeEntry, surface);
  const activeIndex = activeEntry ? visibleEntries.findIndex((e) => e.id === activeEntry.id) : -1;
  const activePrev =
    activeIndex > 0 &&
    visibleEntries.slice(0, activeIndex).some((item) => isEntrySortable(item, surface));
  const activeNext =
    activeIndex >= 0 &&
    visibleEntries.slice(activeIndex + 1).some((item) => isEntrySortable(item, surface));

  return (
    <div className="nav-visibility-body" ref={sectionRef}>
      <div className="nav-visibility-tabs" role="group" aria-label={t("nav.surfaceAria")}>
        {(["left", "capsule"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={`btn sm${surface === value ? " primary" : ""}`}
            aria-pressed={surface === value}
            onClick={() => void onSurfaceChange(value)}
          >
            {surfaceLabel(value)}
          </button>
        ))}
      </div>
      <p className="nav-visibility-hint" id="nav-visibility-hint">
        {surface === "left" ? t("nav.hint.left") : t("nav.hint.capsule")} {t("nav.hint.reorder")}
      </p>

      <div className="nav-visibility-summary">
        <span>{t("nav.summary", { visible: visibleEntries.length, total: surfaceEntries.length })}</span>
        <span className="nav-visibility-preview">
          {visibleEntries.length > 0
            ? visibleEntries.map((entry) => navLabel(entry, t)).join(t("nav.listSeparator"))
            : t("nav.previewEmpty")}
        </span>
      </div>

      <div
        className={`nav-visibility-list${drag.draggingId ? " is-dragging" : ""}`}
        ref={listRef}
        aria-busy={busy}
        aria-describedby="nav-visibility-hint"
        onKeyDown={onListKeyDown}
      >
        {drag.dropLineTop !== null && (
          <div
            className="nav-visibility-drop-line"
            style={{ top: drag.dropLineTop }}
            aria-hidden="true"
          />
        )}
        {rows.map((entry) => {
          const visible = orderIds.includes(entry.id);
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
            visibleEntries.slice(index + 1).some((item) => isEntrySortable(item, surface));
          const label = navLabel(entry, t);
          const dragging = drag.draggingId === entry.id;
          const shift = drag.shifts.get(entry.id) ?? 0;
          // 拖拽期间不叠加调整态高亮：同屏只保留一个强强调（被拖行）。
          const active =
            activeId === entry.id && visible && sortable && drag.draggingId === null;
          const translate = dragging ? drag.offsetY : shift;
          const rowClass = [
            "setting-row",
            "nav-visibility-row",
            active ? "is-active" : "",
            dragging ? "is-dragging" : "",
            repeat.repeatingId === entry.id ? "is-repeating" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              className={rowClass}
              key={entry.id}
              data-nav-entry={entry.id}
              tabIndex={-1}
              style={translate !== 0 ? { transform: `translateY(${translate}px)` } : undefined}
              onPointerDown={(event) => {
                if (!visible || !sortable || busy) return;
                // 触屏的行体位移留给列表纵向滚动，只允许手柄起拖（手柄 touch-action: none）。
                if (event.pointerType === "touch") return;
                const target = event.target as HTMLElement;
                // 开关 / 箭头 / 手柄 / 快捷键标签各有语义，绝不当作拖拽起点。
                if (target.closest("button, label, input, kbd, [role='switch']")) return;
                drag.beginDrag(event, entry.id);
              }}
              onClick={(event) => {
                if (!visible || !sortable || busy) return;
                if (swallowPostDragClick()) return;
                const target = event.target as HTMLElement;
                if (target.closest("button, label, input, kbd, [role='switch']")) return;
                setActiveId(entry.id);
              }}
            >
              <span className="nav-visibility-entry">
                {sortable && visible ? (
                  <button
                    type="button"
                    className="nav-visibility-handle"
                    data-nav-action="handle"
                    aria-label={t("nav.dragHandle", { label })}
                    data-tip={t("nav.dragHint")}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      drag.beginDrag(event, entry.id);
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (swallowPostDragClick()) return;
                      setActiveId(entry.id);
                    }}
                  >
                    <GripVertical size={12} aria-hidden="true" />
                  </button>
                ) : (
                  <span className="nav-visibility-handle is-static" aria-hidden="true" />
                )}
                <entry.icon
                  size={14}
                  strokeWidth={1.6}
                  className="nav-visibility-entry-icon"
                  aria-hidden="true"
                />
                <span className="nav-visibility-entry-label">{label}</span>
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
                      data-nav-action="up"
                      // 按下即移动一格；按住进入连续移动。行随排序移动也不会丢失目标：
                      // 会话锁定稳定 ID，指针捕获让事件继续回到同一个按钮节点。
                      onPointerDown={(event) => repeat.start(event, entry.id, -1)}
                      onClick={(event) => {
                        // 键盘激活（detail=0）没有 pointerdown，按单击补一步。
                        if (event.detail === 0) step(entry.id, -1);
                      }}
                      onContextMenu={(event) => {
                        if (repeat.repeatingId === entry.id) event.preventDefault();
                      }}
                      disabled={!visible || !prevSortable || busy}
                      aria-label={t("nav.moveUp", { label })}
                    >
                      <ArrowUp size={12} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="nav-visibility-move"
                      data-nav-action="down"
                      onPointerDown={(event) => repeat.start(event, entry.id, 1)}
                      onClick={(event) => {
                        if (event.detail === 0) step(entry.id, 1);
                      }}
                      onContextMenu={(event) => {
                        if (repeat.repeatingId === entry.id) event.preventDefault();
                      }}
                      disabled={!visible || !nextSortable || busy}
                      aria-label={t("nav.moveDown", { label })}
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
                      ? t("nav.lockedAria", { label })
                      : t("nav.toggleAria", { label })
                  }
                  onChange={(next) => void onToggle(entry, next)}
                />
              </span>
            </div>
          );
        })}
      </div>

      {activeEntry && activeSortable && (
        // 位置固定的调整条：不随行移动，连续微调时鼠标/手指停在同一处；
        // 只在调整态出现，不常驻占位，也不覆盖名称、快捷键与开关。
        <div
          className="nav-visibility-adjust"
          ref={adjustRef}
          role="group"
          aria-label={t("nav.adjustGroup", { label: navLabel(activeEntry, t) })}
        >
          <span className="nav-visibility-adjust-text">
            <span className="nav-visibility-adjust-label">
              {t("nav.adjusting", { label: navLabel(activeEntry, t) })}
            </span>
            <span className="nav-visibility-adjust-pos">
              {t("nav.adjustPosition", {
                index: activeIndex + 1,
                total: visibleEntries.length,
              })}
            </span>
          </span>
          <span className="nav-visibility-adjust-actions">
            <button
              type="button"
              className="nav-visibility-move"
              data-nav-action="adjust-up"
              onPointerDown={(event) => repeat.start(event, activeEntry.id, -1)}
              onClick={(event) => {
                if (event.detail === 0) step(activeEntry.id, -1);
              }}
              onContextMenu={(event) => {
                if (repeat.repeatingId === activeEntry.id) event.preventDefault();
              }}
              disabled={!activePrev || busy}
              aria-label={t("nav.adjustUp", { label: navLabel(activeEntry, t) })}
            >
              <ArrowUp size={12} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="nav-visibility-move"
              data-nav-action="adjust-down"
              onPointerDown={(event) => repeat.start(event, activeEntry.id, 1)}
              onClick={(event) => {
                if (event.detail === 0) step(activeEntry.id, 1);
              }}
              onContextMenu={(event) => {
                if (repeat.repeatingId === activeEntry.id) event.preventDefault();
              }}
              disabled={!activeNext || busy}
              aria-label={t("nav.adjustDown", { label: navLabel(activeEntry, t) })}
            >
              <ArrowDown size={12} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn sm nav-visibility-adjust-done"
              onClick={() => setActiveId(null)}
            >
              {t("nav.adjustDone")}
            </button>
          </span>
        </div>
      )}

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

      {/* 排序结果的无障碍播报：只播报最终位置，长按过程中不逐格朗读。
          只用 aria-live（不叠 role="status"）：本区块已有写入中的 status 提示，
          再来一个 status 会让 `getByRole("status")` 命中多个节点。 */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </div>
  );
}
