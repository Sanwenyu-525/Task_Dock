// 设备链路状态：配对授权与网络连接必须独立，且三个页面共用同一份状态。
// 覆盖验收表 18（授权/连接独立）与 19（跨页一致）的状态机部分：
// - 正常在线、电脑关机/网络中断、连接超时、401/403、TLS 指纹不匹配；
// - 网络失败绝不清凭据、不要求重配；授权异常与安全异常在重启后仍然可见；
// - 重新配对 / 解除配对后状态更新；订阅者拿到的是同一个快照。
import { beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, openDatabase } from "../../../db/database";
import { clearConnection, saveConnection } from "../../../db/syncConnection";
import { getSetting } from "../../../db/kv";
import {
  __resetLinkState,
  failureKindFromError,
  getLinkState,
  hydrateLinkState,
  reportLinkFailure,
  reportLinkOnline,
  reportLinkPaired,
  reportLinkUnpaired,
} from "../linkState";

const TOKEN = "b".repeat(64);

function meta(overrides: Partial<Parameters<typeof saveConnection>[0]["meta"]> = {}) {
  return {
    baseUrl: "https://192.168.1.20:47822",
    host: "192.168.1.20",
    port: 47822,
    serverName: "TaskDock-Desktop",
    deviceId: "device-1",
    platform: "windows",
    instanceId: "instance-1",
    fingerprint: "abcd1234",
    tlsFingerprint: "c".repeat(64),
    pairedAt: "2026-11-17T01:00:00.000Z",
    ...overrides,
  };
}

/** 等待 `void writeAuthFlag(...)` 这类后台写入落库 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

beforeEach(async () => {
  await closeDatabase();
  await openDatabase();
  await clearConnection();
  __resetLinkState();
});

describe("冷启动恢复：本地有令牌 ≠ 电脑在线", () => {
  it("没有连接与令牌：未配对 + 未检测", async () => {
    await hydrateLinkState();
    const state = getLinkState();
    expect(state.authorization).toBe("unpaired");
    expect(state.connection).toBe("unknown");
    expect(state.loaded).toBe(true);
  });

  it("本地已配对：授权=已配对，连接=未检测（不伪造在线）", async () => {
    await saveConnection({ token: TOKEN, meta: meta() });
    await hydrateLinkState();
    const state = getLinkState();
    expect(state.authorization).toBe("paired");
    expect(state.connection).toBe("unknown");
  });

  it("v1 遗留连接（指纹缺失）：安全验证异常 + 不可信连接", async () => {
    await saveConnection({ token: TOKEN, meta: meta({ tlsFingerprint: "" }) });
    await hydrateLinkState();
    expect(getLinkState().authorization).toBe("security_error");
    expect(getLinkState().connection).toBe("untrusted");
  });
});

describe("失败矩阵：授权与连接独立变化", () => {
  it("电脑关机/网络中断：授权保持已配对，连接=离线", async () => {
    await saveConnection({ token: TOKEN, meta: meta() });
    await hydrateLinkState();
    reportLinkFailure("offline", "电脑不可达");
    const state = getLinkState();
    expect(state.authorization).toBe("paired");
    expect(state.connection).toBe("offline");
    expect(state.lastError).toBe("电脑不可达");
    // 本地凭据还在：不需要重新配对
    expect(getLinkState().authorization).not.toBe("unpaired");
  });

  it("请求超时：授权保持已配对，连接=连接超时", async () => {
    await saveConnection({ token: TOKEN, meta: meta() });
    await hydrateLinkState();
    reportLinkFailure("timeout", "连接超时");
    expect(getLinkState().authorization).toBe("paired");
    expect(getLinkState().connection).toBe("timeout");
  });

  it("401/403：授权=授权失效，连接不再显示在线，但凭据仍在", async () => {
    await saveConnection({ token: TOKEN, meta: meta() });
    await hydrateLinkState();
    reportLinkOnline("2026-11-17T02:00:00.000Z");
    expect(getLinkState().connection).toBe("online");

    reportLinkFailure("auth", "配对授权已失效");
    await flush();
    expect(getLinkState().authorization).toBe("auth_invalid");
    expect(getLinkState().connection).not.toBe("online");
    // 持久标记落库（重启后仍显示授权失效），但连接元数据/令牌没有被删除
    expect(await getSetting("sync.link.auth.v1")).toBe("invalid");

    __resetLinkState();
    await hydrateLinkState();
    expect(getLinkState().authorization).toBe("auth_invalid");
  });

  it("TLS 指纹不匹配：授权=安全验证异常，连接=不可信，严格失败", async () => {
    await saveConnection({ token: TOKEN, meta: meta() });
    await hydrateLinkState();
    reportLinkFailure("tls", "桌面端证书指纹不匹配");
    await flush();
    expect(getLinkState().authorization).toBe("security_error");
    expect(getLinkState().connection).toBe("untrusted");
    expect(await getSetting("sync.link.auth.v1")).toBe("security");

    __resetLinkState();
    await hydrateLinkState();
    expect(getLinkState().authorization).toBe("security_error");
    expect(getLinkState().connection).toBe("untrusted");
  });

  it("网络失败持久化：重启后仍是已配对 + 未检测，而不是未配对", async () => {
    await saveConnection({ token: TOKEN, meta: meta() });
    await hydrateLinkState();
    reportLinkFailure("offline", "电脑不可达");
    __resetLinkState();
    await hydrateLinkState();
    expect(getLinkState().authorization).toBe("paired");
    expect(getLinkState().connection).toBe("unknown");
  });
});

describe("成功与重新配对", () => {
  it("检测成功：在线 + 记录最近成功时间；失败原因清空", async () => {
    await saveConnection({ token: TOKEN, meta: meta() });
    await hydrateLinkState();
    reportLinkFailure("offline", "电脑不可达");
    reportLinkOnline("2026-11-17T03:00:00.000Z");
    const state = getLinkState();
    expect(state.connection).toBe("online");
    expect(state.lastSuccessAt).toBe("2026-11-17T03:00:00.000Z");
    expect(state.lastError).toBeNull();
    await flush();
    expect(await getSetting("sync.link.last_success.v1")).toBe("2026-11-17T03:00:00.000Z");
  });

  it("重新配对：清掉授权异常标记，连接回到未检测", async () => {
    await saveConnection({ token: TOKEN, meta: meta() });
    await hydrateLinkState();
    reportLinkFailure("auth", "授权失效");
    await flush();
    reportLinkPaired("2026-11-17T04:00:00.000Z");
    await flush();
    expect(getLinkState().authorization).toBe("paired");
    expect(getLinkState().connection).toBe("unknown");
    expect(await getSetting("sync.link.auth.v1")).toBeNull();

    __resetLinkState();
    await hydrateLinkState();
    expect(getLinkState().authorization).toBe("paired");
  });

  it("解除配对：清空授权、连接与持久标记", async () => {
    await saveConnection({ token: TOKEN, meta: meta() });
    await hydrateLinkState();
    reportLinkOnline();
    reportLinkUnpaired();
    await flush();
    expect(getLinkState().authorization).toBe("unpaired");
    expect(getLinkState().connection).toBe("unknown");
    expect(await getSetting("sync.link.auth.v1")).toBeNull();
    expect(await getSetting("sync.link.last_success.v1")).toBeNull();
  });
});

describe("跨页共享：所有读取者拿到同一份状态", () => {
  it("任何上报都推进同一个快照，页面之间不存在各自维护的副本", async () => {
    await saveConnection({ token: TOKEN, meta: meta() });
    await hydrateLinkState();
    const before = getLinkState();
    reportLinkFailure("offline", "电脑不可达");
    const after = getLinkState();
    expect(after).not.toBe(before);
    // 三个页面读的是同一个对象与同一版本号
    expect(getLinkState()).toBe(after);
    expect(after.rev).toBe(before.rev + 1);
    expect(after.authorization).toBe("paired");
    expect(after.connection).toBe("offline");
  });
});

describe("错误 → 失败分类", () => {
  it("TLS / 授权 / 超时 / 其余离线", () => {
    expect(failureKindFromError({ code: "tls_pin_mismatch" })).toBe("tls");
    expect(failureKindFromError({ code: "tls_handshake" })).toBe("tls");
    expect(failureKindFromError({ code: "unauthorized" })).toBe("auth");
    expect(failureKindFromError({ code: "auth_invalid" })).toBe("auth");
    expect(failureKindFromError({ code: "request_timeout" })).toBe("timeout");
    expect(failureKindFromError(new Error("请求超时，请重试"))).toBe("timeout");
    expect(failureKindFromError(new Error("连接被拒绝"))).toBe("offline");
    expect(failureKindFromError(null)).toBe("offline");
  });
});
