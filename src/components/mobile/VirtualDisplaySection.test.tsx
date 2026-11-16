/**
 * @vitest-environment jsdom
 */
//! Android 屏幕与控制：设备/工具链、双模式、应用选择、会话操作、高级诊断与生命周期。
//!
//! scrcpy 真机行为不在 jsdom 覆盖范围：这里只验证 UI 层级、交互与 IPC 契约。

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  shelfAddPaths,
  vdDevices,
  vdDiagnostics,
  vdFocus,
  vdListApps,
  vdProbe,
  vdReconnect,
  vdScreenshot,
  vdScreenshotExport,
  vdSessions,
  vdStart,
  vdStop,
  type VdAppList,
  type VdDevice,
  type VdProbe,
  type VdSession,
} from "../../lib/bridge";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";

const devicesMock = vi.mocked(vdDevices);
const appsMock = vi.mocked(vdListApps);
const probeMock = vi.mocked(vdProbe);
const sessionsMock = vi.mocked(vdSessions);
const startMock = vi.mocked(vdStart);
const stopMock = vi.mocked(vdStop);
const focusMock = vi.mocked(vdFocus);
const shotMock = vi.mocked(vdScreenshot);
const exportMock = vi.mocked(vdScreenshotExport);
const shelfMock = vi.mocked(shelfAddPaths);
const diagMock = vi.mocked(vdDiagnostics);
const reconnectMock = vi.mocked(vdReconnect);
const saveDialogMock = vi.mocked(saveFileDialog);

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

function appList(
  serial: string,
  uid: string,
  apps: VdAppList["apps"],
  includeAll = false,
): VdAppList {
  return {
    device_uid: uid,
    serial,
    apps,
    launchable_known: true,
    include_all: includeAll,
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
    started_at: new Date(Date.now() - 65_000).toISOString(),
    ready_at: null,
    ended_at: null,
    alive: true,
    error: null,
    warning: null,
    job_assigned: true,
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

const CHROME_APP = {
  package: "com.google.android.chrome",
  label: "Chrome",
  system: false,
  launchable: true,
  reason: null,
};

const CAMERA_APP = {
  package: "com.android.camera",
  label: "相机",
  system: true,
  launchable: false,
  reason: "没有可启动的 Activity",
};

beforeEach(() => {
  probeMock.mockResolvedValue(probe());
  devicesMock.mockResolvedValue({ devices: [device()], adb_ok: true, error: null });
  appsMock.mockResolvedValue(appList(SERIAL_A, "UID-A", [SETTINGS_APP]));
  sessionsMock.mockResolvedValue([]);
  startMock.mockResolvedValue(session());
  stopMock.mockResolvedValue(true);
  diagMock.mockResolvedValue({ owned_sessions: 0, stale_displays: [], note: "" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("VirtualDisplaySection", () => {
  it("没有设备时给出引导空态，并禁用启动", async () => {
    devicesMock.mockResolvedValue({ devices: [], adb_ok: true, error: null });
    render(<VirtualDisplaySection />);

    expect(await screen.findByText("未发现 Android 调试设备")).toBeTruthy();
    expect(screen.getByText(/连接 USB 并开启 USB 调试/)).toBeTruthy();
    const start = screen.getByRole("button", { name: /开始屏幕镜像/ });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("请先连接并选择设备")).toBeTruthy();
  });

  it("未授权设备明确提示，不显示为已连接且不能启动", async () => {
    devicesMock.mockResolvedValue({
      devices: [device({ state: "unauthorized" })],
      adb_ok: true,
      error: null,
    });
    render(<VirtualDisplaySection />);

    expect(await screen.findByText("设备尚未授权")).toBeTruthy();
    expect(screen.getByText(/允许 USB 调试/)).toBeTruthy();
    expect(screen.getAllByText("未授权").length).toBeGreaterThan(0);
    const start = screen.getByRole("button", { name: /开始屏幕镜像/ });
    expect((start as HTMLButtonElement).disabled).toBe(true);
  });

  it("工具链缺失时展示缺失状态、禁用虚拟屏并给出安装建议", async () => {
    probeMock.mockResolvedValue(
      probe({ adb_path: null, adb_version: null, scrcpy_path: null, scrcpy_version: null, supports_new_display: false }),
    );
    const user = userEvent.setup();
    render(<VirtualDisplaySection />);

    await screen.findAllByText("V2323A");
    expect(screen.getAllByText("缺失").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/未找到 adb/).length).toBeGreaterThan(0);

    const virtualMode = screen.getByRole("button", { name: /独立虚拟屏幕/ });
    expect((virtualMode as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("当前 scrcpy 不支持该模式")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "展开详情" }));
    expect(screen.getByText(/TaskDock 不会自动下载或安装工具/)).toBeTruthy();
  });

  it("默认镜像不显示应用选择；切到虚拟屏才展开配置", async () => {
    const user = userEvent.setup();
    render(<VirtualDisplaySection />);
    await screen.findAllByText("V2323A");

    expect(screen.queryByText("要打开的应用")).toBeNull();
    expect(screen.getByRole("button", { name: /开始屏幕镜像/ })).toBeTruthy();
    expect((screen.getByRole("button", { name: /手机屏幕镜像/ }) as HTMLButtonElement).disabled).toBe(false);

    await user.click(screen.getByRole("button", { name: /独立虚拟屏幕/ }));
    expect(await screen.findByText("要打开的应用")).toBeTruthy();
    expect(screen.getByText("屏幕方向")).toBeTruthy();
    const create = screen.getByRole("button", { name: /创建虚拟屏幕/ });
    expect((create as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: /手机屏幕镜像/ }));
    await waitFor(() => expect(screen.queryByText("要打开的应用")).toBeNull());
    expect(screen.getByRole("button", { name: /开始屏幕镜像/ })).toBeTruthy();
  });

  it("应用搜索同时匹配名称与包名，并提供无结果状态", async () => {
    appsMock.mockResolvedValue(appList(SERIAL_A, "UID-A", [SETTINGS_APP, CHROME_APP]));
    const user = userEvent.setup();
    render(<VirtualDisplaySection />);
    await screen.findAllByText("V2323A");
    await user.click(screen.getByRole("button", { name: /独立虚拟屏幕/ }));

    const search = await screen.findByRole("textbox", { name: "搜索应用名称或包名" });
    await user.type(search, "chrom");
    expect(screen.queryByText("com.android.settings")).toBeNull();
    expect(screen.getByText("com.google.android.chrome")).toBeTruthy();

    await user.clear(search);
    await user.type(search, "com.android.settings");
    expect(screen.getByText("com.android.settings")).toBeTruthy();
    expect(screen.queryByText("com.google.android.chrome")).toBeNull();

    await user.clear(search);
    await user.type(search, "zzz");
    expect(screen.getByText("没有匹配的应用")).toBeTruthy();
  });

  it("显示无入口应用时禁用该行并说明原因", async () => {
    appsMock.mockImplementation((_serial, includeAll) =>
      Promise.resolve(
        appList(SERIAL_A, "UID-A", includeAll ? [SETTINGS_APP, CAMERA_APP] : [SETTINGS_APP], includeAll),
      ),
    );
    const user = userEvent.setup();
    render(<VirtualDisplaySection />);
    await screen.findAllByText("V2323A");
    await user.click(screen.getByRole("button", { name: /独立虚拟屏幕/ }));
    await screen.findByText("com.android.settings");

    await user.click(screen.getByRole("button", { name: "显示无启动入口的应用" }));
    await waitFor(() => expect(appsMock).toHaveBeenLastCalledWith(SERIAL_A, true));
    const camera = await screen.findByRole("button", { name: /相机/ });
    expect((camera as HTMLButtonElement).disabled).toBe(true);
    expect(within(camera).getByText("没有可启动的 Activity")).toBeTruthy();
  });

  it("手动包名校验失败时给出原因，合法后按包名创建", async () => {
    const user = userEvent.setup();
    startMock.mockResolvedValue(
      session({ package: "com.example.demo", app_label: "Demo" }),
    );
    sessionsMock.mockResolvedValueOnce([]).mockResolvedValue([
      session({ package: "com.example.demo", app_label: "Demo", status: "starting" }),
    ]);
    render(<VirtualDisplaySection />);
    await screen.findAllByText("V2323A");
    await user.click(screen.getByRole("button", { name: /独立虚拟屏幕/ }));
    await user.click(screen.getByRole("button", { name: "手动输入包名" }));

    const input = screen.getByRole("textbox", { name: "例如 com.android.settings" });
    await user.type(input, "bad-package!");
    expect(screen.getAllByText(/包名格式不正确/).length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: /创建虚拟屏幕/ }) as HTMLButtonElement).disabled).toBe(true);

    await user.clear(input);
    await user.type(input, "com.example.demo");
    expect(screen.queryAllByText(/包名格式不正确/)).toHaveLength(0);
    const create = screen.getByRole("button", { name: /创建虚拟屏幕/ });
    expect((create as HTMLButtonElement).disabled).toBe(false);
    await user.click(create);

    expect(startMock).toHaveBeenCalledWith({
      serial: SERIAL_A,
      mode: "virtual",
      packageName: "com.example.demo",
      size: "1080x1920/384",
      clipboardSync: false,
      allowMulti: false,
    });
    expect(await screen.findByText("V2323A · Demo")).toBeTruthy();
  });

  it("选择应用后创建虚拟屏，会话标题不使用包名", async () => {
    const user = userEvent.setup();
    sessionsMock.mockResolvedValueOnce([]).mockResolvedValue([session()]);
    render(<VirtualDisplaySection />);
    await screen.findAllByText("V2323A");
    await user.click(screen.getByRole("button", { name: /独立虚拟屏幕/ }));

    const app = screen.getByText("com.android.settings").closest("button");
    expect(app).not.toBeNull();
    await user.click(app!);
    const create = screen.getByRole("button", { name: /创建虚拟屏幕/ });
    expect((create as HTMLButtonElement).disabled).toBe(false);
    await user.click(create);

    expect(startMock).toHaveBeenCalledWith({
      serial: SERIAL_A,
      mode: "virtual",
      packageName: "com.android.settings",
      size: "1080x1920/384",
      clipboardSync: false,
      allowMulti: false,
    });
    expect(await screen.findByText("V2323A · 设置")).toBeTruthy();
    expect(screen.queryByText("V2323A · com.android.settings")).toBeNull();
    expect(screen.getByText("启动中")).toBeTruthy();
    expect(screen.getByText("进程已启动")).toBeTruthy();
  });

  it("镜像模式按 mirror 创建且不带应用与分辨率", async () => {
    const user = userEvent.setup();
    sessionsMock.mockResolvedValueOnce([]).mockResolvedValue([
      session({ mode: "mirror", package: null, app_label: null, status: "running", stage: "ready" }),
    ]);
    render(<VirtualDisplaySection />);
    await screen.findAllByText("V2323A");

    await user.click(screen.getByRole("button", { name: /开始屏幕镜像/ }));
    expect(startMock).toHaveBeenCalledWith({
      serial: SERIAL_A,
      mode: "mirror",
      packageName: null,
      size: null,
      clipboardSync: false,
      allowMulti: false,
    });
    expect(await screen.findByText("V2323A · 手机屏幕")).toBeTruthy();
  });

  it("运行中的会话支持定位、截图预览并保存到暂存架", async () => {
    sessionsMock.mockResolvedValue([
      session({ status: "running", stage: "ready", job_assigned: true }),
    ]);
    shotMock.mockResolvedValue({
      path: "C:\\tmp\\shot.png",
      width: 1080,
      height: 1920,
      captured_at: new Date().toISOString(),
      warning: "窗口可能被遮挡",
    });
    const user = userEvent.setup();
    render(<VirtualDisplaySection />);

    expect(await screen.findByText("V2323A · 设置")).toBeTruthy();
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(screen.getByText("已就绪")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "定位窗口" }));
    expect(focusMock).toHaveBeenCalledWith("session-1");

    await user.click(screen.getByRole("button", { name: "截屏" }));
    expect(shotMock).toHaveBeenCalledWith("session-1");
    expect(await screen.findByText("窗口截图")).toBeTruthy();
    expect(screen.getByText("截图可能不完整")).toBeTruthy();
    expect(screen.getByText("窗口可能被遮挡")).toBeTruthy();

    // jsdom 不会真正解码图片；显式触发 load，验证「可显示后才允许入暂存架」。
    fireEvent.load(screen.getByRole("img"));
    await user.click(screen.getByRole("button", { name: "保存到暂存架" }));
    expect(shelfMock).toHaveBeenCalledWith(["C:\\tmp\\shot.png"], "managed", "manual");
    await waitFor(() => expect(screen.queryByText("窗口截图")).toBeNull());
  });

  it("截图预览可另存为，导出仍绑定原会话", async () => {
    sessionsMock.mockResolvedValue([
      session({ status: "running", stage: "ready" }),
    ]);
    shotMock.mockResolvedValue({
      path: "C:\\tmp\\shot.png",
      width: 1080,
      height: 1920,
      captured_at: new Date().toISOString(),
      warning: null,
    });
    saveDialogMock.mockResolvedValueOnce("D:\\tmp\\out.png");
    const user = userEvent.setup();
    render(<VirtualDisplaySection />);

    await screen.findByText("V2323A · 设置");
    await user.click(screen.getByRole("button", { name: "截屏" }));
    await screen.findByText("窗口截图");
    fireEvent.load(screen.getByRole("img"));
    await user.click(screen.getByRole("button", { name: /另存为/ }));

    expect(exportMock).toHaveBeenCalledWith("session-1", "D:\\tmp\\out.png");
    await waitFor(() => expect(screen.queryByText("窗口截图")).toBeNull());
  });

  it("关闭会话调用 vd_stop，并立即显示关闭中状态", async () => {
    sessionsMock.mockResolvedValue([
      session({ status: "running", stage: "ready" }),
    ]);
    stopMock.mockReturnValueOnce(new Promise<boolean>(() => {}));
    const user = userEvent.setup();
    render(<VirtualDisplaySection />);

    await screen.findByText("V2323A · 设置");
    await user.click(screen.getByRole("button", { name: "关闭" }));

    expect(stopMock).toHaveBeenCalledWith("session-1");
    expect((await screen.findAllByText("关闭中")).length).toBeGreaterThan(0);
  });

  it("两个会话可独立关闭，一个关闭中不阻塞另一个", async () => {
    sessionsMock.mockResolvedValue([
      session({ status: "running", stage: "ready" }),
      session({
        id: "session-2",
        package: "com.google.android.chrome",
        app_label: "Chrome",
        title: "Task Dock · 虚拟屏 · Chrome",
        status: "running",
        stage: "ready",
      }),
    ]);
    stopMock.mockImplementation(() => new Promise<boolean>(() => {}));
    const user = userEvent.setup();
    render(<VirtualDisplaySection />);

    await screen.findByText("V2323A · 设置");
    await screen.findByText("V2323A · Chrome");
    const firstClose = screen.getAllByRole("button", { name: "关闭" })[0];
    await user.click(firstClose);

    expect(stopMock).toHaveBeenCalledWith("session-1");
    const firstClosing = screen.getByRole("button", { name: "关闭中" });
    expect((firstClosing as HTMLButtonElement).disabled).toBe(true);
    const secondClose = screen.getByRole("button", { name: "关闭" });
    expect((secondClose as HTMLButtonElement).disabled).toBe(false);

    await user.click(secondClose);
    expect(stopMock).toHaveBeenCalledWith("session-2");
    expect(screen.getAllByRole("button", { name: "关闭中" })).toHaveLength(2);
  });

  it("高级设置默认折叠，诊断与重连只在展开后可用", async () => {
    sessionsMock.mockResolvedValue([
      session({ status: "running", stage: "ready" }),
    ]);
    diagMock.mockResolvedValue({
      owned_sessions: 0,
      stale_displays: ["display 12: 1080x1920"],
      note: "",
    });
    const user = userEvent.setup();
    render(<VirtualDisplaySection />);

    await screen.findByText("V2323A · 设置");
    expect(screen.queryByText("会话设置")).toBeNull();

    await user.click(screen.getByRole("button", { name: /高级设置与诊断/ }));
    expect(screen.getByText("会话设置")).toBeTruthy();

    const multi = screen.getByRole("switch", { name: "多屏实验模式" }) as HTMLInputElement;
    expect(multi.checked).toBe(false);
    await user.click(multi);
    expect(multi.checked).toBe(true);

    await user.click(screen.getByRole("button", { name: "检测虚拟显示残留" }));
    expect(diagMock).toHaveBeenCalledWith(SERIAL_A);
    expect(await screen.findByText("display 12: 1080x1920")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "重连 ADB" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByText(/重连该设备的 ADB/).length).toBeGreaterThan(0);
    await user.click(within(dialog).getByRole("button", { name: "重连 ADB" }));
    expect(reconnectMock).toHaveBeenCalledWith(SERIAL_A);
  });

  it("多设备切换时丢弃上一台设备的迟到应用响应", async () => {
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
    let resolveA: (value: VdAppList) => void = () => {};
    const pendingA = new Promise<VdAppList>((resolve) => {
      resolveA = resolve;
    });
    appsMock.mockImplementation((serial) => {
      if (serial === SERIAL_A) return pendingA;
      return Promise.resolve(appList(SERIAL_B, "UID-B", [CHROME_APP]));
    });
    const user = userEvent.setup();
    render(<VirtualDisplaySection />);

    await screen.findAllByText("V2323A");
    await user.click(screen.getByRole("combobox", { name: "选择设备" }));
    await user.click(await screen.findByRole("option", { name: /Pixel 9/ }));
    await waitFor(() => expect(appsMock).toHaveBeenCalledWith(SERIAL_B, false));

    await user.click(screen.getByRole("button", { name: /独立虚拟屏幕/ }));
    expect(await screen.findByRole("button", { name: /Chrome/ })).toBeTruthy();

    await act(async () => {
      resolveA(appList(SERIAL_A, "UID-A", [SETTINGS_APP]));
    });
    await waitFor(() => {
      expect(screen.queryByText("com.android.settings")).toBeNull();
    });
    expect(screen.getByText("com.google.android.chrome")).toBeTruthy();
  });

  it("应用列表读取期间显示加载状态", async () => {
    let resolveApps: (value: VdAppList) => void = () => {};
    appsMock.mockReturnValue(
      new Promise<VdAppList>((resolve) => {
        resolveApps = resolve;
      }),
    );
    const user = userEvent.setup();
    render(<VirtualDisplaySection />);

    await screen.findAllByText("V2323A");
    await user.click(screen.getByRole("button", { name: /独立虚拟屏幕/ }));
    expect(await screen.findByText("正在读取应用列表…")).toBeTruthy();

    await act(async () => {
      resolveApps(appList(SERIAL_A, "UID-A", [SETTINGS_APP]));
    });
    expect(await screen.findByText("com.android.settings")).toBeTruthy();
  });

  it("卸载不关闭会话；重新挂载会重新读取真实状态", async () => {
    const { unmount } = render(<VirtualDisplaySection />);
    await screen.findAllByText("V2323A");
    const deviceCalls = devicesMock.mock.calls.length;
    const sessionCalls = sessionsMock.mock.calls.length;

    unmount();
    expect(stopMock).not.toHaveBeenCalled();

    render(<VirtualDisplaySection />);
    await screen.findAllByText("V2323A");
    await waitFor(() => {
      expect(devicesMock.mock.calls.length).toBeGreaterThan(deviceCalls);
      expect(sessionsMock.mock.calls.length).toBeGreaterThan(sessionCalls);
    });
  });
});
