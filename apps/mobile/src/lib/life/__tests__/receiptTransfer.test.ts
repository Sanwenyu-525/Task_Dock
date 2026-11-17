// 票据原图传输链路测试：只 mock 文件系统/网络边界，验证状态机是否如实落库。
// 覆盖「本机文件缺失」「上传成功但导入失败」「重试复用远端文件」「已完成幂等」。
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  fileExists: true,
  link: {
    id: "link-1",
    ownerType: "event" as const,
    ownerId: "ev-1",
    documentRef: "asset-1",
    documentSource: "capture_asset" as const,
    documentName: "小票.jpg",
    mime: "image/jpeg",
    byteSize: 1024,
    remoteRef: null as string | null,
    remoteSource: null as "file" | "shelf_item" | null,
    transferState: "local" as "local" | "metadata_only" | "transferred" | "missing",
    localUri: "/data/receipt.jpg" as string | null,
  },
  uploadCalls: 0,
  importCalls: 0,
}));

vi.mock("../../../db/life", () => ({
  getDocumentLink: vi.fn(async () => ({ ...state.link })),
  markDocumentFileUploaded: vi.fn(async (_linkId: string, input: { remoteFileId: string; name: string }) => {
    state.link.remoteRef = input.remoteFileId;
    state.link.remoteSource = "file";
    state.link.transferState = "metadata_only";
  }),
  markDocumentUploaded: vi.fn(async (_linkId: string, input: { shelfItemId: string; name: string }) => {
    state.link.remoteRef = input.shelfItemId;
    state.link.remoteSource = "shelf_item";
    state.link.transferState = "transferred";
  }),
  setDocumentLinkTransferState: vi.fn(async (_linkId: string, next: (typeof state.link)["transferState"]) => {
    state.link.transferState = next;
  }),
}));

vi.mock("../../../db/syncConnection", () => ({
  loadConnection: vi.fn(async () => ({
    baseUrl: "https://192.168.1.10:47821",
    tlsFingerprint: "PIN",
  })),
  readToken: vi.fn(async () => "pair-token"),
}));

vi.mock("../../sync/crypto", () => ({ deriveSyncKey: vi.fn(async () => "key") }));

vi.mock("../../sync/files", () => ({
  createFileClient: vi.fn(() => ({
    importToShelf: vi.fn(async () => {
      state.importCalls += 1;
      return state.importCalls === 1
        ? Promise.reject(new Error("shelf unavailable"))
        : { shelf_item_id: "shelf-1", name: "小票.jpg", size: 1024 };
    }),
    cancel: vi.fn(),
  })),
}));

vi.mock("../../sync/fileIo", () => ({
  uploadLocalFile: vi.fn(async () => {
    state.uploadCalls += 1;
    return { id: "file-1", name: "小票.jpg", size: 1024 };
  }),
}));

vi.mock("../../sync/pairing", () => ({
  normalizeTlsFingerprint: vi.fn(() => "PIN"),
}));

vi.mock("expo-file-system", () => ({
  File: class {
    constructor(readonly uri: string) {}
    get exists() {
      return state.fileExists;
    }
  },
}));

import { sendReceiptToDesktop } from "../receiptTransfer";
import { setDocumentLinkTransferState, markDocumentFileUploaded } from "../../../db/life";
import { uploadLocalFile } from "../../sync/fileIo";

beforeEach(() => {
  state.fileExists = true;
  state.uploadCalls = 0;
  state.importCalls = 0;
  state.link = {
    id: "link-1",
    ownerType: "event",
    ownerId: "ev-1",
    documentRef: "asset-1",
    documentSource: "capture_asset",
    documentName: "小票.jpg",
    mime: "image/jpeg",
    byteSize: 1024,
    remoteRef: null,
    remoteSource: null,
    transferState: "local",
    localUri: "/data/receipt.jpg",
  };
  vi.clearAllMocks();
});

describe("票据原图传输", () => {
  it("本机原文件缺失：落 missing 并明确报错，不假装上传成功", async () => {
    state.fileExists = false;
    await expect(sendReceiptToDesktop("link-1")).rejects.toThrow(/原图已缺失/);
    expect(setDocumentLinkTransferState).toHaveBeenCalledWith("link-1", "missing");
    expect(uploadLocalFile).not.toHaveBeenCalled();
  });

  it("上传成功但导入失败：保留远端文件 ID；重试只导入不重复上传", async () => {
    state.importCalls = 0;
    await expect(sendReceiptToDesktop("link-1")).rejects.toThrow(/导入票据暂存失败/);
    expect(uploadLocalFile).toHaveBeenCalledTimes(1);
    expect(state.link).toMatchObject({
      remoteSource: "file",
      remoteRef: "file-1",
      transferState: "metadata_only",
    });

    // 第二次进入同一票据：复用 file-1，只调用暂存导入。
    const outcome = await sendReceiptToDesktop("link-1");
    expect(outcome).toEqual({ linkId: "link-1", shelfItemId: "shelf-1", name: "小票.jpg" });
    expect(uploadLocalFile).toHaveBeenCalledTimes(1);
    expect(markDocumentFileUploaded).toHaveBeenCalledTimes(1);
    expect(state.link).toMatchObject({
      remoteSource: "shelf_item",
      remoteRef: "shelf-1",
      transferState: "transferred",
    });
  });

  it("已 transferred 时重复点击直接返回，不再上传或导入", async () => {
    state.link.transferState = "transferred";
    state.link.remoteSource = "shelf_item";
    state.link.remoteRef = "shelf-existing";
    const outcome = await sendReceiptToDesktop("link-1");
    expect(outcome.shelfItemId).toBe("shelf-existing");
    expect(uploadLocalFile).not.toHaveBeenCalled();
    expect(state.importCalls).toBe(0);
  });
});
