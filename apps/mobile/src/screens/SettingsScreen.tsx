// 设置页：主题三态用带预览的分段控件，通知权限用颜色+文案区分状态。
// 权限文案来自 getPermissionLabel()（数据层只暴露展示文案，这里按前缀映射色调）。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Badge } from "../components/Badge";
import { GlassCard } from "../components/GlassCard";
import { SegmentedControl, type SegmentOption } from "../components/SegmentedControl";
import { SettingActionRow } from "../components/SettingActionRow";
import { StatCard } from "../components/StatCard";
import { Toast, type ToastMessage, type ToastTone } from "../components/Toast";
import { listCaptures } from "../db/captures";
import { loadConnection, type PairedConnection } from "../db/syncConnection";
import { listTasks } from "../db/tasks";
import { describeError } from "../lib/errors";
import type { Nav } from "../lib/nav";
import {
  ensurePermission,
  getPermissionLabel,
  sendTestNotification,
} from "../notifications/reminders";
import { useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { font, palette, radius, space, type ThemeMode } from "../theme/tokens";

const MODES: SegmentOption<ThemeMode>[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

type PermissionTone = "ok" | "warn" | "danger";

/** 数据层只给「已允许 / 未授权 / 已拒绝（需在系统设置中开启）」三种文案 */
function permissionTone(label: string): PermissionTone {
  if (label.startsWith("已允许")) return "ok";
  if (label.includes("拒绝")) return "danger";
  return "warn";
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { tokens } = useTheme();
  return (
    <GlassCard style={styles.section}>
      <View style={styles.sectionHead}>
        <View style={[styles.sectionBar, { backgroundColor: tokens.accent }]} />
        <Text accessibilityRole="header" style={[styles.sectionTitle, { color: tokens.text }]}>
          {title}
        </Text>
      </View>
      {children}
    </GlassCard>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  const { tokens } = useTheme();
  return (
    <View style={styles.line}>
      <Text style={[styles.lineLabel, { color: tokens.muted }]}>{label}</Text>
      <Text style={[styles.lineValue, { color: tokens.text }]}>{value}</Text>
    </View>
  );
}

/** 主题预览：直接取对应模式的真实调色板，避免「预览色」和实际界面是两套值 */
function ThemePreview({ mode }: { mode: ThemeMode }) {
  const light = palette("light");
  const dark = palette("dark");

  if (mode === "system") {
    return (
      <View style={[styles.swatch, { borderColor: light.cardBorder }]}>
        <View style={styles.splitRow}>
          <View style={[styles.splitHalf, { backgroundColor: light.bg }]}>
            <View style={[styles.splitCard, { backgroundColor: light.cardSolid }]} />
          </View>
          <View style={[styles.splitHalf, { backgroundColor: dark.bg }]}>
            <View style={[styles.splitCard, { backgroundColor: dark.cardSolid }]} />
          </View>
        </View>
      </View>
    );
  }

  const tone = mode === "light" ? light : dark;
  return (
    <View style={[styles.swatch, { backgroundColor: tone.bg, borderColor: tone.cardBorder }]}>
      <View
        style={[
          styles.swatchCard,
          { backgroundColor: tone.cardSolid, borderColor: tone.cardBorder },
        ]}
      />
      <View style={[styles.swatchDot, { backgroundColor: tone.accentFill }]} />
    </View>
  );
}

export function SettingsScreen({ nav, version = 0 }: { nav: Nav; version?: number }) {
  const { tokens, mode, setMode } = useTheme();
  const reduceMotion = useReduceMotion();
  const [summary, setSummary] = useState({ tasks: 0, captures: 0, completed: 0 });
  const [syncConnection, setSyncConnection] = useState<PairedConnection | null>(null);
  const [permissionLabel, setPermissionLabel] = useState("读取中…");
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSeq = useRef(0);

  const showToast = useCallback((text: string, tone: ToastTone = "info") => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text, tone });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  const refresh = useCallback(async () => {
    try {
      const [tasks, captures, label, connection] = await Promise.all([
        listTasks(),
        listCaptures(),
        getPermissionLabel(),
        // 连接元数据读取失败不应把整页汇总拖失败：按未配对展示。
        loadConnection().catch(() => null),
      ]);
      setSummary({
        tasks: tasks.length,
        captures: captures.length,
        completed: tasks.filter((task) => task.status === "completed").length,
      });
      setPermissionLabel(label);
      setSyncConnection(connection);
    } catch (error) {
      showToast(`读取设置失败：${describeError(error)}`, "danger");
    }
  }, [showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh, version]);

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

  const tone = permissionTone(permissionLabel);
  const toneColor = tone === "ok" ? tokens.ok : tone === "danger" ? tokens.danger : tokens.warn;
  const toneBg =
    tone === "ok" ? tokens.okSoft : tone === "danger" ? tokens.dangerSoft : tokens.warnSoft;

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.titleBlock}>
          <Text accessibilityRole="header" style={[styles.title, { color: tokens.text }]}>
            设置
          </Text>
          <Text style={[styles.subtitle, { color: tokens.muted }]}>外观、提醒与本地数据</Text>
        </View>

        <View style={styles.tiles}>
          <StatCard label="任务" value={summary.tasks} tone="accent" />
          <StatCard label="收集" value={summary.captures} tone="neutral" />
          <StatCard label="已完成" value={summary.completed} tone="ok" />
        </View>

        <Section title="外观">
          <SegmentedControl
            options={MODES}
            value={mode}
            onChange={setMode}
            accessibilityLabel="主题模式"
            renderSegment={(option, selected) => (
              <View style={styles.segment}>
                <ThemePreview mode={option.value} />
                <Text
                  numberOfLines={1}
                  style={[
                    styles.segmentLabel,
                    { color: selected ? tokens.text : tokens.muted },
                    selected ? styles.segmentLabelActive : null,
                  ]}
                >
                  {option.label}
                </Text>
              </View>
            )}
          />
          <View style={styles.noteRow}>
            <View
              style={[styles.noteDot, { backgroundColor: reduceMotion ? tokens.ok : tokens.faint }]}
            />
            <Text style={[styles.note, { color: tokens.muted }]}>
              {reduceMotion
                ? "已跟随系统「减少动态效果」：位移与弹簧动画已关闭"
                : "系统开启「减少动态效果」时，本应用会自动改用直接呈现"}
            </Text>
          </View>
        </Section>

        <Section title="提醒">
          <View style={styles.permissionRow}>
            <Text style={[styles.lineLabel, { color: tokens.muted }]}>系统通知权限</Text>
            <View style={[styles.statusPill, { backgroundColor: toneBg }]}>
              <View style={[styles.statusDot, { backgroundColor: toneColor }]} />
              <Text style={[styles.statusText, { color: toneColor }]}>{permissionLabel}</Text>
            </View>
          </View>

          {tone === "warn" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="请求通知权限"
              accessibilityHint="请求系统通知权限，用于任务提醒"
              onPress={() => void requestPermission()}
              style={({ pressed }) => [
                styles.primaryButton,
                { backgroundColor: tokens.accentFill, opacity: pressed ? 0.8 : 1 },
              ]}
            >
              <Text style={[styles.primaryText, { color: tokens.onAccent }]}>开启通知权限</Text>
            </Pressable>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="发送测试通知"
            onPress={() => void testNotification()}
            style={({ pressed }) => [
              styles.ghostButton,
              { borderColor: tokens.cardBorder, opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <Text style={[styles.ghostText, { color: tokens.accent }]}>发送测试通知</Text>
          </Pressable>
          {tone === "danger" ? (
            <Text style={[styles.hint, { color: tokens.danger }]}>
              系统已不再弹出授权框：请到「设置 → 应用 → TaskDock → 通知」手动开启。
            </Text>
          ) : null}
          <Text style={[styles.hint, { color: tokens.muted }]}>
            提醒使用系统本地通知，不依赖桌面端；权限关闭时任务照常保存，只是到点不提醒。
          </Text>
          <SettingActionRow
            label="通知与后台"
            helper="权限、提醒动作与 vivo 后台限制"
            chevron
            onPress={() => nav.push("notifications")}
          />
        </Section>

        <Section title="手机与同步">
          <SettingActionRow
            label="配对新设备"
            helper={
              syncConnection
                ? `已配对：${syncConnection.serverName}`
                : "与桌面端在同一 Wi-Fi 下扫码或输码配对"
            }
            trailing={syncConnection ? <Badge label="已配对" tone="active" /> : undefined}
            chevron
            accessibilityHint="打开配对页，扫描桌面端二维码或手动输入配对码"
            onPress={() => nav.push("pairing")}
          />
          <SettingActionRow
            label="同步"
            helper="查看已配对连接、测试连通性与解除本机配对"
            trailing={syncConnection ? <Badge label="已连接" tone="active" /> : undefined}
            chevron
            accessibilityHint="同步中心：连接状态与后续数据同步"
            onPress={() => nav.push("sync")}
          />
          <SettingActionRow
            label="主屏小组件"
            trailing={<Badge label="规划中" />}
            chevron
            accessibilityHint="桌面小组件配置（规划中）"
            onPress={() => nav.push("widget")}
          />
          <SettingActionRow
            label="分享接收"
            trailing={<Badge label="规划中" />}
            chevron
            accessibilityHint="系统分享到 TaskDock（规划中）"
            onPress={() => nav.push("share")}
          />
        </Section>

        <Section title="本地数据">
          <Text style={[styles.hint, { color: tokens.muted }]}>
            当前为独立模式：所有写操作只落在本机，操作队列等待桌面端配对后消费。
          </Text>
        </Section>

        <Section title="关于">
          {/* 版本号与 app.json 的 version 保持同步；升级版本时两处一起改 */}
          <InfoRow label="版本" value="0.1.3" />
          <InfoRow label="后端" value="本地 SQLite" />
          <InfoRow label="数据范围" value="只在本机" />
        </Section>
      </ScrollView>

      <Toast toast={toast} onDismiss={dismissToast} bottomOffset={space.lg} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: 44,
    gap: space.md,
  },
  titleBlock: { gap: 1, marginBottom: space.xs },
  title: { fontSize: font.display, fontWeight: "800", letterSpacing: -0.8 },
  subtitle: { fontSize: font.meta },
  tiles: {
    flexDirection: "row",
    gap: space.sm,
    marginBottom: space.xs,
  },
  section: {
    padding: space.md + 2,
    gap: space.sm,
  },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  sectionBar: {
    width: 3,
    height: 14,
    borderRadius: 2,
  },
  sectionTitle: { fontSize: font.title, fontWeight: "700" },
  segment: {
    alignItems: "center",
    gap: 5,
    paddingVertical: space.xxs,
  },
  segmentLabel: {
    fontSize: font.label,
    fontWeight: "600",
  },
  segmentLabelActive: { fontWeight: "700" },
  // 预览块尺寸固定，三种模式对齐；颜色取自真实调色板
  swatch: {
    width: 46,
    height: 26,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  swatchCard: {
    position: "absolute",
    left: 6,
    right: 6,
    top: 6,
    height: 8,
    borderRadius: 3,
    borderWidth: StyleSheet.hairlineWidth,
  },
  swatchDot: {
    position: "absolute",
    right: 6,
    bottom: 5,
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  splitRow: { flexDirection: "row", flex: 1 },
  splitHalf: { flex: 1, justifyContent: "flex-start", paddingTop: 6, alignItems: "center" },
  splitCard: { width: "70%", height: 8, borderRadius: 3 },
  noteRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    paddingTop: space.xs,
  },
  noteDot: { width: 5, height: 5, borderRadius: 3, marginTop: 6 },
  note: { flex: 1, fontSize: font.label, lineHeight: 16 },
  permissionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.chip,
    flexShrink: 1,
  },
  statusDot: { width: 5, height: 5, borderRadius: 3 },
  statusText: { flexShrink: 1, fontSize: font.label, fontWeight: "600" },
  primaryButton: {
    marginTop: space.xs,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
  },
  primaryText: { fontSize: font.title, fontWeight: "600" },
  ghostButton: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
  },
  ghostText: { fontSize: font.title, fontWeight: "600" },
  line: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: space.md,
    minHeight: 26,
  },
  lineLabel: { fontSize: font.body },
  lineValue: {
    fontSize: font.body,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
    textAlign: "right",
    flexShrink: 1,
  },
  hint: { fontSize: font.label, lineHeight: 16 },
});
