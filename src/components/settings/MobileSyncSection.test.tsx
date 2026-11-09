/**
 * @vitest-environment jsdom
 */
//! 手机与同步：设备在线状态只由 `last_seen_at` + 固定窗口推导，
//! 不引入可配置的连接时长；最近 2 分钟内有请求显示「在线」。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    mobileFileDelete: vi.fn(async () => true),
    mobileFileList: vi.fn(async () => []),
    mobileFileOffer: vi.fn(async () => []),
    mobileFileOpenInbox: vi.fn(async () => undefined),
    mobileFileReveal: vi.fn(async () => undefined),
    mobileSyncRevokeDevice: vi.fn(async () => true),
    mobileSyncStatus: vi.fn(),
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import MobileSyncSection from "./MobileSyncSection";
import {
  mobileFileList,
  mobileSyncStatus,
  type MobileDevice,
  type MobileSyncStatus,
} from "../../lib/bridge";
import { useSettingsStore } from "../../store/useSettingsStore";

const statusMock = vi.mocked(mobileSyncStatus);
const filesMock = vi.mocked(mobileFileList);

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

function device(overrides: Partial<MobileDevice> = {}): MobileDevice {
  return {
    id: "device-1",
    name: "Pixel 9",
    platform: "android",
    created_at: "2026-11-09T10:00:00Z",
    last_seen_at: null,
    last_ip: "192.168.1.5",
    revoked_at: null,
    ...overrides,
  };
}

describe("MobileSyncSection 设备在线状态", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      settings: {
        mode: "full",
        theme: "light",
        visual_preset: "dream-gradient",
        mobile_sync_enabled: true,
        mobile_sync_port: 47822,
      } as never,
    });
    statusMock.mockReset();
    filesMock.mockReset();
    filesMock.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it("2 分钟内活跃显示在线，超窗设备回落到最近连接时间", async () => {
    const now = Date.now();
    statusMock.mockResolvedValue(
      status({
        devices: [
          device({
            id: "online",
            name: "Pixel 9",
            last_seen_at: new Date(now - 30_000).toISOString(),
          }),
          device({
            id: "offline",
            name: "Old Phone",
            last_seen_at: new Date(now - 10 * 60_000).toISOString(),
          }),
        ],
      }),
    );

    render(<MobileSyncSection />);

    const onlineName = await screen.findByText("Pixel 9");
    const onlineRow = onlineName.closest(".mobile-sync-device");
    expect(onlineRow).toBeTruthy();
    expect(within(onlineRow as HTMLElement).getByText("在线")).toBeTruthy();

    const offlineRow = screen.getByText("Old Phone").closest(".mobile-sync-device");
    expect(offlineRow).toBeTruthy();
    expect(within(offlineRow as HTMLElement).queryByText("在线")).toBeNull();
    expect(within(offlineRow as HTMLElement).getByText(/最近连接/)).toBeTruthy();
  });

  it("从未连接的设备不显示在线", async () => {
    statusMock.mockResolvedValue(
      status({ devices: [device({ name: "New Phone" })] }),
    );

    render(<MobileSyncSection />);

    const row = (await screen.findByText("New Phone")).closest(".mobile-sync-device");
    expect(row).toBeTruthy();
    expect(within(row as HTMLElement).queryByText("在线")).toBeNull();
    expect(within(row as HTMLElement).getByText(/尚未连接/)).toBeTruthy();
  });
});
