import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { binaryFingerprint, evaluatePayloads } from "./build-candidate.mjs";

test("安装包载荷一致时通过", () => {
  const r = evaluatePayloads("AAA", [{ source: "nsis", status: "extracted", neutral: "AAA" }, { source: "msi", status: "extracted", neutral: "AAA" }]);
  assert.equal(r.ok, true);
  assert.equal(r.complete, true);
  assert.equal(r.distinct, 1);
});

test("NSIS 与 MSI 内嵌二进制不同必须失败", () => {
  const r = evaluatePayloads("AAA", [{ source: "nsis", status: "extracted", neutral: "AAA" }, { source: "msi", status: "extracted", neutral: "BBB" }]);
  assert.equal(r.ok, false);
  assert.equal(r.distinct, 2);
});

test("记录值与载荷不一致必须失败", () => {
  const r = evaluatePayloads("CCC", [{ source: "msi", status: "extracted", neutral: "BBB" }]);
  assert.equal(r.ok, false);
});

test("有期望值但未解包任何载荷时判定失败", () => {
  const r = evaluatePayloads("AAA", []);
  assert.equal(r.ok, false);
});

test("无期望值且未解包载荷时保持未知但不失败", () => {
  const r = evaluatePayloads(null, []);
  assert.equal(r.ok, true);
  assert.equal(r.complete, false);
});

test("只有单一载荷被解包时判定为部分完成而非完全通过", () => {
  const r = evaluatePayloads(null, [{ source: "nsis", status: "skipped", neutral: null }, { source: "msi", status: "extracted", neutral: "BBB" }]);
  assert.equal(r.ok, true);
  assert.equal(r.complete, false);
  assert.equal(r.skipped, 1);
  assert.equal(r.extracted, 1);
});

test("bundle-type 3/4 字节差异被归零，其余差异仍保留", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "taskdock-fp-"));
  try {
    const prefix = Buffer.from("prefix__TAURI_BUNDLE_TYPE_VAR_NSScompilepath__TAURI_BUNDLE_TYPE_VAR_");
    const withUnk = Buffer.concat([prefix, Buffer.from("UNK.svgb"), Buffer.from("tail")]);
    const withMsi = Buffer.concat([prefix, Buffer.from("MSI.svgb"), Buffer.from("tail")]);
    const a = path.join(dir, "unk.bin");
    const b = path.join(dir, "msi.bin");
    writeFileSync(a, withUnk);
    writeFileSync(b, withMsi);
    const fa = binaryFingerprint(a);
    const fb = binaryFingerprint(b);
    assert.equal(fa.bundleType, "UNK");
    assert.equal(fb.bundleType, "MSI");
    assert.notEqual(fa.sha256, fb.sha256);
    assert.equal(fa.neutral, fb.neutral);

    const changed = Buffer.concat([prefix, Buffer.from("UNK.svgb"), Buffer.from("tail-changed")]);
    const c = path.join(dir, "changed.bin");
    writeFileSync(c, changed);
    assert.notEqual(binaryFingerprint(c).neutral, fa.neutral);

    const nsis = Buffer.concat([prefix, Buffer.from("NSISsvgb"), Buffer.from("tail")]);
    const d = path.join(dir, "nsis.bin");
    writeFileSync(d, nsis);
    assert.equal(binaryFingerprint(d).bundleType, "NSIS");
    assert.equal(binaryFingerprint(d).neutral, fa.neutral);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
