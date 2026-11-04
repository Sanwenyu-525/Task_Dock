import { useEffect, useRef, useState } from "react";
import { avatarHue, navAppIcon } from "../../lib/navigation";

export interface AppIconProps {
  /** 已保存目标传 targetId；扫描结果传 appKey。两者都不传时只显示回退图标。 */
  targetId?: string;
  appKey?: string;
  name: string;
  size?: number;
  /** URL / 文件夹等没有可执行文件的目标不需要请求图标。 */
  enabled?: boolean;
  className?: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_LIMIT = 512;
const cache = new Map<string, { url: string | null; at: number }>();
const inflight = new Map<string, Promise<string | null>>();

/** 缓存命中才算命中：超过 TTL 或超过上限就重新请求，避免应用升级后长期显示旧图标。 */
function readCache(key: string): string | null | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry.url;
}

function writeCache(key: string, url: string | null) {
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, { url, at: Date.now() });
}

function loadIcon(key: string, identity: { targetId?: string; appKey?: string }) {
  const cached = readCache(key);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }
  const existing = inflight.get(key);
  if (existing) return existing;
  const task = navAppIcon(identity)
    .then((url) => {
      writeCache(key, url);
      return url as string | null;
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
  name,
  size = 26,
  enabled = true,
  className = "",
}: AppIconProps) {
  const key = targetId ? `target:${targetId}` : appKey ? `app:${appKey}` : null;
  const identityRef = useRef({ targetId, appKey });
  identityRef.current = { targetId, appKey };
  const [url, setUrl] = useState<string | null>(() =>
    key ? readCache(key) ?? null : null,
  );

  useEffect(() => {
    if (!key) {
      setUrl(null);
      return;
    }
    const cached = readCache(key);
    if (cached !== undefined) {
      setUrl(cached);
      return;
    }
    setUrl(null);
    if (!enabled) return;
    let cancelled = false;
    void loadIcon(key, identityRef.current).then((value) => {
      if (!cancelled) setUrl(value);
    });
    return () => {
      cancelled = true;
    };
  }, [key, enabled]);

  const initial = (name.trim()[0] ?? "?").toUpperCase();
  const hue = avatarHue(key ?? name);
  return (
    <span
      className={`app-icon ${url ? "is-loaded" : ""} ${className}`.trim()}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(5, Math.round(size * 0.2)),
        fontSize: Math.max(10, Math.round(size * 0.46)),
        background: url ? "transparent" : `hsl(${hue} 58% 45%)`,
      }}
      aria-hidden="true"
    >
      {!url && <span className="app-icon-letter">{initial}</span>}
      {url && (
        <img
          className="app-icon-img"
          src={url}
          alt=""
          draggable={false}
          onError={() => {
            writeCache(key ?? name, null);
            setUrl(null);
          }}
        />
      )}
    </span>
  );
}
