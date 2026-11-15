/**
 * @vitest-environment jsdom
 */
//! 原生文件夹选择器测试（第三轮 P0：必须走 Windows 系统对话框，且取消/失败不改变现状）。
//!
//! `@tauri-apps/plugin-dialog` 与 `fs_stat` 都是外部边界，这里 mock 掉：
//! 覆盖 ok / cancelled（用户取消）/ notFound / notDir / unreadable / 插件抛错 六条路径。

import { beforeEach, describe, expect, it, vi } from "vitest";

const dialogMock = vi.hoisted(() => ({ open: vi.fn() }));
const bridgeMock = vi.hoisted(() => ({ fsStat: vi.fn() }));

vi.mock("@tauri-apps/plugin-dialog", () => dialogMock);
vi.mock("../bridge", () => bridgeMock);

import { pickFolder, validateFolderPath } from "./folderPicker";

beforeEach(() => {
  dialogMock.open.mockReset();
  bridgeMock.fsStat.mockReset();
});

describe("pickFolder（系统文件夹选择器）", () => {
  it("选中目录且可读 → ok，路径规范化", async () => {
    dialogMock.open.mockResolvedValue("D:\\Projects\\MyGame");
    bridgeMock.fsStat.mockResolvedValue([
      { path: "D:\\Projects\\MyGame", exists: true, kind: "dir", size: null, createdMs: null, modifiedMs: null, readonly: false, hidden: false, childCount: 2, childTruncated: false },
    ]);
    await expect(pickFolder()).resolves.toEqual({ status: "ok", path: "D:\\Projects\\MyGame" });
    expect(dialogMock.open).toHaveBeenCalledWith(
      expect.objectContaining({ directory: true, multiple: false }),
    );
  });

  it("用户取消（返回 null）→ cancelled（调用方不得修改标签/布局）", async () => {
    dialogMock.open.mockResolvedValue(null);
    await expect(pickFolder()).resolves.toEqual({ status: "cancelled" });
    expect(bridgeMock.fsStat).not.toHaveBeenCalled();
  });

  it("目录在选择后被删除 → invalid/notFound，附带路径", async () => {
    dialogMock.open.mockResolvedValue("D:\\gone");
    bridgeMock.fsStat.mockResolvedValue([
      { path: "D:\\gone", exists: false, kind: "missing", size: null, createdMs: null, modifiedMs: null, readonly: false, hidden: false, childCount: null, childTruncated: false },
    ]);
    await expect(pickFolder()).resolves.toEqual({ status: "invalid", reason: "notFound", path: "D:\\gone" });
  });

  it("选中的是文件 → invalid/notDir", async () => {
    dialogMock.open.mockResolvedValue("D:\\file.txt");
    bridgeMock.fsStat.mockResolvedValue([
      { path: "D:\\file.txt", exists: true, kind: "file", size: 1, createdMs: null, modifiedMs: null, readonly: false, hidden: false, childCount: null, childTruncated: false },
    ]);
    await expect(pickFolder()).resolves.toEqual({ status: "invalid", reason: "notDir", path: "D:\\file.txt" });
  });

  it("权限不足 / 网络盘不可达 → invalid/unreadable，带错误原因（不留空白页面）", async () => {
    dialogMock.open.mockResolvedValue("Z:\\remote");
    bridgeMock.fsStat.mockRejectedValue(new Error("access denied"));
    const result = await pickFolder();
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.reason).toBe("unreadable");
      expect(result.message).toContain("access denied");
    }
  });

  it("插件自身抛错（非 Tauri 环境）→ invalid/error，调用方保持现状", async () => {
    dialogMock.open.mockRejectedValue(new Error("dialog unavailable"));
    const result = await pickFolder();
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") expect(result.reason).toBe("error");
  });
});

describe("validateFolderPath（手输路径同样的校验语义）", () => {
  it("空路径 → notFound", async () => {
    await expect(validateFolderPath("   ")).resolves.toEqual({ status: "invalid", reason: "notFound", path: "" });
  });

  it("可读目录 → ok", async () => {
    bridgeMock.fsStat.mockResolvedValue([
      { path: "D:\\ok", exists: true, kind: "dir", size: null, createdMs: null, modifiedMs: null, readonly: false, hidden: false, childCount: 0, childTruncated: false },
    ]);
    await expect(validateFolderPath("D:\\ok")).resolves.toEqual({ status: "ok", path: "D:\\ok" });
  });
});
