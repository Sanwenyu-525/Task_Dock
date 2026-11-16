/**
 * @vitest-environment jsdom
 */
//! 小说「正文」模块（B1 第二轮）：串行保存、离开前落盘、归档只读。
//! 只 mock 桥接层，不 mock React/DOM；用 deferred Promise 模拟真实请求竞争。

import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  novelVolumeList: vi.fn(),
  novelVolumeSave: vi.fn(),
  novelVolumeDelete: vi.fn(),
  novelChapterList: vi.fn(),
  novelChapterGet: vi.fn(),
  novelChapterSave: vi.fn(),
  novelChapterSaveContent: vi.fn(),
  novelChapterDelete: vi.fn(),
}));

vi.mock("../lib/bridge", () => api);

import NovelManuscriptPanel from "./NovelManuscriptPanel";

const volume = {
  id: "v1",
  projectId: "p1",
  title: "第一卷",
  sortOrder: 0,
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};

const chapter = {
  id: "c1",
  projectId: "p1",
  volumeId: "v1",
  title: "第一章",
  wordCount: 4,
  sortOrder: 0,
  createdAt: "2026-11-16T09:00:00+00:00",
  updatedAt: "2026-11-16T09:00:00+00:00",
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function saveResult(id: string, content: string) {
  return {
    chapter: { ...chapter, id, content, wordCount: content.replace(/\s/g, "").length },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.novelVolumeList.mockResolvedValue({ volumes: [volume] });
  api.novelChapterList.mockResolvedValue({ chapters: [chapter] });
  api.novelChapterGet.mockResolvedValue({ chapter: { ...chapter, content: "初稿内容" } });
  api.novelChapterSaveContent.mockImplementation(async (id: string, content: string) =>
    saveResult(id, content),
  );
  api.novelChapterDelete.mockResolvedValue(undefined);
  api.novelVolumeDelete.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

function renderPanel(options?: {
  archived?: boolean;
  projectId?: string;
  onNotice?: ReturnType<typeof vi.fn>;
}) {
  const onNotice = options?.onNotice ?? vi.fn();
  const flushRef: { current: (() => Promise<boolean>) | null } = { current: null };
  const view = render(
    <NovelManuscriptPanel
      projectId={options?.projectId ?? "p1"}
      archived={options?.archived ?? false}
      onNotice={onNotice}
      registerFlush={(flush) => {
        flushRef.current = flush;
      }}
    />,
  );
  return { onNotice, flushRef, view };
}

async function getPanel(flushRef: { current: (() => Promise<boolean>) | null }) {
  await screen.findByText("第一卷");
  const textarea = (await screen.findByLabelText("第一章正文")) as HTMLTextAreaElement;
  await waitFor(() => expect(flushRef.current).not.toBeNull());
  return textarea;
}

describe("NovelManuscriptPanel · 串行保存", () => {
  it("保存中继续输入：同一时刻只有一个请求，完成后自动补交最新正文", async () => {
    const calls: Array<{ id: string; content: string; deferred: Deferred<ReturnType<typeof saveResult>> }> =
      [];
    api.novelChapterSaveContent.mockImplementation(
      (id: string, content: string) => {
        const d = deferred<ReturnType<typeof saveResult>>();
        calls.push({ id, content, deferred: d });
        return d.promise;
      },
    );
    const { flushRef } = renderPanel();
    const textarea = await getPanel(flushRef);

    fireEvent.change(textarea, { target: { value: "版本A" } });
    expect(screen.getByText("待保存")).toBeTruthy();
    await act(async () => {
      void flushRef.current?.();
    });
    expect(calls.map((c) => c.content)).toEqual(["版本A"]);
    expect(screen.getByText("保存中…")).toBeTruthy();

    // A 在途时继续输入 B，并再次请求落盘；不得并发发出 B。
    fireEvent.change(textarea, { target: { value: "版本B" } });
    await act(async () => {
      void flushRef.current?.();
    });
    expect(calls.map((c) => c.content)).toEqual(["版本A"]);

    await act(async () => {
      calls[0].deferred.resolve(saveResult("c1", "版本A"));
      await Promise.resolve();
    });
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1].content).toBe("版本B");

    await act(async () => {
      calls[1].deferred.resolve(saveResult("c1", "版本B"));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText("已自动保存")).toBeTruthy());
    expect(textarea.value).toBe("版本B");
    expect(screen.getByText(/本章 3 字/)).toBeTruthy();
  });

  it("连续输入只补交最后一版，不为每个中间版本发请求", async () => {
    const calls: Array<{ content: string; deferred: Deferred<ReturnType<typeof saveResult>> }> = [];
    api.novelChapterSaveContent.mockImplementation((_id: string, content: string) => {
      const d = deferred<ReturnType<typeof saveResult>>();
      calls.push({ content, deferred: d });
      return d.promise;
    });
    const { flushRef } = renderPanel();
    const textarea = await getPanel(flushRef);

    fireEvent.change(textarea, { target: { value: "第一版" } });
    await act(async () => {
      void flushRef.current?.();
    });
    expect(calls.map((c) => c.content)).toEqual(["第一版"]);

    fireEvent.change(textarea, { target: { value: "中间版" } });
    fireEvent.change(textarea, { target: { value: "最终版" } });
    await act(async () => {
      void flushRef.current?.();
    });
    expect(calls.map((c) => c.content)).toEqual(["第一版"]);

    await act(async () => {
      calls[0].deferred.resolve(saveResult("c1", "第一版"));
      await Promise.resolve();
    });
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1].content).toBe("最终版");

    await act(async () => {
      calls[1].deferred.resolve(saveResult("c1", "最终版"));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText("已自动保存")).toBeTruthy());
    expect(textarea.value).toBe("最终版");
  });

  it("保存失败后保留草稿，重试成功才允许切换章节", async () => {
    const second = { ...chapter, id: "c2", title: "第二章", sortOrder: 1 };
    api.novelChapterList.mockResolvedValue({ chapters: [chapter, second] });
    api.novelChapterGet.mockImplementation(async (id: string) => ({
      chapter: id === "c2" ? { ...second, content: "第二章正文" } : { ...chapter, content: "初稿内容" },
    }));
    api.novelChapterSaveContent
      .mockRejectedValueOnce(new Error("磁盘只读"))
      .mockImplementation(async (id: string, content: string) => saveResult(id, content));

    const { flushRef, onNotice } = renderPanel();
    const textarea = await getPanel(flushRef);
    fireEvent.change(textarea, { target: { value: "未保存草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "第二章" }));
    await waitFor(() => expect(api.novelChapterSaveContent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("error", expect.stringContaining("正文保存失败")));
    expect(api.novelChapterGet).not.toHaveBeenCalledWith("c2");
    expect(textarea.value).toBe("未保存草稿");
    expect(screen.getByText("保存失败，可重试")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "重试保存" }));
    await waitFor(() => expect(api.novelChapterSaveContent).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText("已自动保存")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "第二章" }));
    await waitFor(() => expect(api.novelChapterGet).toHaveBeenCalledWith("c2"));
  });

  it("新建章节前保存失败：不创建、不切换、草稿保留", async () => {
    api.novelChapterSaveContent.mockRejectedValue(new Error("写入失败"));
    const { flushRef, onNotice } = renderPanel();
    const textarea = await getPanel(flushRef);
    fireEvent.change(textarea, { target: { value: "新建前的草稿" } });
    fireEvent.click(screen.getAllByRole("button", { name: /新建章节/ })[0]);
    await waitFor(() => expect(api.novelChapterSaveContent).toHaveBeenCalled());
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("error", expect.stringContaining("正文保存失败")));
    expect(api.novelChapterSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText("第一章正文")).toBe(textarea);
    expect(textarea.value).toBe("新建前的草稿");
  });
});

describe("NovelManuscriptPanel · 删除安全", () => {
    it("删除非当前章节：不触发当前正文保存，直接删除目标", async () => {
      const second = { ...chapter, id: "c2", title: "第二章", sortOrder: 1 };
      api.novelChapterList.mockResolvedValue({ chapters: [chapter, second] });
      const { flushRef } = renderPanel();
      await getPanel(flushRef);

      fireEvent.click(screen.getByRole("button", { name: "删除章节「第二章」" }));
      const dialog = await screen.findByRole("dialog", { name: "确认删除章节" });
      expect(within(dialog).getByText(/本章字数：4 字/)).toBeTruthy();
      expect(within(dialog).getByText(/未保存草稿：无/)).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

      await waitFor(() => expect(api.novelChapterDelete).toHaveBeenCalledWith("c2"));
      await waitFor(() => expect(screen.queryByRole("button", { name: "第二章" })).toBeNull());
      expect(api.novelChapterSaveContent).not.toHaveBeenCalled();
      expect(screen.getByLabelText("第一章正文")).toBeTruthy();
    });

    it("删除当前章节：先保存草稿，成功后才删除并清空编辑区", async () => {
      const save = deferred<ReturnType<typeof saveResult>>();
      api.novelChapterSaveContent.mockReturnValue(save.promise);
      const { flushRef } = renderPanel();
      const textarea = await getPanel(flushRef);
      fireEvent.change(textarea, { target: { value: "删除前的最后草稿" } });

      fireEvent.click(screen.getByRole("button", { name: "删除章节「第一章」" }));
      const dialog = await screen.findByRole("dialog", { name: "确认删除章节" });
      expect(within(dialog).getByText(/未保存草稿：有/)).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "保存后删除" }));

      await waitFor(() =>
        expect(api.novelChapterSaveContent).toHaveBeenCalledWith("c1", "删除前的最后草稿"),
      );
      expect(api.novelChapterDelete).not.toHaveBeenCalled();
      await act(async () => {
        save.resolve(saveResult("c1", "删除前的最后草稿"));
        await Promise.resolve();
      });
      await waitFor(() => expect(api.novelChapterDelete).toHaveBeenCalledWith("c1"));
      await waitFor(() => expect(screen.queryByLabelText("第一章正文")).toBeNull());
    });

    it("保存失败时取消删除：章节和草稿都保留，并给出错误", async () => {
      api.novelChapterSaveContent.mockRejectedValue(new Error("磁盘只读"));
      const { flushRef } = renderPanel();
      const textarea = await getPanel(flushRef);
      fireEvent.change(textarea, { target: { value: "保存失败不能删" } });

      fireEvent.click(screen.getByRole("button", { name: "删除章节「第一章」" }));
      const dialog = await screen.findByRole("dialog", { name: "确认删除章节" });
      fireEvent.click(within(dialog).getByRole("button", { name: "保存后删除" }));

      await waitFor(() =>
        expect(within(dialog).getByText(/保存失败，已取消删除/)).toBeTruthy(),
      );
      expect(api.novelChapterDelete).not.toHaveBeenCalled();
      expect(screen.getByLabelText("第一章正文")).toBe(textarea);
      expect(textarea.value).toBe("保存失败不能删");
    });

    it("明确丢弃草稿并删除：不发起新保存，但删除成功", async () => {
      const { flushRef } = renderPanel();
      const textarea = await getPanel(flushRef);
      fireEvent.change(textarea, { target: { value: "用户明确丢弃" } });

      fireEvent.click(screen.getByRole("button", { name: "删除章节「第一章」" }));
      const dialog = await screen.findByRole("dialog", { name: "确认删除章节" });
      fireEvent.click(within(dialog).getByRole("button", { name: "丢弃草稿并删除" }));

      await waitFor(() => expect(api.novelChapterDelete).toHaveBeenCalledWith("c1"));
      expect(api.novelChapterSaveContent).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByLabelText("第一章正文")).toBeNull());
    });

    it("删除卷包含当前章节：先保存当前正文，再级联删除卷和章节", async () => {
      const { flushRef } = renderPanel();
      const textarea = await getPanel(flushRef);
      fireEvent.change(textarea, { target: { value: "卷删除前正文" } });

      fireEvent.click(screen.getByRole("button", { name: "删除卷「第一卷」及其章节" }));
      const dialog = await screen.findByRole("dialog", { name: "确认删除卷" });
      expect(within(dialog).getByText(/卷内章节：1 章/)).toBeTruthy();
      expect(within(dialog).getByText(/当前正在编辑该卷章节：是/)).toBeTruthy();
      expect(within(dialog).getByText(/未保存草稿：有/)).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "保存后删除" }));

      await waitFor(() =>
        expect(api.novelChapterSaveContent).toHaveBeenCalledWith("c1", "卷删除前正文"),
      );
      await waitFor(() => expect(api.novelVolumeDelete).toHaveBeenCalledWith("v1"));
      expect(api.novelChapterDelete).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByLabelText("第一章正文")).toBeNull());
      expect(screen.queryByText("第一卷")).toBeNull();
    });

    it("删除多章节卷：展示章节数与总字数，删除后切其他卷不串正文", async () => {
      const volume2 = { ...volume, id: "v2", title: "第二卷", sortOrder: 1 };
      const chapter2 = { ...chapter, id: "c2", title: "第二章", sortOrder: 1 };
      const chapter3 = { ...chapter, id: "c3", volumeId: "v2", title: "第三章", sortOrder: 0 };
      api.novelVolumeList.mockResolvedValue({ volumes: [volume, volume2] });
      api.novelChapterList.mockResolvedValue({ chapters: [chapter, chapter2, chapter3] });
      api.novelChapterGet.mockImplementation(async (id: string) => ({
        chapter: {
          ...(id === "c3" ? chapter3 : id === "c2" ? chapter2 : chapter),
          content: id === "c1" ? "初稿内容" : id === "c2" ? "第二章正文" : "第三章正文",
        },
      }));

      const { flushRef } = renderPanel();
      const textarea = await getPanel(flushRef);
      fireEvent.change(textarea, { target: { value: "多章删除前正文" } });

      fireEvent.click(screen.getByRole("button", { name: "删除卷「第一卷」及其章节" }));
      const dialog = await screen.findByRole("dialog", { name: "确认删除卷" });
      expect(within(dialog).getByText(/卷内章节：2 章/)).toBeTruthy();
      expect(within(dialog).getByText(/正文总字数：/)).toBeTruthy();
      expect(within(dialog).getByText(/当前正在编辑该卷章节：是/)).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "保存后删除" }));

      await waitFor(() => expect(api.novelVolumeDelete).toHaveBeenCalledWith("v1"));
      await waitFor(() => expect(screen.queryByRole("button", { name: "第一卷" })).toBeNull());
      expect(screen.queryByRole("button", { name: "第二章" })).toBeNull();
      // 删除成功后不再触发旧正文保存；其他卷章节仍可打开且内容不串。
      expect(api.novelChapterSaveContent).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole("button", { name: "第三章" }));
      await waitFor(() =>
        expect((screen.getByLabelText("第三章正文") as HTMLTextAreaElement).value).toBe(
          "第三章正文",
        ),
      );
      expect(screen.queryByText("多章删除前正文")).toBeNull();
    });

    it("删除期间重复点击：只发一次删除 IPC，按钮进入删除中", async () => {
      const d = deferred<void>();
      api.novelChapterDelete.mockReturnValue(d.promise);
      const { flushRef } = renderPanel();
      await getPanel(flushRef);

      fireEvent.click(screen.getByRole("button", { name: "删除章节「第一章」" }));
      const dialog = await screen.findByRole("dialog", { name: "确认删除章节" });
      const remove = within(dialog).getByRole("button", { name: "删除" });
      fireEvent.click(remove);
      fireEvent.click(remove);

      await waitFor(() => expect(api.novelChapterDelete).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(within(dialog).getByText("删除中…")).toBeTruthy());
      await act(async () => {
        d.resolve(undefined);
        await Promise.resolve();
      });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });

    it("删除当前章节时有在途保存：等待同一请求，不并发第二次写入", async () => {
      const d = deferred<ReturnType<typeof saveResult>>();
      api.novelChapterSaveContent.mockReturnValue(d.promise);
      const { flushRef } = renderPanel();
      const textarea = await getPanel(flushRef);
      fireEvent.change(textarea, { target: { value: "在途正文" } });
      await act(async () => {
        void flushRef.current?.();
        await Promise.resolve();
      });
      expect(api.novelChapterSaveContent).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "删除章节「第一章」" }));
      const dialog = await screen.findByRole("dialog", { name: "确认删除章节" });
      fireEvent.click(within(dialog).getByRole("button", { name: "保存后删除" }));
      expect(api.novelChapterDelete).not.toHaveBeenCalled();

      await act(async () => {
        d.resolve(saveResult("c1", "在途正文"));
        await Promise.resolve();
      });
      await waitFor(() => expect(api.novelChapterDelete).toHaveBeenCalledWith("c1"));
      expect(api.novelChapterSaveContent).toHaveBeenCalledTimes(1);
    });

    it("删除其他卷：不影响当前卷章节，也不触发当前正文保存", async () => {
      const volume2 = { ...volume, id: "v2", title: "第二卷", sortOrder: 1 };
      const c2 = { ...chapter, id: "c2", volumeId: "v2", title: "第二章", sortOrder: 1 };
      api.novelVolumeList.mockResolvedValue({ volumes: [volume, volume2] });
      api.novelChapterList.mockResolvedValue({ chapters: [chapter, c2] });
      const { flushRef } = renderPanel();
      await getPanel(flushRef);

      fireEvent.click(screen.getByRole("button", { name: "删除卷「第二卷」及其章节" }));
      const dialog = await screen.findByRole("dialog", { name: "确认删除卷" });
      expect(within(dialog).getByText(/卷内章节：1 章/)).toBeTruthy();
      expect(within(dialog).getByText(/当前正在编辑该卷章节：否/)).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

      await waitFor(() => expect(api.novelVolumeDelete).toHaveBeenCalledWith("v2"));
      expect(api.novelChapterSaveContent).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "第一章" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "第二卷" })).toBeNull();
    });

    it("取消删除：不发请求，章节仍在", async () => {
      const second = { ...chapter, id: "c2", title: "第二章", sortOrder: 1 };
      api.novelChapterList.mockResolvedValue({ chapters: [chapter, second] });
      const { flushRef } = renderPanel();
      await getPanel(flushRef);

      fireEvent.click(screen.getByRole("button", { name: "删除章节「第二章」" }));
      const dialog = await screen.findByRole("dialog", { name: "确认删除章节" });
      fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(api.novelChapterDelete).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "第二章" })).toBeTruthy();
    });

    it("删除失败：保留章节与正文，显示错误可重试", async () => {
      api.novelChapterDelete.mockRejectedValueOnce(new Error("数据库忙"));
      const { flushRef } = renderPanel();
      const textarea = await getPanel(flushRef);

      fireEvent.click(screen.getByRole("button", { name: "删除章节「第一章」" }));
      const dialog = await screen.findByRole("dialog", { name: "确认删除章节" });
      fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

      await waitFor(() => expect(within(dialog).getByText(/删除失败：数据库忙/)).toBeTruthy());
      expect(screen.getByLabelText("第一章正文")).toBe(textarea);
      expect(textarea.value).toBe("初稿内容");
      expect(screen.getByRole("button", { name: "第一章" })).toBeTruthy();
    });
  });

describe("NovelManuscriptPanel · 离开与卸载", () => {
  const moduleNotice = vi.fn();
  function ModuleHarness() {
    const [module, setModule] = useState<"manuscript" | "overview">("manuscript");
    const flushRef = useRef<(() => Promise<boolean>) | null>(null);
    return (
      <>
        <button
          type="button"
          onClick={() => {
            void (async () => {
              const flush = flushRef.current;
              if (flush && !(await flush())) return;
              setModule("overview");
            })();
          }}
        >
          切换模块
        </button>
        <span data-testid="module">{module}</span>
        {module === "manuscript" && (
          <NovelManuscriptPanel
            projectId="p1"
            archived={false}
            onNotice={moduleNotice}
            registerFlush={(flush) => {
              flushRef.current = flush;
            }}
          />
        )}
      </>
    );
  }

  it("切换模块保存成功：等待落盘后才允许导航", async () => {
    const d = deferred<ReturnType<typeof saveResult>>();
    api.novelChapterSaveContent.mockReturnValue(d.promise);
    render(<ModuleHarness />);
    const textarea = (await screen.findByLabelText("第一章正文")) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "离开前正文" } });
    fireEvent.click(screen.getByRole("button", { name: "切换模块" }));
    await waitFor(() => expect(api.novelChapterSaveContent).toHaveBeenCalledWith("c1", "离开前正文"));
    expect(screen.getByTestId("module").textContent).toBe("manuscript");
    await act(async () => {
      d.resolve(saveResult("c1", "离开前正文"));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("module").textContent).toBe("overview"));
  });

  it("切换模块保存失败：禁止导航并保留草稿", async () => {
    api.novelChapterSaveContent.mockRejectedValue(new Error("保存失败"));
    render(<ModuleHarness />);
    const textarea = (await screen.findByLabelText("第一章正文")) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "失败后保留" } });
    fireEvent.click(screen.getByRole("button", { name: "切换模块" }));
    await waitFor(() => expect(api.novelChapterSaveContent).toHaveBeenCalledWith("c1", "失败后保留"));
    expect(screen.getByTestId("module").textContent).toBe("manuscript");
    expect(textarea.value).toBe("失败后保留");
  });

  it("切换项目：旧项目保存完成后才换项目，不串正文", async () => {
    const projectNotice = vi.fn();
    function ProjectHarness() {
      const [projectId, setProjectId] = useState("p1");
      const flushRef = useRef<(() => Promise<boolean>) | null>(null);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              void (async () => {
                const flush = flushRef.current;
                if (flush && !(await flush())) return;
                setProjectId("p2");
              })();
            }}
          >
            切换项目
          </button>
          <span data-testid="project">{projectId}</span>
          <NovelManuscriptPanel
            projectId={projectId}
            archived={false}
            onNotice={projectNotice}
            registerFlush={(flush) => {
              flushRef.current = flush;
            }}
          />
        </>
      );
    }

    api.novelChapterGet.mockImplementation(async (id: string) => ({
      chapter: {
        ...chapter,
        id,
        title: id === "p2c1" ? "P2 第一章" : chapter.title,
        content: id === "p2c1" ? "P2 正文" : "P1 正文",
      },
    }));
    api.novelChapterList.mockImplementation(async (projectId: string) => ({
      chapters: [
        projectId === "p2"
          ? { ...chapter, id: "p2c1", projectId: "p2", title: "P2 第一章" }
          : chapter,
      ],
    }));
    const d = deferred<ReturnType<typeof saveResult>>();
    api.novelChapterSaveContent.mockReturnValue(d.promise);

    render(<ProjectHarness />);
    const textarea = (await screen.findByLabelText("第一章正文")) as HTMLTextAreaElement;
    expect(textarea.value).toBe("P1 正文");
    fireEvent.change(textarea, { target: { value: "P1 未保存" } });
    fireEvent.click(screen.getByRole("button", { name: "切换项目" }));
    await waitFor(() => expect(api.novelChapterSaveContent).toHaveBeenCalledWith("c1", "P1 未保存"));
    expect(screen.getByTestId("project").textContent).toBe("p1");

    await act(async () => {
      d.resolve(saveResult("c1", "P1 未保存"));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("project").textContent).toBe("p2"));
    await waitFor(() => expect(api.novelChapterGet).toHaveBeenCalledWith("p2c1"));
    const next = (await screen.findByLabelText("P2 第一章正文")) as HTMLTextAreaElement;
    expect(next.value).toBe("P2 正文");
  });

  it("卸载：无脏稿不写库；有脏稿 flush 且失败不静默", async () => {
    // 无脏稿：不得重复写库。
    const clean = renderPanel();
    await getPanel(clean.flushRef);
    clean.view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.novelChapterSaveContent).not.toHaveBeenCalled();

    // 有脏稿：卸载时仍发一次保存。
    cleanup();
    const dirty = renderPanel();
    const textarea = await getPanel(dirty.flushRef);
    fireEvent.change(textarea, { target: { value: "卸载前草稿" } });
    dirty.view.unmount();
    await waitFor(() =>
      expect(api.novelChapterSaveContent).toHaveBeenCalledWith("c1", "卸载前草稿"),
    );

    // 失败：通过 onNotice 报告，不当作成功。
    cleanup();
    const failing = renderPanel({ onNotice: vi.fn() });
    const t2 = await getPanel(failing.flushRef);
    api.novelChapterSaveContent.mockRejectedValue(new Error("卸载写库失败"));
    fireEvent.change(t2, { target: { value: "卸载失败草稿" } });
    failing.view.unmount();
    await waitFor(() =>
      expect(failing.onNotice).toHaveBeenCalledWith(
        "error",
        expect.stringContaining("正文保存失败"),
      ),
    );
  });
});

describe("NovelManuscriptPanel · 归档只读", () => {
  it("归档后所有编辑入口禁用，正文仍可读取", async () => {
    renderPanel({ archived: true });
    const textarea = (await screen.findByLabelText("第一章正文")) as HTMLTextAreaElement;
    expect(textarea.readOnly).toBe(true);
    expect(screen.getByText("项目已归档，只读")).toBeTruthy();
    expect((screen.getByPlaceholderText("新建卷标题") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "卷" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "第一卷" }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "重命名章节「第一章」" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "上移章节「第一章」" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "下移章节「第一章」" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "删除章节「第一章」" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "删除卷「第一卷」及其章节" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    screen.getAllByRole("button", { name: /新建章节/ }).forEach((button) => {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it("编辑中被归档：草稿不丢、明确显示未保存；恢复后可继续保存", async () => {
    const onNotice = vi.fn();
    const flushRef: { current: (() => Promise<boolean>) | null } = { current: null };
    const view = render(
      <NovelManuscriptPanel
        projectId="p1"
        archived={false}
        onNotice={onNotice}
        registerFlush={(flush) => {
          flushRef.current = flush;
        }}
      />,
    );
    await screen.findByText("第一卷");
    const textarea = (await screen.findByLabelText("第一章正文")) as HTMLTextAreaElement;
    await waitFor(() => expect(flushRef.current).not.toBeNull());
    fireEvent.change(textarea, { target: { value: "归档瞬间的草稿" } });

    view.rerender(
      <NovelManuscriptPanel projectId="p1" archived onNotice={onNotice} registerFlush={() => {}} />,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("第一章正文") as HTMLTextAreaElement).readOnly).toBe(true),
    );
    expect((screen.getByLabelText("第一章正文") as HTMLTextAreaElement).value).toBe("归档瞬间的草稿");
    expect(screen.getByText("项目已归档，正文未保存")).toBeTruthy();

    view.rerender(
      <NovelManuscriptPanel
        projectId="p1"
        archived={false}
        onNotice={onNotice}
        registerFlush={(flush) => {
          flushRef.current = flush;
        }}
      />,
    );
    await act(async () => {
      await flushRef.current?.();
    });
    await waitFor(() =>
      expect(api.novelChapterSaveContent).toHaveBeenCalledWith("c1", "归档瞬间的草稿"),
    );
  });
});
