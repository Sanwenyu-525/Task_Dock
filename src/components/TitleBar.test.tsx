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

  it("品牌球呼吸光晕由独立伪元素绘制，不参与布局且不可命中", () => {
    const rule = /\.brand-orb::after\s*\{([\s\S]*?)\}/.exec(themesCss);
    expect(rule, "缺少 .brand-orb::after 光晕层").toBeTruthy();
    const body = rule![1];
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/inset:\s*-8px/);
    expect(body).toMatch(/pointer-events:\s*none/);
    expect(body).toMatch(/animation:\s*brand-orb-breathe\s+3\.6s\s+ease-in-out\s+infinite/);
    // 内圈透明，光晕只叠加在球体外围，不把圆圈本体一起洗亮。
    expect(body).toMatch(/transparent 0%/);
    expect(body).toMatch(/transparent 30%/);
    expect(body).toMatch(/radial-gradient/);
  });

  it("呼吸关键帧只改 opacity，不改变圆圈布局尺寸", () => {
    const kfStart = themesCss.indexOf("@keyframes brand-orb-breathe");
    expect(kfStart, "缺少 brand-orb-breathe 关键帧").toBeGreaterThan(-1);
    const kf = themesCss.slice(kfStart, themesCss.indexOf("@media (prefers-reduced-motion", kfStart));
    expect(kf).toMatch(/opacity:\s*var\(--orb-glow-(min|peak)\)/);
    // 关键帧不写宽高/位移/缩放/滤镜/阴影，布局尺寸只由静态规则决定。
    expect(kf).not.toMatch(/width|height|transform|scale|filter|box-shadow|inset/);
  });

  it("浅色与深色使用对应的光晕强度 Token，两套预设共享同一组动画结构", () => {
    const lightPeak = /\.brand-orb::after\s*\{[\s\S]*?--orb-glow-peak:\s*([\d.]+)/.exec(themesCss);
    const darkRule = /:root\[data-theme="dark"\]\s*\.brand-orb::after\s*\{([^}]*)\}/.exec(themesCss);
    expect(lightPeak, "浅色峰值缺失").toBeTruthy();
    expect(Number(lightPeak![1])).toBeGreaterThanOrEqual(0.55);
    expect(Number(lightPeak![1])).toBeLessThanOrEqual(0.70);
    expect(darkRule, "深色峰值缺失").toBeTruthy();
    expect(Number(/--orb-glow-peak:\s*([\d.]+)/.exec(darkRule![1])![1])).toBeLessThan(Number(lightPeak![1]));
    // 两套视觉预设共用同一组 Token：不存在按预设再覆写的光晕规则。
    expect(themesCss).not.toMatch(/\[data-preset="(?:frosted|dream-gradient)"\][^{]*\.brand-orb::after\s*\{/);
    // 同一套 keyframes 通过变量读取两种明暗的峰值，不复制第二份动画。
    expect(themesCss.match(/@keyframes brand-orb-breathe/g)?.length).toBe(1);
  });

  it("减少动态时关闭呼吸，但仍保留静态柔光", () => {
    expect(themesCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.brand-orb::after\s*\{[^}]*animation:\s*none[^}]*opacity:\s*0\.24/,
    );
  });
});
