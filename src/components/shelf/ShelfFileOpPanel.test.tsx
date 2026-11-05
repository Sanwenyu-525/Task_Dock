// @vitest-environment jsdom
//! 文件操作内嵌面板：模式入口文案、目录分组、同名策略、单飞、逐项结果与卸载守卫。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ShelfItem, ShelfOpReport } from "../../lib/bridge";
import { useShelfStore } from "../../store/useShelfStore";
import ShelfFileOpPanel from "./ShelfFileOpPanel";

const api = vi.hoisted(() => ({
  shelfRecentDirs: vi.fn(),
  shelfRecentDirPin: vi.fn(),
  shelfRecentDirRemove: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...api };
});

const ui = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../../store/useUiStore", () => ({
  useUiStore: (select: (state: { showToast: unknown }) => unknown) =>
    select({ showToast: ui.showToast }),
}));

const dialog = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialog.open }));

const runFileOp = vi.fn<
  (
    op: "move" | "copy",
    ids: string[],
    targetDir: string,
    strategy: "skip" | "rename",
    removeAfter: boolean,
  ) => Promise<ShelfOpReport>
>();

function shelfItem(over: Partial<ShelfItem> = {}): ShelfItem {
  return {
    id: "i1",
    kind: "file",
    display_name: "a.txt",
    source_kind: "picker",
    storage_mode: "reference",
    original_path: "D:\\src\\a.txt",
    managed_path: null,
    content: null,
    byte_size: 100,
    file_ext: "txt",
    favorite: false,
    pinned: false,
    exists_state: "ok",
    group_id: null,
    scene_id: null,
    note: "",
    expire_at: null,
    created_at: "2026-11-05T00:00:00Z",
    updated_at: "2026-11-05T00:00:00Z",
    ...over,
  };
}

const referenceItem = () => shelfItem();
const managedItem = () =>
  shelfItem({
    id: "i2",
    display_name: "b.bin",
    storage_mode: "managed",
    original_path: null,
    managed_path: "D:\\managed\\b.bin",
  });

function dir(path: string, pinned = false, available = true) {
  return { path, pinned, last_used_at: "2026-11-05T00:00:00Z", available };
}

function report(over: Partial<ShelfOpReport> = {}): ShelfOpReport {
  return { success: 1, skipped: 0, failed: 0, removed: 0, remove_failed_files: 0, entries: [], ...over };
}

function renderPanel(op: "move" | "copy", items: ShelfItem[], excluded = 0) {
  const onClose = vi.fn();
  render(
    <ShelfFileOpPanel
      request={{ op, ids: items.map((i) => i.id), items, excluded }}
      onClose={onClose}
    />,
  );
  return { onClose };
}

const waitForDirs = () =>
  screen.findByRole("button", { name: "使用目标目录 D:\\Pinned" });

beforeEach(() => {
  api.shelfRecentDirs.mockReset().mockResolvedValue([
    dir("D:\\Pinned", true),
    dir("D:\\Recent"),
    dir("D:\\Gone", false, false),
  ]);
  api.shelfRecentDirPin.mockReset().mockResolvedValue(undefined);
  api.shelfRecentDirRemove.mockReset().mockResolvedValue(undefined);
  dialog.open.mockReset();
  ui.showToast.mockReset();
  runFileOp.mockReset().mockResolvedValue(report());
  useShelfStore.setState({ runFileOp });
});

afterEach(() => {
  cleanup();
});

describe("ShelfFileOpPanel 入口文案", () => {
  it("移动引用文件显示「移动原文件到…」", () => {
    renderPanel("move", [referenceItem()]);
    expect(screen.getByRole("region", { name: "移动原文件到…" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "移动原文件到…" })).toBeTruthy();
  });

  it("托管副本只显示「导出副本到…」", () => {
    renderPanel("copy", [managedItem()]);
    expect(screen.getByRole("region", { name: "导出副本到…" })).toBeTruthy();
  });

  it("引用与托管混合时区分为「复制 / 导出到…」并说明各自行为", async () => {
    renderPanel("copy", [referenceItem(), managedItem()]);
    expect(screen.getByRole("region", { name: "复制 / 导出到…" })).toBeTruthy();
    expect(
      screen.getByText(/所选含 1 项托管副本与 1 项引用文件/),
    ).toBeTruthy();
  });

  it("全部为引用文件时显示「复制到…」", () => {
    renderPanel("copy", [referenceItem()]);
    expect(screen.getByRole("region", { name: "复制到…" })).toBeTruthy();
  });

  it("展示被排除的条目数量", () => {
    renderPanel("move", [referenceItem()], 2);
    expect(screen.getByText("2 项因类型/存储模式/失效未参与")).toBeTruthy();
  });
});

describe("ShelfFileOpPanel 托管副本删除提示", () => {
  it("勾选移除记录时明确提示会删除托管副本", async () => {
    const user = userEvent.setup();
    renderPanel("copy", [managedItem()]);
    await waitForDirs();

    await user.click(
      screen.getByRole("checkbox", { name: "处理成功后从暂存架移除记录" }),
    );
    expect(screen.getByText(/会删除 Task Dock 拥有的托管副本/)).toBeTruthy();
  });

  it("未勾选时提示托管副本仍占用空间", async () => {
    renderPanel("copy", [managedItem()]);
    await waitForDirs();
    expect(screen.getByText("托管副本会保留在暂存架，继续占用托管空间。")).toBeTruthy();
  });

  it("移动后移除记录只说明删除暂存记录", async () => {
    const user = userEvent.setup();
    renderPanel("move", [referenceItem()]);
    await waitForDirs();
    await user.click(
      screen.getByRole("checkbox", { name: "处理成功后从暂存架移除记录" }),
    );
    expect(screen.getByText("移除的只是暂存记录；已移动到目标目录的文件不受影响。")).toBeTruthy();
  });
});

describe("ShelfFileOpPanel 最近目录与固定目录", () => {
  it("分组展示、不可用目录禁用，点击可切换目标目录", async () => {
    const user = userEvent.setup();
    renderPanel("copy", [referenceItem()]);
    await waitForDirs();

    expect(screen.getByText("固定目录")).toBeTruthy();
    expect(screen.getByText("最近目录（最多 8 个）")).toBeTruthy();

    const gone = screen.getByRole("button", { name: "使用目标目录 D:\\Gone" });
    expect((gone as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "使用目标目录 D:\\Recent" }));
    expect(
      screen
        .getByRole("button", { name: "使用目标目录 D:\\Recent" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("「清空最近」只移除未固定目录", async () => {
    const user = userEvent.setup();
    renderPanel("copy", [referenceItem()]);
    await waitForDirs();

    await user.click(
      screen.getByRole("button", { name: "清空最近目录（保留固定目录）" }),
    );
    await waitFor(() => expect(api.shelfRecentDirRemove).toHaveBeenCalledTimes(2));
    expect(api.shelfRecentDirRemove).not.toHaveBeenCalledWith("D:\\Pinned");
  });

  it("读取目录失败时只提示一次，不阻断面板", async () => {
    api.shelfRecentDirs.mockRejectedValueOnce(new Error("磁盘忙碌"));
    renderPanel("copy", [referenceItem()]);
    await waitFor(() =>
      expect(ui.showToast).toHaveBeenCalledWith("读取最近目录失败：磁盘忙碌", {
        kind: "error",
      }),
    );
    expect(screen.getByText("尚未选择")).toBeTruthy();
  });
});

describe("ShelfFileOpPanel 执行与结果", () => {
  it("执行使用所选目录、同名策略与移除选项", async () => {
    const user = userEvent.setup();
    renderPanel("copy", [referenceItem()]);
    await waitForDirs();

    await user.click(screen.getByRole("combobox", { name: "同名文件处理策略" }));
    await user.click(screen.getByRole("option", { name: /自动重命名/ }));
    await user.click(
      screen.getByRole("checkbox", { name: "处理成功后从暂存架移除记录" }),
    );
    await user.click(screen.getByRole("button", { name: "复制" }));

    expect(runFileOp).toHaveBeenCalledWith(
      "copy",
      ["i1"],
      "D:\\Pinned",
      "rename",
      true,
    );
  });

  it("同批次单飞：处理中再次点击不会重复提交", async () => {
    const user = userEvent.setup();
    let resolve!: (value: ShelfOpReport) => void;
    runFileOp.mockImplementation(
      () => new Promise<ShelfOpReport>((r) => { resolve = r; }),
    );
    renderPanel("copy", [referenceItem()]);
    await waitForDirs();

    const button = screen.getByRole("button", { name: "复制" });
    await user.click(button);
    expect(screen.getByRole("button", { name: /正在处理/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /正在处理/ }));
    fireEvent.click(screen.getByRole("button", { name: /正在处理/ }));
    expect(runFileOp).toHaveBeenCalledTimes(1);

    resolve(report({ entries: [] }));
    await waitFor(() => expect(screen.getByRole("button", { name: "复制" })).toBeTruthy());
  });

  it("部分完成：保留面板、只弹一条 Toast，并可查看失败与跳过原因", async () => {
    const user = userEvent.setup();
    runFileOp.mockResolvedValue(
      report({
        success: 1,
        skipped: 1,
        failed: 1,
        entries: [
          { id: "i1", display_name: "ok.txt", source: "D:\\src\\ok.txt", target: "D:\\Pinned\\ok.txt", status: "ok", reason: null },
          { id: "i2", display_name: "skip.txt", source: "D:\\src\\skip.txt", target: "D:\\Pinned\\skip.txt", status: "skipped", reason: "同名文件已存在" },
          { id: "i3", display_name: "fail.txt", source: "D:\\src\\fail.txt", target: null, status: "failed", reason: "目标目录不可写" },
        ],
      }),
    );
    const { onClose } = renderPanel("copy", [referenceItem()]);
    await waitForDirs();

    await user.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() =>
      expect(screen.getByText(/成功 1 项 · 跳过 1 项 · 失败 1 项/)).toBeTruthy(),
    );
    expect(ui.showToast).toHaveBeenCalledTimes(1);
    expect(ui.showToast.mock.calls[0][0]).toContain("失败/跳过项已保留在暂存架");
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "查看跳过项（1）" }));
    expect(screen.getByText("同名文件已存在")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "查看失败项（1）" }));
    expect(screen.getByText("目标目录不可写")).toBeTruthy();
  });

  it("全部失败：错误 Toast 并展示真实失败项", async () => {
    const user = userEvent.setup();
    runFileOp.mockResolvedValue(
      report({
        success: 0,
        failed: 2,
        entries: [
          { id: "i1", display_name: "a.txt", source: null, target: null, status: "failed", reason: "源文件已失效" },
          { id: "i2", display_name: "b.txt", source: null, target: null, status: "failed", reason: "权限不足" },
        ],
      }),
    );
    renderPanel("copy", [referenceItem()]);
    await waitForDirs();

    await user.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(ui.showToast).toHaveBeenCalledWith("全部 2 项失败，请查看失败原因", { kind: "error" }));
    await user.click(screen.getByRole("button", { name: "查看失败项（2）" }));
    expect(screen.getByText("源文件已失效")).toBeTruthy();
  });

  it("操作成功但托管清理失败：不误报全失败，保留结果并提示清理兜底", async () => {
    const user = userEvent.setup();
    runFileOp.mockResolvedValue(
      report({
        success: 2,
        removed: 2,
        remove_failed_files: 1,
        entries: [
          { id: "i1", display_name: "a.txt", source: null, target: null, status: "ok", reason: null },
          { id: "i2", display_name: "b.txt", source: null, target: null, status: "ok", reason: null },
        ],
      }),
    );
    const { onClose } = renderPanel("copy", [managedItem(), referenceItem()]);
    await waitForDirs();

    await user.click(screen.getByRole("button", { name: /复制 \/ 导出/ }));
    await waitFor(() => expect(ui.showToast).toHaveBeenCalledTimes(1));
    expect(ui.showToast.mock.calls[0][0]).toContain("成功 2 项");
    expect(ui.showToast.mock.calls[0][0]).toContain("1 个托管文件未能删除");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/1 个托管文件未能删除/)).toBeTruthy();
  });

  it("完全成功时关闭面板并只提示一次", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPanel("move", [referenceItem()]);
    await waitForDirs();
    await user.click(screen.getByRole("button", { name: "移动" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(ui.showToast).toHaveBeenCalledTimes(1);
    expect(ui.showToast.mock.calls[0][0]).toContain("已移动 1 项");
  });

  it("执行异常时展示面板错误且不重复提示", async () => {
    const user = userEvent.setup();
    runFileOp.mockRejectedValue(new Error("目标目录不可用"));
    renderPanel("copy", [referenceItem()]);
    await waitForDirs();

    await user.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("目标目录不可用"));
    expect(ui.showToast).toHaveBeenCalledTimes(1);
  });

  it("面板卸载后异步结果不更新状态、不弹 Toast", async () => {
    const user = userEvent.setup();
    let resolve!: (value: ShelfOpReport) => void;
    runFileOp.mockImplementation(
      () => new Promise<ShelfOpReport>((r) => { resolve = r; }),
    );
    const { onClose, unmount } = (() => {
      const rendered = renderPanel("copy", [referenceItem()]);
      return { ...rendered, unmount: () => cleanup() };
    })();
    await waitForDirs();
    await user.click(screen.getByRole("button", { name: "复制" }));
    unmount();

    resolve(report());
    await new Promise((r) => setTimeout(r, 0));

    expect(ui.showToast).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
