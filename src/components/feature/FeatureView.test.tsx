// @vitest-environment jsdom
//! 页面按需加载视图：加载占位、失败重试、二次进入复用缓存、实例保活/释放。
//!
//! 与 `featureRuntime.test.ts` 分工：那边验证状态机与指标，这边验证「用户看到的
//! 行为」——尤其是 React.lazy 无法做到的「失败后真的能重试」。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FeatureView from "./FeatureView";
import {
  __resetFeatureRuntimeForTests,
  getFeatureSnapshot,
  registerFeature,
  type FeatureInstancePolicy,
} from "../../lib/featureRuntime";

function Hello() {
  return <div>PAGE_CONTENT</div>;
}

function renderView(options: {
  id: string;
  active?: boolean;
  instance?: FeatureInstancePolicy;
}) {
  return render(
    <FeatureView
      id={options.id}
      active={options.active ?? true}
      label="测试页"
      instance={options.instance}
    >
      {(Panel) => <Panel />}
    </FeatureView>,
  );
}

describe("FeatureView", () => {
  beforeEach(() => {
    __resetFeatureRuntimeForTests();
  });

  afterEach(() => {
    cleanup();
  });

  it("首次进入显示加载占位，代码就绪后渲染页面", async () => {
    registerFeature({
      id: "test:view",
      label: "测试页",
      load: async () => ({ default: Hello }),
    });

    renderView({ id: "test:view" });
    // 本地 chunk 通常很快，但加载态必须在代码就绪前存在。
    expect(screen.getByRole("status")).toBeTruthy();
    expect(await screen.findByText("PAGE_CONTENT")).toBeTruthy();
    expect(getFeatureSnapshot("test:view")?.state).toBe("active");
  });

  it("加载失败给出原因与重试，重试后成功", async () => {
    let attempts = 0;
    registerFeature({
      id: "test:retry-view",
      label: "测试页",
      load: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("chunk 读取失败");
        return { default: Hello };
      },
    });

    renderView({ id: "test:retry-view" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("chunk 读取失败");

    await userEvent.click(screen.getByRole("button"));
    expect(await screen.findByText("PAGE_CONTENT")).toBeTruthy();
    expect(attempts).toBe(2);
  });

  it("加载途中切页不把旧页占位留在新页，再进入复用在途请求", async () => {
    let resolve!: (module: { default: typeof Hello }) => void;
    const load = vi.fn(() => new Promise<{ default: typeof Hello }>((done) => {
      resolve = done;
    }));
    registerFeature({ id: "test:pending", label: "测试页", load });
    const view = renderView({ id: "test:pending" });
    expect(screen.getByRole("status")).toBeTruthy();
    view.rerender(
      <FeatureView id="test:pending" active={false} label="测试页">
        {(Panel) => <Panel />}
      </FeatureView>,
    );
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => { resolve({ default: Hello }); });
    view.rerender(
      <FeatureView id="test:pending" active label="测试页">
        {(Panel) => <Panel />}
      </FeatureView>,
    );
    expect(await screen.findByText("PAGE_CONTENT")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("二次进入复用已加载代码：不再出现加载占位，也不重复 import", async () => {
    const load = vi.fn(async () => ({ default: Hello }));
    registerFeature({ id: "test:cache", label: "测试页", load });

    const first = renderView({ id: "test:cache" });
    await screen.findByText("PAGE_CONTENT");
    first.unmount();

    renderView({ id: "test:cache" });
    // 初始化即 ready：首帧就是内容，没有 loading 角色。
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("PAGE_CONTENT")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keep 策略：离开页面后实例保活（草稿/滚动位置不丢）", async () => {
    registerFeature({
      id: "test:keep",
      label: "测试页",
      instance: "keep",
      load: async () => ({ default: Hello }),
    });
    const view = renderView({ id: "test:keep" });
    await screen.findByText("PAGE_CONTENT");

    view.rerender(
      <FeatureView id="test:keep" active={false} label="测试页">
        {(Panel) => <Panel />}
      </FeatureView>,
    );
    expect(screen.getByText("PAGE_CONTENT")).toBeTruthy();
    expect(getFeatureSnapshot("test:keep")?.state).toBe("inactive");
  });

  it("release 策略：离开即卸载实例并记一次释放，再进入立即恢复", async () => {
    const load = vi.fn(async () => ({ default: Hello }));
    registerFeature({
      id: "test:release",
      label: "测试页",
      instance: "release",
      load,
    });
    const view = renderView({ id: "test:release" });
    await screen.findByText("PAGE_CONTENT");

    view.rerender(
      <FeatureView id="test:release" active={false} label="测试页">
        {(Panel) => <Panel />}
      </FeatureView>,
    );
    expect(screen.queryByText("PAGE_CONTENT")).toBeNull();
    expect(getFeatureSnapshot("test:release")?.instanceReleases).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);

    view.rerender(
      <FeatureView id="test:release" active label="测试页">
        {(Panel) => <Panel />}
      </FeatureView>,
    );
    expect(screen.getByText("PAGE_CONTENT")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
