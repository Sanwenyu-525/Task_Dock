//! 诊断日志核心单元测试：写入、UTF-8、轮转、保留、聚合、清理、降级、退出。

use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, SystemTime};

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
        max_age_days: MAX_AGE_DAYS,
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

/// 业务失败（IPC 已成功返回）必须在默认异常列表与操作链中可见：
/// 用户复现的「数据库 CHECK 失败导致复制未执行」不允许只留在界面内联结果里。
#[test]
fn shelf_drop_business_failure_reaches_anomaly_list_and_operation_chain() {
    use crate::shelf::fsops::{self, DropEntry, DropReport};

    let dir = temp_dir("drop-business");
    let diag = Diagnostics::init_at(dir.clone(), WriterConfig::default());
    let entry = |status: &str, code: &str, stage: &str| DropEntry {
        source: "C:\\Users\\me\\Desktop\\截图.png".into(),
        display_name: "截图.png".into(),
        target: None,
        status: status.into(),
        reason: Some("写入复制日志失败".into()),
        recovery: None,
        residual_source: None,
        code: Some(code.into()),
        stage: Some(stage.into()),
    };
    let report = DropReport {
        batch_id: "batch-visible-1".into(),
        target_id: "target-1".into(),
        target_path: "C:\\Users\\me\\Pictures".into(),
        op: "copy".into(),
        total: 1,
        success: 0,
        skipped: 0,
        failed: 1,
        partial: 0,
        entries: vec![entry(
            "failed",
            fsops::DROP_CODE_DB_SCHEMA,
            "journal",
        )],
    };
    for event in fsops::drop_diagnostic_events(&report, 12) {
        assert!(diag.record(event), "业务诊断事件必须被接收");
    }
    assert!(diag.flush_blocking().flushed);

    // 默认异常列表（WARN+，最近 24h）必须命中，且错误码可直接筛选。
    let since = (chrono::Utc::now() - chrono::Duration::hours(24)).to_rfc3339();
    let anomalies = query::query(
        &dir,
        &DiagnosticQuery {
            anomalies_only: Some(true),
            since: Some(since),
            ..Default::default()
        },
        &Counters::default(),
    );
    assert_eq!(anomalies.matched, 2, "汇总 + 明细两条都要可见: {:?}", anomalies.items);
    assert!(anomalies.items.iter().all(|e| e.module == "file"));
    assert!(anomalies.items.iter().all(|e| {
        e.operation_id.as_deref() == Some("batch-visible-1")
            && e.error_code.as_deref() == Some(fsops::DROP_CODE_DB_SCHEMA)
    }));

    // 操作链：只按 operation_id 查询，拿到完整链路。
    let chain = query::query(
        &dir,
        &DiagnosticQuery {
            operation_id: Some("batch-visible-1".into()),
            ..Default::default()
        },
        &Counters::default(),
    );
    assert_eq!(chain.matched, 2);
    // 隐私：落盘内容不得包含路径或文件名。
    let raw = std::fs::read_to_string(dir.join(ACTIVE_FILE)).unwrap_or_default();
    assert!(!raw.contains("Desktop"), "诊断日志不得包含完整路径: {raw}");
    assert!(!raw.contains("截图.png"), "诊断日志不得包含文件名: {raw}");
    // 错误码筛选（诊断中心按错误码过滤）。
    let by_code = query::query(
        &dir,
        &DiagnosticQuery {
            error_codes: vec![fsops::DROP_CODE_DB_SCHEMA.into()],
            anomalies_only: Some(true),
            ..Default::default()
        },
        &Counters::default(),
    );
    assert_eq!(by_code.matched, 2);

    std::fs::remove_dir_all(&dir).ok();
}

/// 暂存添加的**业务结果分级**事件必须可在默认异常列表、操作链与错误码筛选中命中；
/// metadata 的 `added` / `failure_codes` 必须通过隐私白名单落盘。
#[test]
fn shelf_add_business_result_is_visible_and_privacy_safe() {
    use serde_json::json;

    let dir = temp_dir("shelf-add-business");
    let diag = Diagnostics::init_at(dir.clone(), WriterConfig::default());
    let operation = "shelf-add-visible-1";
    let failed_event = super::event(
        DiagLevel::Warn,
        "file",
        "shelf_add_paths",
        "暂存添加部分失败：共 2 项，成功 1、失败 1",
    )
    .status(DiagStatus::Failed)
    .stage("persist")
    .operation(operation)
    .error_code("SHELF_ADD_PARTIAL_FAILED")
    .error_category("validation")
    .metadata("count", json!(2))
    .metadata("total", json!(2))
    .metadata("added", json!(1))
    .metadata("failed", json!(1))
    .metadata("mode", json!("reference"))
    .metadata("source", json!("drag"))
    .metadata("failure_codes", json!("VALIDATION_ERROR"))
    .build();
    assert!(diag.record(failed_event), "业务失败事件必须被接收");
    // 同一 operation 的成功终态：用于验证操作链仍能聚合。
    assert!(diag.record(
        super::event(DiagLevel::Info, "file", "shelf_add_paths", "暂存添加完成")
            .status(DiagStatus::Success)
            .operation(operation)
            .metadata("added", json!(1))
            .build()
    ));
    assert!(diag.flush_blocking().flushed);

    // 默认异常列表（WARN+、最近 24h、module=file）。
    let since = (chrono::Utc::now() - chrono::Duration::hours(24)).to_rfc3339();
    let anomalies = query::query(
        &dir,
        &DiagnosticQuery {
            anomalies_only: Some(true),
            since: Some(since),
            modules: vec!["file".into()],
            ..Default::default()
        },
        &Counters::default(),
    );
    assert_eq!(
        anomalies.matched, 1,
        "只应命中 WARN 汇总: {:?}",
        anomalies.items
    );
    let item = &anomalies.items[0];
    assert_eq!(item.operation_id.as_deref(), Some(operation));
    assert_eq!(item.error_code.as_deref(), Some("SHELF_ADD_PARTIAL_FAILED"));
    assert_eq!(item.stage.as_deref(), Some("persist"));
    let meta = item.metadata.as_ref().expect("metadata 必须落盘");
    assert_eq!(meta.get("added").and_then(|v| v.as_i64()), Some(1));
    assert_eq!(
        meta.get("failure_codes").and_then(|v| v.as_str()),
        Some("VALIDATION_ERROR")
    );

    // 操作链：按 operation_id 拿到 started/success/failed 全链路。
    let chain = query::query(
        &dir,
        &DiagnosticQuery {
            operation_id: Some(operation.into()),
            ..Default::default()
        },
        &Counters::default(),
    );
    assert_eq!(chain.matched, 2);

    // 错误码筛选（诊断中心「查看诊断」深链与手动筛选共用同一查询）。
    let by_code = query::query(
        &dir,
        &DiagnosticQuery {
            error_codes: vec!["SHELF_ADD_PARTIAL_FAILED".into()],
            anomalies_only: Some(true),
            ..Default::default()
        },
        &Counters::default(),
    );
    assert_eq!(by_code.matched, 1);

    // 隐私：metadata 只放计数与稳定码，不写路径/文件名。
    let raw = std::fs::read_to_string(dir.join(ACTIVE_FILE)).unwrap_or_default();
    assert!(!raw.contains("Desktop"), "诊断日志不得包含路径: {raw}");
    assert!(!raw.contains("secret.txt"), "诊断日志不得包含文件名: {raw}");

    std::fs::remove_dir_all(&dir).ok();
}

/// 诊断等级不能只按「有失败就 WARN」一刀切：真实 IO 与未知内部错误必须是 ERROR，
/// 权限/校验/格式不支持/过期这类可预期拒绝保持 WARN。
#[test]
fn level_from_category_separates_real_failures_from_expected_rejections() {
    assert_eq!(DiagLevel::from_category("io").as_str(), "ERROR");
    assert_eq!(DiagLevel::from_category("integrity").as_str(), "ERROR");
    assert_eq!(DiagLevel::from_category("unknown").as_str(), "ERROR");
    for category in ["permission", "validation", "conflict", "not_found", "unsupported", "expired"] {
        assert_eq!(
            DiagLevel::from_category(category).as_str(),
            "WARN",
            "可预期拒绝 {category} 不应升级为 ERROR"
        );
    }
}

// ── 时间维度保留（M2）───────────────────────────────────────

/// 造一个「N 天前修改」的归档文件。
fn write_stale_archive(dir: &Path, name: &str, age_days: u64) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, "{}\n").unwrap();
    let file = std::fs::File::options().write(true).open(&path).unwrap();
    file.set_modified(SystemTime::now() - Duration::from_secs(age_days * 86_400))
        .unwrap();
    drop(file);
    path
}

#[test]
fn startup_prunes_archives_older_than_max_age() {
    let dir = temp_dir("age-expired");
    let stale = write_stale_archive(&dir, "diagnostics-20200101-000000-000.jsonl", 30);

    let diag = Diagnostics::init_at(
        dir.clone(),
        WriterConfig {
            max_age_days: 14,
            ..WriterConfig::default()
        },
    );
    // 写线程先跑 startup（内含 prune）再处理消息：flush 返回即代表 prune 已执行完。
    diag.flush_blocking();
    assert!(
        !stale.exists(),
        "超过保留期（14 天）的归档必须在启动时被删除"
    );
    diag.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn startup_keeps_archives_within_max_age() {
    let dir = temp_dir("age-keep");
    let recent = write_stale_archive(&dir, "diagnostics-20260101-000000-000.jsonl", 3);

    let diag = Diagnostics::init_at(
        dir.clone(),
        WriterConfig {
            max_age_days: 14,
            ..WriterConfig::default()
        },
    );
    diag.flush_blocking();
    assert!(recent.exists(), "保留期内的归档不得被删除");
    diag.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn age_retention_can_be_disabled() {
    let dir = temp_dir("age-off");
    let stale = write_stale_archive(&dir, "diagnostics-20200101-000000-000.jsonl", 365);

    let diag = Diagnostics::init_at(
        dir.clone(),
        WriterConfig {
            max_age_days: 0,
            ..WriterConfig::default()
        },
    );
    diag.flush_blocking();
    assert!(
        stale.exists(),
        "max_age_days = 0 表示关闭时间淘汰，不应删除任何归档"
    );
    diag.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

// ── 写失败分类（M3）──────────────────────────────────────────

#[test]
fn write_failure_kind_classifies_io_errors() {
    let permission = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
    assert_eq!(
        WriteFailureKind::from_io(&permission),
        WriteFailureKind::PermissionDenied
    );

    // Windows ERROR_DISK_FULL(112) / ERROR_HANDLE_DISK_FULL(39) / POSIX ENOSPC(28)
    for code in [112, 39, 28] {
        let err = std::io::Error::from_raw_os_error(code);
        assert_eq!(
            WriteFailureKind::from_io(&err),
            WriteFailureKind::DiskFull,
            "错误码 {code} 应判定为磁盘满"
        );
    }

    // Windows ERROR_SHARING_VIOLATION(32) / ERROR_LOCK_VIOLATION(33)
    for code in [32, 33] {
        let err = std::io::Error::from_raw_os_error(code);
        assert_eq!(
            WriteFailureKind::from_io(&err),
            WriteFailureKind::FileLocked,
            "错误码 {code} 应判定为文件被占用"
        );
    }

    // ERROR_FILE_NOT_FOUND(2) → 未命中任何特例 → unknown
    let other = std::io::Error::from_raw_os_error(2);
    assert_eq!(WriteFailureKind::from_io(&other), WriteFailureKind::Unknown);
}

#[test]
fn write_failure_kind_has_stable_strings() {
    assert_eq!(WriteFailureKind::DiskFull.as_str(), "disk_full");
    assert_eq!(
        WriteFailureKind::PermissionDenied.as_str(),
        "permission_denied"
    );
    assert_eq!(WriteFailureKind::FileLocked.as_str(), "file_locked");
    assert_eq!(WriteFailureKind::Unknown.as_str(), "unknown");
}

// ── 故障注入：轮转降级、队列过载（批次 2 / M13）──────────────
//
// 计数快照下标（与 Counters::snapshot 顺序一致）：
// 0=written 1=dropped 2=queue_full 3=aggregated 4=rotations 5=failures
// 6=skipped_lines 7=rotate_failures。

/// 以「允许读/写共享、不给删除共享」的方式占用活动日志文件：
/// 写线程的 rename（需要 DELETE 访问）因此失败（Windows ERROR_SHARING_VIOLATION(32)，
/// 分类为 file_locked），但重新打开追加（写共享放行）仍然成功——
/// 复现杀毒软件 / 索引器锁定日志文件的典型场景。
#[cfg(windows)]
fn hold_active_file_no_delete_share(dir: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x1;
    const FILE_SHARE_WRITE: u32 = 0x2;
    std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(dir.join(ACTIVE_FILE))
}

/// 降级写入决策的边界（纯函数，不构造 64 MB 真实文件）。
#[test]
fn degraded_should_drop_enforces_hard_cap_and_level_policy() {
    use super::writer::{degraded_should_drop, ACTIVE_HARD_CAP_BYTES};
    // 低等级在降级期一律计数丢弃。
    for level in [DiagLevel::Trace, DiagLevel::Debug, DiagLevel::Info] {
        assert!(degraded_should_drop(level, 0, 10), "{level:?} 在降级期必须丢弃");
    }
    // 高等级在硬上限之内保留（故障现场不能丢）。
    for level in [DiagLevel::Warn, DiagLevel::Error, DiagLevel::Critical] {
        assert!(
            !degraded_should_drop(level, ACTIVE_HARD_CAP_BYTES - 100, 10),
            "{level:?} 在硬上限内必须保留"
        );
    }
    // 触到硬上限：任何级别都整体停止写入（只计数）。
    for level in [
        DiagLevel::Trace,
        DiagLevel::Info,
        DiagLevel::Warn,
        DiagLevel::Error,
        DiagLevel::Critical,
    ] {
        assert!(
            degraded_should_drop(level, ACTIVE_HARD_CAP_BYTES, 1),
            "达到硬上限后 {level:?} 必须整体停止写入"
        );
    }
}

/// 真实文件占用（Windows 独占共享模式）触发轮转失败：
/// 必须进入降级、退避窗口内**不再每次写入重试 rename**（消除失败风暴）、
/// 高等级事件继续写入且活动文件不超过硬上限。
#[cfg(windows)]
#[test]
fn rotation_lock_enters_degradation_without_rename_storm() {
    let dir = temp_dir("rotate-lock");
    let diag = Diagnostics::init_at(dir.clone(), small_config());

    // 1) 先把活动文件推过 1024 字节阈值（首条写入时 bytes=0，不触发轮转判断）。
    diag.record(event(
        DiagLevel::Info,
        "probe",
        "fill",
        &"x".repeat(1100),
    ));
    diag.flush_blocking();

    // 2) 真实占用活动日志（写共享放行、删除共享不放行）。
    let holder = hold_active_file_no_delete_share(&dir).expect("必须能以读共享方式占用活动日志");
    diag.record(event(
        DiagLevel::Warn,
        "probe",
        "trigger",
        "占用下触发轮转",
    ));
    diag.flush_blocking();
    let after_first = diag.counters().snapshot();
    assert_eq!(
        after_first[7], 1,
        "首次 rename 失败必须记 rotate_failures=1: {after_first:?}"
    );
    assert_eq!(after_first[4], 0, "占用期间不得成功轮转: {after_first:?}");
    assert_eq!(
        diag.last_failure_kind(),
        Some(WriteFailureKind::FileLocked),
        "共享冲突必须归类为 file_locked"
    );

    // 3) 失败风暴消除：退避窗口（测试构建 1s）内继续写入，不得重复尝试 rename。
    for i in 0..20 {
        // 带 operation_id：绕开聚合器，保证「纯写入/丢弃策略」可精确断言。
        let mut warn = event(DiagLevel::Warn, "probe", "noise", "占用期间告警");
        warn.operation_id = Some(format!("noise-warn-{i}"));
        assert!(diag.record(warn), "高等级事件必须继续接收");
        let info = event(DiagLevel::Info, "probe", "noise", "占用期间低等级");
        assert!(diag.record(info), "入队仍成功（丢弃发生在写入线程内）");
    }
    diag.flush_blocking();
    let during = diag.counters().snapshot();
    assert_eq!(
        during[7], 1,
        "退避窗口内不得重复尝试 rename（失败风暴必须被消除）: {during:?}"
    );
    assert_eq!(
        during[5], 1,
        "failures 计数不得随写入次数膨胀: {during:?}"
    );
    // 降级策略：低等级计数丢弃、高等级逐条写入（fill + trigger + 20 条 Warn）。
    assert_eq!(during[1], 20, "20 条低等级事件必须全部计数丢弃: {during:?}");
    assert_eq!(during[0], 22, "Warn 必须继续写入: {during:?}");
    // 活动文件继续追加但远未触及硬上限。
    let active_bytes = std::fs::metadata(dir.join(ACTIVE_FILE))
        .map(|m| m.len())
        .unwrap_or(0);
    assert!(
        active_bytes < super::writer::ACTIVE_HARD_CAP_BYTES,
        "活动文件不得超过硬上限: {active_bytes}"
    );

    // 4) 释放占用 → 退避窗口过后重试 → 轮转恢复并退出降级。
    drop(holder);
    std::thread::sleep(Duration::from_millis(1200));
    diag.record(event(
        DiagLevel::Warn,
        "probe",
        "recover",
        "占用释放后重试",
    ));
    diag.flush_blocking();
    let recovered = diag.counters().snapshot();
    assert!(
        recovered[4] >= 1,
        "释放占用后必须成功轮转: {recovered:?}"
    );
    assert_eq!(
        recovered[7], 1,
        "恢复不得引入新的失败计数: {recovered:?}"
    );

    // 5) 降级退出后低等级事件恢复写入（恢复正常轮转的直接证据）。
    diag.record(event(
        DiagLevel::Info,
        "probe",
        "post",
        "恢复后的低等级事件",
    ));
    diag.flush_blocking();
    let events = read_events(&dir);
    assert!(
        events
            .iter()
            .any(|e| e.module == "probe" && e.action == "post"),
        "降级退出后低等级事件必须恢复写入: {:?}",
        events.iter().map(|e| (&e.module, &e.action)).collect::<Vec<_>>()
    );
    assert!(
        events
            .iter()
            .any(|e| e.module == "diagnostics" && e.action == "rotate" && e.event == "recovered"),
        "轮转恢复必须留下 recovered 里程碑事件"
    );
    diag.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

/// 轮转恢复（独立场景）：占用释放后再写入，rotations 计数增长、降级退出。
#[cfg(windows)]
#[test]
fn rotation_recovers_after_lock_released() {
    let dir = temp_dir("rotate-recover");
    let diag = Diagnostics::init_at(dir.clone(), small_config());
    diag.flush_blocking();

    diag.record(event(DiagLevel::Info, "probe", "fill", &"x".repeat(1100)));
    diag.flush_blocking();
    let holder = hold_active_file_no_delete_share(&dir).expect("占用活动日志");
    diag.record(event(DiagLevel::Warn, "probe", "trigger", "占用触发轮转"));
    diag.flush_blocking();
    assert_eq!(diag.counters().snapshot()[7], 1, "必须先进入降级");

    drop(holder);
    std::thread::sleep(Duration::from_millis(1200));
    diag.record(event(DiagLevel::Warn, "probe", "after", "占用释放后写入"));
    diag.flush_blocking();

    let snapshot = diag.counters().snapshot();
    assert!(snapshot[4] >= 1, "rotations 必须增长: {snapshot:?}");
    assert_eq!(snapshot[7], 1, "不得有额外轮转失败: {snapshot:?}");
    // 恢复事件落盘（降级退出的可观测里程碑）。
    let events = read_events(&dir);
    assert!(
        events
            .iter()
            .any(|e| e.module == "diagnostics" && e.action == "rotate" && e.event == "recovered"),
        "恢复必须写 recovered 事件: {:?}",
        events.iter().map(|e| (&e.module, &e.action, &e.event)).collect::<Vec<_>>()
    );
    diag.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

/// 队列过载：8 线程高并发写入（Info + Critical 混合）。
/// 断言「尝试总数 = 写入 + 丢弃」的账目一致、Critical 全部可解释且尽量保留、
/// 测试本身完成（无死循环/死锁）。
///
/// 注：队列容量是进程级常量 `CHANNEL_CAPACITY`（1024，见 mod.rs），
/// 测试无法按 WriterConfig 调小；此处以高并发灌满的方式逼近过载场景。
#[test]
fn queue_overload_under_concurrency_keeps_accounting() {
    let dir = temp_dir("overload-concurrent");
    let diag = Diagnostics::init_at(dir.clone(), WriterConfig::default());
    const THREADS: usize = 8;
    const PER_THREAD: usize = 2000;

    let mut attempted_total: u64 = 0;
    let mut attempted_critical: u64 = 0;
    let handles: Vec<_> = (0..THREADS)
        .map(|thread| {
            let diag = diag.clone();
            std::thread::spawn(move || {
                let mut attempted = 0u64;
                let mut critical = 0u64;
                for i in 0..PER_THREAD {
                    let level = if i % 100 == 0 {
                        DiagLevel::Critical
                    } else {
                        DiagLevel::Info
                    };
                    if diag.record(event(
                        level,
                        "flood",
                        &format!("worker-{thread}"),
                        "高并发压测事件",
                    )) {
                        attempted += 1;
                        if level == DiagLevel::Critical {
                            critical += 1;
                        }
                    }
                }
                (attempted, critical)
            })
        })
        .collect();
    for handle in handles {
        let (attempted, critical) = handle.join().expect("写入线程不得 panic（无死循环）");
        attempted_total += attempted;
        attempted_critical += critical;
    }

    // 刷盘（必要时重试，保证队列清空后再核对账目）。
    for _ in 0..10 {
        if diag.flush_blocking().flushed {
            break;
        }
    }
    let snapshot = diag.counters().snapshot();
    let written = snapshot[0];
    let dropped = snapshot[1];
    // 账目一致：接收（written）+ 拒收与写入期丢弃（dropped）= 尝试总数。
    assert_eq!(
        attempted_total,
        written,
        "队列接收数必须等于写入数（本场景无写线程侧丢弃）: {snapshot:?}"
    );
    assert_eq!(
        THREADS as u64 * PER_THREAD as u64,
        attempted_total + dropped,
        "尝试总数 = 写入 + 丢弃（计数必须可解释）: {snapshot:?}"
    );
    // Critical 尽量保留：全部可解释且大多真正落盘。
    let critical_written = read_events(&dir)
        .iter()
        .filter(|e| e.module == "flood" && e.level == DiagLevel::Critical)
        .count() as u64;
    assert!(
        critical_written >= attempted_critical / 2,
        "Critical 必须尽量保留（尝试 {attempted_critical}，落盘 {critical_written}）: {snapshot:?}"
    );
    diag.shutdown();
    std::fs::remove_dir_all(&dir).ok();
}

/// 微基准（#[ignore]：由 scripts/logging-benchmark.mjs 以 --ignored --nocapture 调起）。
/// Debug 构建数字仅用于回归观察，**不得作为正式性能结论**（AGENTS §5.3：
/// 正式基线必须走 Release 集成构建 + 固定采样条件）。
/// 输出 `MICRO_RESULT {…}` JSON 行供脚本解析：record 延迟分位数、吞吐、刷盘与退出耗时。
#[test]
#[ignore]
fn bench_writer_pipeline_micro() {
    use std::time::Instant;

    let dir = temp_dir("bench-micro");
    let diag = Diagnostics::init_at(dir.clone(), WriterConfig::default());
    const N: usize = 20_000;

    // 预热：让写线程与文件句柄进入稳定状态。
    for _ in 0..1000 {
        let _ = diag.record(event(DiagLevel::Info, "bench", "warmup", "预热事件"));
    }
    diag.flush_blocking();

    let mut latencies_ns: Vec<u128> = Vec::with_capacity(N);
    let enqueue_started = Instant::now();
    for _ in 0..N {
        let t0 = Instant::now();
        let _ = diag.record(event(DiagLevel::Info, "bench", "record", "微基准事件"));
        latencies_ns.push(t0.elapsed().as_nanos());
    }
    let enqueue_elapsed = enqueue_started.elapsed();
    let flush_started = Instant::now();
    let _ = diag.flush_blocking();
    let flush_elapsed = flush_started.elapsed();
    let shutdown_started = Instant::now();
    diag.shutdown();
    let shutdown_elapsed = shutdown_started.elapsed();

    latencies_ns.sort_unstable();
    let pct = |q: usize| -> u64 {
        let index = (q * latencies_ns.len() / 100).min(latencies_ns.len() - 1);
        latencies_ns[index] as u64
    };
    let result = serde_json::json!({
        "records": N,
        "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        "enqueue_p50_ns": pct(50),
        "enqueue_p95_ns": pct(95),
        "enqueue_p99_ns": pct(99),
        "enqueue_max_ns": latencies_ns[latencies_ns.len() - 1] as u64,
        "enqueue_throughput_per_sec": (N as f64 / enqueue_elapsed.as_secs_f64()) as u64,
        "flush_ms": flush_elapsed.as_millis() as u64,
        "shutdown_ms": shutdown_elapsed.as_millis() as u64,
    });
    println!("MICRO_RESULT {result}");
    std::fs::remove_dir_all(&dir).ok();
}
