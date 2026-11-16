// 笔记卡片：标题（空标题回退摘要/无标题）+ 两行摘要 + revision·时间 + 置顶图标。
// 纯展示 + onPress；置顶/收藏/删除入口在编辑器内，保持列表交互面最小。
//
// 分组形态与任务页一致：分组头是带色的连续条，卡片按 position 拼成一张分组卡
//（首行顶部直角、末行底部圆角、行间只留一条 hairline），不再是「标题 + 一堆独立白卡」。
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { formatRelative } from "../domain/taskQuery";
import { excerpt, noteDisplayTitle } from "../domain/noteText";
import type { Note } from "../domain/types";
import { decodeRecentTitle } from "../lib/recentTitle";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

import { AppIcon } from "./icons/AppIcon";

/** 卡片在所属分组中的位置：决定顶部/底部圆角与顶边是否绘制 */
export type NoteCardPosition = "only" | "first" | "middle" | "last";

function NoteCardBase({
  note,
  now,
  onPress,
  position = "only",
}: {
  note: Note;
  now: number;
  onPress: (note: Note) => void;
  position?: NoteCardPosition;
}) {
  const { tokens } = useTheme();
  const displayTitle = decodeRecentTitle(noteDisplayTitle(note.title, note.body));
  const displayExcerpt = decodeRecentTitle(excerpt(note.body, 96));
  const topRounded = position === "only" || position === "first";
  const bottomRounded = position === "only" || position === "last";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`打开笔记「${displayTitle}」`}
      accessibilityHint="进入笔记编辑"
      onPress={() => onPress(note)}
      style={({ pressed }) => [{ opacity: pressed ? 0.75 : 1 }]}
    >
      <View
        style={[
          styles.card,
          {
            backgroundColor: tokens.cardSolid,
            borderColor: tokens.cardBorder,
            // 首行与分组头衔接，不画顶边；其余行只留一条底边作分隔
            borderTopWidth: topRounded ? StyleSheet.hairlineWidth : 0,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderLeftWidth: StyleSheet.hairlineWidth,
            borderRightWidth: StyleSheet.hairlineWidth,
            borderTopLeftRadius: topRounded ? radius.row : 0,
            borderTopRightRadius: topRounded ? radius.row : 0,
            borderBottomLeftRadius: bottomRounded ? radius.row : 0,
            borderBottomRightRadius: bottomRounded ? radius.row : 0,
          },
        ]}
      >
        {/* 顶部边光与任务行一致，让两种列表看起来是同一族卡片 */}
        <View
          pointerEvents="none"
          style={[styles.highlight, { backgroundColor: tokens.cardHighlight }]}
        />
        <Text numberOfLines={1} style={[styles.title, { color: tokens.text }]}>
          {displayTitle}
        </Text>
        {note.body.trim() ? (
          <Text numberOfLines={2} style={[styles.excerpt, { color: tokens.muted }]}>
            {displayExcerpt}
          </Text>
        ) : null}
        <View style={styles.footer}>
          <Text style={[styles.meta, { color: tokens.muted }]}>
            revision {note.rev} · {formatRelative(note.updatedAt, now)}
          </Text>
          {/* 图钉放在 footer 右侧：标题行保持纯文本宽度，长标题不会被图标挤断 */}
          {note.pinned ? (
            <View accessibilityLabel="已置顶">
              {/* 置顶图钉：斜置的针头方块 + 针杆，同 1.5dp 笔触 */}
              <AppIcon name="pin" color={tokens.accent} size={16} />
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

export const NoteCard = memo(NoteCardBase);

const styles = StyleSheet.create({
  card: {
    padding: space.md,
    gap: space.sm - 2,
    // 内嵌面板是直角的，不裁剪会把卡片圆角顶成方形
    overflow: "hidden",
  },
  highlight: {
    position: "absolute",
    top: 0,
    left: 14,
    right: 14,
    height: StyleSheet.hairlineWidth,
  },
  title: {
    flexShrink: 1,
    fontSize: font.title,
    fontWeight: "700",
  },
  excerpt: {
    fontSize: font.reading,
    lineHeight: 21,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
  },
  meta: {
    flexShrink: 1,
    fontSize: font.meta,
    fontVariant: ["tabular-nums"],
  },
});
