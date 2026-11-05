/**
 * @vitest-environment jsdom
 */
//! 应用网格顺序：归一化、加号参与排序、增删稳定与损坏配置回退。

import { beforeEach, describe, expect, it } from "vitest";
import {
  APP_ADD_KEY,
  APP_GRID_ORDER_KEY,
  buildAppGrid,
  clearAppGridOrder,
  filterAppGrid,
  moveAppGridBy,
  moveAppGridId,
  normalizeAppGridOrder,
  readAppGridOrder,
  writeAppGridOrder,
} from "./appGridOrder";

const apps = (...ids: string[]) => ids.map((id) => ({ id }));

beforeEach(() => {
  clearAppGridOrder();
});

describe("normalizeAppGridOrder", () => {
  it("去重、丢弃空串/非法值，保留加号一次", () => {
    expect(
      normalizeAppGridOrder([APP_ADD_KEY, "a", "a", "", 42, null, "b"]),
    ).toEqual([APP_ADD_KEY, "a", "b"]);
    expect(normalizeAppGridOrder([])).toBeNull();
    expect(normalizeAppGridOrder("bad")).toBeNull();
  });

  it("超长 ID 被丢弃，但加号伪项不受长度限制", () => {
    const long = "x".repeat(201);
    expect(normalizeAppGridOrder([long, APP_ADD_KEY])).toEqual([APP_ADD_KEY]);
  });
});

describe("buildAppGrid", () => {
  it("默认自然顺序，加号在末尾", () => {
    expect(buildAppGrid(apps("a", "b"), null).map((e) => e.id)).toEqual([
      "a",
      "b",
      APP_ADD_KEY,
    ]);
  });

  it("加号可位于中间；未知/已删除 ID 被跳过；新增应用追加末尾", () => {
    expect(
      buildAppGrid(apps("a", "b", "c"), ["a", APP_ADD_KEY, "deleted", "b"]).map(
        (e) => e.id,
      ),
    ).toEqual(["a", APP_ADD_KEY, "b", "c"]);
  });

  it("恰好一个加号；重复保存也只保留首次位置", () => {
    const entries = buildAppGrid(apps("a"), [APP_ADD_KEY, "a", APP_ADD_KEY]);
    expect(entries.filter((e) => e.type === "add")).toHaveLength(1);
    expect(entries.map((e) => e.id)).toEqual([APP_ADD_KEY, "a"]);
  });

  it("搜索过滤时加号跟随前面仍匹配的应用，不固定跳到末尾", () => {
    const entries = buildAppGrid(apps("a", "b", "c"), ["a", APP_ADD_KEY, "b", "c"]);
    expect(filterAppGrid(entries, new Set(["c"])).map((e) => e.id)).toEqual([
      APP_ADD_KEY,
      "c",
    ]);
    expect(filterAppGrid(entries, new Set(["b"])).map((e) => e.id)).toEqual([
      APP_ADD_KEY,
      "b",
    ]);
  });
});

describe("move helpers", () => {
  it("before/after 与键盘移动都不越界", () => {
    const order = ["a", APP_ADD_KEY, "b"];
    expect(moveAppGridId(order, "b", "a", false)).toEqual(["b", "a", APP_ADD_KEY]);
    expect(moveAppGridId(order, "a", "b", true)).toEqual([APP_ADD_KEY, "b", "a"]);
    expect(moveAppGridBy(order, APP_ADD_KEY, -1)).toEqual([APP_ADD_KEY, "a", "b"]);
    expect(moveAppGridBy(order, "a", -1)).toEqual(order);
  });
});

describe("storage", () => {
  it("写入/读取往返；损坏 JSON 与未知版本回退 null", () => {
    writeAppGridOrder(["a", APP_ADD_KEY]);
    expect(readAppGridOrder()).toEqual(["a", APP_ADD_KEY]);

    localStorage.setItem(APP_GRID_ORDER_KEY, "{not-json");
    expect(readAppGridOrder()).toBeNull();

    localStorage.setItem(
      APP_GRID_ORDER_KEY,
      JSON.stringify({ version: 99, order: ["a"] }),
    );
    expect(readAppGridOrder()).toBeNull();
  });

  it("写空数组等价于清除手动顺序", () => {
    writeAppGridOrder(["a"]);
    writeAppGridOrder([]);
    expect(readAppGridOrder()).toBeNull();
  });
});
