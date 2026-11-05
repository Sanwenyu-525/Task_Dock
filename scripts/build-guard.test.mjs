import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverTargetDirs } from "./build-guard.mjs";

test("discoverTargetDirs 只返回 target-* 普通目录", () => {
  const root = mkdtempSync(join(tmpdir(), "build-guard-"));
  try {
    mkdirSync(join(root, "target-new"));
    mkdirSync(join(root, "target-nested"), { recursive: true });
    mkdirSync(join(root, "src-tauri"));
    writeFileSync(join(root, "target-file.txt"), "");

    const names = discoverTargetDirs(root)
      .map((p) => p.slice(root.length + 1))
      .sort();
    assert.deepEqual(names, ["target-nested", "target-new"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
