// 图标契约测试：语义表与生成位图必须一一对应，且位图必须是合法的透明 PNG data URI。
// 这条测试的价值是挡住「加了语义名却忘了重跑生成器」和「生成器输出被手改」两类事故。
import { describe, expect, it } from "vitest";

import iconMap from "../iconMap.json";
import { ICON_BITMAP } from "../iconAssets.g";

const names = Object.keys(iconMap.map);

describe("icon map / bitmap contract", () => {
  it("每个语义名都有 md 位图", () => {
    for (const name of names) {
      expect(ICON_BITMAP[name], name).toBeTruthy();
      expect(ICON_BITMAP[name].md.startsWith("data:image/png;base64,"), name).toBe(true);
    }
  });

  it("位图里没有多余的键", () => {
    expect(Object.keys(ICON_BITMAP).sort()).toEqual([...names].sort());
  });

  it("small / large 清单只引用已存在的语义名", () => {
    for (const name of iconMap.small) expect(names, name).toContain(name);
    for (const name of iconMap.large) expect(names, name).toContain(name);
  });

  it("声明过的细线 / 大尺寸变体确实生成了", () => {
    for (const name of iconMap.small) expect(ICON_BITMAP[name].sm, name).toBeTruthy();
    for (const name of iconMap.large) expect(ICON_BITMAP[name].lg, name).toBeTruthy();
  });

  it("位图可被解码成 PNG 头（防止把别的格式贴进 data URI）", () => {
    for (const name of names) {
      const base64 = ICON_BITMAP[name].md.split(",")[1];
      const head = Buffer.from(base64.slice(0, 24), "base64");
      expect([...head.subarray(0, 8)], name).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
  });

  it("lucide 名称格式合法（小写短横线）", () => {
    for (const [name, lucide] of Object.entries(iconMap.map)) {
      expect(lucide, name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});
