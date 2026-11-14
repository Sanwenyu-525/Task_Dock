//! 完整模式：左侧垂直导航 + 任务 / Agent / 应用 / 微件 / 行动 / 剪贴板 / 收集与暂存 / 工作流 / 历史 / 规划中心 / 帮助 / 诊断中心 / 资源管理 / 设置
//! **十四个声明视觉入口（其中帮助与诊断中心默认隐藏；默认渲染 11 个滚动项 + 设置固定入口）**。
//! 应用中心（v0.10）复用既有导航目标体系，三端（侧栏 / 胶囊 / 设置）共享同一份数据。
//!
//! v0.6：由顶部横向标签改为**左侧垂直导航**（两套视觉预设共用同一结构）。
//! - 图标 + 文字，选中态由预设决定（梦幻渐变=淡色药丸，液态玻璃=玻璃胶囊）
//! - 徽标口径与行动中心一致（见下），不新造第二套计数
//! - 「新建任务」置于导航顶部，仅图标（可访问名由 aria-label 提供），复用 Ctrl+K / 标题栏的快速添加行为
//! - 窄窗（< 380px）时只留图标，避免挤压右侧统计卡与筛选行
//! - v0.6：剪贴板正式成为第 4 个入口（不再是覆盖整屏的抽屉）
//! - v0.7：新增「收集箱」与「规划中→规划中心」入口
//! - v0.8：新增「暂存架」入口，随后与收集箱**合并为「收集与暂存」单一视觉入口**
//!   （页面内双子页签：快速收集 | 文件暂存）。
//! - v0.10：新增「应用」视觉入口（Agent 之后、行动之前）
//! - v0.11：新增「帮助」视觉入口（规划中心之后、设置之前，不占 Ctrl+数字）
//! - v0.14：新增「诊断中心」视觉入口（帮助之后、设置之前，默认隐藏，不占 Ctrl+数字）
//! - v0.14：新增「资源管理」视觉入口（设置之前、默认可见、可隐藏/排序，不占 Ctrl+数字）
//!
//! 逻辑 Tab 与快捷键：`TAB_ORDER` 仍是 10 个逻辑 Tab（快捷键 Ctrl+1…9 与 Ctrl+0 的
//! 事实源，Ctrl+5=快速收集、Ctrl+6=文件暂存）；「应用 / 微件 / 帮助 / 诊断中心 / 资源管理」
//! 只是视觉入口，**不占用 Ctrl+数字**，已有快捷键语义不漂移。视觉合并只发生在导航渲染层。
//!
//! 入口元数据统一来自 `src/lib/navigationRegistry.ts`，用户显隐/排序来自 SQLite
//! 设置 `navigation_layout`（见 `src/lib/navVisibility.ts`）；本文件不保留第二份入口清单。
//!
//! 徽标口径：合并入口徽标 = 未处理捕获条数（useCaptureStore.inboxCount），
//! 即「待处理收集内容」；暂存条目总数**不计入**未处理徽标。

import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useUiStore, type Tab } from "../store/useUiStore";
import { useTasksStore } from "../store/useTasksStore";
import { useActionsStore, attentionCount } from "../store/useActionsStore";
import { useCaptureStore } from "../store/useCaptureStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { useFullViewVisible } from "../hooks/useMainUiVisible";
// 高频页（任务 / Agent / 行动 / 剪贴板 / 收集与暂存）保持同步加载，避免切页白屏；
// 低频页按需加载，降低首屏主包体积（轻量化专项 B）。打包后仍是本地资源，离线可用。
import TasksPanel from "./tasks/TasksPanel";
import AgentPanel from "./agents/AgentPanel";
import ActionCenterPanel from "./actions/ActionCenterPanel";
import ClipboardPanel from "./clipboard/ClipboardPanel";
import CollectionPanel from "./collection/CollectionPanel";
import TabLeaveGuard from "./TabLeaveGuard";
import ErrorBoundary from "./ErrorBoundary";
import WorkbenchHandoff from "./workbench/WorkbenchHandoff";

import { Plus, MoreHorizontal, Settings2 } from "lucide-react";
import { DropdownMenu } from "./ui";
import { railTipPlacement } from "./capsule/CapsuleRail";
import {
  entriesForSurface,
  leftEntryForTab,
  lockedEntryIds,
  navEntry,
  navLabel,
  type NavEntry,
} from "../lib/navigationRegistry";
import { useNavigationLayout } from "../lib/navigationLayout";
import { safeTabForHiddenEntry } from "../lib/navVisibility";
import { useLocale } from "../hooks/useLocale";

import { requestSettingsSectionReveal } from "../lib/settingsSections";
import type { WorkbenchRoute } from "../lib/workbenchLayout";

const SettingsPanel = lazy(() => import("./settings/SettingsPanel"));

// Phase D：这些功能的完整管理界面只存在于唯一大型工作台。主窗口保留导航
// 位置、徽标与快捷键，但页面退化为兼容入口（摘要 + 打开工作台），不再挂载
// 第二套完整宿主。任务/Agent/行动/剪贴板/收集与暂存是胶囊快捷面的一部分，
// 设置是主窗口自身窗口与外观配置的入口，继续保留。
const WORKBENCH_ONLY_TABS = new Set<Tab>([
  "workbench",
  "workspace",
  "apps",
  "widgets",
  "mobile",
  "workflows",
  "history",
  "roadmap",
  "help",
  "diagnostics",
  "resource",
]);

// 注册中心声明顺序不是展示顺序：左侧入口统一按默认顺序读取，用户排序在渲染时覆盖。
const LEFT_ENTRIES = entriesForSurface("left");

// 完整悬浮栏（自由位置、未贴边停靠）：提示方向保持原有语义「图标右侧」，
// 不套用停靠四边朝内映射；形态显式传给纯函数，避免靠 edge 值推断。
const FLOATING_TIP_PLACEMENT = railTipPlacement("floating", null, false);

export default function FullView() {
  const { t } = useLocale();
  const tab = useUiStore((s) => s.tab);
  const setTab = useUiStore((s) => s.setTab);
  const collectionSub = useUiStore((s) => s.collectionSub);
  const setCollectionSub = useUiStore((s) => s.setCollectionSub);
  const bumpQuickAdd = useUiStore((s) => s.bumpQuickAdd);
  const stats = useTasksStore((s) => s.stats);
  const actionFeed = useActionsStore((s) => s.feed);
  const loadActions = useActionsStore((s) => s.load);
  const inboxCount = useCaptureStore((s) => s.inboxCount);
  const refreshInboxCount = useCaptureStore((s) => s.refreshInboxCount);

  // 进入完整模式先拿一次未处理计数（徽标）；条目列表在进入收集箱时由面板加载。
  useEffect(() => {
    void refreshInboxCount();
  }, [refreshInboxCount]);

  // 完整面板当前是否可见（mode=full 且未停靠）：DeferredView 保活下，
  // 模式切换/停靠期页面组件仍是挂载态，页面级可选刷新以此做消费者门控。
  const fullVisible = useFullViewVisible();

  // 两个徽标共用行动中心口径：需介入（未确认），不再用原始 waiting/failed 计数，
  // 避免同一状态在标签页与行动中心显示两个不同的数字。
  // 行动中心整体关闭或临时暂停时两个徽标都归零：暂停期间不展示可能过期的
  // 自动聚合计数（历史仍可在行动中心手动查看）。
  const pending = stats?.pending ?? 0;
  const actionsPaused = useSettingsStore((s) => s.settings?.actions_paused === true);
  const actionsEnabled = actionFeed?.enabled !== false && !actionsPaused;
  const intervention = actionsEnabled ? actionFeed?.counts.intervention ?? 0 : 0;
  const actions = actionsEnabled ? attentionCount(actionFeed) : 0;

  const counts = { intervention, attention: actions, pending, inbox: inboxCount };

  // ── 导航轨溢出兜底（验收 UI-01）───────────────────────────────────
  // 默认窗口高度下 12 个入口放不进 304px 的可视区，而滚动条被隐藏。
  // 这里测量「几何上不可见的入口」，把它们补进「更多」菜单，并在可滚动时
  // 给轨道底部加渐隐；切页时把当前入口滚回视口，避免"当前页入口消失"。
  const railItemsRef = useRef<HTMLDivElement | null>(null);
  const [railScrollable, setRailScrollable] = useState(false);
  const [overflowEntryIds, setOverflowEntryIds] = useState<string[]>([]);

  // ── 导航显隐与排序（统一导航架构）──────────────────────────────────
  // 只影响左侧导航的渲染：被隐藏的页面仍按 tab 渲染，快捷键/通知跳转照常可用。
  // 当前页入口若被隐藏，**绝不临时插回侧栏**：其余图标位置保持稳定，避免布局
  // 跳动；当前页选中态由「更多」触发按钮承担，菜单内该项以单选勾选显示。
  // 排序来自配置数组顺序；过滤用数组过滤，禁止用 CSS 隐藏代替。
  // 锁定入口（设置）**不在中间滚动列表渲染**：它固定在最底部区域，不参与排序。
  const layout = useNavigationLayout();
  const lockedIds = lockedEntryIds("left");
  const currentEntry = leftEntryForTab(tab);
  const currentHidden = !!currentEntry && !layout.left.includes(currentEntry.id);

  // ── 隐藏当前入口后的安全恢复（导航配置变更驱动，唯一实现点）──────────
  // 只在「当前页所属入口由可见变为隐藏」这一次配置变更上触发一次：
  // - 从「更多」/快捷键/通知/深链主动打开本来就隐藏的页面时**没有**可见→隐藏
  //   迁移，因此不会被强制重定向（隐藏 ≠ 禁止访问）；
  // - 不做「持续检查 tab 是否可见并强制纠正」的 Effect（那会让隐藏功能无法通过
  //   「更多」进入），也不依赖设置页的局部操作路径（旧实现只覆盖该路径，且用的是
  //   写入前的旧快照，连续操作时可能选到刚被隐藏的页面）。
  // 切页仍走 `setTab` 门禁：未保存草稿 → pending（等用户确认/取消）、保存中 →
  // blocked（store 已就地提示）。绝不为恢复导航丢弃用户编辑内容；用户取消后停留
  // 在原页是安全的（页面仍可编辑/保存，设置入口始终可达）。
  const entryState = { id: currentEntry?.id ?? null, hidden: currentHidden };
  const prevEntryState = useRef(entryState);
  useEffect(() => {
    const prev = prevEntryState.current;
    prevEntryState.current = entryState;
    if (!currentEntry || !currentHidden) return;
    if (prev.id !== currentEntry.id || prev.hidden) return;
    const target = safeTabForHiddenEntry(layout, collectionSub);
    const result = setTab(target);
    // 合并入口的「快速笔记」子页没有独立逻辑 Tab：切页会把子页重置为 inbox，
    // 切页成功后再恢复笔记子页，避免恢复导航顺带丢失子页状态。
    if (
      result === "switched" &&
      collectionSub === "notes" &&
      (target === "inbox" || target === "shelf")
    ) {
      setCollectionSub("notes");
    }
  }, [currentEntry, currentHidden, layout, collectionSub, setTab, setCollectionSub]);

  // ── 行动中心徽标的消费者恢复路径 ──────────────────────────────────
  // App 的事件聚合刷新按消费者门控（shouldRefreshActions）：入口隐藏 /
  // 行动页未打开 / 停靠隐藏期间计数停更。这里在「徽标重新有消费者」时补一次，
  // 覆盖：重新显示入口、切到行动页、解除停靠、从其他模式回到完整模式。
  const badgeConsumer = fullVisible && (layout.left.includes("actions") || tab === "actions");
  const prevBadgeConsumer = useRef(badgeConsumer);
  useEffect(() => {
    // 暂停/停用期间消费者出现也不补自动聚合；恢复时由 App 的统一 effect 补一次。
    if (badgeConsumer && !prevBadgeConsumer.current && !actionsPaused) {
      void (actionFeed ? loadActions({ silent: true, countsOnly: true }) : loadActions());
    }
    prevBadgeConsumer.current = badgeConsumer;
  }, [badgeConsumer, actionFeed, loadActions, actionsPaused]);

  const entriesToRender = layout.left
    .filter((id) => !lockedIds.includes(id))
    .map((id) => navEntry(id))
    .filter((entry): entry is NavEntry => entry !== undefined);
  // 固定底部入口：锁定系统入口（设置）永远渲染在最底部，不属于滚动列表。
  const fixedEntries = lockedIds
    .map((id) => navEntry(id))
    .filter((entry): entry is NavEntry => entry !== undefined);
  // 「更多」列出全部被隐藏入口（含当前页），否则当前页隐藏时菜单会凭空消失。
  const hiddenEntries = LEFT_ENTRIES.filter((entry) => !layout.left.includes(entry.id));

  // 因窗口高度而被滚动裁掉的入口：与「配置隐藏」合并进同一菜单，
  // 用户不必先发现"轨道可以滚动"才能到达这些页面。
  const overflowEntries = entriesToRender.filter((entry) => overflowEntryIds.includes(entry.id));
  const menuEntries = [...hiddenEntries, ...overflowEntries];
  const leftLayoutKey = layout.left.join(",");

  useLayoutEffect(() => {
    const el = railItemsRef.current;
    if (!el) return;
    const measure = () => {
      // 用「内容坐标系」判断是否放得下，而不是当前视口：滚动不会改变
      // 「哪些入口装不下」的结论，菜单内容因此保持稳定。
      const box = el.getBoundingClientRect();
      const contentTop = box.top - el.scrollTop;
      const next: string[] = [];
      for (const item of el.querySelectorAll<HTMLElement>("[data-nav-id]")) {
        const rect = item.getBoundingClientRect();
        if (rect.top - contentTop + rect.height > el.clientHeight + 1) {
          next.push(item.dataset.navId ?? "");
        }
      }
      const ids = next.filter(Boolean);
      setRailScrollable(el.scrollHeight > el.clientHeight + 1);
      setOverflowEntryIds((prev) =>
        prev.length === ids.length && prev.every((id, i) => id === ids[i]) ? prev : ids,
      );
    };
    measure();
    // 窗口高度、入口显隐/排序、徽标宽度变化都会改变轨道内容高度。
    // jsdom 不实现 ResizeObserver（单测环境），有则观察、无则只靠 resize/tab 重测。
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [leftLayoutKey, entriesToRender.length, tab]);

  // 切页后确保当前入口在视口内：滚动位置不会因"切换页面"而丢失可见的选中态。
  useEffect(() => {
    const el = railItemsRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>('[aria-current="page"]');
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [tab, leftLayoutKey]);

  /** 打开视觉入口（合并入口回到上一次子页；笔记子页无逻辑 Tab，先落 inbox/shelf 再恢复）。 */
  function openEntry(entry: NavEntry) {
    if (entry.tabs.length > 1) {
      if (collectionSub === "notes") {
        setTab(entry.tabs[0]);
        setCollectionSub("notes");
        return;
      }
      setTab(collectionSub);
      return;
    }
    setTab(entry.tabs[0]);
  }

  return (
    <div className="full-view">
      <nav className="rail" aria-label={t("nav.main")}>
        <div className="rail-head">
          <button
            className="rail-new-task"
            data-tip={t("nav.newTaskTip")}
            data-tip-placement={FLOATING_TIP_PLACEMENT}
            aria-label={t("nav.newTask")}
            onClick={() => {
              setTab("tasks");
              bumpQuickAdd();
            }}
          >
            <Plus size={15} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </div>
        <div
          className={`rail-items${railScrollable ? " is-scrollable" : ""}`}
          ref={railItemsRef}
        >
          {entriesToRender.map((entry) => {
            const count = entry.badge ? counts[entry.badge] : 0;
            const active = entry.tabs.includes(tab);
            const label = navLabel(entry, t);
            // 徽标语义在提示条中如实说明：数字只代表待处理收集内容
            const tip =
              entry.id === "collection" && count > 0
                ? t("nav.pendingCollection", { label, count })
                : label;
            return (
              <button
                key={entry.id}
                data-nav-id={entry.id}
                className={`rail-item ${active ? "active" : ""}`}
                onClick={() => openEntry(entry)}
                aria-current={active ? "page" : undefined}
                // 窄窗下文字标签被隐藏，可访问名必须由 aria-label 兜底；
                // 提示条走统一的 data-tip（原生 title 会弹出系统样式提示）。
                aria-label={count > 0 ? t("nav.labelWithCount", { label, count }) : label}
                data-tip={tip}
                data-tip-placement={FLOATING_TIP_PLACEMENT}
              >
                <span className="rail-icon">
                  <entry.icon size={18} strokeWidth={1.75} />
                  {count > 0 && (
                    <em className={`rail-badge ${entry.badge === "pending" ? "subtle" : ""}`}>
                      {count > 99 ? "99+" : count}
                    </em>
                  )}
                </span>
                <span className="rail-label">{label}</span>
              </button>
            );
          })}
        </div>
        {/* 固定底部区域：不随中间列表滚动。
            「更多」在上（存在隐藏入口或窗口高度不足时出现），设置恒在最底部——
            系统入口不可隐藏/排序，任何窗口高度下都保持可达。 */}
        <div className="rail-foot">
          {menuEntries.length > 0 && (
            <div className="rail-more">
              <DropdownMenu
                menuLabel={t("nav.hiddenMenu")}
                placement="bottom-start"
                trigger={({ ref, expanded, onClick, onKeyDown }) => (
                  <button
                    ref={ref}
                    type="button"
                    className={`rail-item${currentHidden ? " active" : ""}`}
                    aria-current={currentHidden ? "page" : undefined}
                    aria-haspopup="menu"
                    aria-expanded={expanded}
                    aria-label={t("nav.moreAria")}
                    data-tip={t("nav.more")}
                    data-tip-placement={FLOATING_TIP_PLACEMENT}
                    onClick={onClick}
                    onKeyDown={onKeyDown}
                  >
                    <span className="rail-icon">
                      <MoreHorizontal size={18} strokeWidth={1.75} />
                    </span>
                    <span className="rail-label">{t("nav.more")}</span>
                  </button>
                )}
                items={[
                  ...menuEntries.map((entry) => ({
                    key: entry.id,
                    label: navLabel(entry, t),
                    icon: <entry.icon size={14} strokeWidth={1.6} />,
                    radio: true,
                    checked: entry.tabs.includes(tab),
                    onSelect: () => openEntry(entry),
                  })),
                  {
                    key: "__customize-navigation",
                    label: t("nav.customize"),
                    icon: <Settings2 size={14} />,
                    onSelect: () => {
                      setTab("settings");
                      // 跨模块定位：展开并滚动到「导航自定义」分区（不另建配置入口）。
                      requestSettingsSectionReveal("navigation");
                    },
                  },
                ]}
              />
            </div>
          )}
          {fixedEntries.map((entry) => {
            const active = entry.tabs.includes(tab);
            const label = navLabel(entry, t);
            return (
              <button
                key={entry.id}
                className={`rail-item rail-item-fixed ${active ? "active" : ""}`}
                onClick={() => openEntry(entry)}
                aria-current={active ? "page" : undefined}
                aria-label={label}
                data-tip={label}
                data-tip-placement={FLOATING_TIP_PLACEMENT}
              >
                <span className="rail-icon">
                  <entry.icon size={18} strokeWidth={1.75} />
                </span>
                <span className="rail-label">{label}</span>
              </button>
            );
          })}
        </div>
      </nav>
      {/* 内容区是主地标：读屏用户可按 landmark 直接跳到工作区（验收 UI-08）。
          页级 h1 只给读屏，不新增视觉 chrome（560 高窗口的密度已经偏紧）；
          可见页标题仍由各页自己的头部承担。 */}
      <main
        className={`tab-content tab-content-${tab}`}
        aria-labelledby="page-heading"
      >
        <h1 id="page-heading" className="sr-only">
          {currentEntry ? navLabel(currentEntry, t) : t("nav.tasks")}
        </h1>
        {/* 编辑中切换页面：由 store 门禁记录待决目标，这里统一确认，不各页重复拦截。 */}
        <TabLeaveGuard />
        {/* 内容区独立错误边界：单个页面渲染异常只替换内容区，标题栏与左侧导航
            保持可用；切页（resetKey=tab）或点重试即恢复，不重载整个窗口。 */}
        <ErrorBoundary
          scope={`完整面板/${tab}`}
          variant="compact"
          resetKey={tab}
          label={currentEntry ? navLabel(currentEntry, t) : undefined}
        >
          {/* 低频页首次进入时异步加载；fallback 只占位、不做持续动画，避免闪烁。 */}
          <Suspense fallback={<div className="panel-loading" role="status" aria-label={t("nav.loading")} />}>
            {WORKBENCH_ONLY_TABS.has(tab) && (
              <WorkbenchHandoff tab={tab as WorkbenchRoute} />
            )}
            {tab === "tasks" && <TasksPanel />}
            {tab === "agents" && <AgentPanel />}
            {tab === "actions" && <ActionCenterPanel />}
            {tab === "clipboard" && <ClipboardPanel />}
            {/* 收集与暂存：inbox / shelf 两个逻辑 Tab 共用同一组合页 */}
            {(tab === "inbox" || tab === "shelf") && <CollectionPanel />}
            {tab === "settings" && <SettingsPanel />}
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}
