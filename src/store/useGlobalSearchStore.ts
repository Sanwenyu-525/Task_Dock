//! 全局搜索状态：查询、防抖、乱序防护、分类筛选、最近搜索与统一跳转。
//!
//! 设计要点：
//! - 输入防抖 220ms（任务书建议 180–250ms）；请求代际 `seq` 保证旧响应不覆盖新结果。
//! - 弹窗关闭时清理防抖定时器；最近搜索持久化在 localStorage（见 globalSearchBridge）。
//! - 跳转集中在本 store 的 `openResult`：每个分类一条确定路径；不支持伪装成功。
//! - 「精确定位」经 `pendingLocate`（一次性意图 + token 自增）交给目标模块消费，
//!   消费后必须 `consumeLocate()` 清除（先例：useUiStore.agentFocus/appConfig）。
//! - 命令面板层（v0.16）：命令注册唯一事实源在 `lib/commandRegistry.ts`；本 store
//!   只负责组装静态命令 + 动态实体（场景/工作流，弹窗打开时用既有列表命令水合）
//!   与执行分发。命令匹配纯前端本地进行，不新增后端索引；键盘 ↑/↓/Enter 与数据
//!   结果共用同一 flat 序（命令组在前）。

import { create } from "zustand";

import {
  globalSearch,
  loadRecentSearches,
  persistRecentSearches,
  clearRecentSearches as clearRecentPersisted,
  saveRecentSearch,
  type GlobalSearchCategoryFilter,
  type GlobalSearchResult,
} from "../lib/globalSearchBridge";
import { navNavigate } from "../lib/navigation";
import {
  buildScenarioCommands,
  buildStaticCommands,
  buildWorkflowCommands,
  visibleCommands,
  type CommandDef,
} from "../lib/commandRegistry";
import { requestSettingsSectionReveal } from "../lib/settingsSections";
import { errorMessage } from "../lib/errors";
import { t as translate } from "../i18n";
import { fetchTask, resolveCommandPhrase, type PhraseResolution } from "../lib/bridge";
import { formatDue } from "../lib/format";
import { looksLikePhrase, phraseRowCount, priorityLabelKey } from "../lib/commandPhrases";
import { useUiStore } from "./useUiStore";
import { useScenarioStore } from "./useScenarioStore";
import { useTasksStore } from "./useTasksStore";
import { useWorkflowsStore } from "./useWorkflowsStore";

/** 目标模块消费的一次性定位意图。token 自增支持重复定位同一对象。 */
export interface GlobalSearchLocateIntent {
  category: string;
  /** 结果 id（通常即目标条目 id）。 */
  id: string;
  /** 结果子类型（task/session/run/snapshot/project/feature/milestone…）。 */
  kind: string;
  /** 父级 id（run→session、snapshot→task、feature/milestone→project）。 */
  parentId: string | null;
  /** 搜索词（目标模块可用来设置过滤，确保目标可见）。 */
  keyword: string;
  token: number;
}

const SEARCH_DEBOUNCE_MS = 220;
/** 句式解析防抖：比数据搜索更短，保证命令反馈跟手；后端解析是纯本地查库。 */
const PHRASE_DEBOUNCE_MS = 120;

interface GlobalSearchState {
  open: boolean;
  query: string;
  /** 仅筛选维度；"all" = 全部分类。 */
  activeCategory: GlobalSearchCategoryFilter;
  results: Awaited<ReturnType<typeof globalSearch>> | null;
  loading: boolean;
  error: string | null;
  activeIndex: number;
  recent: string[];
  pendingLocate: GlobalSearchLocateIntent | null;
  /** 交互提示（如应用启动失败原因），弹窗底部展示。 */
  notice: string | null;
  /**
   * 当前展示的命令列表（空查询 = 默认列表；有关键词 = 全量过滤后的前 N 条）。
   * flat 键盘序中位于数据结果之前。
   */
  commands: CommandDef[];
  /**
   * 句式命令解析结果。null = 帧表未命中/时间不可解析/整句标题冲突，
   * 一律按普通搜索处理（不提示错误、不改变搜索行为）。
   */
  phrase: PhraseResolution | null;
  phraseLoading: boolean;
  /** 已用第一次 Enter 武装的候选任务 id；再次 Enter 才真正写入。 */
  phraseArmed: string | null;
  /** 写意图执行在途：阻止重复 Enter 造成「完成→反开」这类二次切换。 */
  phraseExecuting: boolean;

  openSearch: () => void;
  closeSearch: () => void;
  toggleSearch: () => void;
  setQuery: (q: string) => void;
  setActiveCategory: (c: GlobalSearchCategoryFilter) => void;
  retry: () => void;
  moveActive: (delta: number) => void;
  setActiveIndex: (i: number) => void;
  /** 组装命令列表（读当前 query 与场景/工作流最新数据；纯本地，不发请求）。 */
  refreshCommands: () => void;
  /** 弹窗打开时水合动态实体列表（场景/工作流；既有列表命令，自带守卫），
   * 完成后重建命令列表。失败静默降级为静态命令，不弹数据搜索的错误横幅。 */
  hydrateCommands: () => void;
  /** 执行命令（只允许打开/跳转/草稿/运行类动作，见 commandRegistry 白名单）。 */
  executeCommand: (cmd: CommandDef) => void;
  /** 解析当前输入；仅 looksLikePhrase 命中时由 setQuery 调度。 */
  refreshPhrase: () => Promise<void>;
  /** Escape 先取消二次确认；返回是否消费了这次 Escape。 */
  disarmPhrase: () => boolean;
  /** 激活句式区第 index 行：写意图两段式确认，查询项直接跳转。 */
  activatePhraseRow: (index: number) => void;
  /** 执行结果跳转（记录最近搜索 → 分类分发）。 */
  openResult: (item: GlobalSearchResult) => void;
  /** 目标模块消费定位意图后调用（清除意图）。 */
  consumeLocate: () => void;
  /** 胶囊「最近暂存」跳转完整暂存架并定位条目（复用同一 pendingLocate 通道）。 */
  requestShelfLocate: (id: string, kind: string) => void;
  /** 从 Agent 会话跳转到规划功能详情。 */
  requestPlanningFeatureLocate: (featureId: string, projectId: string) => void;
  clearRecent: () => void;
  setNotice: (n: string | null) => void;
}

let debounceTimer: number | undefined;
let phraseDebounceTimer: number | undefined;
let searchSeq = 0;
let phraseSeq = 0;
let locateSeq = 0;

function clearDebounce() {
  if (debounceTimer !== undefined) {
    window.clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
}

function clearPhraseDebounce() {
  if (phraseDebounceTimer !== undefined) {
    window.clearTimeout(phraseDebounceTimer);
    phraseDebounceTimer = undefined;
  }
}

export const useGlobalSearchStore = create<GlobalSearchState>((set, get) => ({
  open: false,
  query: "",
  activeCategory: "all",
  results: null,
  loading: false,
  error: null,
  activeIndex: 0,
  recent: loadRecentSearches(),
  pendingLocate: null,
  notice: null,
  commands: [],
  phrase: null,
  phraseLoading: false,
  phraseArmed: null,
  phraseExecuting: false,

  openSearch: () => {
    clearDebounce();
    clearPhraseDebounce();
    phraseSeq += 1;
    set({
      open: true,
      notice: null,
      error: null,
      phrase: null,
      phraseLoading: false,
      phraseArmed: null,
      phraseExecuting: false,
    });
    get().hydrateCommands();
    // 输入框内容在关闭后保留：重新打开时按同一套规则重新解析句式。
    if (looksLikePhrase(get().query)) void get().refreshPhrase();
  },

  closeSearch: () => {
    clearDebounce();
    clearPhraseDebounce();
    phraseSeq += 1;
    set({
      open: false,
      phrase: null,
      phraseLoading: false,
      phraseArmed: null,
      phraseExecuting: false,
    });
  },

  toggleSearch: () => {
    if (get().open) get().closeSearch();
    else get().openSearch();
  },

  setQuery: (q) => {
    // 输入一变立即作废旧解析并清空行：否则防抖窗口内按 Enter 可能执行
    // 上一段文本匹配出的候选（对用户是不可解释的误写）。
    clearPhraseDebounce();
    phraseSeq += 1;
    set({
      query: q,
      error: null,
      notice: null,
      phrase: null,
      phraseLoading: false,
      phraseArmed: null,
    });
    // 命令匹配是纯本地过滤：即时生效，不等数据搜索的防抖窗口。
    get().refreshCommands();
    clearDebounce();
    const trimmed = q.trim();
    if (!trimmed) {
      searchSeq += 1;
      set({ results: null, loading: false });
      return;
    }
    if (looksLikePhrase(trimmed)) {
      phraseDebounceTimer = window.setTimeout(() => {
        phraseDebounceTimer = undefined;
        void get().refreshPhrase();
      }, PHRASE_DEBOUNCE_MS);
    }
    debounceTimer = window.setTimeout(() => {
      debounceTimer = undefined;
      void get().retry();
    }, SEARCH_DEBOUNCE_MS);
  },

  setActiveCategory: (c) => {
    set({ activeCategory: c, activeIndex: 0 });
    // 分类切换立即重查（选择分类后只查询该类别，避免无用请求）。
    if (get().query.trim()) void get().retry();
  },

  retry: async () => {
    const { query, activeCategory } = get();
    const trimmed = query.trim();
    if (!trimmed) return;
    const seq = ++searchSeq;
    set({ loading: true, error: null });
    try {
      const categories =
        activeCategory === "all" ? null : ([activeCategory] as string[]);
      const res = await globalSearch(trimmed, categories, null);
      if (seq !== searchSeq) return; // 旧响应丢弃
      // 句式区已占据选中/武装时，迟到的数据结果不得把选中挪回命令组，
      // 否则「Enter 确认执行」会变成给另一个候选重新武装。
      const phraseCount = phraseRowCount(get().phrase);
      const current = get().activeIndex;
      set({
        results: res,
        loading: false,
        activeIndex: phraseCount > 0 && current < phraseCount ? current : 0,
      });
    } catch (e) {
      if (seq !== searchSeq) return;
      // 失败不清空已有结果：显示错误 + 允许重试。
      set({ loading: false, error: String(e).slice(0, 200) });
    }
  },

  moveActive: (delta) => {
    // flat 序 = 句式区在前 + 命令组 + 数据结果，与弹窗渲染顺序一致；
    // 命令组只在「全部」分类下展示（与弹窗 showCommands 同一判定）。
    const { commands, results, activeIndex, activeCategory, phrase } = get();
    const phraseCount = phraseRowCount(phrase);
    const cmdCount = activeCategory === "all" ? commands.length : 0;
    const total =
      phraseCount +
      cmdCount +
      (results?.groups.reduce((n, g) => n + g.items.length, 0) ?? 0);
    if (total === 0) return;
    const next = (activeIndex + delta + total) % total;
    // 移动选中即离开原候选：取消武装，避免预览行与执行目标错位。
    set({ activeIndex: next, phraseArmed: null });
  },

  setActiveIndex: (i) => set({ activeIndex: i }),

  refreshPhrase: async () => {
    const trimmed = get().query.trim();
    if (!trimmed || !looksLikePhrase(trimmed)) return;
    const seq = ++phraseSeq;
    set({ phraseLoading: true });
    try {
      const res = await resolveCommandPhrase(trimmed);
      if (seq !== phraseSeq) return; // 输入已变化，旧解析作废
      set({ phrase: res, phraseLoading: false, phraseArmed: null, activeIndex: 0 });
    } catch {
      if (seq !== phraseSeq) return;
      // 解析失败不阻断搜索：如实提示一次，搜索链路继续工作。
      set({
        phrase: null,
        phraseLoading: false,
        phraseArmed: null,
        notice: translate("commandPhrases.notice.parseFailed"),
      });
    }
  },

  disarmPhrase: () => {
    if (!get().phraseArmed) return false;
    set({ phraseArmed: null });
    return true;
  },

  activatePhraseRow: (index) => {
    const { phrase, phraseArmed, phraseExecuting } = get();
    if (!phrase || phraseExecuting) return;

    if (phrase.kind === "query") {
      const item = phrase.items[index];
      if (!item) return;
      get().closeSearch();
      const ui = useUiStore.getState();
      if (item.kind === "agent") {
        // 缺会话标识的失败项仍属于 Agent 域：只切页，不拿 action id 去任务页定位。
        ui.setTab("agents");
        if (item.agent) {
          ui.focusAgent({
            sourceId: item.agent.sourceId,
            sessionId: item.agent.sessionId,
            refId: item.agent.runId,
          });
        }
      } else {
        ui.setTab("tasks");
        set({
          pendingLocate: {
            category: "tasks",
            id: item.id,
            kind: "task",
            parentId: null,
            // 句式的整句（如「本周完成了什么」）通常不是任务标题子串；
            // 用条目标题定位，否则任务页按句过滤后会找不到目标行。
            keyword: item.title,
            token: ++locateSeq,
          },
        });
      }
      return;
    }

    const candidate = phrase.candidates[index];
    if (!candidate) return;
    set({ activeIndex: index });
    // 两段式：第一次 Enter 只武装并展示差异预览，不做任何写入。
    if (phraseArmed !== candidate.id) {
      set({ phraseArmed: candidate.id });
      return;
    }

    set({ phraseArmed: null, phraseExecuting: true });
    void (async () => {
      try {
        if (phrase.kind === "complete") {
          // toggle 是状态翻转：候选解析后任务可能已被其他窗口完成，
          // 直接 toggle 会把已完成任务反开。执行前复核，只对未完成项翻转。
          const task = await fetchTask(candidate.id);
          if (task.status !== "pending") {
            const message = translate("commandPhrases.notice.alreadyCompleted", {
              title: candidate.title,
            });
            set({ phraseExecuting: false, phraseArmed: null, notice: message });
            useUiStore.getState().showToast(message, { kind: "warning" });
            return;
          }
          await useTasksStore.getState().toggle(candidate.id);
          useUiStore.getState().showToast(
            translate("commandPhrases.notice.completed", { title: candidate.title }),
            { kind: "success" },
          );
        } else if (phrase.kind === "reschedule" && phrase.dueAt) {
          // update_task 会整字段写入 description/title：先取全量再只改截止时间，
          // 省略的字段由后端三态语义保持原值（避免清空描述或提醒）。
          const task = await fetchTask(candidate.id);
          await useTasksStore.getState().update(candidate.id, {
            title: task.title,
            description: task.description,
            due_at: phrase.dueAt,
          });
          useUiStore.getState().showToast(
            translate("commandPhrases.notice.rescheduled", {
              title: candidate.title,
              due: formatDue(phrase.dueAt),
            }),
            { kind: "success" },
          );
        } else if (phrase.kind === "priority" && phrase.priority != null) {
          const task = await fetchTask(candidate.id);
          await useTasksStore.getState().update(candidate.id, {
            title: task.title,
            description: task.description,
            priority: phrase.priority,
          });
          useUiStore.getState().showToast(
            translate("commandPhrases.notice.priorityChanged", {
              title: candidate.title,
              priority: translate(priorityLabelKey(phrase.priority)),
            }),
            { kind: "success" },
          );
        } else {
          // 后端契约保证写意图带目标值；缺失时不静默关窗，保持可重试。
          set({ phraseExecuting: false });
          return;
        }
        set({ phraseExecuting: false });
        get().closeSearch();
      } catch (e) {
        const message = translate("commandPhrases.notice.executeFailed", {
          error: errorMessage(e),
        });
        set({ phraseExecuting: false, notice: message });
        useUiStore.getState().showToast(message, { kind: "error" });
      }
    })();
  },

  refreshCommands: () => {
    const { query } = get();
    const scenarios = useScenarioStore.getState().summaries;
    const workflows = useWorkflowsStore.getState().workflows;
    const all = [
      ...buildStaticCommands(),
      ...buildScenarioCommands(scenarios),
      ...buildWorkflowCommands(workflows),
    ];
    set({ commands: visibleCommands(all, query, translate) });
  },

  hydrateCommands: () => {
    // 先用现有数据立即渲染静态命令，再用既有列表命令补动态实体。
    get().refreshCommands();
    const scenario = useScenarioStore.getState();
    const workflows = useWorkflowsStore.getState();
    const loads: Promise<unknown>[] = [];
    // 两个 store 都自带代际/加载守卫；这里只防「已在加载中重复发起」。
    if (!scenario.loaded && !scenario.loading) loads.push(scenario.load());
    if (workflows.workflows === null && !workflows.workflowsLoading) {
      loads.push(workflows.loadWorkflows());
    }
    if (loads.length === 0) return;
    // 水合失败不阻断搜索：动态命令缺席即降级，静态命令始终可用。
    void Promise.allSettled(loads).then(() => get().refreshCommands());
  },

  executeCommand: (cmd) => {
    get().closeSearch();
    const ui = useUiStore.getState();
    switch (cmd.action.kind) {
      case "open-tab":
        ui.setTab(cmd.action.tab);
        break;
      case "quick-add":
      case "reminder-draft":
        // 草稿类动作：落到任务页并聚焦快速录入，不静默写任何数据。
        ui.setTab("tasks");
        ui.bumpQuickAdd();
        break;
      case "open-settings-section":
        // 先切页再下发定位意图：设置页挂载后消费 sessionStorage 兜底并滚动展开。
        ui.setTab("settings");
        requestSettingsSectionReveal(cmd.action.sectionId);
        break;
      case "run-workflow": {
        const { workflowId, name } = cmd.action;
        // 先切到工作流页（面板挂载后订阅运行进度事件），再发起运行：
        // 单槽活动运行的执行中/成功/失败反馈由工作流页如实展示。
        ui.setTab("workflows");
        useWorkflowsStore
          .getState()
          .runWorkflow(workflowId)
          .then(() => {
            useUiStore
              .getState()
              .showToast(translate("commandPalette.workflowStarted", { name }), {
                kind: "success",
              });
          })
          .catch((e) => {
            useUiStore
              .getState()
              .showToast(
                translate("commandPalette.workflowStartFailed", {
                  name,
                  error: errorMessage(e),
                }),
                { kind: "error" },
              );
          });
        break;
      }
      case "open-scenario": {
        const { scenarioId, name } = cmd.action;
        // 全局单飞：已有进入在途时如实回显，不排队堆积。
        if (useScenarioStore.getState().enteringId !== null) {
          ui.showToast(translate("commandPalette.scenarioBusy"), { kind: "warning" });
          break;
        }
        ui.setTab("workflows");
        ui.showToast(
          translate("commandPalette.scenarioEntering", { name }),
          { kind: "info" },
        );
        useScenarioStore
          .getState()
          .enter(scenarioId)
          .then((result) => {
            if (!result) return; // 兜底：与上方单飞检查一致，不重复提示
            const ok = result.items.filter((i) => i.status === "ok").length;
            const bad = result.items.length - ok;
            useUiStore.getState().showToast(
              translate("commandPalette.scenarioDone", { name, ok, bad }),
              { kind: bad > 0 ? "warning" : "success" },
            );
          })
          .catch((e) => {
            useUiStore
              .getState()
              .showToast(
                translate("commandPalette.scenarioEnterFailed", {
                  name,
                  error: errorMessage(e),
                }),
                { kind: "error" },
              );
          });
        break;
      }
    }
  },

  openResult: (item) => {
    const { query } = get();
    // 记录最近搜索（本地，去重，最新在前）。
    const recent = saveRecentSearch(query, get().recent);
    persistRecentSearches(recent);
    set({ recent });
    get().closeSearch();

    const ui = useUiStore.getState();
    const intent: GlobalSearchLocateIntent = {
      category: item.category,
      id: item.target_id ?? item.id,
      kind: item.kind,
      parentId: item.parent_id,
      keyword: query.trim(),
      token: ++locateSeq,
    };

    switch (item.category) {
      case "tasks": {
        ui.setTab("tasks");
        set({ pendingLocate: intent });
        break;
      }
      case "clipboard": {
        ui.setTab("clipboard");
        set({ pendingLocate: intent });
        break;
      }
      case "capture": {
        ui.setTab("inbox");
        set({ pendingLocate: intent });
        break;
      }
      case "shelf": {
        ui.setTab("shelf");
        set({ pendingLocate: intent });
        break;
      }
      case "apps": {
        // 已保存导航目标：走既有 navNavigate（不绕过目标可信配置）；
        // focus_or_launch 语义 = 已有运行窗口优先聚焦，否则启动。
        const targetId = item.target_id ?? item.id;
        void navNavigate(targetId, { action: "focus_or_launch" })
          .then(() => set({ notice: null }))
          .catch((e) => {
            // 启动失败如实回显，不伪装成功。
            set({
              open: true,
              notice: `启动失败：${String(e).slice(0, 140)}`,
            });
          });
        break;
      }
      case "agents": {
        // 会话/轮次 → focusAgent 全链路（sourceId/sessionId/refId）。
        if (item.parent_id && (item.target_id || item.id)) {
          ui.setTab("agents");
          ui.focusAgent({
            sourceId: item.parent_id,
            sessionId: item.target_id ?? item.id,
            refId: item.kind === "run" ? item.id : null,
          });
        } else {
          ui.setTab("agents");
        }
        break;
      }
      case "workspace": {
        ui.setTab("tasks");
        set({ pendingLocate: intent });
        break;
      }
      case "planning": {
        ui.setTab("roadmap");
        set({ pendingLocate: intent });
        break;
      }
      case "notes": {
        // 顺序不能反：setTab 会把 collectionSub 重置到 inbox/shelf，
        // 先切顶级入口再切子页签，最后下发定位意图。
        ui.setTab("inbox");
        ui.setCollectionSub("notes");
        set({ pendingLocate: intent });
        break;
      }
      default:
        // 未知分类不伪装跳转。
        set({ open: true, notice: "该结果类型暂不支持跳转" });
        break;
    }
  },

  consumeLocate: () => set({ pendingLocate: null }),

  requestShelfLocate: (id, kind) =>
    set({
      pendingLocate: {
        category: "shelf",
        id,
        kind,
        parentId: null,
        keyword: "",
        token: ++locateSeq,
      },
    }),

  requestPlanningFeatureLocate: (featureId, projectId) => {
    useUiStore.getState().setTab("roadmap");
    set({
      pendingLocate: {
        category: "planning",
        id: featureId,
        kind: "feature",
        parentId: projectId,
        keyword: "",
        token: ++locateSeq,
      },
    });
  },

  clearRecent: () => {
    clearRecentPersisted();
    set({ recent: [] });
  },

  setNotice: (n) => set({ notice: n }),
}));

/** 测试用：重置请求代际与防抖定时器（避免跨用例污染）。 */
export function resetGlobalSearchTimers() {
  clearDebounce();
  clearPhraseDebounce();
  searchSeq += 1;
  phraseSeq += 1;
}
