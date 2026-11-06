/**
 * @vitest-environment jsdom
 */
//! 引导状态机：自动展示判定、跳过/完成持久化、升级不重播（只置新内容标志）。

import { beforeEach, describe, expect, it } from "vitest";
import {
  ONBOARDING_STEP_COUNT,
  ONBOARDING_VERSION,
  __resetOnboardingForTests,
  useOnboardingStore,
} from "./useOnboardingStore";

const STORAGE_KEY = "taskdock.onboarding.v1";

function storedRecord(): Record<string, unknown> | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

/** 模拟重启：只清内存态，保留 localStorage 记录。 */
function reboot() {
  useOnboardingStore.setState({
    open: false,
    step: 0,
    hydrated: false,
    done: false,
    hasNewContent: false,
  });
}

beforeEach(() => {
  __resetOnboardingForTests();
});

describe("useOnboardingStore · 首次展示", () => {
  it("无记录时 hydrate 自动打开并停在第 1 步", () => {
    useOnboardingStore.getState().hydrate();
    const s = useOnboardingStore.getState();
    expect(s.hydrated).toBe(true);
    expect(s.open).toBe(true);
    expect(s.step).toBe(0);
  });

  it("hydrate 幂等：重复调用不重置已推进的步骤", () => {
    useOnboardingStore.getState().hydrate();
    useOnboardingStore.getState().next();
    useOnboardingStore.getState().hydrate();
    expect(useOnboardingStore.getState().step).toBe(1);
  });

  it("用户明确跳过后重启不再自动展示", () => {
    useOnboardingStore.getState().hydrate();
    useOnboardingStore.getState().skip();
    reboot();
    // 模拟重启：内存清空，记录仍在
    expect(storedRecord()).toMatchObject({ skipped: true, version: ONBOARDING_VERSION });
    useOnboardingStore.getState().hydrate();
    expect(useOnboardingStore.getState().open).toBe(false);
  });

  it("存在「未完成且未跳过」的记录（重开后直接关窗）：重启仍会展示", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: ONBOARDING_VERSION,
        done: false,
        skipped: false,
        hasNewContent: false,
      }),
    );
    useOnboardingStore.getState().hydrate();
    expect(useOnboardingStore.getState().open).toBe(true);
  });
});

describe("useOnboardingStore · 步骤流转", () => {
  it("next 到最后一步后不再前进；back 到第一步后不再后退", () => {
    useOnboardingStore.getState().hydrate();
    for (let i = 0; i < ONBOARDING_STEP_COUNT + 2; i += 1) useOnboardingStore.getState().next();
    expect(useOnboardingStore.getState().step).toBe(ONBOARDING_STEP_COUNT - 1);
    for (let i = 0; i < 3; i += 1) useOnboardingStore.getState().back();
    expect(useOnboardingStore.getState().step).toBe(0);
  });

  it("finish 写入 done 记录并关闭；重启不再展示", () => {
    useOnboardingStore.getState().hydrate();
    useOnboardingStore.getState().finish();
    expect(useOnboardingStore.getState().open).toBe(false);
    expect(useOnboardingStore.getState().done).toBe(true);
    expect(storedRecord()).toMatchObject({ done: true, skipped: false });
    reboot();
    useOnboardingStore.getState().hydrate();
    expect(useOnboardingStore.getState().open).toBe(false);
  });
});

describe("useOnboardingStore · 升级不重播", () => {
  it("旧版本记录：不自动重播，只置 hasNewContent 标志", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: ONBOARDING_VERSION - 1, done: true, skipped: false, hasNewContent: false }),
    );
    useOnboardingStore.getState().hydrate();
    const s = useOnboardingStore.getState();
    expect(s.open).toBe(false);
    expect(s.hasNewContent).toBe(true);
  });

  it("同版本记录：不置新内容标志", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: ONBOARDING_VERSION, done: true, skipped: false, hasNewContent: false }),
    );
    useOnboardingStore.getState().hydrate();
    expect(useOnboardingStore.getState().hasNewContent).toBe(false);
  });

  it("损坏记录按无记录处理（自动展示），不抛错", () => {
    localStorage.setItem(STORAGE_KEY, "{not-json");
    expect(() => useOnboardingStore.getState().hydrate()).not.toThrow();
    expect(useOnboardingStore.getState().open).toBe(true);
  });

  it("reopenFromHelp：重置到第 1 步、清除新内容标志并持久化同版本记录", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: ONBOARDING_VERSION - 1, done: true, skipped: false, hasNewContent: true }),
    );
    useOnboardingStore.getState().hydrate();
    expect(useOnboardingStore.getState().hasNewContent).toBe(true);
    useOnboardingStore.getState().reopenFromHelp();
    const s = useOnboardingStore.getState();
    expect(s.open).toBe(true);
    expect(s.step).toBe(0);
    expect(s.hasNewContent).toBe(false);
    expect(storedRecord()).toMatchObject({ version: ONBOARDING_VERSION, hasNewContent: false });
    // 之后再 hydrate（等价重启，保留记录）不再弹新内容
    reboot();
    useOnboardingStore.getState().hydrate();
    expect(useOnboardingStore.getState().hasNewContent).toBe(false);
  });
});
