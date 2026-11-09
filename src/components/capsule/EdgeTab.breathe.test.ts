//! 极简标签「仅活动态呼吸」样式契约（2026-11-09）。
//!
//! 设计结论：极简态要尽量安静，常驻呼吸会稀释「呼吸 = 活动态」的语义
//! （胶囊状态球已经用它表达 running / waiting / failed），也与极简态
//! 「不打扰」的定位冲突。因此只允许三个活动态呼吸，idle / unknown /
//! disconnected 保持静态；呼吸只动 2×18 状态线的透明度（标签窗口被
//! SetWindowRgn 裁成 10×46，外侧光晕画不出来），并在
//! `prefers-reduced-motion: reduce` 下退回静态。

import { describe, expect, it } from "vitest";
import appCss from "../../styles.css?raw";

const CSS = appCss.replace(/\/\*[\s\S]*?\*\//g, "");

/** 取 `marker` 起点处的第一个平衡 `{...}` 块（支持嵌套 @media / @keyframes）。 */
function blockAt(marker: string, from = 0): string {
  const start = CSS.indexOf(marker, from);
  if (start < 0) throw new Error("missing: " + marker);
  let depth = 0;
  for (let i = start; i < CSS.length; i += 1) {
    if (CSS[i] === "{") depth += 1;
    else if (CSS[i] === "}") {
      depth -= 1;
      if (depth === 0) return CSS.slice(start, i + 1);
    }
  }
  throw new Error("unbalanced block: " + marker);
}

/** 同一选择器可能拆成多条规则（背景色一条、呼吸一条），合并后再断言。 */
function ruleBodies(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...CSS.matchAll(new RegExp(escaped + "\\s*\\{([^}]*)\\}", "g"))];
  if (matches.length === 0) throw new Error("rule not found: " + selector);
  return matches.map((m) => m[1]).join("\n");
}

const lineSelector = (tone: string) => `.capsule-tab[data-tone="${tone}"] .capsule-tab-line`;

describe("极简标签状态线呼吸（仅活动态）", () => {
  it("关键帧只动透明度，不做尺寸/位移", () => {
    const keyframes = blockAt("@keyframes capsule-tab-line-breathe");
    const properties = new Set([...keyframes.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]));
    expect(properties).toEqual(new Set(["opacity"]));
  });

  it.each([
    ["running", "3.2s"],
    ["waiting", "2.2s"],
    ["failed", "2.6s"],
  ])("%s 使用与胶囊状态球同节奏的呼吸（%s）", (tone, duration) => {
    const body = ruleBodies(lineSelector(tone));
    expect(body).toContain("animation: capsule-tab-line-breathe");
    expect(body).toContain(duration);
    expect(body).toContain("infinite");
  });

  it.each(["idle", "unknown", "disconnected"])("%s 保持静态，不挂动画", (tone) => {
    const body = ruleBodies(lineSelector(tone));
    expect(body).not.toContain("animation");
  });

  it("prefers-reduced-motion 下三种活动态退回静态（颜色仍表达 tone）", () => {
    const reduced = [...CSS.matchAll(/@media \(prefers-reduced-motion: reduce\)/g)]
      .map((m) => blockAt("@media (prefers-reduced-motion: reduce)", m.index ?? 0))
      .filter((block) => block.includes(lineSelector("running")));
    expect(reduced).toHaveLength(1);
    expect(reduced[0]).toContain("animation: none");
    expect(reduced[0]).toContain("opacity: 0.9");
    for (const tone of ["running", "waiting", "failed"]) {
      expect(reduced[0]).toContain(lineSelector(tone));
    }
  });

  it("reduced-motion 覆盖排在动画声明之后（同 specificity 下能生效）", () => {
    const reduced = CSS.slice(
      CSS.indexOf("@media (prefers-reduced-motion: reduce)", CSS.indexOf("capsule-tab-line-breathe")),
    );
    expect(reduced.indexOf(lineSelector("running"))).toBeGreaterThanOrEqual(0);
    expect(CSS.indexOf("animation: capsule-tab-line-breathe")).toBeLessThan(
      CSS.indexOf(reduced),
    );
  });
});
