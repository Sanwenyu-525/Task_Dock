// 图片灯箱：Modal 全屏查看本机图片素材，支持左右滑动切换多图。
//
// 约束（设计系统第 7 节）：
// - 恒暗 ink 底，图片 contain；顶部关闭按钮 44dp（onInk），底部页码 onInkMuted；
// - 只用 RN 自带 FlatList 横向分页，不引入手势/缩放第三方库；
// - 点背景关闭；系统开启减少动态效果时不做额外动画。
import { useEffect, useRef, useState } from "react";
import {
  Dimensions,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";

import { useWindowInsets } from "../lib/insets";
import { useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

import { AppIcon } from "./icons/AppIcon";

export interface LightboxImage {
  uri: string;
  name?: string;
}

const SCREEN_WIDTH = Dimensions.get("window").width;

export function ImageLightbox({
  visible,
  images,
  initialIndex,
  onClose,
}: {
  visible: boolean;
  images: LightboxImage[];
  initialIndex: number;
  onClose: () => void;
}) {
  const { tokens } = useTheme();
  const insets = useWindowInsets();
  const reduceMotion = useReduceMotion();
  const listRef = useRef<FlatList<LightboxImage>>(null);
  const [index, setIndex] = useState(initialIndex);

  const safeIndex = Math.min(Math.max(initialIndex, 0), Math.max(images.length - 1, 0));

  // 每次打开定位到 initialIndex；减少动态效果时直接跳位，不做滚动动画。
  useEffect(() => {
    if (!visible) return;
    setIndex(safeIndex);
    listRef.current?.scrollToOffset({
      offset: safeIndex * SCREEN_WIDTH,
      animated: false,
    });
  }, [visible, safeIndex]);

  if (!visible || images.length === 0) return null;

  const onMomentumScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(event.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    setIndex(Math.min(Math.max(next, 0), images.length - 1));
  };

  const current = images[index];

  return (
    <Modal
      visible
      transparent={false}
      animationType={reduceMotion ? "none" : "fade"}
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View style={[styles.root, { backgroundColor: tokens.ink }]}>
        <FlatList
          ref={listRef}
          data={images}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={safeIndex}
          keyExtractor={(item, itemIndex) => `${item.uri}-${itemIndex}`}
          getItemLayout={(_, itemIndex) => ({
            length: SCREEN_WIDTH,
            offset: SCREEN_WIDTH * itemIndex,
            index: itemIndex,
          })}
          onMomentumScrollEnd={onMomentumScrollEnd}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={item.name ?? "查看图片"}
              onPress={onClose}
              style={styles.page}
            >
              <Image
                source={{ uri: item.uri }}
                resizeMode="contain"
                style={styles.image}
                accessibilityIgnoresInvertColors
              />
            </Pressable>
          )}
        />

        <View
          style={[
            styles.topBar,
            { paddingTop: insets.top + space.sm, paddingHorizontal: space.md },
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭图片"
            onPress={onClose}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            style={({ pressed }) => [styles.close, { opacity: pressed ? 0.6 : 1 }]}
          >
            <AppIcon name="close" color={tokens.onInk} size={24} />
          </Pressable>
        </View>

        <View
          style={[
            styles.footer,
            { paddingBottom: insets.bottom + space.md },
          ]}
        >
          {current?.name ? (
            <Text numberOfLines={1} style={[styles.name, { color: tokens.onInkMuted }]}>
              {current.name}
            </Text>
          ) : null}
          <Text style={[styles.pageCount, { color: tokens.onInkMuted }]}>
            {index + 1} / {images.length}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  page: {
    width: SCREEN_WIDTH,
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  image: { width: "100%", height: "100%" },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  close: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    gap: space.xs,
    paddingHorizontal: space.lg,
  },
  name: {
    maxWidth: SCREEN_WIDTH - space.lg * 2,
    fontSize: font.meta,
    textAlign: "center",
  },
  pageCount: {
    fontSize: font.meta,
    fontWeight: "600",
  },
});
