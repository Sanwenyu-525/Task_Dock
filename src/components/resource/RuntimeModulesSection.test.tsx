/**
 * @vitest-environment jsdom
 */
//! 功能运行分区：只读状态展示、真实暂停写入、共享模块无按钮、过渡态如实显示。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const bridge = vi.hoisted(() => ({
  lifecycleStatus: vi.fn(),
  updateSettings: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...bridge };
});

vi.mock("../../hooks/useLocale", () => ({
  useLocale: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key}|${JSON.stringify(vars)}` : key,
  }),
}));

import RuntimeModulesSection from "./RuntimeModulesSection";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useUiStore } from "../../store/useUiStore";
import { resetLifecycleStoreForTest, useLifecycleStore } from "../../store/useLifecycleStore";
import type { ModuleRuntimeStatus, Settings } from "../../lib/bridge";

function status(id: string, patch: Partial<ModuleRuntimeStatus> = {}): ModuleRuntimeStatus {
  return {
    id,
    category: "resident",
    state: "running",
    intent: "running",
    controllable: true,
    background: [],
    detail: {},
    error: null,
    ...patch,
  };
}

const SETTINGS = {
  clipboard_enabled: true,
  clipboard_paused: false,
  reminders_paused: false,
  shelf_auto_cleanup_enabled: true,
  actions_enabled: true,
  tts_enabled: false,
  audio_sound_enabled: true,
} as unknown as Settings;

beforeEach(() => {
  cleanup();
  resetLifecycleStoreForTest();
  bridge.lifecycleStatus.mockReset();
  bridge.updateSettings.mockReset();
  bridge.getSettings.mockReset();
  bridge.updateSettings.mockResolvedValue(SETTINGS);
  bridge.getSettings.mockResolvedValue(SETTINGS);
  useSettingsStore.setState({ settings: SETTINGS });
});

describe("RuntimeModulesSection", () => {
  it("展示实际状态与后台活动，且不轮询", async () => {
    bridge.lifecycleStatus.mockResolvedValue([
      status("clipboard", { background: ["clipboard-monitor"] }),
      status("agents", {
        category: "shared",
        controllable: false,
        background: ["agent-ingest-pipeline"],
      }),
      status("ocr", { category: "ondemand", state: "idle", controllable: false }),
    ]);
    render(<RuntimeModulesSection />);
    await screen.findByText("lifecycle.module.clipboard.label");
    expect(bridge.lifecycleStatus).toHaveBeenCalledTimes(1);
    const clipboard = document.querySelector('[data-module-id="clipboard"]') as HTMLElement;
    expect(within(clipboard).getByText("lifecycle.state.running")).toBeTruthy();
    // 后台活动明细按需展开，不再默认堆在行内。
    fireEvent.click(clipboard.querySelector(".runtime-row-toggle") as HTMLElement);
    expect(within(clipboard).getByText("lifecycle.background.clipboardMonitor")).toBeTruthy();
    // 共享基础设施明确说明不可单独暂停，且没有控制按钮（行展开按钮除外）
    const shared = document.querySelector('[data-module-id="agents"]') as HTMLElement;
    expect(within(shared).getByText("resource.modules.sharedManaged")).toBeTruthy();
    expect(shared.querySelector(".runtime-action button")).toBeNull();
    // 按需模块显示 idle，不造暂停按钮
    const ondemand = document.querySelector('[data-module-id="ocr"]') as HTMLElement;
    expect(within(ondemand).getByText("lifecycle.state.idle")).toBeTruthy();
    expect(ondemand.querySelector(".runtime-action button")).toBeNull();
  });

  it("模块详情按需展开：默认单行，展开后显示作用范围与控制方式", async () => {
    bridge.lifecycleStatus.mockResolvedValue([
      status("clipboard", { background: ["clipboard-monitor"] }),
    ]);
    render(<RuntimeModulesSection />);
    await screen.findByText("lifecycle.module.clipboard.label");

    const row = document.querySelector('[data-module-id="clipboard"]') as HTMLElement;
    expect(row.querySelector(".runtime-row-detail")).toBeNull();
    const toggle = row.querySelector(".runtime-row-toggle") as HTMLElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(row.querySelector(".runtime-row-detail")).toBeTruthy();
    expect(within(row).getByText("resource.modules.detailScope")).toBeTruthy();
    expect(within(row).getByText("resource.modules.detailControl")).toBeTruthy();
    expect(within(row).getByText("lifecycle.background.clipboardMonitor")).toBeTruthy();
    expect(within(row).getByText("resource.modules.controlResident")).toBeTruthy();

    // 再次点击折叠，详情不残留。
    fireEvent.click(toggle);
    expect(row.querySelector(".runtime-row-detail")).toBeNull();
  });

  it("暂停写既有设置键，成功后按真实状态切换按钮", async () => {
    bridge.updateSettings.mockResolvedValue({
      ...SETTINGS,
      clipboard_paused: true,
    } as Settings);
    bridge.lifecycleStatus
      .mockResolvedValueOnce([status("clipboard")])
      .mockResolvedValue([
        status("clipboard", { state: "paused", intent: "paused" }),
      ]);
    render(<RuntimeModulesSection />);
    const row = (await screen.findByText("lifecycle.module.clipboard.label")).closest(
      "li",
    ) as HTMLElement;
    const button = within(row).getByRole("button", { name: /lifecycle\.pauseAria/ });
    fireEvent.click(button);
    await waitFor(() =>
      expect(bridge.updateSettings).toHaveBeenCalledWith({ clipboard_paused: true }),
    );
    await waitFor(() => {
      expect(
        within(row).getByRole("button", { name: /lifecycle\.resumeAria/ }),
      ).toBeTruthy();
    });
    expect(within(row).getByText("lifecycle.state.paused")).toBeTruthy();
  });

  it("隐藏时正在进行的暂停操作仍会完成并更新真实状态", async () => {
    let resolveUpdate!: (value: Settings) => void;
    bridge.updateSettings.mockImplementationOnce(
      () => new Promise<Settings>((resolve) => (resolveUpdate = resolve)),
    );
    bridge.lifecycleStatus
      .mockResolvedValueOnce([status("clipboard")])
      .mockResolvedValue([status("clipboard", { state: "paused", intent: "paused" })]);
    const view = render(<RuntimeModulesSection active />);
    const row = (await screen.findByText("lifecycle.module.clipboard.label")).closest(
      "li",
    ) as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /lifecycle\.pauseAria/ }));
    await waitFor(() => expect(bridge.updateSettings).toHaveBeenCalledTimes(1));

    // 页面隐藏不中断已发起的操作：写库完成后仍按真实状态刷新一次
    view.rerender(<RuntimeModulesSection active={false} />);
    await act(async () => {
      resolveUpdate({ ...SETTINGS, clipboard_paused: true } as Settings);
    });
    await waitFor(() =>
      expect(useLifecycleStore.getState().statuses?.[0].state).toBe("paused"),
    );
    expect(bridge.lifecycleStatus).toHaveBeenCalledTimes(2);
  });

  it("线程仍在收尾时显示 pausing，不提前报告已暂停", async () => {
    bridge.lifecycleStatus.mockResolvedValue([
      status("clipboard", { state: "pausing", intent: "paused" }),
    ]);
    render(<RuntimeModulesSection />);
    await screen.findByText("lifecycle.module.clipboard.label");
    expect(screen.getByText("lifecycle.state.pausing")).toBeTruthy();
  });

  it("状态查询失败显示真实错误并保留局部重试入口", async () => {
    bridge.lifecycleStatus.mockRejectedValue(new Error("IPC 失败"));
    render(<RuntimeModulesSection />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("resource.modules.error");
    // 正常刷新统一走页头；这里只保留失败时的局部重试
    expect(within(alert).getByRole("button", { name: "common.retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "resource.modules.refresh" })).toBeNull();
    expect(useLifecycleStore.getState().statuses).toBeNull();

    bridge.lifecycleStatus.mockResolvedValue([status("clipboard")]);
    fireEvent.click(within(alert).getByRole("button", { name: "common.retry" }));
    expect(await screen.findByText("lifecycle.module.clipboard.label")).toBeTruthy();
    expect(bridge.lifecycleStatus).toHaveBeenCalledTimes(2);
  });

  it("隐藏时不因设置变化发起查询，重新显示后读取最新状态", async () => {
    bridge.lifecycleStatus.mockResolvedValue([status("clipboard")]);
    const view = render(<RuntimeModulesSection active />);
    await screen.findByText("lifecycle.module.clipboard.label");
    expect(bridge.lifecycleStatus).toHaveBeenCalledTimes(1);

    // 页面隐藏（组件仍挂载），后台设置变化不产生新的状态查询
    view.rerender(<RuntimeModulesSection active={false} />);
    await act(async () => {
      useSettingsStore.setState({
        settings: { ...SETTINGS, clipboard_paused: true } as Settings,
      });
    });
    expect(bridge.lifecycleStatus).toHaveBeenCalledTimes(1);

    // 重新显示：读取一次最新状态（可能已因外部入口改变）
    view.rerender(<RuntimeModulesSection active />);
    await waitFor(() => expect(bridge.lifecycleStatus).toHaveBeenCalledTimes(2));
  });

  it("设置页/其他入口写入后，按钮意图立即按最新设置同步", async () => {
    bridge.lifecycleStatus.mockResolvedValue([
      status("actions", { category: "task", state: "idle" }),
    ]);
    render(<RuntimeModulesSection active />);
    const row = (await screen.findByText("lifecycle.module.actions.label")).closest(
      "li",
    ) as HTMLElement;
    expect(
      within(row).getByRole("button", { name: /lifecycle\.pauseAria/ }),
    ).toBeTruthy();

    // 模拟设置页直接写 actions_paused：不等生命周期查询返回，按钮必须立刻变恢复。
    await act(async () => {
      useSettingsStore.setState({
        settings: { ...SETTINGS, actions_paused: true } as Settings,
      });
    });
    expect(
      within(row).getByRole("button", { name: /lifecycle\.resumeAria/ }),
    ).toBeTruthy();
  });

  it("设置页写入链成功后，其他入口按钮立即同步（走真实 update 队列）", async () => {
    bridge.updateSettings.mockImplementation(async (patch: Partial<Settings>) => ({
      ...SETTINGS,
      ...patch,
    }));
    bridge.lifecycleStatus.mockResolvedValue([
      status("actions", { category: "task", state: "idle" }),
    ]);
    render(<RuntimeModulesSection active />);
    const row = (await screen.findByText("lifecycle.module.actions.label")).closest(
      "li",
    ) as HTMLElement;

    await act(async () => {
      await useSettingsStore.getState().update({ actions_paused: true });
    });

    expect(bridge.updateSettings).toHaveBeenCalledWith({ actions_paused: true });
    expect(
      within(row).getByRole("button", { name: /lifecycle\.resumeAria/ }),
    ).toBeTruthy();
  });

  it("写库成功但状态查询失败：提示“未确认”，不冒充暂停完成", async () => {
    bridge.updateSettings.mockImplementation(async (patch: Partial<Settings>) => ({
      ...SETTINGS,
      ...patch,
    }));
    bridge.lifecycleStatus
      .mockResolvedValueOnce([status("clipboard")])
      .mockRejectedValueOnce(new Error("状态查询失败"));
    const toast = vi.fn();
    useUiStore.setState({ showToast: toast });
    render(<RuntimeModulesSection active />);
    const row = (await screen.findByText("lifecycle.module.clipboard.label")).closest(
      "li",
    ) as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: /lifecycle\.pauseAria/ }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const [message, options] = toast.mock.calls[0];
    expect(String(message)).toContain("lifecycle.statusUnconfirmed");
    expect(options).toEqual({ kind: "warning" });
    // 配置已写入 → 意图是暂停；但状态未确认，不能出现“成功”提示。
    expect(
      within(row).getByRole("button", { name: /lifecycle\.resumeAria/ }),
    ).toBeTruthy();
  });

  it("长期停用模块不提供假恢复按钮，点击不写暂停字段", async () => {
    bridge.lifecycleStatus.mockResolvedValue([
      status("clipboard", { state: "stopped", intent: "stopped" }),
    ]);
    useSettingsStore.setState({
      settings: {
        ...SETTINGS,
        clipboard_enabled: false,
        clipboard_paused: true,
      } as Settings,
    });
    render(<RuntimeModulesSection active />);
    const row = (await screen.findByText("lifecycle.module.clipboard.label")).closest(
      "li",
    ) as HTMLElement;
    const button = within(row).getByRole("button", { name: /lifecycle\.moduleDisabledAria/ });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(bridge.updateSettings).not.toHaveBeenCalled();
  });

  it("状态刷新失败：旧状态标记为未确认，不冒充实时状态", async () => {
    bridge.lifecycleStatus
      .mockResolvedValueOnce([status("clipboard")])
      .mockRejectedValue(new Error("IPC 失败"));
    render(<RuntimeModulesSection active />);
    await screen.findByText("lifecycle.module.clipboard.label");
    expect(screen.queryByText("resource.modules.unverified")).toBeNull();

    // 设置变化触发重查；重查失败后旧快照仍在，但必须标注未确认。
    await act(async () => {
      useSettingsStore.setState({
        settings: { ...SETTINGS, clipboard_paused: true } as Settings,
      });
    });
    await waitFor(() => expect(bridge.lifecycleStatus).toHaveBeenCalledTimes(2));

    expect(await screen.findByText("resource.modules.staleFailed")).toBeTruthy();
    expect(screen.getByText("resource.modules.unverified")).toBeTruthy();
    const row = document.querySelector('[data-module-id="clipboard"]') as HTMLElement;
    expect(row.className).toContain("is-unverified");
    // 旧状态仍显示，但已有失败错误入口，不把失败吞掉。
    expect(screen.getByRole("alert").textContent).toContain("resource.modules.error");
  });

  it("可见时相关设置变化才重查状态", async () => {
    bridge.lifecycleStatus.mockResolvedValue([status("clipboard")]);
    render(<RuntimeModulesSection active />);
    await screen.findByText("lifecycle.module.clipboard.label");
    expect(bridge.lifecycleStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      useSettingsStore.setState({
        settings: { ...SETTINGS, clipboard_paused: true } as Settings,
      });
    });
    await waitFor(() => expect(bridge.lifecycleStatus).toHaveBeenCalledTimes(2));
  });
});
