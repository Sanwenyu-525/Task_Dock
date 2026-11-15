//! 页面级详情栏共享契约的回归测试（2026-11-15）。
//!
//! 这四条是「右栏」最容易回归的边界，任何一条失效都会直接变成用户可见的问题：
//! 1. 右栏关闭/窄窗降级时不渲染（不能把详情漏在主内容区）；
//! 2. 页面可见时详情挂到外壳宿主，且主内容区不出现重复副本；
//! 3. 被保活的隐藏页面不投送（切页后右栏不能残留上一页的详情）；
//! 4. 事实表只渲染有值的行（不伪造「—」占位字段）。

import { render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { WorkbenchPageActiveContext } from "../lib/windowHost";
import {
  WorkbenchDetailFacts,
  WorkbenchDetailHostProvider,
  WorkbenchPageDetail,
} from "./pageDetail";

function Harness({
  active,
  withHost = true,
  children,
}: {
  active: boolean | null;
  withHost?: boolean;
  children: ReactNode;
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <WorkbenchDetailHostProvider host={withHost ? host : null}>
      {withHost ? <div data-testid="detail-host" ref={setHost} /> : null}
      <WorkbenchPageActiveContext.Provider value={active}>
        <div data-testid="page-body">{children}</div>
      </WorkbenchPageActiveContext.Provider>
    </WorkbenchDetailHostProvider>
  );
}

describe("WorkbenchPageDetail", () => {
  it("右栏不可用（关闭 / 窄窗降级）时不渲染任何节点", () => {
    render(
      <Harness active withHost={false}>
        <WorkbenchPageDetail title="任务详情">内容</WorkbenchPageDetail>
      </Harness>,
    );
    expect(screen.queryByText("任务详情")).toBeNull();
    expect(screen.queryByText("内容")).toBeNull();
  });

  it("页面可见时详情投送到宿主，主内容区不出现重复副本", () => {
    render(
      <Harness active>
        <WorkbenchPageDetail title="任务详情">内容</WorkbenchPageDetail>
      </Harness>,
    );
    const host = screen.getByTestId("detail-host");
    expect(host.textContent).toContain("任务详情");
    expect(host.textContent).toContain("内容");
    // 页面容器里没有第二份详情（避免「内容区 + 右栏」双份挂载）
    expect(screen.getByTestId("page-body").textContent).toBe("");
  });

  it("隐藏的保活页面不投送：切换路由后右栏不残留上一页详情", () => {
    const { rerender } = render(
      <Harness active>
        <WorkbenchPageDetail title="任务详情">旧详情</WorkbenchPageDetail>
      </Harness>,
    );
    expect(screen.getByTestId("detail-host").textContent).toContain("旧详情");
    rerender(
      <Harness active={false}>
        <WorkbenchPageDetail title="任务详情">旧详情</WorkbenchPageDetail>
      </Harness>,
    );
    expect(screen.getByTestId("detail-host").textContent).toBe("");
  });

  it("不在工作台内（active=null）也照常投送，胶囊/主窗口复用不受影响", () => {
    // active=null 表示「不属于工作台页面槽位」；此时是否有右栏只由宿主决定。
    render(
      <Harness active={null}>
        <WorkbenchPageDetail title="任务详情">内容</WorkbenchPageDetail>
      </Harness>,
    );
    expect(screen.getByTestId("detail-host").textContent).toContain("内容");
  });
});

describe("WorkbenchDetailFacts", () => {
  it("只渲染有值的行，缺数据不补空占位", () => {
    render(
      <WorkbenchDetailFacts
        rows={[
          { label: "优先级", value: "高" },
          null,
          false,
          { label: "截止", value: "明天" },
        ]}
      />,
    );
    expect(screen.getByText("优先级")).toBeTruthy();
    expect(screen.getByText("截止")).toBeTruthy();
    expect(screen.queryByText("null")).toBeNull();
  });

  it("全部为空时不渲染空列表容器", () => {
    const { container } = render(<WorkbenchDetailFacts rows={[null, false]} />);
    expect(container.querySelector(".wb-detail-facts")).toBeNull();
  });
});
