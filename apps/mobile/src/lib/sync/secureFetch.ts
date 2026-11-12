// 安全传输通道：把本地 Expo 原生模块（modules/secure-http）包装成 FetchLike，
// 供同步 / 配对 / 文件互传三处客户端注入。
//
// 设计要点：
// - Android 9+ 禁明文 + 本模块只接受 https:// URL：任何 http:// 请求在客户端
//   即被拒绝（fail-closed），不会再触碰网络；
// - SPKI 固定：Kotlin 侧自定义 X509TrustManager 校验
//   SHA-256(certificate.publicKey.encoded) == pin（64 位小写 hex）。
//   `certificate.publicKey.encoded` 就是证书的 SubjectPublicKeyInfo DER，
//   与桌面端 `mobile_sync::tls` 计算指纹用的是同一份字节；
// - pin 缺省（手动输码配对、或旧连接）时仍是 TLS，但不做指纹比对（首用信任），
//   原生层会把观察到的指纹回传，由配对流程落库后钉住后续连接；
// - 原生模块可注入（工厂第二个参数），单测不需要真机。

import { requireNativeModule } from "expo-modules-core";

import { AppError, toAppError } from "../errors";

import type { FetchInitLike, FetchLike, HttpResponseLike } from "./client";
import { normalizeTlsFingerprint } from "./pairing";

/** 原生模块的 TypeScript 形状（与 SecureHttpModule.kt 的 AsyncFunction 对应）。 */
export interface SecureHttpNative {
  request(options: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
    timeoutMs: number;
    pin: string | null;
    requestId: number;
  }): Promise<{ status: number; body: string; observedFingerprint: string | null }>;
  cancel(requestId: number): void;
  /** 最近一次成功连接观察到的对端 SPKI 指纹（首用信任场景落库用）；无记录为 null。 */
  readonly lastServerFingerprint: string | null;
}

export interface SecureFetchOptions {
  /** SPKI SHA-256（64 位小写 hex）；null/undefined = 不比对（首用信任）。 */
  pin?: string | null;
  /** 单请求超时；默认与同步客户端一致（30s，覆盖大文件分块）。 */
  timeoutMs?: number;
}

let nativeModule: SecureHttpNative | null = null;

/** 惰性获取原生模块；测试通过 createSecureFetch 的第二参注入，不经过这里。 */
function resolveNative(): SecureHttpNative {
  if (nativeModule) return nativeModule;
  nativeModule = requireNativeModule<SecureHttpNative>("SecureHttp");
  return nativeModule;
}

function assertPin(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  const normalized = normalizeTlsFingerprint(value);
  if (!normalized) {
    throw new AppError("validation", "TLS 指纹格式不合法，请重新扫码配对");
  }
  return normalized;
}

function headerRecord(headers?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Expo 原生 Promise 拒绝把 `promise.reject(code, ...)` 的 code 挂在 error.code 上。 */
function isPinMismatch(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: unknown }).code === "E_PIN_MISMATCH";
}

/**
 * 构造一个 FetchLike。与全局 fetch 的差异：
 * - 只接受 https://；http:// 直接抛 validation（提示重新配对）；
 * - AbortSignal 通过 requestId 取消原生请求；
 * - 返回的 HttpResponseLike 只覆盖 JSON 场景（同步协议全部是 JSON 信封）。
 */
export function createSecureFetch(
  options: SecureFetchOptions = {},
  native: SecureHttpNative | null = null,
): FetchLike {
  const pin = assertPin(options.pin);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const impl = native ?? resolveNative();
  let nextRequestId = 1;

  return async (url: string, init: FetchInitLike): Promise<HttpResponseLike> => {
    if (!/^https:\/\//i.test(url)) {
      throw new AppError(
        "validation",
        "桌面端连接必须使用 HTTPS（v2 协议），请升级桌面端并重新扫码配对",
      );
    }
    if (init.signal?.aborted) {
      throw new AppError("network", "请求已取消");
    }

    const requestId = nextRequestId;
    nextRequestId += 1;
    const onAbort = () => impl.cancel(requestId);
    init.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const result = await impl.request({
        url,
        method: init.method ?? "GET",
        headers: headerRecord(init.headers),
        body: init.body ?? null,
        timeoutMs,
        pin,
        requestId,
      });
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        json: async () => JSON.parse(result.body) as unknown,
      };
    } catch (error) {
      if (init.signal?.aborted) {
        throw new AppError("network", "请求已取消");
      }
      if (error instanceof AppError) throw error;
      // 原生层把「证书/指纹不匹配」单独编码：给可操作提示，不把证书细节带进异常链。
      // 连接本身已失败（安全语义成立），这里只改善用户能否理解原因。
      if (isPinMismatch(error)) {
        throw new AppError(
          "validation",
          "桌面端证书指纹不匹配（可能存在中间人），请重新扫码配对",
          error,
        );
      }
      // 原生层拒绝（握手失败/超时）统一收敛为 network/validation，
      // 不把证书字节、URL 参数等细节带进异常链。
      throw toAppError(error, "network");
    } finally {
      init.signal?.removeEventListener("abort", onAbort);
    }
  };
}

/**
 * 延迟解析 pin 的 FetchLike：文件互传客户端构造时可能还没有加载连接元数据，
 * 第一次真正发请求时才读取。解析失败会重置缓存（下次请求重试解析）；
 * 解析成功后缓存的 FetchLike 复用于后续请求。
 */
export function createLazyPinnedFetch(
  loadPin: () => Promise<string | null>,
  native: SecureHttpNative | null = null,
): FetchLike {
  let implPromise: Promise<FetchLike> | null = null;

  function resolve(): Promise<FetchLike> {
    if (!implPromise) {
      implPromise = loadPin().then((pin) => createSecureFetch({ pin }, native));
      // 解析失败（库未开/元数据损坏）时允许下一次请求重试；请求本身的
      // 网络错误发生在 resolve 之后，不会走到这里，缓存的实现仍有效。
      implPromise.catch(() => {
        implPromise = null;
      });
    }
    return implPromise;
  }

  return (url, init) =>
    resolve().then(
      (impl) => impl(url, init),
      (error) => {
        throw toAppError(error, "validation");
      },
    );
}

/**
 * 最近一次成功连接观察到的对端 SPKI 指纹（首用信任）。
 * 仅在生产通道（默认原生模块）有意义；注入 fetchImpl 的测试路径返回 null。
 */
export function lastObservedServerFingerprint(native?: SecureHttpNative | null): string | null {
  const impl = native ?? null;
  if (impl) return impl.lastServerFingerprint ?? null;
  try {
    return resolveNative().lastServerFingerprint ?? null;
  } catch {
    return null;
  }
}
