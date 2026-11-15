// P0-01 传输错误分类矩阵：每一种失败都必须落到唯一、可判定的类别，
// 并明确「pending（可重试）/ failed（停止）」与「是否中止整批」。
//
// 这些断言是错误文案以外的事实来源：UI 与数据库状态都由分类结果驱动，
// 后续若有人把 401 收敛成「网络错误」，这里会立刻失败。
import { describe, expect, it } from "vitest";

import { AppError } from "../../errors";
import {
  classifyTransferFailure,
  createCancelledError,
  FileHttpError,
  isFileCancelled,
  reusableRemoteKey,
  transferFailureMessage,
} from "../transferError";

describe("HTTP 状态码分类（保留真实状态码与业务码）", () => {
  it("401 = 授权失效：failed、不允许重试、停止整批", () => {
    const failure = classifyTransferFailure(new FileHttpError(401, "unauthorized"));
    expect(failure.kind).toBe("auth");
    expect(failure.pending).toBe(false);
    expect(failure.retryable).toBe(false);
    expect(failure.stopsBatch).toBe(true);
    expect(failure.status).toBe(401);
    expect(failure.code).toBe("unauthorized");
    expect(transferFailureMessage(failure)).toContain("重新扫码配对");
  });

  it("403 = 拒绝访问：failed 且停止整批", () => {
    const failure = classifyTransferFailure(new FileHttpError(403, "forbidden"));
    expect(failure.kind).toBe("forbidden");
    expect(failure.pending).toBe(false);
    expect(failure.stopsBatch).toBe(true);
  });

  it("暂存架接口 404 = 版本不支持，但不终止整批（上传本身已成功）", () => {
    const failure = classifyTransferFailure(new FileHttpError(404, "not_supported"), {
      endpoint: "shelf",
    });
    expect(failure.kind).toBe("not_supported");
    expect(failure.pending).toBe(false);
    expect(failure.stopsBatch).toBe(false);
    expect(transferFailureMessage(failure)).toContain("升级桌面端");
  });

  it("暂存架接口 404 + 分组探测成功 = 记录不存在（不是版本过低）", () => {
    const failure = classifyTransferFailure(new FileHttpError(404, "not_found"), {
      endpoint: "shelf",
    });
    expect(failure.kind).toBe("not_found");
    expect(failure.pending).toBe(false);
    expect(failure.retryable).toBe(false);
    expect(failure.stopsBatch).toBe(false);
    expect(transferFailureMessage(failure)).toContain("找不到该文件记录");
  });

  it("基础接口 404 = 协议不兼容，必须停止整批", () => {
    const failure = classifyTransferFailure(new FileHttpError(404, null), { endpoint: "list" });
    expect(failure.kind).toBe("not_supported");
    expect(failure.stopsBatch).toBe(true);
  });

  it("408 = 超时：pending 且可重试", () => {
    const failure = classifyTransferFailure(new FileHttpError(408));
    expect(failure.kind).toBe("timeout");
    expect(failure.pending).toBe(true);
    expect(failure.retryable).toBe(true);
  });

  it("409 = 状态冲突：pending，但不自动重试（需先核对远端状态）", () => {
    const failure = classifyTransferFailure(new FileHttpError(409, "conflict"));
    expect(failure.kind).toBe("conflict");
    expect(failure.pending).toBe(true);
    expect(failure.retryable).toBe(false);
  });

  it("429 = 限流：pending 且可重试", () => {
    const failure = classifyTransferFailure(new FileHttpError(429, "too_many_requests"));
    expect(failure.kind).toBe("rate_limited");
    expect(failure.pending).toBe(true);
    expect(failure.retryable).toBe(true);
  });

  it("5xx = 服务端错误：pending（503 可自动重试）", () => {
    const unavailable = classifyTransferFailure(new FileHttpError(503, "internal_error"));
    expect(unavailable.kind).toBe("server");
    expect(unavailable.pending).toBe(true);
    expect(unavailable.retryable).toBe(true);
    const notImplemented = classifyTransferFailure(new FileHttpError(505));
    expect(notImplemented.kind).toBe("server");
    expect(notImplemented.pending).toBe(true);
  });

  it("400/413 = 参数问题：failed 且不自动重复", () => {
    for (const status of [400, 413, 422]) {
      const failure = classifyTransferFailure(new FileHttpError(status, "invalid_request"));
      expect(failure.kind).toBe("invalid_request");
      expect(failure.pending).toBe(false);
      expect(failure.retryable).toBe(false);
    }
  });
});

describe("安全与本地错误的分类（不依赖中文文案）", () => {
  it("TLS 指纹不匹配 = 安全失败：failed、停止整批、绝不 pending", () => {
    const failure = classifyTransferFailure(
      new AppError("validation", "桌面端证书指纹不匹配（可能存在中间人），请重新扫码配对", undefined, "tls_pin_mismatch"),
    );
    expect(failure.kind).toBe("tls");
    expect(failure.pending).toBe(false);
    expect(failure.stopsBatch).toBe(true);
  });

  it("TLS 握手失败 = 安全失败：不能被伪装成离线", () => {
    const failure = classifyTransferFailure(
      new AppError("network", "与桌面端的 TLS 握手失败", undefined, "tls_handshake"),
    );
    expect(failure.kind).toBe("tls");
    expect(failure.pending).toBe(false);
  });

  it("明文/非 HTTPS = fail-closed", () => {
    const failure = classifyTransferFailure(
      new AppError("validation", "必须使用 HTTPS", undefined, "insecure_transport"),
    );
    expect(failure.kind).toBe("insecure");
    expect(failure.pending).toBe(false);
    expect(failure.stopsBatch).toBe(true);
  });

  it("本端超时码 = timeout（可重试）", () => {
    const failure = classifyTransferFailure(
      new AppError("network", "文件请求超时（30s）", undefined, "request_timeout"),
    );
    expect(failure.kind).toBe("timeout");
    expect(failure.pending).toBe(true);
    expect(failure.retryable).toBe(true);
  });

  it("普通网络异常 = offline pending（电脑关闭/断网）", () => {
    const failure = classifyTransferFailure(
      new AppError("network", "java.net.ConnectException: ECONNREFUSED"),
    );
    expect(failure.kind).toBe("offline");
    expect(failure.pending).toBe(true);
    expect(failure.retryable).toBe(true);
  });

  it("用户取消 = cancelled，不重试", () => {
    const error = createCancelledError();
    expect(isFileCancelled(error)).toBe(true);
    const failure = classifyTransferFailure(error);
    expect(failure.kind).toBe("cancelled");
    expect(failure.retryable).toBe(false);
    expect(failure.pending).toBe(false);
  });

  it("未知异常不会被误判成可重试", () => {
    const failure = classifyTransferFailure(new Error("boom"));
    expect(failure.kind).toBe("unknown");
    expect(failure.pending).toBe(false);
    expect(failure.retryable).toBe(false);
  });
});

describe("重试幂等匹配键", () => {
  it("有 SHA-256 时忽略文件名（桌面端会清洗特殊字符）", () => {
    const key = reusableRemoteKey({ name: "a<b>.jpg", size: 10, sha256: "AB".repeat(32) });
    expect(key.withHash).toBe(`${"ab".repeat(32)}\u000010`);
  });

  it("没有 SHA-256 时退回同名同大小", () => {
    const key = reusableRemoteKey({ name: "报告.pdf", size: 2048, sha256: null });
    expect(key.withHash).toBeNull();
    expect(key.byName).toBe("报告.pdf\u00002048");
  });
});
