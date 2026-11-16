import { View } from "react-native";

/**
 * 六点拖拽手柄（2 列 × 3 行）。
 * 只做视觉，不接收手势；无障碍标签由外层手柄负责，点阵对读屏隐藏。
 */
export function GripDots({
  color,
  dot = 2,
  gap = 3,
}: {
  color: string;
  dot?: number;
  gap?: number;
}) {
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: "row", gap }}
    >
      {[0, 1].map((column) => (
        <View key={column} style={{ gap }}>
          {[0, 1, 2].map((row) => (
            <View
              key={row}
              style={{
                width: dot,
                height: dot,
                borderRadius: dot / 2,
                backgroundColor: color,
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
