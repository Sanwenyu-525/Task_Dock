/**
 * @vitest-environment jsdom
 *
 * R14.2 P2：快速预览请求索引竞态。
 *
 * 请求 A → 请求 B 时，首次渲染就必须使用 B 的目标文件；不允许先按 A 的旧 index
 * 挂载一个 B 目录里的错误文件，再靠 effect 修正。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { FsEntry } from "../../lib/bridge";

const bridgeMocks = vi.hoisted(() => ({
  fsOpen: vi.fn(async () => undefined),
  fsStat: vi.fn(),
  fsReadText: vi.fn(),
  fsReadBinary: vi.fn(),
  fsPreviewImage: vi.fn(),
  fsPreviewMediaUrl: vi.fn(),
  fsReleasePreviewUrl: vi.fn(),
}));

const dirMock = vi.hoisted(() => ({
  subscribeDir: vi.fn(() => () => undefined),
  getDirState: vi.fn(() => ({
    path: "",
    showHidden: false,
    listing: null,
    truncated: false,
    hasMore: false,
    diskScanned: null,
    loading: false,
    error: null,
    signatureModifiedMs: null,
    fetchedAt: 0,
  })),
}));

vi.mock("../../lib/bridge", () => bridgeMocks);
vi.mock("../../lib/filesWorkspace/dirCache", () => dirMock);
vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    locale: "zh-CN",
    preference: "zh-CN",
    setPreference: vi.fn(),
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
  }),
}));

import QuickPreviewDialog, { type PreviewRequest } from "./QuickPreviewDialog";

const textMock = bridgeMocks.fsReadText;
const stageText = () => document.querySelector(".fw-preview-stage")?.textContent ?? "";
const stagePath = () => document.querySelector(".fw-preview-stage")?.getAttribute("data-preview-path") ?? null;

function entry(name: string, modifiedMs = 1_700_000_000_000): FsEntry {
  return { name, kind: "file", ext: "md", size: name.length, modifiedMs, hidden: false, category: "code" };
}

function request(dir: string, path: string, entries: FsEntry[]): PreviewRequest {
  return { paneId: "p1", dir, path, entries };
}

beforeEach(() => {
  textMock.mockReset().mockImplementation(async (path: string) => ({
    path,
    size: 1,
    truncated: false,
    encoding: "UTF-8",
    content: `CONTENT:${path}`,
  }));
});

afterEach(() => cleanup());

describe("请求切换的索引一致性", () => {
  it("A 已切到 index 2，B 打开 index 0 的文件：B 首次渲染只读 B1，不读 B2", async () => {
    const aEntries = [entry("a1.md"), entry("a2.md"), entry("a3.md")];
    const bEntries = [entry("b1.md"), entry("b2.md")];
    const { rerender } = render(
      <QuickPreviewDialog request={request("D:\\A", "D:\\A\\a1.md", aEntries)} onClose={() => undefined} />,
    );
    await waitFor(() => expect(stageText()).toContain("CONTENT:D:\\A\\a1.md"));

    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(stageText()).toContain("CONTENT:D:\\A\\a3.md"));

    rerender(<QuickPreviewDialog request={request("D:\\B", "D:\\B\\b1.md", bEntries)} onClose={() => undefined} />);

    // 首次渲染即 B1：既不残留 A 目录文件，也不短暂挂载 B2。
    expect(stagePath()).toBe("D:\\B\\b1.md");
    expect(textMock.mock.calls.some(([path]) => path === "D:\\B\\b2.md")).toBe(false);
    await waitFor(() => expect(stageText()).toContain("CONTENT:D:\\B\\b1.md"));
    expect(textMock.mock.calls.some(([path]) => path === "D:\\B\\b2.md")).toBe(false);
  });

  it("B 的目标文件位于 index 1，A 的旧 index 为 2：首次渲染必须是 B2", async () => {
    const aEntries = [entry("a1.md"), entry("a2.md"), entry("a3.md")];
    const bEntries = [entry("b1.md"), entry("b2.md"), entry("b3.md")];
    const { rerender } = render(
      <QuickPreviewDialog request={request("D:\\A", "D:\\A\\a1.md", aEntries)} onClose={() => undefined} />,
    );
    await waitFor(() => expect(stageText()).toContain("CONTENT:D:\\A\\a1.md"));

    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(stageText()).toContain("CONTENT:D:\\A\\a3.md"));

    rerender(<QuickPreviewDialog request={request("D:\\B", "D:\\B\\b2.md", bEntries)} onClose={() => undefined} />);
    expect(stagePath()).toBe("D:\\B\\b2.md");
    await waitFor(() => expect(stageText()).toContain("CONTENT:D:\\B\\b2.md"));
    expect(textMock.mock.calls.some(([path]) => path === "D:\\B\\b1.md")).toBe(false);
  });

  it("快速切换期间 A 的晚到读取不覆盖 B", async () => {
    let resolveA!: (value: unknown) => void;
    const aPromise = new Promise((resolve) => (resolveA = resolve));
    textMock.mockImplementation(async (path: string) => {
      if (path.endsWith("a1.md")) return aPromise;
      return { path, size: 1, truncated: false, encoding: "UTF-8", content: `CONTENT:${path}` };
    });

    const { rerender } = render(
      <QuickPreviewDialog request={request("D:\\A", "D:\\A\\a1.md", [entry("a1.md")])} onClose={() => undefined} />,
    );
    rerender(
      <QuickPreviewDialog
        request={request("D:\\B", "D:\\B\\b1.md", [entry("b1.md")])}
        onClose={() => undefined}
      />,
    );
    await waitFor(() => expect(stageText()).toContain("CONTENT:D:\\B\\b1.md"));

    resolveA({ path: "D:\\A\\a1.md", size: 1, truncated: false, encoding: "UTF-8", content: "CONTENT:D:\\A\\a1.md" });
    await waitFor(() => expect(stageText()).toContain("CONTENT:D:\\B\\b1.md"));
    expect(stageText()).not.toContain("CONTENT:D:\\A\\a1.md");
  });
});
