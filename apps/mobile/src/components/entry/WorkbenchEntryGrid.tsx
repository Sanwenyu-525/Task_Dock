// 工作台快捷入口网格（含长按编辑态）。
//
// 普通态：直接复用 QuickTile，外观与改造前完全一致（浅蓝磁贴 + 图标 + 名称）。
// 编辑态：磁贴变成可拖拽单元——右上角 × 直接移除，按住拖动排序，
// 轻点弹出动作表（上移/下移/移除），给不方便拖拽的场合一条稳定替代路径。
//
// 拖拽几何全在 lib/entryReorder 的纯函数里，本文件只负责喂 dx/dy 与画反馈；
// 拖拽期间由上层把 ScrollView 的 scrollEnabled 关掉，避免和页面滚动抢手势。
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
} from "react-native";

import { moveEntryByIndex } from "../../lib/entryLayout";
import type { EntryId, MobileEntry } from "../../lib/entryRegistry";
import { gridDropIndex, isTapGesture } from "../../lib/entryReorder";
import { floatingShadow } from "../../theme/shadows";
import { useTheme } from "../../theme/ThemeProvider";
import { radius, space } from "../../theme/tokens";

import { ActionSheet, type SheetAction } from "../ActionSheet";
import { QuickTile } from "../QuickTile";
import { AppIcon, type IconName } from "../icons/AppIcon";

/** 磁贴固有高度：与 QuickTile 的 minHeight 一致（拖拽行步进用它，避免逐格测量） */
export const WORKBENCH_TILE_HEIGHT = 78;

export function WorkbenchEntryGrid({
  entries,
  editing,
  columns,
  contentWidth,
  badgeFor,
  onOpen,
  onLongPress,
  onReorder,
  onRemove,
  onMove,
  onDragActiveChange,
}: {
  entries: MobileEntry[];
  editing: boolean;
  columns: number;
  /** 网格可用宽度（由页面按自己的左右内边距算好） */
  contentWidth: number;
  badgeFor?: (id: string) => number | undefined;
  onOpen: (entry: MobileEntry) => void;
  /** 长按磁贴进入编辑模式 */
  onLongPress?: () => void;
  onReorder: (nextOrder: EntryId[]) => void;
  onRemove: (entry: MobileEntry) => void;
  onMove: (entry: MobileEntry, delta: number) => void;
  onDragActiveChange?: (active: boolean) => void;
}) {
  const { tokens, scheme } = useTheme();
  const gap = space.sm;
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const width = measuredWidth > 0 ? measuredWidth : Math.max(0, contentWidth);
  const cols = Math.max(1, Math.floor(columns));
  const cellWidth = width > 0 ? (width - gap * (cols - 1)) / cols : 0;

  const [dragging, setDragging] = useState<{ index: number; target: number } | null>(null);
  const offset = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const [sheetIndex, setSheetIndex] = useState<number | null>(null);

  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const metrics = useMemo(
    () => ({
      columns: cols,
      columnStep: cellWidth + gap,
      rowStep: WORKBENCH_TILE_HEIGHT + gap,
    }),
    [cellWidth, cols, gap],
  );

  const beginDrag = useCallback(
    (index: number) => {
      offset.setValue({ x: 0, y: 0 });
      setDragging({ index, target: index });
      onDragActiveChange?.(true);
    },
    [offset, onDragActiveChange],
  );

  const updateDrag = useCallback(
    (index: number, dx: number, dy: number) => {
      offset.setValue({ x: dx, y: dy });
      const target = gridDropIndex(index, dx, dy, metrics, entriesRef.current.length);
      setDragging((current) =>
        current && current.index === index && current.target === target
          ? current
          : { index, target },
      );
    },
    [metrics, offset],
  );

  const endDrag = useCallback(
    (index: number, dx: number, dy: number, cancelled = false) => {
      onDragActiveChange?.(false);
      offset.setValue({ x: 0, y: 0 });
      setDragging(null);
      if (cancelled) return;
      const current = entriesRef.current;
      if (isTapGesture(dx, dy)) {
        setSheetIndex(index);
        return;
      }
      const target = gridDropIndex(index, dx, dy, metrics, current.length);
      if (target === index) return;
      onReorder(
        moveEntryByIndex(
          current.map((entry) => entry.id as EntryId),
          index,
          target,
        ),
      );
    },
    [metrics, offset, onDragActiveChange, onReorder],
  );

  const sheetEntry = sheetIndex === null ? null : entries[sheetIndex] ?? null;
  const sheetActions: SheetAction[] = sheetEntry
    ? [
        {
          key: "up",
          label: "上移一位",
          icon: "chevronUp",
          disabled: sheetIndex === 0,
        },
        {
          key: "down",
          label: "下移一位",
          icon: "chevronDown",
          disabled: sheetIndex === entries.length - 1,
        },
        { key: "remove", label: "从工作台移除", icon: "delete", tone: "danger" },
      ]
    : [];

  const targetGeometry = dragging
    ? {
        left: (dragging.target % cols) * (cellWidth + gap),
        top: Math.floor(dragging.target / cols) * (WORKBENCH_TILE_HEIGHT + gap),
      }
    : null;

  return (
    <>
      <View
        onLayout={(event) => setMeasuredWidth(event.nativeEvent.layout.width)}
        style={styles.grid}
      >
        {targetGeometry && dragging ? (
          <View
            pointerEvents="none"
            style={[
              styles.targetSlot,
              targetGeometry,
              { width: cellWidth, borderColor: tokens.accent },
            ]}
          />
        ) : null}

        {entries.map((entry, index) => {
          const isActive = dragging?.index === index;
          return (
            <View
              key={entry.id}
              style={[styles.cell, { width: cellWidth || "25%", marginBottom: gap }]}
            >
              {editing ? (
                <EditableTile
                  entry={entry}
                  index={index}
                  active={isActive}
                  offset={isActive ? offset : null}
                  busy={dragging !== null}
                  onBeginDrag={beginDrag}
                  onUpdateDrag={updateDrag}
                  onEndDrag={endDrag}
                  onRemove={() => onRemove(entry)}
                  onActivate={() => setSheetIndex(index)}
                  shadowStyle={floatingShadow(scheme)}
                />
              ) : (
                <QuickTile
                  icon={entry.icon as IconName}
                  label={entry.label}
                  badge={badgeFor?.(entry.id)}
                  onPress={() => onOpen(entry)}
                  onLongPress={onLongPress}
                />
              )}
            </View>
          );
        })}
      </View>

      <ActionSheet
        visible={sheetEntry !== null}
        title={sheetEntry ? sheetEntry.label : ""}
        subtitle="调整这个入口在工作台的位置"
        actions={sheetActions}
        entityLabel="入口操作"
        onAction={(key) => {
          const entry = sheetEntry;
          setSheetIndex(null);
          if (!entry) return;
          if (key === "remove") onRemove(entry);
          else if (key === "up") onMove(entry, -1);
          else if (key === "down") onMove(entry, 1);
        }}
        onRequestClose={() => setSheetIndex(null)}
      />
    </>
  );
}

function EditableTile({
  entry,
  index,
  active,
  offset,
  busy,
  onBeginDrag,
  onUpdateDrag,
  onEndDrag,
  onRemove,
  onActivate,
  shadowStyle,
}: {
  entry: MobileEntry;
  index: number;
  active: boolean;
  offset: Animated.ValueXY | null;
  busy: boolean;
  onBeginDrag: (index: number) => void;
  onUpdateDrag: (index: number, dx: number, dy: number) => void;
  onEndDrag: (index: number, dx: number, dy: number, cancelled?: boolean) => void;
  onRemove: () => void;
  /** 读屏激活（TalkBack 双击）：打开上移/下移/移除动作表 */
  onActivate: () => void;
  shadowStyle: object;
}) {
  const { tokens } = useTheme();

  const responder = useMemo(
    () =>
      PanResponder.create({
        // 编辑态下磁贴本身就是拖拽面：点按不动 → 动作表，拖动 → 排序
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => onBeginDrag(index),
        onPanResponderMove: (_event, gesture) => onUpdateDrag(index, gesture.dx, gesture.dy),
        onPanResponderRelease: (_event, gesture) =>
          onEndDrag(index, gesture.dx, gesture.dy),
        onPanResponderTerminate: () => onEndDrag(index, 0, 0, true),
      }),
    [index, onBeginDrag, onEndDrag, onUpdateDrag],
  );

  return (
    <Animated.View
      {...responder.panHandlers}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${entry.label}，正在编辑，按住可拖动排序`}
      accessibilityHint="点按打开上移、下移与移除选项"
      // 读屏用户无法拖动：把「点按」暴露成 activate 动作，直接打开动作表
      accessibilityActions={[{ name: "activate", label: "打开入口操作" }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "activate") onActivate();
      }}
      style={[
        styles.surface,
        active ? [{ zIndex: 8, opacity: 0.96 }, shadowStyle] : null,
        offset
          ? {
              transform: [
                { translateX: offset.x },
                { translateY: offset.y },
                { scale: 1.05 },
              ],
            }
          : null,
      ]}
    >
      {/* 磁贴本身不接收触摸：手势统一由上层 PanResponder 处理 */}
      <View pointerEvents="none">
        <QuickTile icon={entry.icon as IconName} label={entry.label} onPress={() => undefined} />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`从工作台移除${entry.label}`}
        onPress={onRemove}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={({ pressed }) => [
          styles.remove,
          { backgroundColor: tokens.dangerSoft, opacity: busy && !active ? 0.7 : 1 },
          pressed ? { opacity: 0.7 } : null,
        ]}
      >
        <AppIcon name="close" color={tokens.danger} size={12} />
      </Pressable>

      {/* 拖动手柄：三枚竖向点 + 浅底，明确「这里可以抓」 */}
      <View pointerEvents="none" style={[styles.grip, { backgroundColor: tokens.track }]}>
        <AppIcon name="more" color={tokens.muted} size={12} style={styles.gripIcon} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space.sm,
    position: "relative",
  },
  cell: {},
  targetSlot: {
    position: "absolute",
    height: WORKBENCH_TILE_HEIGHT,
    borderRadius: radius.row,
    borderWidth: 1,
    borderStyle: "dashed",
  },
  surface: {
    borderRadius: radius.row,
  },
  remove: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  grip: {
    position: "absolute",
    bottom: 4,
    right: 4,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  gripIcon: {
    transform: [{ rotate: "90deg" }],
  },
});
