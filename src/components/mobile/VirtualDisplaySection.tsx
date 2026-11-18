//! Android 屏幕与控制（ADB + scrcpy）。
//!
//! 页面内（手机互传 → 屏幕控制）的投屏控制面板：
//! - 第一层：设备连接与工具链状态；
//! - 第二层：双模式选择与启动配置；
//! - 第三层：正在运行的投屏会话；
//! - 第四层：高级设置与诊断（默认折叠）。
//!
//! 本组件只做设备/模式/应用选择与会话状态展示；画面、输入法与键鼠全部由
//! scrcpy 独立窗口提供。所有按钮都连接真实后端命令，没有占位操作。
//! 卸载不会停止 scrcpy 会话；重新进入页面会重新读取后端真实状态。

import { useEffect, useMemo, useRef, useState } from "react";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import {
  CheckCircle2,
  Loader2,
  Monitor,
  Play,
  ShieldAlert,
  Smartphone,
} from "lucide-react";

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
  type VdApp,
  type VdAppList,
  type VdDevice,
  type VdDiagnostics,
  type VdMode,
  type VdProbe,
  type VdScreenshot,
  type VdScreenshotEvent,
  type VdSession,
} from "../../lib/bridge";
import { copyText } from "../../lib/clipboard";
import { localizedErrorMessage } from "../../i18n/errors";
import { useLocale } from "../../hooks/useLocale";
import { useUiStore } from "../../store/useUiStore";
import { useVirtualDisplayStore } from "../../store/useVirtualDisplayStore";
import { ConfirmDialog } from "../ui";
import DeviceTools from "./virtual-display/device-tools";
import ModePicker from "./virtual-display/mode-picker";
import AppPicker from "./virtual-display/app-picker";
import SessionList from "./virtual-display/session-list";
import AdvancedSection from "./virtual-display/advanced-section";
import ScreenshotPreview from "./virtual-display/screenshot-preview";
import {
  projectionWindowController,
  toolbarVisibilityFor,
} from "./virtual-display/projection-window-controller";
import {
  connectionLabelKey,
  deviceLabel,
  deviceStateKey,
  isActiveSession,
  isValidPackageName,
  launchStageKey,
  type Translate,
} from "./virtual-display/format";
import "./virtual-display.css";

const DEFAULT_SIZE = "1080x1920/384";

function toMessage(err: unknown): string {
  return localizedErrorMessage(err);
}

export default function VirtualDisplaySection() {
  const { t } = useLocale();
  const tr = t as Translate;
  const showToast = useUiStore((s) => s.showToast);
  const getStoredConfig = useVirtualDisplayStore((s) => s.getVirtualDisplayConfig);
  const saveConfig = useVirtualDisplayStore((s) => s.setVirtualDisplayConfig);

  const [initializing, setInitializing] = useState(true);
  const [probe, setProbe] = useState<VdProbe | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [devices, setDevices] = useState<VdDevice[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [adbOk, setAdbOk] = useState(true);
  const [serial, setSerial] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const selectedUidRef = useRef("");

  const [apps, setApps] = useState<VdApp[]>([]);
  const [appListMeta, setAppListMeta] = useState<{
    uid: string;
    launchableKnown: boolean;
  } | null>(null);
  const [appsLoading, setAppsLoading] = useState(false);
  const [appsError, setAppsError] = useState<string | null>(null);
  const [includeAll, setIncludeAll] = useState(false);
  const [appUsage, setAppUsage] = useState<{ recent: string[]; favorites: string[] }>({
    recent: [],
    favorites: [],
  });

  const [mode, setMode] = useState<VdMode>("mirror");
  const [packageName, setPackageName] = useState("");
  const [manual, setManual] = useState(false);
  const [manualPackage, setManualPackage] = useState("");
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [clipboardSync, setClipboardSync] = useState(false);
  const [allowMulti, setAllowMulti] = useState(false);

  const [sessions, setSessions] = useState<VdSession[]>([]);
  const [busy, setBusy] = useState(false);
  const [closingIds, setClosingIds] = useState<string[]>([]);
  const [startError, setStartError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [capturingId, setCapturingId] = useState<string | null>(null);
  const [shot, setShot] = useState<{
    sessionId: string;
    session: VdSession;
    data: VdScreenshot;
  } | null>(null);
  const [shotBusy, setShotBusy] = useState(false);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [diag, setDiag] = useState<VdDiagnostics | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [reconnectOpen, setReconnectOpen] = useState(false);
  const [reconnectBusy, setReconnectBusy] = useState(false);

  const mountedRef = useRef(true);
  const devicesInFlight = useRef(false);
  const sessionsInFlight = useRef(false);
  const sessionsSignature = useRef("");
  const appSeq = useRef(0);
  const previousUid = useRef("");

  // 刷新函数放到 ref：interval / visibilitychange 始终调用最新实现，
  // 同时避免把稳定回调写进依赖数组导致定时器反复重建。
  const refreshProbe = useRef<() => Promise<void>>(async () => {});
  const refreshDevices = useRef<() => Promise<void>>(async () => {});
  const refreshSessions = useRef<() => Promise<void>>(async () => {});
  const loadApps = useRef(
    async (_serial: string, _uid: string, _includeAll: boolean): Promise<void> => {},
  );

  refreshProbe.current = async () => {
    setProbeBusy(true);
    try {
      const next = await vdProbe();
      if (mountedRef.current) setProbe(next);
    } catch (err) {
      if (mountedRef.current) showToast(toMessage(err), { kind: "error" });
    } finally {
      if (mountedRef.current) setProbeBusy(false);
    }
  };

  refreshDevices.current = async () => {
    if (devicesInFlight.current) return;
    devicesInFlight.current = true;
    try {
      const list = await vdDevices();
      if (!mountedRef.current) return;
      setDevices(list.devices);
      setAdbOk(list.adb_ok);
      setDeviceError(list.error);
      setSerial((current) => {
        const stillThere = list.devices.find(
          (device) => device.serial === current || device.transports.includes(current),
        );
        if (stillThere) {
          selectedUidRef.current = stillThere.uid;
          return stillThere.serial;
        }
        // transport 轮换（mDNS 端口变化）时按物理设备身份保持选择，避免选错手机。
        const byUid = list.devices.find((device) => device.uid === selectedUidRef.current);
        if (byUid) {
          selectedUidRef.current = byUid.uid;
          return byUid.serial;
        }
        const online = list.devices.filter((device) => device.state === "device");
        const preferred = online[0] ?? list.devices[0];
        selectedUidRef.current = preferred?.uid ?? "";
        return preferred?.serial ?? "";
      });
    } catch (err) {
      if (mountedRef.current) setDeviceError(toMessage(err));
    } finally {
      devicesInFlight.current = false;
    }
  };

  refreshSessions.current = async () => {
    if (sessionsInFlight.current) return;
    sessionsInFlight.current = true;
    try {
      const list = await vdSessions();
      if (!mountedRef.current) return;
      // 只更新可观察字段，避免相同数据每秒触发重排/闪烁。
      const signature = list
        .map(
          (session) =>
            `${session.id}:${session.status}:${session.stage}:${session.app_label ?? ""}:${
              session.error ?? ""
            }:${session.warning ?? ""}:${session.alive}:${session.package ?? ""}:${
              session.toolbar_state
            }`,
        )
        .join("|");
      if (signature !== sessionsSignature.current) {
        sessionsSignature.current = signature;
        setSessions(list);
      }
    } catch {
      // 轮询失败不覆盖已有状态：下一轮会重试，避免闪成空列表。
    } finally {
      sessionsInFlight.current = false;
    }
  };

  loadApps.current = async (
    targetSerial: string,
    targetUid: string,
    wantAll: boolean,
  ) => {
    if (!targetSerial) {
      setApps([]);
      setAppsError(null);
      setAppListMeta(null);
      return;
    }
    const seq = ++appSeq.current;
    setAppsLoading(true);
    setAppsError(null);
    try {
      const list: VdAppList = await vdListApps(targetSerial, wantAll);
      if (!mountedRef.current || seq !== appSeq.current) return;
      // 设备切换/transport 轮换后丢弃过期响应，避免显示上一台设备的应用。
      if (list.serial !== targetSerial) return;
      if (targetUid && list.device_uid !== targetUid) return;
      setApps(list.apps);
      setAppListMeta({ uid: list.device_uid, launchableKnown: list.launchable_known });
      setPackageName((current) =>
        current && list.apps.some((app) => app.package === current) ? current : "",
      );
    } catch (err) {
      if (seq === appSeq.current) setAppsError(toMessage(err));
    } finally {
      if (seq === appSeq.current) setAppsLoading(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    void (async () => {
      await Promise.allSettled([
        refreshProbe.current(),
        refreshDevices.current(),
        refreshSessions.current(),
      ]);
      if (!cancelled && mountedRef.current) setInitializing(false);
    })();
    return () => {
      cancelled = true;
      mountedRef.current = false;
      appSeq.current += 1;
    };
  }, []);

  // 运行中/启动中时加快轮询；页面隐藏时暂停，避免后台无意义请求。
  const fastPoll = sessions.some(
    (session) => session.status === "starting" || session.status === "stopping",
  );
  useEffect(() => {
    const timer = window.setInterval(
      () => {
        if (document.hidden) return;
        void refreshDevices.current();
        void refreshSessions.current();
        setNow(Date.now());
      },
      fastPoll ? 1000 : 3000,
    );
    const onVisible = () => {
      if (document.hidden) return;
      // 页面切回/窗口恢复时立即同步真实状态，避免最多 3 秒的过期展示。
      void refreshDevices.current();
      void refreshSessions.current();
      setNow(Date.now());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fastPoll]);

  // 工具链缺失时低频重试：用户可能在页面打开期间安装/改 PATH。
  const toolchainMissing = probe !== null && (!probe.adb_path || !probe.scrcpy_path);
  useEffect(() => {
    if (!toolchainMissing) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshProbe.current();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [toolchainMissing]);

  const selectedDevice = useMemo(
    () =>
      devices.find(
        (device) => device.serial === serial || device.transports.includes(serial),
      ) ?? null,
    [devices, serial],
  );
  const selectedUid = selectedDevice?.uid ?? "";

  /** 把启动配置写入 store：页面切换/组件卸载不清除，只有用户修改或设备移除才变化。 */
  const patchConfig = (
    patch: Partial<{
      mode: VdMode;
      selectedPackage?: string;
      size: string;
      multiDisplayEnabled: boolean;
      clipboardSync: boolean;
    }>,
  ) => {
    if (!selectedUid) return;
    const previous = getStoredConfig(selectedUid);
    saveConfig(selectedUid, {
      mode: patch.mode ?? previous?.mode ?? "mirror",
      selectedPackage: patch.selectedPackage ?? previous?.selectedPackage,
      size: patch.size ?? previous?.size ?? DEFAULT_SIZE,
      multiDisplayEnabled:
        patch.multiDisplayEnabled ?? previous?.multiDisplayEnabled ?? false,
      clipboardSync: patch.clipboardSync ?? previous?.clipboardSync ?? false,
    });
  };

  useEffect(() => {
    void loadApps.current(serial, selectedUid, includeAll);
  }, [serial, selectedUid, includeAll]);

  useEffect(() => {
    if (selectedDevice) selectedUidRef.current = selectedDevice.uid;
  }, [selectedDevice]);

  // 最近/收藏按物理设备 UID 隔离，避免 A 手机的记录出现在 B 手机上。
  useEffect(() => {
    if (!selectedUid) {
      setAppUsage({ recent: [], favorites: [] });
      return;
    }
    try {
      const raw = window.localStorage.getItem(`task-dock.vd.apps.${selectedUid}`);
      const parsed = raw ? (JSON.parse(raw) as Partial<typeof appUsage>) : null;
      setAppUsage({
        recent: Array.isArray(parsed?.recent)
          ? parsed.recent.filter((value): value is string => typeof value === "string")
          : [],
        favorites: Array.isArray(parsed?.favorites)
          ? parsed.favorites.filter((value): value is string => typeof value === "string")
          : [],
      });
    } catch {
      setAppUsage({ recent: [], favorites: [] });
    }
  }, [selectedUid]);

  // 只有真正进入 running 的虚拟屏会话才写入最近使用；点击启动本身不算成功。
  useEffect(() => {
    if (!selectedUid) return;
    const launched = sessions
      .filter(
        (session) =>
          session.status === "running" &&
          session.mode === "virtual" &&
          session.device_uid === selectedUid &&
          Boolean(session.package),
      )
      .map((session) => session.package as string);
    if (launched.length === 0) return;
    setAppUsage((previous) => {
      const nextRecent = [...launched, ...previous.recent].filter(
        (pkg, index, all) => all.indexOf(pkg) === index,
      );
      if (
        nextRecent.length === previous.recent.length &&
        nextRecent.every((pkg, index) => pkg === previous.recent[index])
      ) {
        return previous;
      }
      const next = { ...previous, recent: nextRecent.slice(0, 8) };
      try {
        window.localStorage.setItem(
          `task-dock.vd.apps.${selectedUid}`,
          JSON.stringify(next),
        );
      } catch {
        // 本地存储不可用时仍保留本次会话内的最近记录。
      }
      return next;
    });
  }, [sessions, selectedUid]);

  const toggleFavorite = (packageToToggle: string) => {
    setAppUsage((previous) => {
      const favorites = previous.favorites.includes(packageToToggle)
        ? previous.favorites.filter((pkg) => pkg !== packageToToggle)
        : [packageToToggle, ...previous.favorites].slice(0, 12);
      const next = { ...previous, favorites };
      try {
        if (selectedUid) {
          window.localStorage.setItem(
            `task-dock.vd.apps.${selectedUid}`,
            JSON.stringify(next),
          );
        }
      } catch {
        // 同上：不可用时只在本会话内保留。
      }
      return next;
    });
  };

  // 设备切换后清空上一台手机的包名与手动输入，避免把 A 的包名带到 B。
  useEffect(() => {
    if (previousUid.current && previousUid.current !== selectedUid) {
      setPackageName("");
      setManualPackage("");
      setManual(false);
      setStartError(null);
      setDiag(null);
    }
    previousUid.current = selectedUid;
  }, [selectedUid]);

  // 页面重新挂载/切换设备时恢复该设备的启动配置（在清空逻辑之后执行，覆盖默认值）。
  useEffect(() => {
    if (!selectedUid) return;
    const config = getStoredConfig(selectedUid);
    if (!config) return;
    setMode(config.mode);
    setSize(config.size || DEFAULT_SIZE);
    setAllowMulti(config.multiDisplayEnabled);
    setClipboardSync(Boolean(config.clipboardSync));
    if (config.selectedPackage) {
      setPackageName(config.selectedPackage);
      setManual(false);
      setManualPackage("");
    }
  }, [selectedUid, getStoredConfig]);

  // 投屏控制栏生命周期：只在 Session running 后 attach；Session 真正结束后 destroy。
  // 不在组件卸载时销毁窗口（切页/隐藏页面不会关闭投屏）。
  const toolbarAttachedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const session of sessions) {
      const attached = toolbarAttachedRef.current.has(session.id);
      if (
        session.status === "running" &&
        session.toolbar_state !== "unavailable" &&
        !attached
      ) {
        toolbarAttachedRef.current.add(session.id);
        void projectionWindowController.attach(session.id);
        toolbarVisibilityFor(session.id).showToolbar();
      }
      if (!isActiveSession(session) && attached) {
        toolbarAttachedRef.current.delete(session.id);
        void projectionWindowController.destroy(session.id);
      }
    }
  }, [sessions]);

  // 控制栏截图完成：复用主窗口现有的截图预览（页面未挂载时截图仍保存在临时目录）。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<VdScreenshotEvent>("vd-screenshot-captured", (event) => {
      const payload = event.payload;
      if (!payload?.session || !payload?.screenshot) return;
      if (!mountedRef.current) return;
      setShot({
        sessionId: payload.session.id,
        session: payload.session,
        data: payload.screenshot,
      });
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {
        // 非 Tauri 环境（单测/预览）没有事件通道：不影响页面其余功能。
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const sizeOptions = useMemo(
    () => [
      {
        value: "1080x1920/384",
        label: t("virtualDisplay.size.portrait"),
        hint: "384 DPI",
      },
      {
        value: "1920x1080/384",
        label: t("virtualDisplay.size.landscape"),
        hint: "384 DPI",
      },
    ],
    [t],
  );

  const activeSessions = sessions.filter(isActiveSession);
  const sessionLimit = allowMulti ? 2 : 1;
  const limitReached = activeSessions.length >= sessionLimit;
  const online = selectedDevice?.state === "device";
  const toolchainReady = Boolean(probe?.adb_path && probe?.scrcpy_path) && adbOk;
  const virtualSupported = probe?.supports_new_display === true;
  const chosenPackage = (manual ? manualPackage : packageName).trim();
  const manualInvalid =
    manual && manualPackage.trim().length > 0 && !isValidPackageName(manualPackage.trim());

  const launchSession = useMemo(
    () =>
      sessions.find(
        (session) =>
          isActiveSession(session) &&
          session.serial === serial &&
          session.mode === mode &&
          (mode === "mirror" || session.package === chosenPackage),
      ) ?? null,
    [chosenPackage, mode, serial, sessions],
  );
  const lastFailed = sessions.some(
    (session) =>
      session.serial === serial &&
      session.mode === mode &&
      (session.status === "error" || session.status === "disconnected") &&
      (mode === "mirror" || session.package === chosenPackage),
  );

  const blockReason = useMemo((): string | null => {
    if (!selectedDevice) return t("virtualDisplay.start.blockedDevice");
    if (!online) return t(deviceStateKey(selectedDevice.state));
    if (!toolchainReady) {
      return !probe?.adb_path
        ? t("virtualDisplay.adbMissing")
        : t("virtualDisplay.scrcpyMissing");
    }
    if (mode === "virtual" && !virtualSupported) {
      return t("virtualDisplay.versionUnsupported");
    }
    if (mode === "virtual" && !chosenPackage) return t("virtualDisplay.start.blockedApp");
    if (mode === "virtual" && manualInvalid) {
      return t("virtualDisplay.app.manualInvalid");
    }
    if (launchSession?.status === "stopping") {
      return t("virtualDisplay.session.stopping");
    }
    if (limitReached) return t("virtualDisplay.limitReached");
    if (launchSession) return t("virtualDisplay.start.duplicate");
    return null;
  }, [
    chosenPackage,
    launchSession,
    limitReached,
    manualInvalid,
    mode,
    online,
    probe,
    selectedDevice,
    t,
    toolchainReady,
    virtualSupported,
  ]);

  const canStart = !busy && blockReason === null;

  const startPhase = busy
    ? t("virtualDisplay.start.checking")
    : launchSession?.status === "starting"
      ? t(launchStageKey(launchSession.stage))
      : null;

  const startLabel = busy
    ? t("virtualDisplay.start.checking")
    : launchSession?.status === "starting"
      ? t(launchStageKey(launchSession.stage))
      : launchSession?.status === "running"
        ? limitReached
          ? t("virtualDisplay.start.limitLabel")
          : t("virtualDisplay.start.ready")
        : launchSession?.status === "stopping"
          ? t("virtualDisplay.session.stopping")
          : lastFailed
            ? t("virtualDisplay.start.retry")
            : t(
                mode === "mirror"
                  ? "virtualDisplay.start.mirror"
                  : "virtualDisplay.start.virtual",
              );

  const refreshAll = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([refreshProbe.current(), refreshDevices.current()]);
      await loadApps.current(serial, selectedUid, includeAll);
      await refreshSessions.current();
      setNow(Date.now());
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  };

  const create = async () => {
    if (!canStart || !serial) return;
    if (mode === "virtual") {
      if (!chosenPackage) {
        setStartError(t("virtualDisplay.start.blockedApp"));
        return;
      }
      if (!isValidPackageName(chosenPackage)) {
        setStartError(t("virtualDisplay.app.manualInvalid"));
        return;
      }
    }
    setBusy(true);
    setStartError(null);
    try {
      const created = await vdStart({
        serial,
        mode,
        packageName: mode === "virtual" ? chosenPackage : null,
        size: mode === "virtual" ? size : null,
        clipboardSync,
        allowMulti,
      });
      if (!mountedRef.current) return;
      setSessions((previous) => [
        ...previous.filter((session) => session.id !== created.id),
        created,
      ]);
      sessionsSignature.current = "";
      await refreshSessions.current();
      setNow(Date.now());
    } catch (err) {
      if (mountedRef.current) setStartError(toMessage(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const closeSession = async (session: VdSession) => {
    if (closingIds.includes(session.id)) return;
    // 每个会话独立记录收尾状态：关闭 A 不应阻止用户继续关闭 B。
    setClosingIds((previous) => [...previous, session.id]);
    // 立即显示「关闭中」，不等待下一次轮询；后端会在空闲时完成真实收尾。
    setSessions((previous) =>
      previous.map((item) =>
        item.id === session.id ? { ...item, status: "stopping" as const } : item,
      ),
    );
    sessionsSignature.current = "";
    try {
      await vdStop(session.id);
      await refreshSessions.current();
    } catch (err) {
      showToast(`${t("virtualDisplay.session.closeFailed")}：${toMessage(err)}`, {
        kind: "error",
      });
      await refreshSessions.current();
    } finally {
      if (mountedRef.current) {
        setClosingIds((previous) => previous.filter((id) => id !== session.id));
      }
    }
  };

  const focusSession = async (session: VdSession) => {
    try {
      const result = await vdFocus(session.id);
      if (!result.found) {
        showToast(t("virtualDisplay.session.focusNotFound"), { kind: "error" });
      } else if (!result.focused) {
        showToast(t("virtualDisplay.session.focusRestored"), { kind: "warning" });
      }
    } catch (err) {
      showToast(toMessage(err), { kind: "error" });
    }
  };

  const retryToolbar = async (session: VdSession) => {
    toolbarAttachedRef.current.delete(session.id);
    showToast(t("virtualDisplay.session.toolbarRetrying"), { kind: "info" });
    await projectionWindowController.attach(session.id);
    await projectionWindowController.update(session.id);
    await refreshSessions.current();
  };

  const captureSession = async (session: VdSession) => {
    if (capturingId || shotBusy) return;
    setCapturingId(session.id);
    try {
      const data = await vdScreenshot(session.id);
      if (!mountedRef.current) return;
      if (!data.path || data.width <= 0 || data.height <= 0) {
        throw new Error(t("virtualDisplay.screenshot.unreadable"));
      }
      setShot({ sessionId: session.id, session, data });
    } catch (err) {
      showToast(`${t("virtualDisplay.screenshot.failed")}：${toMessage(err)}`, {
        kind: "error",
      });
    } finally {
      if (mountedRef.current) setCapturingId(null);
    }
  };

  const saveShotToShelf = async () => {
    if (!shot || shotBusy) return;
    setShotBusy(true);
    try {
      await shelfAddPaths([shot.data.path], "managed", "manual");
      showToast(t("virtualDisplay.screenshot.savedShelf"), { kind: "success" });
      if (mountedRef.current) setShot(null);
    } catch (err) {
      showToast(toMessage(err), { kind: "error" });
    } finally {
      if (mountedRef.current) setShotBusy(false);
    }
  };

  const saveShotAs = async () => {
    if (!shot || shotBusy) return;
    setShotBusy(true);
    try {
      const chosen = await saveFileDialog({
        defaultPath: `task-dock-screen-${shot.session.mode}-${Date.now()}.png`,
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (!chosen) return;
      await vdScreenshotExport(shot.sessionId, chosen);
      showToast(t("virtualDisplay.screenshot.savedAs"), { kind: "success" });
      if (mountedRef.current) setShot(null);
    } catch (err) {
      showToast(toMessage(err), { kind: "error" });
    } finally {
      if (mountedRef.current) setShotBusy(false);
    }
  };

  const runDiagnostics = async () => {
    if (!serial || diagBusy) return;
    setDiagBusy(true);
    try {
      const result = await vdDiagnostics(serial);
      if (mountedRef.current) setDiag(result);
    } catch (err) {
      showToast(toMessage(err), { kind: "error" });
    } finally {
      if (mountedRef.current) setDiagBusy(false);
    }
  };

  const reconnect = async () => {
    if (!serial || reconnectBusy) return;
    setReconnectBusy(true);
    try {
      await vdReconnect(serial);
      showToast(t("virtualDisplay.reconnected"), { kind: "success" });
      if (mountedRef.current) {
        setReconnectOpen(false);
        setDiag(null);
      }
      await refreshDevices.current();
      await refreshSessions.current();
    } catch (err) {
      showToast(toMessage(err), { kind: "error" });
    } finally {
      if (mountedRef.current) setReconnectBusy(false);
    }
  };

  const copyValue = async (value: string) => {
    try {
      const ok = await copyText(value);
      if (!ok) {
        showToast(t("virtualDisplay.advanced.copyFailed"), { kind: "error" });
        return;
      }
      showToast(t("virtualDisplay.advanced.copied"), { kind: "success" });
    } catch (err) {
      showToast(toMessage(err), { kind: "error" });
    }
  };

  return (
    <div className="virtual-display">
      <div className="vd-panel">
        {initializing ? (
          <div className="vd-initializing" role="status">
            <Loader2 size={14} className="spin" aria-hidden="true" />
            {t("virtualDisplay.loading")}
          </div>
        ) : null}

        <div className="vd-overview">
          <DeviceTools
            devices={devices}
            selected={selectedDevice}
            serial={serial}
            adbOk={adbOk}
            deviceError={deviceError}
            probe={probe}
            probeBusy={probeBusy}
            refreshing={refreshing}
            loading={initializing}
            t={tr}
            onSelect={setSerial}
            onRefresh={() => void refreshAll()}
            onRecheck={() => void refreshProbe.current()}
          />
        </div>

        <div className="vd-workbench">
          <div className="vd-primary-column">
            <ModePicker
              mode={mode}
              busy={busy}
              virtualSupported={virtualSupported}
              activeCount={activeSessions.length}
              t={tr}
              onModeChange={(next) => {
                setMode(next);
                setStartError(null);
                patchConfig({ mode: next });
              }}
            />

            <section className="vd-block vd-config" aria-label={t("virtualDisplay.config.title")}>
          <div className="vd-block-head">
            <h3 className="vd-block-title">{t("virtualDisplay.config.title")}</h3>
            <span className="vd-block-note">
              {t(
                mode === "mirror"
                  ? "virtualDisplay.config.mirrorNote"
                  : "virtualDisplay.config.virtualNote",
              )}
            </span>
          </div>

          <div className="vd-config-device">
            <span className="vd-config-device-icon" aria-hidden="true">
              <Smartphone size={14} />
            </span>
            <div className="vd-config-device-main">
              <span className="vd-config-device-name">
                {selectedDevice
                  ? deviceLabel(selectedDevice, tr)
                  : t("virtualDisplay.noDevice")}
              </span>
              {selectedDevice ? (
                <span className="vd-config-device-meta">
                  {t(connectionLabelKey(selectedDevice.connection))} ·{" "}
                  {t(deviceStateKey(selectedDevice.state))}
                </span>
              ) : (
                <span className="vd-config-device-meta">
                  {t("virtualDisplay.noDeviceHint")}
                </span>
              )}
            </div>
            {selectedDevice ? (
              <span
                className={`vd-status-dot is-${selectedDevice.state}`}
                aria-hidden="true"
              />
            ) : null}
          </div>

          {mode === "virtual" ? (
            <>
              <AppPicker
                apps={apps}
                loading={appsLoading}
                error={appsError}
                launchableKnown={appListMeta?.launchableKnown ?? false}
                includeAll={includeAll}
                deviceUid={selectedUid}
                selectedPackage={packageName}
                recentPackages={appUsage.recent}
                favoritePackages={appUsage.favorites}
                manual={manual}
                manualPackage={manualPackage}
                manualError={manualInvalid ? t("virtualDisplay.app.manualInvalid") : null}
                disabled={busy}
                t={tr}
                onSelect={(nextPackage) => {
                  setPackageName(nextPackage);
                  patchConfig({ selectedPackage: nextPackage });
                }}
                onToggleFavorite={toggleFavorite}
                onManualChange={(value) => {
                  setManualPackage(value);
                  patchConfig({ selectedPackage: value });
                }}
                onToggleManual={(open) => {
                  setManual(open);
                  setStartError(null);
                }}
                onToggleIncludeAll={() => setIncludeAll((value) => !value)}
                onRefresh={() => void loadApps.current(serial, selectedUid, includeAll)}
              />

              <div className="vd-size-field">
                <div className="vd-field-head">
                  <span className="vd-field-label">{t("virtualDisplay.config.size")}</span>
                  <span className="vd-field-count">384 DPI</span>
                </div>
                <div
                  className="vd-size-seg"
                  role="group"
                  aria-label={t("virtualDisplay.config.size")}
                >
                  {sizeOptions.map((option) => (
                    <button
                      type="button"
                      key={option.value}
                      className={`vd-size-btn${
                        size === option.value ? " is-selected" : ""
                      }`}
                      aria-pressed={size === option.value}
                      onClick={() => {
                        setSize(option.value);
                        patchConfig({ size: option.value });
                      }}
                      disabled={busy}
                    >
                      {option.value.startsWith("1920") ? (
                        <Monitor size={14} aria-hidden="true" />
                      ) : (
                        <Smartphone size={14} aria-hidden="true" />
                      )}
                      <span>{option.label}</span>
                    </button>
                  ))}
                </div>
                <div className="vd-hint">{t("virtualDisplay.config.sizeHint")}</div>
              </div>
            </>
          ) : null}

          <div className="vd-start-row">
            <button
              type="button"
              className="btn primary vd-start-btn"
              onClick={() => void create()}
              disabled={!canStart}
            >
              {busy || launchSession?.status === "starting" ? (
                <Loader2 size={13} className="spin" />
              ) : launchSession?.status === "running" ? (
                <CheckCircle2 size={13} />
              ) : (
                <Play size={13} />
              )}
              {startLabel}
            </button>
            <div className="vd-start-meta">
              {startPhase ? (
                <span className="vd-start-phase" role="status">
                  {startPhase}
                </span>
              ) : null}
              {blockReason ? (
                <span className="vd-start-blocked" data-tip={blockReason}>
                  {blockReason}
                </span>
              ) : (
                <span className="vd-start-ready">
                  {t("virtualDisplay.start.readyHint")}
                </span>
              )}
            </div>
          </div>

          {startError ? (
            <div className="vd-alert is-error" role="alert">
              <ShieldAlert size={13} aria-hidden="true" />
              <div className="vd-alert-body">
                <strong>{t("virtualDisplay.start.failed")}</strong>
                <span>{startError}</span>
              </div>
            </div>
          ) : null}
        </section>
          </div>

          <div className="vd-secondary-column">
            <SessionList
              sessions={sessions}
              activeCount={activeSessions.length}
              limit={sessionLimit}
              currentDevice={selectedDevice}
              now={now}
              closingIds={closingIds}
              capturingId={capturingId}
              t={tr}
              onFocus={(session) => void focusSession(session)}
              onCapture={(session) => void captureSession(session)}
              onRetryToolbar={(session) => void retryToolbar(session)}
              onClose={(session) => void closeSession(session)}
            />
          </div>
        </div>

        <AdvancedSection
          open={advancedOpen}
          onToggle={() => setAdvancedOpen((value) => !value)}
          allowMulti={allowMulti}
          onAllowMultiChange={(value) => {
            setAllowMulti(value);
            patchConfig({ multiDisplayEnabled: value });
          }}
          clipboardSync={clipboardSync}
          onClipboardChange={(value) => {
            setClipboardSync(value);
            patchConfig({ clipboardSync: value });
          }}
          size={size}
          onSizeChange={(value) => {
            setSize(value);
            patchConfig({ size: value });
          }}
          sizeOptions={sizeOptions}
          probe={probe}
          selectedDevice={selectedDevice}
          diag={diag}
          diagBusy={diagBusy}
          reconnectBusy={reconnectBusy}
          t={tr}
          onRunDiagnostics={() => void runDiagnostics()}
          onReconnect={() => setReconnectOpen(true)}
          onCopy={(value) => void copyValue(value)}
        />

        <div className="vd-safety-note">{t("virtualDisplay.safetyNote")}</div>
      </div>

      {shot ? (
        <ScreenshotPreview
          session={shot.session}
          shot={shot.data}
          busy={shotBusy}
          t={tr}
          onSaveShelf={() => void saveShotToShelf()}
          onSaveAs={() => void saveShotAs()}
          onDiscard={() => setShot(null)}
        />
      ) : null}

      <ConfirmDialog
        open={reconnectOpen}
        title={t("virtualDisplay.reconnectTitle")}
        detail={t("virtualDisplay.reconnectConfirm")}
        confirmLabel={t("virtualDisplay.reconnect")}
        danger
        busy={reconnectBusy}
        onConfirm={() => void reconnect()}
        onCancel={() => setReconnectOpen(false)}
      />
    </div>
  );
}
