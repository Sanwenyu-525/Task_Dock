// 工作台快捷入口横向轨道（2026-11-16）。
//
// 替代改造前的「固定列数 + flexWrap」网格：无论用户放进来多少个入口，轨道永远
// 一行，超出可视宽度就横向滚动。几何全部来自 lib/entryRail 的纯函数，
// 本文件只负责视图、滚动与编辑态手势。
//
// 为什么是 ScrollView 而不是自研手势引擎：
// - 平台自带惯性、回弹、边缘停止与方向锁，嵌套在首页纵向 ScrollView 里不会互相抢；
// - 入口总数受注册表上限约束（当前 20 多个），磁贴是无动画的静态卡片，
//   不需要 FlatList 的窗口复用与额外测量；为它引入虚拟列表反而多一层布局开销。
//
// 编辑态：磁贴右上 × 直接移除；点磁贴弹动作表（前移 / 后移 / 移除）；
// 按住磁贴任意位置左右拖动排序（按住约 220ms 后启动，短划仍是滚轨道）。
// 拖动过程中相邻磁贴会实时让位，松手落位。
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
} from "react";
import {
  Animated,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";

import { moveEntryByIndex } from "../../lib/entryLayout";
import type { EntryId, MobileEntry } from "../../lib/entryRegistry";
import { clampRailOffset, entryTileLineHeight, railMetrics, RAIL_INSET } from "../../lib/entryRail";
import { isTapGesture, railDropIndex } from "../../lib/entryReorder";
import { floatingShadow } from "../../theme/shadows";
import { useTheme } from "../../theme/ThemeProvider";
import { radius, space } from "../../theme/tokens";

import { ActionSheet, type SheetAction } from "../ActionSheet";
import { QuickTile } from "../QuickTile";
import { AppIcon, type IconName } from "../icons/AppIcon";

/** 编辑态按住多久后允许拖动（短划优先让轨道滚动，避免整块磁贴抢走横向手势） */
const DRAG_HOLD_MS = 220;

/**
 * 上一次的横向滚动位置（进程内存，不写库、不绑定入口配置）。
 * 首页短暂切走再回来时回到原处；冷启动或配置变化后由 clampRailOffset 修正。
 */
let rememberedRailOffset = 0;

/**
 * 轨道上下留白：编辑态磁贴的右上角 ×（top: -6）与拖拽阴影会超出磁贴本身，
 * ScrollView 又会裁剪子视图，所以把留白放进 contentContainer，而不是放在外层容器上。
 */
const RAIL_EDGE_PAD = 6;

export function WorkbenchEntryRail({
  entries,
  editing,
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
  /** 首帧的轨道宽度估计（通栏宽度）；onLayout 量到真实宽度后以实测为准 */
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
  const { fontScale } = useWindowDimensions();
  const [measuredWidth, setMeasuredWidth] = useState(0);
  // 先按页面给的宽度算首帧，量到真实宽度再收敛：两帧都是单行，不会出现「两行然后变一行」
  const width = measuredWidth > 0 ? measuredWidth : Math.max(0, contentWidth);
  const metrics = useMemo(
    () => railMetrics(width, entries.length, fontScale),
    [width, entries.length, fontScale],
  );
  const labelLineHeight = entryTileLineHeight(fontScale);

  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const offsetRef = useRef(0);
  const restoredRef = useRef(false);
  const [dragging, setDragging] = useState<{ index: number; target: number } | null>(null);
  const offset = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const [sheetIndex, setSheetIndex] = useState<number | null>(null);

  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;

  const rememberOffset = useCallback((next: number) => {
    offsetRef.current = next;
    rememberedRailOffset = next;
  }, []);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      offsetRef.current = event.nativeEvent.contentOffset.x;
    },
    [],
  );

  const handleScrollSettled = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      rememberOffset(event.nativeEvent.contentOffset.x);
    },
    [rememberOffset],
  );

  /** 内容尺寸确定后恢复上次位置；不可滚动时归零，避免留下空白 */
  const handleContentSizeChange = useCallback(() => {
    if (!metrics.scrollable) {
      rememberOffset(0);
      scrollRef.current?.scrollTo({ x: 0, animated: false });
      return;
    }
    if (restoredRef.current) return;
    restoredRef.current = true;
    const target = clampRailOffset(rememberedRailOffset, metrics.maxOffset);
    rememberOffset(target);
    scrollRef.current?.scrollTo({ x: target, animated: false });
  }, [metrics.maxOffset, metrics.scrollable, rememberOffset]);

  /**
   * 入口被隐藏 / 排序 / 屏幕变宽后，原偏移可能越界：
   * 只在「当前位置已经不可达」时收敛，合法位置保持不动（不要每次配置变化都跳回开头）。
   */
  useEffect(() => {
    const current = offsetRef.current;
    if (current <= metrics.maxOffset) return;
    const target = clampRailOffset(current, metrics.maxOffset);
    rememberOffset(target);
    scrollRef.current?.scrollTo({ x: target, animated: false });
  }, [metrics.maxOffset, rememberOffset]);

  const beginDrag = useCallback(
    (index: number) => {
      offset.setValue({ x: 0, y: 0 });
      setDragging({ index, target: index });
      onDragActiveChange?.(true);
    },
    [offset, onDragActiveChange],
  );

  const updateDrag = useCallback(
    (index: number, dx: number) => {
      offset.setValue({ x: dx, y: 0 });
      const target = railDropIndex(index, dx, metricsRef.current.step, entriesRef.current.length);
      setDragging((current) =>
        current && current.index === index && current.target === target
          ? current
          : { index, target },
      );
    },
    [offset],
  );

  const endDrag = useCallback(
    (index: number, dx: number, cancelled = false) => {
      onDragActiveChange?.(false);
      offset.setValue({ x: 0, y: 0 });
      setDragging(null);
      if (cancelled) return;
      const current = entriesRef.current;
      if (isTapGesture(dx, 0)) {
        setSheetIndex(index);
        return;
      }
      const target = railDropIndex(index, dx, metricsRef.current.step, current.length);
      if (target === index) return;
      onReorder(
        moveEntryByIndex(
          current.map((entry) => entry.id as EntryId),
          index,
          target,
        ),
      );
    },
    [offset, onDragActiveChange, onReorder],
  );

  const sheetEntry = sheetIndex === null ? null : entries[sheetIndex] ?? null;
  const sheetActions: SheetAction[] = sheetEntry
    ? [
        {
          key: "prev",
          label: "前移一位",
          hint: "在首页轨道里向左挪一个位置",
          disabled: sheetIndex === 0,
        },
        {
          key: "next",
          label: "后移一位",
          hint: "在首页轨道里向右挪一个位置",
          disabled: sheetIndex === entries.length - 1,
        },
        { key: "remove", label: "从工作台移除", tone: "danger", icon: "delete" },
      ]
    : [];

  if (entries.length === 0) return null;

  return (
    <>
      <View
        onLayout={(event) => setMeasuredWidth(event.nativeEvent.layout.width)}
        style={styles.wrapper}
      >
        <ScrollView
          ref={scrollRef}
          horizontal
          style={{ height: metrics.tileHeight + RAIL_EDGE_PAD * 2 }}
          contentContainerStyle={[
            styles.content,
            { height: metrics.tileHeight + RAIL_EDGE_PAD * 2 },
          ]}
          showsHorizontalScrollIndicator={false}
          // 拖拽排序期间关掉轨道滚动，避免同一根手指同时拖磁贴和滚轨道
          scrollEnabled={!dragging}
          // 内容未溢出时不启用吸附，避免 1~4 个入口出现「无意义的一格一格卡顿」
          snapToInterval={metrics.scrollable ? metrics.step : undefined}
          snapToAlignment="start"
          decelerationRate={metrics.scrollable ? "fast" : "normal"}
          onScroll={handleScroll}
          scrollEventThrottle={100}
          onScrollEndDrag={handleScrollSettled}
          onMomentumScrollEnd={handleScrollSettled}
          onContentSizeChange={handleContentSizeChange}
          accessibilityLabel="快捷入口，可左右滑动查看更多"
        >
          <View style={[styles.row, { height: metrics.tileHeight }]}>
            {dragging ? (
              <View
                pointerEvents="none"
                style={[
                  styles.targetSlot,
                  {
                    left: dragging.target * metrics.step,
                    width: metrics.tileWidth,
                    height: metrics.tileHeight,
                    borderColor: tokens.accent,
                  },
                ]}
              />
            ) : null}

            {entries.map((entry, index) => {
              const active = dragging?.index === index;
              // 拖动中：目标区间内的邻居实时让出/补上 step，松手后再提交顺序
              const shift = dragging ? railShiftFor(dragging, index, metrics.step) : 0;
              return (
                <RailCell
                  key={entry.id}
                  width={metrics.tileWidth}
                  shift={shift}
                  raised={active}
                >
                  {editing ? (
                    <EditableRailTile
                      entry={entry}
                      index={index}
                      active={active}
                      offset={active ? offset : null}
                      width={metrics.tileWidth}
                      height={metrics.tileHeight}
                      labelLineHeight={labelLineHeight}
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
                      width={metrics.tileWidth}
                      height={metrics.tileHeight}
                      labelLineHeight={labelLineHeight}
                      onPress={() => onOpen(entry)}
                      onLongPress={onLongPress}
                    />
                  )}
                </RailCell>
              );
            })}
          </View>
        </ScrollView>
      </View>

      <ActionSheet
        visible={sheetEntry !== null}
        title={sheetEntry ? sheetEntry.label : ""}
        subtitle="调整这个入口在首页的位置"
        actions={sheetActions}
        entityLabel="入口操作"
        onAction={(key) => {
          const entry = sheetEntry;
          setSheetIndex(null);
          if (!entry) return;
          if (key === "remove") onRemove(entry);
          else if (key === "prev") onMove(entry, -1);
          else if (key === "next") onMove(entry, 1);
        }}
        onRequestClose={() => setSheetIndex(null)}
      />
    </>
  );
}

/**
 * 拖动中的邻居位移：被拖磁贴跨过的每个位置都让出一个 step，形成实时换位。
 * 只做视觉位移，真正顺序仍在松手时一次性提交。
 */
function railShiftFor(
  drag: { index: number; target: number },
  index: number,
  step: number,
): number {
  if (index === drag.index || drag.target === drag.index) return 0;
  if (drag.index < drag.target && index > drag.index && index <= drag.target) return -step;
  if (drag.index > drag.target && index >= drag.target && index < drag.index) return step;
  return 0;
}

/** 单个磁贴槽位：邻居让位用弹簧过渡，被拖磁贴本身不参与让位（它跟着手指走） */
function RailCell({
  width,
  shift,
  raised,
  children,
}: {
  width: number;
  shift: number;
  raised: boolean;
  children: ReactNode;
}) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(anim, {
      toValue: shift,
      speed: 18,
      bounciness: 0,
      useNativeDriver: true,
    }).start();
  }, [anim, shift]);

  return (
    <Animated.View
      style={{ width, zIndex: raised ? 9 : 0, transform: [{ translateX: anim }] }}
    >
      {children}
    </Animated.View>
  );
}

/**
 * 编辑态磁贴。
 *
 * 触摸分工：整块磁贴点按 = 打开动作表；按住约 220ms 后整块磁贴都可拖动排序；
 * 短划仍交给轨道 ScrollView 滚动。右上角 × 直接移除。
 */
function EditableRailTile({
  entry,
  index,
  active,
  offset,
  width,
  height,
  labelLineHeight,
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
  width: number;
  height: number;
  labelLineHeight: number;
  onBeginDrag: (index: number) => void;
  onUpdateDrag: (index: number, dx: number) => void;
  onEndDrag: (index: number, dx: number, cancelled?: boolean) => void;
  onRemove: () => void;
  /** 读屏激活（TalkBack 双击）：打开前移 / 后移 / 移除动作表 */
  onActivate: () => void;
  shadowStyle: object;
}) {
  const { tokens } = useTheme();
  // 按住计时：只有按住超过 DRAG_HOLD_MS 才允许 PanResponder 接管，
  // 这样短划磁贴仍是滚轨道，整块磁贴都能拖，但不会把横向滚动吃掉。
  const holdRef = useRef(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHold = useCallback(() => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    holdRef.current = false;
  }, []);

  const armHold = useCallback(() => {
    clearHold();
    holdTimer.current = setTimeout(() => {
      holdRef.current = true;
      holdTimer.current = null;
    }, DRAG_HOLD_MS);
  }, [clearHold]);

  useEffect(() => clearHold, [clearHold]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        // 起手不抢触摸：轻点仍走 Pressable，短划仍走轨道 ScrollView
        onStartShouldSetPanResponderCapture: () => false,
        // 按住到时间后整块磁贴接管拖拽
        onMoveShouldSetPanResponderCapture: () => holdRef.current,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          holdRef.current = false;
          onBeginDrag(index);
        },
        onPanResponderMove: (_event, gesture) => onUpdateDrag(index, gesture.dx),
        onPanResponderRelease: (_event, gesture) => {
          clearHold();
          onEndDrag(index, gesture.dx);
        },
        onPanResponderTerminate: () => {
          clearHold();
          onEndDrag(index, 0, true);
        },
      }),
    [index, onBeginDrag, onEndDrag, onUpdateDrag, clearHold],
  );

  return (
    <Animated.View
      {...responder.panHandlers}
      onTouchStart={armHold}
      onTouchEnd={clearHold}
      onTouchCancel={clearHold}
      style={[
        styles.surface,
        { width, height },
        active ? [{ zIndex: 8, opacity: 0.96 }, shadowStyle] : null,
        offset
          ? {
              transform: [
                { translateX: offset.x },
                { translateY: offset.y },
                { scale: 1.04 },
              ],
            }
          : null,
      ]}
    >
      {/* 视觉层不接收触摸，也不进读屏（读屏走下面的整块覆盖层） */}
      <View
        pointerEvents="none"
        accessible={false}
        importantForAccessibility="no-hide-descendants"
      >
        <QuickTile
          icon={entry.icon as IconName}
          label={entry.label}
          width={width}
          height={height}
          labelLineHeight={labelLineHeight}
          onPress={() => undefined}
        />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${entry.label}，正在编辑`}
        accessibilityHint="点按打开前移、后移与移除选项；按住磁贴拖动排序"
        accessibilityActions={[{ name: "activate", label: "打开入口操作" }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "activate") onActivate();
        }}
        onPress={onActivate}
        style={StyleSheet.absoluteFill}
      />

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`从工作台移除${entry.label}`}
        onPress={onRemove}
        // 视觉 22×22，命中区扩到 46×46（≥ 44 的最小可点尺寸）
        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        style={({ pressed }) => [
          styles.remove,
          { backgroundColor: tokens.dangerSoft, opacity: active ? 1 : pressed ? 0.7 : 1 },
        ]}
      >
        <AppIcon name="close" color={tokens.danger} size={12} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // 通栏：抵消页面左右留白，滑动时磁贴可以贴到屏幕边缘；
  // 上下留白放在 contentContainer（ScrollView 会裁剪超出自身边界的内容，× 不能被切掉）。
  wrapper: {
    marginHorizontal: -space.lg,
  },
  content: {
    flexDirection: "row",
    paddingHorizontal: RAIL_INSET,
    paddingVertical: RAIL_EDGE_PAD,
    alignItems: "flex-start",
  },
  row: {
    flexDirection: "row",
    gap: space.sm,
    position: "relative",
    alignItems: "flex-start",
  },
  targetSlot: {
    position: "absolute",
    top: 0,
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
});
