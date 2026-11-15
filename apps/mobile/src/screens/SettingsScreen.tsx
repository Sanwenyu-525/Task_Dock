// 设置页：主题三态、减少动态说明、本地数据与关于。
// 通知权限/测试通知/提醒动作的唯一管理界面是「我的 → 通知」NotificationsScreen；
// 本页不重复放同一套权限控制，只保留「已排期提醒」这类本机数据读数。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import appConfig from "../../app.json";
import { BackButton } from "../components/BackButton";
import { GlassCard } from "../components/GlassCard";
import { SegmentedControl, type SegmentOption } from "../components/SegmentedControl";
import { MetricTile } from "../components/MetricTile";
import { AppIcon, type IconName } from "../components/icons/AppIcon";
import { Toast, type ToastMessage, type ToastTone } from "../components/Toast";
import { listCaptures } from "../db/captures";
import { listReminderSchedules } from "../db/reminderSchedule";
import { SCHEMA_VERSION } from "../db/schema";
import { loadConnection, type PairedConnection } from "../db/syncConnection";
import { countPendingOutbox, listTasks } from "../db/tasks";
import { describeError } from "../lib/errors";
import { isLegacyConnection } from "../lib/sync/connectionState";
import { useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { font, palette, space, type ThemeMode } from "../theme/tokens";

const MODES: SegmentOption<ThemeMode>[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

function Section({
  icon,
  title,
  children,
}: {
  icon: IconName;
  title: string;
  children: ReactNode;
}) {
  const { tokens } = useTheme();
  return (
    <GlassCard style={styles.section}>
      <View style={styles.sectionHead}>
        <View style={[styles.sectionIcon, { backgroundColor: tokens.accentSoft }]}>
          <AppIcon name={icon} size={14} color={tokens.accent} />
        </View>
        <Text accessibilityRole="header" style={[styles.sectionTitle, { color: tokens.text }]}>
          {title}
        </Text>
        {/* 节标题右侧拉一条 hairline 收尾：与任务分组头同一套「标题 + 细线」节奏 */}
        <View style={[styles.sectionRule, { backgroundColor: tokens.separator }]} />
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

export function SettingsScreen({
  version = 0,
  onBack,
}: {
  version?: number;
  /** 从「我的」进入时的返回；一级栏时代不传 */
  onBack?: () => void;
}) {
  const { tokens, mode, setMode } = useTheme();
  const reduceMotion = useReduceMotion();
  const [summary, setSummary] = useState({ tasks: 0, captures: 0, completed: 0 });
  const [pendingOps, setPendingOps] = useState(0);
  const [scheduledReminders, setScheduledReminders] = useState(0);
  const [syncConnection, setSyncConnection] = useState<PairedConnection | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSeq = useRef(0);

  const showToast = useCallback((text: string, tone: ToastTone = "info") => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text, tone });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  const refresh = useCallback(async () => {
    try {
      const [tasks, captures, connection, pending, schedules] = await Promise.all([
        listTasks(),
        listCaptures(),
        // 连接元数据读取失败不应把整页汇总拖失败：按未配对展示。
        loadConnection().catch(() => null),
        // 摘要区不能因为一条统计失败就整页降级
        countPendingOutbox().catch(() => 0),
        listReminderSchedules().catch(() => []),
      ]);
      setSummary({
        tasks: tasks.length,
        captures: captures.length,
        completed: tasks.filter((task) => task.status === "completed").length,
      });
      setPendingOps(pending);
      setScheduledReminders(
        schedules.filter((entry) => entry.occurrenceAt >= Date.now()).length,
      );
      setSyncConnection(connection);
    } catch (error) {
      showToast(`读取设置失败：${describeError(error)}`, "danger");
    }
  }, [showToast]);

  useEffect(() => {
    void refresh();
  }, [refresh, version]);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.headerRow}>
          {onBack ? <BackButton onPress={onBack} /> : null}
          <View style={styles.titleBlock}>
            <Text accessibilityRole="header" style={[styles.title, { color: tokens.text }]}>
              设置
            </Text>
            <Text numberOfLines={1} style={[styles.subtitle, { color: tokens.muted }]}>
              {syncConnection && isLegacyConnection(syncConnection)
                ? `需重新配对 ${syncConnection.serverName} · 桌面端已升级加密传输`
                : syncConnection
                  ? `已配对 ${syncConnection.serverName} · 任务/笔记/收集箱可手动同步`
                  : "未连接桌面端 · 数据仅在本机"}
            </Text>
          </View>
        </View>

        {/* 与首页效率概览同一形态：一张卡三段，不再各占一张白卡 */}
        <GlassCard style={styles.tiles}>
          <View style={styles.tilesRow}>
            <MetricTile variant="column" icon="tasks" label="任务" value={summary.tasks} tone="accent" />
            <View style={[styles.tileDivider, { backgroundColor: tokens.separator }]} />
            <MetricTile variant="column" icon="inbox" label="收集" value={summary.captures} />
            <View style={[styles.tileDivider, { backgroundColor: tokens.separator }]} />
            <MetricTile
              variant="column"
              icon="success"
              label="已完成"
              value={summary.completed}
              tone="ok"
            />
          </View>
        </GlassCard>

        <Section icon="sparkles" title="外观">
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

        <Section icon="database" title="本地数据">
          {/* 对齐原型：这一节给真实的本地数据读数，而不是一段泛化说明 */}
          <InfoRow label="数据库" value={`SQLite v${SCHEMA_VERSION} · WAL`} />
          <InfoRow label="已排期提醒" value={`${scheduledReminders} 条`} />
          <InfoRow label="本地待发操作" value={`${pendingOps} 条`} />
          <Text style={[styles.hint, { color: tokens.muted }]}>
            写操作先落本机并记入队列；同步会消费任务、笔记与收集箱操作。
          </Text>
        </Section>

        <Section icon="info" title="关于">
          {/* 版本号直接读 app.json，避免每轮发版后忘记同步这里的文案 */}
          <InfoRow label="版本" value={appConfig.expo.version} />
          <InfoRow label="后端" value="本地 SQLite" />
          <InfoRow label="数据范围" value="只在本机" />
        </Section>
      </ScrollView>

      <Toast toast={toast} onDismiss={dismissToast} placement="top" />
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
  headerRow: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  titleBlock: { flex: 1, gap: 1, marginBottom: space.xs },
  title: {
    fontSize: font.page,
    fontWeight: "800",
    letterSpacing: -0.5,
    lineHeight: font.page + 7,
  },
  subtitle: { fontSize: font.meta },
  tiles: {
    paddingVertical: space.xs,
  },
  tilesRow: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  tileDivider: {
    width: StyleSheet.hairlineWidth,
    marginVertical: space.sm,
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
  sectionIcon: {
    width: 24,
    height: 24,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  sectionTitle: { fontSize: font.title, fontWeight: "700" },
  sectionRule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    marginLeft: space.xs,
  },
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
