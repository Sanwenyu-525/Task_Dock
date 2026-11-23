//! 与 Tauri 后端的类型化桥接层。

import { invokeCommand as invoke } from "./errors";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentOperation,
  AgentOperationChangeEvent,
  AgentOperationCursor,
  AgentOperationSync,
} from "./contracts/models";

export * from "./contracts/models";
import type {
  Task,
  TaskInput,
  RecurrenceRuleInput,
  SnoozeChange,
  SnoozeResult,
  ActiveReminder,
  TaskFilter,
  ParsedInput,
  AgentSnapshot,
  AgentHistorySession,
  AgentHistorySessionsPage,
  AgentHistoryRunsPage,
  AgentHistoryGroups,
  AgentHistorySessionsQuery,
  DiscoveredAgent,
  Settings,
  TaskStats,
  MaterialResult,
  TaskAgentLink,
  ClipboardItem,
  ClipboardOcrReport,
  ClipboardGroup,
  ClipboardGroupPage,
  ClipboardStats,
  ClipboardMigrationOutcome,
  ClipboardView,
  ClipboardFilter,
  ClipboardSourceOption,
  CopyReport,
  DeleteReport,
  CleanupReport,
  ClearReport,
  ClipboardTaskLink,
  PasteTarget,
  PasteStartReport,
  PasteJob,
  ClipboardStatus,
  ClipboardPasteEvent,
  PasteItemState,
  ClipboardProbe,
  AgentTargetsSnapshot,
  ExportPackage,
  ExportPurgeReport,
  PhraseResolution,
  NotificationPage,
  NotificationInboxStats,
  AgentEventPage,
  TtsVoicesReport,
  TtsSynthesisReport,
  TtsCacheReport,
  TtsCacheClearReport,
  VoiceEventKind,
  VoicePack,
  VoiceClip,
  VoiceAssetImportResult,
  VoiceDeleteResult,
  ResourceCleanupCategory,
  ResourceProcessDiagnostics,
  ResourceSnapshot,
  ResourceCleanupPreview,
  ResourceCleanupExecutionReport,
  ResourceStorageBreakdown,
  ResourceMemoryCatalog,
  ResourceMemoryReleaseReport,
  ResourceDiskScanReport,
  ResourceJunkCategory,
  ResourceJunkPreview,
  ResourceJunkExecutionReport,
  AudioEventPayload,
  SnapDisplayInfo,
  SnapStateExtra,
  BackupEntry,
  BackupMeta,
  EncryptedBackupResult,
  UserWidgetPreference,
  UserPreferencesView,
  RestoreOutcome,
  TestDataAudit,
  AppExitRequest,
  CapsuleRegionMode,
  PerformanceDiagnostics,
  RetentionReport,
  AppBuildInfo,
  AppRuntimeGitInfo,
  ClipboardGroupItemPosition,
  ActionFeed,
  ActionFilter,
  SnapshotSummary,
  SnapshotDetail,
  CaptureInput,
  CaptureWindow,
  RestoreStatus,
  PruneReport,
  TaskContext,
  ClipboardSnapshotLink,
  ReminderLinkKind,
  TaskReminderLink,
  CaptureState,
  CaptureItem,
  CaptureAttachment,
  SubmitCaptureInput,
  SubmitCaptureResult,
  CaptureDraftSaved,
  QuickCaptureShowResult,
  QuickCaptureHideResult,
  CaptureVoiceStartResult,
  AgentChangedEvent,
  NotificationNavigatePayload,
  WorkspaceRestoreProgress,
  QuickCaptureCreatedEvent,
  CaptureVoiceText,
  CaptureVoiceStatus,
  PlanningProjectStatus,
  PlanningFeatureStatus,
  PlanningProject,
  PlanningProjectInput,
  PlanningProjectPatch,
  ProjectRootPatch,
  ProjectAndPlanOutcome,
  PlanningPlan,
  PlanningFeature,
  PlanningAgentFeatureLink,
  PlanningFeatureInput,
  PlanningFeaturePatch,
  PlanningMilestone,
  PlanningMilestoneInput,
  PlanningMilestonePatch,
  PlanningActivity,
  PlanningActivityPage,
  PlanningStepPatch,
  McpAgentScope,
  McpConfigClient,
  McpAgentInfo,
  McpStatus,
  McpCapability,
  McpCapabilityGrant,
  McpWorkspaceRoot,
  McpDiagnosticsReport,
  McpAgentCreated,
  McpAuditPage,
  AgentAccessData,
  PlanningChangedEvent,
  ScenarioSummary,
  ScenarioDetail,
  ScenarioSaveInput,
  ScenarioEnterResult,
  ShelfKind,
  ShelfStorageMode,
  ShelfItem,
  ShelfGroup,
  ShelfPage,
  ShelfStats,
  ShelfAddReport,
  ShelfPasteReport,
  ShelfDeleteReport,
  ShelfTrashDeleteReport,
  ShelfTrashRestoreReport,
  ShelfTrashPurgeReport,
  ShelfRecyclePreview,
  ShelfRecycleExpectation,
  ShelfRecycleReport,
  ShelfCleanupReport,
  ShelfTaskLink,
  ShelfUpdatePatch,
  ShelfSendToStatus,
  ShelfDragOutResult,
  ShelfProjectLink,
  ShelfBatchLinkReport,
  ShelfTagChangeReport,
  ShelfRecentTag,
  ShelfDedupReport,
  ShelfRuleSet,
  ShelfRulePreview,
  ShelfRuleApplyReport,
  ShelfConflictStrategy,
  ShelfOpReport,
  ShelfRecentDir,
  DropTargetOpMode,
  ShelfDropTarget,
  ShelfDropTargetPatch,
  ShelfDropReport,
  WorkflowStepType,
  WorkflowRunStepStatus,
  WorkflowRunStatus,
  Workflow,
  WorkflowStepInput,
  WorkflowInput,
  WorkflowPatch,
  WorkflowDetail,
  WorkflowRunDetail,
  WorkflowRunPage,
  WorkflowActiveRun,
  WorkflowLastRunSummary,
  DiagnosticQuery,
  DiagnosticPage,
  DiagnosticSummary,
  DiagnosticsStatus,
  DiagnosticExportResult,
  DiagnosticClearResult,
  DiagnosticsExportPreview,
  DiagnosticsMetricsSummary,
  SecurityAuditFilter,
  SecurityAuditPage,
  SecurityAuditPruneOptions,
  SecurityAuditPruneReport,
  ModuleRuntimeStatus,
  MobileDevice,
  MobileSyncStatus,
  MobileSyncPairingOffer,
  MobileFile,
  DevProject,
  DevGitInfo,
  DevHandoffPack,
  DevAcceptanceRecord,
  DevAgentRunCandidate,
  SecretFinding,
  NoteSummary,
  WorkspaceKind,
  WorkspaceProjectStatus,
  WorkspaceItemStatus,
  WorkspaceProject,
  WorkspaceInstance,
  WorkspaceItem,
  WorkspaceTaskLink,
  WorkspaceProjectProgress,
  WorkspaceResourceKind,
  WorkspaceResourceLink,
  WorkspaceResourcePage,
  NovelVolume,
  NovelChapterSummary,
  NovelChapter,
  WorkbenchNavTarget,
  WorkbenchNavRequest,
  WorkbenchNavStatus,
  WorkbenchNavAck,
  OpenDevWorkbenchStatus,
  OpenDevWorkbenchAck,
  VdDeviceList,
  VdAppList,
  VdSession,
  VdProbe,
  VdFocus,
  VdScreenshot,
  VdDiagnostics,
  VdStartOptions,
  ProjectionNavigationAction,
  ProjectionIdentityReport,
  FsDirListing,
  FsDirSignature,
  FsPlace,
  FsOpReport,
  FsStat,
  FsBatchRenameItem,
  FsHashEntry,
  VerifiedDuplicateDeleteGroup,
  FsBinaryPreview,
  FsTextPreview,
  OperationPreview,
  RecycleStats,
  RecycleQuery,
  RecyclePage,
  RecycleSyncStatus,
  RecycleSyncSummary,
  RecycleScanProgress,
  FileJobSnapshot,
  KnowledgeBaseKind,
  KnowledgeSourceKind,
  KnowledgeSourceMode,
  KnowledgeDocStatus,
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeLink,
  KnowledgeDocumentDetail,
  KnowledgeBaseDetail,
  KnowledgeStats,
  KnowledgeDocumentPage,
  KnowledgeImportReport,
  KnowledgeSearchPage,
  SkillSummary,
  SkillDetail,
  SkillScanReport,
  ExternalMcpServer,
  McpConnectionReport,
  McpCallReport,
  McpCallPage,
  CapabilityContextConfig,
  CapabilityContextProfile,
  CapabilityContextBundle,
  CapabilityRecipeStep,
  CapabilityRecipe,
  CapabilityRecipeSummary,
  CapabilityRecipeRun,
  CapabilityRecipeRunPage,
  ProjectHubProjectSummary,
  ProjectCreateInput,
  ProjectCreateResult,
  ProjectHubSnapshot,
  ProjectHubCreateInput,
  ProjectHubResourceCandidate,
  ProjectHubResourceLink,
  ProjectHubResourceLinkInput,
} from "./contracts/models";


// ── 任务 ──
export const listTasks = (filter: TaskFilter) => invoke<Task[]>("list_tasks", { filter });
/** 按 ID 读取单个任务；用于微件点击时主窗当前筛选列表未加载该任务的场景。 */
export const fetchTask = (id: string) => invoke<Task>("fetch_task", { id });
export const taskStats = () => invoke<TaskStats>("task_stats");
export const createTask = (input: TaskInput, traceId?: string | null) =>
  invoke<Task>("create_task", { input, traceId: traceId ?? null });
export const updateTask = (id: string, input: TaskInput) => invoke<Task>("update_task", { id, input });
/** 带 CAS 的更新：`expectedUpdatedAt` 与任务当前值不一致时后端返回 CONFLICT。 */
export const updateTaskChecked = (
  id: string,
  input: TaskInput,
  expectedUpdatedAt: string,
) => invoke<Task>("update_task_cas", { id, input, expectedUpdatedAt });
export const toggleTask = (id: string) => invoke<Task>("toggle_task", { id });
export const deleteTask = (id: string) => invoke<void>("delete_task", { id });
export const undoTaskCompletion = (task: Pick<Task, "id" | "updated_at">) =>
  invoke<Task>("undo_task_completion", { id: task.id, updatedAt: task.updated_at });
export const parseQuickAdd = (text: string) => invoke<ParsedInput>("parse_quick_add", { text });
export const createFromQuickAdd = (
  text: string,
  dueAt: string | null,
  recurrence: RecurrenceRuleInput | null,
  advanceMinutes: number | null,
) => invoke<Task>("create_from_quick_add", { text, dueAt, recurrence, advanceMinutes });
export const snoozeReminder = (taskId: string, minutes: number) =>
  invoke<SnoozeResult>("snooze_reminder", { taskId, minutes });
export const undoSnooze = (
  taskId: string,
  changes: SnoozeChange[],
  insertedId: string | null,
) => invoke<[number, number]>("undo_snooze", { taskId, changes, insertedId });
export const activeReminders = () => invoke<ActiveReminder[]>("active_reminders");
export const cancelReminders = (taskId: string) => invoke<number>("cancel_reminders", { taskId });
export const linkTaskAgent = (
  taskId: string,
  sourceId: string,
  sessionExternalId: string,
  runExternalId?: string,
) => invoke<TaskAgentLink>("link_task_agent", { taskId, sourceId, sessionExternalId, runExternalId });
export const unlinkTaskAgent = (linkId: string) => invoke<void>("unlink_task_agent", { linkId });
export const listTaskLinks = (taskId: string) => invoke<TaskAgentLink[]>("list_task_links", { taskId });
export const pendingItemsToTasks = (items: string[]) =>
  invoke<Task[]>("pending_items_to_tasks", { items });


/** 帧表命中才返回解析结果；未命中/时间不可解析/整句标题冲突均返回 null（回退普通搜索）。 */
export const resolveCommandPhrase = (input: string) =>
  invoke<PhraseResolution | null>("resolve_command_phrase", { input });

// ── Agent ──
export const agentSnapshot = () => invoke<AgentSnapshot>("agent_snapshot");
/**
 * 历史会话分页（P1-02）：独立 COUNT + keyset 游标，不受实时快照上限影响。
 * 展开历史分区、加载更多、搜索历史时调用；实时刷新仍走 `agentSnapshot`。
 */
export const agentHistorySessions = (query: AgentHistorySessionsQuery = {}) =>
  invoke<AgentHistorySessionsPage>("agent_history_sessions", { query });
/** 会话轮次按需分页：展开会话后再加载，避免一次拉全部历史轮次。 */
export const agentHistoryRuns = (
  sessionId: string,
  cursor?: string | null,
  limit = 10,
  includeLive = false,
  liveOnly = false,
) =>
  invoke<AgentHistoryRunsPage>("agent_history_runs", {
    sessionId,
    cursor: cursor ?? undefined,
    limit,
    includeLive: includeLive || undefined,
    liveOnly: liveOnly || undefined,
  });
/** 按会话行 ID 精确定位（通知跳转/深链）。 */
export const agentHistorySession = (sessionId: string) =>
  invoke<AgentHistorySession | null>("agent_history_session", { sessionId });
/** 历史入口分组：一次聚合查询某来源下每个真实实例/未关联实例的历史数量。 */
export const agentHistoryGroups = (query: { sourceId?: string; includeLive?: boolean } = {}) =>
  invoke<AgentHistoryGroups>("agent_history_groups", { query });
export const setSourceEnabled = (id: string, enabled: boolean) =>
  invoke<void>("set_source_enabled", { id, enabled });
// 动态来源注册
export const createSource = (id: string, displayName: string, adapter?: string, homepage?: string, note?: string, icon?: string) =>
  invoke<void>("create_source", { id, displayName, adapter, homepage, note, icon });
export const updateSource = (id: string, patch: { displayName?: string; homepage?: string; note?: string; icon?: string; hidden?: boolean }) =>
  invoke<void>("update_source", { id, ...patch });
export const deleteSource = (id: string, alsoDeleteData = false) =>
  invoke<void>("delete_source", { id, alsoDeleteData });
// 自动发现 + 接入向导
export const discoveryScan = () => invoke<DiscoveredAgent[]>("discovery_scan");
export const adapterList = () =>
  invoke<{ id: string; display_name: string; transport_kind: string; docs_url: string }[]>("adapter_list");
export const adapterPreview = (adapterId: string) =>
  invoke<Record<string, unknown>>("adapter_preview", { adapterId });
export const adapterInstall = (adapterId: string) =>
  invoke<Record<string, unknown>>("adapter_install", { adapterId });
export const adapterVerify = (adapterId: string) =>
  invoke<Record<string, unknown>>("adapter_verify", { adapterId });
export const adapterUninstall = (adapterId: string) =>
  invoke<Record<string, unknown>>("adapter_uninstall", { adapterId });
export const adapterStatus = (adapterId: string) =>
  invoke<Record<string, unknown>>("adapter_status", { adapterId });
export const mockStartScenario = (sessionTitle: string, outcome: string) =>
  invoke<void>("mock_start_scenario", { sessionTitle, outcome });
export const codexHooksStatus = () =>
  invoke<{ installed: boolean; hooks_path: string; script_path: string; codex_home: string }>(
    "codex_hooks_status",
  );
export const codexHooksInstall = () => invoke<Record<string, unknown>>("codex_hooks_install");
export const codexHooksUninstall = () => invoke<Record<string, unknown>>("codex_hooks_uninstall");
/** 跳转 Agent 会话（v0.4 走统一导航：证据化能力 + 诚实降级；返回结构化结果）。
 * `traceId` 可选诊断链路标识，只用于诊断关联，不参与鉴权；不传行为不变。 */
export const openAgentSession = (
  sourceId: string,
  sessionId: string,
  traceId?: string | null,
) =>
  invoke<import("./navigation").NavigationResult>("open_agent_session", {
    sourceId,
    sessionId,
    traceId: traceId ?? null,
  });


export const notificationPage = (opts: {
  sourceId?: string;
  since?: string;
  before?: string;
  limit?: number;
} = {}) => invoke<NotificationPage>("notification_page", opts);
export const notificationInboxStats = () =>
  invoke<NotificationInboxStats>("notification_inbox_stats");
export const markNotificationRead = (id: string) => invoke<void>("mark_notification_read", { id });
export const markAllNotificationsRead = () => invoke<void>("mark_all_notifications_read");
export const clearNotifications = () => invoke<void>("clear_notifications");
export const listAgentEvents = (
  limit = 100,
  opts: { sourceId?: string; since?: string; before?: string } = {},
) =>
  invoke<AgentEventPage>("list_agent_events", {
    limit,
    sourceId: opts.sourceId,
    since: opts.since,
    before: opts.before,
  });

// ── 设置 ──
export const getSettings = () => invoke<Settings>("get_settings");
export const updateSettings = (patch: Partial<Settings>) =>
  invoke<Settings>("update_settings", { patch });

/**
 * 设置写入广播（跨窗口同步）：只携带**变更键名**，不携带值。
 * 收到后各窗口按需重新读取权威设置（两个 WebView 不共享内存 store）。
 */
export const onSettingsChanged = (
  cb: (payload: { keys: string[]; origin?: string; revision?: number }) => void,
) =>
  listen<{ keys: string[]; origin?: string; revision?: number }>("settings-changed", (e) => {
    const keys = Array.isArray(e.payload?.keys)
      ? e.payload.keys.filter((key): key is string => typeof key === "string")
      : [];
    const origin = typeof e.payload?.origin === "string" ? e.payload.origin : undefined;
    const revision =
      typeof e.payload?.revision === "number" && Number.isFinite(e.payload.revision)
        ? e.payload.revision
        : undefined;
    cb({ keys, origin, revision });
  });

/**
 * 项目列表变更广播（跨窗口同步）：统一创建服务新增项目后发出，只携带
 * 来源窗口标签。已开工作台收到后重读项目列表（顶栏选择器随之更新）；
 * 本窗口自己的创建（origin="workspace"）已由页面流程刷新，应跳过。
 */
export const onWorkspaceProjectsChanged = (
  cb: (payload: { origin?: string }) => void,
) =>
  listen<{ origin?: string }>("workspace-projects-changed", (e) => {
    const origin = typeof e.payload?.origin === "string" ? e.payload.origin : undefined;
    cb({ origin });
  });


export const voicePacksList = () => invoke<VoicePack[]>("voice_packs_list");
export const voicePackCreate = (name: string) =>
  invoke<string>("voice_pack_create", { name });
export const voicePackRename = (packId: string, name: string) =>
  invoke<void>("voice_pack_rename", { packId, name });
export const voicePackDelete = (packId: string) =>
  invoke<VoiceDeleteResult>("voice_pack_delete", { packId });
export const voiceAssetImport = (packId: string, path: string) =>
  invoke<VoiceAssetImportResult>("voice_asset_import", { packId, path });
export const voiceAssetRemove = (packId: string, assetId: string) =>
  invoke<VoiceDeleteResult>("voice_asset_remove", { packId, assetId });
export const voiceBindingSet = (
  packId: string,
  eventKind: VoiceEventKind,
  assetId: string | null,
) => invoke<void>("voice_binding_set", { packId, eventKind, assetId });
export const voiceResolveClip = (eventKind: VoiceEventKind) =>
  invoke<VoiceClip | null>("voice_resolve_clip", { eventKind });
export const voiceAssetPath = (assetId: string) =>
  invoke<string>("voice_asset_path", { assetId });

export const ttsListVoices = () => invoke<TtsVoicesReport>("tts_list_voices");
export const ttsSynthesize = (args: {
  text: string;
  voiceId?: string;
  gender?: string;
  rate?: number;
  persist?: boolean;
  /** 合成引擎；缺省为 system。不可用引擎返回结构化 engine_unavailable */
  engine?: string;
}) => invoke<TtsSynthesisReport>("tts_synthesize", args);
export const ttsCacheStats = () => invoke<TtsCacheReport>("tts_cache_stats");
export const ttsCacheClear = () => invoke<TtsCacheClearReport>("tts_cache_clear");


export const resourceSnapshot = () => invoke<ResourceSnapshot>("resource_snapshot");
/** 只读进程诊断：仅在用户显式请求时调用；后端不结束进程、不读取命令行。 */
export const resourceProcessDiagnostics = () =>
  invoke<ResourceProcessDiagnostics>("resource_process_diagnostics");


export const resourceDiskUsage = () =>
  invoke<ResourceStorageBreakdown>("resource_disk_usage");


export const resourceDiskAnalyze = (path: string) =>
  invoke<ResourceDiskScanReport>("resource_disk_analyze", { path });
export const resourceMemoryCatalog = () =>
  invoke<ResourceMemoryCatalog>("resource_memory_catalog");
/** 释放应用自身可回收缓存；返回每项实际释放量（不做系统级内存优化）。 */
export const resourceMemoryRelease = () =>
  invoke<ResourceMemoryReleaseReport>("resource_memory_release");
export const resourceCleanupPreview = (categories: ResourceCleanupCategory[]) =>
  invoke<ResourceCleanupPreview>("resource_cleanup_preview", { categories });
export const resourceCleanupExecute = (args: {
  previewId: string;
  categories: ResourceCleanupCategory[];
}) => invoke<ResourceCleanupExecutionReport>("resource_cleanup_execute", args);


/** 只读扫描用户级垃圾；不删除、不写入。 */
export const resourceJunkPreview = (categories: ResourceJunkCategory[]) =>
  invoke<ResourceJunkPreview>("resource_junk_preview", { categories });
/** 执行已预览的用户级垃圾清理；previewId 一次性消费。 */
export const resourceJunkExecute = (args: {
  previewId: string;
  categories: ResourceJunkCategory[];
}) => invoke<ResourceJunkExecutionReport>("resource_junk_execute", args);

export const onAudioEvent = (cb: (payload: AudioEventPayload) => void): Promise<UnlistenFn> =>
  listen<AudioEventPayload>("audio-event", (e) => cb(e.payload));
export const saveWindowRect = (rect: { x: number; y: number; w: number; h: number }) =>
  invoke<void>("save_window_rect", { rect });
export const getWindowRect = () =>
  invoke<{ x: number; y: number; w: number; h: number } | null>("get_window_rect");
export const saveSnapState = (
  edge: string,
  hidden: boolean,
  center: number | null = null,
  extra: SnapStateExtra = {},
) =>
  invoke<void>("save_snap_state", {
    state: {
      edge,
      hidden,
      center,
      centerRatio: extra.centerRatio ?? null,
      display: extra.display ?? null,
      form: extra.form ?? null,
    },
  });
export const getSnapState = () =>
  invoke<
    | {
        edge: string;
        hidden: boolean;
        center?: number | null;
        centerRatio?: number | null;
        display?: SnapDisplayInfo | null;
        form?: "capsule" | "tab" | null;
      }
    | null
  >("get_snap_state");


export const exportData = (path: string) => invoke<string>("export_data", { path });
/** `passphrase`：填入时对备份的剪贴板段加密（≥8 字符），恢复需同一口令；留空保持原明文格式。
 *  `recoveryCode`：口令不可用时改用创建备份时展示的一次性恢复密钥。 */
export const importData = (
  path: string,
  allowPartial = false,
  passphrase?: string,
  recoveryCode?: string,
) =>
  invoke<RestoreOutcome>("import_data", {
    path,
    allowPartial,
    passphrase: passphrase ?? null,
    recoveryCode: recoveryCode ?? null,
  });
export const inspectBackup = (path: string) => invoke<BackupMeta>("inspect_backup", { path });
export const backupNow = (full = false, passphrase?: string) =>
  invoke<string>("backup_now", { full, passphrase: passphrase ?? null });
/** 口令加密剪贴板段备份；`withRecovery` 为真时返回一次性恢复密钥。 */
export const backupNowEncrypted = (
  full: boolean,
  passphrase: string,
  withRecovery: boolean,
) =>
  invoke<EncryptedBackupResult>("backup_now_encrypted", {
    full,
    passphrase,
    withRecovery,
  });
export const listBackups = () => invoke<BackupEntry[]>("list_backups");

// ── 用户偏好镜像（语言 / 桌面微件布局）──
// 运行时权威仍是 localStorage；这里只做文件镜像与恢复标记对账。
export const getUserPreferences = () =>
  invoke<UserPreferencesView>("get_user_preferences");
export const setUserPreferences = (
  locale: string | null,
  widgets: UserWidgetPreference[] | null,
  appliedRestoreId: string | null = null,
  appGridOrder: string[] | null = null,
) =>
  invoke<UserPreferencesView>("set_user_preferences", {
    locale,
    widgets,
    appGridOrder,
    appliedRestoreId,
  });


/** 历史压测/自测数据审计：apply=false 只预览，true 会先备份再删除可证明数据。 */
export const auditTestData = (apply = false) =>
  invoke<TestDataAudit>("audit_test_data", { apply });

export const quitApp = () => invoke<void>("quit_app");
/**
 * 主窗口统一关闭入口（自绘 X）：Rust 读取 `window_close_behavior` 后执行
 * 隐藏到托盘或 `request_exit`。前端不再自行决定关闭策略。
 */
export const requestMainWindowClose = () => invoke<void>("request_main_window_close");
export const onAppBeforeExit = (cb: (request: AppExitRequest) => void): Promise<UnlistenFn> =>
  listen<AppExitRequest>("app-before-exit", (event) => cb(event.payload));
/** 回执：true=草稿已落盘或无需落盘；false=保存失败/无守卫，Rust 取消本次退出。 */
export const appExitAck = (requestId: number, ok: boolean) =>
  invoke<boolean>("app_exit_ack", { requestId, ok });
export const onAppExitBlocked = (cb: (reason: string) => void): Promise<UnlistenFn> =>
  listen<{ reason: string }>("app-exit-blocked", (event) => cb(event.payload.reason));
export const setAutostart = (enabled: boolean) => invoke<boolean>("set_autostart", { enabled });
export const applyMode = (mode: string) => invoke<void>("apply_mode", { mode });

// ── 液态玻璃右键菜单（v0.6）──
export const hideContextMenu = () => invoke<void>("hide_context_menu");
/**
 * 下发窗口材质。`preset` 用于隔离清透玻璃：该预设必须保持「无原生模糊」，
 * 后端据此强制 CSS 通道，避免 Win10 Acrylic 把窗口后的桌面糊掉。
 */
export const applyWindowMaterial = (material: string, preset?: string) =>
  invoke<MaterialResult>("apply_window_material", { material, preset });

/**
 * 下发窗口圆角半径（逻辑像素）给 Win32 区域裁剪。
 * 返回 false 表示原生裁剪不可用（CSS 圆角仍在，四角可能露出原生背景直角）。
 */
export const applyWindowRadius = (radius: number) =>
  invoke<boolean>("apply_window_radius", { radius });
export const setHotkeysEnabled = (enabled: boolean) =>
  invoke<void>("set_hotkeys_enabled", { enabled });
export const getAgentInboxDir = () => invoke<string>("get_agent_inbox_dir");


/**
 * 分类胶囊区域（Smart Dock Capsule）：把主窗口的 Win32 区域裁成
 * 轨道（折叠态）或「轨道 ∪ 面板」（展开态），区域外不绘制、不命中鼠标。
 * **窗口位置与尺寸不变**——这是命中区稳定的前提。
 * `seq` 为前端单调序号：原生侧据此丢弃迟到的旧请求，保证最终区域由最新状态决定。
 * `panelWidthCss` 是工具面板当前宽度（280–480）：拖拽改变宽度时窗口不动，
 * 只按新宽度重写面板矩形；缺省时由后端按默认 340 处理。
 * 返回 false 表示应用失败或被乱序保护丢弃（前端按可见性兜底，不得假设胶囊形态生效）。
 */
export const applyWindowCapsule = (
  mode: CapsuleRegionMode,
  edge: string,
  seq: number,
  panelWidthCss?: number,
) => invoke<boolean>("apply_window_capsule", { mode, edge, seq, panelWidthCss });

/**
 * 拖拽磁力参数（CSS px）：吸引范围 / 最大额外位移 / 脱离拖动距离。
 *
 * 原生侧在 `WM_MOVING` 里按这组参数修正移动矩形，前端不参与逐帧移动。
 * `enabled=false` 时吸引与阻力同时失效（`snap_enabled` 关闭必须彻底停用）。
 * 返回值表示子类化是否已安装（false = 退化为纯阈值吸附，不影响停靠正确性）。
 */
export const setMagneticDragConfig = (
  enabled: boolean,
  range: number,
  maxLead: number,
  release: number,
) => invoke<boolean>("set_magnetic_drag_config", { enabled, range, maxLead, release });

/**
 * 停靠位（物理像素，齐平位置）：`edge=null` 表示未停靠（阻力失效）。
 * 前端只在停靠事务**提交成功后**下发，解除/关闭吸附/卸载时清除。
 */
export const setMagneticDock = (edge: string | null, x = 0, y = 0) =>
  invoke<boolean>("set_magnetic_dock", { edge, x, y });

/**
 * 拖离解除的鼠标锚定：请求原生在**拖拽循环内**把窗口恢复为 `mode` 的尺寸，
 * 并以「标题栏中心 = 光标」对齐（含工作区钳制，见 `magnetic::undock_anchor_rect`）。
 *
 * **只有用户拖离胶囊的解除路径调用**：按钮解除 / 打开完整页 / 托盘唤回等
 * 路径保持各自原有的定位策略。返回 false = 原生磁力层未安装，
 * 解除流程照常，由调用方按实际恢复后的窗口尺寸回退定位。
 */
export const setUndockAnchor = (mode: string, titlebarCss: number) =>
  invoke<boolean>("set_undock_anchor", { mode, titlebarCss });

/** 锚定请求是否已在拖拽循环内应用（取后复位）；false 时调用方需自行定位。 */
export const takeUndockAnchorApplied = () => invoke<boolean>("take_undock_anchor_applied");

/** 作废尚未应用的锚定请求（解除中止 / 回滚时防残留到下一次拖拽）。 */
export const cancelUndockAnchor = () => invoke<void>("cancel_undock_anchor");

/** 唤回事件：托盘/快捷键等入口发现主窗口"可见但大部分在屏外"时下发，
 *  前端吸附引擎据此安全展开（物理位置在屏外时仅 show/focus 找不回窗口）。 */
export const onSnapRecall = (cb: () => void): Promise<UnlistenFn> =>
  listen("snap-recall", () => cb());

/**
 * 首屏就绪：设置已加载且**启动时的停靠恢复结论已确定**，放行主窗口显示。
 *
 * 后端在「上次退出为停靠态」时延后 `show()`：先显示会露出完整主窗口再缩成
 * 胶囊（实测约 1.9s 的矩形窗口）。非停靠启动时窗口早已显示，本调用是 no-op。
 * 幂等，失败不重试（后端有 4s 兜底显示）。
 */
export const notifyUiReady = () => invoke<boolean>("notify_ui_ready");

export const hubHealth = () =>
  invoke<{ sources: number; sessions: number; runs: number; worst_state: string }>("hub_health");

export const performanceDiagnostics = () =>
  invoke<PerformanceDiagnostics>("performance_diagnostics");

export const appBuildInfo = () => invoke<AppBuildInfo>("app_build_info");

export const appRuntimeGitInfo = () => invoke<AppRuntimeGitInfo>("app_runtime_git_info");
export const agentRetentionStatus = () => invoke<Record<string, unknown>>("agent_retention_status");
export const agentRetentionRun = () => invoke<RetentionReport>("agent_retention_run");
export const agentArchiveList = () =>
  invoke<{ name: string; path: string; size: number; modified?: string }[]>("agent_archive_list");
export const agentInboxRetry = () => invoke<number>("agent_inbox_retry");

// ── 智能剪贴板（v0.5）──
export const clipboardView = (filter?: ClipboardFilter) =>
  invoke<ClipboardView>("clipboard_view", {
    // Rust 侧 ClipboardFilter.favorite 为非可选 bool（无 serde default），缺字段会被
    // serde 以「missing field favorite」拒绝；在 IPC 边界统一补齐默认值，
    // 调用方只需传自己关心的字段（轻量列表曾因只传 limit 而长期加载失败）。
    filter: {
      kind: filter?.kind ?? null,
      search: filter?.search ?? null,
      favorite: filter?.favorite ?? false,
      groupId: filter?.groupId ?? null,
      taskId: filter?.taskId ?? null,
      sourceApp: filter?.sourceApp ?? null,
      recentDays: filter?.recentDays ?? null,
      sort: filter?.sort ?? null,
      limit: filter?.limit ?? null,
      offset: filter?.offset ?? null,
    },
  });
export const clipboardSources = (limit = 12) =>
  invoke<ClipboardSourceOption[]>("clipboard_sources", { limit });
export const clipboardItem = (itemId: string) =>
  invoke<ClipboardItem>("clipboard_item", { itemId });
export const clipboardGroup = (groupId: string) =>
  invoke<ClipboardGroup>("clipboard_group", { groupId });
/**
 * 有界读取截图组（`clipboard_group_page`，参数 camelCase）：
 * limit 超过后端 `GROUP_PAGE_MAX_LIMIT=50` 会被截断并在响应 `limit` 回传实际值；
 * `imagesOnly` 为 true 时 SQL 阶段只取图片条目。Lite 封面用 limit 1、组预览用 limit 9。
 * 整组复制仍走 `clipboard_copy_group_rich`（完整数据），不要接到本命令上。
 */
export const clipboardGroupPage = (
  groupId: string,
  opts: { limit: number; offset?: number; imagesOnly?: boolean },
) =>
  invoke<ClipboardGroupPage>("clipboard_group_page", {
    groupId,
    limit: opts.limit,
    offset: opts.offset ?? 0,
    imagesOnly: opts.imagesOnly ?? false,
  });

export const clipboardGroupItemPosition = (groupId: string, itemId: string) =>
  invoke<ClipboardGroupItemPosition>("clipboard_group_item_position", {
    groupId,
    itemId,
  });
export const clipboardStats = () => invoke<ClipboardStats>("clipboard_stats");
/**
 * 加密现有剪贴板历史（正文 + 历史图片）。
 *
 * 后端会先做一次可核对备份（`VACUUM INTO` 快照 + 资产目录拷贝 + 回读计数校验），
 * 校验失败即中止且不写任何密文；结果返回备份路径/哈希与各类计数，供界面如实展示。
 */
export const clipboardEncryptHistoryMigrate = () =>
  invoke<ClipboardMigrationOutcome>("clipboard_encrypt_history_migrate");
export const clipboardThumb = (itemId: string) =>
  invoke<string | null>("clipboard_thumb", { itemId });
/**
 * 工作台大图预览（最长边 640px）。后端按需从原图生成并缓存，失败时回退缩略图。
 * 与 `clipboardThumb` 并存：列表/胶囊继续用 192px 缩略图，只有放大展示的卡片
 * 才请求预览规格，避免所有卡片同时拉高分辨率。
 */
export const clipboardPreview = (itemId: string) =>
  invoke<string | null>("clipboard_preview", { itemId });
export const clipboardImage = (itemId: string) =>
  invoke<string | null>("clipboard_image", { itemId });
/**
 * 图片文字识别：只传已有条目 id，Rust 侧直接读图片缓存，不通过 IPC 传整张图。
 *
 * 同一时刻最多 1 个任务；并发请求返回 `status: "busy"` 而不是排队。
 * `requestId` 用于精准取消（切换条目 / 离开详情），每次请求必须新生成。
 */
export const clipboardOcr = (itemId: string, requestId: string) =>
  invoke<ClipboardOcrReport>("clipboard_ocr", { itemId, requestId });
/** 取消进行中的识别；只匹配同一 requestId，未命中返回 false。 */
export const clipboardOcrCancel = (requestId: string) =>
  invoke<boolean>("clipboard_ocr_cancel", { requestId });
export const clipboardCopyItem = (itemId: string) =>
  invoke<CopyReport>("clipboard_copy_item", { itemId });
/** 通用文本写入：与单项复制共用后端受控写入与自写登记。 */
export const clipboardCopyText = (text: string) =>
  invoke<void>("clipboard_copy_text", { text });
/**
 * 图片另存为：把落盘 PNG 写入用户选择的路径，返回写入字节数。
 *
 * 系统保存对话框只负责选路径（当前 rfd 不设置 `FOS_OVERWRITEPROMPT`），不构成可验证的
 * 覆盖授权。目标已存在时，前端必须先经应用内确认框取得授权，才把 `overwrite=true`
 * 显式传给后端；该值只对本次调用有效，后端不会缓存或复用。
 */
export const clipboardSaveImage = (itemId: string, path: string, overwrite: boolean) =>
  invoke<number>("clipboard_save_image", { itemId, path, overwrite });
/** 用系统默认浏览器打开链接条目（后端校验仅 http/https）。 */
export const clipboardOpenUrl = (itemId: string) =>
  invoke<void>("clipboard_open_url", { itemId });
/** 用系统关联程序打开本地文件/目录（后端校验绝对路径且必须存在）。 */
export const clipboardOpenLocalPath = (path: string) =>
  invoke<void>("clipboard_open_local_path", { path });
/** 在资源管理器中定位文件（explorer /select）。 */
export const clipboardRevealLocalPath = (path: string) =>
  invoke<void>("clipboard_reveal_local_path", { path });
/**
 * 批量查询文件路径状态：ok / missing / inaccessible。
 *
 * 后端在阻塞线程池中批量执行（最多 200 条），同时最多 3 个批量任务；超出以
 * `SERVICE_OVERLOADED` 拒绝（不排队）。后台任务异常结束同样以错误拒绝：调用方必须
 * 按「未知」处理，不得把所有路径视为存在；「繁忙」也不得显示成文件丢失，且不得自动
 * 无限重试（当前调用方仅在重新进入详情时再查一次）。
 */
export const clipboardPathStatus = (paths: string[]) =>
  invoke<string[]>("clipboard_path_status", { paths });
export const clipboardCopyGroupRich = (groupId: string) =>
  invoke<CopyReport>("clipboard_copy_group_rich", { groupId });
export const clipboardCopyGroupFiles = (groupId: string) =>
  invoke<CopyReport>("clipboard_copy_group_files", { groupId });
/** 任意多选批量富文本复制：按选择顺序整合，不创建永久分组。 */
export const clipboardCopyItemsRich = (itemIds: string[]) =>
  invoke<CopyReport>("clipboard_copy_items_rich", { itemIds });
/** 任意多选批量文件复制：文件/图片条目取本地路径，普通文字不转为文件。 */
export const clipboardCopyItemsFiles = (itemIds: string[]) =>
  invoke<CopyReport>("clipboard_copy_items_files", { itemIds });
/** 编辑条目标题：非空设为手动标题；空串恢复自动生成。 */
export const clipboardRenameItem = (itemId: string, title: string) =>
  invoke<ClipboardItem>("clipboard_rename_item", { itemId, title });
export const clipboardToggleItem = (itemId: string, flag: "favorite" | "pinned") =>
  invoke<ClipboardItem>("clipboard_toggle_item", { itemId, flag });
export const clipboardToggleGroup = (groupId: string, flag: "favorite" | "pinned") =>
  invoke<ClipboardGroup>("clipboard_toggle_group", { groupId, flag });
export const clipboardCloseGroup = (groupId: string) =>
  invoke<ClipboardGroup>("clipboard_close_group", { groupId });
export const clipboardDeleteItems = (ids: string[]) =>
  invoke<DeleteReport>("clipboard_delete_items", { ids });
export const clipboardDeleteGroup = (groupId: string, alsoDeleteItems: boolean) =>
  invoke<DeleteReport>("clipboard_delete_group", { groupId, alsoDeleteItems });
/** 清空全部剪贴板历史（含收藏/置顶），不影响系统剪贴板与外部文件。 */
export const clipboardClearHistory = () =>
  invoke<ClearReport>("clipboard_clear_history");
export const clipboardCreateGroup = (name: string, itemIds: string[]) =>
  invoke<ClipboardGroup>("clipboard_create_group", { name, itemIds });
export const clipboardRenameGroup = (groupId: string, name: string) =>
  invoke<ClipboardGroup>("clipboard_rename_group", { groupId, name });
export const clipboardAddToGroup = (groupId: string, itemIds: string[]) =>
  invoke<ClipboardGroup>("clipboard_add_to_group", { groupId, itemIds });
export const clipboardRemoveGroupItem = (groupId: string, itemId: string) =>
  invoke<ClipboardGroup>("clipboard_remove_group_item", { groupId, itemId });
export const clipboardMoveGroupItem = (groupId: string, itemId: string, newIndex: number) =>
  invoke<ClipboardGroup>("clipboard_move_group_item", { groupId, itemId, newIndex });
export const clipboardSplitGroup = (groupId: string, itemIds: string[], name: string) =>
  invoke<ClipboardGroup>("clipboard_split_group", { groupId, itemIds, name });
export const clipboardMergeGroups = (groupIds: string[], name: string) =>
  invoke<ClipboardGroup>("clipboard_merge_groups", { groupIds, name });
export const clipboardLinkTask = (taskId: string, targetType: "item" | "group", targetId: string) =>
  invoke<ClipboardTaskLink>("clipboard_link_task", { taskId, targetType, targetId });
export const clipboardUnlinkTask = (linkId: string) =>
  invoke<void>("clipboard_unlink_task", { linkId });
export const clipboardTaskLinks = (taskId: string) =>
  invoke<ClipboardTaskLink[]>("clipboard_task_links", { taskId });
export const clipboardVisibleTargets = () =>
  invoke<PasteTarget[]>("clipboard_visible_targets");
/**
 * 目标窗口的真实应用图标（PNG data URL；无图标返回 null）。
 * 后端按当前窗口身份重新解析 exe 路径并提取，前端不能传任意路径。
 */
export const clipboardTargetIcon = (hwnd: number, expectedPid?: number) =>
  invoke<string | null>("clipboard_target_icon", { hwnd, expectedPid });
export const clipboardForegroundTarget = () =>
  invoke<PasteTarget | null>("clipboard_foreground_target");
/** `expectedPid` 是选中窗口时记录的进程号；HWND 复用时会拒绝操作。 */
export const clipboardPastePrecheck = (hwnd: number, expectedPid?: number) =>
  invoke<PasteTarget>("clipboard_paste_precheck", { hwnd, expectedPid });
export const clipboardPasteGroup = (
  groupId: string,
  targetHwnd: number,
  expectedPid?: number,
  itemIds?: string[],
) => invoke<PasteStartReport>("clipboard_paste_group", { groupId, targetHwnd, expectedPid, itemIds });
/** 任意多选逐项粘贴：不依赖永久分组，按传入顺序逐条写入并发送。 */
export const clipboardPasteItems = (targetHwnd: number, expectedPid: number | undefined, itemIds: string[]) =>
  invoke<PasteStartReport>("clipboard_paste_items", { targetHwnd, expectedPid, itemIds });
export const clipboardPasteCancel = (jobId: string) =>
  invoke<void>("clipboard_paste_cancel", { jobId });
export const clipboardPasteResume = (jobId: string, targetHwnd: number, expectedPid?: number) =>
  invoke<PasteStartReport>("clipboard_paste_resume", { jobId, targetHwnd, expectedPid });
/** 跳转到目标窗口：只激活并核实前台，不写剪贴板、不发送按键。失败抛出具体原因。 */
export const clipboardFocusTarget = (hwnd: number, expectedPid?: number) =>
  invoke<PasteTarget>("clipboard_focus_target", { hwnd, expectedPid });
export const clipboardPasteJob = (jobId: string) =>
  invoke<PasteJob>("clipboard_paste_job", { jobId });
export const clipboardPasteItemStates = (jobId: string) =>
  invoke<PasteItemState[]>("clipboard_paste_item_states", { jobId });
export const clipboardPasteActive = () =>
  invoke<string | null>("clipboard_paste_active");
/**
 * 最近一个可以继续的粘贴任务（暂停 / 进程中断且仍有剩余条目）。
 * `clipboardPasteActive` 只反映内存里正在跑的任务，页面切走或应用重启后就查不到了。
 */
export const clipboardPasteResumableJob = () =>
  invoke<PasteJob | null>("clipboard_paste_resumable_job");
/**
 * 全部可继续的粘贴任务（按 started_at 倒序，可按分组过滤）。
 * 与单任务版本并存：旧任务不会被更新的新任务静默覆盖，UI 可让用户显式选择恢复哪一个。
 */
export const clipboardPasteResumableJobs = (groupId?: string | null) =>
  invoke<PasteJob[]>("clipboard_paste_resumable_jobs", { groupId: groupId ?? null });
/**
 * 显式处置不确定项：`received` = 确认目标已收到，`resend` = 确认没收到并要求重发。
 * 只允许用户触发；不确定项不会自动回到待处理队列，否则会造成重复粘贴。
 */
export const clipboardPasteResolveUncertain = (
  jobId: string,
  itemId: string,
  action: "received" | "resend",
) => invoke<void>("clipboard_paste_resolve_uncertain", { jobId, itemId, action });
export const clipboardCleanup = () => invoke<CleanupReport>("clipboard_cleanup");
export const clipboardStatus = () => invoke<ClipboardStatus>("clipboard_status");
/** 用户显式修复损坏的剪贴板配置；resume=true 时同时恢复自动记录。 */
export const clipboardRepairConfig = (resume: boolean) =>
  invoke<Settings>("clipboard_repair_config", { resume });
export const clipboardAgentTargets = (refresh = false) =>
  invoke<AgentTargetsSnapshot>("clipboard_agent_targets", { refresh });
export const clipboardExportForAgent = (
  targetType: "item" | "group",
  targetId: string,
  taskId?: string | null,
) => invoke<ExportPackage>("clipboard_export_for_agent", { targetType, targetId, taskId });
export const clipboardExportPreview = (targetType: "item" | "group", targetId: string) =>
  invoke<Record<string, unknown>>("clipboard_export_preview", { targetType, targetId });
/** 手动清理过期导出目录；默认保留 7 天，只删 `clipboard-exports/<uuid>/` 子目录。 */
export const clipboardPurgeAgentExports = (olderThanDays = 7) =>
  invoke<ExportPurgeReport>("clipboard_purge_agent_exports", {
    olderThanDays,
  });
/** 只读探测当前剪贴板可读性与格式，不返回正文。 */
export const clipboardProbe = () => invoke<ClipboardProbe>("clipboard_probe");


export const actionsFeed = (filter?: ActionFilter) =>
  invoke<ActionFeed>("actions_feed", { filter });
/** ID 为 ActionItem.id（`run:` / `notification:`），不再使用原始事件 ID。 */
export const actionsAck = (ids: string[]) => invoke<number>("actions_ack", { eventIds: ids });
export const actionsUnack = (ids: string[]) =>
  invoke<number>("actions_unack", { eventIds: ids });
export const actionsOpenSession = (sourceId: string, sessionId: string) =>
  invoke<import("./navigation").NavigationResult>("actions_open_session", { sourceId, sessionId });


export const workspaceList = (taskId?: string | null) =>
  invoke<SnapshotSummary[]>("workspace_list", { taskId });
export const workspaceGet = (id: string) => invoke<SnapshotDetail>("workspace_get", { id });
export const workspaceCreate = (input: CaptureInput) =>
  invoke<SnapshotDetail>("workspace_create", { input });
export const workspaceCaptureTask = (taskId: string, name?: string, note?: string) =>
  invoke<SnapshotDetail>("workspace_capture_task", { taskId, name, note });
export const workspaceRename = (id: string, name: string, note?: string) =>
  invoke<void>("workspace_rename", { id, name, note });
export const workspaceDelete = (id: string) => invoke<void>("workspace_delete", { id });
export const workspacePrune = (keep?: number) =>
  invoke<PruneReport>("workspace_prune", { keep });
export const workspaceDetachTask = (id: string) => invoke<void>("workspace_detach_task", { id });
export const workspaceCaptureWindows = () =>
  invoke<CaptureWindow[]>("workspace_capture_windows");
export const workspaceRestore = (id: string) => invoke<boolean>("workspace_restore", { id });
export const workspaceRestoreCancel = () => invoke<void>("workspace_restore_cancel");
export const workspaceRestoreStatus = () =>
  invoke<RestoreStatus>("workspace_restore_status");


export const taskContext = (taskId: string) => invoke<TaskContext>("task_context", { taskId });

export const clipboardLinkSnapshot = (
  snapshotId: string,
  targetType: "item" | "group",
  targetId: string,
) => invoke<ClipboardSnapshotLink>("clipboard_link_snapshot", { snapshotId, targetType, targetId });
export const clipboardUnlinkSnapshot = (linkId: string) =>
  invoke<void>("clipboard_unlink_snapshot", { linkId });
export const clipboardSnapshotLinks = (snapshotId: string) =>
  invoke<ClipboardSnapshotLink[]>("clipboard_snapshot_links", { snapshotId });


/** 一个任务最多一条联动；set 覆盖既有关联，目标已删除时拒绝。 */
export const taskReminderLinkGet = (taskId: string) =>
  invoke<TaskReminderLink | null>("task_reminder_link_get", { taskId });
export const taskReminderLinkSet = (
  taskId: string,
  targetKind: ReminderLinkKind,
  targetId: string,
) => invoke<TaskReminderLink>("task_reminder_link_set", { taskId, kind: targetKind, targetId });
export const taskReminderLinkClear = (taskId: string) =>
  invoke<void>("task_reminder_link_clear", { taskId });


export const quickCaptureState = () => invoke<CaptureState>("quick_capture_state");
/** 保存草稿；content trim 后为空 = 清空草稿（后端仍返回 saved_at）。 */
export const quickCaptureSaveDraft = (kind: string, content: string) =>
  invoke<CaptureDraftSaved>("quick_capture_save_draft", { kind, content });
export const quickCaptureClearDraft = () => invoke<void>("quick_capture_clear_draft");
export const quickCaptureSetLastType = (kind: string) =>
  invoke<void>("quick_capture_set_last_type", { kind });
export const quickCaptureSubmit = (input: SubmitCaptureInput) =>
  invoke<SubmitCaptureResult>("quick_capture_submit", { input });
/** status：null/"all" = 全部；"inbox" = 未处理；limit 默认 50、上限 200。 */
export const quickCaptureList = (
  status?: string | null,
  limit?: number,
  offset?: number,
) => invoke<CaptureItem[]>("quick_capture_list", { status: status ?? null, limit, offset });
export const quickCaptureMarkHandled = (id: string) =>
  invoke<CaptureItem>("quick_capture_mark_handled", { id });
export const quickCaptureDelete = (id: string) => invoke<void>("quick_capture_delete", { id });
/** 转为任务（后端复用任务创建链路并回写 task_id/status）。 */
export const quickCaptureConvertToTask = (id: string) =>
  invoke<CaptureItem>("quick_capture_convert_to_task", { id });
export const quickCaptureShow = () =>
  invoke<QuickCaptureShowResult>("quick_capture_show");
/**
 * 只做前台激活（窗口已显示但系统未自动给焦点时的一次补救）。
 * 返回是否已确认在前台；后端有每轮显示的次数上限，不会无界抢焦点。
 */
export const quickCaptureFocus = () => invoke<boolean>("quick_capture_focus");
/**
 * 隐藏捕获窗口并恢复原前台焦点（后端实现）。
 * 返回是否真的收起（以及是否本来就不可见）；失败会抛出，前端必须给出反馈，
 * 不能静默吞掉。reason 仅用于前端语义标注，不会发给后端。
 */
export const quickCaptureHide = (_reason?: "user" | "success") =>
  invoke<QuickCaptureHideResult>("quick_capture_hide");
/**
 * 添加一张粘贴图片：`dataBase64` 是前端 canvas 归一化后的 PNG，
 * 后端再做签名/尺寸校验、落盘并返回附件元数据。失败时抛出可展示的错误。
 */
export const quickCaptureAddAttachment = (dataBase64: string, mime: string) =>
  invoke<CaptureAttachment>("quick_capture_add_attachment", { dataBase64, mime });
/** 删除草稿附件（同时删除磁盘文件）；已提交条目的图片不走这里。 */
export const quickCaptureRemoveAttachment = (id: string) =>
  invoke<void>("quick_capture_remove_attachment", { id });
/** 附件缩略图（data URL，约 192px）；不存在时返回 null。 */
export const quickCaptureAttachmentThumb = (id: string) =>
  invoke<string | null>("quick_capture_attachment_thumb", { id });
/** 附件原图（data URL）；仅用于大图预览，不参与列表渲染。 */
export const quickCaptureAttachmentPreview = (id: string) =>
  invoke<string | null>("quick_capture_attachment_preview", { id });


export const quickCaptureVoiceStart = () =>
  invoke<CaptureVoiceStartResult>("quick_capture_voice_start");
/**
 * 停止听写并释放麦克风；返回停止瞬间才定稿的片段
 * （WinRT StopAsync 会补发待定结果；未启动过时为空数组）。
 */
export const quickCaptureVoiceStop = () => invoke<string[]>("quick_capture_voice_stop");
/** 打开 Windows「语音」隐私设置（在线语音识别未开启时的一步恢复入口）。 */
export const quickCaptureOpenSpeechSettings = () =>
  invoke<void>("quick_capture_open_speech_settings");


/**
 * 归一化 agent-changed 载荷（运行时校验，不依赖 TS 断言）。
 * - 非对象 / null / 数组 / `sources` 或 `source_id` 类型非法 → 返回 null（调用方应忽略，
 *   不抛 TypeError、不刷新）。
 * - 缺少可选字段（`states`、`batch`、`changed` 等）→ 补默认值，仍视为合法事件。
 * - 缺少 `sources` 但有 `source_id` → `sources=[source_id]`。
 * - 仅有 `stale_cleanup` 的旧载荷 → 规范为全局事件（`sources=[]`、`changed=true`），
 *   由所有历史分区与实时摘要刷新消费，不误报为任务成功/失败。
 */
export function normalizeAgentChangedPayload(
  payload: unknown,
): AgentChangedEvent | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  const hasSignal =
    "changed" in raw ||
    "stale_cleanup" in raw ||
    "states" in raw ||
    "sources" in raw ||
    "source_id" in raw ||
    "session_id" in raw;
  if (!hasSignal) return null;
  if (
    "sources" in raw &&
    raw.sources !== undefined &&
    !Array.isArray(raw.sources)
  ) {
    return null;
  }
  if (
    "source_id" in raw &&
    raw.source_id !== undefined &&
    typeof raw.source_id !== "string"
  ) {
    return null;
  }
  if (
    "session_id" in raw &&
    raw.session_id !== undefined &&
    typeof raw.session_id !== "string"
  ) {
    return null;
  }
  if (
    "states" in raw &&
    raw.states !== undefined &&
    (typeof raw.states !== "object" || raw.states === null || Array.isArray(raw.states))
  ) {
    return null;
  }
  if (
    "stale_cleanup" in raw &&
    raw.stale_cleanup !== undefined &&
    typeof raw.stale_cleanup !== "number"
  ) {
    return null;
  }
  const sources: string[] = Array.isArray(raw.sources)
    ? (raw.sources as unknown[]).filter(
        (s): s is string => typeof s === "string",
      )
    : typeof raw.source_id === "string" && raw.source_id
      ? [raw.source_id]
      : [];
  const sourceId =
    typeof raw.source_id === "string" && raw.source_id
      ? raw.source_id
      : (sources[0] ?? "");
  const states: Record<string, number> = {};
  if (raw.states && typeof raw.states === "object" && !Array.isArray(raw.states)) {
    for (const [k, v] of Object.entries(raw.states as Record<string, unknown>)) {
      if (typeof v === "number") states[k] = v;
    }
  }
  const staleCleanup =
    typeof raw.stale_cleanup === "number" ? raw.stale_cleanup : undefined;
  const batch =
    typeof raw.batch === "number"
      ? raw.batch
      : (staleCleanup ?? sources.length);
  return {
    source_id: sourceId,
    sources,
    session_id: typeof raw.session_id === "string" ? raw.session_id : "",
    run_id:
      typeof raw.run_id === "string" || raw.run_id === null
        ? (raw.run_id as string | null)
        : null,
    state: typeof raw.state === "string" ? raw.state : null,
    states,
    batch,
    changed: raw.changed === false ? false : true,
    deduplicated: raw.deduplicated === true,
    late: raw.late === true,
    ...(staleCleanup !== undefined ? { stale_cleanup: staleCleanup } : {}),
  };
}
export const onAgentChanged = (cb: (payload: AgentChangedEvent) => void): Promise<UnlistenFn> =>
  listen<unknown>("agent-changed", (e) => {
    const normalized = normalizeAgentChangedPayload(e.payload);
    if (normalized) cb(normalized);
  });
export const onReminderFired = (cb: () => void): Promise<UnlistenFn> =>
  listen("reminder-fired", () => cb());
/** 延后成功（任意入口）：后端统一广播，主窗口弹带「撤销」的 Toast */
export const onReminderSnoozed = (cb: (payload: SnoozeResult) => void): Promise<UnlistenFn> =>
  listen<SnoozeResult>("reminder-snoozed", (e) => cb(e.payload));
export const onNotification = (cb: () => void): Promise<UnlistenFn> =>
  listen("notification", () => cb());
export const onModeChanged = (cb: (mode: string) => void): Promise<UnlistenFn> =>
  listen<string>("mode-changed", (e) => cb(e.payload));
export const onThemeChanged = (cb: (theme: string) => void): Promise<UnlistenFn> =>
  listen<string>("theme-changed", (e) => cb(e.payload));
/** 右键菜单切换「边缘吸附方式」后广播：capsule | full（主窗口据此原地切换形态）。 */
export const onSnapFormChanged = (cb: (form: string) => void): Promise<UnlistenFn> =>
  listen<string>("snap-form-changed", (e) => cb(e.payload));
export const onFocusQuickAdd = (cb: () => void): Promise<UnlistenFn> =>
  listen("focus-quick-add", () => cb());
export const onAppReady = (cb: () => void): Promise<UnlistenFn> =>
  listen("app-ready", () => cb());
export const onNotificationNavigate = (
  cb: (payload: NotificationNavigatePayload) => void,
): Promise<UnlistenFn> =>
  listen<NotificationNavigatePayload>("notification-navigate", (e) => cb(e.payload));
export const onClipboardChanged = (
  cb: (payload: { kind: string; created?: boolean; grouped?: boolean }) => void,
): Promise<UnlistenFn> =>
  listen<{ kind: string; created?: boolean; grouped?: boolean }>("clipboard-changed", (e) =>
    cb(e.payload),
  );
export const onClipboardPaste = (cb: (payload: ClipboardPasteEvent) => void): Promise<UnlistenFn> =>
  listen<ClipboardPasteEvent>("clipboard-paste", (e) => cb(e.payload));

export const onWorkspaceRestoreProgress = (
  cb: (payload: WorkspaceRestoreProgress) => void,
): Promise<UnlistenFn> =>
  listen<WorkspaceRestoreProgress>("workspace-restore-progress", (e) => cb(e.payload));
export const onWorkspaceChanged = (
  cb: (payload: { kind: string }) => void,
): Promise<UnlistenFn> =>
  listen<{ kind: string }>("workspace-changed", (e) => cb(e.payload));

export const onAgentRetention = (cb: (payload: RetentionReport) => void): Promise<UnlistenFn> =>
  listen<RetentionReport>("agent-retention", (e) => cb(e.payload));

// ── 快速捕获事件（v0.7）──
/** 捕获窗口被唤起（后端已 show）后触发：前端借此刷新状态、恢复草稿、聚焦输入框。 */
export const onQuickCaptureSummoned = (cb: () => void): Promise<UnlistenFn> =>
  listen("quick-capture-summoned", () => cb());
/** 捕获窗口被隐藏（用户关闭 / 成功后自动隐藏 / 失焦）。 */
export const onQuickCaptureHidden = (cb: () => void): Promise<UnlistenFn> =>
  listen("quick-capture-hidden", () => cb());
export const onQuickCaptureCreated = (
  cb: (payload: QuickCaptureCreatedEvent) => void,
): Promise<UnlistenFn> =>
  listen<QuickCaptureCreatedEvent>("quick-capture-created", (e) => cb(e.payload));
/** 应用退出前要求立即落盘草稿（窗口可能即将销毁）。 */
export const onCaptureFlushDraft = (cb: () => void): Promise<UnlistenFn> =>
  listen("capture-flush-draft", () => cb());


/** 临时识别结果（实时字幕，会被下一帧替换，不写入正文）。 */
export const onCaptureVoicePartial = (
  cb: (payload: CaptureVoiceText) => void,
): Promise<UnlistenFn> =>
  listen<CaptureVoiceText>("capture-voice-partial", (e) => cb(e.payload));
/** 定稿片段（前端追加进正文，草稿防抖负责落盘）。 */
export const onCaptureVoiceFinal = (
  cb: (payload: CaptureVoiceText) => void,
): Promise<UnlistenFn> =>
  listen<CaptureVoiceText>("capture-voice-final", (e) => cb(e.payload));
export const onCaptureVoiceStatus = (
  cb: (payload: CaptureVoiceStatus) => void,
): Promise<UnlistenFn> =>
  listen<CaptureVoiceStatus>("capture-voice-status", (e) => cb(e.payload));


export const planningListProjects = (includeArchived?: boolean) =>
  invoke<PlanningProject[]>("planning_list_projects", { includeArchived });
export const planningCreateProject = (input: PlanningProjectInput) =>
  invoke<PlanningProject>("planning_create_project", { input });
/** 计划聚合写：只改执行状态/排序，必须带计划 revision。 */
export const planningUpdatePlan = (id: string, patch: PlanningProjectPatch) =>
  invoke<PlanningPlan>("planning_update_plan", { id, patch });
/** 项目根聚合写：名称/描述/目标日期/生命周期，必须带项目根 revision。 */
export const planningUpdateProjectRoot = (id: string, patch: ProjectRootPatch) =>
  invoke<ProjectAndPlanOutcome>("planning_update_project_root", { id, patch });
/** 两个聚合同一事务写：任一 revision 冲突整体回滚。 */
export const planningUpdateProjectAndPlan = (
  id: string,
  project: ProjectRootPatch,
  plan: PlanningProjectPatch,
) =>
  invoke<ProjectAndPlanOutcome>("planning_update_project_and_plan", {
    id,
    project,
    plan,
  });
export const planningArchiveProject = (id: string, archived: boolean) =>
  invoke<PlanningProject>("planning_archive_project", { id, archived });
export const planningDeleteProject = (id: string) =>
  invoke<void>("planning_delete_project", { id });
export const planningReorderProjects = (ids: string[]) =>
  invoke<void>("planning_reorder_projects", { ids });

export const planningListFeatures = (projectId: string) =>
  invoke<PlanningFeature[]>("planning_list_features", { projectId });
export const planningListFeatureAgentLinks = (featureId: string) =>
  invoke<PlanningAgentFeatureLink[]>("planning_list_feature_agent_links", { featureId });
export const planningListAgentFeatureLinks = (agentSource: string, sessionId: string) =>
  invoke<PlanningAgentFeatureLink[]>("planning_list_agent_feature_links", { agentSource, sessionId });
export const planningUnlinkAgentSession = (
  featureId: string,
  agentSource: string,
  sessionId: string,
) => invoke<void>("planning_unlink_agent_session", { featureId, agentSource, sessionId });
export const planningCreateFeature = (projectId: string, input: PlanningFeatureInput) =>
  invoke<PlanningFeature>("planning_create_feature", { projectId, input });
export const planningUpdateFeature = (id: string, patch: PlanningFeaturePatch) =>
  invoke<PlanningFeature>("planning_update_feature", { id, patch });
export const planningDeleteFeature = (id: string) =>
  invoke<void>("planning_delete_feature", { id });
export const planningReorderFeatures = (projectId: string, ids: string[]) =>
  invoke<void>("planning_reorder_features", { projectId, ids });

export const planningAddStep = (featureId: string, title: string) =>
  invoke<PlanningFeature>("planning_add_step", { featureId, title });
export const planningUpdateStep = (id: string, patch: PlanningStepPatch) =>
  invoke<PlanningFeature>("planning_update_step", { id, patch });
export const planningDeleteStep = (id: string) =>
  invoke<PlanningFeature>("planning_delete_step", { id });
export const planningReorderSteps = (featureId: string, ids: string[]) =>
  invoke<PlanningFeature>("planning_reorder_steps", { featureId, ids });

export const planningListMilestones = (projectId: string) =>
  invoke<PlanningMilestone[]>("planning_list_milestones", { projectId });
export const planningCreateMilestone = (projectId: string, input: PlanningMilestoneInput) =>
  invoke<PlanningMilestone>("planning_create_milestone", { projectId, input });
export const planningUpdateMilestone = (id: string, patch: PlanningMilestonePatch) =>
  invoke<PlanningMilestone>("planning_update_milestone", { id, patch });
export const planningDeleteMilestone = (id: string) =>
  invoke<void>("planning_delete_milestone", { id });

export const planningActivityPage = (
  projectId: string,
  opts?: { featureId?: string | null; limit?: number; offset?: number },
) =>
  invoke<PlanningActivityPage>("planning_activity_page", {
    projectId,
    featureId: opts?.featureId ?? null,
    limit: opts?.limit ?? null,
    offset: opts?.offset ?? null,
  });
export const planningAddNote = (
  projectId: string,
  featureId: string | null,
  message: string,
) => invoke<PlanningActivity>("planning_add_note", { projectId, featureId, message });

/** 规划中心展示辅助：功能状态 → 中文标签（与 featureCatalog 状态语义相互独立）。 */
export const PLANNING_FEATURE_STATUS_LABELS: Record<PlanningFeatureStatus, string> = {
  planned: "待开发",
  in_progress: "开发中",
  review: "待验收",
  completed: "已完成",
  blocked: "受阻",
  paused: "已暂停",
};

export const PLANNING_PROJECT_STATUS_LABELS: Record<PlanningProjectStatus, string> = {
  planning: "规划中",
  in_progress: "进行中",
  paused: "已暂停",
  completed: "已完成",
};


export const agentMcpStatus = () => invoke<McpStatus>("mcp_status", {});
export const agentMcpList = () => invoke<McpAgentInfo[]>("mcp_agent_list", {});
export const agentMcpCreate = (agentId: string, displayName: string) =>
  invoke<McpAgentCreated>("mcp_agent_create", { agentId, displayName });
export const agentMcpRotateToken = (id: string) =>
  invoke<McpAgentCreated>("mcp_agent_rotate_token", { id });
export const agentMcpSetScope = (id: string, scope: McpAgentScope) =>
  invoke<McpAgentInfo>("mcp_agent_set_scope", { id, scope });
export const agentMcpGrantProject = (id: string, projectId: string) =>
  invoke<McpAgentInfo>("mcp_agent_grant_project", { id, projectId });
export const agentMcpRevokeProject = (id: string, projectId: string) =>
  invoke<McpAgentInfo>("mcp_agent_revoke_project", { id, projectId });
export const agentMcpRevoke = (id: string) => invoke<McpAgentInfo>("mcp_agent_revoke", { id });

export const agentAccessStatus = () => invoke<AgentAccessData>("agent_access_status", {});
export const agentAccessInit = (path?: string, name?: string) =>
  invoke<AgentAccessData>("agent_access_init", { path, name });
export const agentAccessManifest = () => invoke<AgentAccessData>("agent_access_manifest", {});
export const agentAccessExport = () => invoke<AgentAccessData>("agent_access_export", {});
export const agentAccessScan = () => invoke<AgentAccessData>("agent_access_scan", {});
export const agentAccessSyncStatus = () => invoke<AgentAccessData>("agent_access_sync_status", {});
export const agentAccessConflicts = () => invoke<AgentAccessData>("agent_access_conflicts", {});
export const agentAccessConflictDetail = (conflictId: string) =>
  invoke<AgentAccessData>("agent_access_conflict_detail", { conflictId });
/**
 * 冲突解决方式。与 Rust `sync::resolve_conflict` 的枚举严格一致：
 * db = 保留 TaskDock 数据，file = 接受外部文件，dismiss = 暂时忽略。
 */
export type ConflictResolution = "db" | "file" | "dismiss";
export const agentAccessResolveConflict = (
  conflictId: string,
  resolution: ConflictResolution,
) => invoke<AgentAccessData>("agent_access_resolve_conflict", { conflictId, resolution });
export const agentAccessImportRequests = (params?: { status?: string }) =>
  invoke<AgentAccessData>("agent_access_import_requests", params ?? {});
export const agentAccessImportApprove = (requestId: string, note?: string) =>
  invoke<AgentAccessData>("agent_access_import_approve", { requestId, note });
export const agentAccessImportReject = (requestId: string, reason?: string) =>
  invoke<AgentAccessData>("agent_access_import_reject", { requestId, reason });
export const agentAccessImportPolicies = () =>
  invoke<AgentAccessData>("agent_access_import_policies", {});
export const agentAccessImportPolicySet = (params: {
  relDir: string;
  mode: "off" | "review" | "trusted";
  agentRowId?: string;
  capabilities?: string[];
  projectId?: string;
}) => invoke<AgentAccessData>("agent_access_import_policy_set", params);
export const agentAccessImportPolicyRemove = (authorizationId: string) =>
  invoke<AgentAccessData>("agent_access_import_policy_remove", { authorizationId });
export const agentAccessActivity = (params: {
  agentId?: string;
  interface?: string;
  since?: string;
  limit?: number;
  offset?: number;
}) => invoke<AgentAccessData>("agent_access_activity", params);
export const agentAccessHandoffs = (params: {
  status?: string;
  projectId?: string;
  limit?: number;
  offset?: number;
}) => invoke<AgentAccessData>("agent_access_handoffs", params);
export const agentAccessHandoffDetail = (handoffId: string) =>
  invoke<AgentAccessData>("agent_access_handoff_detail", { handoffId });
export const agentAccessHandoffTransition = (
  handoffId: string,
  action: "accept" | "reject" | "complete",
  baseRevision: number,
  reason?: string,
) =>
  invoke<AgentAccessData>("agent_access_handoff_transition", {
    handoffId,
    action,
    baseRevision,
    reason,
  });
export const agentAccessReports = (params: {
  agentId?: string;
  handoffId?: string;
  limit?: number;
  offset?: number;
}) => invoke<AgentAccessData>("agent_access_reports", params);
export const agentAccessAgents = () => invoke<AgentAccessData>("agent_access_agents", {});
export const agentAccessPermissions = (agentRowId: string) =>
  invoke<AgentAccessData>("agent_access_permissions", { agentRowId });
export const agentAccessGrant = (agentRowId: string, capability: string, resourceId = "") =>
  invoke<AgentAccessData>("agent_access_grant", { agentRowId, capability, resourceId });
export const agentAccessRevoke = (agentRowId: string, capability: string, resourceId = "") =>
  invoke<AgentAccessData>("agent_access_revoke", { agentRowId, capability, resourceId });
export const agentAccessContext = (params: {
  projectId?: string;
  task?: string;
  taskId?: string;
  budgetTokens?: number;
  format?: "markdown" | "json";
}) => invoke<AgentAccessData>("agent_access_context", params);
export const agentAccessConfigInfo = () => invoke<AgentAccessData>("agent_access_config_info", {});

export const agentMcpAuditList = (offset: number, limit: number) =>
  invoke<McpAuditPage>("mcp_audit_list", { offset, limit });
export const agentMcpConfigSnippet = (client: McpConfigClient, agentToken: string) =>
  invoke<string>("mcp_config_snippet", { input: { client, agentToken } });
export const agentMcpConfigHint = (client: McpConfigClient) =>
  invoke<string>("mcp_config_hint", { client });
export const agentMcpCapabilities = (id: string) =>
  invoke<McpCapabilityGrant[]>("mcp_agent_capabilities", { id });
export const agentMcpGrantCapability = (
  id: string,
  capability: McpCapability,
  resourceId = "",
) =>
  invoke<McpCapabilityGrant[]>("mcp_agent_grant_capability", {
    id,
    capability,
    resourceId,
  });
export const agentMcpRevokeCapability = (
  id: string,
  capability: McpCapability,
  resourceId = "",
) =>
  invoke<McpCapabilityGrant[]>("mcp_agent_revoke_capability", {
    id,
    capability,
    resourceId,
  });
export const agentMcpWorkspaceRoots = (id: string) =>
  invoke<McpWorkspaceRoot[]>("mcp_workspace_roots", { id });
export const agentMcpGrantWorkspaceRoot = (id: string, path: string) =>
  invoke<McpWorkspaceRoot[]>("mcp_workspace_grant_root", { id, path });
export const agentMcpRevokeWorkspaceRoot = (id: string, rootId: string) =>
  invoke<McpWorkspaceRoot[]>("mcp_workspace_revoke_root", { id, rootId });
export const agentMcpAuditPrune = (metadataDays?: number, payloadDays?: number) =>
  invoke<{
    deletedRows: number;
    clearedPayloads: number;
    replayableRows: number;
    metadataCutoff: string;
    payloadCutoff: string;
  }>("mcp_audit_prune", { metadataDays, payloadDays });
export const agentMcpDiagnostics = (agentId?: string) =>
  invoke<McpDiagnosticsReport>("mcp_diagnostics", { agentId });


export const onPlanningChanged = (
  cb: (payload: PlanningChangedEvent) => void,
): Promise<UnlistenFn> =>
  listen<PlanningChangedEvent>("planning-changed", (e) => cb(e.payload));

// ── Agent 操作生命周期（v86）────────────────────────────────────
// 事件只承载元数据，前端按 operationId 合并；丢失后由游标同步补齐。
// 注意：独立 CLI 进程不会发 Tauri 事件，`agentOperationsSync` 是跨进程唯一通道。

export const AGENT_OPERATION_CHANGED_EVENT = "agent-operation-changed";

export const onAgentOperationChanged = (
  cb: (payload: AgentOperationChangeEvent) => void,
): Promise<UnlistenFn> =>
  listen<AgentOperationChangeEvent>(AGENT_OPERATION_CHANGED_EVENT, (e) => cb(e.payload));

/** 游标增量同步：只读取游标之后的变更，不重复全量拉取。 */
export const agentOperationsSync = (cursor: AgentOperationCursor | null, limit = 50) =>
  invoke<AgentOperationSync>("agent_operations_sync", { cursor, limit });

export const agentOperationsActive = (params?: {
  projectId?: string;
  resourceKind?: string;
  resourceId?: string;
  limit?: number;
}) => invoke<{ items: AgentOperation[]; count: number }>("agent_operations_active", params ?? {});

export const agentOperationsList = (params?: {
  agentId?: string;
  resourceKind?: string;
  status?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}) =>
  invoke<{
    items: AgentOperation[];
    page: { limit: number; offset: number; total: number; has_more?: boolean; hasMore?: boolean };
  }>("agent_operations_list", params ?? {});


export const scenarioList = () => invoke<ScenarioSummary[]>("scenario_list", {});
export const scenarioGet = (id: string) => invoke<ScenarioDetail>("scenario_get", { id });
export const scenarioSave = (input: ScenarioSaveInput) =>
  invoke<{ id: string }>("scenario_save", { input });
export const scenarioDelete = (id: string) => invoke<void>("scenario_delete", { id });
export const scenarioDuplicate = (id: string) =>
  invoke<{ id: string }>("scenario_duplicate", { id });
export const scenarioEnter = (id: string) => invoke<ScenarioEnterResult>("scenario_enter", { id });
/** 请求取消在途进入：幂等，未在途返回 false；取消只在项间生效。 */
export const scenarioEnterCancel = (id: string) =>
  invoke<boolean>("scenario_enter_cancel", { id });


export const SHELF_COLLECTED_EVENT = "taskdock://shelf-collected";


export const shelfList = (opts?: {
  search?: string;
  kind?: ShelfKind | "all";
  group_id?: string;
  favorite_only?: boolean;
  limit?: number;
  offset?: number;
  /** default = 置顶优先（完整暂存架）；recent = 纯创建时间倒序（胶囊最近暂存） */
  sort?: "default" | "recent";
}) =>
  invoke<ShelfPage>("shelf_list", {
    search: opts?.search ?? null,
    kind: opts?.kind ?? "all",
    groupId: opts?.group_id ?? "all",
    favoriteOnly: opts?.favorite_only ?? false,
    limit: opts?.limit ?? 100,
    offset: opts?.offset ?? 0,
    sort: opts?.sort ?? null,
  });

export const shelfStats = () => invoke<ShelfStats>("shelf_stats");

export const shelfGroups = () => invoke<ShelfGroup[]>("shelf_groups");

export const shelfGroupCreate = (name: string) =>
  invoke<ShelfGroup>("shelf_group_create", { name });

export const shelfGroupRename = (id: string, name: string) =>
  invoke<void>("shelf_group_rename", { id, name });

export const shelfGroupDelete = (id: string) => invoke<void>("shelf_group_delete", { id });

/**
 * 批量添加文件/文件夹（拖入与文件选择器共用）。
 * reference 不复制原文件；managed 复制到 Task Dock 托管目录（受配额约束）。
 * `traceId` 为可选诊断链路标识（16 位小写 hex）：只用于诊断事件关联，不参与鉴权；
 * 不传时后端行为与旧版完全一致。
 */
export const shelfAddPaths = (
  paths: string[],
  storageMode: ShelfStorageMode,
  sourceKind: "picker" | "drag" | "manual",
  groupId?: string | null,
  traceId?: string | null,
) =>
  invoke<ShelfAddReport>("shelf_add_paths", {
    paths,
    storageMode,
    sourceKind,
    groupId: groupId ?? null,
    traceId: traceId ?? null,
  });

export const shelfAddLink = (url: string, groupId?: string | null) =>
  invoke<ShelfItem>("shelf_add_link", { url, groupId: groupId ?? null });

export const shelfAddText = (text: string, groupId?: string | null) =>
  invoke<ShelfItem>("shelf_add_text", { text, groupId: groupId ?? null });

/** 从剪贴板条目添加：生成独立副本，与剪贴板历史生命周期解耦。 */
export const shelfAddFromClipboard = (
  itemIds: string[],
  storageMode: ShelfStorageMode,
  groupId?: string | null,
) =>
  invoke<ShelfAddReport>("shelf_add_from_clipboard", {
    itemIds,
    storageMode,
    groupId: groupId ?? null,
  });

/**
 * 主动粘贴当前系统剪贴板（不依赖剪贴板历史是否开启）。
 * 只读取、不写回系统剪贴板，不模拟按键、不抢其他应用焦点。
 */
export const shelfPasteCurrent = (
  storageMode: ShelfStorageMode,
  groupId?: string | null,
) =>
  invoke<ShelfPasteReport>("shelf_paste_current", {
    storageMode,
    groupId: groupId ?? null,
  });


export const shelfSendToStatus = () =>
  invoke<ShelfSendToStatus>("shelf_sendto_status");

export const shelfSendToEnable = () =>
  invoke<ShelfSendToStatus>("shelf_sendto_enable");

export const shelfSendToDisable = () =>
  invoke<void>("shelf_sendto_disable");

// ── 通用跨应用拖入（v49）────────────────────────────────────

/** 原生拖入桥状态：false 表示只能用 Tauri 内置的「本地路径」拖入。 */
export const dragBridgeStatus = () =>
  invoke<{
    active: boolean;
    /** 成功接管的窗口数：1 表示可能仍有 WebView 子窗口走 wry 的路径处理器。 */
    windows: number;
    /** 注册失败的窗口数：非 0 表示部分接管，这些窗口收不到富内容。 */
    failedWindows: number;
    maxItems: number;
    maxTextBytes: number;
    maxImageBytes: number;
  }>("drag_bridge_status");

/**
 * 提交一次拖入会话到最近暂存。
 *
 * **只传 `operationId`**：后端从暂存区取内容，前端无法借这条命令指定任意路径。
 * 文本/HTML/图片/虚拟文件都由后端自己落库，前端不参与搬运，避免截断与丢失。
 */
export const dragPayloadCommitShelf = (
  operationId: string,
  storageMode: ShelfStorageMode,
  groupId?: string | null,
) =>
  invoke<{
    operationId: string;
    kind: string;
    added: ShelfItem[];
    failed: { path: string; reason: string; code?: string; category?: string }[];
    failures: {
      code: string;
      scope: string;
      format?: string;
      reason: string;
    }[];
    skipped: number;
  }>("drag_payload_commit_shelf", {
    operationId,
    storageMode,
    groupId: groupId ?? null,
  });

/** 提交一次拖入会话到目录目标卡片（仅本地文件/虚拟文件/图片可投递）。 */
export const dragPayloadCommitDirectory = (
  operationId: string,
  targetId: string,
  batchId?: string | null,
) =>
  invoke<ShelfDropReport>("drag_payload_commit_directory", {
    operationId,
    targetId,
    batchId: batchId ?? null,
  });

/** 放弃一次拖入会话：释放暂存副本（未命中落点/用户取消/消费者已卸载）。 */
export const dragPayloadDiscard = (operationId: string) =>
  invoke<boolean>("drag_payload_discard", { operationId });

/** 前端补记一条拖入异常（只接受枚举化的码与短标签）。 */
export const dragReportClientIssue = (code: string, stage: string) =>
  invoke<void>("drag_report_client_issue", { code, stage });

/** 单条全量读取（含 content）：列表载荷不带大文本。 */
export const shelfGetItem = (id: string) => invoke<ShelfItem>("shelf_get_item", { id });

export const shelfUpdate = (id: string, patch: ShelfUpdatePatch) =>
  invoke<ShelfItem>("shelf_update", { id, patch });

/** 删除条目：托管副本一并删除；引用模式绝不触碰原文件。收藏/置顶/场景引用需显式确认。 */
export const shelfDelete = (ids: string[], includeProtected: boolean) =>
  invoke<ShelfDeleteReport>("shelf_delete", { ids, includeProtected });

/** 软删除到回收站：可撤销；托管副本在保留期内不删除。 */
export const shelfTrashDelete = (ids: string[], includeProtected: boolean) =>
  invoke<ShelfTrashDeleteReport>("shelf_trash_delete", { ids, includeProtected });

export const shelfTrashRestore = (batchId: string) =>
  invoke<ShelfTrashRestoreReport>("shelf_trash_restore", { batchId });

/** 清理回收站：不传 batchId 时只清理已过期批次。 */
export const shelfTrashPurge = (batchId?: string) =>
  invoke<ShelfTrashPurgeReport>("shelf_trash_purge", { batchId: batchId ?? null });

export const shelfTrashCount = () => invoke<number>("shelf_trash_count");

/** 外部文件→回收站：预览只读，不删除任何文件。 */
export const shelfRecyclePreview = (paths: string[]) =>
  invoke<ShelfRecyclePreview>("shelf_recycle_preview", { paths });

/** 外部文件→回收站：逐项复核指纹后调用 Windows 回收站，绝不永久删除。 */
export const shelfRecycleExecute = (
  paths: string[],
  expected: ShelfRecycleExpectation[],
) => invoke<ShelfRecycleReport>("shelf_recycle_execute", { paths, expected });

export const shelfClear = (includeProtected: boolean) =>
  invoke<ShelfDeleteReport>("shelf_clear", { includeProtected });

/** 过期清理：dryRun=true 只返回预览（候选数/释放字节/受保护跳过）。 */
export const shelfCleanup = (dryRun: boolean, includeProtected: boolean) =>
  invoke<ShelfCleanupReport>("shelf_cleanup", { dryRun, includeProtected });

export const shelfCheckExists = (ids: string[]) =>
  invoke<{ id: string; exists_state: string }[]>("shelf_check_exists", { ids });

export const shelfOpenItem = (id: string) => invoke<void>("shelf_open_item", { id });

export const shelfRevealItem = (id: string) => invoke<void>("shelf_reveal_item", { id });

export const shelfReadText = (id: string) =>
  invoke<{ content: string; truncated: boolean }>("shelf_read_text", { id });

/** full=false 读缩略图；full=true 读原图（≤40MB）。引用失效返回 null。 */
export const shelfReadImage = (id: string, full: boolean) =>
  invoke<string | null>("shelf_read_image", { id, full });

/** 复制路径（文本）/ 复制文件（CF_HDROP，资源管理器可直接粘贴）——拖出的键盘/回退通道。 */
export const shelfCopyPaths = (ids: string[]) => invoke<number>("shelf_copy_paths", { ids });
export const shelfCopyFiles = (ids: string[]) => invoke<number>("shelf_copy_files", { ids });


/**
 * 从暂存架卡片发起 Windows 原生拖出（OLE DoDragDrop）。
 * 必须在 pointerdown 后、左键仍按下时调用；路径由后端按 id 解析，前端不传路径。
 */
export const shelfDragOut = (ids: string[]) =>
  invoke<ShelfDragOutResult>("shelf_drag_out", { ids });

export const shelfTaskLinks = (itemId: string) =>
  invoke<ShelfTaskLink[]>("shelf_task_links", { itemId });

export const shelfLinkTask = (itemId: string, taskId: string) =>
  invoke<void>("shelf_link_task", { itemId, taskId });


export const shelfProjectLinks = (itemId: string) =>
  invoke<ShelfProjectLink[]>("shelf_project_links", { itemId });

export const shelfLinkProject = (itemId: string, projectId: string) =>
  invoke<void>("shelf_link_project", { itemId, projectId });

export const shelfUnlinkProject = (itemId: string, projectId: string) =>
  invoke<void>("shelf_unlink_project", { itemId, projectId });


export const shelfBatchLink = (
  ids: string[],
  target: "project" | "task",
  targetId: string,
) => invoke<ShelfBatchLinkReport>("shelf_batch_link", { ids, target, targetId });


export const shelfItemTags = (itemId: string) =>
  invoke<string[]>("shelf_item_tags", { itemId });

export const shelfTagItems = (
  ids: string[],
  tags: string[],
  mode: "add" | "remove",
) => invoke<ShelfTagChangeReport>("shelf_tag_items", { ids, tags, mode });

export const shelfRecentTags = (limit?: number) =>
  invoke<ShelfRecentTag[]>("shelf_recent_tags", { limit: limit ?? null });


export const shelfDuplicateScan = (ids?: string[]) =>
  invoke<ShelfDedupReport>("shelf_duplicate_scan", { ids: ids && ids.length > 0 ? ids : null });


/** 预览草稿规则（不落库）；rules 省略时读已保存设置。 */
export const shelfRulesPreview = (rules?: ShelfRuleSet | null) =>
  invoke<ShelfRulePreview>("shelf_rules_preview", { rules: rules ?? null });

/** 应用已保存且启用的规则；只做加标签/归组。 */
export const shelfRulesApply = (ids?: string[]) =>
  invoke<ShelfRuleApplyReport>("shelf_rules_apply", {
    ids: ids && ids.length > 0 ? ids : null,
  });

export const shelfPasteScreenshot = (groupId?: string | null) =>
  invoke<ShelfPasteReport>("shelf_paste_screenshot", { groupId: groupId ?? null });

/** 暂存架图片 OCR：复用剪贴板本地 OCR 引擎，不自动上传、不改动原图。 */
export const shelfOcrItem = (id: string, requestId: string) =>
  invoke<ClipboardOcrReport>("shelf_ocr_item", { id, requestId });

export const shelfOcrCancel = (requestId: string) =>
  invoke<boolean>("shelf_ocr_cancel", { requestId });


/**
 * 移动原文件/文件夹到目标目录。
 * - 默认不覆盖同名：skip=跳过，rename=`名称 (1).ext`；
 * - managed / link / text 由后端明确拒绝；
 * - removeAfter=true 只移除成功处理的暂存记录，不删除已移动的目标文件。
 * - `traceId` 可选诊断链路标识，只用于诊断关联，不参与鉴权；不传行为不变。
 */
export const shelfMoveItems = (
  ids: string[],
  targetDir: string,
  conflictStrategy: ShelfConflictStrategy = "skip",
  removeAfter = false,
  traceId?: string | null,
) =>
  invoke<ShelfOpReport>("shelf_move_items", {
    ids,
    targetDir,
    conflictStrategy,
    removeAfter,
    traceId: traceId ?? null,
  });

/** 复制到目录（托管条目为导出副本），源文件始终保留。`traceId` 语义同 `shelfMoveItems`。 */
export const shelfCopyTo = (
  ids: string[],
  targetDir: string,
  conflictStrategy: ShelfConflictStrategy = "skip",
  removeAfter = false,
  traceId?: string | null,
) =>
  invoke<ShelfOpReport>("shelf_copy_to", {
    ids,
    targetDir,
    conflictStrategy,
    removeAfter,
    traceId: traceId ?? null,
  });

/** 失效引用条目重新指向外部文件/文件夹；托管条目拒绝。 */
export const shelfRelocateItem = (id: string, path: string) =>
  invoke<ShelfItem>("shelf_relocate_item", { id, path });

/** 最近目标目录（最多 8 个，按固定 + 最近成功使用排序）。 */
export const shelfRecentDirs = () => invoke<ShelfRecentDir[]>("shelf_recent_dirs");

export const shelfRecentDirPin = (path: string, pinned: boolean) =>
  invoke<void>("shelf_recent_dir_pin", { path, pinned });

export const shelfRecentDirRemove = (path: string) =>
  invoke<void>("shelf_recent_dir_remove", { path });


/** 投递目标列表（每次读取都会探测目录可用性，不做后台轮询）。 */
export const shelfDropTargets = () => invoke<ShelfDropTarget[]>("shelf_drop_targets_list");

export const shelfDropTargetCreate = (input: {
  name?: string;
  path: string;
  showInCapsule?: boolean;
  opMode?: DropTargetOpMode;
  conflict?: ShelfConflictStrategy;
}) =>
  invoke<ShelfDropTarget>("shelf_drop_target_create", {
    name: input.name ?? null,
    path: input.path,
    showInCapsule: input.showInCapsule ?? null,
    opMode: input.opMode ?? null,
    conflict: input.conflict ?? null,
  });

export const shelfDropTargetUpdate = (id: string, patch: ShelfDropTargetPatch) =>
  invoke<ShelfDropTarget>("shelf_drop_target_update", { id, patch });

/** 只删除配置行；真实目录与其内容不受影响。 */
export const shelfDropTargetDelete = (id: string) =>
  invoke<void>("shelf_drop_target_delete", { id });

export const shelfDropTargetMove = (id: string, direction: "up" | "down") =>
  invoke<ShelfDropTarget[]>("shelf_drop_target_move", { id, direction });

export const shelfDropTargetOpen = (id: string) =>
  invoke<void>("shelf_drop_target_open", { id });

/**
 * 把拖入的路径直接投递到目标目录。
 * - 目标按 id 由后端解析，前端不传目录字符串；
 * - 单条失败不影响其他条目，结果逐条返回；
 * - `batchId` 只用于操作日志归属（崩溃恢复区分批次）。
 */
export const shelfDropToDirectory = (
  targetId: string,
  paths: string[],
  batchId: string,
) =>
  invoke<ShelfDropReport>("shelf_drop_to_directory", {
    targetId,
    paths,
    batchId,
  });


export const shelfRecentDirsClear = () => invoke<void>("shelf_recent_dirs_clear");


export const workflowList = () => invoke<Workflow[]>("workflow_list");
export const workflowGet = (id: string) => invoke<WorkflowDetail>("workflow_get", { id });
export const workflowCreate = (input: WorkflowInput) =>
  invoke<WorkflowDetail>("workflow_create", { input });
export const workflowUpdate = (id: string, patch: WorkflowPatch) =>
  invoke<WorkflowDetail>("workflow_update", { id, patch });
export const workflowDelete = (id: string) => invoke<void>("workflow_delete", { id });
export const workflowDuplicate = (id: string) =>
  invoke<WorkflowDetail>("workflow_duplicate", { id });
export const workflowReorder = (orderedIds: string[]) =>
  invoke<void>("workflow_reorder", { orderedIds });
/** 整表替换步骤编排（原子事务；增删改排序共用）。 */
export const workflowReplaceSteps = (id: string, steps: WorkflowStepInput[]) =>
  invoke<WorkflowDetail>("workflow_replace_steps", { id, steps });
/** 编辑保存：名称 / 描述 / 步骤在单事务内写入，避免半保存。 */
export const workflowSave = (
  id: string,
  name: string,
  description: string,
  steps: WorkflowStepInput[],
) => invoke<WorkflowDetail>("workflow_save", { id, name, description, steps });

export const workflowRun = (id: string) => invoke<WorkflowRunDetail>("workflow_run", { id });
export const workflowPause = (id: string) => invoke<WorkflowRunDetail>("workflow_pause", { id });
export const workflowResume = (id: string) => invoke<WorkflowRunDetail>("workflow_resume", { id });
export const workflowCancel = (id: string) => invoke<WorkflowRunDetail>("workflow_cancel", { id });
export const workflowActive = () => invoke<WorkflowActiveRun | null>("workflow_active");

export const workflowRunDetail = (runId: string) =>
  invoke<WorkflowRunDetail>("workflow_run_detail", { runId });
export const workflowLastRun = (id: string) =>
  invoke<WorkflowRunDetail | null>("workflow_last_run", { id });
export const workflowLastRunSummary = (id: string) =>
  invoke<WorkflowLastRunSummary | null>("workflow_last_run_summary", { id });
export const workflowListRuns = (id: string, limit?: number, offset?: number) =>
  invoke<WorkflowRunPage>("workflow_list_runs", { id, limit: limit ?? 20, offset: offset ?? 0 });

/** 运行进度推送：payload 为完整运行详情（运行头 + 全部步骤回执）。 */
export const onWorkflowRunProgress = (cb: (payload: WorkflowRunDetail) => void): Promise<UnlistenFn> =>
  listen<WorkflowRunDetail>("workflow-run-progress", (e) => cb(e.payload));

/** 步骤类型的中文标签（与后端 StepType::label 对齐）。 */
export const WORKFLOW_STEP_TYPE_LABELS: Record<WorkflowStepType, string> = {
  open_app: "打开应用 / 激活窗口",
  open_url: "打开网页",
  open_path: "打开文件或目录",
  create_task: "创建任务",
  enter_scene: "进入场景",
  restore_workspace: "恢复工作现场",
};

/** 运行状态的中文标签。 */
export const WORKFLOW_RUN_STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  running: "执行中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

/** 步骤回执状态的中文标签。 */
export const WORKFLOW_STEP_STATUS_LABELS: Record<WorkflowRunStepStatus, string> = {
  pending: "待执行",
  running: "执行中",
  succeeded: "成功",
  skipped: "已跳过",
  failed: "失败",
  cancelled: "已取消",
};

export const shelfUnlinkTask = (itemId: string, taskId: string) =>
  invoke<void>("shelf_unlink_task", { itemId, taskId });

/** 暂存架条目类型 → 中文名。 */
export const SHELF_KIND_LABELS: Record<ShelfKind, string> = {
  file: "文件",
  folder: "文件夹",
  image: "图片",
  link: "链接",
  text: "文本",
};


export const diagnosticsStatus = () => invoke<DiagnosticsStatus>("diagnostics_status");

export const diagnosticsSetMode = (mode: "normal" | "verbose", minutes?: number) =>
  invoke<DiagnosticsStatus>("diagnostics_set_mode", { mode, minutes });

export const diagnosticsQuery = (filter: DiagnosticQuery = {}) =>
  invoke<DiagnosticPage>("diagnostics_query", { filter });

export const diagnosticsSummary = (filter: DiagnosticQuery = {}) =>
  invoke<DiagnosticSummary>("diagnostics_summary", { filter });

/**
 * 导出脱敏诊断报告（本机文件，不上传、不发送）。
 * `includeSecurityAudit` 默认 false：安全审计事件必须由用户显式授权后才并入导出。
 */
export const diagnosticsExport = (
  filter: DiagnosticQuery = {},
  includeSecurityAudit = false,
) =>
  invoke<DiagnosticExportResult>("diagnostics_export", { filter, includeSecurityAudit });

/** 导出前预览：只读统计，不生成文件、不落盘。 */
export const diagnosticsExportPreview = (
  filter: DiagnosticQuery = {},
  includeSecurityAudit = false,
) =>
  invoke<DiagnosticsExportPreview>("diagnostics_export_preview", {
    filter,
    includeSecurityAudit,
  });

/** 性能指标快照（进程累计窗口；有界聚合，不读历史日志）。 */
export const diagnosticsMetricsSummary = () =>
  invoke<DiagnosticsMetricsSummary>("diagnostics_metrics_summary");

// ── 安全审计（多源统一查询 + 用户显式清理）──────────────────
/** 分页查询安全审计事件（新 → 旧）。未接入的来源通过 `sources` 覆盖状态显式返回。 */
export const securityAuditQuery = (filter: SecurityAuditFilter = {}) =>
  invoke<SecurityAuditPage>("security_audit_query", { filter });

/**
 * 用户显式触发两段式保留清理。**启动路径不得调用**；
 * 未传参数时后端使用默认（元数据 90 天 / 明细 30 天）。
 */
export const securityAuditPrune = (options: SecurityAuditPruneOptions = {}) =>
  invoke<SecurityAuditPruneReport>("security_audit_prune", {
    metadataDays: options.metadataDays,
    detailDays: options.detailDays,
  });


export const diagnosticsClear = () =>
  invoke<DiagnosticClearResult>("diagnostics_clear");

export const diagnosticsOpenDir = () => invoke<void>("diagnostics_open_dir");


export const lifecycleStatus = () =>
  invoke<ModuleRuntimeStatus[]>("lifecycle_status");


export const mobileSyncStatus = () =>
  invoke<MobileSyncStatus>("mobile_sync_status");

export const mobileSyncStartPairing = () =>
  invoke<MobileSyncPairingOffer>("mobile_sync_start_pairing");

export const mobileSyncCancelPairing = () =>
  invoke<void>("mobile_sync_cancel_pairing");

export const mobileSyncListDevices = () =>
  invoke<MobileDevice[]>("mobile_sync_list_devices");

export const mobileSyncRevokeDevice = (deviceId: string) =>
  invoke<boolean>("mobile_sync_revoke_device", { deviceId });


export const mobileFileList = () => invoke<MobileFile[]>("mobile_file_list");

export const mobileFileOffer = (paths: string[]) =>
  invoke<MobileFile[]>("mobile_file_offer", { paths });

export const mobileFileDelete = (id: string) =>
  invoke<boolean>("mobile_file_delete", { id });

export const mobileFileReveal = (id: string) =>
  invoke<void>("mobile_file_reveal", { id });

export const mobileFileOpenInbox = () => invoke<void>("mobile_file_open_inbox");

/** 把已接收的手机文件以托管副本加入暂存架（幂等；groupId 缺省=默认分组）。 */
export const mobileFileImportShelf = (id: string, groupId?: string | null) =>
  invoke<MobileFile>("mobile_file_import_shelf", { id, groupId: groupId ?? null });

/** 图片缩略图 PNG data URL；非图片/不可用返回 null（UI 回落类型图标）。路径只由后端解析，前端不传路径。 */
export const mobileFileThumbnail = (id: string, maxPx = 128) =>
  invoke<string | null>("mobile_file_thumbnail", { id, maxPx });


export const devProjectList = () => invoke<{ projects: DevProject[] }>("dev_project_list");

export const devProjectSave = (input: {
  id: string | null;
  name: string;
  rootPath: string;
  note?: string;
}) => invoke<{ project: DevProject }>("dev_project_save", { id: input.id, name: input.name, rootPath: input.rootPath, note: input.note ?? "" });

export const devProjectDelete = (id: string) => invoke<{ ok: true }>("dev_project_delete", { id });

export const devProjectProbe = (rootPath: string) =>
  invoke<DevGitInfo>("dev_project_probe", { rootPath });

export const devHandoffSave = (input: {
  taskId: string | null;
  title: string;
  contentMd: string;
  sourceSummary?: string;
  /** 可选：把该版本绑定到一个真实存在的 Agent 会话（v50）。 */
  agentSourceId?: string | null;
  agentSessionExternalId?: string | null;
}) =>
  invoke<{ pack: DevHandoffPack }>("dev_handoff_save", {
    taskId: input.taskId,
    title: input.title,
    contentMd: input.contentMd,
    sourceSummary: input.sourceSummary ?? "",
    agentSourceId: input.agentSourceId ?? null,
    agentSessionExternalId: input.agentSessionExternalId ?? null,
  });

export const devHandoffList = (opts?: { taskId?: string | null; limit?: number }) =>
  invoke<{ packs: DevHandoffPack[] }>("dev_handoff_list", {
    taskId: opts?.taskId ?? null,
    limit: opts?.limit ?? null,
  });

export const devHandoffGet = (id: string) => invoke<{ pack: DevHandoffPack }>("dev_handoff_get", { id });

export const devHandoffDelete = (id: string) => invoke<{ ok: true }>("dev_handoff_delete", { id });

export const devHandoffSecretScan = (texts: string[]) =>
  invoke<{ findings: SecretFinding[]; truncated: boolean }>("dev_handoff_secret_scan", { texts });

export const devAcceptanceRecordCreate = (input: {
  subjectKind: "task" | "planning_feature";
  subjectId: string;
  verdict: "pass" | "fail" | "blocked" | "not_verified";
  summary: string;
  evidence?: string[];
  /** 可选：标注本结论针对哪个 Agent 轮次（三者必须同时给出且真实存在）。 */
  agentSourceId?: string | null;
  agentSessionExternalId?: string | null;
  agentRunExternalId?: string | null;
}) =>
  invoke<{ record: DevAcceptanceRecord }>("dev_acceptance_record_create", {
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    verdict: input.verdict,
    summary: input.summary,
    evidence: input.evidence ?? [],
    agentSourceId: input.agentSourceId ?? null,
    agentSessionExternalId: input.agentSessionExternalId ?? null,
    agentRunExternalId: input.agentRunExternalId ?? null,
  });

/**
 * 当前任务关联会话里「已完成」的 Agent 轮次（只读派生）。
 * 不自动生成验收记录；已登记的轮次带 accepted*，供前端标注「已验收」。
 */
export const devAcceptanceAgentRuns = (taskId: string, limit = 10) =>
  invoke<{ runs: DevAgentRunCandidate[]; truncated: boolean }>("dev_acceptance_agent_runs", {
    taskId,
    limit,
  });

export const devAcceptanceRecordList = (opts?: {
  subjectKind?: "task" | "planning_feature" | null;
  subjectId?: string | null;
  limit?: number;
}) =>
  invoke<{ records: DevAcceptanceRecord[] }>("dev_acceptance_record_list", {
    subjectKind: opts?.subjectKind ?? null,
    subjectId: opts?.subjectId ?? null,
    limit: opts?.limit ?? null,
  });


export const notesList = (opts?: {
  query?: string | null;
  pinnedOnly?: boolean;
  favoriteOnly?: boolean;
  taskId?: string | null;
  workspaceId?: string | null;
  limit?: number;
  offset?: number;
}) =>
  invoke<NoteSummary[]>("notes_list", {
    query: opts?.query ?? null,
    pinnedOnly: opts?.pinnedOnly ?? false,
    favoriteOnly: opts?.favoriteOnly ?? false,
    taskId: opts?.taskId ?? null,
    workspaceId: opts?.workspaceId ?? null,
    limit: opts?.limit ?? null,
    offset: opts?.offset ?? null,
  });


export const workspaceProjectList = (status?: WorkspaceProjectStatus | null) =>
  invoke<{ projects: WorkspaceProject[] }>("workspace_project_list", { status: status ?? null });

export const workspaceProjectGet = (id: string) =>
  invoke<{ project: WorkspaceProject }>("workspace_project_get", { id });


export const workspaceProjectProgress = (projectId: string) =>
  invoke<WorkspaceProjectProgress>("workspace_project_progress", { projectId });

export const workspaceResourceSave = (input: {
  projectId: string; kind: WorkspaceResourceKind; target: string; label: string; note: string;
}) => invoke<WorkspaceResourceLink>("workspace_resource_save", input);
export const workspaceResourceList = (projectId: string, kind: WorkspaceResourceKind | null = null, offset = 0, limit = 50) =>
  invoke<WorkspaceResourcePage>("workspace_resource_list", { projectId, kind, offset, limit });
export const workspaceResourceRemove = (projectId: string, id: string) =>
  invoke<{ ok: boolean }>("workspace_resource_remove", { projectId, id });

export const workspaceProjectSave = (input: {
  id?: string | null;
  name: string;
  kind: WorkspaceKind;
  rootPath?: string | null;
  devProjectId?: string | null;
  note?: string | null;
}) =>
  invoke<{ project: WorkspaceProject }>("workspace_project_save", {
    id: input.id ?? null,
    name: input.name,
    kind: input.kind,
    rootPath: input.rootPath ?? null,
    devProjectId: input.devProjectId ?? null,
    note: input.note ?? null,
  });

/**
 * 统一项目创建（Workbench 快速创建）。
 *
 * 与项目中枢/CLI/MCP/REST 共用后端 Project Creation Service：同一校验、同一事务、
 * 同一幂等摘要。目录模式必须显式传递，不能靠「路径不存在」推断。
 */
export const projectCreate = (input: ProjectCreateInput) =>
  invoke<ProjectCreateResult>("project_create", { input });

export const workspaceProjectSetStatus = (id: string, status: WorkspaceProjectStatus) =>
  invoke<{ project: WorkspaceProject }>("workspace_project_set_status", { id, status });

export const workspaceProjectDelete = (id: string) =>
  invoke<{ ok: true }>("workspace_project_delete", { id });

export const workspaceSetActiveProject = (projectId: string | null) =>
  invoke<{ projectId: string }>("workspace_set_active_project", { projectId: projectId ?? null });

export const workspaceInstanceGet = (projectId: string) =>
  invoke<{ instance: WorkspaceInstance }>("workspace_instance_get", { projectId });

export const workspaceInstanceSave = (input: {
  projectId: string;
  activeModule: string;
  layoutJson?: string | null;
}) =>
  invoke<{ instance: WorkspaceInstance }>("workspace_instance_save", {
    projectId: input.projectId,
    activeModule: input.activeModule,
    layoutJson: input.layoutJson ?? null,
  });

export const workspaceItemList = (projectId: string) =>
  invoke<{ items: WorkspaceItem[] }>("workspace_item_list", { projectId });

export const workspaceItemSave = (input: {
  id?: string | null;
  projectId: string;
  parentId?: string | null;
  title: string;
  stage?: string | null;
  status?: WorkspaceItemStatus | null;
  sortOrder?: number | null;
  metadataJson?: string | null;
}) =>
  invoke<{ item: WorkspaceItem }>("workspace_item_save", {
    id: input.id ?? null,
    projectId: input.projectId,
    parentId: input.parentId ?? null,
    title: input.title,
    stage: input.stage ?? null,
    status: input.status ?? null,
    sortOrder: input.sortOrder ?? null,
    metadataJson: input.metadataJson ?? null,
  });

export const workspaceItemDelete = (id: string) =>
  invoke<{ ok: true }>("workspace_item_delete", { id });

export const workspaceTaskLinkList = (projectId: string) =>
  invoke<{ links: WorkspaceTaskLink[] }>("workspace_task_link_list", { projectId });

export const workspaceTaskLinkAdd = (projectId: string, taskId: string) =>
  invoke<{ ok: true }>("workspace_task_link_add", { projectId, taskId });

export const workspaceTaskUnlink = (projectId: string, taskId: string) =>
  invoke<{ ok: true }>("workspace_task_unlink", { projectId, taskId });


export const novelVolumeList = (projectId: string) =>
  invoke<{ volumes: NovelVolume[] }>("novel_volume_list", { projectId });

export const novelVolumeSave = (input: {
  id?: string | null;
  projectId: string;
  title: string;
  sortOrder?: number | null;
}) =>
  invoke<{ volume: NovelVolume }>("novel_volume_save", {
    id: input.id ?? null,
    projectId: input.projectId,
    title: input.title,
    sortOrder: input.sortOrder ?? null,
  });

export const novelVolumeDelete = (id: string) =>
  invoke<{ ok: true }>("novel_volume_delete", { id });

export const novelChapterList = (projectId: string) =>
  invoke<{ chapters: NovelChapterSummary[] }>("novel_chapter_list", { projectId });

export const novelChapterGet = (id: string) =>
  invoke<{ chapter: NovelChapter }>("novel_chapter_get", { id });

export const novelChapterSave = (input: {
  id?: string | null;
  projectId: string;
  volumeId?: string | null;
  title: string;
  sortOrder?: number | null;
}) =>
  invoke<{ chapter: NovelChapterSummary }>("novel_chapter_save", {
    id: input.id ?? null,
    projectId: input.projectId,
    volumeId: input.volumeId ?? null,
    title: input.title,
    sortOrder: input.sortOrder ?? null,
  });

export const novelChapterSaveContent = (id: string, content: string) =>
  invoke<{ chapter: NovelChapterSummary }>("novel_chapter_save_content", { id, content });

export const novelChapterDelete = (id: string) =>
  invoke<{ ok: true }>("novel_chapter_delete", { id });

/**
 * 旧 IPC 兼容入口：只把请求适配为统一工作台导航并返回 requestId。
 * `opened=true` 不代表导航已生效；需要最终结果时用返回的 requestId 等待
 * `workbench-nav-ack`（或优先使用 `workbenchNav.openWorkbench`）。
 */
export const openProjectWorkspaceWindow = (input?: {
  projectId?: string | null;
  requestId?: number;
}) =>
  invoke<{ opened: boolean; projectId: string | null; requestId: number | null }>(
    "open_project_workspace_window",
    {
      projectId: input?.projectId ?? null,
      requestId: input?.requestId ?? null,
    },
  );


/** 打开/聚焦工作台并请求导航；返回 requestId，调用方必须等待回执。 */
export const workbenchOpenWindow = (input: {
  target: WorkbenchNavTarget;
  projectId?: string | null;
  /** 调用方在发命令之前生成的请求编号（回执可能先于命令响应到达）。 */
  requestId: number;
}) =>
  invoke<{ requestId: number; created: boolean }>("workbench_open_window", {
    target: input.target,
    projectId: input.projectId ?? null,
    requestId: input.requestId,
  });

/** 工作台拉取下一条待处理导航（挂载/收到事件/重新聚焦时调用；空队列返回 null）。 */
export const workbenchTakeNav = () =>
  invoke<WorkbenchNavRequest | null>("workbench_take_nav");

/** 工作台回传本次导航的真实结果（pending 之后还要回最终结果）。 */
export const workbenchNavAck = (input: {
  requestId: number;
  status: WorkbenchNavStatus;
  error?: string | null;
}) =>
  invoke<void>("workbench_nav_ack", {
    requestId: input.requestId,
    status: input.status,
    error: input.error ?? null,
  });

export const onWorkbenchNavigate = (cb: (request: WorkbenchNavRequest) => void) =>
  listen<WorkbenchNavRequest>("workbench-navigate", (e) => cb(e.payload));

/**
 * 工作台首帧就绪：启动路径的窗口是**隐藏创建**的，收到这个确认后才显示，
 * 避免用户先看到一个空白窗口。手动打开时后端是 no-op，可安全重复调用。
 */
export const workbenchUiReady = () => invoke<void>("workbench_ui_ready");

/**
 * 启动/重复启动路径打开大型工作台失败：主窗口据此展示可恢复的错误提示
 * （托盘 / 快捷入口「打开完整工作台」会重新尝试创建）。
 */
export const onWorkbenchStartupFailed = (cb: (failure: { message: string }) => void) =>
  listen<{ message: string }>("workbench-startup-failed", (e) => cb(e.payload));

export const onWorkbenchNavAck = (cb: (ack: WorkbenchNavAck) => void) =>
  listen<WorkbenchNavAck>("workbench-nav-ack", (e) => cb(e.payload));

/**
 * 「在开发工作台打开」：返回 `requestId`，**事件送达 ≠ 成功**。
 * 主窗口在解除胶囊停靠、切到开发工作台页后必须回执（见 ack），
 * 工作空间窗口据回执展示真实结果。
 *
 * `requestId` 由调用方**在发命令之前**生成并登记：主窗口的回执可能先到，
 * 若等命令返回才知道编号，早到的回执只能被丢弃。
 */
export const projectWorkspaceOpenDevWorkbench = (projectId: string, requestId: number) =>
  invoke<{ requestId: number; devProjectId: string }>(
    "project_workspace_open_dev_workbench",
    { projectId, requestId },
  );

/** 主窗口回执本次跨窗口导航事务的真实结果。 */
export const projectWorkspaceOpenDevWorkbenchAck = (input: {
  requestId: number;
  ok: boolean;
  pending: boolean;
  status?: OpenDevWorkbenchStatus;
  error?: string | null;
}) =>
  invoke<void>("project_workspace_open_dev_workbench_ack", {
    requestId: input.requestId,
    ok: input.ok,
    pending: input.pending,
    status: input.status ?? null,
    error: input.error ?? null,
  });

export const onProjectWorkspaceWindowClosed = (cb: (payload: unknown) => void) =>
  listen<unknown>("project-workspace-window-closed", (e) => cb(e.payload));

export const onProjectWorkspaceOpenDevWorkbench = (
  cb: (payload: { requestId: number; devProjectId: string }) => void,
) =>
  listen<{ requestId: number; devProjectId: string }>(
    "project-workspace-open-dev-workbench",
    (e) => cb(e.payload),
  );


/** 工作空间窗口侧：接收主窗口回执（迟到/重复按 requestId 去重由调用方处理）。 */
export const onProjectWorkspaceOpenDevWorkbenchResult = (
  cb: (payload: OpenDevWorkbenchAck) => void,
) =>
  listen<OpenDevWorkbenchAck>("project-workspace-open-dev-workbench-result", (e) =>
    cb(e.payload),
  );


/** 工具链、参数支持与设备一次性探测（页面打开/手动刷新时调用）。 */
export const vdProbe = () => invoke<VdProbe>("vd_probe");

/** 轻量轮询：只读 ADB 设备状态（已按物理设备合并 transport）。 */
export const vdDevices = () => invoke<VdDeviceList>("vd_devices");

/** 设备上具备启动入口的应用；`includeAll` 时附带无入口应用及原因。 */
export const vdListApps = (serial: string, includeAll = false) =>
  invoke<VdAppList>("vd_list_apps", { serial, includeAll });

/** 创建投屏会话；返回后由前端轮询直到 running/error。 */
export const vdStart = (opts: VdStartOptions) =>
  invoke<VdSession>("vd_start", {
    serial: opts.serial,
    mode: opts.mode,
    package: opts.packageName ?? null,
    size: opts.size ?? null,
    clipboardSync: opts.clipboardSync ?? false,
    allowMulti: opts.allowMulti ?? false,
  });

/** 关闭会话；stopping 后由后端后台收尾，不阻塞状态查询。 */
export const vdStop = (sessionId: string) =>
  invoke<boolean>("vd_stop", { sessionId });

/** 向会话绑定的 Display ID 发送返回/Home/最近任务，不允许默认显示回退。 */
export const vdNav = (sessionId: string, action: "back" | "home" | "recents") =>
  invoke<{ action: string; display_id: number }>("vd_nav", { sessionId, action });

/** 会话列表（含刚结束的保留窗口，便于展示失败原因）。 */
export const vdSessions = () => invoke<VdSession[]>("vd_sessions");

/** 恢复并前置 scrcpy 窗口；只按后端记录的 PID 查找。 */
export const vdFocus = (sessionId: string) =>
  invoke<VdFocus>("vd_focus", { sessionId });

/** 截取当前会话窗口（仅用户主动触发）。 */
export const vdScreenshot = (sessionId: string) =>
  invoke<VdScreenshot>("vd_screenshot", { sessionId });

/** 把最近一次截图另存到用户选择的绝对路径。 */
export const vdScreenshotExport = (sessionId: string, targetPath: string) =>
  invoke<boolean>("vd_screenshot_export", { sessionId, targetPath });

/** 诊断设备侧 scrcpy 虚拟显示残留。 */
export const vdDiagnostics = (serial: string) =>
  invoke<VdDiagnostics>("vd_diagnostics", { serial });

/** 重连指定设备的 ADB（仅无本模块会话时允许）。 */
export const vdReconnect = (serial: string) =>
  invoke<boolean>("vd_reconnect", { serial });


/** 按会话 ID 读取不可变快照（控制栏窗口只绑定自己的 Session）。 */
export const vdSession = (sessionId: string) =>
  invoke<VdSession>("vd_session", { sessionId });

/** 幂等创建/恢复该会话的控制栏与窗口 watcher。返回 pending | ready。 */
export const vdToolbarAttach = (sessionId: string) =>
  invoke<string>("vd_toolbar_attach", { sessionId });

/** 停止 watcher 并隐藏控制栏（不关闭 scrcpy）。 */
export const vdToolbarDetach = (sessionId: string) =>
  invoke<boolean>("vd_toolbar_detach", { sessionId });

/** 立即重读窗口矩形/显示器/DPI 并重算控制栏位置。 */
export const vdToolbarUpdate = (sessionId: string) =>
  invoke<boolean>("vd_toolbar_update", { sessionId });

/** 彻底销毁控制栏与绑定（幂等，Session 关闭时调用）。 */
export const vdToolbarDestroy = (sessionId: string) =>
  invoke<boolean>("vd_toolbar_destroy", { sessionId });

export const vdToolbarSetLocked = (sessionId: string, locked: boolean) =>
  invoke<boolean>("vd_toolbar_set_locked", { sessionId, locked });

export const vdToolbarSetExpanded = (sessionId: string, expanded: boolean) =>
  invoke<boolean>("vd_toolbar_set_expanded", { sessionId, expanded });

/** 复用 vd_screenshot 的 Android 投屏截图链路，并广播给主窗口预览。 */
export const vdToolbarScreenshot = (sessionId: string) =>
  invoke<VdScreenshot>("vd_toolbar_screenshot", { sessionId });

/**
 * 导航动作统一派发（一体化架构入口）：后端先做 Session 归属与有效性校验
 * （会话运行中 + 控制栏已挂载），再复用 vd_nav 发送 Android 导航键。
 * 比直连 vd_nav 多一层多会话隔离与挂载状态防线。
 */
export const vdProjectionDispatch = (sessionId: string, action: ProjectionNavigationAction) =>
  invoke<{ action: string; display_id: number }>("vd_projection_dispatch", {
    sessionId,
    action,
  });

/** 回读投屏窗口品牌身份（标题/WM_SETICON 大小图标/AUMID），供验收与诊断。 */
export const vdProjectionIdentity = (sessionId: string) =>
  invoke<ProjectionIdentityReport>("vd_projection_identity", { sessionId });


export const fsListDir = (path: string, showHidden: boolean, offset = 0) =>
  invoke<FsDirListing>("fs_list_dir", { path, showHidden, offset });

export const fsDirSignature = (path: string) =>
  invoke<FsDirSignature>("fs_dir_signature", { path });

export const fsPlaces = () => invoke<FsPlace[]>("fs_places");

export const fsCreateDir = (parent: string, name: string) =>
  invoke<string>("fs_create_dir", { parent, name });

export const fsCreateFile = (parent: string, name: string) =>
  invoke<string>("fs_create_file", { parent, name });

export const fsRename = (path: string, newName: string) =>
  invoke<string>("fs_rename", { path, newName });


/** 批量重命名：后端逐项校验/执行，返回真实 ok/failed/skipped 与失败原因。 */
export const fsBatchRename = (items: FsBatchRenameItem[], operationId?: string) =>
  invoke<FsOpReport>("fs_batch_rename", { items, operationId });


export const fsHashFiles = (paths: string[]) => invoke<FsHashEntry[]>("fs_hash_files", { paths });

/** 真实卷键：Volume GUID / 卷挂载根；null 表示无法判定，调用方按跨卷安全复制。 */
export const fsVolumeKeys = (paths: string[]) =>
  invoke<Array<string | null>>("fs_volume_keys", { paths });


/** 大图预览（按需解码，不写 256px 缩略图缓存）。 */
export const fsPreviewImage = (path: string) =>
  invoke<string | null>("fs_preview_image", { path });

/** 文本/代码只读预览（最多 2 MiB，二进制拒绝）。 */
export const fsReadText = (path: string, maxBytes?: number) =>
  invoke<FsTextPreview>("fs_read_text", { path, maxBytes });

/** 原始字节只读预览（图片原图 / PDF；默认 32 MiB，上限 64 MiB）。 */
export const fsReadBinary = (path: string, maxBytes?: number) =>
  invoke<FsBinaryPreview>("fs_read_binary", { path, maxBytes });

/** 视频/音频预览 URL（短期 token + 自定义协议，支持 Range）。 */
export const fsPreviewMediaUrl = (path: string) =>
  invoke<string>("fs_preview_media_url", { path });

/** 关闭/切换预览时释放媒体 token，避免短期 token 槽位积压。 */
export const fsReleasePreviewUrl = (url: string) =>
  invoke<void>("fs_release_preview_url", { url });


export const fsPreviewOperation = (
  paths: string[],
  targetDir: string,
  effect: "copy" | "move",
) => invoke<OperationPreview>("fs_preview_operation", { paths, targetDir, effect });

export const fsCopyPaths = (paths: string[], targetDir: string, conflict: string, operationId?: string) =>
  invoke<FsOpReport>("fs_copy_paths", { paths, targetDir, conflict, operationId });

/** conflict: skip | rename | overwrite */
export const fsMovePaths = (paths: string[], targetDir: string, conflict: string, operationId?: string) =>
  invoke<FsOpReport>("fs_move_paths", { paths, targetDir, conflict, operationId });

export const fsDeletePaths = (paths: string[], permanent: boolean, operationId?: string) =>
  invoke<FsOpReport>("fs_delete_paths", { paths, permanent, operationId });

/** 重复文件专用删除：每个组必须保留一项，后端重新 SHA-256 后才进回收站。 */
export const fsDeleteVerifiedDuplicates = (
  groups: VerifiedDuplicateDeleteGroup[],
  operationId?: string,
) => invoke<FileJobSnapshot>("fs_delete_verified_duplicates", { groups, operationId });

export const fsStat = (paths: string[]) => invoke<FsStat[]>("fs_stat", { paths });

export const fsOpen = (path: string) => invoke<void>("fs_open", { path });

export const fsReveal = (path: string) => invoke<void>("fs_reveal", { path });

/** Windows「打开方式」选择器（Shell openas 动词）。 */
export const fsOpenWith = (path: string) => invoke<void>("fs_open_with", { path });

/** Windows 原生属性页（与内部只读属性对话框区分）。 */
export const fsShowProperties = (path: string) => invoke<void>("fs_show_properties", { path });

/** 在终端中打开：目录直接打开；文件打开其父目录。 */
export const fsOpenTerminal = (path: string) => invoke<void>("fs_open_terminal", { path });

/** 缩略图（PNG data URL）；无处理器返回 null，由前端回落类型图标。 */
export const fsThumbnail = (path: string, maxPx: number) =>
  invoke<string | null>("fs_thumbnail", { path, maxPx });


/** 任务是否已结束（前端不得把末态任务继续当运行中轮询）。 */
export const isFileJobTerminal = (job: FileJobSnapshot): boolean =>
  job.status === "completed" ||
  job.status === "partial" ||
  job.status === "failed" ||
  job.status === "cancelled";

export const recycleStats = () => invoke<RecycleStats>("recycle_stats");

export const recycleList = (query: RecycleQuery) => invoke<RecyclePage>("recycle_list", { query });

export const recycleSync = (force = false) =>
  invoke<RecycleSyncStatus>("recycle_sync", { force });

export const recycleSyncStatus = () => invoke<RecycleSyncStatus>("recycle_sync_status");

export const recycleSyncCancel = () => invoke<void>("recycle_sync_cancel");

export const recycleRestore = (ids: string[], conflict: "skip" | "rename", operationId?: string) =>
  invoke<FileJobSnapshot>("recycle_restore", { ids, conflict, operationId });

export const recyclePurge = (ids: string[], operationId?: string) =>
  invoke<FileJobSnapshot>("recycle_purge", { ids, operationId });

export const recycleEmpty = (volumes: string[] | null, operationId?: string) =>
  invoke<FileJobSnapshot>("recycle_empty", { volumes, operationId });

export const fsDeleteJobStart = (paths: string[], permanent: boolean, operationId?: string) =>
  invoke<FileJobSnapshot>("fs_delete_job_start", { paths, permanent, operationId });

/** 批量复制任务：立即返回任务快照，进度经 `recycle:job-progress` 推送。
 * `traceId` 可选诊断链路标识：只做诊断关联（异步 worker 显式传参），不参与鉴权。 */
export const fsCopyJobStart = (
  paths: string[],
  targetDir: string,
  conflict: "skip" | "rename" | "overwrite" = "rename",
  operationId?: string,
  traceId?: string | null,
) =>
  invoke<FileJobSnapshot>("fs_copy_job_start", {
    paths,
    targetDir,
    conflict,
    operationId,
    traceId: traceId ?? null,
  });

/** 批量移动任务：语义同复制，在顶层条目间取消，当前文件/目录需先完成。 */
export const fsMoveJobStart = (
  paths: string[],
  targetDir: string,
  conflict: "skip" | "rename" | "overwrite" = "rename",
  operationId?: string,
  traceId?: string | null,
) =>
  invoke<FileJobSnapshot>("fs_move_job_start", {
    paths,
    targetDir,
    conflict,
    operationId,
    traceId: traceId ?? null,
  });

export const fsJobStatus = (jobId: string) => invoke<FileJobSnapshot>("fs_job_status", { jobId });

export const fsDragOut = (paths: string[]) => invoke<void>("fs_drag_out", { paths });

/** 按需读取复制/移动/重命名完整逐项结果；null 表示尚无报告，任务过期会拒绝。 */
export const fsJobReport = (jobId: string) => invoke<FsOpReport | null>("fs_job_report", { jobId });

export const fsBatchRenameJobStart = (items: FsBatchRenameItem[], operationId?: string) =>
  invoke<FileJobSnapshot>("fs_batch_rename_job_start", { items, operationId });

export const fsJobCancel = (jobId: string) => invoke<boolean>("fs_job_cancel", { jobId });

export const fsJobs = () => invoke<FileJobSnapshot[]>("fs_jobs");

export const onRecycleJobProgress = (cb: (snapshot: FileJobSnapshot) => void): Promise<UnlistenFn> =>
  listen<FileJobSnapshot>("recycle:job-progress", (event) => cb(event.payload));

export const onRecycleSyncProgress = (cb: (progress: RecycleScanProgress) => void): Promise<UnlistenFn> =>
  listen<RecycleScanProgress>("recycle:sync-progress", (event) => cb(event.payload));

export const onRecycleSyncDone = (cb: (summary: RecycleSyncSummary) => void): Promise<UnlistenFn> =>
  listen<RecycleSyncSummary>("recycle:sync-done", (event) => cb(event.payload));


export const capabilityKnowledgeStats = () =>
  invoke<KnowledgeStats>("capability_knowledge_stats", {});
export const capabilityKbList = (query?: string, kind?: string) =>
  invoke<KnowledgeBase[]>("capability_kb_list", { query, kind });
export const capabilityKbGet = (id: string) =>
  invoke<KnowledgeBaseDetail>("capability_kb_get", { id });
export const capabilityKbCreate = (input: {
  name: string;
  description?: string;
  kind?: KnowledgeBaseKind;
  projectId?: string | null;
  workspaceId?: string | null;
}) => invoke<KnowledgeBase>("capability_kb_create", { input });
export const capabilityKbUpdate = (
  id: string,
  input: {
    name: string;
    description?: string;
    kind?: KnowledgeBaseKind;
    projectId?: string | null;
    workspaceId?: string | null;
  },
) => invoke<KnowledgeBase>("capability_kb_update", { id, input });
export const capabilityKbDelete = (id: string) =>
  invoke<{ deletedDocs: number; deletedCopies: number }>("capability_kb_delete", { id });
export const capabilityKbSetFavorite = (id: string, favorite: boolean) =>
  invoke<KnowledgeBase>("capability_kb_set_favorite", { id, favorite });
export const capabilityDocumentList = (
  kbId: string,
  opts: {
    query?: string;
    status?: KnowledgeDocStatus;
    sourceKind?: KnowledgeSourceKind;
    offset?: number;
    limit?: number;
  } = {},
) => invoke<KnowledgeDocumentPage>("capability_document_list", { kbId, ...opts });
export const capabilityDocumentGet = (id: string) =>
  invoke<KnowledgeDocumentDetail>("capability_document_get", { id });
export const capabilityDocumentImportFile = (
  kbId: string,
  path: string,
  mode: KnowledgeSourceMode,
  title?: string,
) => invoke<KnowledgeImportReport>("capability_document_import_file", { kbId, path, mode, title });
export const capabilityDocumentImportFolder = (
  kbId: string,
  path: string,
  mode: KnowledgeSourceMode,
) => invoke<KnowledgeImportReport>("capability_document_import_folder", { kbId, path, mode });
export const capabilityDocumentImportNote = (kbId: string, noteId: string) =>
  invoke<KnowledgeImportReport>("capability_document_import_note", { kbId, noteId });
export const capabilityDocumentImportCapture = (kbId: string, captureId: string) =>
  invoke<KnowledgeImportReport>("capability_document_import_capture", { kbId, captureId });
export const capabilityDocumentCreateText = (kbId: string, title: string, content: string) =>
  invoke<KnowledgeImportReport>("capability_document_create_text", { kbId, title, content });
export const capabilityDocumentReindex = (id: string) =>
  invoke<KnowledgeDocument>("capability_document_reindex", { id });
export const capabilityKbRebuild = (kbId: string) =>
  invoke<{ indexed: number; failed: number; skipped: number }>("capability_kb_rebuild", { kbId });
export const capabilityDocumentDelete = (id: string) =>
  invoke<{ deletedCopy: boolean }>("capability_document_delete", { id });
export const capabilityKnowledgeSearch = (
  query: string,
  opts: {
    kbIds?: string[];
    sourceKind?: KnowledgeSourceKind;
    projectId?: string;
    limit?: number;
    offset?: number;
  } = {},
) => invoke<KnowledgeSearchPage>("capability_knowledge_search", { query, ...opts });
export const capabilityKnowledgeLinkAdd = (
  docId: string,
  targetKind: KnowledgeLink["targetKind"],
  targetId: string,
  label = "",
) => invoke<KnowledgeLink[]>("capability_knowledge_link_add", { docId, targetKind, targetId, label });
export const capabilityKnowledgeLinkRemove = (docId: string, linkId: string) =>
  invoke<KnowledgeLink[]>("capability_knowledge_link_remove", { docId, linkId });
export const capabilityKnowledgeLinks = (docId: string) =>
  invoke<KnowledgeLink[]>("capability_knowledge_links", { docId });

export const capabilitySkillScan = (extraRoots: string[] = []) =>
  invoke<SkillScanReport>("capability_skill_scan", { extraRoots });
export const capabilitySkillList = (opts: {
  query?: string;
  scope?: string;
  risk?: string;
  projectId?: string;
} = {}) => invoke<SkillSummary[]>("capability_skill_list", opts);
export const capabilitySkillGet = (id: string) =>
  invoke<SkillDetail>("capability_skill_get", { id });
export const capabilitySkillSetEnabled = (id: string, enabled: boolean) =>
  invoke<SkillSummary>("capability_skill_set_enabled", { id, enabled });
export const capabilitySkillSetScope = (
  id: string,
  scope: SkillSummary["scope"],
  projectId?: string | null,
  workspaceId?: string | null,
  agentId?: string | null,
) =>
  invoke<SkillSummary>("capability_skill_set_scope", {
    id,
    scope,
    projectId,
    workspaceId,
    agentId,
  });
export const capabilitySkillImport = (
  sourcePath: string,
  scope?: SkillSummary["scope"],
  projectId?: string | null,
  workspaceId?: string | null,
  agentId?: string | null,
) =>
  invoke<SkillDetail>("capability_skill_import", {
    sourcePath,
    scope,
    projectId,
    workspaceId,
    agentId,
  });
export const capabilitySkillSaveContent = (id: string, content: string) =>
  invoke<SkillSummary>("capability_skill_save_content", { id, content });
export const capabilitySkillDelete = (id: string) =>
  invoke<boolean>("capability_skill_delete", { id });

export const capabilityMcpServersList = () =>
  invoke<ExternalMcpServer[]>("capability_mcp_servers_list", {});
export const capabilityMcpServerSave = (input: {
  id?: string;
  name: string;
  command: string;
  args: string[];
  env: { key: string; value: string }[];
}) => invoke<ExternalMcpServer>("capability_mcp_server_save", { input });
export const capabilityMcpServerDelete = (id: string) =>
  invoke<boolean>("capability_mcp_server_delete", { id });
export const capabilityMcpServerSetEnabled = (id: string, enabled: boolean) =>
  invoke<ExternalMcpServer>("capability_mcp_server_set_enabled", { id, enabled });
export const capabilityMcpServerSetAllowHighRisk = (id: string, allow: boolean) =>
  invoke<ExternalMcpServer>("capability_mcp_server_set_allow_high_risk", { id, allow });
export const capabilityMcpServerTest = (id: string) =>
  invoke<McpConnectionReport>("capability_mcp_server_test", { id });
export const capabilityMcpServerCall = (
  id: string,
  toolName: string,
  argsJson: string,
  confirmed: boolean,
) => invoke<McpCallReport>("capability_mcp_server_call", { id, toolName, argsJson, confirmed });
export const capabilityMcpCalls = (serverId?: string, offset = 0, limit = 50) =>
  invoke<McpCallPage>("capability_mcp_calls", { serverId, offset, limit });

export const capabilityContextList = (projectId?: string) =>
  invoke<CapabilityContextProfile[]>("capability_context_list", { projectId });
export const capabilityContextGet = (id: string) =>
  invoke<CapabilityContextProfile>("capability_context_get", { id });
export const capabilityContextSave = (input: {
  id?: string;
  name: string;
  description?: string;
  projectId?: string | null;
  config: CapabilityContextConfig;
}) => invoke<CapabilityContextProfile>("capability_context_save", { input });
export const capabilityContextDelete = (id: string) =>
  invoke<boolean>("capability_context_delete", { id });
export const capabilityContextDuplicate = (id: string) =>
  invoke<CapabilityContextProfile>("capability_context_duplicate", { id });
export const capabilityContextAssemble = (opts: {
  id?: string;
  config?: CapabilityContextConfig;
  query?: string;
  maxChars?: number;
}) => invoke<CapabilityContextBundle>("capability_context_assemble", opts);

export const capabilityRecipeList = () =>
  invoke<CapabilityRecipeSummary[]>("capability_recipe_list", {});
export const capabilityRecipeGet = (id: string) =>
  invoke<CapabilityRecipe>("capability_recipe_get", { id });
export const capabilityRecipeSave = (input: {
  id?: string;
  name: string;
  description?: string;
  projectId?: string | null;
  enabled?: boolean;
  steps: CapabilityRecipeStep[];
}) => invoke<CapabilityRecipe>("capability_recipe_save", { input });
export const capabilityRecipeDelete = (id: string) =>
  invoke<boolean>("capability_recipe_delete", { id });
export const capabilityRecipeDuplicate = (id: string) =>
  invoke<CapabilityRecipe>("capability_recipe_duplicate", { id });
export const capabilityRecipeExport = (id: string, includeSecretArgs = false) =>
  invoke<string>("capability_recipe_export", { id, includeSecretArgs });
export const capabilityRecipeImport = (json: string) =>
  invoke<CapabilityRecipe>("capability_recipe_import", { json });
export const capabilityRecipeRun = (id: string, confirmed: boolean) =>
  invoke<CapabilityRecipeRun>("capability_recipe_run", { id, confirmed });
export const capabilityRecipeRuns = (recipeId?: string, offset = 0, limit = 50) =>
  invoke<CapabilityRecipeRunPage>("capability_recipe_runs", { recipeId, offset, limit });
export const capabilityRecipeRunGet = (id: string) =>
  invoke<CapabilityRecipeRun>("capability_recipe_run_get", { id });


export const projectHubListProjects = () =>
  invoke<ProjectHubProjectSummary[]>("project_hub_list_projects", {});

export const projectHubGetProject = (projectId: string) =>
  invoke<ProjectHubSnapshot>("project_hub_get_project", { projectId });

export const projectHubCreateProject = (input: ProjectHubCreateInput) =>
  invoke<ProjectHubSnapshot>("project_hub_create_project", { input });

/** 可绑定资源候选（知识库 / Skill / MCP / Agent）；只返回当前项目作用域内的真实资源。 */
export const projectHubResourceCandidates = (projectId: string, kind?: string, query?: string) =>
  invoke<ProjectHubResourceCandidate[]>("project_hub_resource_candidates", { projectId, kind, query });

/** 项目已关联的资源清单。 */
export const projectHubResourceLinks = (projectId: string) =>
  invoke<ProjectHubResourceLink[]>("project_hub_resource_links", { projectId });

/** 绑定资源到能力（幂等）。 */
export const projectHubResourceLink = (projectId: string, input: ProjectHubResourceLinkInput) =>
  invoke<ProjectHubResourceLink>("project_hub_resource_link", { projectId, input });

/** 解除资源关联（只删关联，不删资源本体）。 */
export const projectHubResourceUnlink = (projectId: string, linkId: string) =>
  invoke<void>("project_hub_resource_unlink", { projectId, linkId });

/** 重新校验资源可用性。 */
export const projectHubResourceValidate = (projectId: string, linkId: string) =>
  invoke<ProjectHubResourceLink>("project_hub_resource_validate", { projectId, linkId });

/** 工作目录校验原始结果（`workspace_path_check`）：只含事实，不含 canonicalize 后的路径。 */
export interface WorkspacePathCheckResult {
  status: "empty" | "invalid" | "offline" | "not-directory" | "inaccessible" | "ok";
  /** `unc` = 网络目录 / `\\?\` 扩展路径（产品不支持，创建服务会拒绝）。 */
  reason?: "not-absolute" | "unc" | "illegal-char" | null;
  path?: string | null;
}

/** 校验工作目录：语法 + 是否存在 / 是否目录 / 是否可访问。 */
export const workspacePathCheck = (raw: string) =>
  invoke<WorkspacePathCheckResult>("workspace_path_check", { raw });
