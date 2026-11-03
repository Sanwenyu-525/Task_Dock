//! 通知窗口样式的**结构守卫**：锁住 C 方案的材质与动效约束，
//! 避免以后改样式时悄悄退化成不透明色板或常驻高频动画。
//!
//! 硬约束：
//! - 深/浅两套卡片底色都必须是**有层次的半透明渐变**（玻璃，不是纯色平涂）；
//! - 卡片圆角 16px、栈内间距 8px、卡片宽 360px（原型规格）；
//! - 动画只有入场/离场/详情/图标与不确定进度（finite 或卡内存续期），
//!   必须有 prefers-reduced-motion 兜底；
//! - 键盘焦点 focus-visible 必须有独立描边（无障碍）；
//! - 状态语义色六值与原型一致。

import { describe, expect, it } from "vitest";
import ntfCss from "./styles-notifications.css?raw";

interface Rule {
  selector: string;
  body: string;
}

const RULES: Rule[] = [...ntfCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1].trim().replace(/\s+/g, " "),
  body: m[2],
}));

function rule(selectorIncludes: string): Rule | undefined {
  return RULES.find((r) => r.selector.includes(selectorIncludes));
}

describe("玻璃材质（深浅两套）", () => {
  it("深色卡片底色是有层次的半透明渐变，不是纯色平涂", () => {
    const card = rule(".ntf-card");
    expect(card).toBeDefined();
    expect(card!.body).toContain("linear-gradient(145deg");
    expect(card!.body).toContain("radial-gradient(");
    expect(card!.body).not.toMatch(/background:\s*#\w+\s*;/);
  });

  it("浅色主题有独立卡片底色且为半透明渐变", () => {
    const light = rule('html[data-theme="light"] .ntf-card');
    expect(light).toBeDefined();
    expect(light!.body).toContain("linear-gradient(145deg");
    expect(light!.body).toContain("rgba(246, 250, 255");
  });

  it("原型规格：圆角 16px、卡片 360px、栈间距 8px", () => {
    expect(rule(".ntf-card")!.body).toContain("border-radius: 16px");
    expect(rule(".ntf-stack")!.body).toContain("width: 360px");
    expect(rule(".ntf-stack")!.body).toContain("gap: 8px");
  });
});

describe("状态语义色（原型 C 方案六值）", () => {
  const tones: Array<[string, string]> = [
    ["--ntf-blue", "#3882f6"],
    ["--ntf-amber", "#f5b90b"],
    ["--ntf-green", "#22c55e"],
    ["--ntf-red", "#ef4444"],
    ["--ntf-orange", "#f97316"],
    ["--ntf-purple", "#a855f7"],
  ];
  for (const [name, value] of tones) {
    it(`${name} = ${value}`, () => {
      expect(ntfCss).toContain(`${name}: ${value}`);
    });
  }

  it("六种状态 + 摘要卡各自映射到独立色调", () => {
    for (const state of [
      "agent_running",
      "agent_waiting",
      "agent_done",
      "agent_failed",
      "agent_disconnected",
      "digest",
    ]) {
      expect(rule(`.ntf-card[data-state="${state}"]`)).toBeDefined();
    }
  });
});

describe("动效约束", () => {
  it("入场/离场时长符合原型（260ms / 200ms）", () => {
    expect(ntfCss).toContain("ntfEnter 0.26s");
    expect(ntfCss).toContain("ntfExit 0.2s");
  });

  it("必须有 prefers-reduced-motion 兜底", () => {
    expect(ntfCss).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("无限循环动画只允许 图标旋转 与 不确定进度（无常驻高频动效）", () => {
    const infiniteRules = RULES.filter((r) => r.body.includes("infinite"));
    expect(infiniteRules.length).toBe(2);
    for (const r of infiniteRules) {
      expect(
        r.selector.includes(".ntf-spin") || r.selector.includes(".indeterminate"),
        `意外的 infinite 动画：${r.selector}`,
      ).toBe(true);
    }
  });
});

describe("交互与可读性", () => {
  it("键盘焦点有独立 focus-visible 描边", () => {
    expect(rule(".ntf-cta:focus-visible")).toBeDefined();
    expect(rule(".ntf-cta:focus-visible")!.body).toContain("outline: 2px solid");
  });

  it("按钮具备 hover 与 disabled 态", () => {
    expect(rule(".ntf-cta:hover")).toBeDefined();
    expect(rule(".ntf-cta:disabled")).toBeDefined();
  });

  it("长文本截断而非撑破布局（正文 line-clamp）", () => {
    expect(rule(".ntf-body")!.body).toContain("-webkit-line-clamp");
  });

  it("堆叠压缩：非最新卡隐藏操作与元信息区块", () => {
    const compressed = rule(".ntf-stack.stacked .ntf-card:not(:last-child) .ntf-actions");
    expect(compressed).toBeDefined();
    expect(compressed!.body).toContain("display: none");
  });

  it("容器空白区不拦截点击（卡片自身恢复 pointer-events）", () => {
    expect(rule(".ntf-root")!.body).toContain("pointer-events: none");
    expect(rule(".ntf-card")!.body).toContain("pointer-events: auto");
  });
});
