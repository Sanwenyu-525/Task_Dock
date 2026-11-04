/**
 * @vitest-environment jsdom
 */
//! 页内编辑表单测试：无弹窗承载、身份字段只读、白名单提交、保存失败保留输入、
//! 连点单次提交、未保存离开确认。后端命令全部 mock。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { useUiStore } from "../../store/useUiStore";
import TargetEditForm from "./TargetEditForm";
import { navUpdateTarget, type NavTarget } from "../../lib/navigation";

vi.mock("../../lib/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/navigation")>();
  return {
    ...actual,
    navUpdateTarget: vi.fn(async () => {}),
  };
});

function targetFix(extra: Partial<NavTarget> = {}): NavTarget {
  return {
    id: "target-obs",
    display_name: "Obsidian",
    target_type: "application",
    app_key: "obsidian",
    exe_path: "C:\\Program Files\\Obsidian\\Obsidian.exe",
    launch_args: "",
    working_dir: "",
    app_user_model_id: "Obsidian.App",
    url: "",
    path: "",
    agent_source_id: "",
    agent_session_id: "",
    window_title_hint: "",
    icon: "",
    category: "dev",
    favorite: false,
    hidden: false,
    last_used_at: null,
    use_count: 0,
    created_at: "2026-11-04T00:00:00Z",
    updated_at: "2026-11-04T00:00:00Z",
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ toast: null });
});

afterEach(cleanup);

describe("TargetEditForm 页内编辑", () => {
  it("以页内区域承载（无 dialog）；身份字段只读展示，不提供输入框", () => {
    render(<TargetEditForm target={targetFix()} onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.queryByRole("dialog")).toBeNull();
    const region = screen.getByRole("region", { name: "编辑应用配置" });
    expect(region.textContent).toContain(targetFix().exe_path);
    expect(region.textContent).toContain("Obsidian.App");
    expect(screen.queryByLabelText("程序路径")).toBeNull();
    expect(screen.queryByLabelText("EXE 路径")).toBeNull();
  });

  it("保存只提交后端白名单字段，成功后回调刷新共享清单", async () => {
    const onSaved = vi.fn(async () => {});
    render(<TargetEditForm target={targetFix()} onClose={vi.fn()} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "Obsidian 笔记" } });
    fireEvent.change(screen.getByLabelText("启动参数"), { target: { value: " --safe-mode " } });
    fireEvent.change(screen.getByLabelText("工作目录"), { target: { value: "D:\\Notes" } });
    fireEvent.change(screen.getByLabelText("窗口标题匹配提示"), { target: { value: "Obsidian" } });
    fireEvent.click(screen.getByRole("switch", { name: "收藏" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(navUpdateTarget).toHaveBeenCalledWith(
        "target-obs",
        expect.objectContaining({
          display_name: "Obsidian 笔记",
          launch_args: "--safe-mode",
          working_dir: "D:\\Notes",
          window_title_hint: "Obsidian",
          favorite: true,
          hidden: false,
        }),
      ),
    );
    const patch = vi.mocked(navUpdateTarget).mock.calls[0][1];
    expect(patch).not.toHaveProperty("exe_path");
    expect(patch).not.toHaveProperty("app_user_model_id");
    expect(patch).not.toHaveProperty("app_key");
    expect(patch).not.toHaveProperty("url");
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it("保存失败：保留表单内容、就近提示，不调用成功回调", async () => {
    const onSaved = vi.fn(async () => {});
    vi.mocked(navUpdateTarget).mockRejectedValueOnce(new Error("数据库繁忙"));
    render(<TargetEditForm target={targetFix()} onClose={vi.fn()} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "Obsidian 笔记" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("数据库繁忙");
    expect((screen.getByLabelText("显示名称") as HTMLInputElement).value).toBe("Obsidian 笔记");
    expect(onSaved).not.toHaveBeenCalled();
    // 失败后可再次保存（按钮解除 busy）
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("连点保存只提交一次", async () => {
    let resolveSave!: () => void;
    vi.mocked(navUpdateTarget).mockImplementation(
      () => new Promise<void>((res) => { resolveSave = res; }),
    );
    render(<TargetEditForm target={targetFix()} onClose={vi.fn()} onSaved={vi.fn()} />);

    const save = screen.getByRole("button", { name: "保存" });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(navUpdateTarget).toHaveBeenCalledTimes(1);

    resolveSave();
    await waitFor(() => expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("无改动时取消直接关闭；有未保存更改时先确认，可继续编辑或放弃", () => {
    const onClose = vi.fn();
    render(<TargetEditForm target={targetFix()} onClose={onClose} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    cleanup();
    const secondClose = vi.fn();
    render(<TargetEditForm target={targetFix()} onClose={secondClose} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "改名后" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(secondClose).not.toHaveBeenCalled();
    const warning = screen.getByRole("alert");
    expect(warning.textContent).toContain("有未保存的更改");

    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("显示名称")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "放弃更改" }));
    expect(secondClose).toHaveBeenCalledTimes(1);
  });

  it("网址目标不显示启动参数/工作目录等应用专属字段", () => {
    render(
      <TargetEditForm
        target={targetFix({ target_type: "url", display_name: "团队文档", url: "https://example.com" })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByText(/https:\/\/example\.com/)).toBeTruthy();
    expect(screen.queryByLabelText("启动参数")).toBeNull();
    expect(screen.queryByLabelText("工作目录")).toBeNull();
  });
});
