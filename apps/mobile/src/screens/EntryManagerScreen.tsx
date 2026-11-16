// 工作台入口管理（2026-11-15）：已显示 / 未显示 / 暂不可用三个区域 + 搜索 + 批量 + 拖拽 + 恢复默认。
//
// 同一个屏幕承担两个入口：
// - 路由 entry_manager 打开「布局管理」：改显示与顺序；
// - 路由 all_features 打开「全部功能」：按分类浏览全部注册入口，点可用行直接进页面，
//   未显示行可以就地加回工作台。
// 两者共用同一份配置（lib/entryLayoutStore），不存在第二套入口清单。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import type { ReactNode } from "react";

import { AppBar } from "../components/AppBar";
import { ActionSheet, type SheetAction } from "../components/ActionSheet";
import { Badge } from "../components/Badge";
import { BULK_ACTION_BAR_HEIGHT, BulkActionBar } from "../components/BulkActionBar";
import { GlassCard } from "../components/GlassCard";
import { IconTile } from "../components/IconTile";
import { PressableScale } from "../components/PressableScale";
import { SearchField } from "../components/SearchField";
import { SectionHeader } from "../components/SectionHeader";
import { SegmentedControl } from "../components/SegmentedControl";
import { GripDots } from "../components/entry/GripDots";
import { useToast } from "../feedback/ToastProvider";
import { AppIcon, type IconName } from "../components/icons/AppIcon";
import { moveEntryByIndex, mergeEntryOrder } from "../lib/entryLayout";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  availableEntries,
  entriesForIds,
  entryTargetOf,
  unavailableEntries,
  type EntryId,
  type MobileEntry,
} from "../lib/entryRegistry";
import {
  commitEntriesVisibility,
  commitEntryMove,
  commitEntryOrder,
  commitEntryVisibility,
  resetEntryLayout,
  useEntryLayout,
} from "../lib/entryLayoutStore";
import { settleReorder } from "../lib/entryReorder";
import { describeError } from "../lib/errors";
import type { AppNav } from "../lib/nav";
import { useTheme } from "../theme/ThemeProvider";
import { font, radius, space } from "../theme/tokens";

type ManagerView = "layout" | "all";
type RowStatus = "visible" | "hidden" | "unavailable";

const VIEW_OPTIONS = [
  { value: "layout" as const, label: "布局管理" },
  { value: "all" as const, label: "全部功能" },
];

/** 行高下限：拖动按行高步进计算，行必须等高（文本用 numberOfLines 截断） */
const ROW_MIN_HEIGHT = 72;
/** 拖动手柄占位宽度（选择模式隐藏手柄时仍保留，行文字不跳位） */
const HANDLE_ZONE = 44;

export function EntryManagerScreen({
  nav,
  onBack,
  initialView = "layout",
}: {
  nav: AppNav;
  onBack: () => void;
  /** 进入时先显示哪个视图：入口管理页 → layout，全部功能页 → all */
  initialView?: ManagerView;
}) {
  const { tokens } = useTheme();
  const layout = useEntryLayout();
  // 720×1600 / 320dp 窄屏：图标 36 + 简介两行会把名称挤成省略号。
  // 这里只调整信息层级（收起简介、收紧间距），不缩小字号、不改行高基线。
  const { width } = useWindowDimensions();
  const compact = width < 360;

  const [view, setView] = useState<ManagerView>(initialView);
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<EntryId[]>([]);
  const [dragActive, setDragActive] = useState(false);

  const { showToast } = useToast();

  /** 读取配置时发现的问题只在进入时提示一次，修好之后不再常驻一条警告 */
  const noticeRef = useRef<string | null>(null);
  if (noticeRef.current === null) {
    noticeRef.current = layout.corrupt
      ? "入口配置已损坏，已恢复默认布局"
      : layout.readFailed
        ? `读取入口配置失败，当前使用默认布局${layout.readError ? `（${layout.readError}）` : ""}`
        : layout.migrated
          ? "入口配置已按新版本升级，原有选择全部保留"
          : layout.dropped > 0
            ? `已清理 ${layout.dropped} 个失效入口`
            : "";
  }
  const notice = noticeRef.current;

  const available = useMemo(() => availableEntries(), []);
  const unavailable = useMemo(() => unavailableEntries(), []);

  const visibleIds = layout.config.visible;
  const hiddenIds = useMemo(
    () =>
      available
        .map((entry) => entry.id as EntryId)
        .filter((id) => !visibleIds.includes(id)),
    [available, visibleIds],
  );
  const hiddenEntries = useMemo(() => entriesForIds(hiddenIds), [hiddenIds]);

  /** 本地顺序：拖拽过程中先本地换位，松手才写一次库（避免连续拖拽刷满写队列） */
  const [order, setOrder] = useState<EntryId[]>(visibleIds);
  const orderRef = useRef<EntryId[]>(visibleIds);
  const draggingRef = useRef(false);
  const applyOrder = useCallback((next: EntryId[]) => {
    orderRef.current = next;
    setOrder(next);
  }, []);
  useEffect(() => {
    if (draggingRef.current) return;
    applyOrder(visibleIds);
  }, [applyOrder, visibleIds]);

  const orderedVisible = useMemo(() => entriesForIds(order), [order]);
  const orderSet = useMemo(() => new Set<EntryId>(order), [order]);

  // —— 拖拽状态 ——
  const [dragId, setDragId] = useState<string | null>(null);
  const translate = useRef(new Animated.Value(0)).current;
  const rowHeightRef = useRef(new Map<string, number>());
  const dragRef = useRef<{ id: string; swaps: number; rowStep: number } | null>(null);

  const handleDragStart = useCallback(
    (entry: MobileEntry) => {
      draggingRef.current = true;
      dragRef.current = {
        id: entry.id,
        swaps: 0,
        rowStep: rowHeightRef.current.get(entry.id) ?? ROW_MIN_HEIGHT,
      };
      setDragId(entry.id);
      setDragActive(true);
      translate.setValue(0);
    },
    [translate],
  );

  const handleDragMove = useCallback(
    (entry: MobileEntry, dy: number) => {
      const drag = dragRef.current;
      if (!drag || drag.id !== entry.id) return;
      const current = orderRef.current.indexOf(entry.id as EntryId);
      if (current < 0) return;
      const settled = settleReorder(
        current,
        dy,
        drag.swaps,
        drag.rowStep,
        orderRef.current.length,
      );
      drag.swaps = settled.swaps;
      translate.setValue(dy - settled.swaps * drag.rowStep);
      if (settled.moved) {
        applyOrder(moveEntryByIndex(orderRef.current, current, settled.index));
      }
    },
    [applyOrder, translate],
  );

  const handleDragEnd = useCallback(async () => {
    draggingRef.current = false;
    const hadDrag = dragRef.current !== null;
    dragRef.current = null;
    setDragId(null);
    setDragActive(false);
    translate.setValue(0);
    if (!hadDrag) return;

    const desired = orderRef.current;
    const persisted = layout.config.visible;
    const same =
      desired.length === persisted.length &&
      desired.every((id, index) => id === persisted[index]);
    if (same) return;

    try {
      await commitEntryOrder(mergeEntryOrder(persisted, desired));
      showToast("已更新工作台顺序");
    } catch (error) {
      applyOrder(persisted);
      showToast(`顺序未保存：${describeError(error)}`, "danger");
    }
  }, [applyOrder, layout.config.visible, showToast, translate]);

  // —— 显示 / 隐藏 ——
  const toggleEntry = useCallback(
    async (entry: MobileEntry, nextVisible: boolean) => {
      try {
        await commitEntryVisibility(entry.id as EntryId, nextVisible);
        showToast(
          nextVisible
            ? `已把「${entry.label}」加到工作台`
            : `已把「${entry.label}」从工作台移除`,
        );
        if (!nextVisible) {
          setSelected((current) => current.filter((id) => id !== entry.id));
        }
      } catch (error) {
        showToast(`未保存：${describeError(error)}`, "danger");
      }
    },
    [showToast],
  );

  const moveEntry = useCallback(
    async (entry: MobileEntry, delta: number) => {
      try {
        await commitEntryMove(entry.id as EntryId, delta);
      } catch (error) {
        showToast(`顺序未保存：${describeError(error)}`, "danger");
      }
    },
    [showToast],
  );

  const handleReset = useCallback(async () => {
    try {
      await resetEntryLayout();
      setSelected([]);
      showToast("已恢复默认布局");
    } catch (error) {
      showToast(`恢复失败：${describeError(error)}`, "danger");
    }
  }, [showToast]);

  const applyBulk = useCallback(
    async (targetIds: EntryId[], nextVisible: boolean) => {
      if (targetIds.length === 0) return;
      try {
        await commitEntriesVisibility(targetIds, nextVisible);
        setSelected([]);
        showToast(
          nextVisible
            ? `已添加 ${targetIds.length} 个入口`
            : `已移除 ${targetIds.length} 个入口`,
        );
      } catch (error) {
        showToast(`未保存：${describeError(error)}`, "danger");
      }
    },
    [showToast],
  );

  // —— 打开某个入口（全部功能视图） ——
  const openEntry = useCallback(
    (entry: MobileEntry) => {
      const launch = entryTargetOf(entry);
      if (!launch) {
        showToast(`「${entry.label}」移动端暂不可用：${entry.reason ?? "没有可用入口"}`, "warn");
        return;
      }
      if (launch.kind === "route") {
        nav.push(launch.route);
        return;
      }
      // 管理页是压在 Tab 之上的二级页：切 Tab / 打开新建任务面板之前必须先退回，
      // 否则页面仍被管理页盖住，用户看到的是「点了没反应」。
      onBack();
      if (launch.kind === "tab") nav.openTab(launch.tab);
      else nav.openCreateTask();
    },
    [nav, onBack, showToast],
  );

  // —— 搜索 ——
  const normalizedQuery = query.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (normalizedQuery.length === 0) return [];
    return [...available, ...unavailable].filter((entry) =>
      [entry.label, entry.description, entry.reason ?? "", CATEGORY_LABELS[entry.category]]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [available, unavailable, normalizedQuery]);

  const toggleSelect = useCallback((id: EntryId) => {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }, []);

  /** 已显示行的动作表：给不方便拖动时一条稳定路径（上移 / 下移 / 移除） */
  const [entrySheetId, setEntrySheetId] = useState<string | null>(null);
  const sheetIndex =
    entrySheetId === null ? -1 : orderedVisible.findIndex((entry) => entry.id === entrySheetId);
  const sheetEntry = sheetIndex >= 0 ? orderedVisible[sheetIndex] : null;
  const sheetActions: SheetAction[] = [
    { key: "up", label: "上移一位", icon: "chevronUp", disabled: sheetIndex <= 0 },
    {
      key: "down",
      label: "下移一位",
      icon: "chevronDown",
      disabled: sheetIndex < 0 || sheetIndex >= orderedVisible.length - 1,
    },
    { key: "remove", label: "从工作台移除", icon: "delete", tone: "danger" },
  ];

  const selectedVisibleCount = selected.filter((id) => orderSet.has(id)).length;
  const selectedHiddenCount = selected.length - selectedVisibleCount;

  const selectionMark = (entry: MobileEntry) => {
    if (!selecting) return null;
    const checked = selected.includes(entry.id as EntryId);
    return (
      <View
        style={[
          styles.check,
          {
            borderColor: checked ? tokens.accent : tokens.cardBorder,
            backgroundColor: checked ? tokens.accentFill : "transparent",
          },
        ]}
      >
        {checked ? <AppIcon name="check" color={tokens.onAccent} size={14} /> : null}
      </View>
    );
  };

  const actionButton = (
    _entry: MobileEntry,
    label: string,
    icon: IconName,
    onPress: () => void,
    tone: "accent" | "danger" = "accent",
  ) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      style={({ pressed }) => [styles.action, { opacity: pressed ? 0.6 : 1 }]}
    >
      <AppIcon name={icon} color={tone === "danger" ? tokens.danger : tokens.accent} size={20} />
    </Pressable>
  );

  const rowFor = (
    entry: MobileEntry,
    status: RowStatus,
    options: { onPress?: () => void; trailing?: ReactNode } = {},
  ) => (
    <EntryManageRow
      entry={entry}
      status={status}
      compact={compact}
      onPress={options.onPress}
      trailing={options.trailing}
    />
  );

  const statusOf = (entry: MobileEntry): RowStatus =>
    !available.some((item) => item.id === entry.id)
      ? "unavailable"
      : orderSet.has(entry.id as EntryId)
        ? "visible"
        : "hidden";

  return (
    <View style={styles.root}>
      <AppBar
        title={view === "layout" ? "功能入口" : "全部功能"}
        onBack={onBack}
        right={
          view === "layout" && !selecting ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="批量管理入口"
              onPress={() => {
                setSelecting(true);
                setSelected([]);
              }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={({ pressed }) => [styles.textAction, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Text style={[styles.textActionLabel, { color: tokens.accentText }]}>批量</Text>
            </Pressable>
          ) : null
        }
      />

      <ScrollView
        scrollEnabled={!dragActive}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.content,
          { paddingBottom: selecting ? BULK_ACTION_BAR_HEIGHT + space.xxl : space.xxl },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <SegmentedControl
          options={VIEW_OPTIONS}
          value={view}
          onChange={(next) => {
            setView(next);
            if (next === "all") {
              setSelecting(false);
              setSelected([]);
            }
          }}
          accessibilityLabel="功能入口视图"
        />

        <Text style={[styles.summary, { color: tokens.muted }]}>
          {`已显示 ${order.length} · 未显示 ${hiddenIds.length} · 暂不可用 ${unavailable.length}`}
        </Text>

        {notice ? (
          <View
            style={[
              styles.notice,
              { backgroundColor: tokens.warnSoft, borderColor: tokens.cardBorder },
            ]}
          >
            <AppIcon name="warning" color={tokens.warn} size={16} />
            <Text style={[styles.noticeText, { color: tokens.text }]}>{notice}</Text>
          </View>
        ) : null}

        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="搜索功能名称或简介"
          accessibilityLabel="搜索功能"
        />

        {normalizedQuery.length > 0 ? (
          <View style={styles.section}>
            <SectionHeader icon="search" title={`搜索结果 · ${searchResults.length}`} />
            {searchResults.length === 0 ? (
              <GlassCard style={styles.card}>
                <Text style={[styles.emptyHint, { color: tokens.muted }]}>
                  没有匹配的功能。换个关键词试试，或清空搜索查看全部入口。
                </Text>
              </GlassCard>
            ) : (
              <GlassCard style={styles.card}>
                {searchResults.map((entry, index) => {
                  const status = statusOf(entry);
                  const trailing =
                    status === "unavailable" ? (
                      <Badge label="暂不可用" tone="unimplemented" />
                    ) : selecting ? (
                      selectionMark(entry)
                    ) : status === "visible" ? (
                      actionButton(
                        entry,
                        `从工作台移除${entry.label}`,
                        "close",
                        () => void toggleEntry(entry, false),
                        "danger",
                      )
                    ) : (
                      actionButton(entry, `添加${entry.label}到工作台`, "add", () => {
                        void toggleEntry(entry, true);
                      })
                    );
                  return (
                    <View key={entry.id}>
                      {index > 0 ? (
                        <View style={[styles.divider, { backgroundColor: tokens.separator }]} />
                      ) : null}
                      {rowFor(entry, status, {
                        trailing,
                        onPress: selecting
                          ? status === "unavailable"
                            ? undefined
                            : () => toggleSelect(entry.id as EntryId)
                          : () => openEntry(entry),
                      })}
                    </View>
                  );
                })}
              </GlassCard>
            )}
          </View>
        ) : view === "layout" ? (
          <>
            <View style={styles.section}>
              <SectionHeader icon="check" title={`已显示 · ${order.length}`} />
              {orderedVisible.length === 0 ? (
                <GlassCard style={styles.card}>
                  <View style={styles.emptyBlock}>
                    <Text style={[styles.emptyTitle, { color: tokens.text }]}>
                      工作台当前没有任何入口
                    </Text>
                    <Text style={[styles.emptyHint, { color: tokens.muted }]}>
                      工作台会显示空状态，并保留「全部功能」与「恢复默认」两个出口。
                      从下面的「未显示」里挑几个加回来即可。
                    </Text>
                  </View>
                </GlassCard>
              ) : (
                <GlassCard style={styles.card}>
                  <Text style={[styles.dragHint, { color: tokens.muted }]}>
                    {selecting
                      ? "点按行选择要批量添加或移除的入口。"
                      : "按住左侧手柄拖动排序；点按行可用上移 / 下移 / 移除。"}
                  </Text>
                  {orderedVisible.map((entry, index) => {
                    const dragging = dragId === entry.id;
                    return (
                      <View
                        key={entry.id}
                        style={styles.dragRowWrap}
                        onLayout={(event) => {
                          rowHeightRef.current.set(entry.id, event.nativeEvent.layout.height);
                        }}
                      >
                        {index > 0 ? (
                          <View style={[styles.divider, { backgroundColor: tokens.separator }]} />
                        ) : null}
                        <Animated.View
                          style={
                            dragging
                              ? [
                                  styles.dragSurface,
                                  {
                                    zIndex: 6,
                                    backgroundColor: tokens.card,
                                    transform: [{ translateY: translate }],
                                    borderColor: tokens.cardBorderStrong,
                                  },
                                ]
                              : null
                          }
                        >
                          <View style={styles.managedRow}>
                            {selecting ? (
                              <View style={styles.handleZone} />
                            ) : (
                              <View style={styles.handleZone}>
                                <DragHandle
                                  entry={entry}
                                  onStart={handleDragStart}
                                  onMove={handleDragMove}
                                  onEnd={handleDragEnd}
                                />
                              </View>
                            )}
                            <View style={styles.rowGrow}>
                              {rowFor(entry, "visible", {
                                onPress: selecting
                                  ? () => toggleSelect(entry.id as EntryId)
                                  : () => setEntrySheetId(entry.id),
                                trailing: selecting
                                  ? selectionMark(entry)
                                  : actionButton(
                                      entry,
                                      `从工作台移除${entry.label}`,
                                      "close",
                                      () => void toggleEntry(entry, false),
                                      "danger",
                                    ),
                              })}
                            </View>
                          </View>
                        </Animated.View>
                      </View>
                    );
                  })}
                </GlassCard>
              )}
            </View>

            <View style={styles.section}>
              <SectionHeader icon="add" title={`未显示 · ${hiddenEntries.length}`} />
              {hiddenEntries.length === 0 ? (
                <GlassCard style={styles.card}>
                  <Text style={[styles.emptyHint, { color: tokens.muted }]}>
                    所有可用功能都已经在工作台上。
                  </Text>
                </GlassCard>
              ) : (
                <GlassCard style={styles.card}>
                  {hiddenEntries.map((entry, index) => (
                    <View key={entry.id}>
                      {index > 0 ? (
                        <View style={[styles.divider, { backgroundColor: tokens.separator }]} />
                      ) : null}
                      {rowFor(entry, "hidden", {
                        trailing: selecting
                          ? selectionMark(entry)
                          : actionButton(entry, `添加${entry.label}到工作台`, "add", () => {
                              void toggleEntry(entry, true);
                            }),
                        onPress: selecting ? () => toggleSelect(entry.id as EntryId) : undefined,
                      })}
                    </View>
                  ))}
                </GlassCard>
              )}
            </View>

            <View style={styles.section}>
              <SectionHeader icon="lock" title={`暂不可用 · ${unavailable.length}`} />
              <GlassCard style={styles.card}>
                {unavailable.map((entry, index) => (
                  <View key={entry.id}>
                    {index > 0 ? (
                      <View style={[styles.divider, { backgroundColor: tokens.separator }]} />
                    ) : null}
                    {rowFor(entry, "unavailable", {
                      trailing: <Badge label="暂不可用" tone="unimplemented" />,
                      onPress: () => openEntry(entry),
                    })}
                  </View>
                ))}
              </GlassCard>
              <Text style={[styles.footnote, { color: tokens.muted }]}>
                暂不可用是移动端能力缺失，不是被你隐藏；它们不会出现在工作台，也无法被添加。
              </Text>
            </View>

            <View style={styles.footer}>
              <PressableScale
                onPress={() => void handleReset()}
                accessibilityLabel="恢复默认布局"
                accessibilityHint="只保留采集、新建任务、工作区、素材暂存与工具面板"
                style={styles.resetPress}
                contentStyle={[
                  styles.reset,
                  { backgroundColor: tokens.card, borderColor: tokens.cardBorder },
                ]}
                scaleTo={0.98}
              >
                <AppIcon name="refresh" color={tokens.accent} size={18} />
                <Text style={[styles.resetLabel, { color: tokens.accentText }]}>恢复默认布局</Text>
              </PressableScale>
              <Text style={[styles.footnote, { color: tokens.muted }]}>
                所有修改立即保存，退出页面再进来仍然是这套配置。
              </Text>
            </View>
          </>
        ) : (
          <>
            {CATEGORY_ORDER.map((category) => {
              const entries = available.filter((entry) => entry.category === category);
              if (entries.length === 0) return null;
              return (
                <View key={category} style={styles.section}>
                  <SectionHeader icon="list" title={CATEGORY_LABELS[category]} />
                  <GlassCard style={styles.card}>
                    {entries.map((entry, index) => {
                      const shown = orderSet.has(entry.id as EntryId);
                      return (
                        <View key={entry.id}>
                          {index > 0 ? (
                            <View style={[styles.divider, { backgroundColor: tokens.separator }]} />
                          ) : null}
                          {rowFor(entry, shown ? "visible" : "hidden", {
                            trailing: shown ? (
                              <Badge label="已显示" tone="active" />
                            ) : (
                              actionButton(entry, `添加${entry.label}到工作台`, "add", () => {
                                void toggleEntry(entry, true);
                              })
                            ),
                            onPress: () => openEntry(entry),
                          })}
                        </View>
                      );
                    })}
                  </GlassCard>
                </View>
              );
            })}

            <View style={styles.section}>
              <SectionHeader icon="lock" title={`暂不可用 · ${unavailable.length}`} />
              <GlassCard style={styles.card}>
                {unavailable.map((entry, index) => (
                  <View key={entry.id}>
                    {index > 0 ? (
                      <View style={[styles.divider, { backgroundColor: tokens.separator }]} />
                    ) : null}
                    {rowFor(entry, "unavailable", {
                      trailing: <Badge label="暂不可用" tone="unimplemented" />,
                      onPress: () => openEntry(entry),
                    })}
                  </View>
                ))}
              </GlassCard>
              <Text style={[styles.footnote, { color: tokens.muted }]}>
                暂不可用入口点开只会告诉你缺哪条链路，不会跳进不存在或不完整的页面。
              </Text>
            </View>
          </>
        )}
      </ScrollView>

      {selecting ? (
        <BulkActionBar
          selectedCount={selected.length}
          onCancel={() => {
            setSelecting(false);
            setSelected([]);
          }}
          actions={[
            {
              key: "add",
              label: `添加 ${selectedHiddenCount}`,
              icon: "add",
              disabled: selectedHiddenCount === 0,
              onPress: () =>
                void applyBulk(
                  selected.filter((id) => hiddenIds.includes(id)),
                  true,
                ),
            },
            {
              key: "remove",
              label: `移除 ${selectedVisibleCount}`,
              icon: "close",
              tone: "danger",
              disabled: selectedVisibleCount === 0,
              onPress: () =>
                void applyBulk(
                  selected.filter((id) => orderSet.has(id)),
                  false,
                ),
            },
          ]}
        />
      ) : null}

      <ActionSheet
        visible={sheetEntry !== null}
        title={sheetEntry ? sheetEntry.label : ""}
        subtitle="调整这个入口在工作台的位置"
        entityLabel="入口操作"
        actions={sheetActions}
        onAction={(key) => {
          const entry = sheetEntry;
          setEntrySheetId(null);
          if (!entry) return;
          if (key === "remove") void toggleEntry(entry, false);
          else void moveEntry(entry, key === "up" ? -1 : 1);
        }}
        onRequestClose={() => setEntrySheetId(null)}
      />
    </View>
  );
}

/** 单个入口行：图标 + 名称 + 简介/原因 + 右侧动作 */
function EntryManageRow({
  entry,
  status,
  compact,
  onPress,
  trailing,
}: {
  entry: MobileEntry;
  status: RowStatus;
  compact: boolean;
  onPress?: () => void;
  trailing?: ReactNode;
}) {
  const { tokens } = useTheme();
  // 窄屏：可用行的简介收起（名称优先），暂不可用行保留一行原因——
  // 「为什么不能用」比简介更重要，不能一起藏掉。
  const showHelper = !compact || status === "unavailable";
  const helperLines = compact ? 1 : 2;

  return (
    <PressableScale
      onPress={onPress ?? (() => undefined)}
      disabled={!onPress}
      accessibilityLabel={
        status === "unavailable"
          ? `${entry.label}，移动端暂不可用`
          : `${entry.label}，${status === "visible" ? "已显示在工作台" : "未显示在工作台"}`
      }
      accessibilityHint={entry.description}
      style={styles.rowPress}
      contentStyle={compact ? [styles.row, styles.rowCompact] : styles.row}
      scaleTo={0.99}
    >
      <IconTile
        name={entry.icon as IconName}
        size={36}
        tone={status === "unavailable" ? "neutral" : "primary"}
      />
      <View style={styles.rowText}>
        <Text
          numberOfLines={1}
          style={[
            styles.rowLabel,
            { color: status === "unavailable" ? tokens.muted : tokens.text },
          ]}
        >
          {entry.label}
        </Text>
        {showHelper ? (
          <Text
            numberOfLines={helperLines}
            style={[styles.rowHelper, { color: tokens.muted }]}
          >
            {status === "unavailable" ? entry.reason ?? entry.description : entry.description}
          </Text>
        ) : null}
      </View>
      {trailing}
    </PressableScale>
  );
}

/**
 * 拖拽手柄：只有这一小块接收手势，行内其他区域照常滚动页面。
 * entry 用固定引用、回调走 ref，换位后组件重渲染不会重建 PanResponder（否则拖动中断）。
 */
function DragHandle({
  entry,
  onStart,
  onMove,
  onEnd,
}: {
  entry: MobileEntry;
  onStart: (entry: MobileEntry) => void;
  onMove: (entry: MobileEntry, dy: number) => void;
  onEnd: () => void;
}) {
  const { tokens } = useTheme();
  const callbacks = useRef({ onStart, onMove, onEnd });
  callbacks.current = { onStart, onMove, onEnd };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => callbacks.current.onStart(entry),
        onPanResponderMove: (_event, gesture) => callbacks.current.onMove(entry, gesture.dy),
        onPanResponderRelease: () => callbacks.current.onEnd(),
        onPanResponderTerminate: () => callbacks.current.onEnd(),
      }),
    [entry],
  );

  return (
    <View
      {...responder.panHandlers}
      // 纯拖拽手柄不单独进读屏焦点：入口行本身可聚焦，双击行打开动作表，
      // 用「上移一位 / 下移一位 / 从工作台移除」完成同样操作，避免重复焦点。
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      // 视觉仍是 22×40 的六点手柄；左右各 9 的命中区把它扩到 40dp，
      // 外层 handleZone 44dp 提供容纳空间，且不会压到右侧文字。
      hitSlop={{ top: 8, bottom: 8, left: 9, right: 9 }}
      style={[styles.handle, { backgroundColor: tokens.track, borderColor: tokens.cardBorder }]}
    >
      <GripDots color={tokens.muted} dot={3} gap={3} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    gap: space.md,
  },
  summary: { fontSize: font.meta },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
  noticeText: { flex: 1, fontSize: font.label, lineHeight: 16 },
  section: { gap: space.xs },
  card: { paddingHorizontal: space.md, paddingVertical: space.xxs },
  emptyBlock: { gap: space.xs, paddingVertical: space.md },
  emptyTitle: { fontSize: font.body, fontWeight: "600" },
  emptyHint: { fontSize: font.meta, lineHeight: 20, paddingVertical: space.sm },
  dragHint: { fontSize: font.label, lineHeight: 16, paddingTop: space.sm },
  rowPress: {},
  row: {
    minHeight: ROW_MIN_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.sm,
  },
  // 窄屏收紧图标与文字之间的间距，把宽度让给功能名称（不缩字号）
  rowCompact: { gap: space.sm },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { fontSize: font.body, fontWeight: "600" },
  rowHelper: { fontSize: font.label, lineHeight: 16 },
  divider: { height: StyleSheet.hairlineWidth },
  action: {
    width: 40,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  textAction: {
    minHeight: 44,
    justifyContent: "center",
    paddingLeft: space.md,
  },
  textActionLabel: { fontSize: font.meta, fontWeight: "600" },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  dragRowWrap: { position: "relative" },
  managedRow: { flexDirection: "row", alignItems: "center" },
  rowGrow: { flex: 1 },
  handleZone: {
    width: HANDLE_ZONE,
    alignItems: "center",
    justifyContent: "center",
  },
  dragSurface: {
    marginHorizontal: -space.md,
    paddingHorizontal: space.md,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
  handle: {
    width: 22,
    height: 40,
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  footer: { gap: space.xs, paddingTop: space.xs },
  resetPress: {},
  reset: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
  resetLabel: { fontSize: font.body, fontWeight: "600" },
  footnote: { fontSize: font.label, lineHeight: 16 },
});
