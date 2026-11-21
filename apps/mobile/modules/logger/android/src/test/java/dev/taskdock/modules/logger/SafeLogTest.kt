// SafeLog 脱敏规则对照测试（JVM，无需真机）。
//
// 与 JS 侧 src/lib/safeLog.test.ts 的「脱敏规则对照矩阵」是同一组输入 → 同一组期望；
// **改任何一条规则必须同步另一侧**（SafeLog.kt RULES ↔ safeLog.ts REDACT_RULES）。
package dev.taskdock.modules.logger

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SafeLogTest {

  // ---- 规则对照矩阵：输入与期望和 safeLog.test.ts 保持一致 ----

  @Test
  fun `message redaction mirrors JS rule matrix`() {
    val raw = listOf(
      "Authorization: Bearer abcdef0123456789abcdef0123456789",
      "token=abcdef0123456789abcdef0123456789",
      "password:hunter2",
      "secret=topsecretvalue",
      "apikey=abcd1234efgh5678",
      "api_key=abcd1234",
      "api-key=abcd1234",
      "key=sk-abcdef1234567890",
      "https://host/path?key=querysecret&auth=authtok&sig=sigval123",
      "contact alice@example.com here",
      "C:\\Users\\ASUS\\secret.txt",
      "file:///data/0/secret",
      "/data/user/0/dev.taskdock/files/x",
      "trace abcdef0123456789 ok",
      "hex deadbeefdeadbeefdeadbeefdeadbeef done",
    ).joinToString("\n")

    val out = SafeLog.sanitizeText(raw)

    // 单行化：换行被折叠。
    assertFalse(out.contains("\n"))
    // 凭据/邮箱/密钥/路径原值不得残留。
    assertFalse(out.contains("hunter2"))
    assertFalse(out.contains("topsecretvalue"))
    assertFalse(out.contains("abcd1234efgh5678"))
    assertFalse(out.contains("querysecret"))
    assertFalse(out.contains("authtok"))
    assertFalse(out.contains("sigval123"))
    assertFalse(out.contains("alice@example.com"))
    assertFalse(out.contains("C:\\"))
    assertFalse(out.contains("file://"))
    assertFalse(out.contains("/data/user"))
    assertFalse(out.contains("deadbeefdeadbeefdeadbeefdeadbeef"))
    assertFalse(out.contains("sk-abcdef1234567890"))
    // 替换标记保留。
    assertTrue(out.contains("[redacted]"))
    assertTrue(out.contains("[path]"))
    // 16 位 traceId 不属于密钥形态，必须保留。
    assertTrue(out.contains("abcdef0123456789"))
  }

  @Test
  fun `bearer token and query params are redacted`() {
    assertTrue(SafeLog.sanitizeText("Bearer abcdef0123456789").contains("[redacted]"))
    assertFalse(SafeLog.sanitizeText("Bearer abcdef0123456789").contains("abcdef0123456789"))
    val url = SafeLog.sanitizeText("https://h/x?auth=zzzzzzzz&sig=yyyyyyyy&key=wwwwwwww")
    assertFalse(url.contains("zzzzzzzz"))
    assertFalse(url.contains("yyyyyyyy"))
    assertFalse(url.contains("wwwwwwww"))
  }

  @Test
  fun `email address is redacted`() {
    val out = SafeLog.sanitizeText("mail bob.smith+tag@example.co.uk end")
    assertFalse(out.contains("bob.smith+tag@example.co.uk"))
    assertTrue(out.contains("[redacted]"))
  }

  @Test
  fun `32-plus hex redacted but 16-hex trace id preserved`() {
    val longHex = SafeLog.sanitizeText("hex ${ "a".repeat(32) }")
    assertFalse(longHex.contains("a".repeat(32)))
    assertTrue(longHex.contains("[redacted]"))
    val trace = SafeLog.sanitizeText("trace abcdef0123456789")
    assertTrue(trace.contains("abcdef0123456789"))
  }

  @Test
  fun `sk-prefixed secret is redacted`() {
    val out = SafeLog.sanitizeText("key sk-abcdef1234567890")
    assertFalse(out.contains("sk-abcdef1234567890"))
    assertTrue(out.contains("[redacted]"))
  }

  @Test
  fun `long message is truncated`() {
    val out = SafeLog.sanitizeText("x".repeat(600))
    assertTrue(out.length <= 513)
    assertTrue(out.endsWith("…"))
  }

  @Test
  fun `throwable message with secret is sanitized before logging`() {
    val t = IllegalStateException("password:hunter2 failed at /data/user/0/x")
    val out = SafeLog.sanitizeText(t.message ?: "")
    assertFalse(out.contains("hunter2"))
    assertFalse(out.contains("/data/user"))
    assertTrue(out.contains("[redacted]"))
  }

  @Test
  fun `tag is normalized to slug`() {
    assertEquals("device-identity", SafeLog.normalizeTag("Device Identity!!"))
    assertEquals("app", SafeLog.normalizeTag("###"))
    assertEquals("a".repeat(23), SafeLog.normalizeTag("a".repeat(40)))
  }

  // ---- metadata 白名单 ----

  @Test
  fun `metadata whitelist keeps basic values and redacts strings`() {
    val json = """{"kind":"image","bytes":2048,"path":"C:\\Users\\ASUS\\a.jpg","ok":true,"empty":null}"""
    val md = SafeLog.sanitizeMetadataJson(json)
    requireNotNull(md)
    assertEquals("image", md.getString("kind"))
    assertEquals(2048, md.getInt("bytes"))
    assertEquals("[path]", md.getString("path"))
    assertTrue(md.getBoolean("ok"))
    assertTrue(md.isNull("empty"))
  }

  @Test
  fun `metadata sensitive key names force redaction`() {
    val json = """{"password":"P@ssw0rd","token":"abc123","api_key":"raw","key":123456,"authorization":"Bearer secret","note":"password:hunter2"}"""
    val md = SafeLog.sanitizeMetadataJson(json)
    requireNotNull(md)
    assertEquals("[redacted]", md.getString("password"))
    assertEquals("[redacted]", md.getString("token"))
    assertEquals("[redacted]", md.getString("api_key"))
    assertEquals("[redacted]", md.getString("key"))
    assertEquals("[redacted]", md.getString("authorization"))
    assertEquals("[redacted]", md.getString("note"))
  }

  @Test
  fun `metadata drops nested objects and arrays`() {
    val json = """{"nested":{"a":1},"list":[1],"name":"ok"}"""
    val md = SafeLog.sanitizeMetadataJson(json)
    requireNotNull(md)
    assertFalse(md.has("nested"))
    assertFalse(md.has("list"))
    assertEquals("ok", md.getString("name"))
  }

  @Test
  fun `invalid metadata json drops metadata but keeps caller log line`() {
    assertNull(SafeLog.sanitizeMetadataJson("{not json"))
    assertNull(SafeLog.sanitizeMetadataJson(""))
    assertNull(SafeLog.sanitizeMetadataJson(null))
  }

  @Test
  fun `metadata key count and key length are limited`() {
    // 两个 64 位长键截断到 32 位前缀（互不撞前缀）；键数不超过上限。
    val first = "k".repeat(64)
    val second = "z".repeat(64)
    val json = """{"$first":"va","$second":"vz","kind":"x"}"""
    val md = SafeLog.sanitizeMetadataJson(json)
    requireNotNull(md)
    assertTrue(md.length() <= SafeLog.MAX_METADATA_KEYS)
    assertFalse(md.has(first))
    assertFalse(md.has(second))
    assertEquals("va", md.getString(first.take(SafeLog.MAX_KEY_CHARS)))
    assertEquals("vz", md.getString(second.take(SafeLog.MAX_KEY_CHARS)))
  }

  @Test
  fun `metadata colliding truncated keys keep the first arrival`() {
    // 两个 64 位键截断后撞同一 32 位前缀：只保留先遍历到的一条，另一条丢弃。
    val first = "k".repeat(64)
    val second = "k".repeat(32) + "z".repeat(32)
    val json = """{"$first":"va","$second":"vb"}"""
    val md = SafeLog.sanitizeMetadataJson(json)
    requireNotNull(md)
    assertEquals(1, md.length())
    assertTrue(md.has(first.take(SafeLog.MAX_KEY_CHARS)))
    assertFalse(md.has(second))
  }

  @Test
  fun `metadata string value is sanitized and length capped`() {
    val json = """{"note":"password:hunter2 ${ "y".repeat(120) }"}"""
    val md = SafeLog.sanitizeMetadataJson(json)
    requireNotNull(md)
    val value = md.getString("note")
    assertFalse(value.contains("hunter2"))
    assertTrue(value.length <= SafeLog.MAX_METADATA_VALUE_CHARS + 1)
  }

  @Test
  fun `all-dropped metadata yields null`() {
    assertNull(SafeLog.sanitizeMetadataJson("""{"nested":{"a":1},"list":[1]}"""))
  }
}
