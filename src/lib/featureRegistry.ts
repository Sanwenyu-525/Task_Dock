//! 功能注册表：TaskDock 所有「页面级功能」的代码入口、资源等级与缓存策略。
//!
//! 这是 `docs/ON_DEMAND_LOADING.md` 的唯一代码事实源：新增页面必须在这里登记，
//! 否则 `FeatureView` 不会加载它（契约测试会拦下漏登记的路由）。
//!
//! ## 四层按需加载在本文件的落点
//! 1. 导航层：`navigationRegistry` 只提供 ID/图标/顺序（不 import 页面）；
//! 2. 代码层：本文件的 `load` 是**唯一**页面代码入口（动态 import，按页拆包）；
//! 3. 数据层：面板挂载后才发自己的请求（由各面板负责，外壳不预取业务数据）；
//! 4. 重型服务层：见 `docs/ON_DEMAND_LOADING.md` §5；本文件只登记页面级策略。
//!
//! ## 策略怎么选（改这里之前先读文档）
//! - `tier: "heavy"`：首包大、或内部会建立长连接/大列表；
//! - `instance: "release"`：只读工具页，离开即卸载实例（筛选/滚动会重置，属已知取舍）；
//!   有草稿、编辑态、滚动位置意义的页面一律 `keep`（默认），只暂停后台活动；
//! - `preload: "hover"`：悬停/聚焦导航项时预取代码（不初始化任何业务）；
//!   `"idle"`：仅留给「用户极可能进入」的默认页；`"never"`：设置类/低频重页。

import { registerFeature, type FeatureDefinition } from "./featureRuntime";
import type { Tab } from "../store/useUiStore";
import type { WorkbenchRoute } from "./workbenchLayout";

/**
 * 工作台路由 → 功能 ID。
 *
 * 所有路由（含并行任务接入的「安全保险箱」）都必须在这里登记：
 * `featureRegistry.test.ts` 锁定 `WORKBENCH_ROUTES` 全覆盖，新增页面漏登记会失败。
 */
const WORKBENCH_ROUTE_FEATURES: Partial<Record<WorkbenchRoute, string>> = {
  workbench: "page:workbench",
  workspace: "page:workspace",
  files: "page:files",
  tasks: "page:tasks",
  life: "page:life",
  vault: "page:vault",
  agents: "page:agents",
  apps: "page:apps",
  widgets: "page:widgets",
  actions: "page:actions",
  clipboard: "page:clipboard",
  mobile: "page:mobile",
  inbox: "page:collection",
  shelf: "page:collection",
  workflows: "page:workflows",
  history: "page:history",
  roadmap: "page:roadmap",
  capability: "page:capability",
  settings: "page:settings",
  help: "page:help",
  diagnostics: "page:diagnostics",
  resource: "page:resource",
};

/** 已声明路由但尚未接入按需加载的页面（必须写明原因，不能静默留空）。 */
export const WORKBENCH_PENDING_ROUTES: Readonly<Record<string, string>> = {};

/** 主窗口完整面板 → 功能 ID（默认页 tasks 保持同步加载，见文档 §4.1）。 */
const MAIN_TAB_FEATURES: Partial<Record<Tab, string>> = {
  agents: "page:agents",
  actions: "page:actions",
  clipboard: "page:clipboard",
  inbox: "page:collection",
  shelf: "page:collection",
  settings: "page:settings",
};

export function featureIdForWorkbenchRoute(route: WorkbenchRoute): string | null {
  return WORKBENCH_ROUTE_FEATURES[route] ?? null;
}

export function featureIdForMainTab(tab: Tab): string | null {
  return MAIN_TAB_FEATURES[tab] ?? null;
}

/** 工作台里所有登记过的路由（用于契约测试与诊断展示）。 */
export function registeredWorkbenchRoutes(): WorkbenchRoute[] {
  return Object.keys(WORKBENCH_ROUTE_FEATURES) as WorkbenchRoute[];
}

/**
 * 功能定义清单。
 *
 * 每个 `load` 必须是**静态字符串字面量**形式的 `import()`：这是 Vite/Rollup 能
 * 可靠拆包与预加载的前提（变量拼接的路径会退化成运行期请求，无法被静态分析）。
 */
export const FEATURE_DEFINITIONS = [
  {
    id: "page:workbench",
    label: "开发工作台",
    load: () => import("../components/workbench/DevWorkbenchPanel"),
    tier: "heavy",
    instance: "keep",
    preload: "hover",
  },
  {
    id: "page:workspace",
    label: "工作空间",
    load: () => import("../workbench/ProjectWorkspacePanel"),
    tier: "heavy",
    instance: "keep",
    preload: "hover",
  },
  {
    id: "page:files",
    label: "文件工作区",
    load: () => import("../components/files/FilesWorkspacePanel"),
    tier: "heavy",
    instance: "keep",
    preload: "hover",
  },
  {
    id: "page:tasks",
    label: "任务",
    load: () => import("../components/tasks/TasksPanel"),
    tier: "standard",
    instance: "keep",
    preload: "idle",
  },
  {
    id: "page:life",
    label: "生活",
    load: () => import("../components/life/LifePanel"),
    tier: "standard",
    instance: "keep",
    preload: "hover",
  },
  {
    // 安全保险箱：面板由并行任务开发；这里仍按统一入口登记，避免新功能绕过规范。
    id: "page:vault",
    label: "安全保险箱",
    load: () => import("../components/vault/VaultPanel"),
    tier: "heavy",
    instance: "keep",
    preload: "hover",
  },
  {
    id: "page:agents",
    label: "Agent",
    load: () => import("../components/agents/AgentPanel"),
    tier: "heavy",
    instance: "keep",
    preload: "hover",
  },
  {
    id: "page:apps",
    label: "应用",
    load: () => import("../components/apps/AppsPanel"),
    tier: "standard",
    instance: "keep",
    preload: "hover",
  },
  {
    id: "page:widgets",
    label: "微件",
    load: () => import("../components/widgets/WidgetsPanel"),
    tier: "standard",
    instance: "keep",
    preload: "hover",
  },
  {
    id: "page:actions",
    label: "行动",
    load: () => import("../components/actions/ActionCenterPanel"),
    tier: "standard",
    instance: "keep",
    preload: "hover",
  },
  {
    id: "page:clipboard",
    label: "剪贴板",
    load: () => import("../components/clipboard/ClipboardPanel"),
    tier: "light",
    instance: "keep",
    preload: "hover",
  },
  {
    id: "page:mobile",
    label: "手机互传",
    load: () => import("../components/mobile/MobileTransferPanel"),
    tier: "heavy",
    instance: "keep",
    preload: "hover",
  },
  {
    id: "page:collection",
    label: "收集与暂存",
    load: () => import("../components/collection/CollectionPanel"),
    tier: "standard",
    instance: "keep",
    preload: "hover",
  },
  {
    id: "page:workflows",
    label: "工作流",
    load: () => import("../components/workflows/WorkflowsPanel"),
    tier: "heavy",
    instance: "keep",
    preload: "hover",
  },
  {
    id: "page:history",
    label: "历史",
    load: () => import("../components/history/HistoryPanel"),
    tier: "standard",
    instance: "release",
    preload: "hover",
  },
  {
    id: "page:roadmap",
    label: "规划中心",
    load: () => import("../components/roadmap/PlanningCenterPanel"),
    tier: "heavy",
    instance: "keep",
    preload: "hover",
  },
  {
    id: "page:capability",
    label: "能力中心",
    load: () => import("../components/capability/CapabilityCenterPanel"),
    tier: "heavy",
    instance: "release",
    preload: "hover",
  },
  {
    id: "page:settings",
    label: "设置",
    load: () => import("../components/settings/SettingsPanel"),
    tier: "heavy",
    instance: "keep",
    preload: "hover",
  },
  {
    id: "page:help",
    label: "帮助",
    load: () => import("../components/help/HelpCenterPanel"),
    tier: "light",
    instance: "release",
    preload: "hover",
  },
  {
    id: "page:diagnostics",
    label: "诊断中心",
    load: () => import("../components/diagnostics/DiagnosticsCenterPanel"),
    tier: "standard",
    instance: "release",
    preload: "hover",
  },
  {
    id: "page:resource",
    label: "资源管理",
    load: () => import("../components/resource/ResourceManagementPanel"),
    tier: "heavy",
    instance: "release",
    preload: "hover",
  },
] as const satisfies readonly FeatureDefinition[];

/** 页面功能的字面量联合：外壳/路由槽用它接住 ID 拼写错误（编译期失败）。 */
export type PageFeatureId = (typeof FEATURE_DEFINITIONS)[number]["id"];

let installed = false;

/**
 * 安装注册表（幂等）。
 *
 * 由两个窗口入口（`main.tsx` / `workspace/main.tsx`）在渲染前调用：只登记元数据，
 * 不做任何 import。放在模块顶层副作用也可以，但显式调用更容易在测试里隔离。
 */
export function installFeatureRegistry(): void {
  if (installed) return;
  installed = true;
  for (const definition of FEATURE_DEFINITIONS) registerFeature(definition);
}

/** 仅测试使用：允许在清空 runtime 之后重新安装。 */
export function __resetFeatureRegistryForTests(): void {
  installed = false;
}
