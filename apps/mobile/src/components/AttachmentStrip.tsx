// 附件条：在收集箱卡片、任务详情、笔记编辑器里显示「这一条记录挂了什么」，
// 并让用户真的能打开——图片看大图、录音试听、文件/PDF 走系统预览。
//
// 设计边界：
// - 只在有附件时渲染，空记录不多占一行；
// - 不重做列表：调用方把本组件放进现有卡片/编辑器即可；
// - 附件状态用文字表达（待发送 / 已发送 / 失败 / 本机文件缺失），不把「本机保存」
//   说成「已同步到电脑」；
// - 删除附件是显式动作（长按确认），删记录不会级联删文件（文件可能仍被别处引用）。
import { useCallback, useEffect, useState } from "react";
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { File } from "expo-file-system";

import { deleteAttachment, listAttachments } from "../db/attachments";
import type { Attachment, AttachmentOwner } from "../domain/types";
import { formatBytes, formatDuration } from "../lib/capture/summary";
import { pathFromFileUri } from "../lib/capture/storage";
import { describeError } from "../lib/errors";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";
import VoiceRecorder, { voiceRecorderAvailable } from "../../modules/voice-recorder";

const STATE_LABEL: Record<Attachment["transferState"], string> = {
  pending: "待发送",
  uploading: "发送中",
  sent: "已发送",
  failed: "发送失败",
  skipped: "未发送",
};

function attachmentLabel(item: Attachment): string {
  if (item.kind === "image") return item.name || "照片";
  if (item.kind === "audio") {
    return `${item.name || "语音"}${item.durationMs ? ` · ${formatDuration(item.durationMs)}` : ""}`;
  }
  return item.name || "文件";
}

/**
 * 附件条：按归属惰性读取，不参与列表的分页加载。
 *
 * @param refreshKey 外层数据版本变化时传一个新值即可重查（如同步完成、转任务后）。
 */
export function AttachmentStrip({
  ownerEntity,
  ownerId,
  refreshKey,
  onChanged,
}: {
  ownerEntity: AttachmentOwner;
  ownerId: string;
  refreshKey?: number;
  onChanged?: () => void;
}) {
  const { tokens } = useTheme();
  const [items, setItems] = useState<Attachment[]>([]);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failedId, setFailedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setItems(await listAttachments(ownerEntity, ownerId));
    } catch {
      // 附件读取失败不阻塞主内容展示
    }
  }, [ownerEntity, ownerId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const stopPlayback = useCallback(() => {
    try {
      VoiceRecorder?.stopPlayback();
    } catch {
      // 模块缺失时忽略
    }
    setPlayingId(null);
  }, []);

  const handleAudio = useCallback(
    async (item: Attachment) => {
      if (!voiceRecorderAvailable) {
        setMessage("当前构建不含录音模块，无法试听");
        return;
      }
      if (playingId === item.id) {
        stopPlayback();
        return;
      }
      try {
        stopPlayback();
        await VoiceRecorder?.play(pathFromFileUri(item.localUri));
        setPlayingId(item.id);
      } catch (error) {
        setMessage(`试听失败：${describeError(error)}`);
      }
    },
    [playingId, stopPlayback],
  );

  const handleFile = useCallback(async (item: Attachment) => {
    try {
      const file = new File(item.localUri);
      if (!file.exists) {
        setMessage("本机文件已缺失，请重新采集");
        return;
      }
      const can = await file.canPreview({ mimeType: item.mime || undefined });
      if (!can) {
        setMessage("本机没有能打开该类型的应用");
        return;
      }
      await file.preview({ mimeType: item.mime || undefined });
    } catch (error) {
      setMessage(`打开失败：${describeError(error)}`);
    }
  }, []);

  const handlePress = useCallback(
    (item: Attachment) => {
      setMessage(null);
      if (item.kind === "image") {
        setPreview(item);
        return;
      }
      if (item.kind === "audio") {
        void handleAudio(item);
        return;
      }
      void handleFile(item);
    },
    [handleAudio, handleFile],
  );

  const handleRemove = useCallback(
    async (item: Attachment) => {
      setFailedId(null);
      try {
        await deleteAttachment(item.id);
        setPreview(null);
        await refresh();
        onChanged?.();
        setMessage("附件已删除");
      } catch (error) {
        setMessage(`删除失败：${describeError(error)}`);
      }
    },
    [onChanged, refresh],
  );

  if (items.length === 0) return null;

  const total = items.reduce((sum, item) => sum + item.size, 0);

  return (
    <View style={styles.container}>
      <Text style={[styles.caption, { color: tokens.muted }]}>
        附件 {items.length} 个 · {formatBytes(total)} · 点按查看
      </Text>
      <View style={styles.chips}>
        {items.map((item) => {
          const isPlaying = playingId === item.id;
          const state = item.transferState;
          const bad = state === "failed";
          return (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityLabel={`${attachmentLabel(item)}，${STATE_LABEL[state]}`}
              onPress={() => handlePress(item)}
              onLongPress={() => setFailedId(item.id)}
              delayLongPress={450}
              style={({ pressed }) => [
                styles.chip,
                {
                  backgroundColor: tokens.bgAccent,
                  borderColor: bad ? tokens.danger : tokens.cardBorder,
                  opacity: pressed ? 0.75 : 1,
                },
              ]}
            >
              {item.kind === "image" ? (
                <Image source={{ uri: item.localUri }} style={styles.thumb} resizeMode="cover" />
              ) : (
                <Text style={[styles.chipKind, { color: tokens.accentText }]}>
                  {item.kind === "audio" ? (isPlaying ? "停止" : "试听") : "打开"}
                </Text>
              )}
              <View style={styles.chipText}>
                <Text numberOfLines={1} style={[styles.chipName, { color: tokens.text }]}>
                  {attachmentLabel(item)}
                </Text>
                <Text
                  numberOfLines={1}
                  style={[styles.chipState, { color: bad ? tokens.danger : tokens.muted }]}
                >
                  {STATE_LABEL[state]}
                  {item.kind !== "audio" ? ` · ${formatBytes(item.size)}` : ""}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      {message ? <Text style={[styles.message, { color: tokens.muted }]}>{message}</Text> : null}
      {failedId ? (
        <View style={styles.confirmRow}>
          <Text style={[styles.message, { color: tokens.danger }]}>删除这个附件？</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="确认删除附件"
            onPress={() => {
              const item = items.find((row) => row.id === failedId);
              if (item) void handleRemove(item);
            }}
            style={styles.confirmAction}
          >
            <Text style={[styles.confirmText, { color: tokens.danger }]}>删除</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="取消删除附件"
            onPress={() => setFailedId(null)}
            style={styles.confirmAction}
          >
            <Text style={[styles.confirmText, { color: tokens.muted }]}>取消</Text>
          </Pressable>
        </View>
      ) : null}

      <Modal visible={preview !== null} transparent animationType="fade" onRequestClose={() => setPreview(null)}>
        <View style={styles.modalRoot}>
          <View style={styles.modalBar}>
            <Text numberOfLines={1} style={[styles.modalTitle, { color: "#FFFFFF" }]}>
              {preview ? attachmentLabel(preview) : ""}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="关闭图片预览"
              onPress={() => setPreview(null)}
              style={styles.modalClose}
            >
              <Text style={[styles.modalCloseText, { color: "#FFFFFF" }]}>关闭</Text>
            </Pressable>
          </View>
          {preview ? (
            <ScrollView
              contentContainerStyle={styles.modalBody}
              maximumZoomScale={3}
              minimumZoomScale={1}
              centerContent
            >
              <Image source={{ uri: preview.localUri }} style={styles.previewImage} resizeMode="contain" />
            </ScrollView>
          ) : null}
          {preview ? (
            <View style={styles.modalFooter}>
              <Text style={[styles.modalMeta, { color: "#D6E4F5" }]}>
                {STATE_LABEL[preview.transferState]} · {formatBytes(preview.size)}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="删除当前附件"
                onPress={() => void handleRemove(preview)}
                style={styles.modalDelete}
              >
                <Text style={[styles.modalDeleteText, { color: "#FF837C" }]}>删除附件</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: space.xs, marginTop: space.xs },
  caption: { fontSize: font.label },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: 6,
    minHeight: 44,
    borderRadius: radius.chip,
    borderWidth: 1,
    maxWidth: "100%",
  },
  thumb: { width: 32, height: 32, borderRadius: radius.chip },
  chipKind: { fontSize: font.label, fontWeight: "700" },
  chipText: { flexShrink: 1, maxWidth: 190 },
  chipName: { fontSize: font.label, fontWeight: "600" },
  chipState: { fontSize: 11 },
  message: { fontSize: font.label },
  confirmRow: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  confirmAction: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.sm },
  confirmText: { fontSize: font.meta, fontWeight: "600" },
  modalRoot: { flex: 1, backgroundColor: "rgba(8,14,24,0.96)" },
  modalBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingTop: 52,
    paddingBottom: space.sm,
    gap: space.sm,
  },
  modalTitle: { flex: 1, fontSize: font.title, fontWeight: "700" },
  modalClose: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.sm },
  modalCloseText: { fontSize: font.meta, fontWeight: "600" },
  modalBody: { flexGrow: 1, justifyContent: "center", padding: space.md },
  previewImage: { width: "100%", height: "100%", minHeight: 320 },
  modalFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingBottom: 40,
    paddingTop: space.sm,
      gap: space.sm,
  },
  modalMeta: { fontSize: font.label },
  modalDelete: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.sm },
  modalDeleteText: { fontSize: font.meta, fontWeight: "600" },
});
