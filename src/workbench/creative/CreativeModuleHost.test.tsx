/**
 * @vitest-environment jsdom
 */
//! 专业模块挂载点契约测试（2026-11-16，创作工作台五线）。
//!
//! 锁两件事：
//! 1. 注册表里没有实现时必须**诚实降级**（显示「未接入」而不是空白页/假数据）；
//! 2. 有实现时 props 必须完整透传（projectId / kind / archived 等），
//!    否则专业模块会自己去查项目，破坏项目隔离约定。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

afterEach(cleanup);

vi.mock("./moduleRegistry", () => ({
  resolveCreativeModule: (kind: string, moduleId: string) => {
    if (kind === "novel" && moduleId === "characters") {
      return function FakeCharacters(props: Record<string, unknown>) {
        return (
          <div data-testid="fake-characters" data-archived={String(props.archived)}>
            {String(props.projectId)}|{String(props.kind)}
          </div>
        );
      };
    }
    return undefined;
  },
}));

import CreativeModuleHost from "./CreativeModuleHost";
import { CREATIVE_MODULE_PENDING_TEXT } from "./types";

const baseProps = {
  projectId: "proj-1",
  projectName: "测试项目",
  archived: false,
  rootPath: "D:\\proj",
  rootExists: true,
  devProjectId: null,
  onNotice: () => {},
  switchModule: () => {},
};

describe("CreativeModuleHost", () => {
  it("注册表没有实现时显示「未接入」降级，不渲染空白页", () => {
    const { container } = render(
      <CreativeModuleHost moduleId="worldview" kind="novel" {...baseProps} />,
    );
    expect(container.textContent).toContain(CREATIVE_MODULE_PENDING_TEXT);
    // 降级态必须带状态徽标，用户能看出是未接入而不是加载失败
    expect(container.querySelector('[role="status"]')).toBeTruthy();
  });

  it("有实现时把项目上下文完整透传（不叠加二次项目查询）", () => {
    const { getByTestId } = render(
      <CreativeModuleHost moduleId="characters" kind="novel" {...baseProps} />,
    );
    const node = getByTestId("fake-characters");
    expect(node.textContent).toBe("proj-1|novel");
    expect(node.getAttribute("data-archived")).toBe("false");
  });

  it("归档项目把 archived=true 传给专业模块（供其置灰写入口）", () => {
    const { getByTestId } = render(
      <CreativeModuleHost moduleId="characters" kind="novel" {...baseProps} archived />,
    );
    expect(getByTestId("fake-characters").getAttribute("data-archived")).toBe("true");
  });

  it("同 ID 在别的类型下不串用实现（类型分桶隔离）", () => {
    const { container } = render(
      <CreativeModuleHost moduleId="characters" kind="ai_comic" {...baseProps} />,
    );
    expect(container.textContent).toContain(CREATIVE_MODULE_PENDING_TEXT);
    expect(container.querySelector('[data-testid="fake-characters"]')).toBeNull();
  });
});
