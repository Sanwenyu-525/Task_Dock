// 通知与后台：本地通知能力是真实的（权限/测试通知/提醒动作开关），
// 远程推送未实现、后台同步属规划——两节明确标注，不给可用的假开关。
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { AppBar } from "../components/AppBar";
import { Badge } from "../components/Badge";
import { PressableScale } from "../components/PressableScale";
import { SettingActionRow } from "../components/SettingActionRow";
import { SettingRow } from "../components/SettingRow";
import { SettingSection } from "../components/SettingSection";
import { StatusPill, type StatusTone } from "../components/StatusPill";
import { ToggleSwitch } from "../components/ToggleSwitch";
import { Toast, type ToastMessage, type ToastTone } from "../components/Toast";
import { getSetting, setSetting } from "../db/kv";
import { describeError } from "../lib/errors";
import type { Nav } from "../lib/nav";
import {
  ensurePermission,
  getPermissionLabel,
  sendTestNotification,
} from "../notifications/reminders";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

/** kv 键与默认值：默认行为与历史版本一致（收起=开，10 分钟动作=开） */
const KEY_DISMISS_ON_COMPLETE = "reminder_dismiss_on_complete";
const KEY_SNOOZE_ENABLED = "reminder_snooze_enabled";
const DEFAULT_ON = "1";

/** 数据层只给「已允许 / 未授权 / 已拒绝（需在系统设置中开启）」三种文案 */
function permissionTone(label: string): StatusTone {
  if (label.startsWith("已允许")) return "ok";
  if (label.includes("拒绝")) return "danger";
  return "warn";
}

export function NotificationsScreen({ nav }: { nav: Nav }) {
  const { tokens } = useTheme();
  const [permissionLabel, setPermissionLabel] = useState("读取中…");
  const [dismissOnComplete, setDismissOnComplete] = useState(true);
  const [snoozeEnabled, setSnoozeEnabled] = useState(true);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSeq = useRef(0);

  const showToast = useCallback((text: string, tone: ToastTone = "info") => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text, tone });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  const refresh = useCallback(async () => {
    try {
      const [label, dismissRaw, snoozeRaw] = await Promise.all([
        getPermissionLabel(),
        getSetting(KEY_DISMISS_ON_COMPLETE),
        getSetting(KEY_SNOOZE_ENABLED),
      ]);
      setPermissionLabel(label);
      setDismissOnComplete(dismissRaw !== "0");
      setSnoozeEnabled(snoozeRaw !== "0");
    } catch (error) {
      showToast(`读取通知设置失败：${describeError(error)}`, "danger");
    }
  }, [showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const requestPermission = useCallback(async () => {
    const granted = await ensurePermission();
    showToast(
      granted ? "通知权限已开启" : "仍未获得权限，可在系统设置中手动开启",
      granted ? "success" : "warn",
    );
    await refresh();
  }, [refresh, showToast]);

  const testNotification = useCallback(async () => {
    const sent = await sendTestNotification();
    showToast(
      sent ? "已发送测试通知，稍后应看到系统提示" : "通知权限未开启，无法发送",
      sent ? "success" : "warn",
    );
    await refresh();
  }, [refresh, showToast]);

  const saveFlag = useCallback(
    async (key: string, value: boolean, apply: (next: boolean) => void, label: string) => {
      const previous = value;
      apply(value);
      try {
        await setSetting(key, value ? DEFAULT_ON : "0");
      } catch (error) {
        apply(previous);
        showToast(`保存失败：${describeError(error)}`, "danger");
        return;
      }
      showToast(`${label}已${value ? "开启" : "关闭"}；对之后排期的提醒生效`);
    },
    [showToast],
  );

  const tone = permissionTone(permissionLabel);

  return (
    <View style={styles.container}>
      {/* 顶栏固定在滚动容器外：滚动后返回箭头不能跟着滚走（真机实测会被滚出屏幕） */}
      <AppBar title="通知与后台" onBack={nav.back} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <SettingSection title="通知权限">
          <View style={styles.statusRow}>
            <Text style={[styles.statusLabel, { color: tokens.muted }]}>系统通知权限</Text>
            <StatusPill label={permissionLabel} tone={tone} />
          </View>
          {tone === "warn" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="请求通知权限"
              onPress={() => void requestPermission()}
              style={({ pressed }) => [
                styles.primary,
                { backgroundColor: tokens.accentFill, opacity: pressed ? 0.8 : 1 },
              ]}
            >
              <Text style={[styles.primaryText, { color: tokens.onAccent }]}>开启通知权限</Text>
            </Pressable>
          ) : null}
          <SettingRow label="提醒精度" value="默认（约 7.5 分钟）" valueTone="muted" />
          <PressableScale
            onPress={() => void testNotification()}
            accessibilityLabel="发送测试通知"
            contentStyle={[styles.ghost, { borderColor: tokens.cardBorder }]}
          >
            <Text style={[styles.ghostText, { color: tokens.accent }]}>发送测试通知</Text>
          </PressableScale>
        </SettingSection>

        <SettingSection title="提醒动作">
          <SettingActionRow
            label="完成后收起通知"
            helper="在通知上点「完成」后，把这条通知从通知栏收起"
            trailing={
              <ToggleSwitch
                value={dismissOnComplete}
                onChange={(next) =>
                  void saveFlag(KEY_DISMISS_ON_COMPLETE, next, setDismissOnComplete, "完成后收起通知")
                }
                accessibilityLabel="完成后收起通知"
              />
            }
          />
          <SettingActionRow
            label="「10 分钟后」动作"
            helper="提醒通知上提供一键延后 10 分钟"
            trailing={
              <ToggleSwitch
                value={snoozeEnabled}
                onChange={(next) =>
                  void saveFlag(KEY_SNOOZE_ENABLED, next, setSnoozeEnabled, "「10 分钟后」动作")
                }
                accessibilityLabel="10 分钟后动作"
              />
            }
          />
        </SettingSection>

        {/* vivo 后台策略是已知的厂商限制（docs/mobile/04 §6），如实呈现而不是隐藏 */}
        <View style={[styles.warning, { backgroundColor: tokens.warnSoft }]}>
          <Text style={[styles.warningTitle, { color: tokens.warn }]}>
            vivo 后台策略可能延迟提醒
          </Text>
          <Text style={[styles.warningBody, { color: tokens.textSoft }]}>
            应用被系统清理后提醒可能不投递。可在系统设置中允许后台运行。
          </Text>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel="去系统设置允许后台运行"
            onPress={() => void Linking.openSettings().catch(() => undefined)}
            style={({ pressed }) => [styles.linkRow, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={[styles.linkText, { color: tokens.accent }]}>去设置允许后台运行 →</Text>
          </Pressable>
        </View>

        <SettingSection title="远程推送" trailing={<Badge label="未实现" tone="unimplemented" />}>
          <SettingActionRow
            label="远程推送"
            helper="需要厂商推送账号与中继服务，当前未接入"
            trailing={
              <ToggleSwitch
                value={false}
                onChange={() => undefined}
                disabled
                accessibilityLabel="远程推送（未实现）"
              />
            }
          />
          <SettingRow label="推送服务" value="未配置" valueTone="muted" />
        </SettingSection>

        <SettingSection title="后台同步" trailing={<Badge label="规划中" />}>
          <SettingActionRow
            label="后台同步"
            helper="仅在有待同步内容且已配对时运行，完成后注销；随同步能力一起提供"
            trailing={
              <ToggleSwitch
                value={false}
                onChange={() => undefined}
                disabled
                accessibilityLabel="后台同步（规划中）"
              />
            }
          />
        </SettingSection>

        <Text style={[styles.footer, { color: tokens.faint }]}>
          本机提醒使用系统本地通知；跨网络推送是另一套通道。
        </Text>
      </ScrollView>

      <Toast toast={toast} onDismiss={dismissToast} bottomOffset={space.xl} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    paddingBottom: 48,
    paddingHorizontal: space.lg,
    gap: space.md,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
  },
  statusLabel: {
    fontSize: font.body,
  },
  primary: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
    marginTop: space.xs,
  },
  primaryText: {
    fontSize: font.title,
    fontWeight: "600",
  },
  ghost: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
  },
  ghostText: {
    fontSize: font.title,
    fontWeight: "600",
  },
  warning: {
    padding: space.md,
    borderRadius: radius.row,
    gap: space.xs,
  },
  warningTitle: {
    fontSize: font.body,
    fontWeight: "700",
  },
  warningBody: {
    fontSize: font.body,
    lineHeight: 19,
  },
  linkRow: {
    minHeight: 44,
    justifyContent: "center",
  },
  linkText: {
    fontSize: font.body,
    fontWeight: "600",
  },
  footer: {
    fontSize: font.label,
    lineHeight: 16,
    textAlign: "center",
    paddingHorizontal: space.sm,
  },
});
