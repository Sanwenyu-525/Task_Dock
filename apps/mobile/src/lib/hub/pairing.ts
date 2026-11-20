// Personal Hub 扫码配对编排（基线 §6.2 / 契约 §2–§3）。
//
// 流程：Base64URL 二维码 → 结构与版本校验 → 指纹自洽 → Hub 签名校验 → 过期校验
// → 本地身份（首次生成）→ 提交配对申请 → 轮询 PC 批准 → 返回 PC 指纹供人工比对。
//
// 安全边界：
// - 二维码签名只证明「内容自洽」，不证明 Hub 可信；真正的防中间人依赖批准后展示的
//   PC 指纹与电脑屏幕人工比对（契约 §2 最后一段），本文件强制该字段存在且与二维码一致；
// - 邀请 secret 只存在于本次调用的局部变量与请求体，绝不进入 UI 状态、审计或日志；
// - 过期 / 版本不支持 / 签名不合法一律拒绝，不静默降级；
// - 没有任何「跳过 PC 批准」的分支。
import nacl from "tweetnacl";
import { decodeBase64, decodeUTF8, encodeUTF8 } from "tweetnacl-util";

import { safeLog } from "../safeLog";
import { sha256Hex } from "../sync/sha256";

import { recordHubAudit, type HubAuditEventInput } from "./audit";
import { canonicalStringify } from "./canonical";
import {
  assertSecureControlPlaneUrl,
  toHubApiError,
  type HubApiError,
  type HubClient,
  type HubPeer,
  type PairingRequestStatus,
} from "./hubClient";
import type { DeviceIdentityApi } from "./identity";

export type HubPairingErrorCode =
  | "QR_INVALID"
  | "VERSION_UNSUPPORTED"
  | "QR_EXPIRED"
  | "QR_SIGNATURE_INVALID"
  | "QR_FINGERPRINT_MISMATCH"
  | "INSECURE_URL"
  | "IDENTITY_UNAVAILABLE"
  | "PAIRING_REJECTED"
  | "PAIRING_EXPIRED"
  | "SERVER_INVALID"
  | "NETWORK"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "CANCELLED"
  | "UNKNOWN";

export class HubPairingError extends Error {
  constructor(
    readonly code: HubPairingErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "HubPairingError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** 完整邀请（含 secret）：只在内部流转，绝不交给 UI 状态。 */
export interface HubInvitation {
  v: number;
  cp: string;
  iid: string;
  sec: string;
  nonce: string;
  exp: string;
  hid: string;
  hpk: string;
  hfp: string;
  sig: string;
}

/** 可展示的邀请视图：剔除 invitationSecret。 */
export type HubInvitationView = Omit<HubInvitation, "sec">;

export interface HubPairingStateNone {
  phase: "verifying" | "submitting";
}
export interface HubPairingStateVerified {
  phase: "verified";
  invitation: HubInvitationView;
}
export interface HubPairingStateAwaiting {
  phase: "awaiting_pc_approval";
  invitation: HubInvitationView;
  requestId: string;
  expiresAt: string;
  /** 轮询暂时失败时的提示；不影响继续重试。 */
  warning?: string;
}
export interface HubPairingStateApproved {
  phase: "approved";
  invitation: HubInvitationView;
  requestId: string;
  peer: HubPeer;
}
export interface HubPairingStateRejected {
  phase: "rejected" | "expired";
  invitation: HubInvitationView;
  requestId: string;
}
export interface HubPairingStateFailed {
  phase: "failed";
  error: HubPairingError;
  invitation?: HubInvitationView;
}

export type HubPairingState =
  | HubPairingStateNone
  | HubPairingStateVerified
  | HubPairingStateAwaiting
  | HubPairingStateApproved
  | HubPairingStateRejected
  | HubPairingStateFailed;

export interface HubPairingResult {
  invitation: HubInvitationView;
  requestId: string;
  status: Extract<PairingRequestStatus, "approved" | "rejected" | "expired">;
  peer?: HubPeer;
}

export interface PairWithHubOptions {
  qrPayload: string;
  identity: DeviceIdentityApi;
  /** PC 上显示名称；只用于 PC 批准面板展示，不得含敏感信息。 */
  deviceName: string;
  /** 由二维码里的 cp 构造客户端；默认实现见 UI 层。 */
  createClient: (baseUrl: string) => HubClient;
  onState?: (state: HubPairingState) => void;
  signal?: AbortSignal;
  now?: () => number;
  pollIntervalMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  audit?: (event: HubAuditEventInput) => void | Promise<void>;
  /** 仅测试本地控制面时显式放行 loopback http。 */
  allowLoopbackHttp?: boolean;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const INVITATION_FIELDS = ["v", "cp", "iid", "sec", "nonce", "exp", "hid", "hpk", "hfp", "sig"];

function decodeBase64Url(value: string): Uint8Array {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  if (!BASE64_PATTERN.test(padded)) {
    throw new HubPairingError("QR_INVALID", "二维码内容不是合法的 Base64URL");
  }
  try {
    return decodeBase64(padded);
  } catch (error) {
    throw new HubPairingError("QR_INVALID", "二维码内容不是合法的 Base64URL", error);
  }
}

function decodeBase64Field(value: unknown, bytes: number, field: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || !BASE64_PATTERN.test(value)) {
    throw new HubPairingError("QR_INVALID", `二维码字段 ${field} 不是合法 base64`);
  }
  let decoded: Uint8Array;
  try {
    decoded = decodeBase64(value);
  } catch (error) {
    throw new HubPairingError("QR_INVALID", `二维码字段 ${field} 不是合法 base64`, error);
  }
  if (decoded.length !== bytes) {
    throw new HubPairingError("QR_INVALID", `二维码字段 ${field} 长度不正确`);
  }
  return decoded;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new HubPairingError("QR_INVALID", `二维码缺少字段 ${field}`);
  }
  return value;
}

/**
 * 解析并校验二维码。任何失败都抛 HubPairingError（带稳定 code），不返回半成品。
 * `now` 可注入，便于测试过期边界。
 */
export function parseHubInvitation(
  qrPayload: string,
  options: { now?: () => number; allowLoopbackHttp?: boolean } = {},
): HubInvitation {
  if (typeof qrPayload !== "string" || qrPayload.trim().length === 0) {
    throw new HubPairingError("QR_INVALID", "二维码内容为空");
  }

  let parsed: unknown;
  try {
    const bytes = decodeBase64Url(qrPayload);
    parsed = JSON.parse(encodeUTF8(bytes));
  } catch (error) {
    if (error instanceof HubPairingError) throw error;
    throw new HubPairingError("QR_INVALID", "这不是 TaskDock Personal Hub 的二维码", error);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HubPairingError("QR_INVALID", "二维码内容不是 JSON 对象");
  }
  const record = parsed as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !INVITATION_FIELDS.includes(key));
  if (extra.length > 0) {
    // 额外字段不在签名覆盖范围内，不能带进配对流程。
    throw new HubPairingError("QR_INVALID", "二维码包含未定义的字段");
  }

  const v = record.v;
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new HubPairingError("QR_INVALID", "二维码缺少协议版本");
  }
  if (v !== 1) {
    throw new HubPairingError(
      "VERSION_UNSUPPORTED",
      "二维码协议版本不受支持，请升级手机端或电脑端",
    );
  }

  const cp = requireString(record, "cp");
  const iid = requireString(record, "iid");
  const sec = requireString(record, "sec");
  const nonce = requireString(record, "nonce");
  const exp = requireString(record, "exp");
  const hid = requireString(record, "hid");
  const hpk = requireString(record, "hpk");
  const hfpRaw = requireString(record, "hfp");
  const sig = requireString(record, "sig");

  for (const [field, value] of [
    ["iid", iid],
    ["nonce", nonce],
    ["hid", hid],
  ] as const) {
    if (!UUID_PATTERN.test(value)) {
      throw new HubPairingError("QR_INVALID", `二维码字段 ${field} 不是合法 UUID`);
    }
  }
  const expiresAtMs = Date.parse(exp);
  if (!Number.isFinite(expiresAtMs)) {
    throw new HubPairingError("QR_INVALID", "二维码过期时间格式不正确");
  }
  const hfp = hfpRaw;
  if (!FINGERPRINT_PATTERN.test(hfp)) {
    throw new HubPairingError("QR_INVALID", "二维码电脑指纹格式不正确");
  }

  try {
    assertSecureControlPlaneUrl(cp, options.allowLoopbackHttp === true);
  } catch (error) {
    throw new HubPairingError(
      "INSECURE_URL",
      "二维码里的云端地址不是 HTTPS，已拒绝配对",
      error,
    );
  }

  const secretBytes = decodeBase64Field(sec, 16, "sec");
  const publicKey = decodeBase64Field(hpk, 32, "hpk");
  const signature = decodeBase64Field(sig, 64, "sig");

  const expectedFingerprint = sha256Hex(publicKey).slice(0, 32);
  if (expectedFingerprint !== hfp) {
    throw new HubPairingError(
      "QR_FINGERPRINT_MISMATCH",
      "二维码中的电脑指纹与公钥不一致，已拒绝配对",
    );
  }

  const signable = { v, cp, iid, sec, nonce, exp, hid, hpk, hfp };
  const payloadBytes = decodeUTF8(canonicalStringify(signable));
  let signatureValid = false;
  try {
    signatureValid = nacl.sign.detached.verify(payloadBytes, signature, publicKey);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    throw new HubPairingError(
      "QR_SIGNATURE_INVALID",
      "二维码签名校验失败，内容可能被篡改，已拒绝配对",
    );
  }

  const now = options.now ?? (() => Date.now());
  if (expiresAtMs <= now()) {
    throw new HubPairingError(
      "QR_EXPIRED",
      "配对二维码已过期，请在电脑上重新生成后扫码",
    );
  }

  // secretBytes 只用于长度校验；不保留副本，垃圾回收即可（非长期密钥材料）。
  secretBytes.fill(0);

  const invitation: HubInvitation = {
    v,
    cp,
    iid,
    sec,
    nonce,
    exp,
    hid,
    hpk,
    hfp,
    sig,
  };
  return invitation;
}

/** 剔除 secret 后交给 UI/审计，防止邀请密钥被渲染或写入日志。 */
export function toInvitationView(invitation: HubInvitation): HubInvitationView {
  const { sec: _sec, ...view } = invitation;
  return view;
}

export function describeHubPairingError(error: unknown): string {
  if (error instanceof HubPairingError) {
    switch (error.code) {
      case "QR_INVALID":
        return "这不是 TaskDock Personal Hub 的配对二维码";
      case "VERSION_UNSUPPORTED":
        return "二维码协议版本不受支持，请升级手机端或电脑端";
      case "QR_EXPIRED":
      case "PAIRING_EXPIRED":
        return "配对二维码已过期，请在电脑上重新生成后扫码";
      case "QR_SIGNATURE_INVALID":
        return "二维码签名校验失败，内容可能被篡改，已拒绝配对";
      case "QR_FINGERPRINT_MISMATCH":
        return "二维码中的电脑指纹与公钥不一致，已拒绝配对";
      case "INSECURE_URL":
        return "二维码里的云端地址不是 HTTPS，已拒绝配对";
      case "IDENTITY_UNAVAILABLE":
        return "本机设备身份不可用，请重启应用后重试";
      case "PAIRING_REJECTED":
        return "电脑拒绝了这次配对申请；请在电脑上重新发起配对";
      case "RATE_LIMITED":
        return "尝试次数过多，请稍后再试";
      case "NETWORK":
        return "无法连接 TaskDock 云端服务，请检查网络后重试";
      case "TIMEOUT":
        return "连接 TaskDock 云端服务超时，请稍后重试";
      case "CANCELLED":
        return "已取消配对";
      case "SERVER_INVALID":
        return "云端返回的配对结果不完整或与二维码不一致，已安全终止";
      default:
        return "配对失败，请重试";
    }
  }
  const apiError = error as Partial<HubApiError> | null;
  if (apiError && typeof apiError.code === "string") {
    if (apiError.code === "INVITATION_EXPIRED" || apiError.code === "INVITATION_NOT_PENDING") {
      return "配对邀请已失效，请在电脑上重新生成二维码";
    }
    if (apiError.code === "INVALID_SIGNATURE") {
      return "设备签名未被云端接受，请重置本机身份后重新配对";
    }
    if (apiError.code === "RATE_LIMITED") {
      return "尝试次数过多，请稍后再试";
    }
    if (apiError.code === "NETWORK" || apiError.code === "TIMEOUT") {
      return "无法连接 TaskDock 云端服务，请检查网络后重试";
    }
  }
  return "配对失败，请重试";
}

function asPairingError(error: unknown): HubPairingError {
  if (error instanceof HubPairingError) return error;
  const apiError = toHubApiError(error);
  const code: HubPairingErrorCode =
    apiError.code === "RATE_LIMITED"
      ? "RATE_LIMITED"
      : apiError.code === "NETWORK"
        ? "NETWORK"
        : apiError.code === "TIMEOUT"
          ? "TIMEOUT"
          : apiError.code === "CANCELLED"
            ? "CANCELLED"
            : apiError.code === "INSECURE_URL"
              ? "INSECURE_URL"
              : apiError.code === "INVITATION_EXPIRED" ||
                  apiError.code === "INVITATION_NOT_PENDING"
                ? "PAIRING_EXPIRED"
                : "UNKNOWN";
  return new HubPairingError(code, apiError.message, apiError);
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HubPairingError("CANCELLED", "已取消配对"));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      if (timer !== null) clearTimeout(timer);
      reject(new HubPairingError("CANCELLED", "已取消配对"));
    };
    timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 轮询期间可继续重试的传输错误；其余服务端拒绝立即 fail-closed。 */
function isRetryable(code: string): boolean {
  return code === "NETWORK" || code === "TIMEOUT" || code === "RATE_LIMITED";
}

/**
 * 执行完整配对。返回前一定处于 approved / rejected / expired；
 * 其他情况抛 HubPairingError（含 CANCELLED）。
 */
export async function pairWithHub(options: PairWithHubOptions): Promise<HubPairingResult> {
  const now = options.now ?? (() => Date.now());
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const sleep = options.sleep ?? defaultSleep;
  const audit = options.audit ?? ((event) => void recordHubAudit(event));
  const signal = options.signal;

  const notify = (state: HubPairingState) => options.onState?.(state);
  const cancelled = () => signal?.aborted === true;

  const invitation = (() => {
    try {
      return parseHubInvitation(options.qrPayload, {
        now,
        allowLoopbackHttp: options.allowLoopbackHttp,
      });
    } catch (error) {
      const pairingError = asPairingError(error);
      void audit({
        type: "pairing_scan",
        result: "rejected",
        reason: pairingError.code,
      });
      notify({ phase: "failed", error: pairingError });
      throw pairingError;
    }
  })();
  const view = toInvitationView(invitation);
  notify({ phase: "verified", invitation: view });

  if (cancelled()) {
    const error = new HubPairingError("CANCELLED", "已取消配对");
    notify({ phase: "failed", error, invitation: view });
    throw error;
  }

  try {
    const existing = await options.identity.getIdentity();
    if (!existing) {
      await options.identity.ensureIdentity();
      void audit({ type: "identity_created", result: "ok" });
    }
  } catch (error) {
    const pairingError = new HubPairingError(
      "IDENTITY_UNAVAILABLE",
      "本机设备身份不可用",
      error,
    );
    // 原生身份错误（IdentityStorageException 等）抛回 JS 的采集点：只记稳定码，
    // 绝不记底层异常文本（可能含文件路径）。
    safeLog.warn("identity", "设备身份不可用", { code: pairingError.code });
    void audit({ type: "identity_created", result: "error", reason: pairingError.code });
    notify({ phase: "failed", error: pairingError, invitation: view });
    throw pairingError;
  }

  notify({ phase: "submitting" });

  let client: HubClient;
  try {
    client = options.createClient(invitation.cp);
  } catch (error) {
    const pairingError = asPairingError(error);
    notify({ phase: "failed", error: pairingError, invitation: view });
    throw pairingError;
  }
  let ack: { requestId: string; expiresAt: string };
  try {
    ack = await client.submitPairingRequest({
      invitationId: invitation.iid,
      invitationSecret: invitation.sec,
      displayName: options.deviceName,
      signal,
    });
    void audit({ type: "pairing_request", result: "ok" });
  } catch (error) {
    const pairingError = asPairingError(error);
    void audit({
      type: "pairing_request",
      result: pairingError.code === "CANCELLED" ? "cancelled" : "error",
      reason: pairingError.code,
    });
    notify({ phase: "failed", error: pairingError, invitation: view });
    throw pairingError;
  } finally {
    // 邀请 secret 只服务一次提交；成功或失败后都从内存对象里清掉。
    invitation.sec = "";
  }

  const invitationDeadline = Date.parse(invitation.exp);
  const ackDeadline = Date.parse(ack.expiresAt);
  const deadline = Number.isFinite(ackDeadline)
    ? Math.min(invitationDeadline, ackDeadline)
    : invitationDeadline;

  let requestId = ack.requestId;
  let lastWarning: string | undefined;
  notify({
    phase: "awaiting_pc_approval",
    invitation: view,
    requestId,
    expiresAt: new Date(deadline).toISOString(),
    warning: lastWarning,
  });

  while (now() < deadline) {
    if (cancelled()) {
      const error = new HubPairingError("CANCELLED", "已取消配对");
      notify({ phase: "failed", error, invitation: view });
      throw error;
    }

    try {
      const result = await client.getPairingStatus({ requestId, signal });
      lastWarning = undefined;
      if (result.status === "awaiting_pc_approval") {
        notify({
          phase: "awaiting_pc_approval",
          invitation: view,
          requestId,
          expiresAt: new Date(deadline).toISOString(),
          warning: lastWarning,
        });
        await sleep(pollIntervalMs, signal);
        continue;
      }

      if (result.status === "approved") {
        const peer = result.peer;
        if (!peer) {
          throw new HubPairingError("SERVER_INVALID", "配对已批准但缺少电脑身份信息");
        }
        // 批准的必须就是二维码里的那台 Hub：ID 与指纹都必须一致。
        if (peer.deviceId !== invitation.hid || peer.identityFingerprint !== invitation.hfp) {
          throw new HubPairingError(
            "SERVER_INVALID",
            "云端返回的电脑身份与二维码不一致，已安全终止",
          );
        }
        void audit({ type: "pairing_status", result: "approved" });
        notify({ phase: "approved", invitation: view, requestId, peer });
        return { invitation: view, requestId, status: "approved", peer };
      }

      if (result.status === "rejected") {
        void audit({ type: "pairing_status", result: "rejected", reason: "PC_REJECTED" });
        notify({ phase: "rejected", invitation: view, requestId });
        return { invitation: view, requestId, status: "rejected" };
      }

      // expired：邀请已被云端判定过期，直接结束，不再轮询。
      void audit({ type: "pairing_status", result: "expired", reason: "INVITATION_EXPIRED" });
      notify({ phase: "expired", invitation: view, requestId });
      return { invitation: view, requestId, status: "expired" };
    } catch (error) {
      if (error instanceof HubPairingError) {
        if (error.code === "CANCELLED") {
          notify({ phase: "failed", error, invitation: view });
          throw error;
        }
        // 云端身份/签名不一致属于安全失败，立即终止。
        if (error.code === "SERVER_INVALID") {
          void audit({ type: "pairing_status", result: "error", reason: error.code });
          notify({ phase: "failed", error, invitation: view });
          throw error;
        }
        lastWarning = describeHubPairingError(error);
        notify({
          phase: "awaiting_pc_approval",
          invitation: view,
          requestId,
          expiresAt: new Date(deadline).toISOString(),
          warning: lastWarning,
        });
        await sleep(pollIntervalMs, signal);
        continue;
      }

      const apiError = toHubApiError(error);
      if (apiError.code === "CANCELLED") {
        const pairingError = new HubPairingError("CANCELLED", "已取消配对", apiError);
        notify({ phase: "failed", error: pairingError, invitation: view });
        throw pairingError;
      }
      if (isRetryable(apiError.code)) {
        lastWarning =
          apiError.code === "RATE_LIMITED"
            ? "查询频率受限，正在重试…"
            : "网络异常，正在重试…";
        notify({
          phase: "awaiting_pc_approval",
          invitation: view,
          requestId,
          expiresAt: new Date(deadline).toISOString(),
          warning: lastWarning,
        });
        await sleep(pollIntervalMs, signal);
        continue;
      }

      // 其余服务端拒绝（签名/身份/设备撤销/邀请失效）立即失败，不重试。
      const pairingError = asPairingError(apiError);
      void audit({ type: "pairing_status", result: "error", reason: apiError.code });
      notify({ phase: "failed", error: pairingError, invitation: view });
      throw pairingError;
    }
  }

  void audit({ type: "pairing_status", result: "expired", reason: "DEADLINE_REACHED" });
  notify({ phase: "expired", invitation: view, requestId });
  return { invitation: view, requestId, status: "expired" };
}
