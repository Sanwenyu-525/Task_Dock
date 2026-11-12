// 分享接收：接收系统 ACTION_SEND(text/plain) 载荷，用户确认后才写入收集箱。
// 载荷经 src/lib/pendingShare 的内存队列进入本屏：挂载时消费最早的待处理分享，
// 运行中新分享由订阅就地更新。返回/取消/保存都会清空队列，不残留待处理载荷。
//
// 关于标签/备注：captures 表没有这两列（schema 与桌面端收集箱对齐，迁移文件不在
// 本任务所有权内），为避免用户填写后被静默丢弃，本屏不提供这两个输入。
// 决策记录见 docs/mobile/09-share-receive.md。
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

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
import {
  consumePendingShare,
  discardPendingShare,
  subscribePendingShare,
} from "../lib/pendingShare";
import type { ShareIntentPayload } from "../../modules/share-intent";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

export function ShareScreen({ nav, onDataChanged }: { nav: Nav; onDataChanged: () => void }) {
  const { tokens } = useTheme();
  const insets = useWindowInsets();
  /** 输入区在页面底部：edge-to-edge 下系统不收缩窗口，需要自己给键盘让位 */
  const keyboardHeight = useKeyboardHeight();
  /** 当前展示的分享载荷：挂载时消费队列最早一条，之后新分享就地替换 */
  const [payload, setPayload] = useState<ShareIntentPayload | null>(() => consumePendingShare());
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastSeq = useRef(0);

  const showToast = useCallback((message: string, tone: ToastTone = "info") => {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text: message, tone });
  }, []);
  const dismissToast = useCallback(() => setToast(null), []);

  // 运行中再次收到分享：消费队列里最新一条，就地替换展示内容
  useEffect(
    () =>
      subscribePendingShare((next) => {
        const taken = consumePendingShare();
        if (taken) setPayload(taken);
        else setPayload(next);
      }),
    [],
  );

  // 离开本屏即丢弃待处理载荷（保存与取消都适用）：返回键经 App 的栈 pop 也会走这里，
  // 保证「用户返回键取消 → 不残留待处理载荷」。
  useEffect(() => () => discardPendingShare(), []);

  const handleSave = useCallback(async () => {
    if (saving || !payload) return;
    setSaving(true);
    try {
      await addCapture(payload.text);
      discardPendingShare();
      onDataChanged();
      showToast("已保存到收集箱", "success");
      nav.back();
    } catch (error) {
      showToast(`保存失败：${describeError(error)}`, "danger");
    } finally {
      setSaving(false);
    }
  }, [nav, onDataChanged, payload, showToast]);

  const handleCancel = useCallback(() => {
    discardPendingShare();
    nav.back();
  }, [nav]);

  return (
    <View style={styles.container}>
      <AppBar title="分享到 TaskDock" badge={<Badge label="已接入" tone="active" />} onBack={handleCancel} />

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: 48 + keyboardHeight }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {payload ? (
          <GlassCard style={styles.preview}>
            <Text style={[styles.previewText, { color: tokens.text }]}>{payload.text}</Text>
            <Text style={[styles.previewMeta, { color: tokens.faint }]}>
              {payload.truncated
                ? `文本 · 原文 ${payload.originalLength} 字，超出收集箱上限已截断为 4000 字`
                : "文本"}
            </Text>
          </GlassCard>
        ) : (
          <GlassCard style={styles.preview}>
            <Text style={[styles.previewText, { color: tokens.muted }]}>还没有收到分享内容</Text>
            <Text style={[styles.previewMeta, { color: tokens.faint }]}>
              在浏览器或其他应用里选「分享到 TaskDock」，就会打开本页
            </Text>
          </GlassCard>
        )}

        <GlassCard style={styles.form}>
          <Text style={[styles.formLabel, { color: tokens.text }]}>保存到</Text>
          <View style={[styles.segment, { backgroundColor: tokens.bgAccent }]}>
            <View style={[styles.segmentActive, { backgroundColor: tokens.accentFill }]}>
              <Text style={[styles.segmentText, { color: tokens.onAccent }]}>收集箱</Text>
            </View>
            <View style={styles.segmentIdle}>
              <Text style={[styles.segmentText, { color: tokens.muted }]}>新任务</Text>
            </View>
          </View>
          <Text style={[styles.formHint, { color: tokens.faint }]}>
            保存后可在收集箱一键转为任务并补充标签、备注
          </Text>
        </GlassCard>

        <PressableScale
          onPress={() => void handleSave()}
          accessibilityLabel="保存到收集箱"
          accessibilityHint={payload ? "把分享内容存入收集箱" : "还没有可保存的分享内容"}
          disabled={!payload}
          contentStyle={[
            styles.primary,
            { backgroundColor: tokens.accentFill, opacity: payload ? 1 : 0.45 },
          ]}
        >
          <Text style={[styles.primaryText, { color: tokens.onAccent }]}>保存到收集箱</Text>
        </PressableScale>

        <PressableScale onPress={handleCancel} accessibilityLabel="取消" contentStyle={styles.secondary}>
          <Text style={[styles.secondaryText, { color: tokens.accent }]}>取消</Text>
        </PressableScale>

        <Text style={[styles.footer, { color: tokens.faint }]}>
          保存后进入本机收集箱；已配对桌面端时，内容会随同步发送到桌面端。分享内容不会进入剪贴板历史。
        </Text>
      </ScrollView>

      {/* 唯一操作在页面底部：提示留在底部；键盘弹起时抬到键盘上沿 */}
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
  formHint: {
    fontSize: font.label,
    lineHeight: 15,
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
