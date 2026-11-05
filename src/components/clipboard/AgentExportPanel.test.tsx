/**
 * @vitest-environment jsdom
 */
//! Agent 导出面板：默认轻量、导出不依赖探测、能力语义可核验、异步结果不串会话。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  clipboardAgentTargets: vi.fn(),
  clipboardExportForAgent: vi.fn(),
}));
vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...bridge };
});

const clipboard = vi.hoisted(() => ({ copyText: vi.fn() }));
vi.mock("../../lib/clipboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/clipboard")>();
  return { ...actual, copyText: clipboard.copyText };
});

import AgentExportPanel from "./AgentExportPanel";
import type {
  AgentClipboardTarget,
  AgentTargetsSnapshot,
  ExportPackage,
} from "../../lib/bridge";
import { useUiStore } from "../../store/useUiStore";

const TARGET: AgentClipboardTarget = {
  source_id: "agent-1",
  display_name: "示例 Agent",
  installed: true,
  window_present: true,
  evidence: "window-present",
  note: "窗口可用：可手动逐项粘贴，或导出本地包",
  direct_send: {
    supported: false,
    evidence: "unsupported-interface",
    note: "当前没有经过验证的结构化发送接口，不会自动上传或发送。",
  },
  file_import: { supported: false, evidence: "unverified", note: "文件导入未验证。" },
  desktop_paste: {
    supported: true,
    evidence: "window-present",
    note: "需用户手动触发桌面粘贴，只代表按键动作已发送。",
  },
  export: { supported: true, evidence: "local-export", note: "本地导出始终可用。" },
  recommended: "paste",
};

const PKG: ExportPackage = {
  dir: "C:\\Users\\me\\AppData\\Local\\TaskDock\\agent-exports\\pkg-1",
  markdown_path: "C:\\Users\\me\\AppData\\Local\\TaskDock\\agent-exports\\pkg-1\\clipboard.md",
  manifest_path: "C:\\Users\\me\\AppData\\Local\\TaskDock\\agent-exports\\pkg-1\\manifest.json",
  files: ["clipboard.md", "manifest.json"],
  item_count: 3,
  summary: "已导出 3 项（图片 1 张）",
  warnings: [],
};

let toastSpy: ReturnType<typeof vi.fn>;

/** 后端探测快照：默认「刚扫描过」，可显式构造缓存命中与旧时间。 */
function snapshot(
  targets: AgentClipboardTarget[] = [TARGET],
  opts?: { cached?: boolean; probed_at_ms?: number },
): AgentTargetsSnapshot {
  return {
    targets,
    probed_at_ms: opts?.probed_at_ms ?? Date.now(),
    cached: opts?.cached ?? false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function openPanel() {
  fireEvent.click(screen.getByRole("button", { name: /导出给 Agent/ }));
}

function openCompat() {
  fireEvent.click(screen.getByRole("button", { name: /Agent 兼容信息/ }));
}

beforeEach(() => {
  vi.clearAllMocks();
  bridge.clipboardAgentTargets.mockResolvedValue(snapshot());
  bridge.clipboardExportForAgent.mockResolvedValue(PKG);
  clipboard.copyText.mockResolvedValue(true);
  toastSpy = vi.fn();
  useUiStore.setState({ toast: null, showToast: toastSpy as never });
});

afterEach(() => {
  cleanup();
});

describe("AgentExportPanel 信息架构", () => {
  it("默认收起，只显示入口且不加载 Agent 列表", () => {
    render(<AgentExportPanel targetType="group" targetId="g1" />);

    expect(screen.getByRole("button", { name: /导出给 Agent/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /导出本地文件包/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Agent 兼容信息/ })).toBeNull();
    expect(bridge.clipboardAgentTargets).not.toHaveBeenCalled();
  });

  it("展开后导出按钮立即可见，不等待 Agent 探测", () => {
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();

    expect(screen.getByRole("button", { name: /导出本地文件包/ })).toBeTruthy();
    expect(screen.getByText(/不会自动发送/)).toBeTruthy();
    expect(bridge.clipboardAgentTargets).not.toHaveBeenCalled();
  });

  it("有任务关联时说明包含任务上下文", () => {
    render(<AgentExportPanel targetType="group" targetId="g1" taskId="task-9" />);
    openPanel();

    expect(screen.getByText(/包含关联任务上下文/)).toBeTruthy();
  });

  it("导出说明默认收起，展开后列出技术边界", () => {
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();

    fireEvent.click(screen.getByRole("button", { name: /导出说明/ }));
    expect(screen.getByText(/manifest\.json/)).toBeTruthy();
    expect(screen.getByText(/不会自动上传或发送给任何 Agent/)).toBeTruthy();
    expect(screen.getByText(/是否被 Agent 接收无法自动验证/)).toBeTruthy();
  });
});

describe("AgentExportPanel 导出可靠性", () => {
  it("没有 Agent 时仍可导出", async () => {
    bridge.clipboardAgentTargets.mockResolvedValueOnce(snapshot([]));
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    openCompat();

    expect(await screen.findByText(/未发现已注册的 Agent/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /导出本地文件包/ }));

    await waitFor(() =>
      expect(bridge.clipboardExportForAgent).toHaveBeenCalledWith("group", "g1", null),
    );
    expect(await screen.findByText(PKG.dir)).toBeTruthy();
  });

  it("探测失败不影响本地导出，并给出明确原因", async () => {
    bridge.clipboardAgentTargets.mockRejectedValueOnce(new Error("探测超时"));
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    openCompat();

    expect(await screen.findByText(/读取 Agent 列表失败：探测超时/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /导出本地文件包/ }));

    await waitFor(() => expect(bridge.clipboardExportForAgent).toHaveBeenCalled());
    expect(await screen.findByText(PKG.dir)).toBeTruthy();
  });

  it("导出成功显示目录、Markdown 路径与复制操作", async () => {
    render(<AgentExportPanel targetType="group" targetId="g1" taskId="task-9" />);
    openPanel();

    fireEvent.click(screen.getByRole("button", { name: /导出本地文件包/ }));
    await waitFor(() =>
      expect(bridge.clipboardExportForAgent).toHaveBeenCalledWith("group", "g1", "task-9"),
    );

    expect(await screen.findByText(PKG.dir)).toBeTruthy();
    expect(screen.getByText(PKG.markdown_path)).toBeTruthy();
    expect(screen.getByText(/已导出 3 项/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制导出目录" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制 Markdown 路径" })).toBeTruthy();
    expect(toastSpy).toHaveBeenCalledWith(
      "已导出 3 项到本地文件（未发送）",
      expect.objectContaining({ kind: "success" }),
    );
  });

  it("导出失败给出原因，不弹模态框", async () => {
    bridge.clipboardExportForAgent.mockRejectedValueOnce(new Error("磁盘空间不足"));
    render(<AgentExportPanel targetType="item" targetId="i1" />);
    openPanel();

    fireEvent.click(screen.getByRole("button", { name: /导出本地文件包/ }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("导出失败：磁盘空间不足");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("路径复制调用受控写入并反馈", async () => {
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: /导出本地文件包/ }));

    fireEvent.click(await screen.findByRole("button", { name: "复制导出目录" }));
    await waitFor(() => expect(clipboard.copyText).toHaveBeenCalledWith(PKG.dir));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith("路径已复制", expect.objectContaining({ kind: "success" })),
    );
  });

  it("重开面板不显示上一次的导出成功状态", async () => {
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: /导出本地文件包/ }));
    expect(await screen.findByText(PKG.dir)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /导出给 Agent/ }));
    expect(screen.queryByText(PKG.dir)).toBeNull();

    openPanel();
    expect(screen.queryByText(PKG.dir)).toBeNull();
    expect(screen.getByRole("button", { name: /导出本地文件包/ })).toBeTruthy();
  });

  it("卸载后不会被过期导出请求更新", async () => {
    const d = deferred<ExportPackage>();
    bridge.clipboardExportForAgent.mockReturnValueOnce(d.promise);
    const { unmount } = render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: /导出本地文件包/ }));

    unmount();
    d.resolve(PKG);
    await d.promise;
    await Promise.resolve();

    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("卸载后忽略过期的 Agent 探测结果", async () => {
    const d = deferred<AgentTargetsSnapshot>();
    bridge.clipboardAgentTargets.mockReturnValueOnce(d.promise);
    const { unmount } = render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    openCompat();

    unmount();
    d.resolve(snapshot());
    await d.promise;
    await Promise.resolve();

    expect(toastSpy).not.toHaveBeenCalled();
  });
});

describe("AgentExportPanel Agent 兼容信息", () => {
  it("展开后才探测，收起再展开复用结果不重复探测", async () => {
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    expect(bridge.clipboardAgentTargets).not.toHaveBeenCalled();

    openCompat();
    expect(await screen.findByText("示例 Agent")).toBeTruthy();
    expect(bridge.clipboardAgentTargets).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Agent 兼容信息/ }));
    expect(screen.queryByText("示例 Agent")).toBeNull();

    openCompat();
    expect(await screen.findByText("示例 Agent")).toBeTruthy();
    expect(bridge.clipboardAgentTargets).toHaveBeenCalledTimes(1);
  });

  it("默认探测复用缓存，用户可主动强制重新探测", async () => {
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    openCompat();
    expect(await screen.findByText("示例 Agent")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /重新探测/ }));
    await waitFor(() => expect(bridge.clipboardAgentTargets).toHaveBeenCalledWith(true));
    expect(bridge.clipboardAgentTargets).toHaveBeenCalledTimes(2);
  });

  it("主列表只显示名称、一个主要状态和详情箭头，状态不暗示直接发送", async () => {
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    openCompat();

    expect(await screen.findByText("示例 Agent")).toBeTruthy();
    expect(screen.getByText("窗口可用")).toBeTruthy();
    expect(
      screen.getByText(/「窗口可用 \/ 已安装」只表示应用状态，不代表可以直接发送/),
    ).toBeTruthy();
    expect(screen.queryByText(/直接发送：/)).toBeNull();
  });

  it("单项展开后展示四种能力语义与验证状态", async () => {
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    openCompat();
    fireEvent.click(await screen.findByRole("button", { name: /示例 Agent/ }));

    expect(screen.getByText("直接发送")).toBeTruthy();
    expect(screen.getByText("不支持")).toBeTruthy();
    expect(screen.getByText("无可用接口")).toBeTruthy();

    expect(screen.getByText("官方文件导入")).toBeTruthy();
    // 结果值与证据状态都写作「未验证」
    expect(screen.getAllByText("未验证").length).toBe(2);

    expect(screen.getByText("桌面逐项粘贴")).toBeTruthy();
    expect(screen.getByText("可手动触发")).toBeTruthy();
    expect(screen.getByText("检测到可交互窗口")).toBeTruthy();

    expect(screen.getByText("本地导出")).toBeTruthy();
    expect(screen.getByText("可用")).toBeTruthy();
    expect(screen.getByText("本地文件导出")).toBeTruthy();

    expect(screen.getByText("限制说明")).toBeTruthy();
    expect(screen.getByText(/不会自动上传或发送/)).toBeTruthy();
  });

  it("未安装的 Agent 只显示未安装状态", async () => {
    const notInstalled: AgentClipboardTarget = {
      ...TARGET,
      source_id: "agent-2",
      display_name: "未安装 Agent",
      installed: false,
      window_present: false,
      evidence: "not-installed",
      desktop_paste: { supported: false, evidence: "not-installed", note: "未安装，无法桌面粘贴或发送。" },
    };
    bridge.clipboardAgentTargets.mockResolvedValueOnce(snapshot([notInstalled]));
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    openCompat();

    expect(await screen.findByText("未安装")).toBeTruthy();
    expect(screen.queryByText("窗口可用")).toBeNull();
  });

  it("长名称单行省略、长说明完整换行不丢内容", async () => {
    const longName = "这是一个名称非常长且包含技术标识的 Agent 客户端（OpenCode Experimental Build 2026.11）";
    const longNote =
      "限制说明非常长：该 Agent 的文件导入接口未验证，导出包需要用户在应用内手动附加，且不会绕过任何权限或使用未公开协议，接收结果也无法自动确认。";
    const longTarget: AgentClipboardTarget = {
      ...TARGET,
      source_id: "agent-long",
      display_name: longName,
      direct_send: { ...TARGET.direct_send, note: longNote },
      file_import: { ...TARGET.file_import, note: longNote },
      desktop_paste: { ...TARGET.desktop_paste, note: longNote },
    };
    bridge.clipboardAgentTargets.mockResolvedValueOnce(snapshot([longTarget]));
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    openCompat();

    const name = await screen.findByText(longName);
    expect(name.className).toContain("clip-agent-name");
    expect(name.getAttribute("title")).toBe(longName);

    fireEvent.click(screen.getByRole("button", { name: new RegExp(longName.slice(0, 12)) }));
    expect(await screen.findByText(longNote)).toBeTruthy();
    // 长说明在详情里是完整文本节点，不是被截断的省略号。
    expect(screen.getByText(longNote).textContent).toBe(longNote);
  });
});

describe("AgentExportPanel 请求身份与生命周期", () => {
  const PKG_A: ExportPackage = { ...PKG, dir: "C:\\exports\\pkg-a" };
  const PKG_B: ExportPackage = { ...PKG, dir: "C:\\exports\\pkg-b" };

  function clickExport() {
    fireEvent.click(screen.getByRole("button", { name: /导出本地文件包/ }));
  }

  function closePanel() {
    fireEvent.click(screen.getByRole("button", { name: /导出给 Agent/ }));
  }

  it("切换分组后，旧分组的导出结果不写回新目标", async () => {
    const dA = deferred<ExportPackage>();
    bridge.clipboardExportForAgent.mockReturnValueOnce(dA.promise);
    const { rerender } = render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    clickExport();

    rerender(<AgentExportPanel targetType="group" targetId="g2" />);
    openPanel();

    dA.resolve(PKG_A);
    await dA.promise;
    await Promise.resolve();

    expect(screen.queryByText(PKG_A.dir)).toBeNull();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("B 先完成、A 后完成时保留 B 的结果，且旧结果不清掉新请求的 loading", async () => {
    const dA = deferred<ExportPackage>();
    const dB = deferred<ExportPackage>();
    bridge.clipboardExportForAgent
      .mockReturnValueOnce(dA.promise)
      .mockReturnValueOnce(dB.promise);
    const { rerender } = render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    clickExport();

    rerender(<AgentExportPanel targetType="group" targetId="g2" />);
    openPanel();
    clickExport();

    // A 的迟到结果返回时 B 仍在进行：不能覆盖 B，也不能把 B 的 loading 清掉。
    dA.resolve(PKG_A);
    await dA.promise;
    await Promise.resolve();
    expect(screen.getByRole("button", { name: /导出本地文件包/ }).getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(screen.queryByText(PKG_A.dir)).toBeNull();

    dB.resolve(PKG_B);
    expect(await screen.findByText(PKG_B.dir)).toBeTruthy();
    expect(screen.queryByText(PKG_A.dir)).toBeNull();
    expect(toastSpy).toHaveBeenCalledTimes(1);
  });

  it("关闭面板后旧导出返回，不弹成功提示，重开也不显示旧路径", async () => {
    const d = deferred<ExportPackage>();
    bridge.clipboardExportForAgent.mockReturnValueOnce(d.promise);
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    clickExport();

    closePanel();
    d.resolve(PKG_A);
    await d.promise;
    await Promise.resolve();

    expect(toastSpy).not.toHaveBeenCalled();
    openPanel();
    expect(screen.queryByText(PKG_A.dir)).toBeNull();
  });

  it("关闭再重开后旧导出才返回，仍不写入新上下文", async () => {
    const d = deferred<ExportPackage>();
    bridge.clipboardExportForAgent.mockReturnValueOnce(d.promise);
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    clickExport();

    closePanel();
    openPanel();
    d.resolve(PKG_A);
    await d.promise;
    await Promise.resolve();

    expect(screen.queryByText(PKG_A.dir)).toBeNull();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("导出失败后可重新导出成功", async () => {
    bridge.clipboardExportForAgent
      .mockRejectedValueOnce(new Error("磁盘已满"))
      .mockResolvedValueOnce(PKG);
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();

    clickExport();
    expect((await screen.findByRole("alert")).textContent).toContain("导出失败：磁盘已满");

    clickExport();
    expect(await screen.findByText(PKG.dir)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("同一上下文连点只发起一次导出", async () => {
    const d = deferred<ExportPackage>();
    bridge.clipboardExportForAgent.mockReturnValueOnce(d.promise);
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();

    clickExport();
    clickExport();
    await waitFor(() => expect(bridge.clipboardExportForAgent).toHaveBeenCalledTimes(1));

    d.resolve(PKG);
    expect(await screen.findByText(PKG.dir)).toBeTruthy();
    expect(toastSpy).toHaveBeenCalledTimes(1);
  });

  it("探测中收起兼容信息，完成后展开复用同一次结果", async () => {
    const d = deferred<AgentTargetsSnapshot>();
    bridge.clipboardAgentTargets.mockReturnValueOnce(d.promise);
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    openCompat();
    expect(screen.getByText(/正在探测本机 Agent/)).toBeTruthy();

    openCompat();
    d.resolve(snapshot());
    await act(async () => {
      await d.promise;
    });

    openCompat();
    expect(await screen.findByText("示例 Agent")).toBeTruthy();
    expect(bridge.clipboardAgentTargets).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/上次探测/)).toBeTruthy();
  });

  it("探测失败后可重试成功", async () => {
    bridge.clipboardAgentTargets
      .mockRejectedValueOnce(new Error("探测被拒绝"))
      .mockResolvedValueOnce(snapshot());
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    openCompat();

    expect(await screen.findByText(/读取 Agent 列表失败：探测被拒绝/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));

    expect(await screen.findByText("示例 Agent")).toBeTruthy();
    expect(screen.queryByText(/读取 Agent 列表失败/)).toBeNull();
    expect(bridge.clipboardAgentTargets).toHaveBeenLastCalledWith(true);
  });

  it("切换目标后旧导出错误不污染新目标", async () => {
    const dA = deferred<ExportPackage>();
    bridge.clipboardExportForAgent.mockReturnValueOnce(dA.promise);
    const { rerender } = render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    clickExport();

    rerender(<AgentExportPanel targetType="item" targetId="i1" />);
    openPanel();

    dA.reject(new Error("旧目标导出失败"));
    await dA.promise.catch(() => undefined);
    await Promise.resolve();

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("关闭再展开时导出说明与 Agent 兼容详情默认收起", async () => {
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: /导出说明/ }));
    openCompat();
    expect(await screen.findByText("示例 Agent")).toBeTruthy();

    closePanel();
    openPanel();

    expect(screen.queryByText(/manifest\.json/)).toBeNull();
    expect(screen.queryByText("示例 Agent")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /导出说明/ }));
    expect(screen.getByText(/manifest\.json/)).toBeTruthy();
  });

  it("缓存命中显示约 N 分钟前探测，不把响应时间当作扫描时间", async () => {
    bridge.clipboardAgentTargets.mockResolvedValueOnce(
      snapshot([TARGET], { cached: true, probed_at_ms: Date.now() - 3 * 60 * 1000 }),
    );
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    openCompat();

    expect(await screen.findByText("示例 Agent")).toBeTruthy();
    expect(screen.getByText(/缓存结果 · 约 3 分钟前探测/)).toBeTruthy();
    expect(screen.queryByText(/^上次探测/)).toBeNull();
  });

  it("重新探测后展示新的扫描时间且不再标记缓存", async () => {
    bridge.clipboardAgentTargets
      .mockResolvedValueOnce(
        snapshot([TARGET], { cached: true, probed_at_ms: Date.now() - 4 * 60 * 1000 }),
      )
      .mockResolvedValueOnce(snapshot([TARGET], { cached: false, probed_at_ms: Date.now() }));
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    openCompat();

    expect(await screen.findByText("示例 Agent")).toBeTruthy();
    expect(screen.getByText(/缓存结果 · 约 4 分钟前探测/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /重新探测/ }));
    await waitFor(() =>
      expect(bridge.clipboardAgentTargets).toHaveBeenLastCalledWith(true),
    );
    expect(await screen.findByText(/上次探测/)).toBeTruthy();
    expect(screen.queryByText(/缓存结果/)).toBeNull();
  });

  it("刷新失败时保留上次有效列表与探测时间，并明确标注", async () => {
    bridge.clipboardAgentTargets
      .mockResolvedValueOnce(snapshot([TARGET], { probed_at_ms: Date.now() }))
      .mockRejectedValueOnce(new Error("刷新失败"));
    render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    openCompat();

    expect(await screen.findByText("示例 Agent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /重新探测/ }));

    expect(await screen.findByText(/读取 Agent 列表失败：刷新失败/)).toBeTruthy();
    expect(screen.getByText("示例 Agent")).toBeTruthy();
    expect(screen.getByText(/本次刷新失败，以下为上次有效结果/)).toBeTruthy();
  });

  it("切换目标后复制路径不产生陈旧提示", async () => {
    const d = deferred<boolean>();
    clipboard.copyText.mockReturnValueOnce(d.promise);
    const { rerender } = render(<AgentExportPanel targetType="group" targetId="g1" />);
    openPanel();
    clickExport();
    await screen.findByText(PKG.dir);

    fireEvent.click(screen.getByRole("button", { name: "复制导出目录" }));
    rerender(<AgentExportPanel targetType="item" targetId="i1" />);
    d.resolve(true);
    await d.promise;
    await Promise.resolve();

    expect(toastSpy).not.toHaveBeenCalledWith("路径已复制", expect.anything());
  });

  it("切换 taskId 后旧任务导出完成不写入新任务", async () => {
    const d = deferred<ExportPackage>();
    bridge.clipboardExportForAgent.mockReturnValueOnce(d.promise);
    const { rerender } = render(
      <AgentExportPanel targetType="group" targetId="g1" taskId="task-1" />,
    );
    openPanel();
    clickExport();

    rerender(<AgentExportPanel targetType="group" targetId="g1" taskId="task-2" />);
    openPanel();

    d.resolve(PKG);
    await d.promise;
    await Promise.resolve();

    expect(screen.queryByText(PKG.dir)).toBeNull();
    expect(toastSpy).not.toHaveBeenCalled();
  });
});
