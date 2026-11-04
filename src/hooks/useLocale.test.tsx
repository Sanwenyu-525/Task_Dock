// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useLocale } from "./useLocale";
import { __resetLocaleForTests, setLocalePreference } from "../i18n";

function Probe() {
  const { t, locale } = useLocale();
  return (
    <span data-testid="probe">
      {locale}:{t("common.cancel")}
    </span>
  );
}

beforeEach(() => {
  __resetLocaleForTests();
});

afterEach(() => {
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
});
