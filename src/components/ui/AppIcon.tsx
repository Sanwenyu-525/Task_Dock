import { useEffect, useRef, useState, type CSSProperties } from "react";
import { avatarHue, navAppIcon, type AppIconData } from "../../lib/navigation";

export interface AppIconProps {
  /** 已保存目标传 targetId；扫描结果传 appKey；窗口选择页可传真实 exePath。 */
  targetId?: string;
  appKey?: string;
  exePath?: string;
  name: string;
  size?: number;
  /** URL / 文件夹等没有可执行文件的目标不需要请求图标。 */
  enabled?: boolean;
  className?: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_LIMIT = 512;
const cache = new Map<string, { icon: AppIconData | null; at: number }>();
const inflight = new Map<string, Promise<AppIconData | null>>();

/** 缓存命中才算命中：超过 TTL 或超过上限就重新请求，避免应用升级后长期显示旧图标。 */
function readCache(key: string): AppIconData | null | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry.icon;
}

function writeCache(key: string, icon: AppIconData | null) {
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, { icon, at: Date.now() });
}

function loadIcon(key: string, identity: { targetId?: string; appKey?: string; exePath?: string }) {
  const cached = readCache(key);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }
  const existing = inflight.get(key);
  if (existing) return existing;
  const task = navAppIcon(identity)
    .then((icon) => {
      writeCache(key, icon);
      return icon;
    })
    .catch(() => {
      // 取不到图标（UWP、权限不足、文件被替换）统一回退到字母图标，不打扰用户。
      writeCache(key, null);
      return null;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, task);
  return task;
}

/**
 * 应用真实图标；后端按需提取并缓存，加载中/失败时使用统一的字母回退。
 * 不在这里轮询：每个身份只请求一次。
 */
export default function AppIcon({
  targetId,
  appKey,
  exePath,
  name,
  size = 26,
  enabled = true,
  className = "",
}: AppIconProps) {
  const normalizedExe = exePath?.trim().toLowerCase() || undefined;
  const key = targetId
    ? `target:${targetId}`
    : appKey
      ? `app:${appKey}`
      : normalizedExe
        ? `exe:${normalizedExe}`
        : null;
  const identityRef = useRef({ targetId, appKey, exePath });
  identityRef.current = { targetId, appKey, exePath };
  const [icon, setIcon] = useState<AppIconData | null>(() =>
    key ? readCache(key) ?? null : null,
  );

  useEffect(() => {
    if (!key) {
      setIcon(null);
      return;
    }
    const cached = readCache(key);
    if (cached !== undefined) {
      setIcon(cached);
      return;
    }
    setIcon(null);
    if (!enabled) return;
    let cancelled = false;
    void loadIcon(key, identityRef.current).then((value) => {
      if (!cancelled) setIcon(value);
    });
    return () => {
      cancelled = true;
    };
  }, [key, enabled]);

  const initial = (name.trim()[0] ?? "?").toUpperCase();
  const hue = avatarHue(key ?? name);
  // 近白/浅色 logo：浅色主题下白底白字几乎不可见。用主题语义色做极轻底衬，
  // 并用低透明度深色描边保证任意底色下都可辨认；彩色/深色图标保持原始外观。
  const light = Boolean(icon?.light);
  // 描边画在图片外侧，父容器 overflow:hidden 会裁掉贴边的阴影；给浅色图标留出
  // 1–2px 内边距，保证轮廓完整可见（彩色/深色图标保持原始尺寸，不外扩）。
  const lightPad = Math.max(1, Math.round(size * 0.08));
  const lightStyle: CSSProperties | undefined = light
    ? {
        filter:
          "drop-shadow(0 0 1px rgba(0, 0, 0, 0.55)) drop-shadow(0 0 1px rgba(0, 0, 0, 0.3))",
      }
    : undefined;
  const lightBoxStyle: CSSProperties | undefined = light
    ? {
        background:
          "color-mix(in srgb, var(--text-primary, #22263c) 14%, transparent)",
        padding: lightPad,
        boxSizing: "border-box",
        boxShadow:
          "inset 0 0 0 1px color-mix(in srgb, var(--text-primary, #22263c) 28%, transparent)",
      }
    : undefined;
  return (
    <span
      className={`app-icon ${icon ? "is-loaded" : ""} ${light ? "is-light" : ""} ${className}`.trim()}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(5, Math.round(size * 0.2)),
        fontSize: Math.max(10, Math.round(size * 0.46)),
        background: icon ? "transparent" : `hsl(${hue} 58% 45%)`,
        ...lightBoxStyle,
      }}
      aria-hidden="true"
    >
      {!icon && <span className="app-icon-letter">{initial}</span>}
      {icon && (
        <img
          className="app-icon-img"
          src={icon.url}
          alt=""
          draggable={false}
          style={lightStyle}
          onError={() => {
            writeCache(key ?? name, null);
            setIcon(null);
          }}
        />
      )}
    </span>
  );
}
