/**
 * @vitest-environment jsdom
 */
//! 条目详情的类型专属区域契约：
//! - URL：域名 + 打开/复制，无效 http(s) 地址不给打开按钮；
//! - 文件：状态徽标区分存在/已不存在/无权限，失效文件禁用打开与定位；
//! - HTML：阅读视图不渲染主动内容，源码视图可见原文；
//! - 文字：代码置信识别默认进入代码阅读（as-code）。
//! 通用操作（复制/收藏/置顶/删除/关联/导出）结构保持不变。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  clipboardItem: vi.fn(),
  clipboardPathStatus: vi.fn(),
  clipboardOpenUrl: vi.fn(),
  clipboardOpenLocalPath: vi.fn(),
  clipboardRevealLocalPath: vi.fn(),
  clipboardCopyItem: vi.fn(),
  clipboardCopyText: vi.fn(),
  clipboardDeleteItems: vi.fn(),
  clipboardToggleItem: vi.fn(),
  clipboardRenameItem: vi.fn(),
  clipboardLinkTask: vi.fn(),
  workspaceList: vi.fn(),
  clipboardAgentTargets: vi.fn(),
  clipboardExportForAgent: vi.fn(),
}));
vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...bridge };
});

import ClipboardItemDetail from "./ClipboardItemDetail";
import type { ClipboardItem } from "../../lib/bridge";
import { resetOverlayStack } from "../../lib/overlayStack";

beforeEach(() => {
  vi.clearAllMocks();
  resetOverlayStack();
  bridge.clipboardCopyItem.mockResolvedValue({
    mode: "text",
    bytes: 10,
    warnings: [],
    sequence: 1,
    item_count: 1,
  });
  bridge.clipboardCopyText.mockResolvedValue(undefined);
  bridge.clipboardOpenUrl.mockResolvedValue(undefined);
  bridge.clipboardOpenLocalPath.mockResolvedValue(undefined);
  bridge.clipboardRevealLocalPath.mockResolvedValue(undefined);
  bridge.clipboardPathStatus.mockResolvedValue([]);
  bridge.workspaceList.mockResolvedValue([]);
  bridge.clipboardAgentTargets.mockResolvedValue([]);
});

afterEach(cleanup);

function makeItem(over: Partial<ClipboardItem> = {}): ClipboardItem {
  return {
    id: "ci1",
    kind: "text",
    text: "",
    html: "",
    preview: "预览",
    title: "",
    title_source: "none",
    byte_size: 20,
    source_app: "notepad.exe",
    source_title: "记事本",
    image_width: null,
    image_height: null,
    file_paths: [],
    favorite: false,
    pinned: false,
    copy_count: 0,
    created_at: "2026-11-02T10:00:00Z",
    last_seen_at: "2026-11-02T10:00:00Z",
    has_image: false,
    has_thumb: false,
    ...over,
  };
}

async function renderDetail(item: ClipboardItem) {
  bridge.clipboardItem.mockResolvedValue(item);
  render(
    <ClipboardItemDetail
      itemId={item.id}
      linkTask={null}
      askConfirm={({ run }) => void run()}
      onBack={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  await waitFor(() => expect(bridge.clipboardItem).toHaveBeenCalled());
}

describe("URL 专属操作", () => {
  it("展示域名与完整链接，打开走后端校验命令", async () => {
    await renderDetail(makeItem({ kind: "url", text: "https://example.com/page?x=1" }));
    await waitFor(() => expect(screen.getByText("example.com")).toBeTruthy());
    expect(screen.getByText("https://example.com/page?x=1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /打开链接/ }));
    await waitFor(() =>
      expect(bridge.clipboardOpenUrl).toHaveBeenCalledWith("ci1"),
    );
  });

  it("非 http/https 正文不提供打开按钮并明确提示", async () => {
    await renderDetail(makeItem({ kind: "url", text: "javascript:alert(1)" }));
    await waitFor(() => expect(screen.getByText(/域名不可用/)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /打开链接/ })).toBeNull();
    expect(screen.getByText(/打开已被禁止/)).toBeTruthy();
  });
});

describe("文件专属操作", () => {
  it("状态徽标区分存在与已不存在，失效文件禁用打开/定位", async () => {
    bridge.clipboardPathStatus.mockResolvedValue(["ok", "missing"]);
    await renderDetail(
      makeItem({
        kind: "files",
        text: "C:\\a.txt\nC:\\b.txt",
        file_paths: ["C:\\a.txt", "C:\\b.txt"],
      }),
    );
    await waitFor(() => expect(bridge.clipboardPathStatus).toHaveBeenCalled());
    const rows = await waitFor(() => {
      const rows = document.querySelectorAll(".clip-path-row");
      expect(rows.length).toBe(2);
      return rows;
    });
    expect(rows[0].classList.contains("is-ok")).toBe(true);
    expect(rows[1].classList.contains("is-missing")).toBe(true);
    expect(rows[1].textContent).toContain("已不存在");
    const openB = rows[1].querySelector('button[aria-label^="打开"]');
    const revealB = rows[1].querySelector('button[aria-label^="定位"]');
    expect((openB as HTMLButtonElement).disabled).toBe(true);
    expect((revealB as HTMLButtonElement).disabled).toBe(true);
  });

  it("切换条目后，旧路径查询的迟到结果不得覆盖新条目状态", async () => {
    let resolveOld: (v: string[]) => void = () => {};
    const oldQuery = new Promise<string[]>((r) => {
      resolveOld = r;
    });
    bridge.clipboardPathStatus.mockImplementation((paths: string[]) =>
      paths[0] === "C:\\old.txt" ? oldQuery : Promise.resolve(["ok"]),
    );
    bridge.clipboardItem.mockImplementation((id: string) =>
      Promise.resolve(
        id === "old"
          ? makeItem({ id: "old", kind: "files", text: "C:\\old.txt", file_paths: ["C:\\old.txt"] })
          : makeItem({ id: "new", kind: "files", text: "C:\\new.txt", file_paths: ["C:\\new.txt"] }),
      ),
    );
    const props = {
      linkTask: null,
      askConfirm: ({ run }: { run: () => void }) => void run(),
      onBack: vi.fn(),
      onChanged: vi.fn(),
    };
    const view = render(<ClipboardItemDetail itemId="old" {...props} />);
    await waitFor(() => expect(bridge.clipboardPathStatus).toHaveBeenCalledTimes(1));

    view.rerender(<ClipboardItemDetail itemId="new" {...props} />);
    await waitFor(() => expect(bridge.clipboardPathStatus).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(document.querySelector(".clip-path-state")!.textContent).toContain("存在"),
    );

    // 旧查询此时才返回「已不存在」：已卸载的 effect 不得把新条目的状态改回去
    resolveOld(["missing"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector(".clip-path-state")!.textContent).toContain("存在");
    expect(document.querySelector(".clip-path-state")!.textContent).not.toContain("已不存在");
  });

  it("单文件块级操作与行内操作分别调用打开/定位命令", async () => {
    bridge.clipboardPathStatus.mockResolvedValue(["ok"]);
    await renderDetail(
      makeItem({ kind: "files", text: "C:\\a.txt", file_paths: ["C:\\a.txt"] }),
    );
    await waitFor(() => expect(document.querySelectorAll(".clip-path-row").length).toBe(1));
    // 顶部按钮在状态落地前是禁用的（checking），等它变为可用再点
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /打开文件/ }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /打开文件/ }));
    await waitFor(() =>
      expect(bridge.clipboardOpenLocalPath).toHaveBeenCalledWith("C:\\a.txt"),
    );
    fireEvent.click(screen.getByRole("button", { name: /资源管理器定位/ }));
    await waitFor(() =>
      expect(bridge.clipboardRevealLocalPath).toHaveBeenCalledWith("C:\\a.txt"),
    );
  });
});

describe("单文件顶部操作与文件状态同源", () => {
  /** 顶部「打开文件 / 资源管理器定位」是单文件专属入口，必须与行内按钮同一判定。 */
  const topOpen = () => screen.getByRole("button", { name: /打开文件/ }) as HTMLButtonElement;
  const topReveal = () =>
    screen.getByRole("button", { name: /资源管理器定位/ }) as HTMLButtonElement;

  async function renderSingleFile(paths = ["C:\\a.txt"]) {
    await renderDetail(makeItem({ kind: "files", text: paths.join("\n"), file_paths: paths }));
    await waitFor(() => expect(document.querySelectorAll(".clip-path-row").length).toBe(paths.length));
  }

  it("文件存在：顶部与行内都可用", async () => {
    bridge.clipboardPathStatus.mockResolvedValue(["ok"]);
    await renderSingleFile();
    await waitFor(() => expect(topOpen().disabled).toBe(false));
    expect(topReveal().disabled).toBe(false);
    fireEvent.click(topOpen());
    await waitFor(() => expect(bridge.clipboardOpenLocalPath).toHaveBeenCalledWith("C:\\a.txt"));
    fireEvent.click(topReveal());
    await waitFor(() => expect(bridge.clipboardRevealLocalPath).toHaveBeenCalledWith("C:\\a.txt"));
  });

  it("文件已不存在：顶部两个按钮同步禁用，并说明原因", async () => {
    bridge.clipboardPathStatus.mockResolvedValue(["missing"]);
    await renderSingleFile();
    await waitFor(() => expect(topOpen().disabled).toBe(true));
    expect(topReveal().disabled).toBe(true);
    expect(topOpen().getAttribute("data-tip")).toContain("已不存在");
    expect(screen.getByText("已不存在", { selector: ".clip-path-state" })).toBeTruthy();
  });

  it("状态查询尚未完成：不允许误操作（检查中即禁用）", async () => {
    // 永不落定的查询：模拟慢盘/网络盘上的 stat
    bridge.clipboardPathStatus.mockReturnValue(new Promise(() => {}));
    await renderSingleFile();
    expect(topOpen().disabled).toBe(true);
    expect(topReveal().disabled).toBe(true);
    expect(topOpen().getAttribute("data-tip")).toContain("检查中");
    expect(document.querySelector(".clip-path-state")!.textContent).toContain("检查中");
  });

  it("状态查询失败：不得误判为存在，顶部与行内都禁用并给出明确反馈", async () => {
    bridge.clipboardPathStatus.mockRejectedValue(new Error("stat 失败"));
    await renderSingleFile();
    await waitFor(() => expect(topOpen().disabled).toBe(true));
    expect(topReveal().disabled).toBe(true);
    expect(screen.getByText(/文件状态查询失败/)).toBeTruthy();
    expect(document.querySelector(".clip-path-state")!.textContent).toContain("无法确认");
    // 行内按钮同样禁用（同一判定，不是两套口径）
    const rowOpen = document.querySelector<HTMLButtonElement>('button[aria-label^="打开"]')!;
    expect(rowOpen.disabled).toBe(true);
    expect(bridge.clipboardOpenLocalPath).not.toHaveBeenCalled();
  });

  it("后台繁忙（并发配额已满）：提示区分繁忙，状态仍是无法确认，且不自动重试", async () => {
    bridge.clipboardPathStatus.mockRejectedValue({
      code: "SERVICE_OVERLOADED",
      category: "service",
      severity: "warning",
      retryable: true,
      message: "服务繁忙，请稍后重试：文件状态检查任务过多",
    });
    await renderSingleFile();
    await waitFor(() => expect(topOpen().disabled).toBe(true));
    expect(topReveal().disabled).toBe(true);
    expect(screen.getByText(/后台繁忙/)).toBeTruthy();
    const badge = document.querySelector(".clip-path-state")!;
    expect(badge.textContent).toContain("无法确认");
    expect(badge.textContent).not.toContain("已不存在");
    expect(bridge.clipboardPathStatus).toHaveBeenCalledTimes(1);
    expect(bridge.clipboardOpenLocalPath).not.toHaveBeenCalled();
  });

  it("后端返回非预期状态值：按「无法确认」处理，不放行", async () => {
    bridge.clipboardPathStatus.mockResolvedValue(["something-else"]);
    await renderSingleFile();
    await waitFor(() => expect(topOpen().disabled).toBe(true));
    expect(document.querySelector(".clip-path-state")!.textContent).toContain("无法确认");
  });

  it("多文件：不出现顶部单文件入口，行内按钮各自按状态启用/禁用", async () => {
    bridge.clipboardPathStatus.mockResolvedValue(["ok", "missing"]);
    await renderSingleFile(["C:\\a.txt", "C:\\b.txt"]);
    expect(screen.queryByRole("button", { name: /打开文件/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /资源管理器定位/ })).toBeNull();
    // 等状态落地：行内按钮的启用与否就是判定结果本身
    await waitFor(() =>
      expect(document.querySelector(".clip-path-row.is-ok")).not.toBeNull(),
    );
    const rows = document.querySelectorAll(".clip-path-row");
    const openA = rows[0].querySelector<HTMLButtonElement>('button[aria-label^="打开"]')!;
    const openB = rows[1].querySelector<HTMLButtonElement>('button[aria-label^="打开"]')!;
    expect(openA.disabled).toBe(false);
    expect(openB.disabled).toBe(true);
  });
});

describe("HTML 阅读视图", () => {
  it("阅读视图渲染白名单内容且不出现脚本元素，源码视图可见原始 HTML", async () => {
    const html = `<p>安全<b>加粗</b></p><script>alert(1)</script>`;
    await renderDetail(makeItem({ kind: "html", text: "安全加粗", html }));
    await waitFor(() => expect(document.querySelector(".clip-doc")).not.toBeNull());
    expect(document.querySelector(".clip-doc")!.textContent).toContain("安全");
    expect(document.querySelector("script")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /源码/ }));
    const pre = document.querySelector(".clip-html")!;
    expect(pre.textContent).toBe(html);
  });

  it("复制富文本走单项复制链路（保留 HTML 格式）", async () => {
    await renderDetail(makeItem({ kind: "html", text: "正文", html: "<p>正文</p>" }));
    await waitFor(() => expect(document.querySelector(".clip-doc")).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /复制富文本/ }));
    await waitFor(() => expect(bridge.clipboardCopyItem).toHaveBeenCalledWith("ci1"));
  });
});

describe("文字代码阅读", () => {
  it("代码置信内容默认代码阅读（等宽不换行），可切回普通文本", async () => {
    const code = ["function add(a, b) {", "  return a + b;", "}"].join("\n");
    await renderDetail(makeItem({ kind: "text", text: code, preview: "add()" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /代码阅读/ })).toBeTruthy());
    expect(screen.getByRole("tab", { name: /代码阅读/ }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector("pre.clip-full-text")!.classList.contains("as-code")).toBe(true);

    fireEvent.click(screen.getByRole("tab", { name: /普通文本/ }));
    expect(document.querySelector("pre.clip-full-text")!.classList.contains("as-code")).toBe(false);
  });

  it("普通段落默认普通文本视图", async () => {
    const prose = [
      "task_dock 是一个 Windows 桌面任务启动器。",
      "这次升级把剪贴板变成轻量的多类型内容管理器。",
      "不同类型的内容提供专属的详情和操作。",
    ].join("\n");
    await renderDetail(makeItem({ kind: "text", text: prose, preview: "段落" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /普通文本/ })).toBeTruthy());
    expect(screen.getByRole("tab", { name: /普通文本/ }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector("pre.clip-full-text")!.classList.contains("as-code")).toBe(false);
  });
});

describe("采集环境", () => {
  it("显示应用、窗口与系统记录语义，并声明不一定是实际复制程序", async () => {
    await renderDetail(
      makeItem({
        source_app: "chrome.exe",
        source_title: "Go | OpenCode Console - Google Chrome",
        source_kind: "owner",
      }),
    );
    const block = await screen.findByRole("region", { name: "采集环境" });
    expect(block.textContent).toContain("Google Chrome");
    expect(block.textContent).toContain("窗口");
    expect(block.textContent).toContain("剪贴板所有者窗口（系统记录）");
    expect(block.textContent).not.toContain("可确认");
    expect(block.textContent).toContain("不一定是实际执行复制操作的程序");
    expect(block.textContent).toContain("来源进程 chrome.exe");
  });

  it("未知来源不冒充已识别应用/窗口", async () => {
    await renderDetail(
      makeItem({ source_app: "unknown", source_title: "", source_kind: "unknown" }),
    );
    const block = await screen.findByRole("region", { name: "采集环境" });
    expect(block.textContent).toContain("未知应用");
    expect(block.textContent).toContain("未能识别来源");
    expect(block.textContent).not.toContain("chrome.exe");
    // 不得把后端哨兵值 `unknown` 当成进程名展示。
    expect(block.textContent).not.toContain("来源进程");
    expect(block.textContent).not.toContain("可确认");
  });

  it("旧记录空 source_kind 显示「旧记录未记录识别方式」，不假装已确认", async () => {
    await renderDetail(
      makeItem({ source_app: "notepad.exe", source_title: "记事本", source_kind: "" }),
    );
    const block = await screen.findByRole("region", { name: "采集环境" });
    expect(block.textContent).toContain("旧记录未记录识别方式");
    expect(block.textContent).not.toContain("可确认");
    expect(block.textContent).not.toContain("系统记录）");
  });
});
