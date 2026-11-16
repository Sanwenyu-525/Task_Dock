//! 通知窗口样式的**结构守卫**：锁住 2D 语义表面与动效约束，
//! 避免以后改样式时悄悄退回整卡玻璃渐变或常驻高频动画。
//!
//! 硬约束：
//! - 卡片底色消费 `--surface-overlay`，边框消费 `--border-subtle`，
//!   外阴影消费 `--elev-3`，不再维护深/浅两套独立玻璃色板；
//! - 卡片圆角使用 `--radius-xl`；卡片宽 360px、栈间距 6px 保持原型规格；
//! - 状态语义色只落在 `--tone` / 全局 `--status-*`，不整卡铺径向光斑；
//! - 动画只有入场/离场/详情/图标与不确定进度（finite 或卡内存续期），
//!   必须有 prefers-reduced-motion 兜底；
//! - 键盘焦点 focus-visible 必须有独立描边（无障碍）。

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

function exactRule(selector: string): Rule | undefined {
  return RULES.find((r) => r.selector === selector);
}

describe("2D 语义表面", () => {
  it("卡片使用语义表面、1px 轮廓与柔和外阴影，不再铺玻璃渐变", () => {
    const card = rule(".ntf-card");
    expect(card).toBeDefined();
    expect(card!.body).toContain("background: var(--surface-overlay)");
    expect(card!.body).toContain("border: 1px solid var(--border-subtle)");
    expect(card!.body).toContain("box-shadow: var(--elev-3)");
    expect(card!.body).not.toMatch(/radial-gradient|linear-gradient|inset\s+0/);
  });

  it("不再维护浅色主题的独立卡片玻璃色板", () => {
    expect(ntfCss).not.toContain('html[data-theme="light"] .ntf-card');
    expect(rule(".ntf-card")!.body).toContain("border-radius: var(--radius-xl)");
  });

  it("原型规格：卡片 360px、栈间距 6px 保持不变", () => {
    expect(rule(".ntf-stack")!.body).toContain("width: 360px");
    expect(rule(".ntf-stack")!.body).toContain("gap: 6px");
  });

  it("状态图标不再使用径向渐变或发光，状态色只落在图标/描边", () => {
    const status = exactRule(".ntf-status-icon");
    expect(status).toBeDefined();
    expect(status!.body).toContain("background: var(--surface-raised)");
    expect(status!.body).toContain("color: var(--tone)");
    expect(status!.body).not.toContain("radial-gradient");
    expect(status!.body).not.toMatch(/0 0 24px|inset/);
  });
});

describe("状态语义色", () => {
  const tones: Array<[string, string]> = [
    ["--ntf-blue", "var(--status-running)"],
    ["--ntf-amber", "var(--status-waiting)"],
    ["--ntf-green", "var(--status-success)"],
    ["--ntf-red", "var(--status-error)"],
    ["--ntf-orange", "var(--status-waiting)"],
    ["--ntf-purple", "var(--icon-violet)"],
  ];
  for (const [name, value] of tones) {
    it(`${name} 消费全局状态 Token`, () => {
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

describe("品牌图标", () => {
  it("左上角 logo 保持 18px 容器并等比缩放，不变形", () => {
    const symbol = rule(".ntf-app-symbol");
    expect(symbol).toBeDefined();
    expect(symbol!.body).toContain("width: 18px");
    expect(symbol!.body).toContain("height: 18px");
    const img = rule(".ntf-app-symbol img");
    expect(img).toBeDefined();
    expect(img!.body).toContain("object-fit: contain");
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
    const compressed = rule(
      ".ntf-stack.stacked .ntf-slot:not(:last-child) .ntf-actions",
    );
    expect(compressed).toBeDefined();
    expect(compressed!.body).toContain("display: none");
    // 离场槽位负责自然填补（高度收缩），避免其余卡片瞬跳
    expect(rule(".ntf-slot.leaving")!.body).toContain("grid-template-rows: 0fr");
  });

  it("容器空白区不拦截点击（卡片自身恢复 pointer-events）", () => {
    expect(rule(".ntf-root")!.body).toContain("pointer-events: none");
    expect(rule(".ntf-card")!.body).toContain("pointer-events: auto");
  });
});
