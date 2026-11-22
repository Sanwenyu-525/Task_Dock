/**
 * 诊断与日志设置区块：状态与入口。
 * 只验证行为契约（首屏拉取、模式切换、最近异常、入口跳转），不校验视觉。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  summary: vi.fn(),
  query: vi.fn(),
  setMode: vi.fn(),
  setTab: vi.fn(),
  setClientVerboseMode: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("../../lib/bridge", () => ({
  diagnosticsStatus: mocks.status,
  diagnosticsSummary: mocks.summary,
  diagnosticsQuery: mocks.query,
  diagnosticsSetMode: mocks.setMode,
}));

vi.mock("../../lib/diagnostics", () => ({
  setClientVerboseMode: mocks.setClientVerboseMode,
}));

vi.mock("../../store/useUiStore", () => ({
  useUiStore: Object.assign(
    (selector: (state: { showToast: typeof mocks.showToast }) => unknown) =>
      selector({ showToast: mocks.showToast }),
    { getState: () => ({ setTab: mocks.setTab }) },
  ),
}));

vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}|${JSON.stringify(vars)}` : key,
  }),
}));

import DiagnosticsLogsSection from "./DiagnosticsLogsSection";

const STATUS = {
  sessionId: "session-1234-abcd",
  startedAt: "2026-11-06T18:00:00.000+08:00",
  logDir: "C:\\Users\\tester\\AppData\\Roaming\\com.taskdock.desktop\\diagnostics",
  mode: "normal" as const,
  verboseRemainingMs: 0,
  files: [{ name: "diagnostics-active.jsonl", bytes: 2048, active: true }],
  totalBytes: 2048,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
  maxArchiveFiles: 4,
  written: 12,
  dropped: 1,
  queueFull: 0,
  aggregated: 3,
  rotations: 1,
  failures: 0,
  skippedLines: 0,
  degraded: false,
};

const SUMMARY = {
  total: 4,
  errors: 3,
  warnings: 1,
  infos: 0,
  groups: [
    {
      module: "clipboard",
      action: "paste_batch",
      errorCode: "IO_ERROR",
      level: "ERROR" as const,
      count: 3,
      firstSeen: "2026-11-06T18:01:00.000+08:00",
      lastSeen: "2026-11-06T18:02:00.000+08:00",
      lastStatus: "failed" as const,
      recovered: true,
      sampleMessage: "批量粘贴失败",
    },
  ],
  byModule: [{ key: "clipboard", count: 3 }],
  byCode: [{ key: "IO_ERROR", count: 3 }],
  truncated: false,
  scanned: 12,
  skipped: 0,
  files: 1,
  generatedAt: "2026-11-06T18:03:00.000+08:00",
};

const HOUR_MS = 3_600_000;

beforeEach(() => {
  mocks.status.mockReset().mockResolvedValue(STATUS);
  mocks.summary.mockReset().mockResolvedValue(SUMMARY);
  mocks.query.mockReset().mockResolvedValue({ items: [] });
  mocks.setMode.mockReset().mockResolvedValue({
    ...STATUS,
    mode: "verbose",
    verboseRemainingMs: 1_800_000,
  });
  mocks.setTab.mockReset();
  mocks.setClientVerboseMode.mockReset();
  mocks.showToast.mockReset();
});

afterEach(() => cleanup());

describe("DiagnosticsLogsSection", () => {
  it("加载后展示容量、计数器与会话，只拉取一次状态与摘要", async () => {
    render(<DiagnosticsLogsSection />);

    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(1));
    expect(mocks.summary).toHaveBeenCalledTimes(1);

    const summaryArg = mocks.summary.mock.calls[0]?.[0];
    expect(summaryArg?.anomaliesOnly).toBe(true);
    expect(typeof summaryArg?.since).toBe("string");
    expect(Math.abs(Date.now() - Date.parse(summaryArg.since) - 24 * HOUR_MS)).toBeLessThan(5_000);

    expect(await screen.findByText(/settings\.diagnosticsLogs\.status\.capacityValue/)).toBeTruthy();
    expect(screen.getByText(/settings\.diagnosticsLogs\.status\.countersValue/)).toBeTruthy();
    expect(screen.getByText(/session- · 11-06 18:00:00/)).toBeTruthy();
  });

  it("开启详细诊断会调用后端并同步客户端模式", async () => {
    render(<DiagnosticsLogsSection />);
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(1));

    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.diagnosticsLogs.mode.enable",
      }),
    );

    await waitFor(() => expect(mocks.setMode).toHaveBeenCalledWith("verbose", 30));
    await waitFor(() => expect(mocks.setClientVerboseMode).toHaveBeenLastCalledWith(true));
  });

  it("渲染最近异常分组与恢复标记", async () => {
    render(<DiagnosticsLogsSection />);
    await waitFor(() => expect(mocks.summary).toHaveBeenCalledTimes(1));

    expect(await screen.findByText("clipboard")).toBeTruthy();
    expect(screen.getByText("paste_batch")).toBeTruthy();
    expect(screen.getByText("IO_ERROR")).toBeTruthy();
    expect(screen.getByText("×3")).toBeTruthy();
    expect(screen.getByText("settings.diagnosticsLogs.recent.recovered")).toBeTruthy();
    expect(screen.getByText("批量粘贴失败")).toBeTruthy();
  });

  it("打开诊断中心会切换设置页签", async () => {
    render(<DiagnosticsLogsSection />);
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(1));

    fireEvent.click(
      screen.getByRole("button", { name: "settings.diagnosticsLogs.openCenter" }),
    );

    expect(mocks.setTab).toHaveBeenCalledWith("diagnostics");
  });

  it("不再调用 diagnosticsQuery，事件列表交给诊断中心", async () => {
    render(<DiagnosticsLogsSection />);
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.summary).toHaveBeenCalledTimes(1));

    expect(mocks.query).not.toHaveBeenCalled();
  });
});
