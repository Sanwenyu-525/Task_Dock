// 主屏小组件：配置页结构（预览 / 尺寸 / 内容 / 外观）。偏好存 kv，
// 「添加到主屏幕」是规划能力——Android 小组件需要原生 AppWidgetProvider（expo-widgets 仍 ALPHA）。
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { AppBar } from "../components/AppBar";
import { Badge } from "../components/Badge";
import { Chip } from "../components/Chip";
import { PressableScale } from "../components/PressableScale";
import { SegmentedControl, type SegmentOption } from "../components/SegmentedControl";
import { SettingSection } from "../components/SettingSection";
import { Toast, type ToastMessage, type ToastTone } from "../components/Toast";
import { getSetting, setSetting } from "../db/kv";
import type { Nav } from "../lib/nav";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

type WidgetSize = "2x2" | "4x2" | "4x4";
type WidgetContent = "today" | "pending" | "captures";
type WidgetAppearance = "system" | "light" | "dark";

const SIZES: SegmentOption<WidgetSize>[] = [
  { value: "2x2", label: "2×2" },
  { value: "4x2", label: "4×2" },
  { value: "4x4", label: "4×4" },
];

const CONTENTS: { key: WidgetContent; label: string }[] = [
  { key: "today", label: "今天任务" },
  { key: "pending", label: "待办任务" },
  { key: "captures", label: "收集箱速记" },
];

const APPEARANCES: { key: WidgetAppearance; label: string }[] = [
  { key: "system", label: "跟随系统" },
  { key: "light", label: "浅色" },
  { key: "dark", label: "深色" },
];

const WIDGET_PREFS_KEY = "widget_prefs";

interface WidgetPrefs {
  size: WidgetSize;
  content: WidgetContent;
  appearance: WidgetAppearance;
}

const DEFAULT_PREFS: WidgetPrefs = { size: "4x2", content: "today", appearance: "system" };

function parsePrefs(raw: string | null): WidgetPrefs {
  if (!raw) return DEFAULT_PREFS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_PREFS;
    const record = parsed as Record<string, unknown>;
    const size = SIZES.some((s) => s.value === record.size) ? (record.size as WidgetSize) : DEFAULT_PREFS.size;
    const content = CONTENTS.some((c) => c.key === record.content)
      ? (record.content as WidgetContent)
      : DEFAULT_PREFS.content;
    const appearance = APPEARANCES.some((a) => a.key === record.appearance)
      ? (record.appearance as WidgetAppearance)
      : DEFAULT_PREFS.appearance;
    return { size, content, appearance };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function WidgetScreen({ nav }: { nav: Nav }) {
  const { tokens } = useTheme();
  const [prefs, setPrefs] = useState<WidgetPrefs>(DEFAULT_PREFS);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSeq = useRef(0);

  const showToast = useCallback((text: string, tone: ToastTone = "info") => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text, tone });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const parsed = parsePrefs(await getSetting(WIDGET_PREFS_KEY));
        if (!cancelled) setPrefs(parsed);
      } catch {
        // 偏好读不到就用默认值：配置页不因 kv 异常而不可用
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const savePrefs = useCallback((next: WidgetPrefs) => {
    setPrefs(next);
    void setSetting(WIDGET_PREFS_KEY, JSON.stringify(next)).catch(() => undefined);
  }, []);

  const plannedAction = useCallback(
    () => showToast("小组件能力规划中：需要原生 AppWidgetProvider，尚未接入"),
    [showToast],
  );

  return (
    <View style={styles.container}>
      {/* 顶栏固定在滚动容器外：滚动后返回箭头不能跟着滚走（真机实测会被滚出屏幕） */}
      <AppBar title="主屏小组件" badge={<Badge label="规划中" />} onBack={nav.back} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* 桌面预览：bgAccent 底上摆两张组件卡；勾选框只是视觉元素 */}
        <View style={[styles.preview, { backgroundColor: tokens.bgAccent }]}>
          <View style={[styles.widgetCard, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
            <View style={styles.widgetHead}>
              <Text style={[styles.widgetTitle, { color: tokens.text }]}>今天</Text>
              <View style={[styles.widgetCount, { backgroundColor: tokens.accentSoft }]}>
                <Text style={[styles.widgetCountText, { color: tokens.accent }]}>3</Text>
              </View>
            </View>
            {["写周报：Q4 目标复盘", "预约体检", "给妈妈打电话"].map((label) => (
              <View key={label} style={styles.widgetRow}>
                <View style={[styles.widgetCheck, { borderColor: tokens.muted }]} />
                <Text numberOfLines={1} style={[styles.widgetRowText, { color: tokens.text }]}>
                  {label}
                </Text>
              </View>
            ))}
            <Text style={[styles.widgetFooter, { color: tokens.faint }]}>TaskDock · 4×2</Text>
          </View>

          <View style={[styles.widgetCard, styles.widgetSmall, { backgroundColor: tokens.card, borderColor: tokens.cardBorder }]}>
            <View style={styles.widgetHead}>
              <Text style={[styles.widgetTitle, { color: tokens.text }]}>今天</Text>
              <Text style={[styles.widgetBig, { color: tokens.accent }]}>3</Text>
            </View>
            <View style={styles.widgetRow}>
              <View style={[styles.widgetCheck, { borderColor: tokens.muted }]} />
              <Text numberOfLines={1} style={[styles.widgetRowText, { color: tokens.text }]}>
                写周报：Q4 目标复盘
              </Text>
            </View>
            <Text style={[styles.widgetFooter, { color: tokens.faint }]}>TaskDock · 2×2</Text>
          </View>
        </View>

        <SettingSection title="尺寸">
          <SegmentedControl
            options={SIZES}
            value={prefs.size}
            onChange={(size) => savePrefs({ ...prefs, size })}
            accessibilityLabel="小组件尺寸"
          />
        </SettingSection>

        <SettingSection title="内容">
          <View style={styles.chipRow}>
            {CONTENTS.map((item) => (
              <Chip
                key={item.key}
                label={item.label}
                active={prefs.content === item.key}
                accessibilityLabel={`内容 ${item.label}`}
                onPress={() => savePrefs({ ...prefs, content: item.key })}
              />
            ))}
          </View>
        </SettingSection>

        <SettingSection title="外观">
          <View style={styles.chipRow}>
            {APPEARANCES.map((item) => (
              <Chip
                key={item.key}
                label={item.label}
                active={prefs.appearance === item.key}
                accessibilityLabel={`外观 ${item.label}`}
                onPress={() => savePrefs({ ...prefs, appearance: item.key })}
              />
            ))}
          </View>
        </SettingSection>

        <PressableScale
          onPress={plannedAction}
          accessibilityLabel="添加到主屏幕"
          accessibilityHint="小组件能力规划中，点击查看说明"
          contentStyle={[styles.primary, { backgroundColor: tokens.accentFill }]}
        >
          <Text style={[styles.primaryText, { color: tokens.onAccent }]}>添加到主屏幕</Text>
        </PressableScale>

        <Text style={[styles.helper, { color: tokens.faint }]}>
          Android：长按桌面空白处 → 小组件 → TaskDock
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
  preview: {
    marginTop: space.md,
    borderRadius: radius.card,
    padding: space.md,
    gap: space.md,
  },
  widgetCard: {
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.md,
    gap: space.sm,
    alignSelf: "stretch",
  },
  widgetSmall: {
    alignSelf: "center",
    width: "62%",
  },
  widgetHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
  },
  widgetTitle: {
    fontSize: font.body,
    fontWeight: "700",
  },
  widgetCount: {
    minWidth: 20,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 999,
    alignItems: "center",
  },
  widgetCountText: {
    fontSize: font.label,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  widgetBig: {
    marginLeft: "auto",
    fontSize: font.stat,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
  },
  widgetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  widgetCheck: {
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 1.5,
  },
  widgetRowText: {
    flexShrink: 1,
    fontSize: font.meta,
  },
  widgetFooter: {
    fontSize: font.label,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
  },
  primary: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
  },
  primaryText: {
    fontSize: font.title,
    fontWeight: "600",
  },
  helper: {
    fontSize: font.label,
    textAlign: "center",
  },
});
