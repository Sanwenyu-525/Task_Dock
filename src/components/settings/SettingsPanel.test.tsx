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

import { listBackups } from "../../lib/bridge";
import { SETTINGS_SECTIONS_STORAGE_KEY } from "../../lib/settingsSections";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import SettingsPanel from "./SettingsPanel";

const BASE_SETTINGS: Settings = {
  theme: "dark",
  mode: "full",
  material: "glass",
  visual_preset: "liquid-glass",
  clear_foreground: "auto",
  snap_enabled: true,
  snap_display_mode: "capsule",
  autostart: false,
  hotkey_enabled: true,
  http_enabled: false,
  http_port: 7331,
  http_token: "",
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

const SECTION_TITLES = [
  "外观与主题",
  "导航自定义",
  "窗口与快捷键",
  "功能模块",
  "应用与快捷方式",
  "智能剪贴板",
  "通知",
  "Agent 接入",
  "数据与备份",
  "性能诊断",
  "开发者选项",
];

function sectionHead(title: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(title) });
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
  useUiStore.setState({ appConfig: null });
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
  it("首次无记录时所有主分组默认折叠，箭头位于标题行末尾", () => {
    render(<SettingsPanel />);
    for (const title of SECTION_TITLES) {
      const head = sectionHead(title);
      expectExpanded(head, false);
      // 箭头属于标题行（图标/标题/徽标同一层），整行仍由按钮承载点击与键盘操作
      expect(
        head.querySelector(".collapsible-title-row")?.lastElementChild?.classList.contains(
          "collapsible-chevron",
        ),
      ).toBe(true);
    }
    expect(foldableBodyCount()).toBe(0);
  });

  it("展开后组件重挂载仍从本地偏好恢复，可同时展开多个", () => {
    render(<SettingsPanel />);
    fireEvent.click(sectionHead("外观与主题"));
    fireEvent.click(sectionHead("通知"));

    expectExpanded(sectionHead("外观与主题"), true);
    expectExpanded(sectionHead("通知"), true);
    expect(foldableBodyCount()).toBe(2);

    cleanup();
    render(<SettingsPanel />);
    expectExpanded(sectionHead("外观与主题"), true);
    expectExpanded(sectionHead("通知"), true);
    expectExpanded(sectionHead("数据与备份"), false);
  });

  it("自动识别图片文字开关为禁用状态并标注待开发", () => {
    render(<SettingsPanel />);
    fireEvent.click(sectionHead("智能剪贴板"));

    const switchControl = screen.getByRole("switch", { name: "自动识别图片文字" }) as HTMLInputElement;
    expect(switchControl.disabled).toBe(true);
    expect(switchControl.checked).toBe(false);
    expect(screen.getByText(/待开发，目前仅支持手动提取文字/)).toBeTruthy();
  });

  it("历史配置已是 true 时如实展示为开启、仍禁用且不重置配置", () => {
    useSettingsStore.setState({ settings: { ...BASE_SETTINGS, clipboard_ocr_auto: true } });
    render(<SettingsPanel />);
    fireEvent.click(sectionHead("智能剪贴板"));

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

  it("「自定义导航」一次性意图会展开导航分区并清除标记", async () => {
    sessionStorage.setItem("taskdock.settings.reveal.v1", "navigation");
    render(<SettingsPanel />);

    await waitFor(() => expectExpanded(sectionHead("导航自定义"), true));
    expect(screen.getByText(/常驻 11 \/ 11 项/)).toBeTruthy();
    expect(sessionStorage.getItem("taskdock.settings.reveal.v1")).toBeNull();
  });

  it("存储损坏或权限拒绝时安全回退为全部折叠", () => {
    localStorage.setItem(SETTINGS_SECTIONS_STORAGE_KEY, "{broken");
    render(<SettingsPanel />);
    for (const title of SECTION_TITLES) {
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

  it("从工具面板进入时先展开应用分组，再滚动定位", async () => {
    const scrollSpy = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    useUiStore.setState({ appConfig: { kind: "manage", token: 1 } });

    render(<SettingsPanel />);
    await waitFor(() => expectExpanded(sectionHead("应用与快捷方式"), true));
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
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
    fireEvent.click(sectionHead("数据与备份"));
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
