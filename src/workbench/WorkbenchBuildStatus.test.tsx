// @vitest-environment jsdom
//! 底部状态栏「包信息」：一行构建标识、详情弹窗、可复制 JSON、取不到时整项隐藏。
//!
//! 只测组件契约：IPC 与剪贴板由调用方注入替身，时间断言只看格式与 Unix 秒，
//! 不依赖运行时区。真实包元信息由 `app_build_info` 提供（Rust 侧同名命令）。

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkbenchBuildStatus, {
  buildInfoSnapshot,
  formatBuildStamp,
} from "./WorkbenchBuildStatus";
import type { AppBuildInfo } from "../lib/bridge";

/** 固定样本：短 commit + release + 23.35GB 那台机器的真实字段形状。 */
const SAMPLE: AppBuildInfo = {
  name: "Task Dock",
  version: "0.5.0",
  identifier: "com.taskdock.desktop",
  platform: "windows-x86_64",
  build: {
    commit: "3086351",
    dirty: "false",
    built_at_unix: "1763283600",
    profile: "release",
    exe: "C:\\Program Files\\Task Dock\\Task Dock.exe",
  },
};

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(cleanup);

describe("WorkbenchBuildStatus", () => {
  it("状态栏一行给出提交 / 配置 / 构建时间，并暴露机器可读字段", async () => {
    render(<WorkbenchBuildStatus load={() => Promise.resolve(SAMPLE)} />);
    await flush();

    const chip = screen.getByRole("button", { name: /查看当前运行包信息/ });
    expect(chip.textContent).toContain("构建 3086351");
    expect(chip.textContent).toContain("release");
    expect(chip.textContent).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
    // 自动读取（脚本 / Agent 取 DOM）的稳定字段
    expect(chip.getAttribute("data-build-version")).toBe("0.5.0");
    expect(chip.getAttribute("data-build-identifier")).toBe("com.taskdock.desktop");
    expect(chip.getAttribute("data-build-commit")).toBe("3086351");
    expect(chip.getAttribute("data-build-dirty")).toBe("false");
    expect(chip.getAttribute("data-build-profile")).toBe("release");
    expect(chip.getAttribute("data-build-built-at-unix")).toMatch(/^\d+$/);
  });

  it("构建时工作树有未提交改动 → 标记「未提交」，不冒充干净构建", async () => {
    const dirty: AppBuildInfo = {
      ...SAMPLE,
      build: { ...SAMPLE.build, dirty: "true" },
    };
    render(<WorkbenchBuildStatus load={() => Promise.resolve(dirty)} />);
    await flush();

    const chip = screen.getByRole("button", { name: /查看当前运行包信息/ });
    expect(chip.textContent).toContain("未提交");
    expect(chip.getAttribute("data-build-dirty")).toBe("true");
  });

  it("点击打开包信息弹窗：字段齐全，并可复制与看到的 JSON 完全一致", async () => {
    const copy = vi.fn<(text: string) => Promise<boolean>>();
    copy.mockResolvedValue(true);
    const notice = vi.fn();
    render(
      <WorkbenchBuildStatus
        load={() => Promise.resolve(SAMPLE)}
        onCopy={copy}
        onNotice={notice}
      />,
    );
    await flush();

    fireEvent.click(screen.getByRole("button", { name: /查看当前运行包信息/ }));
    const dialog = screen.getByRole("dialog", { name: "包信息" });
    expect(dialog.textContent).toContain("Task Dock");
    expect(dialog.textContent).toContain("com.taskdock.desktop");
    expect(dialog.textContent).toContain("windows-x86_64");
    expect(dialog.textContent).toContain("C:\\Program Files\\Task Dock\\Task Dock.exe");
    expect(dialog.textContent).toContain("干净");

    const machine = screen.getByTestId("wb-build-machine").textContent ?? "";
    expect(machine).toContain('"commit": "3086351"');
    expect(machine).toContain('"profile": "release"');
    expect(machine).toContain('"unix": 1763283600');

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制包信息" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy.mock.calls[0]?.[0]).toBe(machine);
    expect(notice).toHaveBeenCalledWith("ok", "包信息已复制");
  });

  it("取不到包信息（预览 / IPC 失败）→ 状态栏不渲染该项，也不显示假值", async () => {
    const { container } = render(
      <WorkbenchBuildStatus load={() => Promise.reject(new Error("no ipc"))} />,
    );
    await flush();
    expect(container.textContent).toBe("");
  });

  it("连构建溯源都没有（commit unknown 且无构建时间）→ 不占用状态栏", async () => {
    render(
      <WorkbenchBuildStatus
        load={() =>
          Promise.resolve({
            ...SAMPLE,
            build: { ...SAMPLE.build, commit: "unknown", built_at_unix: "unknown" },
          })
        }
      />,
    );
    await flush();
    expect(screen.queryByRole("button", { name: /查看当前运行包信息/ })).toBeNull();
  });
});

describe("包信息格式化", () => {
  it("Unix 秒转本地时间；“unknown”/非法值返回 null，不伪造 1970", () => {
    const stamp = formatBuildStamp("1763283600");
    expect(stamp).not.toBeNull();
    expect(stamp?.unix).toBe(1763283600);
    expect(stamp?.compact).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(stamp?.full).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(stamp?.iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(formatBuildStamp("unknown")).toBeNull();
    expect(formatBuildStamp("0")).toBeNull();
    expect(formatBuildStamp("")).toBeNull();
  });

  it("机器可读快照与 IPC 字段一一对应，时间给出 local/iso/unix 三视图", () => {
    const snapshot = buildInfoSnapshot(SAMPLE, formatBuildStamp(SAMPLE.build.built_at_unix));
    expect(snapshot.version).toBe("0.5.0");
    expect(snapshot.build.commit).toBe("3086351");
    expect(snapshot.build.dirty).toBe("false");
    expect(snapshot.build.builtAt).toMatchObject({ unix: 1763283600 });
  });
});
