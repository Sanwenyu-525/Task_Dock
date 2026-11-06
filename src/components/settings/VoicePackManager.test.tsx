/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import VoicePackManager from "./VoicePackManager";
import { useSettingsStore } from "../../store/useSettingsStore";
import { __resetLocaleForTests, setLocalePreference } from "../../i18n";
import type { VoiceAsset, VoiceEventKind, VoicePack } from "../../lib/bridge";

const mocks = vi.hoisted(() => ({
  voicePacksList: vi.fn(),
  voicePackCreate: vi.fn(),
  voicePackRename: vi.fn(),
  voicePackDelete: vi.fn(),
  voiceAssetImport: vi.fn(),
  voiceAssetRemove: vi.fn(),
  voiceBindingSet: vi.fn(),
  updateSettings: vi.fn(),
  open: vi.fn(),
  previewCustomAsset: vi.fn(),
  stopPreview: vi.fn(),
}));

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    voicePacksList: mocks.voicePacksList,
    voicePackCreate: mocks.voicePackCreate,
    voicePackRename: mocks.voicePackRename,
    voicePackDelete: mocks.voicePackDelete,
    voiceAssetImport: mocks.voiceAssetImport,
    voiceAssetRemove: mocks.voiceAssetRemove,
    voiceBindingSet: mocks.voiceBindingSet,
    updateSettings: mocks.updateSettings,
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));

vi.mock("../../lib/audioNotification", () => ({
  getAudioService: () => ({
    previewCustomAsset: mocks.previewCustomAsset,
    stopPreview: mocks.stopPreview,
  }),
}));

let packs: VoicePack[];

function asset(id: string, displayName = `${id}.mp3`): VoiceAsset {
  return {
    id,
    displayName,
    mediaType: "audio/mpeg",
    durationMs: 2300,
    sizeBytes: 2048,
  };
}

function pack(id: string, name = id, assets: VoiceAsset[] = [], bindings: VoicePack["bindings"] = []): VoicePack {
  return {
    id,
    name,
    assets,
    bindings,
    storageBytes: assets.reduce((sum, item) => sum + item.sizeBytes, 0),
  };
}

function seedSettings(packId = "", enabled = false) {
  useSettingsStore.setState({
    settings: {
      tts_voice_pack_enabled: enabled,
      tts_voice_pack_id: packId,
      tts_voice_route: "auto",
    } as never,
  });
}

async function renderLoaded() {
  const result = render(<VoicePackManager />);
  await waitFor(() => expect(mocks.voicePacksList).toHaveBeenCalled());
  return result;
}

beforeEach(() => {
  setLocalePreference("zh-CN");
  packs = [];
  vi.clearAllMocks();
  mocks.voicePacksList.mockImplementation(async () => packs.map((item) => structuredClone(item)));
  mocks.voicePackCreate.mockResolvedValue("created-pack");
  mocks.voicePackRename.mockResolvedValue(undefined);
  mocks.voicePackDelete.mockResolvedValue(undefined);
  mocks.voiceAssetImport.mockResolvedValue({ ok: true, code: "ok", asset: asset("imported") });
  mocks.voiceAssetRemove.mockResolvedValue(undefined);
  mocks.voiceBindingSet.mockResolvedValue(undefined);
  mocks.updateSettings.mockImplementation(async (patch: Record<string, unknown>) => ({
    ...(useSettingsStore.getState().settings ?? {}),
    ...patch,
  }));
  mocks.open.mockResolvedValue(null);
  mocks.previewCustomAsset.mockResolvedValue({ ok: true, code: "ok" });
  mocks.stopPreview.mockImplementation(() => undefined);
  seedSettings();
});

afterEach(() => {
  cleanup();
  __resetLocaleForTests();
  useSettingsStore.setState({ settings: null, materialInfo: null });
});

describe("自定义语音包管理", () => {
  it("显示空状态和可访问的启用开关", async () => {
    render(<VoicePackManager />);

    expect(await screen.findByText("还没有语音包。创建一个语音包后即可导入 MP3 或 WAV 片段。")).toBeTruthy();
    const enabled = screen.getByRole("switch", { name: "启用自定义语音包" }) as HTMLInputElement;
    expect(enabled.disabled).toBe(true);
    expect(screen.getByRole("textbox", { name: "新语音包名称" })).toBeTruthy();
  });

  it("列出多个语音包并标明当前且已启用的包", async () => {
    packs = [pack("pack-a", "工作通知"), pack("pack-b", "个人提醒")];
    seedSettings("pack-b", true);
    await renderLoaded();

    expect(screen.getByText("工作通知")).toBeTruthy();
    expect(screen.getByText("个人提醒")).toBeTruthy();
    expect(screen.getByText("当前语音包")).toBeTruthy();
    expect(screen.getByText("已启用")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "播报路由" })).toBeTruthy();
  });

  it("可以绑定和清除某类事件的片段", async () => {
    const user = userEvent.setup();
    packs = [pack("pack-a", "工作通知", [asset("done", "完成.mp3")])];
    seedSettings("pack-a");
    mocks.voiceBindingSet.mockImplementation(async (packId: string, eventKind: VoiceEventKind, assetId: string | null) => {
      packs = packs.map((entry) => {
        if (entry.id !== packId) return entry;
        const bindings = entry.bindings.filter((binding) => binding.eventKind !== eventKind);
        return {
          ...entry,
          bindings: assetId ? [...bindings, { eventKind, assetId }] : bindings,
        };
      });
    });
    await renderLoaded();

    await user.click(screen.getByRole("combobox", { name: "Agent 完成：选择语音片段" }));
    await user.click(screen.getByRole("option", { name: "完成.mp3" }));
    await waitFor(() => expect(mocks.voiceBindingSet).toHaveBeenLastCalledWith("pack-a", "agent_done", "done"));

    await user.click(screen.getByRole("button", { name: "清除「Agent 完成」绑定" }));
    await waitFor(() => expect(mocks.voiceBindingSet).toHaveBeenLastCalledWith("pack-a", "agent_done", null));
  });

  it("多选导入逐项显示成功、失败与超过 15 秒警告，且不展示本机路径", async () => {
    const user = userEvent.setup();
    packs = [pack("pack-a", "工作通知")];
    seedSettings("pack-a");
    mocks.open.mockResolvedValue([
      "C:\\incoming\\ok.mp3",
      "C:\\incoming\\long.wav",
      "C:\\incoming\\bad.wav",
    ]);
    mocks.voiceAssetImport.mockImplementation(async (_packId: string, path: string) => {
      if (path.endsWith("long.wav")) {
        return { ok: true, code: "ok", asset: asset("long", "long.wav"), durationWarning: true };
      }
      if (path.endsWith("bad.wav")) return { ok: false, code: "disk_full" };
      return { ok: true, code: "ok", asset: asset("ok", "ok.mp3") };
    });
    const { container } = await renderLoaded();

    await user.click(screen.getByRole("button", { name: "向语音包「工作通知」导入音频" }));

    const results = await screen.findByRole("status", { name: "导入结果" });
    expect(results.getAttribute("aria-live")).toBe("polite");
    expect(results.textContent).toContain("long.wav");
    expect(await screen.findByText("导入成功；片段超过 15 秒，建议剪短后使用。")).toBeTruthy();
    expect(screen.getByText("存储空间不足，无法保存片段。")).toBeTruthy();
    expect(screen.getByText("ok.mp3")).toBeTruthy();
    expect(container.textContent).not.toContain("C:\\incoming");
    expect(mocks.voiceAssetImport).toHaveBeenCalledTimes(3);
  });

  it("试听时显示停止状态，点击停止并在卸载时释放试听", async () => {
    const user = userEvent.setup();
    packs = [pack("pack-a", "工作通知", [asset("done", "完成.mp3")], [{ eventKind: "agent_done", assetId: "done" }])];
    seedSettings("pack-a");
    mocks.previewCustomAsset.mockReturnValue(new Promise(() => undefined));
    const { unmount } = await renderLoaded();

    const assetPreview = screen.getByRole("button", { name: "试听片段：完成.mp3" });
    const eventPreview = screen.getByRole("button", { name: "试听「Agent 完成」片段" });
    expect(assetPreview.getAttribute("aria-pressed")).toBe("false");
    expect(eventPreview.getAttribute("aria-pressed")).toBe("false");
    await user.click(assetPreview);
    expect(mocks.previewCustomAsset).toHaveBeenCalledWith("done");
    const stop = screen.getByRole("button", { name: "停止试听：完成.mp3" });
    expect(stop.getAttribute("aria-pressed")).toBe("true");
    expect(eventPreview.getAttribute("aria-pressed")).toBe("true");
    await user.click(stop);
    expect(screen.getByRole("button", { name: "试听片段：完成.mp3" }).getAttribute("aria-pressed")).toBe("false");
    expect(eventPreview.getAttribute("aria-pressed")).toBe("false");
    expect(mocks.stopPreview).toHaveBeenCalledTimes(2); // 开始新试听前收敛一次，再由按钮停止
    unmount();
    expect(mocks.stopPreview).toHaveBeenCalledTimes(2);
  });

  it("移除正在试听的资源前先停止播放器", async () => {
    const user = userEvent.setup();
    packs = [pack("pack-a", "工作通知", [asset("previewing", "试听中.mp3")])];
    seedSettings("pack-a");
    mocks.previewCustomAsset.mockReturnValue(new Promise(() => undefined));
    await renderLoaded();

    await user.click(screen.getByRole("button", { name: "试听片段：试听中.mp3" }));
    await user.click(screen.getByRole("button", { name: "移除片段：试听中.mp3" }));

    expect(mocks.stopPreview).toHaveBeenCalledTimes(2);
    expect(mocks.stopPreview.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.voiceAssetRemove.mock.invocationCallOrder[0],
    );
    expect(mocks.voiceAssetRemove).toHaveBeenCalledWith("pack-a", "previewing");
  });

  it("只有确认后才删除；删除失败时保留语音包并显示错误", async () => {
    const user = userEvent.setup();
    packs = [pack("pack-a", "工作通知")];
    seedSettings("pack-a");
    mocks.voicePackDelete.mockRejectedValue(new Error("disk_full"));
    await renderLoaded();

    await user.click(screen.getByRole("button", { name: "删除语音包：工作通知" }));
    expect(mocks.voicePackDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "确认删除语音包：工作通知" }));

    expect(await screen.findByText("删除语音包失败，语音包仍保留。")).toBeTruthy();
    expect(screen.getByText("工作通知")).toBeTruthy();
    expect(mocks.voicePackDelete).toHaveBeenCalledWith("pack-a");
  });

  it("创建或重命名失败时保留用户输入与原语音包", async () => {
    const user = userEvent.setup();
    packs = [pack("pack-a", "原名称")];
    mocks.voicePackCreate.mockRejectedValue(new Error("package_limit"));
    mocks.voicePackRename.mockRejectedValue(new Error("storage_error"));
    await renderLoaded();

    const createName = screen.getByRole("textbox", { name: "新语音包名称" });
    await user.type(createName, "新包");
    await user.click(screen.getByRole("button", { name: "新建语音包" }));
    expect(await screen.findByText("创建语音包失败，名称已保留。")).toBeTruthy();
    expect((createName as HTMLInputElement).value).toBe("新包");

    await user.click(screen.getByRole("button", { name: "重命名语音包：原名称" }));
    const renameName = screen.getByRole("textbox", { name: "语音包新名称" });
    await user.clear(renameName);
    await user.type(renameName, "修改后的名称");
    await user.click(screen.getByRole("button", { name: "保存语音包名称" }));
    expect(await screen.findByText("重命名失败，输入内容已保留。")).toBeTruthy();
    expect((renameName as HTMLInputElement).value).toBe("修改后的名称");
    expect(screen.getByText("原名称")).toBeTruthy();
  });

  it("含斜杠的语音包名称完整显示", async () => {
    packs = [pack("pack-a", "工作/日常"), pack("pack-b", "工作\\个人")];
    await renderLoaded();
    expect(screen.getByText("工作/日常")).toBeTruthy();
    expect(screen.getByText("工作\\个人")).toBeTruthy();
    expect(screen.queryByText("日常")).toBeNull();
  });

  it("同音频快速重启时旧请求不能清理新试听状态", async () => {
    const user = userEvent.setup();
    packs = [pack("pack-a", "工作通知", [asset("done", "完成.mp3")])];
    seedSettings("pack-a");
    let resolveFirst: ((v: unknown) => void) | undefined;
    let call = 0;
    mocks.previewCustomAsset.mockImplementation(() => {
      call += 1;
      if (call === 1) return new Promise((r) => { resolveFirst = r as (v: unknown) => void; });
      return new Promise(() => undefined);
    });
    await renderLoaded();
    const btn = screen.getByRole("button", { name: "试听片段：完成.mp3" });
    await user.click(btn);
    expect(screen.getByRole("button", { name: "停止试听：完成.mp3" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "停止试听：完成.mp3" }));
    expect(screen.getByRole("button", { name: "试听片段：完成.mp3" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "试听片段：完成.mp3" }));
    expect(screen.getByRole("button", { name: "停止试听：完成.mp3" })).toBeTruthy();
    resolveFirst?.({ ok: true, code: "ok" });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole("button", { name: "停止试听：完成.mp3" })).toBeTruthy();
  });

  it("跨音频切换时旧请求不能覆盖新试听状态", async () => {
    const user = userEvent.setup();
    packs = [pack("pack-a", "工作通知", [asset("a1", "A.mp3"), asset("b1", "B.mp3")])];
    seedSettings("pack-a");
    let resolveA: ((v: unknown) => void) | undefined;
    let call = 0;
    mocks.previewCustomAsset.mockImplementation(() => {
      call += 1;
      if (call === 1) return new Promise((r) => { resolveA = r as (v: unknown) => void; });
      return new Promise(() => undefined);
    });
    await renderLoaded();
    await user.click(screen.getByRole("button", { name: "试听片段：A.mp3" }));
    await user.click(screen.getByRole("button", { name: "试听片段：B.mp3" }));
    expect(screen.getByRole("button", { name: "停止试听：B.mp3" })).toBeTruthy();
    resolveA?.({ ok: true, code: "ok" });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole("button", { name: "停止试听：B.mp3" })).toBeTruthy();
  });

  it("试听错误按类型展示可执行反馈", async () => {
    const user = userEvent.setup();
    packs = [pack("pack-a", "工作通知", [asset("done", "完成.mp3")])];
    seedSettings("pack-a");
    mocks.previewCustomAsset.mockResolvedValue({ ok: false, code: "muted" });
    await renderLoaded();
    await user.click(screen.getByRole("button", { name: "试听片段：完成.mp3" }));
    expect(await screen.findByText("已开启全部静音，试听被跳过。")).toBeTruthy();
  });

  it("删除活动语音包后从数据库真值同步而不是二次写入", async () => {
    const user = userEvent.setup();
    packs = [pack("pack-a", "工作通知")];
    seedSettings("pack-a", true);
    const loadMock = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState({ load: loadMock as never });
    mocks.voicePackDelete.mockImplementation(async () => {
      packs = [];
    });
    await renderLoaded();
    await user.click(screen.getByRole("button", { name: "删除语音包：工作通知" }));
    await user.click(screen.getByRole("button", { name: "确认删除语音包：工作通知" }));
    await waitFor(() => expect(loadMock).toHaveBeenCalled());
    expect(screen.queryByText("设置保存失败。")).toBeNull();
  });
});
