// 本地通知：只负责「手机侧」提醒，与桌面端提醒需按 (task_id, 发生次, 设备) 去重（联动模式接入后实现）。
// 用默认精度排期，不申请 SCHEDULE_EXACT_ALARM：精确定时属敏感权限，且 Android 16 上仍可能被延后。
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

export const REMINDER_CHANNEL_ID = "task-reminders";

/** 用任务 id 派生通知 id，重复排期自动覆盖，取消时无需额外映射表 */
export const reminderId = (taskId: string): string => `remind-${taskId}`;

export function installNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
    name: "任务提醒",
    importance: Notifications.AndroidImportance.DEFAULT,
    sound: null,
  });
}

export async function ensurePermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) {
    await ensureChannel();
    return true;
  }
  if (!current.canAskAgain) return false;
  const asked = await Notifications.requestPermissionsAsync();
  if (asked.granted) await ensureChannel();
  return asked.granted;
}

export async function getPermissionLabel(): Promise<string> {
  const status = await Notifications.getPermissionsAsync();
  if (status.granted) return "已允许";
  if (!status.canAskAgain) return "已拒绝（需在系统设置中开启）";
  return "未授权";
}

export async function scheduleReminder(
  taskId: string,
  title: string,
  atMs: number,
): Promise<boolean> {
  if (atMs <= Date.now()) return false;
  const granted = await ensurePermission();
  if (!granted) return false;

  await Notifications.scheduleNotificationAsync({
    identifier: reminderId(taskId),
    content: { title: "TaskDock", body: title, sound: false },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: new Date(atMs),
      channelId: REMINDER_CHANNEL_ID,
    },
  });
  return true;
}

export async function cancelReminder(taskId: string): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(reminderId(taskId));
  } catch {
    // 该任务本来没排期，取消失败无需上报
  }
}

/** 设置页的「发一条测试通知」，用于确认系统开关与通道是否真的生效 */
export async function sendTestNotification(): Promise<boolean> {
  const granted = await ensurePermission();
  if (!granted) return false;
  await Notifications.scheduleNotificationAsync({
    content: { title: "TaskDock", body: "本地通知已可用", sound: false },
    trigger: null,
  });
  return true;
}
