// 主屏小组件：配置页（预览 / 尺寸 / 内容 / 外观）。偏好存 kv（widget_prefs），
// 变化后经 src/lib/widgetSnapshot 推送快照并刷新已添加的原生小组件实例。
// 预览与原生小组件共用同一份真实快照数据（无假数据）；尺寸在系统小组件选择器
// 添加时选择（2×2 / 4×2），此处的尺寸偏好决定预览形状。
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { AppBar } from "../components/AppBar";
import { Badge } from "../components/Badge";
import { Chip } from "../components/Chip";
import { PressableScale } from "../components/PressableScale";
import { SegmentedControl, type SegmentOption } from "../components/SegmentedControl";
import { SettingSection } from "../components/SettingSection";
import { Toast, type ToastMessage, type ToastTone } from "../components/Toast";
import { requestPinWidget, taskDockWidgetAvailable } from "../../modules/taskdock-widget";
import { getSetting, setSetting } from "../db/kv";
import { useWindowInsets } from "../lib/insets";
import type { Nav } from "../lib/nav";
import {
  DEFAULT_WIDGET_PREFS,
  parseWidgetPrefs,
  previewCount,
  refreshWidgetSnapshot,
  resolvePreviewContent,
  WIDGET_PREFS_KEY,
  type WidgetAppearance,
  type WidgetContent,
  type WidgetPrefs,
  type WidgetSize,
  type WidgetSnapshot,
} from "../lib/widgetSnapshot";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

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

const CONTENT_TITLES: Record<WidgetContent, string> = {
  today: "今天",
  pending: "待办",
  captures: "收集箱",
};

export function WidgetScreen({ nav }: { nav: Nav }) {
  const { tokens } = useTheme();
  const insets = useWindowInsets();
  const [prefs, setPrefs] = useState<WidgetPrefs>(DEFAULT_WIDGET_PREFS);
  const [snapshot, setSnapshot] = useState<WidgetSnapshot | null>(null);
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
        // 首次进入：先读回已保存偏好，再按同一份偏好构建真实快照。
        // 只写不读会让页面每次回到默认值，也会让预览口径与快照内容不一致。
        const stored = parseWidgetPrefs(await getSetting(WIDGET_PREFS_KEY));
        if (cancelled) return;
        setPrefs(stored);
        const next = await refreshWidgetSnapshot(stored);
        if (!cancelled && next) setSnapshot(next);
      } catch {
        // 预览不可用不阻塞配置页
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const savePrefs = useCallback((next: WidgetPrefs) => {
    setPrefs(next);
    // 偏好变化立即生效：写 kv + 用新偏好构建快照推送（已添加的小组件马上重渲染）
    void setSetting(WIDGET_PREFS_KEY, JSON.stringify(next))
      .then(() => refreshWidgetSnapshot(next))
      .then((snapshot) => {
        if (snapshot) setSnapshot(snapshot);
      })
      .catch(() => undefined);
  }, []);

  // 真实添加：Android 8+ 请求系统弹出「添加到桌面」确认框（requestPinAppWidget）。
  // 桌面（launcher）不支持时回退为长按引导文案；4×4 未提供，按最近的 4×2 请求。
  const addToHomeScreen = useCallback(() => {
    const size = prefs.size === "2x2" ? "2x2" : "4x2";
    const result = taskDockWidgetAvailable ? requestPinWidget(size) : null;
    if (result?.requested) {
      // requestPinAppWidget 返回 true 只代表请求已被系统接受，不保证桌面一定弹窗
      // （vivo OriginOS 桌面实测不弹）。文案给出手动兜底路径，避免用户干等。
      showToast("已请求添加到桌面；若系统未弹确认，请长按桌面空白处 → 组件 → TaskDock", "info");
    } else if (result && !result.supported) {
      showToast("当前桌面不支持直接添加：长按桌面空白处 → 小组件 → TaskDock", "info");
    } else {
      showToast("长按桌面空白处 → 小组件 → TaskDock，选择 2×2 或 4×2 添加", "info");
    }
  }, [prefs.size, showToast]);

  // 标题、计数、行统一按快照内容取，避免偏好与快照瞬时不同步时口径打架。
  const previewContent = resolvePreviewContent(prefs.content, snapshot);
  const title = CONTENT_TITLES[previewContent];
  const count = previewCount(previewContent, snapshot);
  const rows = snapshot?.items ?? [];
  const widePreview = prefs.size !== "2x2";
  const maxRows = widePreview ? 3 : 1;
  const previewRows = rows.slice(0, maxRows);

  return (
    <View style={styles.container}>
      <AppBar title="主屏小组件" badge={<Badge label="已接入" tone="active" />} onBack={nav.back} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* 桌面预览：与原生 RemoteViews 同一份数据、同一套圆角/配色语义 */}
        <View style={[styles.preview, { backgroundColor: tokens.bgAccent }]}>
          <View
            style={[
              styles.widgetCard,
              widePreview ? null : styles.widgetSmall,
              { backgroundColor: tokens.card, borderColor: tokens.cardBorder },
            ]}
          >
            <View style={styles.widgetHead}>
              <Text style={[styles.widgetTitle, { color: tokens.text }]}>{title}</Text>
              {widePreview ? (
                <View style={[styles.widgetCount, { backgroundColor: tokens.accentSoft }]}>
                  <Text style={[styles.widgetCountText, { color: tokens.accentText }]}>{count}</Text>
                </View>
              ) : (
                <Text style={[styles.widgetBig, { color: tokens.accentText }]}>{count}</Text>
              )}
            </View>
            {previewRows.map((row, index) => (
              <View key={`${row.t}-${index}`} style={styles.widgetRow}>
                <View
                  style={[
                    styles.widgetCheck,
                    { backgroundColor: row.done ? tokens.ok : "transparent", borderColor: tokens.muted },
                  ]}
                />
                <Text numberOfLines={1} style={[styles.widgetRowText, { color: tokens.text }]}>
                  {row.t}
                </Text>
              </View>
            ))}
            {snapshot && previewRows.length === 0 ? (
              <Text style={[styles.widgetEmpty, { color: tokens.muted }]}>{snapshot.empty}</Text>
            ) : null}
            <Text style={[styles.widgetFooter, { color: tokens.faint }]}>
              TaskDock · {prefs.size.replace("x", "×")}
            </Text>
          </View>
        </View>

        <SettingSection icon="smartphone" title="尺寸">
          <SegmentedControl
            options={SIZES}
            value={prefs.size}
            onChange={(size) => savePrefs({ ...prefs, size })}
            accessibilityLabel="小组件尺寸"
          />
          {prefs.size === "4x4" ? (
            <Text style={[styles.sizeHint, { color: tokens.faint }]}>
              4×4 暂未提供：添加时请在系统选择器里选 2×2 或 4×2
            </Text>
          ) : null}
        </SettingSection>

        <SettingSection icon="list" title="内容">
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

        <SettingSection icon="sparkles" title="外观">
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
          {prefs.appearance === "system" ? (
            <Text style={[styles.sizeHint, { color: tokens.faint }]}>
              跟随系统：系统切换明暗后，下次打开 TaskDock 时小组件同步重渲染
            </Text>
          ) : null}
        </SettingSection>

        <PressableScale
          onPress={addToHomeScreen}
          accessibilityLabel="添加到主屏幕"
          accessibilityHint="请求系统把 TaskDock 小组件添加到桌面，不支持时给出手动添加步骤"
          contentStyle={[styles.primary, { backgroundColor: tokens.accentFill }]}
        >
          <Text style={[styles.primaryText, { color: tokens.onAccent }]}>添加到主屏幕</Text>
        </PressableScale>

        <Text style={[styles.helper, { color: tokens.faint }]}>
          Android：长按桌面空白处 → 小组件 → TaskDock。内容变化时小组件自动更新。
        </Text>
      </ScrollView>

      {/* 唯一操作在页面底部主按钮：提示留在底部、抬到手势条上方 */}
      <Toast
        toast={toast}
        onDismiss={dismissToast}
        placement="bottom"
        bottomOffset={space.lg + insets.bottom}
      />
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
  widgetEmpty: {
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
  sizeHint: {
    fontSize: font.label,
    lineHeight: 15,
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
