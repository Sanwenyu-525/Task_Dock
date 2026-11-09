// 键盘高度：Android 15+ 强制 edge-to-edge 后集成的 adjustResize 不再收缩窗口，
// KeyboardAvoidingView 的 height/padding 行为在真机（Android 16）上实测无效——
// 底部工具栏会被键盘整个盖住。这里统一改为自己听键盘高度，由屏幕决定让位方式。
// BottomSheet（Modal 窗口）与需要底部工具栏/输入区的页面共用同一份实现。
import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

export function useKeyboardHeight(enabled = true): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setHeight(0);
      return;
    }
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSub = Keyboard.addListener(showEvent, (event) =>
      setHeight(event.endCoordinates.height),
    );
    const hideSub = Keyboard.addListener(hideEvent, () => setHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [enabled]);

  return height;
}
