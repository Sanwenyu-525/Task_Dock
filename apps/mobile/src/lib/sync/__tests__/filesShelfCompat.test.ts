// 暂存架接口的 404 二义性处理：
// 旧桌面端没有 `/v1/files/{id}/shelf` 与 `/v1/shelf/groups`，
// 新桌面端在「记录不存在/不属于本设备」时也返回 404。
// 客户端必须用只读能力探测把两者分开，否则「版本过低」会被误报成「文件没了」。
import { describe, expect, it } from "vitest";

import type { HttpResponseLike } from "../client";
import { encryptEnvelope } from "../crypto";
import { AppError } from "../../errors";
import { AAD_SHELF_GROUPS, createFileClient } from "../files";

const KEY = new Uint8Array(32).fill(3);
const TOKEN = "d".repeat(64);
const FILE_ID = "e".repeat(32);

function jsonResponse(status: number, body: unknown): HttpResponseLike {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function clientWith(handler: (path: string, method: string) => HttpResponseLike) {
  return createFileClient({
    baseUrl: "https://192.168.1.5:4782",
    token: TOKEN,
    syncKey: KEY,
    fetchImpl: async (url, init) => {
      const path = new URL(url).pathname;
      return handler(path, init.method ?? "GET");
    },
  });
}

describe("暂存架 404 能力探测", () => {
  it("两个接口都 404 = 旧桌面端：抛 not_supported（提示升级，而不是记录不存在）", async () => {
    const client = clientWith((path) => {
      if (path === `/v1/files/${FILE_ID}/shelf` || path === "/v1/shelf/groups") {
        return jsonResponse(404, { error: "not_found", message: "接口不存在" });
      }
      throw new Error(`unexpected ${path}`);
    });

    await expect(client.importToShelf(FILE_ID, null)).rejects.toMatchObject({
      status: 404,
      code: "not_supported",
    });
  });

  it("分组接口可用 = 新桌面端：保留原始 404（传输记录不存在）", async () => {
    const groups = encryptEnvelope(KEY, AAD_SHELF_GROUPS, {
      groups: [{ id: "g1", name: "默认分组", builtin: true }],
    });
    const client = clientWith((path) => {
      if (path === `/v1/files/${FILE_ID}/shelf`) {
        return jsonResponse(404, { error: "not_found", message: "传输记录不存在" });
      }
      if (path === "/v1/shelf/groups") return jsonResponse(200, groups);
      throw new Error(`unexpected ${path}`);
    });

    await expect(client.importToShelf(FILE_ID, null)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });

  it("探测本身 401 时用授权错误覆盖 404（授权问题必须优先暴露）", async () => {
    const client = clientWith((path) => {
      if (path === `/v1/files/${FILE_ID}/shelf`) {
        return jsonResponse(404, { error: "not_found", message: "接口不存在" });
      }
      if (path === "/v1/shelf/groups") {
        return jsonResponse(401, { error: "unauthorized", message: "缺少设备令牌" });
      }
      throw new Error(`unexpected ${path}`);
    });

    await expect(client.importToShelf(FILE_ID, null)).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });

  it("探测本身 TLS 失败时保留安全错误，不能退化成记录不存在", async () => {
    const client = createFileClient({
      baseUrl: "https://192.168.1.5:4782",
      token: TOKEN,
      syncKey: KEY,
      fetchImpl: async (url) => {
        const path = new URL(url).pathname;
        if (path === `/v1/files/${FILE_ID}/shelf`) {
          return jsonResponse(404, { error: "not_found", message: "传输记录不存在" });
        }
        if (path === "/v1/shelf/groups") {
          throw new AppError("validation", "证书指纹不匹配", undefined, "tls_pin_mismatch");
        }
        throw new Error(`unexpected ${path}`);
      },
    });

    await expect(client.importToShelf(FILE_ID, null)).rejects.toMatchObject({
      code: "tls_pin_mismatch",
    });
  });

  it("探测成功但原始 404 没有业务码时，也转换为 not_found", async () => {
    const groups = encryptEnvelope(KEY, AAD_SHELF_GROUPS, {
      groups: [{ id: "g1", name: "默认分组", builtin: true }],
    });
    const client = clientWith((path) => {
      if (path === `/v1/files/${FILE_ID}/shelf`) return jsonResponse(404, {});
      if (path === "/v1/shelf/groups") return jsonResponse(200, groups);
      throw new Error(`unexpected ${path}`);
    });

    await expect(client.importToShelf(FILE_ID, null)).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });
});

describe("HTTP 错误体里的业务码必须保留", () => {
  it("401 响应体 error=unauthorized 被解析到错误对象上", async () => {
    const client = clientWith((path) => {
      if (path === "/v1/files") {
        return jsonResponse(401, { error: "unauthorized", message: "缺少设备令牌" });
      }
      throw new Error(`unexpected ${path}`);
    });

    await expect(client.list()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("错误体不是 JSON 时仍保留 HTTP 状态码", async () => {
    const client = clientWith((path) => {
      if (path === "/v1/files") {
        return {
          ok: false,
          status: 403,
          json: async () => {
            throw new SyntaxError("not json");
          },
        };
      }
      throw new Error(`unexpected ${path}`);
    });

    await expect(client.list()).rejects.toMatchObject({ status: 403, code: null });
  });
});
