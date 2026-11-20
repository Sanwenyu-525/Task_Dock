// FileLogSink 有界队列 / 轮转降级 / 退避恢复测试（JVM 临时目录，无需真机）。
//
// 生产路径不依赖测试接缝：容量、阈值、时钟、执行器均为 internal 可测点；
// TestDispatcher 是手动队列，断言入队/丢弃计数时任务留在队列里，drain 后才落盘。
package dev.taskdock.modules.logger

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.FileOutputStream
import java.util.ArrayDeque

/** 测试用手动执行器：任务入队不自动执行，drain() 按 FIFO 跑完。 */
internal class TestDispatcher : LogDispatcher {
  val queue = ArrayDeque<Runnable>()
  @Volatile
  var rejected = false

  override fun post(task: Runnable): Boolean = synchronized(this) {
    if (rejected) false else {
      queue.addLast(task)
      true
    }
  }

  fun drain() = synchronized(this) {
    while (queue.isNotEmpty()) queue.removeFirst().run()
  }

  override fun quit() = synchronized(this) {
    rejected = true
    queue.clear()
  }
}

class FileLogSinkTest {

  private fun newTempDir(): File = createTempDir("taskdock-logs-test")

  private fun activeFile(dir: File): File = File(dir, FileLogSink.activeFileName())

  private fun readActiveLines(dir: File): List<String> {
    val f = activeFile(dir)
    return if (f.exists()) f.readLines() else emptyList()
  }

  private fun flush(dispatcher: TestDispatcher) {
    dispatcher.drain()
    // flushBlocking 会把刷盘任务提交到手动队列；另一线程等待 latch，本线程等任务入队后 drain 跑完它。
    var ok = false
    val worker = Thread { ok = FileLogSink.flushBlocking(2_000) }
    worker.start()
    while (dispatcher.queue.isEmpty() && worker.isAlive) Thread.sleep(2)
    dispatcher.drain()
    worker.join(2_000)
    assertTrue(ok)
  }

  @Test
  fun `writes persist as parseable json lines with sanitized metadata`() {
    val dir = newTempDir()
    val dispatcher = TestDispatcher()
    FileLogSink.resetForTest(dir, dispatcher)

    FileLogSink.append("info", "sync", "hello", """{"bytes":12,"kind":"image"}""")
    FileLogSink.append("warn", "sync", "bad metadata", "{not json")
    flush(dispatcher)

    val lines = readActiveLines(dir)
    assertEquals(2, lines.size)
    val first = JSONObject(lines[0])
    assertEquals("info", first.getString("l"))
    assertEquals("hello", first.getString("m"))
    assertEquals("sync", first.getString("tag"))
    val md = first.getJSONObject("md")
    assertEquals(12, md.getInt("bytes"))
    assertEquals("image", md.getString("kind"))
    // 非法 JSON 只丢 metadata，整条日志保留。
    val second = JSONObject(lines[1])
    assertEquals("warn", second.getString("l"))
    assertFalse(second.has("md"))

    FileLogSink.shutdown()
  }

  @Test
  fun `queue full drops low levels first and keeps warn error within reserved quota`() {
    val dir = newTempDir()
    val dispatcher = TestDispatcher()
    FileLogSink.resetForTest(dir, dispatcher)
    FileLogSink.maxPendingLogs = 4
    FileLogSink.highReserved = 2

    // 任务留在手动队列里不执行，队列满载状态可直接观测。
    FileLogSink.append("info", "t", "m1")
    FileLogSink.append("info", "t", "m2") // 低级别第 2 条，占满低级别槽位
    FileLogSink.append("info", "t", "m3") // 低级别槽满 → 丢弃
    FileLogSink.append("warn", "t", "w1") // 高级别配额内
    FileLogSink.append("error", "t", "e1")
    FileLogSink.append("warn", "t", "w2") // 高级别配额满 → 丢弃

    assertEquals(1, FileLogSink.droppedByLevel("info"))
    assertEquals(1, FileLogSink.droppedByLevel("warn"))
    assertEquals(0, FileLogSink.droppedByLevel("error"))
    assertEquals(4, FileLogSink.pendingCount())

    flush(dispatcher)
    assertEquals(0, FileLogSink.pendingCount())
    FileLogSink.shutdown()
  }

  @Test
  fun `concurrent appends do not crash and pending drains to zero`() {
    val dir = newTempDir()
    val dispatcher = TestDispatcher()
    FileLogSink.resetForTest(dir, dispatcher)

    val threads = (1..8).map { index ->
      Thread {
        repeat(50) { FileLogSink.append("info", "sync", "msg-$index-$it") }
      }.apply { start() }
    }
    threads.forEach { it.join(5_000) }
    flush(dispatcher)

    assertEquals(0, FileLogSink.pendingCount())
    assertTrue(activeFile(dir).exists())
    FileLogSink.shutdown()
  }

  @Test
  fun `append after shutdown is silently dropped and counted`() {
    val dir = newTempDir()
    val dispatcher = TestDispatcher()
    FileLogSink.resetForTest(dir, dispatcher)
    FileLogSink.shutdown()

    FileLogSink.append("error", "t", "after shutdown")
    assertEquals(1, FileLogSink.droppedCount.get())
    assertEquals(1, FileLogSink.droppedByLevel("error"))
    assertEquals(0, FileLogSink.pendingCount())
  }

  @Test
  fun `shutdown racing with appends does not crash`() {
    val dir = newTempDir()
    val dispatcher = TestDispatcher()
    FileLogSink.resetForTest(dir, dispatcher)

    val appenders = (1..10).map {
      Thread { repeat(20) { FileLogSink.append("info", "sync", "race") } }.apply { start() }
    }
    val closer = Thread {
      Thread.sleep(20)
      FileLogSink.shutdown()
    }.apply { start() }
    appenders.forEach { it.join(5_000) }
    closer.join(5_000)

    assertEquals(0, FileLogSink.pendingCount())
  }

  @Test
  fun `rename failure enters degraded backoff and does not retry inside window`() {
    val dir = newTempDir()
    var clock = 1_000L
    val dispatcher = TestDispatcher()
    FileLogSink.resetForTest(dir, dispatcher) { clock }
    FileLogSink.maxFileBytes = 120
    FileLogSink.hardFileBytes = 100_000

    // 外部独占占用活动文件（Windows 下 renameTo 对被占用文件返回 false）。
    val lock = FileOutputStream(activeFile(dir))
    repeat(4) { FileLogSink.append("info", "sync", "fail-$it " + "x".repeat(80)) }
    flush(dispatcher)

    assertTrue(FileLogSink.rotateDegraded)
    assertEquals(1, FileLogSink.rotateFailures.get())

    // 退避窗口内继续写：不得重复 rename，失败计数不增长。
    repeat(4) { FileLogSink.append("info", "sync", "retry-$it " + "x".repeat(80)) }
    flush(dispatcher)
    assertEquals(1, FileLogSink.rotateFailures.get())

    // 释放占用，时钟推进过退避窗口：下一条写入即恢复正常轮转。
    lock.close()
    clock = 10_000_000L
    repeat(2) { FileLogSink.append("info", "sync", "recover " + "x".repeat(80)) }
    flush(dispatcher)

    assertFalse(FileLogSink.rotateDegraded)
    assertTrue(File(dir, "app.1.log").exists())
    FileLogSink.shutdown()
  }

  @Test
  fun `active file hard cap bounds growth when rotate keeps failing`() {
    val dir = newTempDir()
    var clock = 1_000L
    val dispatcher = TestDispatcher()
    FileLogSink.resetForTest(dir, dispatcher) { clock }
    FileLogSink.maxFileBytes = 120
    FileLogSink.hardFileBytes = 300

    val lock = FileOutputStream(activeFile(dir))
    repeat(30) { FileLogSink.append("info", "sync", "cap " + "x".repeat(80)) }
    flush(dispatcher)

    val length = activeFile(dir).length()
    assertTrue("active file grew unbounded: $length", length <= 300 + 256)
    assertTrue(FileLogSink.writeFailures.get() > 0)

    lock.close()
    FileLogSink.shutdown()
  }

  @Test
  fun `hard cap recovers on append path without flush after rename becomes available`() {
    val dir = newTempDir()
    var clock = 1_000L
    val dispatcher = TestDispatcher()
    FileLogSink.resetForTest(dir, dispatcher) { clock }
    FileLogSink.maxFileBytes = 100_000
    FileLogSink.hardFileBytes = 300

    // 外部独占占用活动文件：rename 持续失败。写到硬上限后由硬上限分支首次 rotate 失败
    // 进入降级，之后的写入有界丢弃并计数。
    val lock = FileOutputStream(activeFile(dir))
    repeat(20) { FileLogSink.append("info", "sync", "cap " + "x".repeat(80)) }
    dispatcher.drain()

    assertTrue(FileLogSink.rotateDegraded)
    assertTrue(FileLogSink.bytesInFile() >= FileLogSink.hardFileBytes)
    val failuresBeforeRecovery = FileLogSink.writeFailures.get()
    assertTrue(failuresBeforeRecovery > 0)

    // 退避未到期：硬上限分支不重试 rename，本条仍有界丢弃，写失败计数 +1。
    FileLogSink.append("info", "sync", "still capped")
    dispatcher.drain()
    assertEquals(failuresBeforeRecovery + 1, FileLogSink.writeFailures.get())

    // 释放占用 + 时钟越过退避窗口；全程不调用 flushWriter/flushBlocking，
    // 恢复必须由下一条 append 的写线程路径自行触发。
    lock.close()
    clock = 10_000_000L
    FileLogSink.append("info", "sync", "recovered line one")
    dispatcher.drain()

    assertFalse(FileLogSink.rotateDegraded)
    assertEquals(0, FileLogSink.rotateFailures.get())
    // 恢复这条不得再计入写失败。
    assertEquals(failuresBeforeRecovery + 1, FileLogSink.writeFailures.get())
    assertTrue(File(dir, "app.1.log").exists())
    // 恢复后的第一条已进入活动文件（字节计数增长；缓冲未落盘不由本用例的 flush 负责）。
    val bytesAfterOne = FileLogSink.bytesInFile()
    assertTrue(bytesAfterOne > 0)

    FileLogSink.append("info", "sync", "recovered line two")
    dispatcher.drain()
    // 第二条继续正常落盘，字节计数继续增长，未再进入硬上限丢弃。
    assertTrue(FileLogSink.bytesInFile() > bytesAfterOne)
    FileLogSink.shutdown()
  }

  @Test
  fun `write open failure is counted without throwing`() {
    // 把目录指到一个普通文件上：openWriter 必然失败。
    val notDir = createTempFile("not-a-dir", ".txt")
    val dispatcher = TestDispatcher()
    FileLogSink.resetForTest(notDir, dispatcher)

    FileLogSink.append("error", "t", "io failure")
    flush(dispatcher)

    assertTrue(FileLogSink.writeFailures.get() > 0)
    FileLogSink.shutdown()
    notDir.delete()
  }

  @Test
  fun `flush after shutdown reports true without pending`() {
    val dir = newTempDir()
    val dispatcher = TestDispatcher()
    FileLogSink.resetForTest(dir, dispatcher)
    FileLogSink.shutdown()
    assertTrue(FileLogSink.flushBlocking(1_000))
    assertEquals(0, FileLogSink.pendingCount())
  }

  @Test
  fun `rotate backoff doubles from base and caps at max delay`() {
    assertEquals(5_000L, FileLogSink.rotateBackoff(1))
    assertEquals(10_000L, FileLogSink.rotateBackoff(2))
    assertEquals(20_000L, FileLogSink.rotateBackoff(3))
    // 位移上限后封顶 60 s。
    assertEquals(60_000L, FileLogSink.rotateBackoff(11))
  }

  @Test
  fun `backoff grows exponentially and caps at max delay`() {
    val dir = newTempDir()
    var clock = 0L
    val dispatcher = TestDispatcher()
    FileLogSink.resetForTest(dir, dispatcher) { clock }
    FileLogSink.maxFileBytes = 120
    FileLogSink.hardFileBytes = 100_000
    val lock = FileOutputStream(activeFile(dir))

    // 连续触发 3 次失败（每次都在退避窗口外，手动推进时钟）。
    repeat(3) {
      clock = 10_000_000L * (it + 1)
      repeat(2) { FileLogSink.append("info", "sync", "backoff " + "x".repeat(80)) }
      dispatcher.drain()
    }
    assertEquals(3, FileLogSink.rotateFailures.get())
    assertTrue(FileLogSink.rotateDegraded)

    lock.close()
    FileLogSink.shutdown()
  }
}
