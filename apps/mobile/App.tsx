// 应用入口：先打开数据库并读取主题偏好，再挂载界面。
// 启动失败必须显式报错，不能进一个「看起来空数据」的界面。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, AppState, BackHandler, Linking, StyleSheet, Text, View, useColorScheme } from "react-native";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";

import { LaunchOverlay } from "./src/components/LaunchOverlay";
import { TabBar, type TabKey } from "./src/components/TabBar";
import { openDatabase } from "./src/db/database";
import { getSetting, setSetting } from "./src/db/kv";
import { useWindowInsets } from "./src/lib/insets";
import type { Route, RouteKey } from "./src/lib/nav";
import { offerPairingUri } from "./src/lib/sync/pendingPairing";
import { subscribeReminderActions } from "./src/notifications/actions";
import { rebuildAllReminders, rescheduleAllReminders } from "./src/notifications/reminderEngine";
import { ensureReminderCategory, installNotificationHandler } from "./src/notifications/reminders";
import { ConflictScreen } from "./src/screens/ConflictScreen";
import { InboxScreen } from "./src/screens/InboxScreen";
import { NoteEditorScreen } from "./src/screens/NoteEditorScreen";
import { NotesScreen } from "./src/screens/NotesScreen";
import { NotificationsScreen } from "./src/screens/NotificationsScreen";
import { PairingScreen } from "./src/screens/PairingScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { ShareScreen } from "./src/screens/ShareScreen";
import { SyncScreen } from "./src/screens/SyncScreen";
import { TasksScreen } from "./src/screens/TasksScreen";
import { WidgetScreen } from "./src/screens/WidgetScreen";
import { duration, easeOut, MotionProvider, useReduceMotion } from "./src/theme/MotionProvider";
import { ThemeProvider, useTheme } from "./src/theme/ThemeProvider";
import { font, palette, space, type ThemeMode } from "./src/theme/tokens";

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * 通知动作的「能力版本」：动作按钮是在排期时写进通知的，老通知不会自动长出按钮。
 * 版本不一致时整体重排一次（只发生在升级后的首次启动），之后每次启动只做幂等等价对账。
 */
const REMINDER_ACTIONS_VERSION = "1";

// 原生启动图一直保留到 JS 第一帧：LaunchOverlay 在布局完成后主动隐藏。
// 开库失败时也要显式隐藏，否则错误页会被原生图永久盖住。
// 退出动画设为 0：JS 首帧与原生图同构（同一张骨架、同一 80dp），硬切不可见；
// 默认 400ms 淡出反而会把动画开头盖掉。
SplashScreen.setOptions({ duration: 0 });
void SplashScreen.preventAutoHideAsync().catch(() => undefined);

/** 切换标签页时的轻微淡入：不位移、不缩放，避免打断正在阅读的列表 */
function ScreenFade({ children }: { children: ReactNode }) {
  const reduceMotion = useReduceMotion();
  const opacity = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useEffect(() => {
    if (reduceMotion) {
      opacity.setValue(1);
      return;
    }
    const animation = Animated.timing(opacity, {
      toValue: 1,
      duration: duration.fast,
      easing: easeOut,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [opacity, reduceMotion]);

  return <Animated.View style={[styles.fill, { opacity }]}>{children}</Animated.View>;
}

function Shell() {
  const { tokens, scheme } = useTheme();
  const insets = useWindowInsets();
  const [tab, setTab] = useState<TabKey>("tasks");
  /** 数据版本号：前台恢复、收集箱转任务后自增，驱动列表重查 */
  const [version, setVersion] = useState(0);
  /** 推送栈：非空时全屏盖在 Tab 之上（隐藏 TabBar），硬件返回 = pop */
  const [stack, setStack] = useState<Route[]>([]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") setVersion((v) => v + 1);
    });
    return () => sub.remove();
  }, []);

  // 通知上的「完成 / 10 分钟后」会直接改库：处理完让列表重查一次，
  // 否则前台时点动作，界面还停在旧数据上。
  useEffect(() => {
    return subscribeReminderActions(() => setVersion((v) => v + 1));
  }, []);

  // 收集箱转任务后只刷新数据、不强制切页：用户通常要连续整理多条记录
  const handleDataChanged = useCallback(() => {
    setVersion((v) => v + 1);
  }, []);

  const push = useCallback((key: RouteKey, noteId?: string) => {
    setStack((prev) => {
      // 深链可能在配对页已打开时重复触发：不叠加第二个相同页面，
      // 新载荷由 pendingPairing 的订阅者就地更新。
      if (key === "pairing" && prev[prev.length - 1]?.key === "pairing") return prev;
      return [...prev, { key, noteId }];
    });
  }, []);

  // 深链配对：系统相机扫描 taskdock://pair?... 后唤起 App（冷启动与运行中都覆盖）。
  // 载荷只进内存队列，不写日志；解析失败的非本应用链接静默忽略。
  useEffect(() => {
    let active = true;
    const handle = (url: string | null | undefined) => {
      if (!active || !url) return;
      if (offerPairingUri(url)) push("pairing");
    };
    void Linking.getInitialURL()
      .then(handle)
      .catch(() => undefined);
    const subscription = Linking.addEventListener("url", (event) => handle(event.url));
    return () => {
      active = false;
      subscription.remove();
    };
  }, [push]);

  const back = useCallback(() => {
    // 推送页返回后让已挂载的 Tab 页重查一次：配对/解除配对会改变设置页状态。
    setVersion((v) => v + 1);
    setStack((prev) => prev.slice(0, -1));
  }, []);

  const nav = useMemo(() => ({ push, back }), [push, back]);

  // 硬件返回：栈非空时 pop 栈顶。NoteEditor 会注册自己的返回监听（晚于这里注册，
  // RN 先调用后注册者），因此编辑页的未保存内容会先走「保存再关」，不会绕过。
  const stackDepth = stack.length;
  useEffect(() => {
    if (stackDepth === 0) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      // 与顶栏返回一致：弹栈后让下层 Tab 页重查一次（配对状态可能已变化）。
      setVersion((v) => v + 1);
      setStack((prev) => prev.slice(0, -1));
      return true;
    });
    return () => sub.remove();
  }, [stackDepth]);

  const top = stack[stack.length - 1] ?? null;

  const renderRoute = (route: Route): ReactNode => {
    switch (route.key) {
      case "pairing":
        return <PairingScreen nav={nav} />;
      case "sync":
        return <SyncScreen nav={nav} />;
      case "conflict":
        return <ConflictScreen nav={nav} />;
      case "note_editor":
        return (
          <NoteEditorScreen
            noteId={route.noteId}
            nav={nav}
            onDataChanged={handleDataChanged}
          />
        );
      case "widget":
        return <WidgetScreen nav={nav} />;
      case "share":
        return <ShareScreen nav={nav} onDataChanged={handleDataChanged} />;
      case "notifications":
        return <NotificationsScreen nav={nav} />;
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg, paddingTop: insets.top }]}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      {/* 推送页打开时底层 Tab 页仍挂载（返回要保留滚动位置），但它被完全盖住：
          无障碍树里必须一起隐藏，否则 TalkBack 能聚焦到看不见的筛选条/列表项。
          body 只有 flex:1，首帧 top 为 null 时无障碍属性都是默认值，Fabric 会把它当
          layout-only 折叠掉、不建原生 View；推送页打开时属性才变成非默认值，属性能否
          生效就取决于「折叠 -> 实视图」的运行期转换。collapsable={false} 让它从首帧起
          就是稳定存在的原生 View，之后只更新同一层的属性，不再依赖折叠/展开时机。
          aria-hidden 是跨平台写法（iOS 映射 accessibilityElementsHidden；Android 由
          View.js 同时映射为 no-hide-descendants）；importantForAccessibility 再显式兜住
          Android——RN 的 accessibilityElementsHidden 在 Android 没有原生 setter，是空操作。 */}
      <View
        style={styles.body}
        collapsable={false}
        aria-hidden={Boolean(top)}
        importantForAccessibility={top ? "no-hide-descendants" : "auto"}
      >
        {tab === "tasks" ? (
          <ScreenFade>
            <TasksScreen version={version} />
          </ScreenFade>
        ) : null}
        {tab === "inbox" ? (
          <ScreenFade>
            <InboxScreen
              onPromoted={handleDataChanged}
              onOpenTasks={() => setTab("tasks")}
            />
          </ScreenFade>
        ) : null}
        {tab === "notes" ? (
          <ScreenFade>
            <NotesScreen version={version} nav={nav} />
          </ScreenFade>
        ) : null}
        {tab === "settings" ? (
          <ScreenFade>
            <SettingsScreen nav={nav} version={version} />
          </ScreenFade>
        ) : null}
      </View>

      {/* 推送页：宿主绝对定位盖满根容器（含 TabBar 区域）；ScreenFade 不能直接参与
          root 的纵向布局，否则 flex:1 会与 body 平分高度，推送页只占半屏（真机实测）。
          top 必须手动让开状态栏：RN 的 absolute 子元素相对 border box 定位，
          不会自动吃到 root 的 paddingTop（真机实测 AppBar 与状态栏重叠）。 */}
      {top ? (
        <View
          style={[styles.pushHost, { top: insets.top }]}
          pointerEvents="box-none"
          // iOS：让 VoiceOver 把推送页当模态容器，忽略同级的底层 Tab 内容。
          // Android 没有这个属性的原生 setter（BaseViewManagerDelegate 不处理），无副作用。
          accessibilityViewIsModal
        >
          <ScreenFade key={`${top.key}-${top.noteId ?? "new"}`}>
            <View style={[styles.pushPage, { backgroundColor: tokens.bg }]}>
              {renderRoute(top)}
            </View>
          </ScreenFade>
        </View>
      ) : null}

      {top ? null : <TabBar active={tab} onChange={setTab} bottomInset={insets.bottom} />}
    </View>
  );
}

type BootState =
  | { phase: "loading" }
  | { phase: "ready"; mode: ThemeMode }
  | { phase: "error"; message: string };

function BootErrorView({ message }: { message: string }) {
  // 主题偏好还没读出来（或读失败）时只能跟随系统
  const systemScheme = useColorScheme();
  const tokens = palette(systemScheme === "dark" ? "dark" : "light");

  return (
    <View style={[styles.boot, { backgroundColor: tokens.bg }]}>
      <StatusBar style={systemScheme === "dark" ? "light" : "dark"} />
      <Text style={[styles.errorTitle, { color: tokens.danger }]}>本地数据库打开失败</Text>
      <Text style={[styles.errorBody, { color: tokens.textSoft }]}>{message}</Text>
      <Text style={[styles.errorHint, { color: tokens.muted }]}>
        请重启应用；若反复出现，检查设备存储是否可写、剩余空间是否充足。
      </Text>
    </View>
  );
}

export default function App() {
  const [boot, setBoot] = useState<BootState>({ phase: "loading" });
  /** 退场动画结束后才卸载启动层，避免主界面先露出再淡入 */
  const [launchDone, setLaunchDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        installNotificationHandler();
        await openDatabase();
        // 启动时对账提醒：系统升级/换时区/被系统清理后，排期可能已经丢失。
        // 顺序必须先注册动作按钮，再决定「整体重排」还是「幂等等价对账」。
        // 失败不阻塞启动（通知是增强能力，不是打开应用的前提）。
        void (async () => {
          await ensureReminderCategory().catch(() => undefined);
          const actionsVersion = await getSetting("reminder_actions_version");
          if (actionsVersion === REMINDER_ACTIONS_VERSION) {
            await rescheduleAllReminders();
            return;
          }
          await rebuildAllReminders();
          await setSetting("reminder_actions_version", REMINDER_ACTIONS_VERSION);
        })().catch(() => undefined);
        const stored = await getSetting("theme_mode");
        if (cancelled) return;
        setBoot({ phase: "ready", mode: isThemeMode(stored) ? stored : "system" });
      } catch (error) {
        if (cancelled) return;
        // 错误页必须自己接管屏幕，不能让原生启动图一直盖着
        SplashScreen.hide();
        setBoot({
          phase: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const finishLaunch = useCallback(() => setLaunchDone(true), []);

  if (boot.phase === "error") {
    return <BootErrorView message={boot.message} />;
  }

  return (
    <MotionProvider>
      {boot.phase === "ready" ? (
        <ThemeProvider initialMode={boot.mode}>
          <Shell />
        </ThemeProvider>
      ) : null}
      {launchDone ? null : (
        <LaunchOverlay ready={boot.phase === "ready"} onDone={finishLaunch} />
      )}
    </MotionProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1 },
  fill: { flex: 1 },
  pushHost: {
    position: "absolute" as const,
    left: 0,
    right: 0,
    bottom: 0,
  },
  pushPage: {
    flex: 1,
  },
  boot: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    padding: space.xl,
  },
  errorTitle: {
    fontSize: font.title + 3,
    fontWeight: "700",
    textAlign: "center",
  },
  errorBody: {
    fontSize: font.body,
    lineHeight: 19,
    textAlign: "center",
  },
  errorHint: {
    fontSize: font.label,
    lineHeight: 16,
    textAlign: "center",
    marginTop: space.sm,
    maxWidth: 260,
  },
});
