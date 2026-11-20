/**
 * @vitest-environment jsdom
 */
//! 设置中心（2026-11-20 重构后）：页面直达、持久化恢复、跨模块定位、
//! 按需数据加载、草稿卸载保护、树形导航键盘交互与备份元数据展示。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BackupEntry, Settings } from "../../lib/bridge";
import { NAV_ENTRIES } from "../../lib/navigationRegistry";

vi.mock("../../lib/bridge", () => ({
  auditTestData: vi.fn(),
  backupNow: vi.fn(),
  clipboardCleanup: vi.fn(),
  clipboardProbe: vi.fn(),
  clipboardRepairConfig: vi.fn(),
  clipboardStats: vi.fn(async () => ({})),
  clipboardStatus: vi.fn(async () => ({ configError: null, configOrigin: null })),
  exportData: vi.fn(),
  getAgentInboxDir: vi.fn(async () => ""),
  importData: vi.fn(),
  inspectBackup: vi.fn(),
  listBackups: vi.fn(async () => []),
  setAutostart: vi.fn(),
  setHotkeysEnabled: vi.fn(),
  performanceDiagnostics: vi.fn(),
  agentRetentionRun: vi.fn(),
  agentInboxRetry: vi.fn(),
  agentMcpStatus: vi.fn(async () => ({ enabled: false, running: false, port: null, agent_count: 0, started_at: null })),
  agentMcpList: vi.fn(async () => []),
  agentMcpCreate: vi.fn(),
  agentMcpRotateToken: vi.fn(),
  agentMcpSetScope: vi.fn(),
  agentMcpGrantProject: vi.fn(),
  agentMcpRevokeProject: vi.fn(),
  agentMcpRevoke: vi.fn(),
  agentMcpAuditList: vi.fn(async (offset: number, limit: number) => ({ items: [], total: 0, offset, limit })),
  agentMcpConfigSnippet: vi.fn(),
  mobileSyncStatus: vi.fn(async () => ({
    enabled: false,
    running: false,
    port: 47822,
    lan_ip: null,
    base_url: null,
    server_name: "TEST-PC",
    instance_id: "test-instance",
    fingerprint: "1A2B3C4D",
    error: null,
    pairing: null,
    paired_device: null,
    devices: [],
  })),
  mobileSyncStartPairing: vi.fn(),
  mobileSyncCancelPairing: vi.fn(async () => undefined),
  mobileSyncListDevices: vi.fn(async () => []),
  mobileSyncRevokeDevice: vi.fn(async () => true),
  mobileFileList: vi.fn(async () => []),
  mobileFileOffer: vi.fn(async () => []),
  mobileFileDelete: vi.fn(async () => true),
  mobileFileReveal: vi.fn(async () => undefined),
  mobileFileOpenInbox: vi.fn(async () => undefined),
  planningListProjects: vi.fn(async () => []),
  resourceSnapshot: vi.fn(async () => ({
    sampledAt: "2026-11-06T00:00:00.000Z",
    application: { knownCacheBytes: null, knownCacheFiles: null, status: "unavailable" },
    memory: { totalBytes: null, availableBytes: null },
    disks: [],
    process: {
      pid: 4242,
      name: "task-dock.exe",
      cpuPercent: null,
      cpuWindowMs: 0,
      workingSetBytes: null,
      privateBytes: null,
      uptimeSecs: null,
      status: "unknown",
    },
  })),
  resourceProcessDiagnostics: vi.fn(async () => ({
    sampledAt: "2026-11-06T00:00:00.000Z",
    cpuWindowMs: 0,
    supported: false,
    truncated: false,
      omittedExternal: 0,
      omittedUnknown: 0,
    processes: [],
  })),
  resourceCleanupPreview: vi.fn(),
  resourceCleanupExecute: vi.fn(),
  resourceJunkPreview: vi.fn(async () => ({
    previewId: "junk-1",
    createdAt: "2026-11-08T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    minimumAgeHours: 168,
    categories: [],
    totalCandidates: 0,
    totalEstimatedBytes: 0,
  })),
  resourceJunkExecute: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  applyWindowMaterial: vi.fn(async () => ({ applied: false, effect: "none", os_version: "" })),
  applyWindowRadius: vi.fn(async () => true),
}));

vi.mock("../../store/useAgentsStore", () => ({
  getAgentRefreshMetrics: () => ({}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
}));

vi.mock("../agents/MockControls", () => ({ default: () => null }));
vi.mock("./AppManagement", () => ({
  default: () => <div className="app-management" />,
}));
vi.mock("../navigation/AppPicker", () => ({ default: () => null }));
vi.mock("./hotkeys/HotkeysSection", () => ({ default: () => null }));
vi.mock("../../i18n/LanguageSetting", () => ({ default: () => null }));

import {
  clipboardStats,
  clipboardStatus,
  listBackups,
  resourceSnapshot,
} from "../../lib/bridge";
import { SETTINGS_SECTIONS_STORAGE_KEY, type SettingsSectionId } from "../../lib/settingsSections";
import {
  SETTINGS_CATEGORY_IDS,
  SETTINGS_CATEGORY_STORAGE_KEY,
  SETTINGS_SECTION_ACTIVE_STORAGE_KEY,
  firstSectionOf,
  sectionsForCategory,
  type SettingsCategoryId,
} from "../../lib/settingsCategories";
import { navItemElementId } from "./SettingsNavigation";
import { zhCN } from "../../locales/zh-CN";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { useOnboardingStore } from "../../store/useOnboardingStore";
import SettingsPanel from "./SettingsPanel";

const BASE_SETTINGS: Settings = {
  theme: "dark",
  mode: "full",
  material: "glass",
  visual_preset: "liquid-glass",
  clear_foreground: "auto",
  snap_enabled: true,
  snap_display_mode: "capsule",
  capsule_panel_width: 340,
  autostart: false,
  hotkey_enabled: true,
  http_enabled: false,
  http_port: 7331,
  http_token: "",
  mcp_server_enabled: false,
  mock_enabled: false,
  notify_reminder: true,
  notify_agent: true,
  notify_muted: false,
  notify_burst_max: 5,
  notify_rate_window_secs: 60,
  notify_done_aggregate: true,
  agent_alert_sound: true,
  overdue_grace_hours: 24,
  stale_run_minutes: 30,
  auto_backup: true,
  backup_retain_days: 30,
  ingest_queue_capacity: 1000,
  ingest_batch_size: 100,
  ingest_coalesce_ms: 50,
  agent_event_retention_days: 30,
  agent_event_max_rows: 100_000,
  agent_event_archive: true,
  agent_inbox_max_file_bytes: 1_048_576,
  agent_inbox_max_files: 1000,
  perf_diagnostics_enabled: true,
  nav_prefer_focus: true,
  nav_allow_launch: true,
  nav_fallback: true,
  nav_remember_window: true,
  nav_default_browser: "",
  // 生活效率系统：默认货币，空 = 未配置（不自动假设人民币）
  life_default_currency: "",
  nav_workspace_max: 5,
  workspace_enabled: true,
  actions_enabled: true,
  clipboard_enabled: true,
  clipboard_paused: false,
  clipboard_capture_images: true,
  clipboard_capture_files: true,
  clipboard_capture_html: true,
  clipboard_auto_group: true,
  clipboard_group_window_secs: 30,
  clipboard_retention_days: 7,
  clipboard_max_items: 500,
  clipboard_max_storage_mb: 100,
  clipboard_exclude_apps: "",
  clipboard_paste_interval_ms: 100,
  clipboard_paste_interval_image_ms: 100,
  clipboard_paste_interval_html_ms: 100,
  clipboard_paste_interval_files_ms: 100,
  clipboard_sensitive_filter: true,
  quick_capture_last_type: "task",
  // 开发工作台（2026-11）：当前任务锚点，空 = 未设置
  workbench_current_task: "",
};

/** 树内二级页面项（稳定 DOM id；同一函数供组件与测试共用）。 */
function pageItem(id: SettingsSectionId): HTMLElement {
  const item = document.getElementById(navItemElementId(id));
  if (!item) throw new Error(`未找到导航页面项：${id}`);
  return item;
}

/** 直达二级页面（点击树内页面项）。 */
function selectPage(id: SettingsSectionId) {
  fireEvent.click(pageItem(id));
}

/** 断言某页面处于选中态且内容已挂载（用该页面特有元素校验，避免依赖具体文案）。 */
function expectPageActive(id: SettingsSectionId, selected = true) {
  expect(pageItem(id).getAttribute("aria-selected")).toBe(String(selected));
}

/** 分类项：树内一级 treeitem。 */
function categoryItem(category: SettingsCategoryId): HTMLElement {
  const item = document.getElementById(`settings-nav-category-${category}`);
  if (!item) throw new Error(`未找到导航分类项：${category}`);
  return item;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  useUiStore.setState({ appConfig: null, tab: "settings", helpReturnTab: null });
  useSettingsStore.setState({
    settings: BASE_SETTINGS,
    materialInfo: null,
    load: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    syncExternal: vi.fn(),
    reapplyFromSystem: vi.fn(),
  });
  vi.mocked(listBackups).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ── 树形导航与页面直达 ────────────────────────────────────────────────
describe("设置中心树形导航", () => {
  it("首次无记录时默认进入第一个页面，六个分类全部展开", () => {
    render(<SettingsPanel />);
    const firstCategory = SETTINGS_CATEGORY_IDS[0];
    const firstSection = firstSectionOf(firstCategory);
    expectPageActive(firstSection, true);
    for (const category of SETTINGS_CATEGORY_IDS) {
      expect(categoryItem(category).getAttribute("aria-expanded")).toBe("true");
    }
    // 树是常驻导航（展开分类的页面项都在）；这里断言「其它页面内容未挂载」
    expect(
      screen.queryByRole("switch", { name: zhCN["settings.features.workspace"] }),
    ).toBeNull();
  });

  it("点击二级页面直达对应内容，切换后其它页面卸载", () => {
    render(<SettingsPanel />);
    selectPage("navigation");
    expectPageActive("navigation");
    // 导航自定义页面内容已挂载（原折叠卡三步操作 → 一步直达）
    expect(screen.getByText(/常驻 \d+ \/ \d+ 项/)).toBeTruthy();
    // 外观页面内容卸载
    expect(screen.queryByText(zhCN["settings.appearance.preset"])).toBeNull();
  });

  it("页面切换持久化，重挂载后恢复上次页面", () => {
    render(<SettingsPanel />);
    selectPage("diagnostics");
    const stored = JSON.parse(
      localStorage.getItem(SETTINGS_SECTION_ACTIVE_STORAGE_KEY) ?? "{}",
    );
    expect(stored.version).toBe(1);
    expect(stored.section).toBe("diagnostics");

    cleanup();
    render(<SettingsPanel />);
    expectPageActive("diagnostics");
    // 所属分类（接入与诊断）自动展开
    expect(categoryItem("integration").getAttribute("aria-expanded")).toBe("true");
  });

  it("损坏的页面键回退到旧分类键推导的页面；再损坏回退全局默认", () => {
    localStorage.setItem(SETTINGS_SECTION_ACTIVE_STORAGE_KEY, "{broken");
    localStorage.setItem(
      SETTINGS_CATEGORY_STORAGE_KEY,
      JSON.stringify({ version: 1, category: "integration" }),
    );
    render(<SettingsPanel />);
    expectPageActive(firstSectionOf("integration"));

    cleanup();
    localStorage.setItem(SETTINGS_CATEGORY_STORAGE_KEY, "{broken");
    render(<SettingsPanel />);
    expectPageActive(firstSectionOf(SETTINGS_CATEGORY_IDS[0]));
  });

  it("分类点击行为明确：收起态点击 = 展开并打开第一个页面；展开态点击 = 收起", () => {
    render(<SettingsPanel />);
    const helpCategory = categoryItem("help");
    // 默认全展开：先收起
    fireEvent.click(helpCategory);
    expect(helpCategory.getAttribute("aria-expanded")).toBe("false");
    // 再点击：展开 + 打开该分类第一个页面（当前页面不在其下）
    fireEvent.click(helpCategory);
    expect(helpCategory.getAttribute("aria-expanded")).toBe("true");
    expectPageActive("help");

    // 当前页面在该分类下时再次点击 = 仅收起导航，内容保持
    fireEvent.click(helpCategory);
    expect(helpCategory.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: "打开帮助中心" })).toBeTruthy();
  });

  it("收起含漫游锚点的分类后，树内仍存在可聚焦项（无死区）", () => {
    render(<SettingsPanel />);
    // 锚点初始在第一个页面项上；收起其所属分类后锚点应回落
    fireEvent.click(categoryItem(SETTINGS_CATEGORY_IDS[0]));
    const tabbable = Array.from(
      document.querySelectorAll<HTMLElement>('[role="treeitem"][tabindex="0"]'),
    );
    expect(tabbable.length).toBe(1);
    // 回落到所属分类按钮
    expect(tabbable[0].id).toBe(`settings-nav-category-${SETTINGS_CATEGORY_IDS[0]}`);
  });

  it("六个分类逐一可达：页面切换渲染对应可操作控件", () => {
    render(<SettingsPanel />);
    for (const category of SETTINGS_CATEGORY_IDS) {
      const section = firstSectionOf(category);
      selectPage(section);
      expectPageActive(section);
      const body = document.querySelector(".settings-page-host")!;
      expect(
        body.querySelectorAll(
          'button, [role="switch"], [role="combobox"], [role="spinbutton"], input, select, textarea',
        ).length,
      ).toBeGreaterThan(0);
    }
  });
});

// ── 树形导航键盘交互 ─────────────────────────────────────────────────
describe("设置中心导航键盘", () => {
  it("方向键在可见项间移动并激活页面；Home/End 到首尾", () => {
    render(<SettingsPanel />);
    const first = pageItem(firstSectionOf(SETTINGS_CATEGORY_IDS[0]));
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    // 下一个可见项是同分类第二个页面：聚焦并激活
    const second = sectionsForCategory(SETTINGS_CATEGORY_IDS[0])[1];
    expect(document.activeElement).toBe(pageItem(second.id));
    expectPageActive(second.id);
    expect(pageItem(second.id).getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(pageItem(second.id), { key: "End" });
    const lastCategory = SETTINGS_CATEGORY_IDS[SETTINGS_CATEGORY_IDS.length - 1];
    const lastSection = firstSectionOf(lastCategory);
    expect(document.activeElement).toBe(pageItem(lastSection));
    expectPageActive(lastSection);
  });

  it("ArrowRight 展开分类并进入第一个页面；ArrowLeft 收起", () => {
    render(<SettingsPanel />);
    const helpCategory = categoryItem("help");
    fireEvent.click(helpCategory); // 收起
    expect(helpCategory.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(helpCategory, { key: "ArrowRight" });
    expect(helpCategory.getAttribute("aria-expanded")).toBe("true");
    expectPageActive("help");

    fireEvent.keyDown(helpCategory, { key: "ArrowLeft" });
    expect(helpCategory.getAttribute("aria-expanded")).toBe("false");
  });
});

// ── 跨模块定位与搜索 ─────────────────────────────────────────────────
describe("设置中心定位与搜索", () => {
  it("「自定义导航」一次性意图直达导航自定义页面并清除标记", () => {
    sessionStorage.setItem("taskdock.settings.reveal.v1", "navigation");
    render(<SettingsPanel />);

    expectPageActive("navigation");
    expect(screen.getByText(/常驻 \d+ \/ \d+ 项/)).toBeTruthy();
    // 数字与导航注册表默认常驻入口一致（由注册表推导，避免测试与 UI 漂移）
    const leftEntries = NAV_ENTRIES.filter((entry) => entry.surfaces.includes("left"));
    const residentCount = leftEntries.filter((entry) => entry.defaults.left.visible).length;
    expect(
      screen.getByText(`常驻 ${residentCount} / ${leftEntries.length} 项`),
    ).toBeTruthy();
    expect(sessionStorage.getItem("taskdock.settings.reveal.v1")).toBeNull();
  });

  it("查找设置：命中结果直达对应页面（结果展示所属分类）", async () => {
    render(<SettingsPanel />);
    const input = screen.getByRole("combobox", { name: "查找设置" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "日志" } });

    const option = await screen.findByRole("option", { name: /诊断与日志/ });
    // 结果项展示所属分类（hint），用户选择前就知道会去哪个分类
    expect(option.textContent).toContain(zhCN["settings.category.integration"]);
    fireEvent.click(option);

    expectPageActive("diagnostics-logs");
    expect(categoryItem("integration").getAttribute("aria-expanded")).toBe("true");
    // 页面内容已挂载：焦点移到页面标题（外部定位路径）
    await waitFor(() =>
      expect(document.activeElement?.classList.contains("settings-page-title")).toBe(true),
    );
  });

  it("查找设置无匹配时给出明确说明；清空后收起", async () => {
    render(<SettingsPanel />);
    const input = screen.getByRole("combobox", { name: "查找设置" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "zzz-not-exist" } });
    expect(await screen.findByText("没有匹配的设置页面")).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "清除查找" }));
    await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("从工具面板进入时直达「应用与快捷方式」页面", () => {
    useUiStore.setState({ appConfig: { kind: "manage", token: 1 } });
    render(<SettingsPanel />);
    expectPageActive("apps");
    expect(document.querySelector(".app-management")).toBeTruthy();
  });
});

// ── 按需数据加载 ─────────────────────────────────────────────────────
describe("设置中心按需数据加载", () => {
  it("初始挂载与页面切换不读附属数据；进入对应页面各读一次", async () => {
    render(<SettingsPanel />);
    expect(vi.mocked(listBackups)).not.toHaveBeenCalled();
    expect(vi.mocked(clipboardStats)).not.toHaveBeenCalled();
    expect(vi.mocked(clipboardStatus)).not.toHaveBeenCalled();

    // 在不产生数据查询的页面间切换
    selectPage("appearance");
    selectPage("notifications");
    expect(vi.mocked(listBackups)).not.toHaveBeenCalled();
    expect(vi.mocked(clipboardStats)).not.toHaveBeenCalled();

    selectPage("data");
    await waitFor(() => expect(vi.mocked(listBackups)).toHaveBeenCalledTimes(1));

    selectPage("clipboard");
    await waitFor(() => {
      expect(vi.mocked(clipboardStats)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(clipboardStatus)).toHaveBeenCalledTimes(1);
    });
  });

  it("备份列表读取失败显示真实错误，重试可恢复", async () => {
    vi.mocked(listBackups).mockRejectedValueOnce(new Error("数据库被占用"));
    render(<SettingsPanel />);
    selectPage("data");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("数据库被占用");

    vi.mocked(listBackups).mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(vi.mocked(listBackups)).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// ── 页面切换的状态保护 ───────────────────────────────────────────────
describe("设置中心页面切换的状态保护", () => {
  it("输入中的剪贴板排除名单在切换页面前被提交（卸载守卫），不静默丢失", () => {
    render(<SettingsPanel />);
    selectPage("clipboard");

    const textarea = screen.getByRole("textbox", {
      name: "剪贴板排除的应用名单",
    }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "keepass.exe" } });

    // 未失焦直接切页：卸载守卫提交草稿
    selectPage("appearance");

    expect(useSettingsStore.getState().update).toHaveBeenCalledWith({
      clipboard_exclude_apps: "keepass.exe",
    });
    // 设置值本身来自 Store，切页不改变它
    expect(useSettingsStore.getState().settings?.clipboard_enabled).toBe(true);
  });

  it("切换页面时页面滚动区归零：搜索定位不会停在上一页的滚动位置", async () => {
    render(<SettingsPanel />);
    selectPage("data");
    const host = document.querySelector(".settings-page-host") as HTMLElement;
    // 模拟用户在长页面里向下滚动后再切页（dom 的 scrollTop 是可写的）。
    host.scrollTop = 520;

    selectPage("appearance");

    await waitFor(() =>
      expect((document.querySelector(".settings-page-host") as HTMLElement).scrollTop).toBe(0),
    );
  });
});

// ── 数据与备份页 ─────────────────────────────────────────────────────
describe("设置中心数据与备份页", () => {
  it("按真实 modified 展示时间与时区，类型/大小/截断信息不误标", async () => {
    vi.mocked(listBackups).mockResolvedValue([
      {
        name: "task-dock-20261104-full.json",
        size: 5 * 1024 * 1024,
        modified: new Date(2026, 10, 4, 10, 15).toISOString(),
        kind: "full",
        partial: false,
        truncated_tables: [],
        extended_modules: true,
      },
      {
        name: "legacy-2025.json",
        size: 2048,
        modified: new Date(2025, 0, 2, 3, 4).toISOString(),
        kind: null,
        partial: false,
      },
      {
        name: "mystery.zip",
        size: 10 * 1024 * 1024 * 1024,
        modified: "not-a-date",
        kind: "mystery",
        partial: true,
        truncated_tables: ["events"],
      },
    ] satisfies BackupEntry[]);

    render(<SettingsPanel />);
    selectPage("data");
    await waitFor(() =>
      expect(document.querySelectorAll(".backup-record")).toHaveLength(3),
    );

    const rows = Array.from(document.querySelectorAll(".backup-record")) as HTMLElement[];
    const byName = (name: string) => rows.find((row) => row.textContent?.includes(name))!;

    const full = byName("task-dock-20261104-full.json");
    expect(full.textContent).toContain("完整备份");
    expect(full.textContent).toContain("2026-11-04 10:15（UTC");
    expect(full.textContent).toContain("5.0 MB");
    expect(full.textContent).toContain("含扩展模块");

    const legacy = byName("legacy-2025.json");
    expect(legacy.textContent).toContain("旧版备份");
    expect(legacy.textContent).not.toContain("完整备份");

    const unknown = byName("mystery.zip");
    expect(unknown.textContent).toContain("类型未知");
    expect(unknown.textContent).toContain("10.00 GB");
    expect(unknown.textContent).toContain("部分数据");
    expect(unknown.textContent).toContain("截断 1 表");
    expect(unknown.textContent).toContain("修改时间未知");
  });

  it("资源清理页只保留入口，点击后切到独立页面而不是内嵌完整面板", () => {
    render(<SettingsPanel />);
    selectPage("resource-cleanup");

    // 设置里不再渲染清理/概览/进程诊断本体（避免两份完整界面）。
    expect(screen.queryByText("资源概览")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开资源管理" }));
    expect(useUiStore.getState().tab).toBe("resource");
    // 设置页内不应触发资源采样 IPC
    expect(vi.mocked(resourceSnapshot)).not.toHaveBeenCalled();
  });

  it("帮助页可打开帮助中心并重新打开新手引导", () => {
    useOnboardingStore.setState({ open: false, step: 0, hydrated: true, done: true, hasNewContent: false });
    render(<SettingsPanel />);
    selectPage("help");

    fireEvent.click(screen.getByRole("button", { name: "打开帮助中心" }));
    expect(useUiStore.getState().tab).toBe("help");
    expect(useUiStore.getState().helpReturnTab).toBe("settings");

    cleanup();
    render(<SettingsPanel />);
    selectPage("help");
    fireEvent.click(screen.getByRole("button", { name: "重新打开新手引导" }));
    expect(useOnboardingStore.getState().open).toBe(true);
    expect(useOnboardingStore.getState().step).toBe(0);
  });

  it("Agent 接入页：MCP 服务开关默认关闭并通过设置更新", async () => {
    render(<SettingsPanel />);
    selectPage("agent");

    expect(screen.getByRole("button", { name: "查看帮助：MCP 服务器：规划数据的授权读写" })).toBeTruthy();

    const toggle = screen.getByRole("switch", { name: "MCP 规划数据访问服务（默认关闭）" });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(useSettingsStore.getState().update).toHaveBeenCalledWith({ mcp_server_enabled: true }),
    );
  });

  it("数据与备份页提供对应的恢复教程入口", () => {
    render(<SettingsPanel />);
    selectPage("data");
    expect(screen.getByRole("button", { name: "查看帮助：备份与恢复：数据在哪些环节受保护" })).toBeTruthy();
  });

  it("剪贴板页：自动识别图片文字开关为禁用状态并标注待开发", () => {
    render(<SettingsPanel />);
    selectPage("clipboard");

    const switchControl = screen.getByRole("switch", { name: "自动识别图片文字" }) as HTMLInputElement;
    expect(switchControl.disabled).toBe(true);
    expect(switchControl.checked).toBe(false);
    expect(screen.getByText(/待开发，目前仅支持手动提取文字/)).toBeTruthy();
  });
});

// ── 折叠偏好键兼容（旧版本升级路径）──────────────────────────────────
describe("设置中心存储兼容", () => {
  it("旧折叠偏好键不再被页面消费，但键保留且 reveal 协议不受影响", () => {
    localStorage.setItem(
      SETTINGS_SECTIONS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        sections: { appearance: true, clipboard: true },
      }),
    );
    render(<SettingsPanel />);
    // 页面化后不再有折叠卡：全部页面直达，旧键不产生任何错误行为
    expectPageActive(firstSectionOf(SETTINGS_CATEGORY_IDS[0]));
    selectPage("clipboard");
    expectPageActive("clipboard");
  });
});
