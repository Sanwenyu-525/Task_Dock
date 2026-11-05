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
  applyMode: vi.fn(),
  applyWindowMaterial: vi.fn(),
  applyWindowRadius: vi.fn(async () => true),
}));

vi.mock("../lib/bridge", () => api);

import { useSettingsStore } from "./useSettingsStore";
import type { Settings } from "../lib/bridge";

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
  it("旧库缺 visual_preset：安全回退 frosted，并写入 DOM 标记", async () => {
    api.getSettings.mockResolvedValue({ ...baseSettings });
    api.applyWindowMaterial.mockResolvedValue({
      material: "glass",
      applied: true,
      effect: "mica",
      os_version: "10.0.26100",
    });

    await useSettingsStore.getState().load();

    expect(document.documentElement.dataset.preset).toBe("frosted");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.material).toBe("glass");
    expect(document.documentElement.dataset.nativeGlass).toBe("true");
    // clear_foreground 已废弃：即使库里是 dark，也不再写 data-clear-fg
    expect(document.documentElement.dataset.clearFg).toBeUndefined();
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
    expect(document.documentElement.dataset.preset).toBe("frosted");
  });

  it("历史值 liquid-glass / clear 读到即归一为 frosted，且不再读取 clear_foreground", async () => {
    for (const legacy of ["liquid-glass", "clear"]) {
      document.documentElement.removeAttribute("data-preset");
      api.getSettings.mockResolvedValue({
        ...baseSettings,
        visual_preset: legacy,
        clear_foreground: "dark",
      });
      api.applyWindowMaterial.mockResolvedValue({
        material: "glass",
        applied: true,
        effect: "mica",
        os_version: "10.0.26100",
      });

      await useSettingsStore.getState().load();

      expect(document.documentElement.dataset.preset).toBe("frosted");
      expect(document.documentElement.dataset.clearFg).toBeUndefined();
      expect(api.applyWindowMaterial).toHaveBeenLastCalledWith("glass", "frosted");
    }
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
    expect(api.applyWindowMaterial).toHaveBeenLastCalledWith("solid", "frosted");
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
    expect(api.applyWindowMaterial).toHaveBeenCalledWith("solid", "frosted");

    // 2) 用户关闭该偏好 → 必须重新应用 glass（而不是只恢复 CSS 半透明）
    api.applyWindowMaterial.mockClear();
    flags.transparency = false;
    useSettingsStore.getState().reapplyFromSystem();
    await vi.waitFor(() => {
      expect(useSettingsStore.getState().materialInfo?.resolved).toBe("glass");
    });

    expect(api.applyWindowMaterial).toHaveBeenCalledWith("glass", "frosted");
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
    expect(api.applyWindowMaterial).toHaveBeenLastCalledWith("glass", "frosted");

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
    expect(api.applyWindowMaterial).toHaveBeenLastCalledWith("solid", "frosted");
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
    expect(document.documentElement.dataset.preset).toBe("frosted");

    api.updateSettings.mockImplementation(async (patch: Record<string, unknown>) => ({
      ...baseSettings,
      ...patch,
    }));

    await useSettingsStore.getState().update({ visual_preset: "dream-gradient" } as never);

    expect(api.updateSettings).toHaveBeenCalledWith({ visual_preset: "dream-gradient" });
    expect(document.documentElement.dataset.preset).toBe("dream-gradient");
    expect(api.applyWindowRadius).toHaveBeenCalledWith(18);
    // 预设切换会重放一次材质，但只此一次，不重建窗口。
    expect(api.applyWindowMaterial).toHaveBeenCalledTimes(2);
    expect(api.applyWindowMaterial).toHaveBeenLastCalledWith("glass", "dream-gradient");
  });

  it("写侧兼容：历史值 liquid-glass / clear 入库前归一为 frosted", async () => {
    api.getSettings.mockResolvedValue({ ...baseSettings, visual_preset: "frosted" });
    api.applyWindowMaterial.mockResolvedValue({
      material: "glass",
      applied: true,
      effect: "mica",
      os_version: "10.0.26100",
    });
    await useSettingsStore.getState().load();

    api.updateSettings.mockImplementation(async (patch: Record<string, unknown>) => ({
      ...baseSettings,
      ...patch,
    }));
    for (const legacy of ["liquid-glass", "clear"]) {
      await useSettingsStore.getState().update({ visual_preset: legacy } as never);

      expect(api.updateSettings).toHaveBeenLastCalledWith({ visual_preset: "frosted" });
      expect(document.documentElement.dataset.preset).toBe("frosted");
      expect(api.applyWindowRadius).toHaveBeenLastCalledWith(20);
      expect(api.applyWindowMaterial).toHaveBeenLastCalledWith("glass", "frosted");
      expect(document.documentElement.dataset.clearFg).toBeUndefined();
    }
  });
});

describe("设置写入并发契约（串行 + 合并 + 字段级裁决）", () => {
  const BASE_FULL: Record<string, unknown> = {
    theme: "light",
    mode: "full",
    material: "solid",
    visual_preset: "frosted",
    snap_enabled: false,
    snap_display_mode: "capsule",
    actions_enabled: true,
    navigation_layout: { version: 1, left: [], capsule: [] },
  };

  interface Call {
    patch: Record<string, unknown>;
    resolve: (v: Settings) => void;
    reject: (e: unknown) => void;
    settled: boolean;
  }

  let db: Record<string, unknown>;
  let calls: Call[];
  let inFlight: number;
  let maxInFlight: number;
  let modeCalls: string[];

  const update = (patch: Record<string, unknown>) =>
    useSettingsStore.getState().update(patch as never);
  const settings = () =>
    useSettingsStore.getState().settings as unknown as Record<string, unknown>;
  const settle = (i: number) => {
    const c = calls[i];
    if (c.settled) throw new Error(`call ${i} 已结束`);
    c.settled = true;
    inFlight -= 1;
    db = { ...db, ...c.patch };
    c.resolve({ ...db } as unknown as Settings);
  };
  /** 用指定快照结束请求（不改数据库）：模拟「后端已写库，但快照读取更早」。 */
  const settleWith = (i: number, snapshot: Record<string, unknown>) => {
    const c = calls[i];
    if (c.settled) throw new Error(`call ${i} 已结束`);
    c.settled = true;
    inFlight -= 1;
    c.resolve(snapshot as unknown as Settings);
  };
  const fail = (i: number, error: unknown) => {
    const c = calls[i];
    if (c.settled) throw new Error(`call ${i} 已结束`);
    c.settled = true;
    inFlight -= 1;
    c.reject(error);
  };

  beforeEach(async () => {
    db = { ...BASE_FULL };
    calls = [];
    inFlight = 0;
    maxInFlight = 0;
    modeCalls = [];
    // 后端模型：update_settings 写库后返回完整快照；apply_mode 只写 mode。
    api.getSettings.mockImplementation(async () => ({ ...db }) as unknown as Settings);
    api.updateSettings.mockImplementation(
      (patch: Record<string, unknown>) =>
        new Promise<Settings>((resolve, reject) => {
          calls.push({ patch, resolve, reject, settled: false });
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
        }),
    );
    api.applyMode.mockImplementation(async (mode: string) => {
      modeCalls.push(mode);
      db = { ...db, mode };
    });
    api.applyWindowMaterial.mockResolvedValue({
      material: "glass",
      applied: true,
      effect: "mica",
      os_version: "10.0.26100",
    });
    await useSettingsStore.getState().load();
  });

  it("S01 不同字段：A 先返回，两项都落地（不再整体丢弃旧响应）", async () => {
    const a = update({ tts_enabled: true });
    const b = update({ tts_rate: 120 });
    expect(calls).toHaveLength(1); // 串行：B 等待 A
    expect(calls[0].patch).toEqual({ tts_enabled: true });

    settle(0);
    await a;
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].patch).toEqual({ tts_rate: 120 });
    settle(1);
    await b;

    expect(settings().tts_enabled).toBe(true);
    expect(settings().tts_rate).toBe(120);
    expect(db.tts_enabled).toBe(true);
    expect(db.tts_rate).toBe(120);
  });

  it("S02 响应不可能乱序：任意时刻只有一个在途，待发请求合并为一次 IPC", async () => {
    const a = update({ tts_enabled: true });
    const b = update({ tts_rate: 120 });
    const c = update({ tts_volume: 70 });
    expect(calls).toHaveLength(1);

    settle(0);
    await a;
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    // B、C 合并：同一次请求里两项都在，不产生第三次 IPC
    expect(calls[1].patch).toEqual({ tts_rate: 120, tts_volume: 70 });
    settle(1);
    await Promise.all([b, c]);

    expect(maxInFlight).toBe(1);
    expect(settings().tts_rate).toBe(120);
    expect(settings().tts_volume).toBe(70);
  });

  it("S03 A 成功、B 失败：A 保留，B 报错且不回滚已成功字段", async () => {
    const a = update({ tts_enabled: true });
    settle(0);
    await a;

    const b = update({ tts_rate: 120 });
    fail(1, new Error("数据库被占用"));
    await expect(b).rejects.toThrow("数据库被占用");

    expect(settings().tts_enabled).toBe(true);
    expect(settings().tts_rate).toBe(undefined);
    expect(db.tts_enabled).toBe(true);
  });

  it("S04 A 失败、B 成功：B 落地，A 不生效", async () => {
    const a = update({ tts_enabled: true });
    const b = update({ tts_rate: 120 });
    fail(0, new Error("校验失败"));
    await expect(a).rejects.toThrow();

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    settle(1);
    await b;

    expect(settings().tts_enabled).toBe(undefined);
    expect(settings().tts_rate).toBe(120);
    expect(db.tts_rate).toBe(120);
  });

  it("S05 同字段快速连续写入：最后一次操作胜出（数据库与界面一致）", async () => {
    const a = update({ tts_rate: 110 });
    const b = update({ tts_rate: 120 });
    const c = update({ tts_rate: 130 });
    expect(calls[0].patch).toEqual({ tts_rate: 110 });

    settle(0);
    await a;
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    // 中间值 120 被合并掉，只落最终值 130
    expect(calls[1].patch).toEqual({ tts_rate: 130 });
    settle(1);
    await Promise.all([b, c]);

    expect(settings().tts_rate).toBe(130);
    expect(db.tts_rate).toBe(130);
  });

  it("S06 TTS 更新与外部 mode 事件并发：UI 与数据库都保持外部值", async () => {
    const a = update({ tts_enabled: true });
    // 外部路径（apply_mode）在请求发起后落库并广播
    db = { ...db, mode: "minimal" };
    useSettingsStore.getState().syncExternal({ mode: "minimal" });
    // 语音写入的响应携带模式切换前读到的旧快照
    settleWith(0, { ...db, mode: "full", tts_enabled: true });
    await a;

    expect(settings().mode).toBe("minimal");
    expect(settings().tts_enabled).toBe(true);
    // 数据库与界面一致，无需修复下发
    await vi.waitFor(() => expect(modeCalls).toEqual([]));
  });

  it("S07 显式 mode 写入与外部 mode 事件并发：外部事件（更晚）胜出，并修复数据库", async () => {
    const a = update({ mode: "compact" });
    useSettingsStore.getState().syncExternal({ mode: "minimal" });
    // 我方写入晚到，数据库被旧意图覆盖成 compact
    db = { ...db, mode: "compact" };
    settleWith(0, { ...db, mode: "compact" });
    await a;

    expect(settings().mode).toBe("minimal");
    // 终态核对：重读数据库发现落后，用 apply_mode 重新落库 + 调整窗口
    await vi.waitFor(() => expect(modeCalls).toEqual(["minimal"]));
    expect(db.mode).toBe("minimal");
    expect(settings().mode).toBe("minimal");
  });

  it("S07b 外部事件早于写入发起：本次写入生效", async () => {
    db = { ...db, mode: "minimal" };
    useSettingsStore.getState().syncExternal({ mode: "minimal" });
    const a = update({ mode: "compact" });
    settle(0);
    await a;

    expect(settings().mode).toBe("compact");
    expect(modeCalls).toEqual([]);
  });

  it("S07c 吸附形态并发：旧快照不回退，数据库落后时重新下发界面值", async () => {
    const a = update({ snap_display_mode: "capsule" });
    useSettingsStore.getState().syncExternal({ snap_display_mode: "full" });
    // 我方写入晚到：数据库被旧意图覆盖成 capsule
    db = { ...db, snap_display_mode: "capsule" };
    settleWith(0, { ...db, snap_display_mode: "capsule" });
    await a;

    expect(settings().snap_display_mode).toBe("full");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].patch).toEqual({ snap_display_mode: "full" });
    settle(1);
    await vi.waitFor(() => expect(db.snap_display_mode).toBe("full"));
  });

  it("S08 主题/预设/语音并发：三项都落地，DOM 与原生材质副作用执行", async () => {
    const a = update({ theme: "dark" });
    const b = update({ tts_enabled: true });
    const c = update({ visual_preset: "dream-gradient" });

    settle(0);
    await a;
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].patch).toEqual({
      tts_enabled: true,
      visual_preset: "dream-gradient",
    });
    settle(1);
    await Promise.all([b, c]);

    expect(settings().theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(settings().visual_preset).toBe("dream-gradient");
    expect(document.documentElement.dataset.preset).toBe("dream-gradient");
    expect(api.applyWindowMaterial).toHaveBeenLastCalledWith("solid", "dream-gradient");
  });

  it("S09 运行时状态与重新加载（等价重启）一致", async () => {
    const a = update({ tts_enabled: true });
    settle(0);
    await a;
    const b = update({ theme: "dark", tts_rate: 120 });
    settle(1);
    await b;

    await useSettingsStore.getState().load();
    expect(settings()).toMatchObject({
      tts_enabled: true,
      tts_rate: 120,
      theme: "dark",
      mode: "full",
    });
  });

  it("S10 残缺/非法响应：不损坏其他设置", async () => {
    const a = update({ tts_enabled: true });
    settleWith(0, {
      ...db,
      mode: "",
      theme: undefined,
      tts_enabled: true,
    });
    await a;

    expect(settings().mode).toBe("full");
    expect(settings().theme).toBe("light");
    expect(settings().tts_enabled).toBe(true);
    expect(settings().navigation_layout).toEqual({ version: 1, left: [], capsule: [] });
  });

  it("写入失败但后端已部分落库：按数据库真值对齐，不误报成功", async () => {
    api.updateSettings.mockImplementationOnce(async (patch: Record<string, unknown>) => {
      db = { ...db, ...patch }; // 已写入后失败（极端部分写入）
      throw new Error("写入后失败");
    });
    const a = update({ tts_enabled: true, tts_rate: 120 });
    await expect(a).rejects.toThrow("写入后失败");
    await vi.waitFor(() => expect(settings().tts_enabled).toBe(true));
    expect(settings().tts_rate).toBe(120);
  });
});
