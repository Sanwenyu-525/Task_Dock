// 设备链路状态：把「配对授权」和「当前网络连接」拆成两个独立状态，并作为三个页面
// （同步页 / 文件互传 / 配对页）唯一的状态来源。
//
// 为什么必须拆开：
// - 配对成功只说明双方交换过令牌与指纹，不代表电脑此刻在线；
// - 用同一个布尔值表达，就会出现「文件互传说连接失败，配对页仍显示已配对」这种自相矛盾，
//   或者因为一次断网就要求用户重新配对（把可恢复的网络问题当成授权失效）。
//
// 状态机约定（不可违反）：
//   normal      : 授权=已配对     连接=在线
//   pc off      : 授权=已配对     连接=离线          ← 不提示重新配对
//   net down    : 授权=已配对     连接=离线/超时      ← 不提示重新配对
//   timeout     : 授权=已配对     连接=连接超时
//   401/403     : 授权=授权失效   连接=不可用        ← 清「在线」，但绝不清配对凭据
//   TLS mismatch: 授权=安全验证异常 连接=不可信        ← 严格失败，禁止绕过
//
// 凭据只由配对/解除配对流程改写；这里任何失败都不会删除令牌或连接元数据。
import { useSyncExternalStore } from "react";

import { deleteSetting, getSetting, setSetting } from "../../db/kv";
import { loadConnection, readToken } from "../../db/syncConnection";

import { isLegacyConnection } from "./connectionState";

/** 配对授权状态（与网络无关） */
export type PairAuthorization = "unpaired" | "paired" | "auth_invalid" | "security_error";

/** 当前网络连接状态（与授权无关） */
export type LinkConnection =
  | "unknown"
  | "checking"
  | "online"
  | "offline"
  | "timeout"
  | "untrusted";

/** 失败分类：与文件列表 / 连接测试的分类结果同构 */
export type LinkFailureKind = "offline" | "timeout" | "auth" | "tls";

export interface LinkState {
  authorization: PairAuthorization;
  connection: LinkConnection;
  /** 最近一次成功连接（ISO）；重新配对成功也会记录 */
  lastSuccessAt: string | null;
  /** 最近一次失败的可读原因；成功后退回 null */
  lastError: string | null;
  lastFailure: LinkFailureKind | null;
  /** 是否已完成一次本地状态恢复（未完成时界面显示「读取中」而不是「未配对」） */
  loaded: boolean;
  /** 状态版本：每次变化自增，便于消费方做旧值比对 */
  rev: number;
}

/** 授权异常的持久标记：401/403 与 TLS 指纹错误必须在重启后仍然可见 */
const AUTH_FLAG_KEY = "sync.link.auth.v1";
const LAST_SUCCESS_KEY = "sync.link.last_success.v1";

type AuthFlag = "invalid" | "security";

function initialState(): LinkState {
  return {
    authorization: "unpaired",
    connection: "unknown",
    lastSuccessAt: null,
    lastError: null,
    lastFailure: null,
    loaded: false,
    rev: 0,
  };
}

let state: LinkState = initialState();
const listeners = new Set<() => void>();
let hydrateTask: Promise<void> | null = null;

function emit(patch: Partial<LinkState>): void {
  state = { ...state, ...patch, rev: state.rev + 1 };
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): LinkState {
  return state;
}

export function getLinkState(): LinkState {
  return state;
}

/** 三个页面共用同一份状态；任何一处上报结果都会立刻反映到另外两处 */
export function useLinkState(): LinkState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

async function readAuthFlag(): Promise<AuthFlag | null> {
  const raw = (await getSetting(AUTH_FLAG_KEY))?.trim();
  return raw === "invalid" || raw === "security" ? raw : null;
}

async function writeAuthFlag(flag: AuthFlag | null): Promise<void> {
  try {
    if (flag) await setSetting(AUTH_FLAG_KEY, flag);
    else await deleteSetting(AUTH_FLAG_KEY);
  } catch {
    // 标记写入失败只影响「重启后能否记住授权异常」，不影响本次会话状态；
    // 绝不因为写标记失败去删除配对凭据。
  }
}

/**
 * 从本地恢复状态（幂等，单飞）。
 * 授权判定顺序：无连接/无令牌 → 未配对；设备不符合当前协议 → 安全验证异常；
 * 持久标记 → 授权失效 / 安全验证异常；否则已配对。
 * 连接状态一律从「未检测」开始：本地有令牌不代表电脑在线。
 */
export function hydrateLinkState(): Promise<void> {
  if (state.loaded) return Promise.resolve();
  if (hydrateTask) return hydrateTask;

  hydrateTask = (async () => {
    const [connection, token, flag, lastSuccess] = await Promise.all([
      loadConnection().catch(() => null),
      readToken().catch(() => null),
      readAuthFlag().catch(() => null),
      getSetting(LAST_SUCCESS_KEY).catch(() => null),
    ]);

    let authorization: PairAuthorization;
    if (!connection || !token) authorization = "unpaired";
    else if (isLegacyConnection(connection)) authorization = "security_error";
    else if (flag === "security") authorization = "security_error";
    else if (flag === "invalid") authorization = "auth_invalid";
    else authorization = "paired";

    emit({
      authorization,
      connection: authorization === "security_error" ? "untrusted" : "unknown",
      lastSuccessAt: lastSuccess || connection?.lastSeenAt || null,
      lastError: null,
      lastFailure: null,
      loaded: true,
    });
  })().finally(() => {
    hydrateTask = null;
  });

  return hydrateTask;
}

/** 开始一次连接检测：只改连接状态，不动授权 */
export function reportLinkChecking(): void {
  emit({ connection: "checking" });
}

/**
 * 一次经认证且通过指纹校验的请求成功。
 * 授权回到「已配对」并清掉持久标记；记录最近成功时间。
 */
export function reportLinkOnline(at: string = new Date().toISOString()): void {
  void writeAuthFlag(null);
  void setSetting(LAST_SUCCESS_KEY, at).catch(() => undefined);
  emit({
    authorization: "paired",
    connection: "online",
    lastSuccessAt: at,
    lastError: null,
    lastFailure: null,
  });
}

/**
 * 一次请求失败。
 * - offline/timeout：只影响连接状态，授权保持原样（绝不要求重新配对）；
 * - auth：授权=失效，连接=不可用，持久标记；
 * - tls：授权=安全验证异常，连接=不可信，持久标记；严格失败，不提供绕过。
 */
export function reportLinkFailure(kind: LinkFailureKind, message: string): void {
  if (kind === "auth") {
    void writeAuthFlag("invalid");
    emit({
      authorization: "auth_invalid",
      connection: "unknown",
      lastError: message,
      lastFailure: kind,
    });
    return;
  }
  if (kind === "tls") {
    void writeAuthFlag("security");
    emit({
      authorization: "security_error",
      connection: "untrusted",
      lastError: message,
      lastFailure: kind,
    });
    return;
  }
  emit({
    connection: kind === "timeout" ? "timeout" : "offline",
    lastError: message,
    lastFailure: kind,
  });
}

/**
 * 配对成功。
 * 连接状态明确回到「未检测」：配对那一刻的请求成功不代表后续一直在线，
 * 不能因为刚配对完就显示「在线」；lastSuccessAt 记录配对完成的时刻。
 */
export function reportLinkPaired(at: string = new Date().toISOString()): void {
  void writeAuthFlag(null);
  void setSetting(LAST_SUCCESS_KEY, at).catch(() => undefined);
  emit({
    authorization: "paired",
    connection: "unknown",
    lastSuccessAt: at,
    lastError: null,
    lastFailure: null,
  });
}

/** 解除配对：清掉两个状态与持久标记（凭据删除由 clearConnection 负责） */
export function reportLinkUnpaired(): void {
  void writeAuthFlag(null);
  void deleteSetting(LAST_SUCCESS_KEY).catch(() => undefined);
  emit({
    ...initialState(),
    loaded: true,
    rev: state.rev + 1,
  });
}

/** 用户主动重新检测前的「尚未检测」提示（例如切换页面后） */
export function reportLinkUnknown(): void {
  emit({ connection: "unknown" });
}

export const AUTHORIZATION_LABEL: Record<PairAuthorization, string> = {
  unpaired: "未配对",
  paired: "已配对",
  auth_invalid: "授权失效，需要重新配对",
  security_error: "安全验证异常，需要人工处理",
};

export const CONNECTION_LABEL: Record<LinkConnection, string> = {
  unknown: "未检测",
  checking: "正在检测…",
  online: "在线",
  offline: "离线 · 电脑不可达",
  timeout: "连接超时",
  untrusted: "不可信连接",
};

export type LinkTone = "ok" | "warn" | "danger" | "muted";

/** 授权状态的语气：只有「已配对」是 ok；失效/安全异常一律 danger，不能与在线混用同一绿色 */
export function authorizationTone(value: PairAuthorization): LinkTone {
  if (value === "paired") return "ok";
  if (value === "unpaired") return "muted";
  return "danger";
}

/** 连接状态的语气：在线才是 ok；检测中/未检测中性；离线与超时是 warn（可恢复） */
export function connectionTone(value: LinkConnection): LinkTone {
  if (value === "online") return "ok";
  if (value === "offline" || value === "timeout") return "warn";
  if (value === "untrusted") return "danger";
  return "muted";
}

/** 是否仍持有可用凭据（授权失效/安全异常时凭据仍在，允许「解除配对」而不是要求重配） */
export function hasCredentials(value: PairAuthorization): boolean {
  return value !== "unpaired";
}

const TLS_FAILURE_CODES = new Set([
  "tls_pin_mismatch",
  "tls_handshake",
  "insecure_transport",
]);

/**
 * 把连接/配对异常收敛成四类。只认结构化 code 与超时语义，不猜中文文案：
 * - TLS 指纹/握手类 → tls（安全失败，不可绕过）
 * - 401/403 / unauthorized → auth（授权失效）
 * - 超时 → timeout（网络问题，可重试）
 * - 其余 → offline（电脑不可达）
 */
export function failureKindFromError(error: unknown): LinkFailureKind {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : null;
  const code = typeof record?.code === "string" ? record.code : "";
  const message = typeof record?.message === "string" ? record.message : "";
  if (TLS_FAILURE_CODES.has(code)) return "tls";
  if (code === "unauthorized" || code === "auth_invalid") return "auth";
  if (/超时|timeout|timed out/i.test(message) || code === "request_timeout") return "timeout";
  return "offline";
}

/** 测试专用：清空内存状态，模拟冷启动 */
export function __resetLinkState(): void {
  state = initialState();
  hydrateTask = null;
  for (const listener of [...listeners]) listener();
}
