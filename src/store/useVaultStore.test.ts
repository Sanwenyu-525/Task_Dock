import { beforeEach, describe, expect, it, vi } from "vitest";

import type { VaultRecordDetail } from "../lib/vault";

vi.mock("../lib/vault", () => ({
  vaultApi: {
    getRecord: vi.fn(),
    listRecords: vi.fn().mockResolvedValue([]),
  },
}));

import { vaultApi } from "../lib/vault";
import { useVaultStore } from "./useVaultStore";

const base: VaultRecordDetail = {
  id: "r1",
  rev: 1,
  type: "password",
  title: "示例站点",
  username: "alice",
  email: "",
  url: "https://example.com",
  platform: "",
  categoryId: "cat",
  categoryName: "账号",
  tagIds: [],
  tagNames: [],
  favorite: false,
  updatedAt: "2026-11-18T00:00:00Z",
  fieldCount: 1,
  note: "",
  createdAt: "2026-11-18T00:00:00Z",
  fields: [],
};

function detailWith(revealed: boolean): VaultRecordDetail {
  return {
    ...base,
    fields: [
      {
        id: "password",
        label: "密码",
        kind: "password",
        revealed,
        value: revealed ? "secret-value" : "••••••",
      },
    ],
  };
}

beforeEach(() => {
  vi.mocked(vaultApi.getRecord).mockImplementation(async (_id, reveal = []) => {
    return detailWith(reveal.includes("password"));
  });
  useVaultStore.setState({ detail: detailWith(false), error: null });
});

describe("useVaultStore field reveal", () => {
  it("reveals a hidden field and hides it again without dropping other fields", async () => {
    await useVaultStore.getState().toggleFieldReveal("password");
    expect(vaultApi.getRecord).toHaveBeenLastCalledWith("r1", ["password"]);
    expect(useVaultStore.getState().detail?.fields[0].revealed).toBe(true);

    await useVaultStore.getState().toggleFieldReveal("password");
    expect(vaultApi.getRecord).toHaveBeenLastCalledWith("r1", []);
    expect(useVaultStore.getState().detail?.fields[0].revealed).toBe(false);
  });
});
