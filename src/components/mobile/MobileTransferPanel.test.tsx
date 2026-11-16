/**
 * @vitest-environment jsdom
 */
//! 手机互传页面级分区：文件互传 / 屏幕控制两个 pane 的挂载、切换与键盘导航。
//!
//! 子面板各自的数据加载由 VirtualDisplaySection.test.tsx 覆盖；这里只断言
//! 页面信息架构与「切换不保留旧 pane、重新进入重新挂载」的行为。

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const mounts = vi.hoisted(() => ({ screen: 0, files: 0 }));

vi.mock("../settings/MobileSyncSection", () => ({
  default: () => {
    mounts.files += 1;
    return <div>文件互传内容</div>;
  },
}));

vi.mock("./VirtualDisplaySection", () => ({
  default: () => {
    mounts.screen += 1;
    return <div>屏幕控制面板</div>;
  },
}));

import MobileTransferPanel from "./MobileTransferPanel";

afterEach(() => {
  cleanup();
  mounts.screen = 0;
  mounts.files = 0;
});

describe("MobileTransferPanel", () => {
  it("默认进入文件互传，屏幕控制不挂载", () => {
    render(<MobileTransferPanel />);

    expect(screen.getByText("文件互传内容")).toBeTruthy();
    expect(screen.queryByText("屏幕控制面板")).toBeNull();
    expect(screen.getByRole("tab", { name: /文件互传/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(mounts.files).toBe(1);
    expect(mounts.screen).toBe(0);
  });

  it("切换到屏幕控制只挂载当前 pane，切回后重新挂载", async () => {
    const user = userEvent.setup();
    render(<MobileTransferPanel />);

    await user.click(screen.getByRole("tab", { name: /屏幕控制/ }));
    expect(screen.getByText("屏幕控制面板")).toBeTruthy();
    expect(screen.queryByText("文件互传内容")).toBeNull();
    expect(mounts.screen).toBe(1);

    await user.click(screen.getByRole("tab", { name: /文件互传/ }));
    expect(screen.getByText("文件互传内容")).toBeTruthy();
    expect(screen.queryByText("屏幕控制面板")).toBeNull();
    expect(mounts.screen).toBe(1);

    await user.click(screen.getByRole("tab", { name: /屏幕控制/ }));
    expect(screen.getByText("屏幕控制面板")).toBeTruthy();
    expect(mounts.screen).toBe(2);
  });

  it("支持左右方向键在两个功能区之间移动", async () => {
    const user = userEvent.setup();
    render(<MobileTransferPanel />);

    const filesTab = screen.getByRole("tab", { name: /文件互传/ });
    filesTab.focus();
    await user.keyboard("{ArrowRight}");

    expect(screen.getByText("屏幕控制面板")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /屏幕控制/ }).getAttribute("aria-selected")).toBe(
      "true",
    );

    await user.keyboard("{ArrowLeft}");
    expect(screen.getByText("文件互传内容")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /文件互传/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });
});
