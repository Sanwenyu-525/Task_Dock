//! 首次使用引导状态（localStorage 持久化，键 `taskdock.onboarding.v1`）。
//!
//! 语义（与 docs/help/README.md 保持一致）：
//! - 最多 3 步：认识 task_dock → 完成第一个任务 → 按需启用功能；
//! - 首次使用（无记录）或「既没完成也没跳过」时自动展示；明确跳过后不再自动打扰；
//! - 升级不重播：记录 version（seenVersion 语义），新版本只置 `hasNewContent`
//!   标志、由帮助中心的「重新打开新手引导」按钮（带小红点）呈现，绝不自动重播；
//! - 存储损坏 / 隐私模式 / 配额满：静默降级为「本次会话展示」，不影响功能。
//!
//! 引导过程**不写入任何业务数据**（不创建示例任务），第三步只是说明文字与跳转入口。

import { create } from "zustand";

const ONBOARDING_STORAGE_KEY = "taskdock.onboarding.v1";

/** 引导内容版本：引导文案或步骤发生实质变化时递增（触发「有新内容」标志）。 */
export const ONBOARDING_VERSION = 1;

/** 引导总步数（组件与测试共同使用）。 */
export const ONBOARDING_STEP_COUNT = 3;

interface OnboardingRecord {
  /** 最近一次完成/跳过/重开时所处的引导内容版本 */
  version: number;
  /** 用户完成过全部步骤 */
  done: boolean;
  /** 用户明确跳过（此后不再自动展示） */
  skipped: boolean;
  /** 新版本引导内容标志（由帮助中心呈现与清除） */
  hasNewContent: boolean;
}

function isRecord(value: unknown): value is OnboardingRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.version === "number" &&
    Number.isFinite(r.version) &&
    typeof r.done === "boolean" &&
    typeof r.skipped === "boolean" &&
    typeof r.hasNewContent === "boolean"
  );
}

function readRecord(): OnboardingRecord | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(ONBOARDING_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistRecord(record: OnboardingRecord): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // 存储不可用（隐私模式 / 配额满）：仅保留内存态，不影响本次会话。
  }
}

interface OnboardingState {
  /** 引导卡片是否打开（可见性还由 OnboardingOverlay 按 mode/停靠相位门控） */
  open: boolean;
  /** 当前步骤（0 起） */
  step: number;
  /** 启动 hydrate 是否已执行（避免未决定前闪现） */
  hydrated: boolean;
  /** 用户是否完成过引导 */
  done: boolean;
  /** 新版本引导内容标志：帮助中心据此显示红点 */
  hasNewContent: boolean;
  /** 启动时调用一次：决定是否自动展示、是否置「有新内容」 */
  hydrate: () => void;
  next: () => void;
  back: () => void;
  /** 明确跳过（含 Escape）：写记录、不再自动展示 */
  skip: () => void;
  /** 完成最后一步 */
  finish: () => void;
  /** 帮助中心「重新打开新手引导」：重置到第一步并清除「有新内容」 */
  reopenFromHelp: () => void;
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  open: false,
  step: 0,
  hydrated: false,
  done: false,
  hasNewContent: false,
  hydrate: () => {
    if (get().hydrated) return;
    const record = readRecord();
    // 无记录或「未完成且未跳过」→ 自动展示；明确跳过后不再打扰
    const autoOpen = !record || (!record.done && !record.skipped);
    const hasNew = record !== null && record.version < ONBOARDING_VERSION;
    set({
      hydrated: true,
      open: autoOpen,
      step: 0,
      done: record?.done ?? false,
      hasNewContent: hasNew,
    });
  },
  next: () =>
    set((s) => ({
      step: Math.min(s.step + 1, ONBOARDING_STEP_COUNT - 1),
    })),
  back: () => set((s) => ({ step: Math.max(s.step - 1, 0) })),
  skip: () => {
    set({ open: false, done: get().done, hasNewContent: false });
    persistRecord({
      version: ONBOARDING_VERSION,
      done: get().done,
      skipped: true,
      hasNewContent: false,
    });
  },
  finish: () => {
    set({ open: false, done: true, hasNewContent: false });
    persistRecord({
      version: ONBOARDING_VERSION,
      done: true,
      skipped: false,
      hasNewContent: false,
    });
  },
  reopenFromHelp: () => {
    set({ open: true, step: 0, hasNewContent: false });
    persistRecord({
      version: ONBOARDING_VERSION,
      done: get().done,
      skipped: false,
      hasNewContent: false,
    });
  },
}));

/** 仅供测试：清空内存态与持久化记录。 */
export function __resetOnboardingForTests(): void {
  try {
    localStorage?.removeItem(ONBOARDING_STORAGE_KEY);
  } catch {
    // 忽略
  }
  useOnboardingStore.setState({
    open: false,
    step: 0,
    hydrated: false,
    done: false,
    hasNewContent: false,
  });
}
