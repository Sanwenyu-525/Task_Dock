// 主题上下文：模式存 kv 表（跟随系统/浅/深），切换即时生效并持久化。
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useColorScheme } from "react-native";

import { setSetting } from "../db/kv";
import { palette, type ColorScheme, type Palette, type ThemeMode } from "./tokens";

interface ThemeValue {
  mode: ThemeMode;
  scheme: ColorScheme;
  tokens: Palette;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({
  initialMode,
  children,
}: {
  initialMode: ThemeMode;
  children: ReactNode;
}) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>(initialMode);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    // 持久化失败不应阻塞界面切换：下次启动退回默认模式即可
    void setSetting("theme_mode", next);
  }, []);

  const scheme: ColorScheme =
    mode === "system" ? (systemScheme === "dark" ? "dark" : "light") : mode;
  const tokens = useMemo(() => palette(scheme), [scheme]);

  const value = useMemo<ThemeValue>(
    () => ({ mode, scheme, tokens, setMode }),
    [mode, scheme, tokens, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme 必须在 ThemeProvider 内使用");
  return value;
}
