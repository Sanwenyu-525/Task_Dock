// 本地通知：只负责「手机侧」提醒，与桌面端提醒需按 (task_id, 发生次, 设备) 去重（联动模式接入后实现）。
// 用默认精度排期，不申请 SCHEDULE_EXACT_ALARM：精确定时属敏感权限，且 Android 16 上仍可能被延后。
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

export const REMINDER_CHANNEL_ID = "task-reminders";

/** 提醒通知上的动作按钮：动作 id 会原样回传给响应监听器 */
export const REMINDER_CATEGORY_ID = "task-reminder-actions";
/** 关闭「10 分钟后」动作时使用的类别：只有「完成」按钮 */
export const REMINDER_CATEGORY_ID_BASIC = "task-reminder-basic";
export const REMINDER_ACTION_COMPLETE = "complete";
export const REMINDER_ACTION_SNOOZE = "snooze";
export const SNOOZE_MINUTES = 10;

/**
 * 注册动作按钮。进程内只做一次；失败时清掉缓存，下次排期还能重试。
 * 必须在排期之前注册，否则系统不认识 categoryIdentifier，通知上没有按钮。
 * 两个类别一起注册：完整版（完成 + 10 分钟后）与基础版（仅完成），
 * 排期时按用户开关选择类别（见 scheduleReminder 的 snooze 参数）。
 */
let categoryReady: Promise<void> | null = null;

export function ensureReminderCategory(): Promise<void> {
  if (!categoryReady) {
    categoryReady = Promise.all([
      Notifications.setNotificationCategoryAsync(REMINDER_CATEGORY_ID, [
        { identifier: REMINDER_ACTION_COMPLETE, buttonTitle: "完成" },
        { identifier: REMINDER_ACTION_SNOOZE, buttonTitle: `${SNOOZE_MINUTES} 分钟后` },
      ]),
      Notifications.setNotificationCategoryAsync(REMINDER_CATEGORY_ID_BASIC, [
        { identifier: REMINDER_ACTION_COMPLETE, buttonTitle: "完成" },
      ]),
    ])
      .then(() => undefined)
      .catch((error: unknown) => {
        categoryReady = null;
        throw error;
      });
  }
  return categoryReady;
}

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
  /** false = 用基础类别（只有「完成」按钮）；开关变化只影响之后排期的提醒 */
  snoozeEnabled = true,
): Promise<boolean> {
  if (atMs <= Date.now()) return false;
  const granted = await ensurePermission();
  if (!granted) return false;

  // 动作按钮注册失败不影响「到点弹通知」，因此不让它拦住排期
  await ensureReminderCategory().catch(() => undefined);

  await Notifications.scheduleNotificationAsync({
    identifier: reminderId(taskId),
    content: {
      title: "TaskDock",
      body: title,
      sound: false,
      categoryIdentifier: snoozeEnabled ? REMINDER_CATEGORY_ID : REMINDER_CATEGORY_ID_BASIC,
      // 动作处理器靠 data.taskId 找到要操作的任务（不解析通知 id 字符串）
      data: { kind: "task-reminder", taskId },
    },
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

/**
 * 系统侧仍存在的已排期通知 id 集合。
 *
 * 用于对账：`reminder_schedule` 只是「我们排过」的记录，重启/应用更新/被系统
 * 清理后系统可能已经丢掉这些闹钟。只信本地记录会让提醒永远不再触发，
 * 所以每次对账都要拿系统现状核对一遍。
 */
export async function listScheduledNotificationIds(): Promise<Set<string>> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  return new Set(scheduled.map((item) => item.identifier));
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
