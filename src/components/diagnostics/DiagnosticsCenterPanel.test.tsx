/**
 * 诊断中心页面：只验证行为契约（查询模式、请求竞态、状态区分、清空确认、
 * 导出完整度），不校验视觉（视觉走截图走查）。
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  summary: vi.fn(),
  query: vi.fn(),
  clear: vi.fn(),
  exportReport: vi.fn(),
  openDir: vi.fn(),
  showToast: vi.fn(),
  setClientVerboseMode: vi.fn(),
  fullVisible: { value: true },
}));

vi.mock("../../lib/bridge", () => ({
  diagnosticsStatus: mocks.status,
  diagnosticsSummary: mocks.summary,
  diagnosticsQuery: mocks.query,
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
  useFullViewVisible: () => mocks.fullVisible.value,
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

const FACETS = {
  ...HEALTH,
  recoveredMarked: true,
  groups: [{ ...HEALTH.groups[0], recovered: true }],
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

const EMPTY_PAGE = {
  items: [],
  matched: 0,
  scanned: 12,
  truncated: false,
  files: 1,
  skipped: 0,
};

const CHAIN_PAGE = {
  items: [
    {
      ...PAGE.items[0],
      timestamp: "2026-11-06T18:03:00.000+08:00",
      action: "finish",
      event: "success",
      status: "success",
      message: "链-新",
    },
    {
      ...PAGE.items[0],
      timestamp: "2026-11-06T18:01:00.000+08:00",
      action: "start",
      event: "started",
      status: "started",
      message: "链-旧",
    },
  ],
  matched: 2,
  scanned: 12,
  truncated: false,
  files: 1,
  skipped: 0,
};

function pageWithMessage(message: string) {
  return {
    ...PAGE,
    items: [{ ...PAGE.items[0], message }],
  };
}

beforeEach(() => {
  mocks.fullVisible.value = true;
  mocks.status.mockReset().mockResolvedValue(STATUS);
  mocks.summary.mockReset().mockResolvedValue(FACETS);
  mocks.query.mockReset().mockResolvedValue(PAGE);
  mocks.clear.mockReset().mockResolvedValue({
    removedBytes: 2048,
    completed: true,
    status: { ...STATUS, totalBytes: 0, written: 0 },
  });
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
  it("默认异常列表使用 anomaliesOnly 查询，概览错误/警告来自 24h 摘要", async () => {
    render(<DiagnosticsCenterPanel />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));

    const listFilter = mocks.query.mock.calls[0][0];
    expect(listFilter.anomaliesOnly).toBe(true);
    expect(listFilter.levels).toBeUndefined();
    expect(listFilter.offset).toBe(0);
    expect(listFilter.limit).toBe(30);
    expect(listFilter.since).toBeTruthy();

    // 健康概览固定 24h + anomaliesOnly；分面摘要不按模块/错误码收窄。
    const healthCall = mocks.summary.mock.calls[0][0];
    expect(healthCall.anomaliesOnly).toBe(true);
    expect(
      Math.abs(Date.now() - 24 * 3_600_000 - Date.parse(healthCall.since)),
    ).toBeLessThan(60_000);
    const facetCall = mocks.summary.mock.calls[1][0];
    expect(facetCall.modules).toBeUndefined();
    expect(facetCall.errorCodes).toBeUndefined();

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

    // 模式徽标只读展示（切换在设置页）。
    expect(screen.getByText("diagnosticsCenter.overview.modeNormal")).toBeTruthy();

    // 列表两行：第一行 module/action 与聚合次数，第二行错误码/message/已恢复。
    const list = screen.getByRole("region", { name: "diagnosticsCenter.list.title" });
    expect(await within(list).findByText("clipboard/paste_batch")).toBeTruthy();
    expect(within(list).getByText("×2")).toBeTruthy();
    expect(within(list).getByText("diagnosticsCenter.list.recovered")).toBeTruthy();
    expect(
      screen.getByText(
        "diagnosticsCenter.list.pageInfo|" + JSON.stringify({ shown: 1, matched: 1 }),
      ),
    ).toBeTruthy();
  });

  it("点击有 operation_id 的记录可查看操作链，查询不带列表筛选且时间线升序", async () => {
    mocks.query.mockImplementation((filter: { operationId?: string }) =>
      filter?.operationId ? Promise.resolve(CHAIN_PAGE) : Promise.resolve(PAGE),
    );
    render(<DiagnosticsCenterPanel />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));

    fireEvent.click(
      screen.getByRole("button", { name: "diagnosticsCenter.list.expand" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "diagnosticsCenter.list.chain" }),
    );

    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(2));
    const chainFilter = mocks.query.mock.calls[1][0];
    expect(chainFilter).toEqual({
      operationId: "op-1234abcd",
      limit: 200,
      offset: 0,
    });
    expect(chainFilter.levels).toBeUndefined();
    expect(chainFilter.anomaliesOnly).toBeUndefined();

    const timeline = await screen.findByRole("list", {
      name: "diagnosticsCenter.chain.title",
    });
    const items = within(timeline).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    // mock 返回新→旧，界面必须按时间升序渲染为旧→新。
    expect(items[0].textContent).toContain("链-旧");
    expect(items[1].textContent).toContain("链-新");
    expect(screen.queryByText("diagnosticsCenter.chain.noStart")).toBeNull();
    expect(screen.queryByText("diagnosticsCenter.chain.noTerminal")).toBeNull();
    // 没有 DEBUG stage 事件时明确说明：普通模式下中间阶段不落盘。
    expect(screen.getByText("diagnosticsCenter.chain.noStages")).toBeTruthy();
  });

  it("操作链 0 条与缺少 started/终态时给出明确提示", async () => {
    const openChain = () => {
      fireEvent.click(
        screen.getByRole("button", { name: "diagnosticsCenter.list.expand" }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "diagnosticsCenter.list.chain" }),
      );
    };

    mocks.query
      .mockResolvedValueOnce(PAGE)
      .mockResolvedValueOnce(EMPTY_PAGE);
    render(<DiagnosticsCenterPanel />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));
    openChain();
    expect(await screen.findByText("diagnosticsCenter.chain.empty")).toBeTruthy();

    cleanup();
    mocks.query.mockReset();
    mocks.query
      .mockResolvedValueOnce(PAGE)
      .mockResolvedValueOnce({
        ...CHAIN_PAGE,
        items: [
          {
            ...PAGE.items[0],
            level: "INFO",
            event: "step",
            status: undefined,
            message: "只有中间步骤",
          },
        ],
        matched: 1,
      });
    render(<DiagnosticsCenterPanel />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));
    openChain();
    expect(await screen.findByText("diagnosticsCenter.chain.noStart")).toBeTruthy();
    expect(screen.getByText("diagnosticsCenter.chain.noTerminal")).toBeTruthy();
  });

  it("操作链命中数超过 200 条上限时明确提示只展示最近部分", async () => {
    mocks.query.mockImplementation((filter: { operationId?: string }) =>
      filter?.operationId
        ? Promise.resolve({ ...CHAIN_PAGE, matched: 250 })
        : Promise.resolve(PAGE),
    );
    render(<DiagnosticsCenterPanel />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));

    fireEvent.click(
      screen.getByRole("button", { name: "diagnosticsCenter.list.expand" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "diagnosticsCenter.list.chain" }),
    );

    expect(
      await screen.findByText(
        "diagnosticsCenter.chain.limit|" + JSON.stringify({ matched: 250, count: 2 }),
      ),
    ).toBeTruthy();
  });

  it("无 operation_id 的记录不出现「查看操作链」，详情说明无法关联", async () => {
    mocks.query.mockResolvedValue({
      ...PAGE,
      items: [{ ...PAGE.items[0], operation_id: undefined }],
    });
    render(<DiagnosticsCenterPanel />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));

    fireEvent.click(
      screen.getByRole("button", { name: "diagnosticsCenter.list.expand" }),
    );
    expect(screen.queryByRole("button", { name: "diagnosticsCenter.list.chain" })).toBeNull();
    expect(screen.getByText("diagnosticsCenter.list.noOperation")).toBeTruthy();
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("应用 operation_id 后显示 chip，可从 chip 查看完整操作链", async () => {
    mocks.query.mockImplementation((filter: { limit?: number }) =>
      filter?.limit === 200 ? Promise.resolve(CHAIN_PAGE) : Promise.resolve(PAGE),
    );
    render(<DiagnosticsCenterPanel />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));

    fireEvent.click(
      screen.getByRole("button", { name: "diagnosticsCenter.filter.advanced" }),
    );
    const operation = screen.getByLabelText("diagnosticsCenter.filter.operation");
    fireEvent.change(operation, { target: { value: "op-1234abcd" } });
    fireEvent.keyDown(operation, { key: "Enter" });
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(2));

    const chip = screen
      .getByText("diagnosticsCenter.filter.operationChip")
      .closest(".diag-center-op-chip");
    expect(chip?.textContent).toContain("op-1234abcd");
    fireEvent.click(
      within(chip as HTMLElement).getByRole("button", {
        name: "diagnosticsCenter.filter.viewChain",
      }),
    );

    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(3));
    expect(mocks.query.mock.calls[2][0]).toEqual({
      operationId: "op-1234abcd",
      limit: 200,
      offset: 0,
    });
    expect(
      await screen.findByRole("list", { name: "diagnosticsCenter.chain.title" }),
    ).toBeTruthy();
  });

  it("快速切换筛选时旧响应不得覆盖新结果", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    mocks.query.mockImplementation((filter: { text?: string }) => {
      if (filter?.text === "first") return firstPromise;
      if (filter?.text === "second") return Promise.resolve(pageWithMessage("second-only"));
      return Promise.resolve(PAGE);
    });
    render(<DiagnosticsCenterPanel />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));

    const keyword = screen.getByLabelText("diagnosticsCenter.filter.keyword");
    fireEvent.change(keyword, { target: { value: "first" } });
    fireEvent.keyDown(keyword, { key: "Enter" });
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(2));

    fireEvent.change(keyword, { target: { value: "second" } });
    fireEvent.keyDown(keyword, { key: "Enter" });
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(3));
    expect(await screen.findByText("second-only")).toBeTruthy();

    // 第一次查询此时才返回：序号已过期，必须被丢弃。
    resolveFirst(pageWithMessage("first-only"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("first-only")).toBeNull();
    expect(screen.getByText("second-only")).toBeTruthy();
  });

  it("无任何日志与筛选无结果使用不同空态", async () => {
    mocks.status.mockResolvedValue({
      ...STATUS,
      totalBytes: 0,
      written: 0,
      files: [],
    });
    mocks.query.mockResolvedValue({ ...EMPTY_PAGE, scanned: 0, files: 0 });
    render(<DiagnosticsCenterPanel />);

    expect(await screen.findByText("diagnosticsCenter.list.empty")).toBeTruthy();
    expect(screen.getByText("diagnosticsCenter.list.emptyNoLogsHint")).toBeTruthy();
    expect(screen.queryByText("diagnosticsCenter.list.emptyFiltered")).toBeNull();

    cleanup();
    mocks.query.mockClear();

    mocks.status.mockResolvedValue(STATUS);
    mocks.query.mockResolvedValue(EMPTY_PAGE);
    render(<DiagnosticsCenterPanel />);
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));
    const keyword = screen.getByLabelText("diagnosticsCenter.filter.keyword");
    fireEvent.change(keyword, { target: { value: "no-match" } });
    fireEvent.keyDown(keyword, { key: "Enter" });

    expect(await screen.findByText("diagnosticsCenter.list.emptyFiltered")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "diagnosticsCenter.filter.reset" }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("diagnosticsCenter.list.emptyNoLogsHint")).toBeNull();
  });

  it("读取失败显示原因与重试按钮，重试成功后恢复列表", async () => {
    mocks.status
      .mockRejectedValueOnce(new Error("IPC down"))
      .mockResolvedValue(STATUS);
    render(<DiagnosticsCenterPanel />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("IPC down");
    expect(alert.textContent).toContain("diagnosticsCenter.list.error");
    expect(screen.queryByText("diagnosticsCenter.list.empty")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("×2")).toBeTruthy();
  });

  it("清理必须二次确认；确认后调用后端并明确「业务数据未删除」", async () => {
    render(<DiagnosticsCenterPanel />);
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(1));
    // 清理后的重新加载必须返回空列表，才能覆盖「已清理」列表状态。
    mocks.query.mockResolvedValue(EMPTY_PAGE);

    fireEvent.click(
      screen.getByRole("button", { name: "diagnosticsCenter.action.clear" }),
    );
    expect(mocks.clear).not.toHaveBeenCalled();

    fireEvent.click(
      await screen.findByRole("button", { name: "diagnosticsCenter.clear.confirm" }),
    );
    await waitFor(() => expect(mocks.clear).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.status).toHaveBeenCalledTimes(2));
    expect((await screen.findAllByText("diagnosticsCenter.list.cleared")).length).toBeGreaterThan(0);
    // 列表位置也保留「已清理」状态，避免页面滚动后只剩普通空态。
    const list = screen.getByRole("region", { name: "diagnosticsCenter.list.title" });
    expect(within(list).getByText("diagnosticsCenter.list.cleared")).toBeTruthy();
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

  it("完整面板不可见时不发起任何查询", async () => {
    mocks.fullVisible.value = false;
    render(<DiagnosticsCenterPanel />);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.summary).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("容量进度条与降级提示按 status 渲染", async () => {
    mocks.status.mockResolvedValue({
      ...STATUS,
      totalBytes: 24 * 1024 * 1024,
      maxTotalBytes: 25 * 1024 * 1024,
      degraded: true,
      lastError: "disk full",
    });
    render(<DiagnosticsCenterPanel />);
    await waitFor(() => expect(mocks.status).toHaveBeenCalled());

    const bar = await screen.findByRole("progressbar", {
      name: /diagnosticsCenter\.overview\.capacityAria/,
    });
    expect(bar.getAttribute("aria-valuenow")).toBe("96");
    const track = bar.closest(".diag-center-capacity-track");
    expect(track?.className).toContain("is-warn");
    // 接近上限是正常运维信号，不是错误；页面只提示自动轮转。
    expect(track?.className).not.toContain("is-error");
    expect(screen.getByText("diagnosticsCenter.overview.capacityNote")).toBeTruthy();

    const capacityMetric = screen
      .getByText("diagnosticsCenter.overview.capacity")
      .closest(".diag-center-metric");
    expect(capacityMetric?.textContent).toContain("24.00 MB / 25.00 MB");

    expect(screen.getByText(/diagnosticsCenter\.overview\.degraded/)).toBeTruthy();
    expect(screen.getByText(/disk full/)).toBeTruthy();
  });
});
