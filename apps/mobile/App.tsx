// 应用入口：先打开数据库并读取主题偏好，再挂载界面。
// 启动失败必须显式报错，不能进一个「看起来空数据」的界面。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Animated,
  AppState,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from "react-native";
import { StatusBar } from "expo-status-bar";

import { TabBar, type TabKey } from "./src/components/TabBar";
import { openDatabase } from "./src/db/database";
import { getSetting, setSetting } from "./src/db/kv";
import { useWindowInsets } from "./src/lib/insets";
import { subscribeReminderActions } from "./src/notifications/actions";
import { rebuildAllReminders, rescheduleAllReminders } from "./src/notifications/reminderEngine";
import { ensureReminderCategory, installNotificationHandler } from "./src/notifications/reminders";
import { InboxScreen } from "./src/screens/InboxScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { TasksScreen } from "./src/screens/TasksScreen";
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

  return (
    <View style={[styles.root, { backgroundColor: tokens.bg, paddingTop: insets.top }]}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <View style={styles.body}>
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
        {tab === "settings" ? (
          <ScreenFade>
            <SettingsScreen />
          </ScreenFade>
        ) : null}
      </View>
      <TabBar active={tab} onChange={setTab} bottomInset={insets.bottom} />
    </View>
  );
}

type BootState =
  | { phase: "loading" }
  | { phase: "ready"; mode: ThemeMode }
  | { phase: "error"; message: string };

function BootView({ state }: { state: BootState }) {
  // 主题偏好还没读出来（或读失败）时只能跟随系统
  const systemScheme = useColorScheme();
  const tokens = palette(systemScheme === "dark" ? "dark" : "light");

  return (
    <View style={[styles.boot, { backgroundColor: tokens.bg }]}>
      <StatusBar style={systemScheme === "dark" ? "light" : "dark"} />
      {state.phase === "loading" ? (
        <>
          <View
            style={[
              styles.bootOrb,
              { backgroundColor: tokens.accentSoft, borderColor: tokens.cardBorder },
            ]}
          >
            <ActivityIndicator color={tokens.accent} />
          </View>
          <Text style={[styles.bootTitle, { color: tokens.text }]}>TaskDock</Text>
          <Text style={[styles.bootText, { color: tokens.muted }]}>正在打开本地数据…</Text>
        </>
      ) : null}

      {state.phase === "error" ? (
        <>
          <Text style={[styles.errorTitle, { color: tokens.danger }]}>本地数据库打开失败</Text>
          <Text style={[styles.errorBody, { color: tokens.textSoft }]}>{state.message}</Text>
          <Text style={[styles.errorHint, { color: tokens.muted }]}>
            请重启应用；若反复出现，检查设备存储是否可写、剩余空间是否充足。
          </Text>
        </>
      ) : null}
    </View>
  );
}

export default function App() {
  const [boot, setBoot] = useState<BootState>({ phase: "loading" });

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

  if (boot.phase !== "ready") {
    return <BootView state={boot} />;
  }

  return (
    <ThemeProvider initialMode={boot.mode}>
      <MotionProvider>
        <Shell />
      </MotionProvider>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1 },
  fill: { flex: 1 },
  boot: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    padding: space.xl,
  },
  bootOrb: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.sm,
  },
  bootTitle: {
    fontSize: font.display,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  bootText: {
    fontSize: font.meta,
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
