/**
 * @vitest-environment jsdom
 */
//! 设置 Store 的主题管道测试（v0.6 关键回归点）：
//! 1. 旧库缺少 visual_preset 时回退默认预设，不把 undefined 写进 data-preset；
//! 2. 界面材质跟随**实际生效值**（玻璃渲染失败 → solid），
//!    且 CSS 玻璃与原生玻璃必须区分（v0.7：applied 不等于原生模糊）；
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
  document.documentElement.removeAttribute("data-glass-render");
  document.documentElement.removeAttribute("data-clear-fg");
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
    expect(info?.native).toBe(false);
    expect(info?.render).toBe("solid");
    expect(document.documentElement.dataset.material).toBe("solid");
    expect(document.documentElement.dataset.glassRender).toBe("solid");
    expect(document.documentElement.dataset.nativeGlass).toBe("false");
  });

  it("CSS 玻璃：applied=true + effect=css 保持 glass，但绝不声明原生", async () => {
    api.getSettings.mockResolvedValue({ ...baseSettings });
    api.applyWindowMaterial.mockResolvedValue({
      material: "glass",
      applied: true,
      native: false,
      effect: "css",
      os_version: "10.0.26100",
    });

    await useSettingsStore.getState().load();

    const info = useSettingsStore.getState().materialInfo;
    expect(info?.resolved).toBe("glass");
    expect(info?.applied).toBe(true);
    expect(info?.native).toBe(false);
    expect(info?.render).toBe("css");
    expect(document.documentElement.dataset.material).toBe("glass");
    expect(document.documentElement.dataset.glassRender).toBe("css");
    expect(document.documentElement.dataset.nativeGlass).toBe("false");
  });

  it("CSS 玻璃 + 系统减少透明：回退 solid 并清除材质", async () => {
    api.getSettings.mockResolvedValue({ ...baseSettings });
    api.applyWindowMaterial.mockResolvedValue({
      material: "glass",
      applied: true,
      effect: "css",
      os_version: "10.0.26100",
    });
    flags.transparency = true;

    await useSettingsStore.getState().load();

    expect(useSettingsStore.getState().materialInfo?.resolved).toBe("solid");
    expect(document.documentElement.dataset.material).toBe("solid");
    expect(api.applyWindowMaterial).toHaveBeenLastCalledWith("solid", "dream-gradient");
  });

  it("原生 Mica：渲染通道为 native，才允许原生半透明语言", async () => {
    api.getSettings.mockResolvedValue({ ...baseSettings });
    api.applyWindowMaterial.mockResolvedValue({
      material: "glass",
      applied: true,
      native: true,
      effect: "mica",
      os_version: "10.0.26100",
    });

    await useSettingsStore.getState().load();

    expect(useSettingsStore.getState().materialInfo?.render).toBe("native");
    expect(document.documentElement.dataset.glassRender).toBe("native");
    expect(document.documentElement.dataset.nativeGlass).toBe("true");
  });

  it("旧后端缺省 native 字段时 effect 仍能判定 CSS，不会虚报原生", async () => {
    api.getSettings.mockResolvedValue({ ...baseSettings });
    api.applyWindowMaterial.mockResolvedValue({
      material: "glass",
      applied: true,
      effect: "css",
      os_version: "10.0.26100",
    });

    await useSettingsStore.getState().load();

    expect(document.documentElement.dataset.nativeGlass).toBe("false");
    expect(useSettingsStore.getState().materialInfo?.native).toBe(false);
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
    expect(api.applyWindowMaterial).toHaveBeenCalledWith("solid", "dream-gradient");

    // 2) 用户关闭该偏好 → 必须重新应用 glass（而不是只恢复 CSS 半透明）
    api.applyWindowMaterial.mockClear();
    flags.transparency = false;
    useSettingsStore.getState().reapplyFromSystem();
    await vi.waitFor(() => {
      expect(useSettingsStore.getState().materialInfo?.resolved).toBe("glass");
    });

    expect(api.applyWindowMaterial).toHaveBeenCalledWith("glass", "dream-gradient");
    expect(document.documentElement.dataset.material).toBe("glass");
    expect(document.documentElement.dataset.nativeGlass).toBe("true");
  });
});

describe("异步材质结果", () => {
  it("材质 IPC 串行化：旧请求未完成时不并发下发新请求，过期结果被丢弃", async () => {
    let resolveGlass!: (v: unknown) => void;
    const glassP = new Promise((r) => {
      resolveGlass = r;
    });
    api.getSettings.mockResolvedValue({ ...baseSettings });
    api.updateSettings.mockImplementation(async (patch: Record<string, unknown>) => ({
      ...baseSettings,
      ...patch,
    }));
    api.applyWindowMaterial.mockImplementation((m: string) =>
      m === "glass"
        ? glassP
        : Promise.resolve({
            material: "solid",
            applied: false,
            effect: "none",
            os_version: "10.0.26100",
          }),
    );

    // 第一条 glass 请求挂起，第二条 solid 请求必须排队等待它返回
    const firstP = useSettingsStore.getState().update({ material: "glass" } as never);
    await vi.waitFor(() => expect(api.applyWindowMaterial).toHaveBeenCalledTimes(1));
    const secondP = useSettingsStore.getState().update({ material: "solid" } as never);

    // Rust 侧不识别请求序号：旧请求未返回时新请求必须排队，
    // 否则两条 IPC 可能乱序落到主线程，窗口留下旧材质而界面已是新设置。
    await new Promise((r) => setTimeout(r, 20));
    expect(api.applyWindowMaterial).toHaveBeenCalledTimes(1);
    expect(api.applyWindowMaterial).toHaveBeenLastCalledWith("glass", "dream-gradient");

    // 旧探测后返回：序号已过期，结果必须被丢弃
    resolveGlass({
      material: "glass",
      applied: true,
      native: true,
      effect: "mica",
      os_version: "10.0.26100",
    });
    await firstP;
    await secondP;

    // 排队的 solid 随后执行并最终落地
    expect(api.applyWindowMaterial).toHaveBeenLastCalledWith("solid", "dream-gradient");
    expect(document.documentElement.dataset.material).toBe("solid");
    expect(document.documentElement.dataset.nativeGlass).toBe("false");
    expect(useSettingsStore.getState().materialInfo?.resolved).toBe("solid");
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
    // 预设会改变原生层取舍（清透必须强制无原生模糊），因此要重放一次材质，
    // 但只此一次，不重建窗口。
    expect(api.applyWindowMaterial).toHaveBeenCalledTimes(2);
    expect(api.applyWindowMaterial).toHaveBeenLastCalledWith("glass", "liquid-glass");
  });

  it("切到清透：写前景属性并让后端按 clear 强制 CSS 通道", async () => {
    api.getSettings.mockResolvedValue({ ...baseSettings });
    api.applyWindowMaterial.mockResolvedValue({
      material: "glass",
      applied: true,
      effect: "css",
      os_version: "10.0.26100",
    });
    await useSettingsStore.getState().load();

    api.updateSettings.mockImplementation(async (patch: Record<string, unknown>) => ({
      ...baseSettings,
      ...patch,
    }));
    await useSettingsStore.getState().update({ visual_preset: "clear" } as never);

    expect(document.documentElement.dataset.preset).toBe("clear");
    expect(document.documentElement.dataset.clearFg).toBe("auto");
    expect(api.applyWindowMaterial).toHaveBeenLastCalledWith("glass", "clear");
  });
});
