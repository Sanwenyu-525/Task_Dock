//! Agent 接入向导的运行态。
//!
//! 安装 / 验证 / 卸载是可能持续数秒的后端操作，不能绑定在页面组件生命周期上：
//! 向导改为页内视图后，切换主 Tab 会卸载组件，但运行态、结果和错误仍保留在这里。
//! 页面重新进入时直接恢复当前步骤，读的是真实状态，不会误报「已取消」，也不会重复执行。

import { create } from "zustand";
import {
  adapterInstall,
  adapterPreview,
  adapterUninstall,
  adapterVerify,
  type DiscoveredAgent,
} from "../lib/bridge";
import { errorMessage } from "../lib/errors";
import { useAgentsStore } from "./useAgentsStore";
import { useUiStore } from "./useUiStore";

export type OnboardStep = "preview" | "installing" | "verifying" | "result" | "uninstalling";

export interface VerifyResult {
  ok?: boolean;
  reason?: string;
  note?: string;
  received_at?: string;
}

export interface OnboardState {
  agent: DiscoveredAgent;
  step: OnboardStep;
  preview: Record<string, unknown> | null;
  previewError: string;
  installError: string;
  verifyError: string;
  rollbackError: string;
  /** 写入是否成功：仅成功后才允许回滚，失败时后端已按契约自动回滚。 */
  installOk: boolean;
  verify: VerifyResult | null;
}

interface OnboardStore {
  wizard: OnboardState | null;
  /** 接入操作完成后的修订号：面板据此重扫本地发现结果（不轮询）。 */
  revision: number;
  open: (agent: DiscoveredAgent) => Promise<void>;
  install: () => Promise<void>;
  retryVerify: () => Promise<void>;
  uninstall: () => Promise<void>;
  dismiss: () => void;
}

function busyStep(step: OnboardStep): boolean {
  return step === "installing" || step === "verifying" || step === "uninstalling";
}

const toast = (message: string, kind: "success" | "error" | "info" | "warning") =>
  useUiStore.getState().showToast(message, { kind, code: "agent-onboard" });

async function refreshSources() {
  await useAgentsStore.getState().load();
}

export const useAgentOnboardingStore = create<OnboardStore>((set, get) => ({
  wizard: null,
  revision: 0,

  open: async (agent) => {
    const current = get().wizard;
    if (current && busyStep(current.step)) {
      toast("接入操作进行中，请等待完成后再切换来源", "warning");
      return;
    }
    set({
      wizard: {
        agent,
        step: "preview",
        preview: null,
        previewError: "",
        installError: "",
        verifyError: "",
        rollbackError: "",
        installOk: false,
        verify: null,
      },
    });
    try {
      const preview = await adapterPreview(agent.source_id);
      set((s) =>
        s.wizard?.agent.source_id === agent.source_id
          ? { wizard: { ...s.wizard, preview } }
          : s,
      );
    } catch (e) {
      set((s) =>
        s.wizard?.agent.source_id === agent.source_id
          ? { wizard: { ...s.wizard, previewError: errorMessage(e) } }
          : s,
      );
    }
  },

  install: async () => {
    const w = get().wizard;
    if (!w || w.step !== "preview" || !w.preview) return;
    set({ wizard: { ...w, step: "installing", installError: "", verifyError: "", rollbackError: "" } });
    try {
      await adapterInstall(w.agent.source_id);
    } catch (e) {
      set((s) =>
        s.wizard
          ? {
              wizard: {
                ...s.wizard,
                step: "result",
                installOk: false,
                installError: errorMessage(e),
              },
            }
          : s,
      );
      set({ revision: get().revision + 1 });
      toast(`接入安装失败：${errorMessage(e)}`, "error");
      await refreshSources();
      return;
    }
    set((s) => (s.wizard ? { wizard: { ...s.wizard, step: "verifying" } } : s));
    let verify: VerifyResult | null = null;
    let verifyError = "";
    try {
      verify = (await adapterVerify(w.agent.source_id)) as VerifyResult;
    } catch (e) {
      verifyError = errorMessage(e);
    }
    set((s) =>
      s.wizard
        ? {
            wizard: {
              ...s.wizard,
              step: "result",
              installOk: true,
              verify,
              verifyError,
            },
          }
        : s,
    );
    set({ revision: get().revision + 1 });
    const ok = verify?.ok === true;
    toast(
      verifyError
        ? `接入验证失败：${verifyError}`
        : ok
          ? "接入配置已写入，自测链路通过（不代表宿主已产生真实事件）"
          : `接入配置已写入，但验证未通过：${verify?.reason ?? "未知原因"}`,
      verifyError || !ok ? "warning" : "success",
    );
    await refreshSources();
  },

  retryVerify: async () => {
    const w = get().wizard;
    if (!w || w.step !== "result" || busyStep(w.step)) return;
    set((s) => (s.wizard ? { wizard: { ...s.wizard, step: "verifying", verifyError: "" } } : s));
    let verify: VerifyResult | null = null;
    let verifyError = "";
    try {
      verify = (await adapterVerify(w.agent.source_id)) as VerifyResult;
    } catch (e) {
      verifyError = errorMessage(e);
    }
    set((s) =>
      s.wizard
        ? { wizard: { ...s.wizard, step: "result", verify, verifyError } }
        : s,
    );
    set({ revision: get().revision + 1 });
    toast(
      verifyError
        ? `重新验证失败：${verifyError}`
        : verify?.ok
          ? "自测链路通过：测试事件已写入数据库（不代表宿主已产生真实事件）"
          : `验证未通过：${verify?.reason ?? "未知原因"}`,
      verifyError || !verify?.ok ? "warning" : "success",
    );
    await refreshSources();
  },

  uninstall: async () => {
    const w = get().wizard;
    if (!w || w.step !== "result" || !w.installOk) return;
    set((s) => (s.wizard ? { wizard: { ...s.wizard, step: "uninstalling", rollbackError: "" } } : s));
    try {
      await adapterUninstall(w.agent.source_id);
      set({ wizard: null, revision: get().revision + 1 });
      toast("已卸载 Task Dock 写入的配置（第三方配置保留）", "success");
      await refreshSources();
    } catch (e) {
      set((s) =>
        s.wizard
          ? { wizard: { ...s.wizard, step: "result", rollbackError: errorMessage(e) } }
          : s,
      );
      toast(`回滚失败：${errorMessage(e)}`, "error");
    }
  },

  dismiss: () => {
    const w = get().wizard;
    if (!w || busyStep(w.step)) return;
    set({ wizard: null });
  },
}));

/** 当前是否处于不可安全中断的接入操作。 */
export function onboardBusy(wizard: OnboardState | null): boolean {
  return Boolean(wizard && busyStep(wizard.step));
}
