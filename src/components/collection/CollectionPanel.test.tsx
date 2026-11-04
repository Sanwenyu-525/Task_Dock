/**
 * @vitest-environment jsdom
 */
//! CollectionPanel 合并入口行为测试（jsdom）：
//! - 双子页签切换渲染对应子页面，且**同一时刻只挂载一个**（切换卸载另一个）；
//! - 子页选择来自 useUiStore.collectionSub（setTab 幂等映射）；
//! - 点击子页签 = setTab 对应逻辑 Tab（快捷键与旧调用方语义一致）。
//! 两个子页面 mock，业务测试分别在各自文件与 store 测试中覆盖。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import userEvent from "@testing-library/user-event";

vi.mock("../inbox/CaptureInboxPanel", () => ({ default: () => <div>inbox-panel</div> }));
vi.mock("../shelf/ShelfPanel", () => ({ default: () => <div>shelf-panel</div> }));

import CollectionPanel from "./CollectionPanel";
import { useUiStore } from "../../store/useUiStore";

afterEach(cleanup);

beforeEach(() => {
  useUiStore.setState({ tab: "inbox", collectionSub: "inbox" });
});

describe("CollectionPanel", () => {
  it("默认显示快速收集子页，页签 aria-selected 正确", () => {
    render(<CollectionPanel />);
    expect(screen.getByText("inbox-panel")).toBeTruthy();
    expect(screen.queryByText("shelf-panel")).toBeNull();
    expect(screen.getByRole("tab", { name: "快速收集" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "文件暂存" }).getAttribute("aria-selected")).toBe("false");
  });

  it("切到文件暂存：卸载收集箱、渲染暂存架，同步 tab 逻辑位", async () => {
    const user = userEvent.setup();
    render(<CollectionPanel />);
    await user.click(screen.getByRole("tab", { name: "文件暂存" }));
    expect(screen.getByText("shelf-panel")).toBeTruthy();
    expect(screen.queryByText("inbox-panel")).toBeNull();
    expect(useUiStore.getState().tab).toBe("shelf");
    expect(useUiStore.getState().collectionSub).toBe("shelf");
    expect(screen.getByRole("tab", { name: "文件暂存" }).getAttribute("aria-selected")).toBe("true");
  });

  it("setTab(inbox)（如 Ctrl+5 或旧调用方）驱动子页回到快速收集", () => {
    useUiStore.setState({ tab: "shelf", collectionSub: "shelf" });
    render(<CollectionPanel />);
    expect(screen.getByText("shelf-panel")).toBeTruthy();
    act(() => {
      useUiStore.getState().setTab("inbox");
    });
    // collectionSub 由 setTab 幂等同步 → 重渲染为收集箱
    expect(screen.getByText("inbox-panel")).toBeTruthy();
  });
});
