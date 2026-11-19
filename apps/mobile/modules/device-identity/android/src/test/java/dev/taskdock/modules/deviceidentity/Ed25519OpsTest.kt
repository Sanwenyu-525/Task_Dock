// Ed25519 固定向量测试（JVM，无需真机/Keystore）。
//
// 向量由云端同款 node:crypto 生成：
//   seed = 32 × 0x01
//   payload = 契约 §5 的 canonicalExample.expected（UTF-8）
// 断言签名 base64 与 node:crypto 完全一致；再覆盖验签往返、指纹规则与篡改拒绝。
package dev.taskdock.modules.deviceidentity

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class Ed25519OpsTest {
  private val seed = ByteArray(Ed25519Ops.SEED_BYTES) { 0x01 }
  private val canonicalPayload =
    "{\"a\":\"x\",\"b\":1,\"nested\":{\"y\":[3,2,1],\"z\":true}}".toByteArray(Charsets.UTF_8)

  @Test
  fun `signature matches node crypto contract vector`() {
    val signature = Ed25519Ops.sign(seed, canonicalPayload)
    assertEquals(Ed25519Ops.SIGNATURE_BYTES, signature.size)
    assertEquals(
      "JTOdQIzR9w/+B6biFIIV88YoUDhU29x7vwd6n9xhIYjnb2q0yvuB2nToiQRdg/Lnoghk/YwgfZfij9Lf+a4SBw==",
      Ed25519Ops.base64(signature),
    )
  }

  @Test
  fun `public key and fingerprint follow contract rule`() {
    val keyMaterial = Ed25519Ops.fromSeed(seed)
    assertEquals(
      "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=",
      Ed25519Ops.base64(keyMaterial.publicKey),
    )
    assertEquals("34750f98bd59fcfc946da45aaabe933b", Ed25519Ops.fingerprintHex(keyMaterial.publicKey))
    assertEquals(Ed25519Ops.FINGERPRINT_CHARS, Ed25519Ops.fingerprintHex(keyMaterial.publicKey).length)
  }

  @Test
  fun `sign then verify round trip accepts exact payload`() {
    val keyMaterial = Ed25519Ops.fromSeed(seed)
    val signature = Ed25519Ops.sign(keyMaterial.seed, canonicalPayload)
    assertTrue(Ed25519Ops.verify(keyMaterial.publicKey, canonicalPayload, signature))
    // 单字节差异必须失败：canonical 序列化错一位就不能通过验签。
    val tampered = canonicalPayload.copyOf()
    tampered[tampered.size - 2] = (tampered[tampered.size - 2] + 1).toByte()
    assertFalse(Ed25519Ops.verify(keyMaterial.publicKey, tampered, signature))
  }

  @Test
  fun `tampered signature and wrong length are rejected`() {
    val keyMaterial = Ed25519Ops.fromSeed(seed)
    val signature = Ed25519Ops.sign(keyMaterial.seed, canonicalPayload)
    val tampered = signature.copyOf()
    tampered[0] = (tampered[0] + 1).toByte()
    assertFalse(Ed25519Ops.verify(keyMaterial.publicKey, canonicalPayload, tampered))
    assertFalse(Ed25519Ops.verify(keyMaterial.publicKey, canonicalPayload, signature.copyOf(32)))
  }

  @Test
  fun `signature is deterministic for same seed and payload`() {
    val first = Ed25519Ops.sign(seed, canonicalPayload)
    val second = Ed25519Ops.sign(seed, canonicalPayload)
    assertArrayEquals(first, second)
  }
}
