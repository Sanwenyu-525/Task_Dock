// expo-notifications 的 node 测试替身：仅满足模块导入链（reminders.ts）。
// 提醒引擎的行为测试通过 vi.mock 掉 notifications/reminderEngine 完成，
// 这里只是让「导入不炸」，不模拟通知语义。
export const setNotificationChannelAsync = async (): Promise<void> => undefined;
export const getPermissionsAsync = async (): Promise<{ granted: boolean; canAskAgain: boolean }> => ({
  granted: false,
  canAskAgain: true,
});
export const requestPermissionsAsync = async (): Promise<{ granted: boolean; canAskAgain: boolean }> => ({
  granted: false,
  canAskAgain: true,
});
export const getAllScheduledNotificationsAsync = async (): Promise<unknown[]> => [];
export const cancelScheduledNotificationAsync = async (): Promise<void> => undefined;
export const scheduleNotificationAsync = async (): Promise<string> => "test-notification";
export const setNotificationHandler = (): void => undefined;
