// 分享接收：share-target 页面结构。真实「来自系统分享」需要原生 intent-filter
// （后续原生轮接入）；本屏通过路由参数接收文本，无参数时展示等待态。
// 参数里的文本可以直接真实落库：保存到收集箱走与收集箱一致的 addCapture。
import { useCallback, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { AppBar } from "../components/AppBar";
import { Badge } from "../components/Badge";
import { GlassCard } from "../components/GlassCard";
import { PressableScale } from "../components/PressableScale";
import { Toast, type ToastMessage, type ToastTone } from "../components/Toast";
import { addCapture } from "../db/captures";
import { describeError } from "../lib/errors";
import { useWindowInsets } from "../lib/insets";
import { useKeyboardHeight } from "../lib/keyboard";
import type { Nav } from "../lib/nav";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

export function ShareScreen({
  nav,
  sharedText,
  onDataChanged,
}: {
  nav: Nav;
  /** 将来由系统分享 intent 传入；当前入口没有真实分享源 */
  sharedText?: string;
  onDataChanged: () => void;
}) {
  const { tokens } = useTheme();
  const insets = useWindowInsets();
  /** 输入框在页面底部：edge-to-edge 下系统不收缩窗口，需要自己给键盘让位 */
  const keyboardHeight = useKeyboardHeight();
  const text = sharedText ?? "";
  const [tagsText, setTagsText] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSeq = useRef(0);

  const showToast = useCallback((message: string, tone: ToastTone = "info") => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text: message, tone });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  const handleSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      await addCapture(text);
      onDataChanged();
      showToast("已保存到收集箱", "success");
      nav.back();
    } catch (error) {
      showToast(`保存失败：${describeError(error)}`, "danger");
    } finally {
      setSaving(false);
    }
  }, [nav, onDataChanged, showToast, text]);

  return (
    <View style={styles.container}>
      <AppBar title="分享到 TaskDock" badge={<Badge label="规划中" />} onBack={nav.back} />

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: 48 + keyboardHeight }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
      {text ? (
        <GlassCard style={styles.preview}>
          <Text style={[styles.previewText, { color: tokens.text }]}>{text}</Text>
          <Text style={[styles.previewMeta, { color: tokens.faint }]}>文本</Text>
        </GlassCard>
      ) : (
        <GlassCard style={styles.preview}>
          <Text style={[styles.previewText, { color: tokens.muted }]}>
            还没有收到分享内容
          </Text>
          <Text style={[styles.previewMeta, { color: tokens.faint }]}>
            系统分享接收需要原生 intent-filter，接入后浏览器选「分享到 TaskDock」即可到达本页
          </Text>
        </GlassCard>
      )}

      <GlassCard style={styles.form}>
        <Text style={[styles.formLabel, { color: tokens.text }]}>保存到</Text>
        <View
          style={[
            styles.segment,
            { backgroundColor: tokens.bgAccent },
          ]}
        >
          <View style={[styles.segmentActive, { backgroundColor: tokens.accentFill }]}>
            <Text style={[styles.segmentText, { color: tokens.onAccent }]}>收集箱</Text>
          </View>
          <View style={styles.segmentIdle}>
            <Text style={[styles.segmentText, { color: tokens.muted }]}>新任务</Text>
          </View>
        </View>

        <Text style={[styles.formLabel, { color: tokens.text }]}>标签</Text>
        <TextInput
          accessibilityLabel="标签"
          value={tagsText}
          onChangeText={setTagsText}
          placeholder="用空格分隔，如：研究 原型"
          placeholderTextColor={tokens.faint}
          underlineColorAndroid="transparent"
          editable={Boolean(text)}
          style={[
            styles.input,
            {
              backgroundColor: tokens.bgAccent,
              borderColor: tokens.cardBorder,
              color: tokens.text,
              // 没有分享内容时输入框不可编辑：不能仍画成可输入的常态
              opacity: text ? 1 : 0.55,
            },
          ]}
        />

        <Text style={[styles.formLabel, { color: tokens.text }]}>补充备注（可选）</Text>
        <TextInput
          accessibilityLabel="补充备注"
          value={note}
          onChangeText={setNote}
          placeholder="补充一句（可选）"
          placeholderTextColor={tokens.faint}
          underlineColorAndroid="transparent"
          editable={Boolean(text)}
          style={[
            styles.input,
            {
              backgroundColor: tokens.bgAccent,
              borderColor: tokens.cardBorder,
              color: tokens.text,
              // 没有分享内容时输入框不可编辑：不能仍画成可输入的常态
              opacity: text ? 1 : 0.55,
            },
          ]}
        />
      </GlassCard>

      <PressableScale
        onPress={() => void handleSave()}
        accessibilityLabel="保存到收集箱"
        accessibilityHint={text ? "把分享内容存入收集箱" : "还没有可保存的分享内容"}
        disabled={!text}
        contentStyle={[
          styles.primary,
          { backgroundColor: tokens.accentFill, opacity: text ? 1 : 0.45 },
        ]}
      >
        <Text style={[styles.primaryText, { color: tokens.onAccent }]}>保存到收集箱</Text>
      </PressableScale>

      <PressableScale onPress={nav.back} accessibilityLabel="取消" contentStyle={styles.secondary}>
        <Text style={[styles.secondaryText, { color: tokens.accent }]}>取消</Text>
      </PressableScale>

      <Text style={[styles.footer, { color: tokens.faint }]}>
        分享内容只保存在本机，不进入剪贴板历史，也不随同步外发。
      </Text>
      </ScrollView>

      {/* 保存按钮在页面底部：提示留在底部；键盘弹起时抬到键盘上沿 */}
      <Toast
        toast={toast}
        onDismiss={dismissToast}
        placement="bottom"
        bottomOffset={keyboardHeight > 0 ? keyboardHeight + space.lg : space.lg + insets.bottom}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingBottom: 48,
    paddingHorizontal: space.lg,
    gap: space.md,
  },
  preview: {
    marginTop: space.md,
    padding: space.md,
    gap: space.sm,
  },
  previewText: {
    fontSize: font.body,
    lineHeight: 19,
  },
  previewMeta: {
    fontSize: font.label,
  },
  form: {
    padding: space.md,
    gap: space.sm,
  },
  formLabel: {
    fontSize: font.body,
    fontWeight: "600",
  },
  segment: {
    flexDirection: "row",
    borderRadius: radius.control,
    padding: 2,
    gap: 2,
  },
  segmentActive: {
    flex: 1,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control - 2,
  },
  segmentIdle: {
    flex: 1,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentText: {
    fontSize: font.body,
    fontWeight: "600",
  },
  input: {
    minHeight: 44,
    borderRadius: radius.control,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: font.body,
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
  secondary: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryText: {
    fontSize: font.title,
    fontWeight: "600",
  },
  footer: {
    fontSize: font.label,
    lineHeight: 16,
    textAlign: "center",
  },
});
