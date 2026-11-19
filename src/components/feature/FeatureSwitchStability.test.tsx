// @vitest-environment jsdom
//! 连续切页稳定性：30 次切换后不重复加载、不重复初始化、状态按策略保留。
//!
//! 这是「按需加载不能变成重复加载」的回归闸门：真实运行时指标（内存/句柄/Worker）
//! 需要真机采样，jsdom 只能证明**代码与实例**层面的不变量：
//! - 每个页面代码只 import 一次（loadExecutions === 1）；
//! - 同时只有一个页面处于 active；
//! - keep 页面保留输入内容，release 页面离开即卸载（再次进入重建）；
//! - 事件环形缓冲有上限（不会随切页无限增长）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import FeatureView from "./FeatureView";
import {
  __resetFeatureRuntimeForTests,
  getFeatureRuntimeSummary,
  getFeatureSnapshot,
  isFeatureLoaded,
  listFeatureEvents,
  registerFeature,
} from "../../lib/featureRuntime";

const PAGE_IDS = ["a", "b", "c", "d", "e"] as const;
type PageId = (typeof PAGE_IDS)[number];

function DraftPage() {
  const [value, setValue] = useState("");
  return (
    <input
      aria-label="draft"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}

function Shell({ initial }: { initial: PageId }) {
  const [tab, setTab] = useState<PageId>(initial);
  return (
    <div>
      {PAGE_IDS.map((id) => (
        <button key={id} type="button" onClick={() => setTab(id)}>
          {`go-${id}`}
        </button>
      ))}
      {PAGE_IDS.map((id) => (
        <FeatureView
          key={id}
          id={`test:page-${id}`}
          active={tab === id}
          label={id}
          instance={id === "e" ? "release" : "keep"}
        >
          {(Panel) => <Panel />}
        </FeatureView>
      ))}
    </div>
  );
}

describe("连续 30 次切页", () => {
  beforeEach(() => {
    __resetFeatureRuntimeForTests();
    const loaders = new Map<string, ReturnType<typeof vi.fn>>();
    for (const id of PAGE_IDS) {
      const load = vi.fn(async () => ({ default: DraftPage }));
      loaders.set(id, load);
      registerFeature({
        id: `test:page-${id}`,
        label: `页面 ${id}`,
        instance: id === "e" ? "release" : "keep",
        load,
      });
    }
    // 供断言读取：每个页面的 loader 调用次数（应恒为 1）。
    (globalThis as Record<string, unknown>).__loaders = loaders;
  });

  afterEach(() => {
    cleanup();
  });

  it("不重复加载、只保留一个活动页、保活页状态不丢", async () => {
    const loaders = (globalThis as Record<string, unknown>).__loaders as Map<
      string,
      ReturnType<typeof vi.fn>
    >;

    render(<Shell initial="a" />);
    const input = (await screen.findByLabelText("draft")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "未保存草稿" } });

    // 30 次切换：a→b→c→d→e→a … 覆盖 keep 与 release 两种策略。
    for (let step = 0; step < 30; step += 1) {
      const next = PAGE_IDS[step % PAGE_IDS.length];
      fireEvent.click(screen.getByText(`go-${next}`));
    }

    // 回到 a：keep 策略下输入内容仍在。
    fireEvent.click(screen.getByText("go-a"));
    expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("未保存草稿");

    for (const id of PAGE_IDS) {
      const snapshot = getFeatureSnapshot(`test:page-${id}`);
      expect(snapshot?.loadExecutions, `页面 ${id} 被重复 import`).toBe(1);
      expect(loaders.get(id)?.mock.calls.length, `页面 ${id} 的 loader 被重复调用`).toBe(1);
      // 代码缓存在 Promise 兑现后写入：等最后一轮的 import 落地。
      await waitFor(() => expect(isFeatureLoaded(`test:page-${id}`)).toBe(true));
    }

    // 同时只有一个活动页：keep 页面虽然挂载，但状态是 inactive。
    await waitFor(() => expect(getFeatureRuntimeSummary().active).toBe(1));
    const summary = getFeatureRuntimeSummary();
    expect(summary.loaded).toBe(PAGE_IDS.length);
    expect(summary.loadFailures).toBe(0);
    // 事件缓冲有上限，不会随切页无限增长。
    expect(listFeatureEvents().length).toBeLessThanOrEqual(40);
  });
});
