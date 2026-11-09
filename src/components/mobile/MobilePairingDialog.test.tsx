/**
 * @vitest-environment jsdom
 */
//! 手机配对弹层：全局快捷入口打开后直接生成二维码；服务关闭时给出一键开启；
//! 关闭弹层必须取消会话（120s TTL 之外的第二道保险）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    applyMode: vi.fn(async () => true),
    mobileSyncStatus: vi.fn(),
    mobileSyncStartPairing: vi.fn(),
    mobileSyncCancelPairing: vi.fn(async () => undefined),
  };
});

import MobilePairingDialog from "./MobilePairingDialog";
import {
  closeMobilePairing,
  isMobilePairingOpen,
  openMobilePairing,
} from "../../lib/mobilePairing";
import { useSettingsStore } from "../../store/useSettingsStore";
import {
  mobileSyncCancelPairing,
  mobileSyncStartPairing,
  mobileSyncStatus,
  type MobileSyncStatus,
} from "../../lib/bridge";

const statusMock = vi.mocked(mobileSyncStatus);
const startMock = vi.mocked(mobileSyncStartPairing);
const cancelMock = vi.mocked(mobileSyncCancelPairing);

function status(overrides: Partial<MobileSyncStatus> = {}): MobileSyncStatus {
  return {
    enabled: true,
    running: true,
    port: 47822,
    lan_ip: "192.168.1.20",
    base_url: "http://192.168.1.20:47822",
    server_name: "STUDIO-PC",
    instance_id: "instance-1",
    fingerprint: "1A2B3C4D",
    error: null,
    pairing: null,
    paired_device: null,
    devices: [],
    ...overrides,
  };
}

function setSettings(enabled: boolean) {
  useSettingsStore.setState({
    settings: {
      mode: "full",
      theme: "light",
      visual_preset: "dream-gradient",
      mobile_sync_enabled: enabled,
      mobile_sync_port: 47822,
    } as never,
  });
}

function offer(code: string) {
  return {
    code,
    expires_in_secs: 120,
    lan_ip: "192.168.1.20",
    port: 47822,
    server_name: "STUDIO-PC",
    instance_id: "instance-1",
    fingerprint: "1A2B3C4D",
    qr_payload: `taskdock://pair?v=1&host=192.168.1.20&port=47822&code=${code}&name=STUDIO-PC&instance=instance-1&fp=1A2B3C4D`,
  };
}

describe("MobilePairingDialog", () => {
  const update = vi.fn(async () => undefined);

  beforeEach(() => {
    update.mockClear();
    useSettingsStore.setState({ update } as never);
    statusMock.mockReset();
    startMock.mockReset();
    cancelMock.mockClear();
  });

  afterEach(() => {
    closeMobilePairing();
    cleanup();
  });

  it("服务已运行时，标题栏入口打开即生成二维码与 6 位码", async () => {
    setSettings(true);
    statusMock.mockResolvedValue(status());
    startMock.mockResolvedValue({
      code: "482913",
      expires_in_secs: 120,
      lan_ip: "192.168.1.20",
      port: 47822,
      server_name: "STUDIO-PC",
      instance_id: "instance-1",
      fingerprint: "1A2B3C4D",
      qr_payload: "taskdock://pair?v=1&code=482913",
    });

    render(<MobilePairingDialog />);
    act(() => openMobilePairing());

    expect(await screen.findByText("482913")).toBeTruthy();
    expect(screen.getByRole("img", { name: "配对新设备" })).toBeTruthy();
    expect(startMock).toHaveBeenCalledTimes(1);
  });

  it("重新生成原地换码：二维码路径更新，不回到加载态", async () => {
    setSettings(true);
    statusMock.mockResolvedValue(status());
    startMock.mockResolvedValueOnce(offer("111111")).mockResolvedValueOnce(offer("222222"));

    render(<MobilePairingDialog />);
    act(() => openMobilePairing());
    await screen.findByText("111111");
    const before = document.querySelector(".mobile-sync-qr svg path")?.getAttribute("d");
    expect(before).toBeTruthy();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "重新生成" }));

    expect(await screen.findByText("222222")).toBeTruthy();
    const after = document.querySelector(".mobile-sync-qr svg path")?.getAttribute("d");
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    // 原地替换：不经过 loading 文案，也不额外调用取消接口。
    expect(screen.queryByText("正在生成配对码…")).toBeNull();
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("服务关闭时在弹层内一键开启，不必先去设置页", async () => {
    setSettings(false);
    statusMock.mockResolvedValue(status({ enabled: false, running: false, lan_ip: null, base_url: null }));

    render(<MobilePairingDialog />);
    act(() => openMobilePairing());

    const enable = await screen.findByRole("button", { name: "开启并生成配对码" });
    const user = userEvent.setup();
    await user.click(enable);

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({ mobile_sync_enabled: true }),
    );
    expect(startMock).not.toHaveBeenCalled();
  });

  it("关闭弹层取消会话并释放全局打开状态", async () => {
    setSettings(true);
    statusMock.mockResolvedValue(status());
    startMock.mockResolvedValue({
      code: "482913",
      expires_in_secs: 120,
      lan_ip: "192.168.1.20",
      port: 47822,
      server_name: "STUDIO-PC",
      instance_id: "instance-1",
      fingerprint: "1A2B3C4D",
      qr_payload: "taskdock://pair?v=1&code=482913",
    });

    render(<MobilePairingDialog />);
    act(() => openMobilePairing());
    await screen.findByText("482913");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => expect(cancelMock).toHaveBeenCalled());
    expect(isMobilePairingOpen()).toBe(false);
  });
});
