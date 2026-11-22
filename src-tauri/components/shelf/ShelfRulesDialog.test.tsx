/**
 * @vitest-environment jsdom
 */
//! 收集规则对话框：默认关闭、编辑校验、预览不落库、保存并应用。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  shelfRulesPreview: vi.fn(),
  shelfRulesApply: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return { ...actual, ...api };
});

import ShelfRulesDialog from "./ShelfRulesDialog";
import { useShelfStore } from "../../store/useShelfStore";
import { useUiStore } from "../../store/useUiStore";

const GROUP = {
  id: "shelf-work",
  name: "工作资料",
  builtin: true,
  sort_order: 1,
  created_at: "2026-01-01T00:00:00Z",
  item_count: 0,
};

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  api.getSettings.mockResolvedValue({ shelf_collect_rules: null });
  api.updateSettings.mockResolvedValue({});
  useShelfStore.setState({ groups: [GROUP] });
  useUiStore.setState({ toast: null, toasts: [] });
});

afterEach(() => cleanup());

async function createRule() {
  fireEvent.click(await screen.findByRole("button", { name: /新建规则/ }));
  const ext = await screen.findByLabelText("后缀条件 规则 1");
  fireEvent.change(ext, { target: { value: "pdf, .PDF" } });
  fireEvent.change(screen.getByLabelText("动作值 规则 1"), { target: { value: "文档" } });
  fireEvent.click(screen.getByLabelText("启用规则 规则 1"));
}

describe("ShelfRulesDialog", () => {
  it("新建规则默认关闭，启用并保存后写入设置", async () => {
    render(<ShelfRulesDialog open onClose={() => {}} />);
    await screen.findByText(/还没有规则/);
    fireEvent.click(screen.getByRole("button", { name: /新建规则/ }));

    // 默认未启用：保存写入 enabled=false。
    fireEvent.click(screen.getByRole("button", { name: "保存规则" }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    const first = api.updateSettings.mock.calls[0][0] as {
      shelf_collect_rules: { rules: { enabled: boolean }[] };
    };
    expect(first.shelf_collect_rules.rules[0].enabled).toBe(false);

    api.updateSettings.mockClear();
    await createRule();
    fireEvent.click(screen.getByRole("button", { name: "保存规则" }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    const second = api.updateSettings.mock.calls[0][0] as {
      shelf_collect_rules: {
        rules: { enabled: boolean; match: { exts: string[] }; action: { value: string } }[];
      };
    };
    expect(second.shelf_collect_rules.rules[0].enabled).toBe(true);
    expect(second.shelf_collect_rules.rules[0].match.exts).toEqual(["pdf", ".PDF"]);
    expect(second.shelf_collect_rules.rules[0].action.value).toBe("文档");
  });

  it("预览使用草稿且不写入设置", async () => {
    api.shelfRulesPreview.mockResolvedValue({
      evaluated_items: 5,
      matched_items: 2,
      matches: [
        {
          rule_id: "rule-1",
          rule_name: "规则 1",
          item_id: "a",
          item_name: "合同.pdf",
          action_type: "add_tag",
          action_value: "文档",
        },
      ],
      conflicts: [
        { item_id: "a", item_name: "合同.pdf", rule_ids: ["r1", "r2"], rule_names: ["A", "B"] },
      ],
      per_rule: [{ rule_id: "rule-1", rule_name: "规则 1", matched: 2 }],
      truncated: false,
    });
    render(<ShelfRulesDialog open onClose={() => {}} />);
    await createRule();
    fireEvent.click(screen.getByRole("button", { name: /预览匹配/ }));

    await waitFor(() => expect(api.shelfRulesPreview).toHaveBeenCalled());
    const draft = api.shelfRulesPreview.mock.calls[0][0] as { rules: { enabled: boolean }[] };
    expect(draft.rules[0].enabled).toBe(true);
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect((await screen.findByRole("region", { name: "规则预览结果" })).textContent).toContain(
      "命中 2 项",
    );
    expect(screen.getByText(/同时命中多条规则/)).toBeTruthy();
  });

  it("保存并应用先落库再应用，并展示结果", async () => {
    api.shelfRulesApply.mockResolvedValue({
      evaluated_items: 5,
      applied: 2,
      tagged: 1,
      grouped: 1,
      skipped: 0,
      entries: [
        {
          item_id: "a",
          item_name: "合同.pdf",
          rule_id: "rule-1",
          action_type: "add_tag",
          action_value: "文档",
          applied: true,
          reason: null,
        },
      ],
      truncated: false,
    });
    render(<ShelfRulesDialog open onClose={() => {}} />);
    await createRule();
    fireEvent.click(screen.getByRole("button", { name: /保存并应用/ }));

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    await waitFor(() => expect(api.shelfRulesApply).toHaveBeenCalled());
    expect((await screen.findByRole("region", { name: "规则应用结果" })).textContent).toContain(
      "应用 2 项",
    );
  });

  it("启用规则缺少匹配条件时阻止保存与预览", async () => {
    render(<ShelfRulesDialog open onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /新建规则/ }));
    fireEvent.click(screen.getByLabelText("启用规则 规则 1"));
    fireEvent.change(screen.getByLabelText("动作值 规则 1"), { target: { value: "文档" } });

    fireEvent.click(screen.getByRole("button", { name: "保存规则" }));
    expect((await screen.findByRole("alert")).textContent).toContain("至少填写后缀或名称关键词");
    expect(api.updateSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /预览匹配/ }));
    expect(api.shelfRulesPreview).not.toHaveBeenCalled();
  });

  it("没有启用规则时禁用应用按钮", async () => {
    render(<ShelfRulesDialog open onClose={() => {}} />);
    await screen.findByText(/还没有规则/);
    const apply = screen.getByRole("button", { name: /保存并应用/ }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
  });
});
