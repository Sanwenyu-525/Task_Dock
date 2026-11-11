// 配对 v2 协议解析测试：二维码字段、TLS 指纹强制、地址归一化。
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MOBILE_SYNC_PORT,
  MOBILE_API_VERSION,
  normalizeDesktopAddress,
  normalizePairingCode,
  normalizeTlsFingerprint,
  parsePairingUri,
  targetToAddress,
} from "../pairing";

const TLS_FP = "a".repeat(64);
const URI_V2 = (overrides: Record<string, string> = {}): string => {
  const params = new URLSearchParams({
    v: "2",
    host: "192.168.1.10",
    port: "47822",
    code: "042913",
    // URLSearchParams 自行做百分号编码；这里给原文，避免双重编码。
    name: "台式机",
    instance: "abc123def456",
    fp: "1A2B3C4D",
    tls: TLS_FP,
    ...overrides,
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === "") params.delete(key);
  }
  return `taskdock://pair?${params.toString()}`;
};

describe("MOBILE_API_VERSION", () => {
  it("手机端协议版本为 2（TLS-only）", () => {
    expect(MOBILE_API_VERSION).toBe(2);
  });
});

describe("parsePairingUri（v2）", () => {
  it("解析完整 v2 二维码并小写化 TLS 指纹", () => {
    const target = parsePairingUri(URI_V2());
    expect(target).not.toBeNull();
    expect(target?.host).toBe("192.168.1.10");
    expect(target?.port).toBe(47822);
    expect(target?.code).toBe("042913");
    expect(target?.serverName).toBe("台式机");
    expect(target?.instanceId).toBe("abc123def456");
    expect(target?.fingerprint).toBe("1A2B3C4D");
    expect(target?.tlsFingerprint).toBe(TLS_FP);
  });

  it("大写 TLS 指纹统一转小写", () => {
    const target = parsePairingUri(URI_V2({ tls: TLS_FP.toUpperCase() }));
    expect(target?.tlsFingerprint).toBe(TLS_FP);
  });

  it("v1 二维码（无 tls 参数）被拒绝：旧版桌面端必须先升级", () => {
    expect(parsePairingUri("taskdock://pair?v=1&host=192.168.1.10&port=47822&code=042913")).toBeNull();
  });

  it("缺少 tls 字段返回 null（fail-closed）", () => {
    expect(parsePairingUri(URI_V2({ tls: "" }))).toBeNull();
  });

  it("tls 长度或字符非法返回 null", () => {
    expect(parsePairingUri(URI_V2({ tls: "a".repeat(63) }))).toBeNull();
    expect(parsePairingUri(URI_V2({ tls: `g${"a".repeat(63)}` }))).toBeNull();
  });

  it("版本号不是 2 返回 null", () => {
    expect(parsePairingUri(URI_V2({ v: "3" }))).toBeNull();
  });

  it("非法端口 / 配对码 / 主机返回 null", () => {
    expect(parsePairingUri(URI_V2({ port: "0" }))).toBeNull();
    expect(parsePairingUri(URI_V2({ port: "99999" }))).toBeNull();
    expect(parsePairingUri(URI_V2({ code: "04291" }))).toBeNull();
    // 含空格/中文的主机不是合法 IPv4 也非法主机名（数字型字符串会走 hostname
    // 分支，属于既有宽松行为，连接层会做 DNS/TLS 校验，不在此收紧）。
    expect(parsePairingUri(URI_V2({ host: "bad host" }))).toBeNull();
    expect(parsePairingUri(URI_V2({ host: "主机.local" }))).toBeNull();
  });

  it("非 taskdock://pair 链接返回 null", () => {
    expect(parsePairingUri("https://example.com/pair?v=2")).toBeNull();
    expect(parsePairingUri("")).toBeNull();
  });
});

describe("normalizeTlsFingerprint", () => {
  it("接受 64 位十六进制并转小写", () => {
    expect(normalizeTlsFingerprint(`${"AB".repeat(32)}`)).toBe("ab".repeat(32));
  });
  it("拒绝空串、短串与非十六进制", () => {
    expect(normalizeTlsFingerprint("")).toBeNull();
    expect(normalizeTlsFingerprint("a".repeat(32))).toBeNull();
    expect(normalizeTlsFingerprint("短指纹")).toBeNull();
  });
});

describe("normalizeDesktopAddress", () => {
  it("纯 IP 使用默认端口并输出 https", () => {
    expect(normalizeDesktopAddress("192.168.1.10")).toEqual({
      host: "192.168.1.10",
      port: DEFAULT_MOBILE_SYNC_PORT,
      baseUrl: "https://192.168.1.10:47822",
    });
  });

  it("IP:端口 与 https 前缀均可，统一 https", () => {
    expect(normalizeDesktopAddress("192.168.1.10:47900")?.baseUrl).toBe("https://192.168.1.10:47900");
    expect(normalizeDesktopAddress("https://192.168.1.10:47822/")?.baseUrl).toBe(
      "https://192.168.1.10:47822",
    );
  });

  it("v1 遗留的 http:// 输入按 https 处理（明文服务已不存在）", () => {
    expect(normalizeDesktopAddress("http://192.168.1.10:47822")?.baseUrl).toBe(
      "https://192.168.1.10:47822",
    );
  });

  it("拒绝端口越界与空串", () => {
    expect(normalizeDesktopAddress("192.168.1.10:0")).toBeNull();
    expect(normalizeDesktopAddress("")).toBeNull();
  });
});

describe("targetToAddress", () => {
  it("生成 https 地址", () => {
    const target = parsePairingUri(URI_V2())!;
    expect(targetToAddress(target)).toEqual({
      host: "192.168.1.10",
      port: 47822,
      baseUrl: "https://192.168.1.10:47822",
    });
  });
});

describe("normalizePairingCode", () => {
  it("只保留 6 位数字", () => {
    expect(normalizePairingCode(" 04 29 13 ")).toBe("042913");
    expect(normalizePairingCode("1234567890")).toBe("123456");
  });
});
