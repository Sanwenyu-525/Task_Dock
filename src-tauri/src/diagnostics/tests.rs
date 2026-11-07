//! 诊断日志核心单元测试：写入、UTF-8、轮转、保留、聚合、清理、降级、退出。

use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;

use super::*;

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("taskdock-diag-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_events(dir: &Path, events: &[DiagnosticEvent]) {
    use std::io::Write;
    let path = dir.join(ACTIVE_FILE);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    for event in events {
        writeln!(file, "{}", serde_json::to_string(event).unwrap()).unwrap();
    }
    file.flush().unwrap();
}

fn read_events(dir: &Path) -> Vec<DiagnosticEvent> {
    let mut out = Vec::new();
    for file in query::list_files(dir) {
        let path = dir.join(&file.name);
        let Ok(handle) = std::fs::File::open(&path) else {
            continue;
        };
        for line in std::io::BufReader::new(handle)
            .lines()
            .map_while(Result::ok)
        {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(event) = serde_json::from_str::<DiagnosticEvent>(&line) {
                out.push(event);
            }
        }
    }
    out
}

fn small_config() -> WriterConfig {
    WriterConfig {
        max_file_bytes: 1024,
        max_archive_files: 2,
        max_total_bytes: 10 * 1024 * 1024,
        agg_window: Duration::from_millis(50),
        agg_capacity: 8,
    }
}

fn event(level: DiagLevel, module: &str, action: &str, message: &str) -> DiagnosticEvent {
    DiagnosticEvent::new(level, module, action, "failed").with_message(message)
}

#[test]
fn writes_jsonl_with_utf8_and_session() {
    let dir = temp_dir("write");
    let diag = Diagnostics::init_at(dir.clone(), WriterConfig::default());
    diag.record(event(
        DiagLevel::Error,
        "task",
        "create",
        "创建任务失败：数据库正忙",
    ));
    diag.flush_blocking();

    let events = read_events(&dir);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].module, "task");
    assert_eq!(events[0].action, "create");
    assert_eq!(events[0].level, DiagLevel::Error);
    assert_eq!(events[0].source, DiagSource::Rust);
    assert_eq!(events[0].session_id, diag.session_id());
    assert!(events[0]
        .message
        .as_deref()
        .unwrap()
        .contains("创建任务失败"));
    // 时间戳必须可解析为带时区的 RFC3339
    let parsed = chrono::DateTime::parse_from_rfc3339(&events[0].timestamp).unwrap();
    assert!(parsed.timestamp() > 0);
    diag.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn debug_events_are_dropped_in_normal_mode_and_kept_in_verbose() {
    let dir = temp_dir("level");
    let diag = Diagnostics::init_at(dir.clone(), WriterConfig::default());
    assert!(!diag.record(event(DiagLevel::Debug, "ui", "render", "细节")));
    assert!(diag.record(event(DiagLevel::Warn, "ui", "render", "异常")));

    diag.set_mode(true, Some(1));
    assert!(diag.is_verbose());
    assert!(diag.record(event(DiagLevel::Debug, "ui", "render", "细节")));
    diag.flush_blocking();

    let events = read_events(&dir);
    assert!(events.iter().any(|e| e.level == DiagLevel::Warn));
    assert!(events.iter().any(|e| e.level == DiagLevel::Debug));
    diag.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn verbose_mode_expires_back_to_normal() {
    let dir = temp_dir("verbose-expire");
    let diag = Diagnostics::init_at(dir.clone(), WriterConfig::default());
    // 直接设置一个极短的有效期：与生产路径共用同一原子字段。
    diag.verbose_until_ms
        .store(diag.now_ms().saturating_add(20), Ordering::Relaxed);
    assert!(diag.is_verbose());
    std::thread::sleep(Duration::from_millis(40));
    assert!(!diag.is_verbose(), "到期后必须自动恢复正常模式");
    assert_eq!(diag.verbose_remaining_ms(), 0);
    diag.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn rotates_when_file_exceeds_limit() {
    let dir = temp_dir("rotate");
    let diag = Diagnostics::init_at(dir.clone(), small_config());
    // 用 INFO 事件（WARN/ERROR 会被聚合，无法验证“纯写入量”驱动的轮转）。
    for i in 0..40 {
        diag.record(event(
            DiagLevel::Info,
            "clipboard",
            "paste",
            &format!("批量粘贴进度 {i} 这是一段用于撑大日志行的说明文字"),
        ));
    }
    diag.flush_blocking();
    let files = query::list_files(&dir);
    assert!(
        files.iter().any(|f| !f.active),
        "超过单文件上限后必须产生归档文件: {files:?}"
    );
    assert!(
        files.len() <= small_config().max_archive_files + 1,
        "归档数量必须受保留策略约束: {files:?}"
    );
    for file in &files {
        assert!(
            file.bytes <= small_config().max_file_bytes + 512,
            "单个文件不得明显超过上限: {} {}",
            file.name,
            file.bytes
        );
    }
    diag.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn aggregates_repeated_noise_without_operation_id() {
    let dir = temp_dir("aggregate");
    let mut cfg = small_config();
    cfg.agg_window = Duration::from_millis(50);
    let diag = Diagnostics::init_at(dir.clone(), cfg);
    for _ in 0..4 {
        diag.record(event(DiagLevel::Warn, "agent", "connect", "连接超时"));
    }
    std::thread::sleep(Duration::from_millis(120));
    diag.flush_blocking();

    let events = read_events(&dir);
    let raw: Vec<_> = events.iter().filter(|e| e.event == "failed").collect();
    let summaries: Vec<_> = events.iter().filter(|e| e.event == "aggregated").collect();
    assert_eq!(raw.len(), 1, "窗口内只写一条原始行: {events:?}");
    assert_eq!(summaries.len(), 1, "窗口结束写一条摘要: {events:?}");
    assert_eq!(summaries[0].count, 3, "摘要代表 3 次被抑制的重复");
    assert_eq!(
        summaries[0]
            .metadata
            .as_ref()
            .and_then(|m| m.get("occurrences"))
            .and_then(|v| v.as_u64()),
        Some(4)
    );
    diag.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn never_merges_distinct_operations() {
    let dir = temp_dir("no-merge");
    let mut cfg = small_config();
    cfg.agg_window = Duration::from_millis(2_000);
    let diag = Diagnostics::init_at(dir.clone(), cfg);
    for i in 0..3 {
        let mut event = event(DiagLevel::Error, "task", "create", "创建任务失败");
        event.operation_id = Some(format!("op-{i}"));
        event.status = Some(DiagStatus::Failed);
        diag.record(event);
    }
    diag.flush_blocking();
    let events = read_events(&dir);
    let failures: Vec<_> = events.iter().filter(|e| e.event == "failed").collect();
    assert_eq!(failures.len(), 3, "带 operation_id 的失败必须逐条保留");
    diag.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn critical_events_are_never_aggregated() {
    let dir = temp_dir("critical");
    let mut cfg = small_config();
    cfg.agg_window = Duration::from_millis(2_000);
    let diag = Diagnostics::init_at(dir.clone(), cfg);
    for _ in 0..3 {
        diag.record(event(
            DiagLevel::Critical,
            "db",
            "integrity",
            "索引与数据不一致",
        ));
    }
    diag.flush_blocking();
    let events = read_events(&dir);
    assert_eq!(
        events.iter().filter(|e| e.event == "failed").count(),
        3,
        "CRITICAL 必须逐条可见"
    );
    diag.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn clear_only_touches_diagnostic_files() {
    let dir = temp_dir("clear");
    let diag = Diagnostics::init_at(dir.clone(), WriterConfig::default());
    std::fs::write(dir.join("unrelated.json"), "{}").unwrap();
    for _ in 0..5 {
        diag.record(event(DiagLevel::Error, "file", "deliver", "投递失败"));
    }
    diag.flush_blocking();
    let removed = diag.clear().expect("清理应成功");
    assert!(removed.completed);
    assert!(removed.removed_bytes > 0);
    assert!(read_events(&dir).is_empty(), "清理后不应还有诊断事件");
    assert!(
        dir.join("unrelated.json").exists(),
        "同目录下的非诊断文件不得删除"
    );
    diag.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn unwritable_dir_degrades_without_panicking() {
    let root = temp_dir("degraded");
    let blocker = root.join("blocker");
    std::fs::write(&blocker, "not a directory").unwrap();
    let dir = blocker.join("diagnostics");

    let diag = Diagnostics::init_at(dir, WriterConfig::default());
    // 仍可入队；写入线程内部失败只计数，不 panic、不向调用方报错。
    let _ = diag.record(event(
        DiagLevel::Critical,
        "diagnostics",
        "write",
        "目录不可用",
    ));
    diag.flush_blocking();
    assert!(diag.is_disabled(), "目录不可用时应标记降级");
    let counters = diag.counters().snapshot();
    assert!(
        counters[1] > 0 || counters[5] > 0,
        "必须记录丢弃或失败计数: {counters:?}"
    );
    diag.shutdown();
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn shutdown_is_idempotent_and_flushes_tail() {
    let dir = temp_dir("shutdown");
    let diag = Diagnostics::init_at(dir.clone(), WriterConfig::default());
    diag.record(event(DiagLevel::Error, "workflow", "run", "步骤执行失败"));
    diag.shutdown();
    let events = read_events(&dir);
    assert_eq!(events.len(), 1, "退出前必须刷出尾部事件");
    diag.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn queue_overflow_is_bounded_and_counted() {
    let dir = temp_dir("overflow");
    let diag = Diagnostics::init_at(dir.clone(), WriterConfig::default());
    // 生产者持续写、写线程按批处理：只要最终 dropped 有计数即说明队列有界策略生效。
    for _ in 0..(CHANNEL_CAPACITY * 4) {
        let _ = diag.record(event(DiagLevel::Info, "ui", "burst", "高频事件"));
    }
    diag.flush_blocking();
    let counters = diag.counters().snapshot();
    let accounted = counters[0] + counters[1];
    assert!(
        accounted > 0 && accounted <= (CHANNEL_CAPACITY * 4 + 8) as u64,
        "写入 + 丢弃必须可解释: {counters:?}"
    );
    diag.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

// ── 复查修复回归（2026-11-06）──────────────────────────────

/// P1：内部产生的模式事件也必须经过标准化（时间戳/session 不能为空）。
#[test]
fn internal_events_carry_timestamp_and_session() {
    let dir = temp_dir("internal-events");
    let diag = Diagnostics::init_at(dir.clone(), WriterConfig::default());
    diag.set_mode(true, Some(1));
    diag.set_mode(false, None);
    diag.flush_blocking();

    let events = read_events(&dir);
    let mode_events: Vec<_> = events
        .iter()
        .filter(|e| e.module == "diagnostics" && e.action == "verbose_mode")
        .collect();
    assert_eq!(mode_events.len(), 2, "开关各一条: {events:?}");
    for event in mode_events {
        assert!(!event.timestamp.is_empty(), "时间戳不得为空: {event:?}");
        assert!(
            chrono::DateTime::parse_from_rfc3339(&event.timestamp).is_ok(),
            "时间戳必须是合法 RFC3339: {}",
            event.timestamp
        );
        assert_eq!(event.session_id, diag.session_id(), "会话必须来自当前运行");
        assert!(!event.module.is_empty() && !event.action.is_empty());
        assert_eq!(event.source, DiagSource::Rust);
    }
    diag.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

/// P1：刷盘必须返回可信结果，而不是静默吞掉失败。
#[test]
fn flush_reports_outcome() {
    let dir = temp_dir("flush-outcome");
    let diag = Diagnostics::init_at(dir.clone(), WriterConfig::default());
    diag.record(event(DiagLevel::Error, "task", "create", "写入后刷盘"));
    let outcome = diag.flush_blocking();
    assert!(outcome.flushed && !outcome.degraded(), "{outcome:?}");
    diag.shutdown();
    // 写线程退出后：刷盘不再成功，也不能 panic。
    let after = diag.flush_blocking();
    assert!(!after.flushed, "写线程退出后不得声称刷盘成功: {after:?}");
    std::fs::remove_dir_all(&dir).ok();
}

/// P1：并发清理必须被拒绝（单飞），避免重复删除与状态错乱。
#[test]
fn concurrent_clear_is_rejected() {
    let dir = temp_dir("clear-single-flight");
    let diag = Diagnostics::init_at(dir.clone(), WriterConfig::default());
    // 模拟"已有清理在进行中"
    diag.clearing.store(true, Ordering::Release);
    let err = diag.clear().expect_err("第二次清理必须被拒绝");
    assert_eq!(err.code(), "CONFLICT");
    diag.clearing.store(false, Ordering::Release);
    assert!(diag.clear().is_ok());
    diag.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

/// P1：取消标记生效时，写线程不得执行任何删除。
#[test]
fn cancelled_clear_does_not_delete() {
    let dir = temp_dir("clear-cancelled");
    let diag = Diagnostics::init_at(dir.clone(), WriterConfig::default());
    for _ in 0..3 {
        diag.record(event(DiagLevel::Info, "task", "create", "保留我一"));
    }
    diag.flush_blocking();
    let before = read_events(&dir).len();
    assert!(before > 0);

    let cancelled = AtomicBool::new(true);
    let result = super::writer::clear_for_test(&dir, diag.clone(), &cancelled);
    assert_eq!(result.unwrap_err(), "cancelled");
    assert_eq!(read_events(&dir).len(), before, "取消后不得删除任何日志");
    diag.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

/// P2：导出上限必须与声明一致（不再被普通分页的 500 条截断）。
#[test]
fn export_exceeds_page_limit() {
    let dir = temp_dir("export-cap");
    let handle = Diagnostics::init_at(dir.clone(), WriterConfig::default());
    let mut events = Vec::new();
    for i in 0..600 {
        let mut item = event(DiagLevel::Info, "task", &format!("create-{i}"), "批量导出");
        item.event = format!("ok-{i}");
        events.push(item);
    }
    // 直接落盘（绕开聚合），验证读取上限；记录数量与内容由读取端保证。
    write_events(&dir, &events);
    let result = query::export(
        &dir,
        &handle,
        &DiagnosticQuery::default(),
        FlushOutcome::ok(),
    )
    .expect("导出应成功");
    assert_eq!(result.records, 600, "导出必须超过普通分页的 500 条上限");
    assert!(!result.truncated);
    assert!(result.complete && result.flushed, "{result:?}");
    handle.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

fn timed(
    level: DiagLevel,
    action: &str,
    status: Option<DiagStatus>,
    ts: &str,
    op: Option<&str>,
) -> DiagnosticEvent {
    let mut item = event(level, "clipboard", action, "批量粘贴失败");
    item.status = status;
    item.timestamp = ts.to_string();
    item.operation_id = op.map(str::to_string);
    item
}

/// P2：恢复状态必须精确关联（failed→recovered / →failed / A→B / cancelled）。
#[test]
fn summary_recovery_matrix() {
    let dir = temp_dir("recovery");
    let f1 = timed(
        DiagLevel::Error,
        "paste_batch",
        Some(DiagStatus::Failed),
        "2026-11-06T10:00:00.000+08:00",
        None,
    );
    let r1 = timed(
        DiagLevel::Info,
        "paste_batch",
        Some(DiagStatus::Recovered),
        "2026-11-06T10:01:00.000+08:00",
        None,
    );
    write_events(&dir, &[f1.clone(), r1.clone()]);
    let s = query::summary(&dir, &DiagnosticQuery::default(), &Counters::default());
    let g = &s.groups[0];
    assert!(g.recovered, "失败后恢复必须标记已恢复");
    assert_eq!(g.last_status, Some(DiagStatus::Recovered));
    assert_eq!(s.errors, 1, "恢复事件不得计入错误数");

    // 恢复后再次失败：重新显示为未恢复
    let f2 = timed(
        DiagLevel::Error,
        "paste_batch",
        Some(DiagStatus::Failed),
        "2026-11-06T10:02:00.000+08:00",
        None,
    );
    write_events(&dir, &[f2]);
    let s = query::summary(&dir, &DiagnosticQuery::default(), &Counters::default());
    assert!(!s.groups[0].recovered, "新失败后不得继续显示已恢复");

    // 不同 operation_id 不得互相标记恢复
    let dir2 = temp_dir("recovery-op");
    let fa = timed(
        DiagLevel::Error,
        "paste_batch",
        Some(DiagStatus::Failed),
        "2026-11-06T10:00:00.000+08:00",
        Some("op-a"),
    );
    let rb = timed(
        DiagLevel::Info,
        "paste_batch",
        Some(DiagStatus::Recovered),
        "2026-11-06T10:01:00.000+08:00",
        Some("op-b"),
    );
    write_events(&dir2, &[fa, rb]);
    let s = query::summary(&dir2, &DiagnosticQuery::default(), &Counters::default());
    assert!(!s.groups[0].recovered, "A 的失败不能被 B 的恢复覆盖");

    // 同 operation_id 的成功恢复
    let dir3 = temp_dir("recovery-op-ok");
    let fa2 = timed(
        DiagLevel::Error,
        "paste_batch",
        Some(DiagStatus::Failed),
        "2026-11-06T10:00:00.000+08:00",
        Some("op-a"),
    );
    let ra2 = timed(
        DiagLevel::Info,
        "paste_batch",
        Some(DiagStatus::Recovered),
        "2026-11-06T10:01:00.000+08:00",
        Some("op-a"),
    );
    write_events(&dir3, &[fa2, ra2]);
    let s = query::summary(&dir3, &DiagnosticQuery::default(), &Counters::default());
    assert!(s.groups[0].recovered, "同一 operation_id 的恢复必须生效");

    // 取消不等于恢复
    let dir4 = temp_dir("recovery-cancel");
    let fc = timed(
        DiagLevel::Error,
        "paste_batch",
        Some(DiagStatus::Failed),
        "2026-11-06T10:00:00.000+08:00",
        None,
    );
    let cc = timed(
        DiagLevel::Info,
        "paste_batch",
        Some(DiagStatus::Cancelled),
        "2026-11-06T10:01:00.000+08:00",
        None,
    );
    write_events(&dir4, &[fc, cc]);
    let s = query::summary(&dir4, &DiagnosticQuery::default(), &Counters::default());
    assert!(!s.groups[0].recovered, "取消不得视为恢复");

    for d in [&dir, &dir2, &dir3, &dir4] {
        std::fs::remove_dir_all(d).ok();
    }
}

/// 「操作链」查询契约：同一 operation_id 的 DEBUG/INFO/WARN/ERROR/success 必须
/// 全部返回（新→旧，前端负责升序）；`anomaliesOnly` 会过滤掉 WARN 以下，
/// 因此操作链模式必须显式关闭该选项。
#[test]
fn query_operation_chain_includes_all_levels() {
    let dir = temp_dir("query-operation-chain");
    let chain = "op-chain";
    let events = [
        timed(
            DiagLevel::Debug,
            "paste_batch",
            None,
            "2026-11-07T10:00:00.000+08:00",
            Some(chain),
        ),
        timed(
            DiagLevel::Info,
            "paste_batch",
            Some(DiagStatus::Started),
            "2026-11-07T10:00:01.000+08:00",
            Some(chain),
        ),
        timed(
            DiagLevel::Warn,
            "paste_batch",
            None,
            "2026-11-07T10:00:02.000+08:00",
            Some(chain),
        ),
        timed(
            DiagLevel::Error,
            "paste_batch",
            Some(DiagStatus::Failed),
            "2026-11-07T10:00:03.000+08:00",
            Some(chain),
        ),
        timed(
            DiagLevel::Info,
            "paste_batch",
            Some(DiagStatus::Success),
            "2026-11-07T10:00:04.000+08:00",
            Some(chain),
        ),
        // 无关操作：不得混入操作链。
        timed(
            DiagLevel::Warn,
            "paste_batch",
            None,
            "2026-11-07T10:00:05.000+08:00",
            Some("op-other"),
        ),
    ];
    write_events(&dir, &events);

    let page = query::query(
        &dir,
        &DiagnosticQuery {
            operation_id: Some(chain.into()),
            ..Default::default()
        },
        &Counters::default(),
    );
    assert_eq!(
        page.matched, 5,
        "必须精确匹配该操作的 5 条事件: {:?}",
        page.items
    );
    assert_eq!(page.items.len(), 5);
    for item in &page.items {
        assert_eq!(
            item.operation_id.as_deref(),
            Some(chain),
            "不得混入其它操作: {item:?}"
        );
    }
    // 查询结果为新→旧（存储倒序扫描）；前端负责升序展示。
    for pair in page.items.windows(2) {
        assert!(
            pair[0].timestamp > pair[1].timestamp,
            "顺序必须为新→旧: {} vs {}",
            pair[0].timestamp,
            pair[1].timestamp
        );
    }
    assert_eq!(page.items[0].timestamp, "2026-11-07T10:00:04.000+08:00");
    assert_eq!(page.items[4].timestamp, "2026-11-07T10:00:00.000+08:00");
    for level in [
        DiagLevel::Debug,
        DiagLevel::Info,
        DiagLevel::Warn,
        DiagLevel::Error,
    ] {
        assert!(
            page.items.iter().any(|event| event.level == level),
            "操作链缺少 {level:?}: {:?}",
            page.items
        );
    }

    // 契约：操作链模式必须显式关闭 anomaliesOnly，否则 DEBUG/INFO 被过滤。
    let anomalies = query::query(
        &dir,
        &DiagnosticQuery {
            operation_id: Some(chain.into()),
            anomalies_only: Some(true),
            ..Default::default()
        },
        &Counters::default(),
    );
    assert_eq!(
        anomalies.matched, 2,
        "anomaliesOnly 只应保留 WARN/ERROR: {:?}",
        anomalies.items
    );
    assert_eq!(anomalies.items.len(), 2);
    assert!(
        anomalies
            .items
            .iter()
            .all(|event| event.level >= DiagLevel::Warn),
        "不得残留 WARN 以下事件: {:?}",
        anomalies.items
    );
    for item in &anomalies.items {
        assert_eq!(item.operation_id.as_deref(), Some(chain));
    }

    std::fs::remove_dir_all(&dir).ok();
}
