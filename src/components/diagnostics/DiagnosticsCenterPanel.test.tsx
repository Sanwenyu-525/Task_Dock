/**
 * 诊断中心页面：只验证行为契约（数据来源、失败/空状态区分、清理二次确认、
 * 导出不完整警告），不校验视觉（视觉走截图走查）。
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
  setClientVerboseMode: vi.fn(),
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

vi.mock("../../lib/diagnostics", () => ({
  setClientVerboseMode: mocks.setClientVerboseMode,
}));

vi.mock("../../lib/errors", () => ({
  errorMessage: (raw: unknown) => (raw instanceof Error ? raw.message : String(raw)),
}));

vi.mock("../../store/useUiStore", () => ({
  useUiStore: (selector: (state: { showToast: typeof mocks.showToast }) => unknown) =>
    selector({ showToast: mocks.showToast }),
}));

vi.mock("../../hooks/useMainUiVisible", () => ({
  useFullViewVisible: () => true,
}));

// Key 级翻译：断言只依赖稳定 Key，不复制文案；带参数时追加 JSON 便于定位。
vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}|${JSON.stringify(vars)}` : key,
  }),
}));

import DiagnosticsCenterPanel from "./DiagnosticsCenterPanel";

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

const HEALTH = {
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
      recovered: false,
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

const FACETS = { ...HEALTH, recoveredMarked: true, groups: [{ ...HEALTH.groups[0], recovered: true }] };

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
      stage: "write",
      duration_ms: 42,
      window_id: "main",
      operation_id: "op-1234abcd",
      message: "批量粘贴失败",
      source: "frontend" as const,
      count: 2,
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
  mocks.summary.mockReset().mockResolvedValue(FACETS);
  mocks.query.mockReset().mockResolvedValue(PAGE);
  mocks.setMode.mockReset().mockResolvedValue({ ...STATUS, mode: "verbose" });
  mocks.clear.mockReset().mockResolvedValue({ removedBytes: 2048, completed: true, status: STATUS });
  mocks.exportReport.mockReset().mockResolvedValue({
    path: "C:\\data\\diagnostics\\exports\\diagnostic-report.json",
    bytes: 4096,
    records: 1,
    truncated: false,
    complete: true,
    flushIssue: null,
  });
  mocks.openDir.mockReset().mockResolvedValue(undefined);
  mocks.showToast.mockReset();
  mocks.setClientVerboseMode.mockReset();
});

afterEach(() => cleanup());

describe("DiagnosticsCenterPanel", () => {
  it("健康概览与异常列表来自诊断 API，不在前端重算", async () => {
    render(<DiagnosticsCenterPanel />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));

    // 概览：近 24h 错误/警告、最近异常、诊断模式
    const errorsMetric = screen
      .getByText("diagnosticsCenter.overview.errors")
      .closest(".diag-center-metric");
    expect(errorsMetric?.textContent).toContain("3");
    const warningsMetric = screen
      .getByText("diagnosticsCenter.overview.warnings")
      .closest(".diag-center-metric");
    expect(warningsMetric?.textContent).toContain("1");
    const latestMetric = screen
      .getByText("diagnosticsCenter.overview.latest")
      .closest(".diag-center-metric");
    expect(latestMetric?.textContent).toContain("clipboard/paste_batch");
    const modeMetric = screen
      .getByText("diagnosticsCenter.overview.mode")
      .closest(".diag-center-metric");
    expect(modeMetric?.textContent).toContain("diagnosticsCenter.overview.modeNormal");

    // 列表行：stage / 聚合次数 / 摘要恢复标记
    expect(await screen.findByText("write")).toBeTruthy();
    expect(screen.getByText("×2")).toBeTruthy();
    expect(screen.getByText("diagnosticsCenter.list.recovered")).toBeTruthy();
    expect(
      screen.getByText("diagnosticsCenter.list.pageInfo|" + JSON.stringify({ shown: 1, matched: 1 })),
    ).toBeTruthy();

    // 健康概览固定 24h；分面摘要不按模块/错误码收窄（便于切换筛选）
    const since24hCall = mocks.summary.mock.calls[0][0];
    expect(since24hCall.anomaliesOnly).toBe(true);
    expect(since24hCall.since).toBeTruthy();
    const facetCall = mocks.summary.mock.calls[1][0];
    expect(facetCall.modules).toBeUndefined();
    expect(facetCall.errorCodes).toBeUndefined();
  });

  it("读取失败显示原因，绝不伪装成「没有日志」", async () => {
    mocks.status.mockRejectedValue(new Error("IPC down"));
    render(<DiagnosticsCenterPanel />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("IPC down");
    expect(alert.textContent).toContain("diagnosticsCenter.list.error");
    expect(screen.queryByText("diagnosticsCenter.list.empty")).toBeNull();
  });

  it("清理必须二次确认；确认后才调用后端并重新加载", async () => {
    render(<DiagnosticsCenterPanel />);
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(1));

    fireEvent.click(
      screen.getByRole("button", { name: "diagnosticsCenter.action.clear" }),
    );
    expect(mocks.clear).not.toHaveBeenCalled();

    fireEvent.click(
      await screen.findByRole("button", { name: "diagnosticsCenter.clear.confirm" }),
    );
    await waitFor(() => expect(mocks.clear).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
  });

  it("导出不完整时展示 complete 标记与 flushIssue 原因", async () => {
    mocks.exportReport.mockResolvedValue({
      path: "C:\\data\\diagnostics\\exports\\diagnostic-report.json",
      bytes: 4096,
      records: 1,
      truncated: false,
      complete: false,
      flushIssue: "timeout",
    });
    render(<DiagnosticsCenterPanel />);
    await waitFor(() => expect(mocks.status).toHaveBeenCalled());

    fireEvent.click(
      screen.getByRole("button", { name: "diagnosticsCenter.action.export" }),
    );
    expect(
      await screen.findByText("diagnosticsCenter.export.incompleteFlag"),
    ).toBeTruthy();
    expect(
      screen.getByText(/diagnosticsCenter\.export\.reason\.timeout/),
    ).toBeTruthy();
  });
});
