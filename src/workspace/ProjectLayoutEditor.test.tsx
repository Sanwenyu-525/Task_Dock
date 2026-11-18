/**
 * @vitest-environment jsdom
 */
//! 布局编辑器：概览不可隐藏、隐藏当前模块回落概览、保存 payload 为真实 layout_json。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import ProjectLayoutEditor from "./ProjectLayoutEditor";
import { defaultLayout, WORKSPACE_PROFILES, type WorkspaceLayoutConfig } from "./workspaceProfiles";

const DEV = WORKSPACE_PROFILES.development;

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
});
