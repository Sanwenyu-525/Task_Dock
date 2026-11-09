// 开关：RN 核心 Switch 包一层 token 配色，避免每个屏幕各写一份颜色映射。
// disabled 态在真机（Android 16）上并不会自动变灰：track 仍是全饱和蓝，
// 规划中的开关会被读成「已启用」。这里显式降透明度并改用中性 track。
import { Switch, View } from "react-native";

import { useTheme } from "../theme/ThemeProvider";

export function ToggleSwitch({
  value,
  onChange,
  disabled = false,
  accessibilityLabel,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  accessibilityLabel: string;
}) {
  const { tokens } = useTheme();

  return (
    <View style={disabled ? { opacity: 0.45 } : null}>
      <Switch
        accessibilityRole="switch"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ checked: value, disabled }}
        disabled={disabled}
        value={value}
        onValueChange={onChange}
        trackColor={{
          false: tokens.track,
          true: disabled ? tokens.track : tokens.accentFill,
        }}
        thumbColor={disabled ? tokens.faint : tokens.onAccent}
        ios_backgroundColor={tokens.track}
      />
    </View>
  );
}
