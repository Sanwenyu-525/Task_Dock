//! Agent 接入运行态 store 行为测试：跨卸载保留、防重复执行、失败/回滚反馈。
//!
//! 这些状态不再绑定 AgentPanel 生命周期：安装 / 验证 / 卸载过程中切换主 Tab，
//! 后端仍在运行，重新进入必须读到真实步骤与结果，而不是误报取消。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const preview = vi.fn();
const install = vi.fn();
const verify = vi.fn();
const uninstall = vi.fn();

vi.mock("../lib/bridge", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/bridge")>(),
  adapterPreview: (...a: unknown[]) => preview(...a),
  adapterInstall: (...a: unknown[]) => install(...a),
  adapterVerify: (...a: unknown[]) => verify(...a),
  adapterUninstall: (...a: unknown[]) => uninstall(...a),
}));

import { useAgentOnboardingStore, onboardBusy } from "./useAgentOnboardingStore";
import { useAgentsStore } from "./useAgentsStore";
import { useUiStore } from "./useUiStore";
import type { DiscoveredAgent } from "../lib/bridge";

const agent = {
  source_id: "codex",
  display_name: "Codex CLI",
  transport_kind: "transport",
  installed: true,
  version: "1.0",
  install_paths: [],
  config_homes: [],
  install_method: "config-home-or-executable",
  running_instances: [],
  capabilities: [],
  supported_events: [],
  docs_url: "",
  limitations: [],
  registered: true,
  enabled: true,
  configured: true,
  verified: false,
  transport_verified: false,
  real_event_seen: false,
  last_event_at: null,
  last_real_event_at: null,
  health_state: "awaiting-first-event",
  connection_state: "unknown",
} as unknown as DiscoveredAgent;

const load = vi.fn(async () => {});
const showToast = vi.fn();

beforeEach(() => {
  preview.mockReset().mockResolvedValue({});
  install.mockReset().mockResolvedValue({});
  verify.mockReset().mockResolvedValue({ ok: true });
  uninstall.mockReset().mockResolvedValue({});
  load.mockClear();
  showToast.mockClear();
  useAgentsStore.setState({ load });
  useUiStore.setState({ showToast });
  useAgentOnboardingStore.setState({ wizard: null, revision: 0 });
});

afterEach(() => {
  useAgentOnboardingStore.setState({ wizard: null, revision: 0 });
  vi.clearAllMocks();
});

describe("接入运行态跨卸载保留", () => {
  it("安装连点只执行一次；验证完成后停在结果页", async () => {
    await useAgentOnboardingStore.getState().open(agent);
    expect(useAgentOnboardingStore.getState().wizard?.step).toBe("preview");

    const first = useAgentOnboardingStore.getState().install();
    const second = useAgentOnboardingStore.getState().install();
    expect(useAgentOnboardingStore.getState().wizard?.step).toBe("installing");
    await Promise.all([first, second]);

    expect(install).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
    const state = useAgentOnboardingStore.getState().wizard;
    expect(state).toMatchObject({ step: "result", installOk: true });
    expect(state?.verify).toMatchObject({ ok: true });
  });

  it("安装失败：停在结果页并给出失败原因，可关闭；不误报取消", async () => {
    install.mockRejectedValueOnce(new Error("写入配置失败：权限不足"));
    await useAgentOnboardingStore.getState().open(agent);
    await useAgentOnboardingStore.getState().install();

    expect(useAgentOnboardingStore.getState().wizard).toMatchObject({
      step: "result",
      installOk: false,
      installError: "写入配置失败：权限不足",
    });
    expect(verify).not.toHaveBeenCalled();
    expect(onboardBusy(useAgentOnboardingStore.getState().wizard)).toBe(false);

    // 失败结果可以关闭，且不会留下运行态
    useAgentOnboardingStore.getState().dismiss();
    expect(useAgentOnboardingStore.getState().wizard).toBeNull();
  });

  it("验证失败：写入仍成功、结果页保留原因，可重新验证", async () => {
    verify.mockResolvedValueOnce({ ok: false, reason: "未收到测试事件" });
    await useAgentOnboardingStore.getState().open(agent);
    await useAgentOnboardingStore.getState().install();

    const state = useAgentOnboardingStore.getState().wizard;
    expect(state).toMatchObject({ step: "result", installOk: true });
    expect(state?.verify).toMatchObject({ ok: false, reason: "未收到测试事件" });

    verify.mockResolvedValueOnce({ ok: true });
    await useAgentOnboardingStore.getState().retryVerify();
    expect(verify).toHaveBeenCalledTimes(2);
    expect(useAgentOnboardingStore.getState().wizard).toMatchObject({
      step: "result",
      verify: { ok: true },
      verifyError: "",
    });
  });

  it("验证抛错：明确展示错误而不是成功", async () => {
    verify.mockRejectedValueOnce(new Error("验证命令不可用"));
    await useAgentOnboardingStore.getState().open(agent);
    await useAgentOnboardingStore.getState().install();

    const state = useAgentOnboardingStore.getState().wizard;
    expect(state).toMatchObject({ step: "result", installOk: true, verifyError: "验证命令不可用" });
  });

  it("回滚失败：保留结果页与回滚原因，可再次尝试", async () => {
    await useAgentOnboardingStore.getState().open(agent);
    await useAgentOnboardingStore.getState().install();

    uninstall.mockRejectedValueOnce(new Error("恢复备份失败"));
    await useAgentOnboardingStore.getState().uninstall();

    expect(uninstall).toHaveBeenCalledTimes(1);
    expect(useAgentOnboardingStore.getState().wizard).toMatchObject({
      step: "result",
      rollbackError: "恢复备份失败",
    });
  });

  it("回滚成功：关闭向导且不残留运行态", async () => {
    await useAgentOnboardingStore.getState().open(agent);
    await useAgentOnboardingStore.getState().install();
    await useAgentOnboardingStore.getState().uninstall();

    expect(uninstall).toHaveBeenCalledTimes(1);
    expect(useAgentOnboardingStore.getState().wizard).toBeNull();
  });

  it("运行中拒绝关闭与切换来源；空闲时可关闭", async () => {
    await useAgentOnboardingStore.getState().open(agent);
    let resolveInstall: (v: unknown) => void = () => {};
    install.mockReturnValueOnce(
      new Promise<unknown>((resolve) => {
        resolveInstall = resolve;
      }),
    );

    const running = useAgentOnboardingStore.getState().install();
    expect(onboardBusy(useAgentOnboardingStore.getState().wizard)).toBe(true);

    useAgentOnboardingStore.getState().dismiss();
    expect(useAgentOnboardingStore.getState().wizard?.agent.source_id).toBe("codex");

    await useAgentOnboardingStore.getState().open({
      ...agent,
      source_id: "trae",
      display_name: "Trae",
    });
    // 仍在安装：不允许换来源覆盖运行态
    expect(useAgentOnboardingStore.getState().wizard?.agent.source_id).toBe("codex");
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("进行中"),
      expect.objectContaining({ kind: "warning" }),
    );

    resolveInstall({});
    await running;
    expect(useAgentOnboardingStore.getState().wizard?.step).toBe("result");
  });
});
