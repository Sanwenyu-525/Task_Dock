// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useLocale } from "./useLocale";
import {
  __resetLocaleForTests,
  initLocale,
  LOCALE_STORAGE_KEY,
  setLocalePreference,
} from "../i18n";

function Probe() {
  const { t, locale } = useLocale();
  return (
    <span data-testid="probe">
      {locale}:{t("common.cancel")}
    </span>
  );
}

/** 带输入框与挂载计数的探针：用于证明切换语言不重建组件、不丢输入与焦点。 */
function FormProbe({ mounts }: { mounts: { current: number } }) {
  const { t } = useLocale();
  const rendered = useRef(false);
  if (!rendered.current) {
    rendered.current = true;
    mounts.current += 1;
  }
  return (
    <label>
      {t("tasks.search.open")}
      <input data-testid="search" defaultValue="" />
    </label>
  );
}

beforeEach(() => {
  __resetLocaleForTests();
});

afterEach(() => {
  cleanup();
  __resetLocaleForTests();
});

describe("useLocale", () => {
  it("切换语言后已渲染组件立即更新，无需重新挂载", () => {
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("zh-CN:取消");

    act(() => {
      setLocalePreference("en-US");
    });

    expect(screen.getByTestId("probe").textContent).toBe("en-US:Cancel");
  });

  it("输入中切换语言：组件不重建、输入值与焦点保留", async () => {
    const user = userEvent.setup();
    const mounts = { current: 0 };
    render(<FormProbe mounts={mounts} />);
    const input = screen.getByTestId("search") as HTMLInputElement;
    await user.type(input, "draft");
    expect(mounts.current).toBe(1);

    act(() => {
      setLocalePreference("en-US");
    });

    expect(screen.getByLabelText("Search tasks")).toBe(input);
    expect(input.value).toBe("draft");
    expect(document.activeElement).toBe(input);
    expect(mounts.current).toBe(1);
  });

  it("其他窗口写入语言时已渲染界面同步，无需重载窗口", () => {
    const dispose = initLocale();
    try {
      render(<Probe />);
      expect(screen.getByTestId("probe").textContent).toBe("zh-CN:取消");

      act(() => {
        localStorage.setItem(LOCALE_STORAGE_KEY, "en-US");
        window.dispatchEvent(
          new StorageEvent("storage", { key: LOCALE_STORAGE_KEY, newValue: "en-US" }),
        );
      });

      expect(screen.getByTestId("probe").textContent).toBe("en-US:Cancel");
    } finally {
      dispose();
    }
  });

  it("非法偏好收敛为中文，不渲染 undefined", () => {
    act(() => {
      useLocaleStoreSetPreference("fr-FR");
    });
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("zh-CN:取消");
  });
});

/** 通过公开 API 传入运行时非法值（模拟旧配置 / 手写存储）。 */
function useLocaleStoreSetPreference(value: string) {
  setLocalePreference(value as never);
}
