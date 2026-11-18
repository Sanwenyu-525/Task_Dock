// @vitest-environment jsdom
//! 底部状态栏「包信息」：一行构建标识、详情弹窗、可复制 JSON、取不到时整项隐藏。
//!
//! 2026-11-17 起明确两层数据：包内构建信息（编译期固定）与当前运行环境 Git 现场
//! （实时读取）。本测试同时锁定「不许拿运行期 HEAD 冒充包内 commit」的边界。
//! 只测组件契约：IPC 与剪贴板由调用方注入替身，时间断言只看格式与 Unix 秒。

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkbenchBuildStatus, {
  buildInfoSnapshot,
  formatBuildStamp,
  formatIsoStamp,
} from "./WorkbenchBuildStatus";
import type { AppBuildInfo, AppRuntimeGitInfo } from "../lib/bridge";

const FULL_COMMIT = "11c9a35000000000000000000000000000000000";

/** 固定样本：短 commit + release + 23.35GB 那台机器的真实字段形状。 */
const SAMPLE: AppBuildInfo = {
  name: "Task Dock",
  version: "0.5.0",
  identifier: "com.taskdock.desktop",
  platform: "windows-x86_64",
  build: {
    commit: "11c9a35",
    commit_full: FULL_COMMIT,
    dirty: "false",
    built_at_unix: "1763283600",
    profile: "release",
    exe: "C:\\Program Files\\Task Dock\\Task Dock.exe",
  },
};

/** 运行环境现场：与包内 commit 故意不同，用来证明两者不会被混用。 */
const RUNTIME_DIRTY: AppRuntimeGitInfo = {
  status: "ok",
  repoRoot: "D:\\Develop\\task_dock",
  branch: "main",
  detached: false,
  headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  dirtyCount: 39,
  probedAt: "2026-11-17T14:33:00+08:00",
};

const RUNTIME_CLEAN: AppRuntimeGitInfo = {
  ...RUNTIME_DIRTY,
  headSha: FULL_COMMIT,
  dirtyCount: 0,
};

const RUNTIME_OUTSIDE: AppRuntimeGitInfo = {
  status: "not_applicable",
  repoRoot: null,
  branch: null,
  detached: false,
  headSha: null,
  dirtyCount: null,
  probedAt: "2026-11-17T14:33:00+08:00",
};

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderStatus(
  info: AppBuildInfo,
  runtime: () => Promise<AppRuntimeGitInfo> = () => Promise.resolve(RUNTIME_CLEAN),
) {
  return render(
    <WorkbenchBuildStatus
      load={() => Promise.resolve(info)}
      loadRuntime={runtime}
      onCopy={vi.fn(async () => true)}
    />,
  );
}

afterEach(cleanup);

describe("WorkbenchBuildStatus", () => {
  it("状态栏一行给出提交 / 配置 / 构建时间，并暴露机器可读字段", async () => {
    renderStatus(SAMPLE);
    await flush();

    const chip = screen.getByRole("button", { name: /查看当前运行包信息/ });
    expect(chip.textContent).toContain("构建 11c9a35");
    expect(chip.textContent).toContain("release");
    expect(chip.textContent).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
    // 自动读取（脚本 / Agent 取 DOM）的稳定字段
    expect(chip.getAttribute("data-build-version")).toBe("0.5.0");
    expect(chip.getAttribute("data-build-identifier")).toBe("com.taskdock.desktop");
    expect(chip.getAttribute("data-build-commit")).toBe("11c9a35");
    expect(chip.getAttribute("data-build-commit-full")).toBe(FULL_COMMIT);
    expect(chip.getAttribute("data-build-dirty")).toBe("false");
    expect(chip.getAttribute("data-build-profile")).toBe("release");
    expect(chip.getAttribute("data-build-built-at-unix")).toMatch(/^\d+$/);
    expect(chip.getAttribute("data-runtime-git-status")).toBe("ok");
    expect(chip.getAttribute("data-runtime-git-dirty")).toBe("0");
    // Hover 提示给完整 Commit，而不是只有短号
    expect(chip.getAttribute("data-tip")).toContain(FULL_COMMIT);
  });

  it("构建时工作树有未提交改动 → 标记「构建时未提交」，不冒充干净构建", async () => {
    const dirty: AppBuildInfo = {
      ...SAMPLE,
      build: { ...SAMPLE.build, dirty: "true" },
    };
    renderStatus(dirty);
    await flush();

    const chip = screen.getByRole("button", { name: /查看当前运行包信息/ });
    expect(chip.textContent).toContain("构建时未提交");
    expect(chip.getAttribute("data-build-dirty")).toBe("true");
  });

  it("点击打开包信息弹窗：包内/运行环境分区，完整与短 commit 同屏", async () => {
    const copy = vi.fn<(text: string) => Promise<boolean>>();
    copy.mockResolvedValue(true);
    const notice = vi.fn();
    render(
      <WorkbenchBuildStatus
        load={() => Promise.resolve(SAMPLE)}
        loadRuntime={() => Promise.resolve(RUNTIME_DIRTY)}
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
    expect(dialog.textContent).toContain("包内构建信息");
    expect(dialog.textContent).toContain("当前运行环境");
    expect(dialog.textContent).toContain(FULL_COMMIT);
    expect(dialog.textContent).toContain("11c9a35");
    expect(dialog.textContent).toContain("Release（发布构建）");
    // 包内构建时干净
    expect(dialog.textContent).toContain("干净");
    // 运行环境同一时刻 39 项未提交，与包内状态分开显示
    expect(dialog.textContent).toContain("39 项未提交");
    expect(dialog.textContent).toContain("D:\\Develop\\task_dock");
    expect(dialog.textContent).toContain("main");
    // 运行期 HEAD 与包内 commit 故意不同：两者都出现，证明没有互相顶替
    expect(dialog.textContent).toContain("aaaaaaaa");

    const machine = screen.getByTestId("wb-build-machine").textContent ?? "";
    expect(machine).toContain(`"commit": "11c9a35"`);
    expect(machine).toContain(`"commitFull": "${FULL_COMMIT}"`);
    expect(machine).toContain('"profile": "release"');
    expect(machine).toContain('"unix": 1763283600');
    expect(machine).toContain('"headSha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
    expect(machine).toContain('"dirtyCount": 39');

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制包信息" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy.mock.calls[0]?.[0]).toBe(machine);
    expect(notice).toHaveBeenCalledWith("ok", "包信息已复制");
  });

  it("运行环境不在 Git 仓库 → 明确「不适用」，不拿未知当 0 项", async () => {
    renderStatus(SAMPLE, () => Promise.resolve(RUNTIME_OUTSIDE));
    await flush();

    const chip = screen.getByRole("button", { name: /查看当前运行包信息/ });
    expect(chip.getAttribute("data-runtime-git-status")).toBe("not_applicable");
    expect(chip.getAttribute("data-runtime-git-dirty")).toBe("unknown");

    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog", { name: "包信息" });
    expect(dialog.textContent).toContain("不适用：当前可执行文件不在 Git 仓库内");
    expect(screen.getByTestId("wb-build-runtime").textContent).not.toContain("39 项");
  });

  it("运行环境读取失败 → 保留包信息与状态栏，只在运行区块显示未知", async () => {
    renderStatus(SAMPLE, () => Promise.reject(new Error("ipc down")));
    await flush();

    const chip = screen.getByRole("button", { name: /查看当前运行包信息/ });
    expect(chip.getAttribute("data-runtime-git-status")).toBe("unavailable");
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog", { name: "包信息" });
    expect(dialog.textContent).toContain("未知（读取失败）");
    expect(dialog.textContent).toContain("11c9a35");
  });

  it.each([
    ["release", "Release（发布构建）"],
    ["debug", "Debug（开发构建）"],
  ])("构建配置 %s → 渠道文案明确", async (profile, expected) => {
    const info: AppBuildInfo = { ...SAMPLE, build: { ...SAMPLE.build, profile } };
    renderStatus(info);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /查看当前运行包信息/ }));
    expect(screen.getByRole("dialog", { name: "包信息" }).textContent).toContain(expected);
  });

  it("旧版本元数据缺失（无 commit_full）→ 完整 Commit 显示未知，短 commit 不伪造", async () => {
    const legacy: AppBuildInfo = {
      ...SAMPLE,
      build: { ...SAMPLE.build, commit_full: undefined, commit: "unknown" },
    };
    renderStatus(legacy, () => Promise.resolve(RUNTIME_DIRTY));
    await flush();

    const chip = screen.getByRole("button", { name: /查看当前运行包信息/ });
    expect(chip.getAttribute("data-build-commit")).toBe("unknown");
    expect(chip.getAttribute("data-build-commit-full")).toBe("unknown");
    fireEvent.click(chip);
    const dialog = screen.getByRole("dialog", { name: "包信息" });
    expect(dialog.textContent).toContain("该构建未写入完整 Commit");
    // 运行期 HEAD 存在，但不得被拿来填包内完整 commit
    expect(dialog.textContent).toContain("aaaaaaaa");
  });

  it("构建时间无效 → 显示未知，不生成 1970 假时间", async () => {
    const invalid: AppBuildInfo = {
      ...SAMPLE,
      build: { ...SAMPLE.build, built_at_unix: "not-a-time" },
    };
    renderStatus(invalid);
    await flush();

    const chip = screen.getByRole("button", { name: /查看当前运行包信息/ });
    expect(chip.getAttribute("data-build-built-at")).toBe("unknown");
    expect(chip.textContent).toContain("未知");
    expect(chip.textContent).not.toContain("1970");
  });

  it("取不到包信息（预览 / IPC 失败）→ 状态栏不渲染该项，也不显示假值", async () => {
    const { container } = render(
      <WorkbenchBuildStatus
        load={() => Promise.reject(new Error("no ipc"))}
        loadRuntime={() => Promise.resolve(RUNTIME_CLEAN)}
      />,
    );
    await flush();
    expect(container.textContent).toBe("");
  });

  it("连构建溯源都没有（commit unknown 且无构建时间）→ 不占用状态栏", async () => {
    renderStatus({
      ...SAMPLE,
      build: { ...SAMPLE.build, commit: "unknown", commit_full: undefined, built_at_unix: "unknown" },
    });
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

  it("运行期 ISO 时间非法 → null，不显示 1970", () => {
    expect(formatIsoStamp("2026-11-17T14:33:00+08:00")?.full).toMatch(/^2026-11-17/);
    expect(formatIsoStamp("not-a-time")).toBeNull();
    expect(formatIsoStamp(null)).toBeNull();
  });

  it("机器可读快照与 IPC 字段一一对应，时间给出 local/iso/unix 三视图", () => {
    const snapshot = buildInfoSnapshot(SAMPLE, formatBuildStamp(SAMPLE.build.built_at_unix), RUNTIME_DIRTY);
    expect(snapshot.version).toBe("0.5.0");
    expect(snapshot.build.commit).toBe("11c9a35");
    expect(snapshot.build.commitFull).toBe(FULL_COMMIT);
    expect(snapshot.build.dirty).toBe("false");
    expect(snapshot.build.builtAt).toMatchObject({ unix: 1763283600 });
    expect(snapshot.runtime).toMatchObject({
      status: "ok",
      dirtyCount: 39,
      observedAt: "2026-11-17T14:33:00+08:00",
    });
  });
});
