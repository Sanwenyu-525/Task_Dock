// @vitest-environment jsdom
//! 固定列 / 抽屉互斥：同一窗口同一时间只能有一个工作篮面板实例。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("./TransferPanel", () => ({
  default: ({ variant }: { variant: string }) => <div data-testid="transfer-panel">{variant}</div>,
}));

import TransferDrawer from "./TransferDrawer";
import { useTransferStore } from "../../store/useTransferStore";

function setPanel(visible: boolean, mode: "dock" | "drawer") {
  useTransferStore.setState({
    panel: { visible, pinned: true, width: 320, suggestionsEnabled: true },
    panelMode: mode,
  });
}

afterEach(() => cleanup());
beforeEach(() => {
  localStorage.clear();
});

describe("TransferDrawer", () => {
  it("抽屉形态且可见时渲染工作篮", () => {
    setPanel(true, "drawer");
    render(<TransferDrawer host="workbench" />);
    expect(screen.getByTestId("transfer-panel").textContent).toBe("drawer");
  });

  it("固定列形态下不渲染抽屉（避免两个实例）", () => {
    setPanel(true, "dock");
    render(<TransferDrawer host="workbench" />);
    expect(screen.queryByTestId("transfer-panel")).toBeNull();
  });

  it("面板关闭时不渲染", () => {
    setPanel(false, "drawer");
    render(<TransferDrawer host="workbench" />);
    expect(screen.queryByTestId("transfer-panel")).toBeNull();
  });

  it("主窗口始终使用抽屉，即使面板仍记为固定", () => {
    setPanel(true, "dock");
    render(<TransferDrawer host="main" />);
    expect(screen.getByTestId("transfer-panel").textContent).toBe("drawer");
    // 主窗口会把形态收敛为 drawer，不留 dock 状态。
    expect(useTransferStore.getState().panelMode).toBe("drawer");
  });
});
