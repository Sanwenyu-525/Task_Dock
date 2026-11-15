/**
 * @vitest-environment jsdom
 */
//! 手机与同步：设备在线状态只由 `last_seen_at` + 固定窗口推导，
//! 不引入可配置的连接时长；最近 2 分钟内有请求显示「在线」。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    mobileFileDelete: vi.fn(async () => true),
    mobileFileImportShelf: vi.fn(),
    mobileFileList: vi.fn(async () => []),
    mobileFileOffer: vi.fn(async () => []),
    mobileFileOpenInbox: vi.fn(async () => undefined),
    mobileFileReveal: vi.fn(async () => undefined),
    mobileFileThumbnail: vi.fn(async () => null),
    mobileSyncRevokeDevice: vi.fn(async () => true),
    mobileSyncStatus: vi.fn(),
    shelfGroups: vi.fn(async () => []),
  };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

// 查看暂存项复用既有定位通道；测试里替换 openFullApp，直接执行 after 定位回调，
// 避免 jsdom 下走到真实窗口停靠/模式切换逻辑。
vi.mock("../capsule/actions", () => ({
  openFullApp: vi.fn((_tab: string, after?: () => void) => after?.()),
}));

import MobileSyncSection from "./MobileSyncSection";
import {
  mobileFileImportShelf,
  mobileFileList,
  mobileFileThumbnail,
  mobileSyncStatus,
  shelfGroups,
  type MobileDevice,
  type MobileFile,
  type MobileSyncStatus,
} from "../../lib/bridge";
import { useSettingsStore } from "../../store/useSettingsStore";
import { useGlobalSearchStore } from "../../store/useGlobalSearchStore";

const statusMock = vi.mocked(mobileSyncStatus);
const filesMock = vi.mocked(mobileFileList);
const groupsMock = vi.mocked(shelfGroups);
const thumbMock = vi.mocked(mobileFileThumbnail);
const importMock = vi.mocked(mobileFileImportShelf);

afterEach(() => {
  cleanup();
});

function file(overrides: Partial<MobileFile> = {}): MobileFile {
  return {
    id: "mf-1",
    direction: "to_desktop",
    name: "照片.jpg",
    size: 204_800,
    sha256: "abc",
    status: "ready",
    chunk_size: 65_536,
    chunks: 4,
    received_chunks: 4,
    created_at: "2026-11-15T10:00:00Z",
    updated_at: "2026-11-15T10:01:00Z",
    completed_at: "2026-11-15T10:01:00Z",
    shelf_item_id: null,
    shelf_imported_at: null,
    shelf_group_id: null,
    ...overrides,
  };
}

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
    groupsMock.mockReset();
    groupsMock.mockResolvedValue([]);
    thumbMock.mockReset();
    thumbMock.mockResolvedValue(null);
    importMock.mockReset();
    useGlobalSearchStore.setState({ pendingLocate: null });
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

describe("MobileSyncSection 暂存架导入与来源标记", () => {
  it("已导入记录显示暂存架徽标，查看按钮写入定位意图", async () => {
    statusMock.mockResolvedValue(
      status({ devices: [device({ id: "device-1", name: "Pixel 9" })] }),
    );
    filesMock.mockResolvedValue([
      file({ device_id: "device-1", shelf_item_id: "mf-mf-1", shelf_group_id: null }),
    ]);

    render(<MobileSyncSection />);

    expect(await screen.findByText("已加入暂存架：默认分组")).toBeTruthy();
    const viewBtn = screen.getByRole("button", { name: /查看暂存项/ });
    await userEvent.click(viewBtn);
    expect(useGlobalSearchStore.getState().pendingLocate?.id).toBe("mf-mf-1");
  });

  it("待导入图片懒加载缩略图，默认分组导入后局部更新为已导入", async () => {
    statusMock.mockResolvedValue(status());
    thumbMock.mockResolvedValue("data:image/png;base64,xxx");
    importMock.mockResolvedValue(file({ shelf_item_id: "mf-mf-1", shelf_group_id: null }));
    filesMock.mockResolvedValue([file({ name: "shot.png" })]);

    const { container } = render(<MobileSyncSection />);

    // 装饰性缩略图 alt 为空，不参与 role="img" 匹配；按既有缩略图类名断言。
    await waitFor(() => expect(container.querySelector(".mobile-file-thumb")).toBeTruthy());
    const addBtn = screen.getByRole("button", { name: /加入暂存架/ });
    await userEvent.click(addBtn);
    const defaultItem = await screen.findByRole("menuitem", { name: "默认分组" });
    await userEvent.click(defaultItem);

    await waitFor(() => expect(importMock).toHaveBeenCalledWith("mf-1", null));
    await screen.findByText("已加入暂存架：默认分组");
  });

  it("导入失败显示失败徽标与重试入口", async () => {
    statusMock.mockResolvedValue(status());
    importMock.mockRejectedValue(new Error("配额不足"));
    filesMock.mockResolvedValue([file()]);

    render(<MobileSyncSection />);

    const addBtn = await screen.findByRole("button", { name: /加入暂存架/ });
    await userEvent.click(addBtn);
    const defaultItem = await screen.findByRole("menuitem", { name: "默认分组" });
    await userEvent.click(defaultItem);

    await screen.findByText("加入暂存架失败");
    expect(screen.getByRole("button", { name: /重试/ })).toBeTruthy();
  });

  it("删除确认文案区分传输副本，不与暂存条目删除混用", async () => {
    statusMock.mockResolvedValue(status());
    filesMock.mockResolvedValue([file()]);

    render(<MobileSyncSection />);

    const delBtn = await screen.findByRole("button", { name: /删除传输副本/ });
    await userEvent.click(delBtn);

    expect(await screen.findByText(/删除传输副本「/)).toBeTruthy();
    expect(screen.getByText(/不会改动暂存架/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除传输副本" })).toBeTruthy();
  });
});
