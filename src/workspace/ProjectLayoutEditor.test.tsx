/**
 * @vitest-environment jsdom
 */
//! 布局编辑器：概览不可隐藏、隐藏当前模块回落概览、保存 payload 为真实 layout_json。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import ProjectLayoutEditor from "./ProjectLayoutEditor";
import { defaultLayout, WORKSPACE_PROFILES, type WorkspaceLayoutConfig } from "./workspaceProfiles";

const DEV = WORKSPACE_PROFILES.development;
const NOVEL = WORKSPACE_PROFILES.novel;

afterEach(() => cleanup());

describe("ProjectLayoutEditor", () => {
  it("概览固定且不可隐藏；隐藏当前模块后保存为 activeModule=overview", async () => {
    const onSave = vi.fn(async (_layout: WorkspaceLayoutConfig) => "ok" as const);
    const onClose = vi.fn();
    render(
      <ProjectLayoutEditor
        open
        profile={DEV}
        layout={{ ...defaultLayout(DEV), activeModule: "items" }}
        archived={false}
        onClose={onClose}
        onSave={onSave}
      />,
    );

    expect((screen.getByRole("button", { name: "隐藏 概览" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "隐藏 开发事项" }));
    fireEvent.click(screen.getByRole("button", { name: "保存布局" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const layout = onSave.mock.calls[0][0] as {
      hiddenModules: string[];
      activeModule: string;
      moduleOrder: string[];
    };
    expect(layout.hiddenModules).toContain("items");
    expect(layout.activeModule).toBe("overview");
    expect(layout.moduleOrder[0]).toBe("overview");
    expect(onClose).toHaveBeenCalled();
  });

  it("归档项目不能保存", () => {
    render(
      <ProjectLayoutEditor
        open
        profile={DEV}
        layout={defaultLayout(DEV)}
        archived
        onClose={() => {}}
        onSave={async () => "ok"}
      />,
    );
    expect((screen.getByRole("button", { name: "保存布局" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("小说：分组展示概览/正文/设定/推进/项目设置，隐藏人物后回退到世界观", async () => {
    const onSave = vi.fn(async (_layout: WorkspaceLayoutConfig) => "ok" as const);
    render(
      <ProjectLayoutEditor
        open
        profile={NOVEL}
        layout={{ ...defaultLayout(NOVEL), activeModule: "characters" }}
        archived={false}
        onClose={() => {}}
        onSave={onSave}
      />,
    );

    for (const label of ["概览", "正文", "设定", "推进", "项目设置"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // 一级分组的上移按钮存在；概览分组固定（按钮禁用）
    expect((screen.getByRole("button", { name: "上移分组 概览" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "隐藏 人物" }));
    fireEvent.click(screen.getByRole("button", { name: "保存布局" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const layout = onSave.mock.calls[0][0];
    expect(layout.hiddenModules).toEqual(["characters"]);
    // 设定组仍保留世界观，当前模块不被踢回概览
    expect(layout.activeModule).toBe("worldview");
  });

  it("小说：一级分组排序会展平为模块 ID 数组", async () => {
    const onSave = vi.fn(async (_layout: WorkspaceLayoutConfig) => "ok" as const);
    render(
      <ProjectLayoutEditor
        open
        profile={NOVEL}
        layout={defaultLayout(NOVEL)}
        archived={false}
        onClose={() => {}}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "上移分组 推进" }));
    fireEvent.click(screen.getByRole("button", { name: "保存布局" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const order = onSave.mock.calls[0][0].moduleOrder;
    expect(order.indexOf("items")).toBeLessThan(order.indexOf("characters"));
    expect(order.indexOf("links")).toBeLessThan(order.indexOf("characters"));
    expect(order[0]).toBe("overview");
  });

  it("小说：整组隐藏后当前模块回退概览", async () => {
    const onSave = vi.fn(async (_layout: WorkspaceLayoutConfig) => "ok" as const);
    render(
      <ProjectLayoutEditor
        open
        profile={NOVEL}
        layout={{ ...defaultLayout(NOVEL), activeModule: "worldview" }}
        archived={false}
        onClose={() => {}}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "隐藏 人物" }));
    fireEvent.click(screen.getByRole("button", { name: "隐藏 世界观" }));
    fireEvent.click(screen.getByRole("button", { name: "保存布局" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].activeModule).toBe("overview");
  });
});
