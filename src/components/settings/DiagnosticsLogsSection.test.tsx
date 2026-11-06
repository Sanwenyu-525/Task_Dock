/**
 * 诊断与日志设置区块：只读列表 + 筛选 + 清理确认。
 * 只验证行为契约，不校验视觉（视觉走截图走查）。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  summary: vi.fn(),
  query: vi.fn(),
  setMode: vi.fn(),
  clear: vi.fn(),
  exportReport: vi.fn(),
  openDir: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock("../../lib/bridge", () => ({
  diagnosticsStatus: mocks.status,
  diagnosticsSummary: mocks.summary,
  diagnosticsQuery: mocks.query,
  diagnosticsSetMode: mocks.setMode,
  diagnosticsClear: mocks.clear,
  diagnosticsExport: mocks.exportReport,
  diagnosticsOpenDir: mocks.openDir,
}));

vi.mock("../../store/useUiStore", () => ({
  useUiStore: (selector: (state: { showToast: typeof mocks.showToast }) => unknown) =>
    selector({ showToast: mocks.showToast }),
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

const PAGE = {
  items: [
    {
      timestamp: "2026-11-06T18:02:00.000+08:00",
      level: "ERROR" as const,
      module: "clipboard",
      action: "paste_batch",
      event: "failed",
      session_id: "session-1234-abcd",
      error_code: "IO_ERROR",
      duration_ms: 42,
      window_id: "main",
      operation_id: "op-1234abcd",
      message: "批量粘贴失败",
      source: "frontend" as const,
      count: 1,
    },
  ],
  matched: 1,
  scanned: 12,
  truncated: false,
  files: 1,
  skipped: 0,
};

beforeEach(() => {
  mocks.status.mockReset().mockResolvedValue(STATUS);
  mocks.summary.mockReset().mockResolvedValue(SUMMARY);
  mocks.query.mockReset().mockResolvedValue(PAGE);
  mocks.setMode.mockReset().mockResolvedValue({ ...STATUS, mode: "verbose", verboseRemainingMs: 1_800_000 });
  mocks.clear.mockReset().mockResolvedValue({ removedBytes: 2048, status: STATUS });
  mocks.exportReport.mockReset().mockResolvedValue({
    path: "C:\\data\\diagnostics\\exports\\diagnostic-report.json",
    bytes: 4096,
    records: 1,
    truncated: false,
  });
  mocks.openDir.mockReset().mockResolvedValue(undefined);
  mocks.showToast.mockReset();
});

afterEach(() => cleanup());

describe("DiagnosticsLogsSection", () => {
  it("加载状态与最近异常，不伪造空数据", async () => {
    render(<DiagnosticsLogsSection />);
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(1));
    // 模块名同时出现在「最近异常」和「日志明细」两处，按所有匹配断言。
    expect((await screen.findAllByText("clipboard")).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("IO_ERROR").length).toBeGreaterThanOrEqual(2);
    // 聚合次数与恢复标记来自后端，不在前端推算
    expect(screen.getByText("×3")).toBeTruthy();
    expect(
      screen.getByText("settings.diagnosticsLogs.recent.recovered"),
    ).toBeTruthy();
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("切换级别筛选会带上 levels 重新查询", async () => {
    render(<DiagnosticsLogsSection />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));
    const levelSelect = screen.getByLabelText("settings.diagnosticsLogs.filter.level");
    fireEvent.click(levelSelect);
    // 下拉项带 role=option；列表行里也有 ERROR 文本，不能按文本匹配。
    fireEvent.click(await screen.findByRole("option", { name: "ERROR" }));
    await waitFor(() => {
      const last = mocks.query.mock.calls.at(-1)?.[0];
      expect(last?.levels).toEqual(["ERROR"]);
      expect(last?.limit).toBe(30);
      expect(last?.offset).toBe(0);
    });
  });

  it("开启详细诊断会调用后端并同步模式", async () => {
    render(<DiagnosticsLogsSection />);
    await waitFor(() => expect(mocks.status).toHaveBeenCalled());
    fireEvent.click(
      screen.getByRole("button", {
        name: "settings.diagnosticsLogs.mode.enable",
      }),
    );
    await waitFor(() => expect(mocks.setMode).toHaveBeenCalledWith("verbose", 30));
  });

  it("清理需要二次确认，确认后重新加载", async () => {
    render(<DiagnosticsLogsSection />);
    await waitFor(() => expect(mocks.status).toHaveBeenCalled());
    fireEvent.click(
      screen.getByRole("button", { name: /settings.diagnosticsLogs.action.clear/ }),
    );
    expect(mocks.clear).not.toHaveBeenCalled();
    const confirm = await screen.findByRole("button", {
      name: "settings.diagnosticsLogs.clear.confirm",
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.clear).toHaveBeenCalledTimes(1));
    // 清理后重新拉取状态与列表
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
  });

  it("导出只请求本机文件并展示路径", async () => {
    render(<DiagnosticsLogsSection />);
    await waitFor(() => expect(mocks.status).toHaveBeenCalled());
    fireEvent.click(
      screen.getByRole("button", { name: /settings.diagnosticsLogs.action.export/ }),
    );
    await waitFor(() => expect(mocks.exportReport).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(/C:\\data\\diagnostics\\exports\\diagnostic-report\.json/),
    ).toBeTruthy();
  });
});
