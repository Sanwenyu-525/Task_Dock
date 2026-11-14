// 功能占位：桌面端已有、移动端尚未接入的能力只保留一个线性图标 + 名称。
// 硬约束：不可点击、不渲染二级页、不写库、不显示任何假数字/假进度。
//
// 视觉口径（第四轮）：占位与真实入口必须一眼可分——真实入口用浅蓝底板 + 蓝线图标，
// 占位用中性底板 + 灰线图标，且不挂徽标、不出现箭头。
import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

import { IconTile } from "./IconTile";
import { type IconName } from "./icons/AppIcon";

type PlaceholderVariant = "stacked" | "compact" | "grid" | "inline";

export function FeatureIconPlaceholder({
  icon,
  label,
  hint = "移动端暂未接入",
  compact = false,
  variant,
  spokenLabel,
}: {
  icon: IconName;
  /** 省略时说明文字单独成行：模块标题已写明名称时不再重复一遍 */
  label?: string;
  /** 视觉名称在窄屏上需要缩写时，给读屏保留完整名称 */
  spokenLabel?: string;
  hint?: string;
  /** @deprecated 使用 variant="compact"；保留是为了兼容既有调用 */
  compact?: boolean;
  /**
   * stacked：图标 + 名称 + 一行说明（仅模块整体需要解释时使用）
   * compact：四列工具图标 + 名称
   * grid：两列工作区图标 + 名称，底板更大
   * inline：横向紧凑占位，用于首页 AI / 协作动态 / 项目空间
   */
  variant?: PlaceholderVariant;
}) {
  const { tokens } = useTheme();
  const resolved: PlaceholderVariant = variant ?? (compact ? "compact" : "stacked");

  if (resolved === "inline") {
    return (
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={label ? `${spokenLabel ?? label}，${hint}` : hint}
        accessibilityState={{ disabled: true }}
        style={styles.inlineWrap}
      >
        <IconTile name={icon} size={36} tone="neutral" />
        <View style={styles.inlineText}>
          {label ? (
            <Text numberOfLines={1} style={[styles.inlineLabel, { color: tokens.muted }]}>
              {label}
            </Text>
          ) : null}
          <Text
            numberOfLines={2}
            style={[label ? styles.inlineHint : styles.inlineHintStrong, { color: tokens.muted }]}
          >
            {hint}
          </Text>
        </View>
      </View>
    );
  }

  const grid = resolved === "grid";
  const compactMode = resolved === "compact";

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`${spokenLabel ?? label}，${hint}`}
      accessibilityState={{ disabled: true }}
      style={[styles.wrap, compactMode ? styles.compactWrap : null, grid ? styles.gridWrap : null]}
    >
      <IconTile
        name={icon}
        size={grid ? 48 : 46}
        tone="neutral"
      />
      <Text
        numberOfLines={compactMode ? 2 : 1}
        style={[
          styles.label,
          { color: tokens.muted },
          compactMode ? styles.compactLabel : null,
          grid ? styles.gridLabel : null,
        ]}
      >
        {label}
      </Text>
      {resolved === "stacked" ? (
        <Text numberOfLines={1} style={[styles.hint, { color: tokens.faint }]}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    gap: 6,
    paddingVertical: space.xs,
    paddingHorizontal: space.xs,
    minHeight: 84,
    justifyContent: "center",
  },
  compactWrap: {
    minHeight: 84,
    gap: 7,
    /** 与 IconEntry 完全同高：同一行里真实入口和占位不能一个高一个矮 */
    paddingVertical: space.sm,
    /** 一行里某个标签折成两行时，其余单元拉伸到同高，图标与标签基线仍对齐 */
    flexGrow: 1,
  },
  gridWrap: {
    minHeight: 92,
    gap: 8,
  },
  inlineWrap: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.xs,
    paddingHorizontal: space.xs,
  },
  inlineText: {
    flex: 1,
    gap: 2,
  },
  inlineLabel: {
    fontSize: font.meta,
    fontWeight: "700",
  },
  inlineHint: {
    fontSize: font.label,
  },
  /** 没有独立标题时，说明行承担主文案，必须比附注更实 */
  inlineHintStrong: {
    fontSize: font.body,
    fontWeight: "600",
    lineHeight: 19,
  },
  label: {
    fontSize: font.meta,
    fontWeight: "600",
    textAlign: "center",
  },
  gridLabel: {
    fontSize: font.meta,
  },
  compactLabel: {
    fontSize: font.label,
    fontWeight: "600",
    lineHeight: 16,
  },
  hint: {
    fontSize: font.label,
    textAlign: "center",
  },
});
