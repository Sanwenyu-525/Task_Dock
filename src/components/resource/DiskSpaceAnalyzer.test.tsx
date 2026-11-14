/**
 * @vitest-environment jsdom
 */
//! 只读空间分析：不自动扫描、子目录/大文件展示、逐层进入与返回、失败重试。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  openDialog: vi.fn(),
  reveal: vi.fn(),
}));

vi.mock("../../lib/bridge", () => ({
  resourceDiskAnalyze: mocks.analyze,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.openDialog,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: mocks.reveal,
}));

vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key}|${JSON.stringify(vars)}` : key,
  }),
}));

import DiskSpaceAnalyzer from "./DiskSpaceAnalyzer";

const REPORT = {
  path: "C:\\Temp",
  parent: "C:\\",
  sampledAt: "2026-11-08T00:00:00.000Z",
  totalBytes: 1000,
  totalFiles: 5,
  totalDirs: 3,
  rootFilesBytes: 100,
  rootFiles: 1,
  skippedLinks: 1,
  skippedErrors: 0,
  truncated: false,
  elapsedMs: 120,
  folders: [
    { name: "alpha", path: "C:\\Temp\\alpha", bytes: 600, files: 2 },
    { name: "beta", path: "C:\\Temp\\beta", bytes: 300, files: 2 },
  ],
  files: [
    { name: "big.bin", path: "C:\\Temp\\alpha\\big.bin", bytes: 400 },
    { name: "small.bin", path: "C:\\Temp\\small.bin", bytes: 20 },
  ],
};

beforeEach(() => {
  mocks.analyze.mockReset().mockResolvedValue(REPORT);
  mocks.openDialog.mockReset().mockResolvedValue(null);
  mocks.reveal.mockReset().mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("DiskSpaceAnalyzer", () => {
  it("初始不扫描；点击开始分析后展示汇总、子目录与最大文件", async () => {
    render(<DiskSpaceAnalyzer defaultPath={"C:\\"} />);
    expect(mocks.analyze).not.toHaveBeenCalled();
    expect(screen.getByText("C:\\")).toBeTruthy();
    expect(screen.getByText("resource.analysis.notScanned")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "resource.analysis.scan" }));
    await waitFor(() => expect(mocks.analyze).toHaveBeenCalledWith("C:\\"));
    expect(
      await screen.findByText(
        'resource.analysis.summary|{"bytes":"1000 B","files":5,"dirs":3,"ms":120}',
      ),
    ).toBeTruthy();

    // 子目录按占用降序；根目录文件单独一行；链接跳过提示存在
    const folders = screen
      .getAllByRole("button", { name: /resource\.aria\.analysisFolder/ })
      .map((node) => node.getAttribute("aria-label"));
    expect(folders[0]).toContain("alpha");
    expect(folders[1]).toContain("beta");
    expect(screen.getByText("resource.analysis.rootFiles")).toBeTruthy();
    expect(
      screen.getByText('resource.analysis.rootFilesMeta|{"files":1,"percent":"10.0%"}'),
    ).toBeTruthy();
    expect(
      screen.getByText('resource.analysis.skippedLinks|{"count":1}'),
    ).toBeTruthy();
    expect(screen.getByText("big.bin")).toBeTruthy();
    expect(screen.getByText("C:\\Temp\\alpha")).toBeTruthy();
  });

  it("点击子目录进入下一层，返回上一级来自后端 parent", async () => {
    render(<DiskSpaceAnalyzer defaultPath={"C:\\Temp"} />);
    fireEvent.click(screen.getByRole("button", { name: "resource.analysis.scan" }));
    const alpha = await screen.findByRole("button", { name: /analysisFolder.*alpha/ });

    mocks.analyze.mockResolvedValueOnce({
      ...REPORT,
      path: "C:\\Temp\\alpha",
      parent: "C:\\Temp",
      totalBytes: 600,
      folders: [],
      files: [],
    });
    fireEvent.click(alpha);
    await waitFor(() => expect(mocks.analyze).toHaveBeenLastCalledWith("C:\\Temp\\alpha"));

    const up = await screen.findByRole("button", { name: "resource.analysis.up" });
    fireEvent.click(up);
    await waitFor(() => expect(mocks.analyze).toHaveBeenLastCalledWith("C:\\Temp"));
  });

  it("选择文件夹后自动分析所选目录", async () => {
    mocks.openDialog.mockResolvedValue("D:\\Data");
    render(<DiskSpaceAnalyzer defaultPath={"C:\\"} />);
    fireEvent.click(screen.getByRole("button", { name: "resource.analysis.choose" }));
    await waitFor(() => expect(mocks.openDialog).toHaveBeenCalled());
    await waitFor(() => expect(mocks.analyze).toHaveBeenCalledWith("D:\\Data"));
  });

  it("截断与读取失败给出明确提示，未扫描目录不显示 0 B", async () => {
    mocks.analyze.mockResolvedValue({
      ...REPORT,
      truncated: true,
      skippedErrors: 2,
      folders: [
        REPORT.folders[0],
        { name: "gamma", path: "C:\\Temp\\gamma", bytes: null, files: null },
      ],
    });
    render(<DiskSpaceAnalyzer defaultPath={"C:\\"} />);
    fireEvent.click(screen.getByRole("button", { name: "resource.analysis.scan" }));
    expect(await screen.findByText("resource.analysis.truncated")).toBeTruthy();
    expect(
      screen.getByText('resource.analysis.skippedErrors|{"count":2}'),
    ).toBeTruthy();
    expect(screen.getByText("gamma")).toBeTruthy();
    expect(screen.getByText("resource.analysis.unscanned")).toBeTruthy();
    expect(screen.queryByText("0 B")).toBeNull();
  });

  it("扫描失败给出错误与重试入口", async () => {
    mocks.analyze.mockRejectedValueOnce(new Error("权限不足"));
    render(<DiskSpaceAnalyzer defaultPath={"C:\\"} />);
    fireEvent.click(screen.getByRole("button", { name: "resource.analysis.scan" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("resource.analysis.failed");
    expect(within(alert).getByRole("button", { name: "common.retry" })).toBeTruthy();
  });

  it("切换目录后旧报告立即作废，失败不残留旧路径数据", async () => {
    render(<DiskSpaceAnalyzer defaultPath={"C:\\"} />);
    fireEvent.click(screen.getByRole("button", { name: "resource.analysis.scan" }));
    expect(await screen.findByText("big.bin")).toBeTruthy();

    mocks.openDialog.mockResolvedValue("D:\\Data");
    mocks.analyze.mockRejectedValueOnce(new Error("权限不足"));
    mocks.analyze.mockResolvedValueOnce({
      ...REPORT,
      path: "D:\\Data",
      parent: "D:\\",
      folders: [],
      files: [],
      totalFiles: 1,
      totalDirs: 0,
    });
    fireEvent.click(screen.getByRole("button", { name: "resource.analysis.choose" }));
    await waitFor(() => expect(mocks.analyze).toHaveBeenLastCalledWith("D:\\Data"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("resource.analysis.failed");
    // 旧目录（C:\Temp）的报告不能挂在新路径下。
    expect(screen.queryByText("big.bin")).toBeNull();
    expect(screen.queryByText(/resource\.analysis\.summary/)).toBeNull();
    expect(screen.getByText("D:\\Data")).toBeTruthy();
    expect(alert.querySelector("[data-retry-path]")?.getAttribute("data-retry-path")).toBe(
      "D:\\Data",
    );

    // 重试目标就是真正失败的目录。
    fireEvent.click(within(alert).getByRole("button", { name: "common.retry" }));
    await waitFor(() => expect(mocks.analyze).toHaveBeenLastCalledWith("D:\\Data"));
    // 结果区显式绑定的就是本次扫描目录。
    expect(
      await screen.findByText("resource.analysis.resultTime", { exact: false }),
    ).toBeTruthy();
    expect(document.querySelector(".resource-analysis-scope-path")?.textContent).toBe(
      "D:\\Data",
    );
  });

  it("子目录扫描失败后重试仍指向失败目录，不退回旧路径", async () => {
    render(<DiskSpaceAnalyzer defaultPath={"C:\\Temp"} />);
    fireEvent.click(screen.getByRole("button", { name: "resource.analysis.scan" }));
    const alpha = await screen.findByRole("button", { name: /analysisFolder.*alpha/ });

    mocks.analyze.mockRejectedValueOnce(new Error("权限不足"));
    fireEvent.click(alpha);
    await waitFor(() => expect(mocks.analyze).toHaveBeenLastCalledWith("C:\\Temp\\alpha"));

    const alert = await screen.findByRole("alert");
    expect(alert.querySelector("[data-retry-path]")?.getAttribute("data-retry-path")).toBe(
      "C:\\Temp\\alpha",
    );
    // 失败后旧报告被清空，避免把 C:\Temp 的结果显示在当前目录下。
    expect(screen.queryByText(/resource\.analysis\.summary/)).toBeNull();

    mocks.analyze.mockResolvedValueOnce({
      ...REPORT,
      path: "C:\\Temp\\alpha",
      parent: "C:\\Temp",
      folders: [],
      files: [],
    });
    fireEvent.click(within(alert).getByRole("button", { name: "common.retry" }));
    await waitFor(() =>
      expect(mocks.analyze).toHaveBeenLastCalledWith("C:\\Temp\\alpha"),
    );
  });

  it("空目录显示空态而不是伪造数据", async () => {
    mocks.analyze.mockResolvedValue({
      ...REPORT,
      totalBytes: 0,
      totalFiles: 0,
      totalDirs: 0,
      rootFilesBytes: 0,
      rootFiles: 0,
      skippedLinks: 0,
      folders: [],
      files: [],
    });
    render(<DiskSpaceAnalyzer defaultPath={"C:\\"} />);
    fireEvent.click(screen.getByRole("button", { name: "resource.analysis.scan" }));
    expect(await screen.findByText("resource.analysis.empty")).toBeTruthy();
  });

  it("大文件可在资源管理器中显示", async () => {
    render(<DiskSpaceAnalyzer defaultPath={"C:\\Temp"} />);
    fireEvent.click(screen.getByRole("button", { name: "resource.analysis.scan" }));
    const revealButtons = await screen.findAllByRole("button", {
      name: "resource.analysis.reveal",
    });
    fireEvent.click(revealButtons[0]);
    await waitFor(() =>
      expect(mocks.reveal).toHaveBeenCalledWith("C:\\Temp\\alpha\\big.bin"),
    );
  });
});
