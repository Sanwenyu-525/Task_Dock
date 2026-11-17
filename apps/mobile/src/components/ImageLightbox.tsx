// 图片灯箱：Modal 全屏查看本机图片素材，支持左右滑动切换多图。
//
// 约束（设计系统第 7 节）：
// - 恒暗 ink 底，图片 contain；顶部关闭按钮 44dp（onInk），底部页码 onInkMuted；
// - 只用 RN 自带 FlatList 横向分页，不引入手势/缩放第三方库；
// - 点背景关闭；系统开启减少动态效果时不做额外动画。
import { useCallback, useEffect, useRef, useState, type ElementRef } from "react";
import {
  Dimensions,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";

import { useWindowInsets } from "../lib/insets";
import { useReduceMotion } from "../theme/MotionProvider";
import { useTheme } from "../theme/ThemeProvider";
import { font, space } from "../theme/tokens";

import { AppIcon } from "./icons/AppIcon";

export interface LightboxImage {
  /** 优先展示的高清资源（素材详情的原图 / 处理后的高清文件） */
  uri: string;
  /** 高清资源不可读时的降级资源（列表缩略图）；不得反过来优先使用 */
  fallbackUri?: string;
  name?: string;
}

const SCREEN_WIDTH = Dimensions.get("window").width;

/**
 * 单页图片：先加载高清资源，读取失败才降级到缩略图，并把降级结果上报给灯箱页脚，
 * 避免用户把压缩缩略图误认为原图。
 */
function LightboxPage({
  item,
  onClose,
  onResolved,
}: {
  item: LightboxImage;
  onClose: () => void;
  onResolved: (primaryUri: string, resolvedUri: string, degraded: boolean) => void;
}) {
  const [uri, setUri] = useState(item.uri);
  const degraded = uri !== item.uri;

  useEffect(() => {
    setUri(item.uri);
  }, [item.uri]);

  useEffect(() => {
    onResolved(item.uri, uri, degraded);
  }, [degraded, item.uri, onResolved, uri]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.name ?? "查看图片"}
      onPress={onClose}
      style={styles.page}
    >
      <Image
        source={{ uri }}
        resizeMode="contain"
        style={styles.image}
        accessibilityIgnoresInvertColors
        onError={() => {
          if (item.fallbackUri && uri !== item.fallbackUri) setUri(item.fallbackUri);
        }}
      />
    </Pressable>
  );
}

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
  const zoomRef = useRef<ElementRef<typeof ScrollView>>(null);
  const [index, setIndex] = useState(initialIndex);
  // 不引入手势库：用「放大 / 还原」按钮 + 双向可平移的大画布实现原图查看。
  // 放大时暂停横向翻页，避免两套手势争抢；还原后可继续左右滑动。
  const [zoomed, setZoomed] = useState(false);
  const [viewport, setViewport] = useState({ width: SCREEN_WIDTH, height: 0 });
  /** 每页实际解析到的地址与是否已降级：放大必须用真正加载成功的那个地址 */
  const [resolved, setResolved] = useState<Record<string, { uri: string; degraded: boolean }>>({});

  const safeIndex = Math.min(Math.max(initialIndex, 0), Math.max(images.length - 1, 0));

  // 每次打开定位到 initialIndex；减少动态效果时直接跳位，不做滚动动画。
  useEffect(() => {
    if (!visible) return;
    setIndex(safeIndex);
    setZoomed(false);
    listRef.current?.scrollToOffset({
      offset: safeIndex * SCREEN_WIDTH,
      animated: false,
    });
  }, [visible, safeIndex]);

  if (!visible || images.length === 0) return null;

  const onMomentumScrollEnd = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(event.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    setIndex(Math.min(Math.max(next, 0), images.length - 1));
    setZoomed(false);
  };

  const current = images[index];
  const resolvedCurrent = current ? resolved[current.uri] : undefined;
  const currentUri = resolvedCurrent?.uri ?? current?.uri ?? "";
  const currentDegraded = resolvedCurrent?.degraded ?? false;
  const zoomScale = 2.5;
  const zoomedWidth = viewport.width * zoomScale;
  const zoomedHeight = Math.max(1, viewport.height) * zoomScale;

  const handleResolved = useCallback(
    (primaryUri: string, actualUri: string, degraded: boolean) => {
      setResolved((prev) => {
        const existing = prev[primaryUri];
        if (existing && existing.uri === actualUri && existing.degraded === degraded) {
          return prev;
        }
        return { ...prev, [primaryUri]: { uri: actualUri, degraded } };
      });
    },
    [],
  );

  const toggleZoom = () => {
    const next = !zoomed;
    setZoomed(next);
    if (next) {
      requestAnimationFrame(() => {
        zoomRef.current?.scrollTo({
          x: (zoomedWidth - viewport.width) / 2,
          y: (zoomedHeight - viewport.height) / 2,
          animated: false,
        });
      });
    }
  };

  return (
    <Modal
      visible
      transparent={false}
      animationType={reduceMotion ? "none" : "fade"}
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View
        style={[styles.root, { backgroundColor: tokens.ink }]}
        onLayout={(event: LayoutChangeEvent) => {
          const { width, height } = event.nativeEvent.layout;
          setViewport({ width, height });
        }}
      >
        {zoomed ? (
          <ScrollView
            ref={zoomRef}
            style={styles.zoomScroll}
            contentContainerStyle={{ width: zoomedWidth, height: zoomedHeight }}
            horizontal
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
            maximumZoomScale={1}
          >
            <Image
              source={{ uri: currentUri }}
              resizeMode="contain"
              style={{ width: zoomedWidth, height: zoomedHeight }}
              accessibilityIgnoresInvertColors
              accessibilityLabel={current?.name ?? "放大的票据原图"}
            />
          </ScrollView>
        ) : (
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
              <LightboxPage item={item} onClose={onClose} onResolved={handleResolved} />
            )}
          />
        )}

        <View
          style={[
            styles.topBar,
            { paddingTop: insets.top + space.sm, paddingHorizontal: space.md },
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={zoomed ? "还原图片大小" : "放大图片"}
            onPress={toggleZoom}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            style={({ pressed }) => [
              styles.zoomButton,
              { backgroundColor: tokens.inkScrim, opacity: pressed ? 0.6 : 1 },
            ]}
          >
            <Text style={[styles.zoomText, { color: tokens.onInk }]}>
              {zoomed ? "还原" : "放大"}
            </Text>
          </Pressable>
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
          {currentDegraded ? (
            <Text style={[styles.degraded, { color: tokens.warn }]}>
              高清原图不可读，当前显示缩略图预览
            </Text>
          ) : null}
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
  zoomScroll: { flex: 1 },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  zoomButton: {
    minHeight: 34,
    minWidth: 58,
    paddingHorizontal: space.md,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  zoomText: { fontSize: font.label, fontWeight: "700" },
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
  degraded: {
    fontSize: font.label,
    fontWeight: "600",
    textAlign: "center",
  },
  pageCount: {
    fontSize: font.meta,
    fontWeight: "600",
  },
});
