import { beforeEach, describe, expect, it, vi } from "vitest";

import { workspacePathCheck } from "./bridge";
import { checkWorkspacePath } from "./workspacePath";

vi.mock("./bridge", () => ({
  workspacePathCheck: vi.fn(),
}));

const mockedCheck = vi.mocked(workspacePathCheck);

describe("checkWorkspacePath", () => {
  beforeEach(() => {
    mockedCheck.mockReset();
  });

  it("空输入返回 empty 且不请求后端", async () => {
    await expect(checkWorkspacePath("   ")).resolves.toEqual({ status: "empty" });
    expect(mockedCheck).not.toHaveBeenCalled();
  });

  it("UNC 与 \\\\?\\ 扩展路径按 unc 拒绝，不再落到后端", async () => {
    for (const raw of ["\\\\server\\share\\proj", "//server/share/proj", "\\\\?\\C:\\proj"]) {
      await expect(checkWorkspacePath(raw)).resolves.toEqual({
        status: "invalid",
        reason: "unc",
      });
    }
    expect(mockedCheck).not.toHaveBeenCalled();
  });

  it("相对路径与盘符相对路径按 not-absolute 拒绝", async () => {
    for (const raw of ["docs/handoff", "C:proj"]) {
      await expect(checkWorkspacePath(raw)).resolves.toEqual({
        status: "invalid",
        reason: "not-absolute",
      });
    }
    expect(mockedCheck).not.toHaveBeenCalled();
  });

  it("非法字符在本地拦截", async () => {
    await expect(checkWorkspacePath("D:\\work\\a?b")).resolves.toEqual({
      status: "invalid",
      reason: "illegal-char",
    });
    expect(mockedCheck).not.toHaveBeenCalled();
  });

  it("合法盘符路径交给后端判定文件系统事实", async () => {
    mockedCheck.mockResolvedValue({ status: "offline", path: "D:\\work\\demo" });
    await expect(checkWorkspacePath("  D:\\work\\demo  ")).resolves.toEqual({
      status: "offline",
      path: "D:\\work\\demo",
    });
    expect(mockedCheck).toHaveBeenCalledWith("D:\\work\\demo");
  });

  it("后端返回 invalid/unc 时保留 unc 原因（不复用 not-absolute 文案）", async () => {
    mockedCheck.mockResolvedValue({ status: "invalid", reason: "unc" });
    await expect(checkWorkspacePath("D:\\work\\demo")).resolves.toEqual({
      status: "invalid",
      reason: "unc",
    });
  });
});
