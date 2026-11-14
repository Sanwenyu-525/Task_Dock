// Task Dock 品牌标识：蓝→青渐变圆角方块 + 白色 </> 代码符号。
//
// 品牌标识不是功能图标：不得复用 project / workspace / boxes / folders 等业务语义，
// 也不允许页面各自画一个「差不多」的方块。所有需要展示 App 自身的地方只用这个组件。
// 尺寸按用途取：24 行内、32 次级、46 首页欢迎区、54–64 应用信息卡。
import type { StyleProp, ViewStyle } from "react-native";
import { StyleSheet, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";

import { AppIcon } from "./icons/AppIcon";

export function BrandMark({
  size = 46,
  style,
}: {
  /** 视觉边长（dp） */
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { tokens } = useTheme();
  // 图标约占底块一半：46dp 时 23dp，64dp 时 32dp（自动切到更细的 lg 线宽）
  const iconSize = Math.round(size * 0.5);

  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          // 参考图的圆角约为边长的 28–30%；取整避免不同尺寸出现小数像素
          borderRadius: Math.round(size * 0.29),
          backgroundImage: `linear-gradient(145deg, ${tokens.brandBase} 0%, ${tokens.brandBaseAlt} 100%)`,
        },
        style,
      ]}
    >
      <AppIcon name="brand" size={iconSize} color={tokens.onAccent} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
});
