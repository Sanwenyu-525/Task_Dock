/**
 * @vitest-environment jsdom
 */
//! Android 屏幕与控制：设备空态、双模式创建、旧设备响应丢弃、失败提示与轮询清理。
//!
//! scrcpy 真机行为不在 jsdom 覆盖范围：这里只验证 UI 与 IPC 契约。

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/bridge")>();
  return {
    ...actual,
    shelfAddPaths: vi.fn(async () => ({ added: [], failed: [] })),
    vdDevices: vi.fn(),
    vdDiagnostics: vi.fn(async () => ({
      owned_sessions: 0,
      stale_displays: [],
      note: "",
    })),
    vdFocus: vi.fn(async () => ({ found: true, focused: true })),
    vdListApps: vi.fn(),
    vdProbe: vi.fn(),
    vdReconnect: vi.fn(async () => true),
    vdScreenshot: vi.fn(),
    vdScreenshotExport: vi.fn(async () => true),
    vdSessions: vi.fn(async () => []),
    vdStart: vi.fn(),
    vdStop: vi.fn(async () => true),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(async () => null),
}));

import VirtualDisplaySection from "./VirtualDisplaySection";
import {
  vdDevices,
  vdListApps,
  vdProbe,
  vdSessions,
  vdStart,
  type VdAppList,
  type VdDevice,
  type VdProbe,
  type VdSession,
} from "../../lib/bridge";

const devicesMock = vi.mocked(vdDevices);
const appsMock = vi.mocked(vdListApps);
const probeMock = vi.mocked(vdProbe);
const sessionsMock = vi.mocked(vdSessions);
const startMock = vi.mocked(vdStart);

const SERIAL_A = "192.168.1.5:5555";
const SERIAL_B = "192.168.1.6:5555";

function device(overrides: Partial<VdDevice> = {}): VdDevice {
  return {
    serial: SERIAL_A,
    uid: "UID-A",
    state: "device",
    model: "V2323A",
    product: "PD2323",
    device: "PD2323",
    transport_id: "1",
    connection: "wifi",
    transports: [SERIAL_A],
    ...overrides,
  };
}

function probe(overrides: Partial<VdProbe> = {}): VdProbe {
  return {
    adb_path: "C:\\platform-tools\\adb.exe",
    adb_version: "Android Debug Bridge version 1.0.41",
    scrcpy_path: "C:\\scrcpy\\scrcpy.exe",
    scrcpy_version: "scrcpy 5.0.1",
    supports_new_display: true,
    supports_ime_local: true,
    devices: [],
    error: null,
    ...overrides,
  };
}

function appList(serial: string, uid: string, apps: VdAppList["apps"]): VdAppList {
  return {
    device_uid: uid,
    serial,
    apps,
    launchable_known: true,
    include_all: false,
    error: null,
  };
}

function session(overrides: Partial<VdSession> = {}): VdSession {
  return {
    id: "session-1",
    pid: 1234,
    serial: SERIAL_A,
    device_uid: "UID-A",
    device_model: "V2323A",
    mode: "virtual",
    package: "com.android.settings",
    app_label: "设置",
    status: "starting",
    stage: "process",
    title: "Task Dock · 虚拟屏 · com.android.settings",
    started_at: new Date().toISOString(),
    ready_at: null,
    ended_at: null,
    alive: true,
    error: null,
    warning: null,
    size: "1080x1920/384",
    ...overrides,
  };
}

const SETTINGS_APP = {
  package: "com.android.settings",
  label: "设置",
  system: true,
  launchable: true,
  reason: null,
};

beforeEach(() => {
  probeMock.mockResolvedValue(probe());
  devicesMock.mockResolvedValue({ devices: [device()], adb_ok: true, error: null });
  appsMock.mockResolvedValue(appList(SERIAL_A, "UID-A", [SETTINGS_APP]));
  sessionsMock.mockResolvedValue([]);
  startMock.mockResolvedValue(session());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("VirtualDisplaySection", () => {
  it("没有设备时显示空态，创建按钮禁用", async () => {
    devicesMock.mockResolvedValue({ devices: [], adb_ok: true, error: null });
    render(<VirtualDisplaySection />);

    expect(await screen.findByText("没有可用的 ADB 设备")).toBeTruthy();
    expect(screen.getByText(/开启「无线调试」/)).toBeTruthy();
    const create = screen.getByRole("button", { name: /创建虚拟屏/ });
    expect((create as HTMLButtonElement).disabled).toBe(true);
  });

  it("未授权设备显示未授权状态且不能创建", async () => {
    devicesMock.mockResolvedValue({
      devices: [device({ state: "unauthorized" })],
      adb_ok: true,
      error: null,
    });
    render(<VirtualDisplaySection />);

    expect((await screen.findAllByText("未授权")).length).toBeGreaterThan(0);
    const create = screen.getByRole("button", { name: /创建虚拟屏/ });
    expect((create as HTMLButtonElement).disabled).toBe(true);
  });

  it("选择应用后以虚拟屏模式创建，并展示启动中会话", async () => {
    const user = userEvent.setup();
    sessionsMock.mockResolvedValueOnce([]).mockResolvedValue([session()]);
    render(<VirtualDisplaySection />);

    await screen.findByText("V2323A");
    await waitFor(() => {
      expect(appsMock).toHaveBeenCalledWith(SERIAL_A, false);
    });

    const combo = screen.getByRole("combobox", { name: "应用" });
    await user.click(combo);
    await user.type(combo, "settings");
    await user.click(await screen.findByRole("option", { name: /设置/ }));
    await user.click(screen.getByRole("button", { name: /创建虚拟屏/ }));

    expect(startMock).toHaveBeenCalledWith({
      serial: SERIAL_A,
      mode: "virtual",
      packageName: "com.android.settings",
      size: "1080x1920/384",
      clipboardSync: false,
      allowMulti: false,
    });
    expect(await screen.findByText("启动中")).toBeTruthy();
    expect(screen.getByText("设置")).toBeTruthy();
  });

  it("切换到屏幕镜像后不再显示应用选择，并以 mirror 模式创建", async () => {
    const user = userEvent.setup();
    startMock.mockResolvedValue(
      session({ mode: "mirror", package: null, app_label: null, title: "Task Dock · 手机屏幕 · V2323A" }),
    );
    render(<VirtualDisplaySection />);

    await screen.findByText("V2323A");
    await user.click(screen.getByRole("button", { name: /屏幕镜像/ }));

    expect(screen.queryByRole("combobox", { name: "应用" })).toBeNull();
    expect(screen.getByText(/电脑与手机共享同一画面/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /开始镜像/ }));
    expect(startMock).toHaveBeenCalledWith({
      serial: SERIAL_A,
      mode: "mirror",
      packageName: null,
      size: null,
      clipboardSync: false,
      allowMulti: false,
    });
  });

  it("设备切换后丢弃上一台设备的迟到应用响应", async () => {
    const user = userEvent.setup();
    let resolveA: (value: VdAppList) => void = () => {};
    const pendingA = new Promise<VdAppList>((resolve) => {
      resolveA = resolve;
    });
    const deviceB = device({
      serial: SERIAL_B,
      uid: "UID-B",
      model: "Pixel 9",
      transports: [SERIAL_B],
    });
    devicesMock.mockResolvedValue({
      devices: [device(), deviceB],
      adb_ok: true,
      error: null,
    });
    appsMock.mockImplementation((serial) => {
      if (serial === SERIAL_A) return pendingA;
      return Promise.resolve(
        appList(SERIAL_B, "UID-B", [
          {
            package: "com.android.chrome",
            label: "Chrome",
            system: false,
            launchable: true,
            reason: null,
          },
        ]),
      );
    });
    render(<VirtualDisplaySection />);

    await screen.findAllByText("V2323A");
    await user.click(screen.getByRole("combobox", { name: "连接设备" }));
    await user.click(await screen.findByRole("option", { name: /Pixel 9/ }));

    await waitFor(() => {
      expect(appsMock).toHaveBeenCalledWith(SERIAL_B, false);
    });
    await waitFor(() => {
      const combo = screen.getByRole("combobox", { name: "应用" }) as HTMLInputElement;
      expect(combo.disabled).toBe(false);
    });
    await act(async () => {
      resolveA(appList(SERIAL_A, "UID-A", [SETTINGS_APP]));
    });

    // 设备 B 的应用仍在，设备 A 的迟到响应没有覆盖它。
    const combo = screen.getByRole("combobox", { name: "应用" });
    await user.click(combo);
    expect(await screen.findByRole("option", { name: /Chrome/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /设置/ })).toBeNull();
  });

  it("创建失败时展示可读错误，不留下假会话", async () => {
    const user = userEvent.setup();
    startMock.mockRejectedValue(new Error("该应用没有可启动的入口，无法在虚拟屏中打开"));
    render(<VirtualDisplaySection />);

    await screen.findByText("V2323A");
    const combo = screen.getByRole("combobox", { name: "应用" });
    await user.click(combo);
    await user.type(combo, "settings");
    await user.click(await screen.findByRole("option", { name: /设置/ }));
    await user.click(screen.getByRole("button", { name: /创建虚拟屏/ }));

    expect(await screen.findByText(/该应用没有可启动的入口/)).toBeTruthy();
    expect(screen.queryByText("运行中")).toBeNull();
  });

  it("卸载后停止设备与会话轮询", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<VirtualDisplaySection />);
    await act(async () => {
      await Promise.resolve();
    });
    const deviceCalls = devicesMock.mock.calls.length;
    const sessionCalls = sessionsMock.mock.calls.length;
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(devicesMock.mock.calls.length).toBe(deviceCalls);
    expect(sessionsMock.mock.calls.length).toBe(sessionCalls);
  });
});
