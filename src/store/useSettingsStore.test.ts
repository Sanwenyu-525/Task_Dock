/**
 * @vitest-environment jsdom
 */
//! 设置 Store 的主题管道测试（v0.6 关键回归点）：
//! 1. 旧库缺少 visual_preset 时回退默认预设，不把 undefined 写进 data-preset；
//! 2. 界面材质跟随**实际生效值**（原生材质失败 → solid），而不是用户请求值；
//! 3. 系统「减少透明」关闭后重新探测并真正恢复原生材质（v0.5 缺陷）；
//! 4. 切换预设只改 data-preset 与 Win32 圆角半径，不重置业务状态。

import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  applyWindowMaterial: vi.fn(),
  applyWindowRadius: vi.fn(async () => true),
}));

vi.mock("../lib/bridge", () => api);

import { useSettingsStore } from "./useSettingsStore";

interface Flags {
  dark?: boolean;
  contrast?: boolean;
  transparency?: boolean;
}

let flags: Flags = {};

function installMatchMedia() {
  window.matchMedia = ((q: string) => {
    const matches = q.includes("prefers-color-scheme: dark")
      ? !!flags.dark
      : q.includes("prefers-contrast: more")
        ? !!flags.contrast
        : q.includes("prefers-reduced-transparency: more")
          ? !!flags.transparency
          : false;
    return {
      matches,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

const baseSettings = {
  theme: "light",
  mode: "full",
  material: "glass",
} as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  flags = {};
  installMatchMedia();
  useSettingsStore.setState({ settings: null, materialInfo: null });
  document.documentElement.removeAttribute("data-preset");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-material");
  document.documentElement.removeAttribute("data-native-glass");
});

describe("设置加载与预设回退", () => {
  it("旧库缺 visual_preset：安全回退 dream-gradient，并写入 DOM 标记", async () => {
    api.getSettings.mockResolvedValue({ ...baseSettings });
    api.applyWindowMaterial.mockResolvedValue({
      material: "glass",
      applied: true,
      effect: "mica",
      os_version: "10.0.26100",
    });

    await useSettingsStore.getState().load();

    expect(document.documentElement.dataset.preset).toBe("dream-gradient");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.material).toBe("glass");
    expect(document.documentElement.dataset.nativeGlass).toBe("true");
  });

  it("未知预设值同样回退，不会出现空 data-preset", async () => {
    api.getSettings.mockResolvedValue({ ...baseSettings, visual_preset: "neon-rainbow" });
    api.applyWindowMaterial.mockResolvedValue({
      material: "glass",
      applied: true,
      effect: "mica",
      os_version: "10.0.26100",
    });

    await useSettingsStore.getState().load();
    expect(document.documentElement.dataset.preset).toBe("dream-gradient");
  });
});

describe("材质以实际生效值驱动", () => {
  it("原生材质应用失败：data-material 与 resolved 都是 solid", async () => {
    api.getSettings.mockResolvedValue({ ...baseSettings });
    api.applyWindowMaterial.mockResolvedValue({
      material: "glass",
      applied: false,
      effect: "none",
      os_version: "10.0.19045",
    });

    await useSettingsStore.getState().load();

    const info = useSettingsStore.getState().materialInfo;
    expect(info?.requested).toBe("glass");
    expect(info?.resolved).toBe("solid");
    expect(info?.applied).toBe(false);
    expect(document.documentElement.dataset.material).toBe("solid");
    expect(document.documentElement.dataset.nativeGlass).toBe("false");
  });

  it("系统减少透明关闭后重新探测并恢复原生材质", async () => {
    api.getSettings.mockResolvedValue({ ...baseSettings });
    api.applyWindowMaterial.mockResolvedValue({
      material: "glass",
      applied: true,
      effect: "mica",
      os_version: "10.0.26100",
    });

    // 1) 系统开启「减少透明」→ 回退 solid，并清除原生效果
    flags.transparency = true;
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().materialInfo?.resolved).toBe("solid");
    expect(api.applyWindowMaterial).toHaveBeenCalledWith("solid");

    // 2) 用户关闭该偏好 → 必须重新应用 glass（而不是只恢复 CSS 半透明）
    api.applyWindowMaterial.mockClear();
    flags.transparency = false;
    useSettingsStore.getState().reapplyFromSystem();
    await vi.waitFor(() => {
      expect(useSettingsStore.getState().materialInfo?.resolved).toBe("glass");
    });

    expect(api.applyWindowMaterial).toHaveBeenCalledWith("glass");
    expect(document.documentElement.dataset.material).toBe("glass");
    expect(document.documentElement.dataset.nativeGlass).toBe("true");
  });
});

describe("预设切换", () => {
  it("切换预设立即生效并下发对应圆角半径，不触碰设置以外的状态", async () => {
    api.getSettings.mockResolvedValue({ ...baseSettings });
    api.applyWindowMaterial.mockResolvedValue({
      material: "glass",
      applied: true,
      effect: "mica",
      os_version: "10.0.26100",
    });
    await useSettingsStore.getState().load();
    expect(document.documentElement.dataset.preset).toBe("dream-gradient");

    api.updateSettings.mockImplementation(async (patch: Record<string, unknown>) => ({
      ...baseSettings,
      ...patch,
    }));

    await useSettingsStore.getState().update({ visual_preset: "liquid-glass" } as never);

    expect(document.documentElement.dataset.preset).toBe("liquid-glass");
    expect(api.applyWindowRadius).toHaveBeenCalledWith(20);
    // 预设切换不重放材质探测（材质偏好没变）
    expect(api.applyWindowMaterial).toHaveBeenCalledTimes(1);
  });
});
