// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { navAppIcon } from "../../lib/navigation";
import AppIcon from "./AppIcon";

vi.mock("../../lib/navigation", () => ({
  avatarHue: () => 210,
  navAppIcon: vi.fn(),
}));

const LIGHT_PNG = "data:image/png;base64,AAAA";
const DARK_PNG = "data:image/png;base64,BBBB";

describe("AppIcon", () => {
  beforeEach(() => {
    vi.mocked(navAppIcon).mockReset();
  });

  it("近白图标标记 is-light 并加自适应底衬/轮廓（浅色主题可辨认）", async () => {
    vi.mocked(navAppIcon).mockResolvedValue({ url: LIGHT_PNG, light: true });
    const { container } = render(<AppIcon appKey="light-icon-a" name="ChatGPT" />);

    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
    const icon = container.querySelector(".app-icon");
    expect(icon?.classList.contains("is-light")).toBe(true);
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.src).toContain("data:image/png;base64,AAAA");
    // 主题语义色底衬 + 深色描边：不硬编码单一应用，任意浅色 logo 同样适用。
    // 底衬放容器上（不是图片），图片只负责字形描边。
    const iconEl = icon as HTMLElement;
    expect(iconEl.style.background).toContain("var(--text-primary");
    expect(iconEl.style.boxShadow).toContain("inset");
    // 2px 内边距：drop-shadow 不再被父容器 overflow:hidden 裁掉。
    expect(iconEl.style.padding).toBe("2px");
    expect(img.style.filter).toContain("drop-shadow");
    expect(img.style.background).toBe("");
  });

  it("彩色/深色图标保持原始外观，不加底衬", async () => {
    vi.mocked(navAppIcon).mockResolvedValue({ url: DARK_PNG, light: false });
    const { container } = render(<AppIcon appKey="color-icon-b" name="Chrome" />);

    await waitFor(() => expect(container.querySelector("img")).toBeTruthy());
    const icon = container.querySelector(".app-icon") as HTMLElement;
    expect(icon.classList.contains("is-light")).toBe(false);
    expect(icon.style.background).toBe("transparent");
    expect(icon.style.padding).toBe("");
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.style.filter).toBe("");
    expect(img.style.background).toBe("");
  });

  it("图标取不到时回退到统一的字母样式", async () => {
    vi.mocked(navAppIcon).mockResolvedValue(null);
    const { container } = render(<AppIcon appKey="missing-icon-c" name="微信" />);

    await waitFor(() =>
      expect(container.querySelector(".app-icon-letter")?.textContent).toBe("微"),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".app-icon")?.classList.contains("is-loaded")).toBe(false);
  });
});
