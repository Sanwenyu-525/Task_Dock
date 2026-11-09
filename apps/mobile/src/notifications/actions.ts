// 通知动作处理：提醒通知上的「完成」「10 分钟后」。
//
// 独立模式下动作直接写本地库，并且必须走与界面完全相同的数据层路径
// （toggleTask / updateTask），否则「完成重复任务」会出现两套期次推进实现，
// 迟早一边推进、一边不推进。
import * as Notifications from "expo-notifications";

import { getSetting } from "../db/kv";
import { getTask, toggleTask, updateTask } from "../db/tasks";
import { rescheduleAllReminders } from "./reminderEngine";
import {
  cancelReminder,
  REMINDER_ACTION_COMPLETE,
  REMINDER_ACTION_SNOOZE,
  SNOOZE_MINUTES,
} from "./reminders";

/** 「完成后收起通知」开关的 kv 键（通知与后台页维护），默认开启 */
const DISMISS_SETTING_KEY = "reminder_dismiss_on_complete";

/** 冷启动补处理的时间窗（秒）：太久以前的响应直接丢弃，避免重放一次「完成」 */
const COLD_START_WINDOW_SECONDS = 10 * 60;
/** 去重集合上限：长期运行不累积 */
const HANDLED_LIMIT = 128;

/** 同一次交互可能同时来自监听器与冷启动读取，必须去重（重复「完成」会多推进一期） */
const handled = new Set<string>();

function responseKey(response: Notifications.NotificationResponse): string {
  const request = response.notification.request;
  return `${request.identifier}|${response.actionIdentifier}|${response.notification.date}`;
}

function taskIdOf(response: Notifications.NotificationResponse): string | null {
  const data = response.notification.request.content.data;
  const taskId = data?.taskId;
  return typeof taskId === "string" && taskId.length > 0 ? taskId : null;
}

/**
 * 动作点掉后把通知从通知栏移除。
 * Android 的动作按钮不像正文点击那样带 AUTO_CANCEL：真机实测点「完成」后任务已完成，
 * 通知却还挂在通知栏里，用户会以为没生效、再点一次。
 */
async function dismissNotification(response: Notifications.NotificationResponse): Promise<void> {
  try {
    await Notifications.dismissNotificationAsync(response.notification.request.identifier);
  } catch {
    // 通知可能已被系统或用户清掉，无需上报
  }
}

export async function handleNotificationResponse(
  response: Notifications.NotificationResponse,
): Promise<void> {
  const taskId = taskIdOf(response);
  if (!taskId) return;

  const key = responseKey(response);
  if (handled.has(key)) return;
  if (handled.size >= HANDLED_LIMIT) handled.clear();
  handled.add(key);

  const isReminderAction =
    response.actionIdentifier === REMINDER_ACTION_COMPLETE ||
    response.actionIdentifier === REMINDER_ACTION_SNOOZE;

  try {
    if (response.actionIdentifier === REMINDER_ACTION_COMPLETE) {
      const task = await getTask(taskId);
      // 只在仍待办时完成：用户可能已经在应用里处理过这条
      if (!task || task.status !== "pending") return;
      const outcome = await toggleTask(taskId);
      // 重复任务：期次被推进，需要按新 remind_at 重排；普通任务：直接撤掉通知
      if (outcome.advanced) await rescheduleAllReminders();
      else await cancelReminder(taskId);
      return;
    }

    if (response.actionIdentifier === REMINDER_ACTION_SNOOZE) {
      // 改 remind_at 而不是只排一条新通知：否则下一次全局对账会把延后条目的
      // 旧排期当成「不需要」清掉，用户刚点的延后立刻失效。
      await updateTask(taskId, { remindAt: Date.now() + SNOOZE_MINUTES * 60_000 });
      await rescheduleAllReminders();
    }
  } finally {
    // 无论成功、失败还是任务已处理过，都按用户开关决定是否收起这条通知。
    // 关闭「完成后收起通知」时保留在通知栏里，方便回看刚完成的内容。
    if (isReminderAction) {
      const dismissRaw = await getSetting(DISMISS_SETTING_KEY).catch(() => null);
      if (dismissRaw !== "0") await dismissNotification(response);
    }
  }
}

/**
 * 注册通知交互监听，并在应用启动时补处理「把应用打开的那次点击」。
 * `onHandled` 在动作真正落库后触发，用于让界面重新拉数据。
 * 返回取消订阅函数，调用方（Shell）卸载时释放，避免重复监听导致一次操作执行多次。
 */
export function subscribeReminderActions(onHandled?: () => void): () => void {
  const run = async (response: Notifications.NotificationResponse): Promise<void> => {
    try {
      await handleNotificationResponse(response);
      onHandled?.();
    } catch {
      // 动作失败不能把应用带崩：通知已被用户点掉，下次对账会修正排期
    }
  };

  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    void run(response);
  });

  void (async () => {
    try {
      const last = Notifications.getLastNotificationResponse();
      if (!last) return;
      const ageSeconds = Date.now() / 1000 - last.notification.date;
      // date 是通知投递时间（秒）；负值说明设备时钟被回拨，按「刚发生」处理
      if (ageSeconds < 0 || ageSeconds <= COLD_START_WINDOW_SECONDS) {
        await run(last);
      }
      Notifications.clearLastNotificationResponse();
    } catch {
      // 通知是增强能力：读取失败不影响界面启动
    }
  })();

  return () => subscription.remove();
}
