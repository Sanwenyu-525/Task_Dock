/**
 * @vitest-environment jsdom
 */
//! 设置页：分组默认折叠与持久化、跨模块定位、备份元数据展示、箭头行尾布局。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BackupEntry, Settings } from "../../lib/bridge";

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
import {
  SETTINGS_SECTIONS_STORAGE_KEY,
  type SettingsSectionId,
} from "../../lib/settingsSections";
import {
  SETTINGS_CATEGORY_STORAGE_KEY,
  categoryForSection,
  sectionsForCategory,
  settingsCategory,
  settingsSectionMeta,
  type SettingsCategoryId,
} from "../../lib/settingsCategories";
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
};

/** 设置页每个一级分类下的分组标题（顺序与页面渲染一致）。 */
function categoryTitles(category: SettingsCategoryId): string[] {
  return sectionsForCategory(category).map((meta) => titleOf(meta.id));
}

function sectionHead(title: string): HTMLElement {
  // 只匹配可折叠分组头（带 aria-expanded），避免命中内容区里的「打开资源管理」等按钮。
  const head = screen
    .getAllByRole("button")
    .find((el) => el.hasAttribute("aria-expanded") && (el.textContent ?? "").includes(title));
  if (!head) throw new Error(`未找到分组：${title}`);
  return head;
}

/** 分组标题：直接取自注册表的 i18n Key，避免测试里再抄一份中文标题表。 */
function titleOf(id: SettingsSectionId): string {
  const meta = settingsSectionMeta(id);
  if (!meta) throw new Error(`分组 ${id} 未在注册表中登记`);
  return zhCN[meta.labelKey];
}

/** 切换一级分类（分类导航是 tablist，用 role=tab 定位）。 */
function activateCategory(category: SettingsCategoryId) {
  const meta = settingsCategory(category);
  if (!meta) throw new Error(`分类 ${category} 未登记`);
  fireEvent.click(screen.getByRole("tab", { name: zhCN[meta.labelKey] }));
}

/** 先切到分组所属分类，再返回该分组的折叠头（分类内只渲染当前分类）。 */
function openSection(id: SettingsSectionId): HTMLElement {
  activateCategory(categoryForSection(id));
  return sectionHead(titleOf(id));
}

function expectExpanded(head: HTMLElement, expanded: boolean) {
  expect(head.getAttribute("aria-expanded")).toBe(String(expanded));
}

/** 只统计可折叠分组（带折叠箭头）的展开内容，忽略其他会话新增的非折叠区块。 */
function foldableBodyCount(): number {
  const foldable = Array.from(document.querySelectorAll("[data-collapsible-section]")).filter((section) =>
    section.querySelector(".collapsible-chevron"),
  );
  return foldable.reduce(
    (sum, section) => sum + section.querySelectorAll(".collapsible-body:not([hidden])").length,
    0,
  );
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

describe("设置页分组折叠", () => {
  it("首次无记录时默认进入「通用与外观」，本分类分组全部折叠、箭头在标题行末尾", () => {
    render(<SettingsPanel />);
    // 默认分类：第一个分类
    expect(
      screen.getByRole("tab", { name: zhCN["settings.category.general"] }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    for (const title of categoryTitles("general")) {
      const head = sectionHead(title);
      expectExpanded(head, false);
      // 箭头属于标题行（图标/标题/徽标同一层），整行仍由按钮承载点击与键盘操作
      expect(
        head.querySelector(".collapsible-title-row")?.lastElementChild?.classList.contains(
          "collapsible-chevron",
        ),
      ).toBe(true);
    }
    // 其它分类的分组不在 DOM 里（不是靠 CSS 隐藏，也不产生额外查询）
    expect(screen.queryByRole("button", { name: /智能剪贴板/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /数据与备份/ })).toBeNull();
    expect(foldableBodyCount()).toBe(0);
  });

  it("切换分类只渲染目标分类的分组，切回后原分类内容仍在", () => {
    render(<SettingsPanel />);
    expect(screen.getByRole("button", { name: /外观与主题/ })).toBeTruthy();

    activateCategory("data-resources");
    expect(screen.getByRole("tab", { name: zhCN["settings.category.dataResources"] }).getAttribute("aria-selected")).toBe("true");
    for (const title of categoryTitles("data-resources")) {
      expect(screen.getByRole("button", { name: new RegExp(title) })).toBeTruthy();
    }
    expect(screen.queryByRole("button", { name: /外观与主题/ })).toBeNull();

    activateCategory("general");
    expect(screen.getByRole("button", { name: /外观与主题/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /数据与备份/ })).toBeNull();
  });

  it("展开后组件重挂载仍从本地偏好恢复，可同时展开多个（跨分类保持）", () => {
    render(<SettingsPanel />);
    fireEvent.click(sectionHead("外观与主题"));
    fireEvent.click(sectionHead("导航自定义"));

    expectExpanded(sectionHead("外观与主题"), true);
    expectExpanded(sectionHead("导航自定义"), true);
    expect(foldableBodyCount()).toBe(2);

    // 另一个分类里再展开一个：两个分类的展开状态互不影响
    fireEvent.click(openSection("notifications"));
    expectExpanded(sectionHead("通知"), true);

    cleanup();
    render(<SettingsPanel />);
    // 分类选中态同样持久化：回到上次查看的分类
    expect(
      screen.getByRole("tab", { name: zhCN["settings.category.notifyVoice"] }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    expectExpanded(sectionHead("通知"), true);

    activateCategory("general");
    expectExpanded(sectionHead("外观与主题"), true);
    expectExpanded(sectionHead("导航自定义"), true);
    expectExpanded(sectionHead("窗口与快捷键"), false);
  });

  it("自动识别图片文字开关为禁用状态并标注待开发", () => {
    render(<SettingsPanel />);
    fireEvent.click(openSection("clipboard"));

    const switchControl = screen.getByRole("switch", { name: "自动识别图片文字" }) as HTMLInputElement;
    expect(switchControl.disabled).toBe(true);
    expect(switchControl.checked).toBe(false);
    expect(screen.getByText(/待开发，目前仅支持手动提取文字/)).toBeTruthy();
  });

  it("历史配置已是 true 时如实展示为开启、仍禁用且不重置配置", () => {
    useSettingsStore.setState({ settings: { ...BASE_SETTINGS, clipboard_ocr_auto: true } });
    render(<SettingsPanel />);
    fireEvent.click(openSection("clipboard"));

    const switchControl = screen.getByRole("switch", { name: "自动识别图片文字" }) as HTMLInputElement;
    expect(switchControl.checked).toBe(true);
    expect(switchControl.disabled).toBe(true);
    expect(screen.getByText(/待开发，目前仅支持手动提取文字/)).toBeTruthy();
    // 禁用态下不触发业务更新，历史键值不被清空
    fireEvent.click(switchControl);
    expect(useSettingsStore.getState().settings?.clipboard_ocr_auto).toBe(true);
  });

  it("再次折叠会立即写回本地偏好", () => {
    render(<SettingsPanel />);
    fireEvent.click(sectionHead("外观与主题"));
    fireEvent.click(sectionHead("外观与主题"));

    const stored = JSON.parse(localStorage.getItem(SETTINGS_SECTIONS_STORAGE_KEY) ?? "{}");
    expect(stored.version).toBe(1);
    expect(stored.sections.appearance).toBe(false);
    expectExpanded(sectionHead("外观与主题"), false);
  });

  it("资源管理分组只保留入口，点击后切到独立页面而不是内嵌完整面板", () => {
    render(<SettingsPanel />);
    fireEvent.click(openSection("resource-cleanup"));

    // 设置里不再渲染清理/概览/进程诊断本体（避免两份完整界面）。
    expect(screen.queryByText("资源概览")).toBeNull();
    expect(screen.queryByText("settings.resourceCleanup.categoriesTitle")).toBeNull();
    expect(localStorage.getItem(SETTINGS_SECTIONS_STORAGE_KEY)).toContain('"resource-cleanup":true');

    fireEvent.click(screen.getByRole("button", { name: "打开资源管理" }));
    expect(useUiStore.getState().tab).toBe("resource");
    // 设置页内不应触发资源采样 IPC
    expect(vi.mocked(resourceSnapshot)).not.toHaveBeenCalled();
  });

  it("查找设置可直接展开并定位资源管理，无需滚动查找", async () => {
    render(<SettingsPanel />);

    const search = screen.getByRole("combobox", { name: "查找设置" });
    fireEvent.focus(search);
    fireEvent.change(search, { target: { value: "资源管理" } });
    fireEvent.click(await screen.findByRole("option", { name: /资源管理/ }));

    await waitFor(() => expectExpanded(sectionHead("资源管理"), true));
    // 查找结果会自动切到分组所属分类
    expect(
      screen.getByRole("tab", { name: zhCN["settings.category.dataResources"] }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    const stored = JSON.parse(localStorage.getItem(SETTINGS_SECTIONS_STORAGE_KEY) ?? "{}");
    expect(stored.sections["resource-cleanup"]).toBe(true);
  });

  it("帮助与教程设置可打开帮助中心并重新打开新手引导", () => {
    useOnboardingStore.setState({ open: false, step: 0, hydrated: true, done: true, hasNewContent: false });
    render(<SettingsPanel />);
    fireEvent.click(openSection("help"));

    fireEvent.click(screen.getByRole("button", { name: "打开帮助中心" }));
    expect(useUiStore.getState().tab).toBe("help");
    expect(useUiStore.getState().helpReturnTab).toBe("settings");

    fireEvent.click(screen.getByRole("button", { name: "重新打开新手引导" }));
    expect(useOnboardingStore.getState().open).toBe(true);
    expect(useOnboardingStore.getState().step).toBe(0);
  });

  it("MCP 服务开关默认关闭并通过设置更新", async () => {
    render(<SettingsPanel />);
    fireEvent.click(openSection("agent"));

    expect(screen.getByRole("button", { name: "查看帮助：MCP 服务器：规划数据的授权读写" })).toBeTruthy();

    const toggle = screen.getByRole("switch", { name: "MCP 规划数据访问服务（默认关闭）" });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(useSettingsStore.getState().update).toHaveBeenCalledWith({ mcp_server_enabled: true }),
    );
  });

  it("数据与备份区提供对应的恢复教程入口", () => {
    render(<SettingsPanel />);
    fireEvent.click(openSection("data"));

    expect(screen.getByRole("button", { name: "查看帮助：备份与恢复：数据在哪些环节受保护" })).toBeTruthy();
  });

  it("「自定义导航」一次性意图会展开导航分区并清除标记", async () => {
    sessionStorage.setItem("taskdock.settings.reveal.v1", "navigation");
    render(<SettingsPanel />);

    await waitFor(() => expectExpanded(sectionHead("导航自定义"), true));
    // 数字与 navigationRegistry 默认常驻的 left 入口数一致（帮助入口默认隐藏）；
    // 再新增常驻入口时需同步更新。
    expect(screen.getByText(/常驻 13 \/ 15 项/)).toBeTruthy();
    expect(sessionStorage.getItem("taskdock.settings.reveal.v1")).toBeNull();
    // 定位意图会先切到分组所属分类
    expect(
      screen.getByRole("tab", { name: zhCN["settings.category.general"] }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
  });

  it("跨分类定位：语音缓存意图会切到「通知与语音」并展开对应分组", async () => {
    sessionStorage.setItem("taskdock.settings.reveal.v1", "tts-cache");
    render(<SettingsPanel />);

    await waitFor(() => expectExpanded(sectionHead("语音缓存"), true));
    expect(
      screen.getByRole("tab", { name: zhCN["settings.category.notifyVoice"] }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
  });

  it("存储损坏或权限拒绝时安全回退为默认分类且全部折叠", () => {
    localStorage.setItem(SETTINGS_SECTIONS_STORAGE_KEY, "{broken");
    localStorage.setItem(SETTINGS_CATEGORY_STORAGE_KEY, "{broken");
    render(<SettingsPanel />);
    expect(
      screen.getByRole("tab", { name: zhCN["settings.category.general"] }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    for (const title of categoryTitles("general")) {
      expectExpanded(sectionHead(title), false);
    }

    cleanup();
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    render(<SettingsPanel />);
    expect(() => fireEvent.click(sectionHead("外观与主题"))).not.toThrow();
    expectExpanded(sectionHead("外观与主题"), true);
    getItem.mockRestore();
  });

  it("从工具面板进入时先切到「功能与应用」、展开应用分组，再滚动定位", async () => {
    const scrollSpy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    useUiStore.setState({ appConfig: { kind: "manage", token: 1 } });

    render(<SettingsPanel />);
    await waitFor(() => expectExpanded(sectionHead("应用与快捷方式"), true));
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
    expect(
      screen.getByRole("tab", { name: zhCN["settings.category.features"] }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
  });
});

describe("设置页备份记录", () => {
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
    fireEvent.click(openSection("data"));
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
});

// ── 按需加载（2026-11-06 信息架构重整）────────────────────────────────
// 设置页不再在挂载时并发读取备份/剪贴板附属数据：只有展开对应分组才读一次，
// 切换分类本身不产生查询；读取失败会解除「已加载」标记，再次展开可重试。
describe("设置页按需加载", () => {
  it("初始挂载与分类切换都不读取附属数据；展开对应分组各读一次", async () => {
    render(<SettingsPanel />);
    expect(vi.mocked(listBackups)).not.toHaveBeenCalled();
    expect(vi.mocked(clipboardStats)).not.toHaveBeenCalled();
    expect(vi.mocked(clipboardStatus)).not.toHaveBeenCalled();

    for (const category of ["features", "notify-voice", "data-resources", "integration", "help", "general"] as const) {
      activateCategory(category);
    }
    expect(vi.mocked(listBackups)).not.toHaveBeenCalled();
    expect(vi.mocked(clipboardStats)).not.toHaveBeenCalled();

    fireEvent.click(openSection("data"));
    await waitFor(() => expect(vi.mocked(listBackups)).toHaveBeenCalledTimes(1));
    // 折叠再展开不重复读取
    fireEvent.click(sectionHead("数据与备份"));
    fireEvent.click(sectionHead("数据与备份"));
    expect(vi.mocked(listBackups)).toHaveBeenCalledTimes(1);

    fireEvent.click(openSection("clipboard"));
    await waitFor(() => expect(vi.mocked(clipboardStats)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(clipboardStatus)).toHaveBeenCalledTimes(1);
  });

  it("读取失败显示真实错误，再次展开会重试而不是永久空数据", async () => {
    vi.mocked(listBackups).mockRejectedValueOnce(new Error("数据库被占用"));
    render(<SettingsPanel />);
    fireEvent.click(openSection("data"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("数据库被占用");

    fireEvent.click(sectionHead("数据与备份"));
    fireEvent.click(sectionHead("数据与备份"));
    await waitFor(() => expect(vi.mocked(listBackups)).toHaveBeenCalledTimes(2));
  });
});

// ── 分类导航无障碍 ────────────────────────────────────────────────────
describe("设置页分类导航无障碍", () => {
  it("方向键在分类间移动并激活，Home/End 到首尾", () => {
    render(<SettingsPanel />);
    const general = screen.getByRole("tab", { name: zhCN["settings.category.general"] });
    general.focus();
    fireEvent.keyDown(general, { key: "ArrowRight" });

    const features = screen.getByRole("tab", { name: zhCN["settings.category.features"] });
    expect(features.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(features);

    fireEvent.keyDown(features, { key: "End" });
    const help = screen.getByRole("tab", { name: zhCN["settings.category.help"] });
    expect(help.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(help, { key: "Home" });
    expect(screen.getByRole("tab", { name: zhCN["settings.category.general"] }).getAttribute("aria-selected")).toBe("true");
  });

  it("只有当前分类进入 Tab 序列，tab 与内容区通过 aria 双向关联", () => {
    render(<SettingsPanel />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(6);
    expect(tabs.filter((tab) => tab.getAttribute("tabindex") === "0")).toHaveLength(1);

    const selected = screen.getByRole("tab", { selected: true });
    const panel = screen.getByRole("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(selected.id);
    expect(panel.id).toBe(selected.getAttribute("aria-controls"));
    // 隐藏分类的内容不会被读屏软件读到：其它分类的分组根本不在 DOM 里
    expect(screen.queryByRole("button", { name: /智能剪贴板/ })).toBeNull();
  });
});

// ── 分类切换的状态保护 ────────────────────────────────────────────────
describe("设置页分类切换的状态保护", () => {
  it("输入中的剪贴板排除名单在切换分类前被提交，不静默丢失", () => {
    render(<SettingsPanel />);
    fireEvent.click(openSection("clipboard"));

    const textarea = screen.getByRole("textbox", {
      name: "剪贴板排除的应用名单",
    }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "keepass.exe" } });

    activateCategory("general");

    expect(useSettingsStore.getState().update).toHaveBeenCalledWith({
      clipboard_exclude_apps: "keepass.exe",
    });
    // 设置值本身来自 Store，切换分类不改变它
    expect(useSettingsStore.getState().settings?.clipboard_enabled).toBe(true);
  });
});

// ── 查找设置（分类 + 分组级搜索）──────────────────────────────────────
describe("设置页查找设置", () => {
  it("输入别名命中分组，选中后切分类、展开并定位（含诊断与日志）", async () => {
    render(<SettingsPanel />);
    const input = screen.getByRole("combobox", { name: "查找设置" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "日志" } });

    const option = await screen.findByRole("option", { name: /诊断与日志/ });
    fireEvent.click(option);

    await waitFor(() => expectExpanded(sectionHead("诊断与日志"), true));
    expect(
      screen.getByRole("tab", { name: zhCN["settings.category.integration"] }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
  });

  it("无匹配结果时给出明确说明，不显示空列表", async () => {
    render(<SettingsPanel />);
    const input = screen.getByRole("combobox", { name: "查找设置" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "zzz-not-exist" } });

    expect(await screen.findByText("没有匹配的设置分组")).toBeTruthy();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("只做搜索：点空输入不拿全量列表当下拉，输入后才出结果", async () => {
    const { container } = render(<SettingsPanel />);
    const input = screen.getByRole("combobox", { name: "查找设置" });

    // 不再渲染下拉箭头，聚焦/点击空输入也不会展开 25 个分组
    expect(container.querySelector(".ui-combobox-caret")).toBeNull();
    fireEvent.focus(input);
    fireEvent.click(input);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("option")).toHaveLength(0);

    fireEvent.change(input, { target: { value: "日志" } });
    expect(await screen.findByRole("option", { name: /诊断与日志/ })).toBeTruthy();

    // 清空检索词后收起结果，回到初始搜索态
    fireEvent.click(screen.getByRole("button", { name: "清除查找" }));
    await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
    expect((input as HTMLInputElement).value).toBe("");
  });
});
