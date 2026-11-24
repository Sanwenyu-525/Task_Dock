/**
 * @vitest-environment jsdom
 *
 * R14.2 P1：媒体元素生命周期。
 *
 * 重点不是「DOM 里没有播放器」，而是卸载/切版本时媒体元素真的被 `pause()`、
 * `src` 被清空并 `load()`，且 token 恰好释放一次。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const bridgeMocks = vi.hoisted(() => ({
  fsPreviewMediaUrl: vi.fn(),
  fsReleasePreviewUrl: vi.fn(),
}));

vi.mock("../../../lib/bridge", () => bridgeMocks);
vi.mock("../../../hooks/useLocale", () => ({
  useLocale: () => ({
    locale: "zh-CN",
    preference: "zh-CN",
    setPreference: vi.fn(),
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
  }),
}));

import FileAudioPreview from "./FileAudioPreview";
import FileVideoPreview from "./FileVideoPreview";

const mediaMock = vi.mocked(bridgeMocks.fsPreviewMediaUrl);
const releaseMock = vi.mocked(bridgeMocks.fsReleasePreviewUrl);

let pauseSpy: ReturnType<typeof vi.spyOn>;
let loadSpy: ReturnType<typeof vi.spyOn>;
let playSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mediaMock.mockReset();
  releaseMock.mockReset().mockResolvedValue(undefined);
  pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  loadSpy = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("音频", () => {
  it("卸载时 pause + 清空 src + load，token 只释放一次", async () => {
    mediaMock.mockResolvedValue("media://audio-1");
    const { unmount } = render(<FileAudioPreview path="D:\\a\\a.mp3" name="a.mp3" size={10} />);
    const el = await waitFor(() => {
      const node = document.querySelector("audio");
      expect(node).toBeTruthy();
      return node as HTMLAudioElement;
    });

    unmount();

    await waitFor(() => expect(pauseSpy).toHaveBeenCalled());
    await waitFor(() => expect(el.hasAttribute("src")).toBe(false));
    expect(loadSpy).toHaveBeenCalled();
    await waitFor(() => expect(releaseMock).toHaveBeenCalledWith("media://audio-1"));
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("播放失败：停止元素、清理资源并显示错误", async () => {
    mediaMock.mockResolvedValue("media://audio-bad");
    render(<FileAudioPreview path="D:\\a\\bad.mp3" name="bad.mp3" size={10} />);
    const el = await waitFor(() => {
      const node = document.querySelector("audio");
      expect(node).toBeTruthy();
      return node as HTMLAudioElement;
    });

    playSpy.mockRejectedValueOnce(new Error("decode failed"));
    fireEvent.click(screen.getByLabelText("fw.preview.audio.play"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    expect(pauseSpy).toHaveBeenCalled();
    expect(loadSpy).toHaveBeenCalled();
    expect(el.hasAttribute("src")).toBe(false);
  });

  it("版本切换：旧音频先停止并释放旧 token，新版本重新取 URL", async () => {
    mediaMock.mockResolvedValueOnce("media://audio-v1").mockResolvedValueOnce("media://audio-v2");
    const { rerender } = render(<FileAudioPreview path="D:\\a\\a.mp3" name="a.mp3" size={10} revisionKey="v1" />);
    const first = await waitFor(() => {
      const node = document.querySelector("audio");
      expect(node?.getAttribute("src")).toBe("media://audio-v1");
      return node as HTMLAudioElement;
    });

    rerender(<FileAudioPreview path="D:\\a\\a.mp3" name="a.mp3" size={20} revisionKey="v2" />);
    await waitFor(() => expect(document.querySelector("audio")?.getAttribute("src")).toBe("media://audio-v2"));

    expect(pauseSpy).toHaveBeenCalled();
    expect(first.hasAttribute("src")).toBe(false);
    await waitFor(() => expect(releaseMock).toHaveBeenCalledWith("media://audio-v1"));
  });

  it("连续 50 次版本切换：每个 token 恰好释放一次，不重复释放", async () => {
    let seq = 0;
    mediaMock.mockImplementation(async () => {
      seq += 1;
      return `media://audio-${seq}`;
    });
    const { rerender } = render(<FileAudioPreview path="D:\\a\\a.mp3" name="a.mp3" size={10} revisionKey="v0" />);
    await waitFor(() => expect(mediaMock).toHaveBeenCalledTimes(1));

    for (let i = 1; i <= 50; i += 1) {
      rerender(<FileAudioPreview path="D:\\a\\a.mp3" name="a.mp3" size={10 + i} revisionKey={`v${i}`} />);
      await waitFor(() => expect(mediaMock).toHaveBeenCalledTimes(i + 1));
    }

    cleanup();
    await waitFor(() => expect(releaseMock).toHaveBeenCalledTimes(51));
    const released = releaseMock.mock.calls.map(([url]) => url as string);
    expect(new Set(released).size).toBe(51);
    expect(pauseSpy.mock.calls.length).toBeGreaterThanOrEqual(51);
  });
});

describe("视频", () => {
  it("卸载时 pause + 清空 src + load，token 只释放一次", async () => {
    mediaMock.mockResolvedValue("media://video-1");
    const { unmount } = render(<FileVideoPreview path="D:\\a\\a.mp4" name="a.mp4" size={10} />);
    const el = await waitFor(() => {
      const node = document.querySelector("video");
      expect(node).toBeTruthy();
      return node as HTMLVideoElement;
    });

    unmount();

    await waitFor(() => expect(pauseSpy).toHaveBeenCalled());
    await waitFor(() => expect(el.hasAttribute("src")).toBe(false));
    expect(loadSpy).toHaveBeenCalled();
    await waitFor(() => expect(releaseMock).toHaveBeenCalledWith("media://video-1"));
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("解码失败后停止视频并释放资源", async () => {
    mediaMock.mockResolvedValue("media://video-bad");
    render(<FileVideoPreview path="D:\\a\\bad.mp4" name="bad.mp4" size={10} />);
    const el = await waitFor(() => {
      const node = document.querySelector("video");
      expect(node).toBeTruthy();
      return node as HTMLVideoElement;
    });

    fireEvent.error(el);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(pauseSpy).toHaveBeenCalled();
    expect(loadSpy).toHaveBeenCalled();
    expect(el.hasAttribute("src")).toBe(false);
  });
});
