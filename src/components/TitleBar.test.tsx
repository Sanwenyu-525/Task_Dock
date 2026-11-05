/**
 * @vitest-environment jsdom
 */
//! 标题栏（v0.6）：
//! - 完整模式**没有**剪贴板按钮（入口在左侧导航）；
//! - 紧凑/极简模式没有左侧导航，标题栏保留剪贴板按钮作为临时入口；
//! - 该按钮开合剪贴板抽屉，并同步 aria-expanded。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize: vi.fn(), hide: vi.fn() }),
}));

import TitleBar from "./TitleBar";
import { useUiStore } from "../store/useUiStore";
import { useSettingsStore } from "../store/useSettingsStore";
import { useAgentsStore } from "../store/useAgentsStore";
// 标题栏与品牌球的视觉契约直接从样式表读取，避免 jsdom 不计算伪元素样式。
import themesCss from "../styles-themes.css?raw";

function setMode(mode: "full" | "compact" | "minimal") {
  useSettingsStore.setState({
    settings: { mode, theme: "light", visual_preset: "dream-gradient" } as never,
  });
}

/** 读取品牌球某个伪元素的规则体；jsdom 不计算伪元素样式，只能断言样式表契约。 */
function orbRule(pseudo: "before" | "after") {
  return new RegExp(`\\.brand-orb::${pseudo}\\s*\\{([\\s\\S]*?)\\}`).exec(themesCss)?.[1] ?? "";
}

function darkOrbRule(pseudo: "before" | "after") {
  return new RegExp(`:root\\[data-theme="dark"\\]\\s*\\.brand-orb::${pseudo}\\s*\\{([^}]*)\\}`).exec(themesCss)?.[1] ?? "";
}

function brandOrbKeyframes() {
  const start = themesCss.indexOf("@keyframes brand-orb-cycle");
  if (start < 0) return "";
  return themesCss.slice(start, themesCss.indexOf("@media (prefers-reduced-motion", start));
}

describe("TitleBar 剪贴板入口", () => {
  beforeEach(() => {
    useUiStore.setState({ tab: "tasks", clipboardOpen: false, clipboardLinkTask: null });
    useAgentsStore.setState({ snapshot: null });
    setMode("full");
  });

  afterEach(() => cleanup());

  it("完整模式不显示剪贴板按钮（入口在左侧导航）", () => {
    render(<TitleBar />);
    expect(screen.queryByRole("button", { name: "打开智能剪贴板" })).toBeNull();
  });

  it("紧凑模式保留剪贴板按钮，点击后打开抽屉", async () => {
    const user = userEvent.setup();
    setMode("compact");
    render(<TitleBar />);

    const btn = screen.getByRole("button", { name: "打开智能剪贴板" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    await user.click(btn);
    expect(useUiStore.getState().clipboardOpen).toBe(true);
    expect(screen.getByRole("button", { name: "打开智能剪贴板" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("极简模式保留剪贴板按钮，再次点击关闭抽屉", async () => {
    const user = userEvent.setup();
    setMode("minimal");
    render(<TitleBar />);

    const btn = screen.getByRole("button", { name: "打开智能剪贴板" });
    await user.click(btn);
    expect(useUiStore.getState().clipboardOpen).toBe(true);

    await user.click(screen.getByRole("button", { name: "打开智能剪贴板" }));
    expect(useUiStore.getState().clipboardOpen).toBe(false);
  });
});

describe("TitleBar 品牌球与状态点", () => {
  beforeEach(() => {
    useUiStore.setState({ tab: "tasks", clipboardOpen: false, clipboardLinkTask: null });
    setMode("full");
  });

  afterEach(() => cleanup());

  it("标题栏移除 Agent 状态点（失败轮次也不会出现红点）", () => {
    const now = new Date().toISOString();
    useAgentsStore.setState({
      snapshot: {
        sources: [],
        instances: [],
        sessions: [],
        runs: [
          {
            id: "r1",
            session_id: "s1",
            source_id: "src-1",
            external_run_id: null,
            task_title: "失败任务",
            status: "failed",
            started_at: now,
            updated_at: now,
            ended_at: null,
            pending_items: [],
          },
        ],
      } as never,
    });

    const { container } = render(<TitleBar />);
    expect(container.querySelector(".titlebar .agent-dot")).toBeNull();
    expect(screen.queryByLabelText(/Agent 状态/)).toBeNull();
    // 品牌球仍在，标题紧跟其后，没有为状态点保留空位。
    expect(container.querySelector(".brand-orb")).toBeTruthy();
    expect(screen.getByText("Task Dock")).toBeTruthy();
  });

  it("两层动效都裁在 14px 圆内，旧外围光环不再存在", () => {
    for (const body of [orbRule("before"), orbRule("after")]) {
      expect(body, "缺少品牌球动效层").toBeTruthy();
      expect(body).toMatch(/position:\s*absolute/);
      expect(body).toMatch(/inset:\s*0;/);
      expect(body).toMatch(/border-radius:\s*inherit/);
      expect(body).toMatch(/pointer-events:\s*none/);
      expect(body).not.toMatch(/inset:\s*-\d/);
    }
    // 旧外围环 Token 与按预设复制动画的写法都已清除。
    expect(themesCss).not.toMatch(/--orb-glow-/);
    expect(themesCss).not.toMatch(/\[data-preset="(?:frosted|dream-gradient)"\][^{]*\.brand-orb::(?:before|after)/);
    // 球体本体尺寸固定，动画只挂在伪元素上，不改布局。
    const base = /\.brand-orb\s*\{([\s\S]*?)\}/.exec(themesCss)?.[1] ?? "";
    expect(base).toMatch(/width:\s*14px/);
    expect(base).toMatch(/height:\s*14px/);
    expect(base).not.toMatch(/animation|transform/);
  });

  it("颜色是圆内静态渐变叠层，变化只发生在 opacity", () => {
    expect(orbRule("before")).toMatch(/--orb-cool:/);
    expect(orbRule("before")).toMatch(/radial-gradient/);
    expect(orbRule("after")).toMatch(/--orb-warm:/);
    expect(orbRule("after")).toMatch(/radial-gradient/);
    // 关键帧不写渐变/阴影/滤镜：色泽层是预先定义的静态渐变，只交替透明度。
    expect(brandOrbKeyframes()).not.toMatch(/background|linear-gradient|radial-gradient/);
  });

  it("7.2s 双周期时间轴：第一口气更快、第二口气更慢、首尾连续", () => {
    for (const body of [orbRule("before"), orbRule("after")]) {
      expect(body).toMatch(/animation:\s*brand-orb-cycle\s+7\.2s\s+linear\s+infinite/);
    }
    const kf = brandOrbKeyframes();
    // 起点与终点同为静息值 → 无缝循环；两个峰值分别落在 24% 与 75.5%。
    expect(kf).toMatch(/0%\s*\{\s*opacity:\s*var\(--orb-layer-min\)/);
    expect(kf).toMatch(/100%\s*\{\s*opacity:\s*var\(--orb-layer-min\)/);
    expect(kf).toMatch(/24%\s*\{\s*opacity:\s*var\(--orb-layer-fast\)/);
    expect(kf).toMatch(/75\.5%\s*\{\s*opacity:\s*var\(--orb-layer-slow\)/);
    // 第一次吸气 1.728s < 第二次吸气 2.436s（同一 7.2s 时间轴）。
    expect((24 / 100) * 7.2).toBeLessThan(((75.5 - 41.67) / 100) * 7.2);
    // 分段缓动承担「加速 → 减速 → 短停 → 慢呼气」；不碰布局/滤镜/阴影。
    expect(kf.match(/cubic-bezier\(/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(kf).not.toMatch(/width|height|transform|scale|filter|box-shadow|backdrop-filter/);
  });

  it("颜色、高光与节奏共用同一关键帧，深浅只通过 Token 调强度", () => {
    expect(themesCss.match(/@keyframes brand-orb-cycle/g)?.length).toBe(1);
    const beforeAnim = /animation:\s*([^;]+);/.exec(orbRule("before"))?.[1]?.trim();
    const afterAnim = /animation:\s*([^;]+);/.exec(orbRule("after"))?.[1]?.trim();
    expect(beforeAnim).toBe(afterAnim);
    const lightFast = Number(/--orb-layer-fast:\s*([\d.]+)/.exec(orbRule("before"))?.[1]);
    const darkFast = Number(/--orb-layer-fast:\s*([\d.]+)/.exec(darkOrbRule("before"))?.[1]);
    const lightSlow = Number(/--orb-layer-slow:\s*([\d.]+)/.exec(orbRule("after"))?.[1]);
    const darkSlow = Number(/--orb-layer-slow:\s*([\d.]+)/.exec(darkOrbRule("after"))?.[1]);
    expect(darkFast).toBeLessThan(lightFast);
    expect(darkSlow).toBeLessThan(lightSlow);
  });

  it("冷色/暖紫由 :root Token 按预设取值，伪元素只消费 Token", () => {
    // 梦幻渐变底色中段本身是紫蓝，必须换更蓝的冷色 Token，才能出现色相转换。
    expect(orbRule("before")).toMatch(/--orb-cool:\s*color-mix\(in srgb, var\(--orb-cool-tone\)/);
    expect(orbRule("after")).toMatch(/--orb-warm:\s*color-mix\(in srgb, var\(--orb-warm-tone\)/);
    expect(darkOrbRule("before")).toMatch(/var\(--orb-cool-tone\)/);
    expect(darkOrbRule("after")).toMatch(/var\(--orb-warm-tone\)/);
    expect(themesCss).toMatch(/\[data-preset="dream-gradient"\][^{]*\{[^}]*--orb-cool-tone:/);
    expect(themesCss).toMatch(/\[data-preset="dream-gradient"\][^{]*\{[^}]*--orb-warm-tone:/);
    // 预设只改 Token，不复制第二套动画。
    expect(themesCss).not.toMatch(/\[data-preset="(?:frosted|dream-gradient)"\][^{]*\.brand-orb::(?:before|after)/);
  });

  it("减少动态时取消双周期循环，保留静态玻璃球", () => {
    const kfStart = themesCss.indexOf("@keyframes brand-orb-cycle");
    const reduceBody = themesCss.slice(themesCss.indexOf("@media (prefers-reduced-motion: reduce)", kfStart));
    expect(reduceBody).toMatch(/\.brand-orb::before\s*\{[^}]*animation:\s*none[^}]*opacity:\s*0\.3/);
    expect(reduceBody).toMatch(/\.brand-orb::after\s*\{[^}]*animation:\s*none[^}]*opacity:\s*0\.12/);
  });

  it("品牌球对读屏隐藏，标题栏结构不被动画影响", () => {
    const { container } = render(<TitleBar />);
    const orb = container.querySelector(".brand-orb");
    expect(orb).toBeTruthy();
    expect(orb!.getAttribute("aria-hidden")).toBe("true");
    // 品牌球自身必须是拖拽热区：Tauri 只认事件 target 上的 data-tauri-drag-region。
    expect(orb!.getAttribute("data-tauri-drag-region")).not.toBeNull();
    expect(container.querySelector(".titlebar .agent-dot")).toBeNull();
    expect(screen.getByText("Task Dock")).toBeTruthy();
  });
});
