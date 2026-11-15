//! 批量文件操作的诊断事件构造（**单一实现**）。
//!
//! 暂存架投递（`shelf::fsops::drop_diagnostic_events`）与文件工作区
//! （`file_workspace::op_diagnostic_events`）是同一类业务结果：一次批量文件操作
//! 里有成功 / 跳过 / 失败 / 部分完成。它们共用本模块的级别判定、字段集合与
//! 有界明细策略，避免出现「形状几乎相同的第二套日志语义」。
//!
//! 规则（与 `docs/DIAGNOSTICS.md` 一致）：
//! - 汇总事件始终一条；
//! - 明细按（稳定错误码, 阶段）聚合，最多 [`MAX_FAILURE_DETAIL_EVENTS`] 条；
//! - 只写计数、模式、目标 id、阶段与稳定错误码，**绝不写路径、文件名或原始错误文本**；
//! - 正常跳过不算失败，只进入汇总计数；
//! - 明确的预期拒绝（校验/不支持/冲突/目标不可用）全量失败时仍是 WARN，
//!   真实 IO/权限/数据库故障才升级为 ERROR；
//! - 命中 `critical_codes`（如数据库结构不兼容）即使部分成功也升级为 ERROR。

use serde_json::Value as Json;
use std::collections::BTreeMap;

use super::{DiagLevel, DiagStatus, DiagnosticEvent};

/// 单次批量操作最多写几条失败明细（按错误码/阶段聚合）；其余只计入汇总。
pub const MAX_FAILURE_DETAIL_EVENTS: usize = 4;

/// 一次批量操作的计数（字段与业务报告同名，便于直接映射）。
#[derive(Clone, Copy, Debug, Default)]
pub struct BatchCounts {
    pub total: i64,
    pub success: i64,
    pub skipped: i64,
    pub failed: i64,
    pub partial: i64,
}

/// 聚合后的一组失败。
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct BatchFailure {
    pub code: String,
    pub stage: String,
    pub count: i64,
}

/// 批量操作诊断事件的构造参数。
pub struct BatchSpec<'a> {
    /// 诊断模块标识（`file`）。
    pub module: &'a str,
    /// 操作标识（`shelf_drop_to_directory` / `workspace_copy`…）。
    pub action: &'a str,
    /// 与前端 / IPC 共享的操作 ID（同一故障可跨窗口、跨阶段关联）。
    pub operation_id: &'a str,
    pub counts: BatchCounts,
    /// 已按 (错误码, 阶段) 聚合的失败分组。
    pub failures: Vec<BatchFailure>,
    pub duration_ms: u64,
    /// 中文名词，用于 message（「文件投递」「文件操作」）。
    pub noun: &'a str,
    pub success_event: &'a str,
    pub failed_event: &'a str,
    pub partial_event: &'a str,
    pub detail_event: &'a str,
    /// 汇总事件附加 metadata（只允许隐私白名单键）。
    pub extra_metadata: Vec<(&'a str, Json)>,
    /// 命中即整体升级 ERROR 的错误码。
    pub critical_codes: &'a [&'a str],
    /// 「明确的预期拒绝」错误码：全量失败也只是 WARN。
    pub expected_rejection_codes: &'a [&'a str],
    /// 多种错误码并存时汇总使用的合并错误码。
    pub multi_failure_code: &'a str,
    /// 稳定错误码 → 诊断分类（与 `error::ErrorCategory` 字符串取值一致）。
    pub category_of: fn(&str) -> &'static str,
}

/// 把一次批量操作的业务结果映射为**有界**诊断事件。
///
/// 事件级判定放在 Rust 业务边界：即使前端面板已卸载、窗口已关闭，
/// 结果仍可在诊断中心按 `operation_id` 追踪。
pub fn events(spec: &BatchSpec<'_>) -> Vec<DiagnosticEvent> {
    let failure_total = spec.counts.failed + spec.counts.partial;
    let has_failure = failure_total > 0;
    let all_failed = spec.counts.failed > 0
        && spec.counts.success == 0
        && spec.counts.skipped == 0
        && spec.counts.partial == 0;
    let critical = spec
        .failures
        .iter()
        .any(|f| spec.critical_codes.contains(&f.code.as_str()));
    // 明确的预期拒绝（校验/不支持/冲突/目标不可用）全量失败时用 WARN，
    // 真实 IO/权限/数据库故障才升级为 ERROR。
    let only_expected_rejection = !spec.failures.is_empty()
        && spec
            .failures
            .iter()
            .all(|f| spec.expected_rejection_codes.contains(&f.code.as_str()));

    let (level, event, status) = if !has_failure {
        (DiagLevel::Info, spec.success_event, DiagStatus::Success)
    } else if critical || (all_failed && !only_expected_rejection) {
        (DiagLevel::Error, spec.failed_event, DiagStatus::Failed)
    } else {
        (DiagLevel::Warn, spec.partial_event, DiagStatus::Failed)
    };

    let mut summary = super::event(level, spec.module, spec.action, event)
        .status(status)
        .stage("business")
        .operation(spec.operation_id)
        .duration_ms(spec.duration_ms)
        .metadata("total", Json::from(spec.counts.total))
        .metadata("success", Json::from(spec.counts.success))
        .metadata("skipped", Json::from(spec.counts.skipped))
        .metadata("failed", Json::from(spec.counts.failed))
        .metadata("partial", Json::from(spec.counts.partial));
    for (key, value) in &spec.extra_metadata {
        summary = summary.metadata(key, value.clone());
    }
    summary = summary.metadata("failure_groups", Json::from(spec.failures.len() as u64));
    let verdict = if !has_failure {
        "完成"
    } else if all_failed {
        "失败"
    } else {
        "部分失败"
    };
    let mut summary = summary
        .message(format!(
            "{}{}：共 {} 项，成功 {}、跳过 {}、失败 {}、部分完成 {}",
            spec.noun,
            verdict,
            spec.counts.total,
            spec.counts.success,
            spec.counts.skipped,
            spec.counts.failed,
            spec.counts.partial
        ))
        .build();

    if !spec.failures.is_empty() {
        let (code, category) = if spec.failures.len() == 1 {
            let only = &spec.failures[0];
            (only.code.clone(), (spec.category_of)(&only.code))
        } else {
            (
                spec.multi_failure_code.to_string(),
                (spec.category_of)(spec.multi_failure_code),
            )
        };
        summary.error_code = Some(code);
        summary.error_category = Some(category.to_string());
    }

    let mut out = vec![summary];
    // 失败多的分组优先，保证被截断时保留最有信息量的分类。
    let mut grouped: Vec<BatchFailure> = spec.failures.clone();
    grouped.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.cmp(b)));
    for group in grouped.into_iter().take(MAX_FAILURE_DETAIL_EVENTS) {
        let group_level = if spec.critical_codes.contains(&group.code.as_str())
            || (all_failed && !only_expected_rejection)
        {
            DiagLevel::Error
        } else {
            DiagLevel::Warn
        };
        let mut builder = super::event(group_level, spec.module, spec.action, spec.detail_event)
            .status(DiagStatus::Failed)
            .operation(spec.operation_id)
            .stage(&group.stage)
            .error_code(&group.code)
            .error_category((spec.category_of)(&group.code))
            .metadata("count", Json::from(group.count));
        // 模式（copy/move/delete）能定位投递语义，但同样是白名单标量。
        if let Some((_, mode)) = spec.extra_metadata.iter().find(|(key, _)| *key == "mode") {
            builder = builder.metadata("mode", mode.clone());
        }
        let detail = builder
            .message(format!(
                "{}失败 {} 项（{}）",
                spec.noun, group.count, group.code
            ))
            .build();
        out.push(detail);
    }
    out
}

/// 把逐条结果的 (状态, 错误码, 阶段) 聚合为失败分组（只统计 failed/partial）。
pub fn aggregate_failures<'a, I>(entries: I, unknown_code: &str) -> Vec<BatchFailure>
where
    I: IntoIterator<Item = (&'a str, Option<&'a str>, Option<&'a str>)>,
{
    let mut groups: BTreeMap<(String, String), i64> = BTreeMap::new();
    for (status, code, stage) in entries {
        if status != "failed" && status != "partial" {
            continue;
        }
        let code = code.unwrap_or(unknown_code).to_string();
        let stage = stage.unwrap_or("unknown").to_string();
        *groups.entry((code, stage)).or_insert(0) += 1;
    }
    groups
        .into_iter()
        .map(|((code, stage), count)| BatchFailure { code, stage, count })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CRITICAL: &[&str] = &["FS_OP_DB_INCOMPATIBLE"];
    const EXPECTED: &[&str] = &["FS_OP_VALIDATION", "FS_OP_CONFLICT"];
    const MULTI: &str = "FS_OP_MULTI_FAILURE";

    fn cat(code: &str) -> &'static str {
        match code {
            "FS_OP_VALIDATION" | "FS_OP_CONFLICT" => "validation",
            "FS_OP_IO" => "io",
            "FS_OP_DB_INCOMPATIBLE" => "database",
            _ => "unknown",
        }
    }

    fn counts(total: i64, success: i64, skipped: i64, failed: i64, partial: i64) -> BatchCounts {
        BatchCounts {
            total,
            success,
            skipped,
            failed,
            partial,
        }
    }

    fn group(code: &str, stage: &str, count: i64) -> BatchFailure {
        BatchFailure {
            code: code.into(),
            stage: stage.into(),
            count,
        }
    }

    /// 汇总/明细都必带 metadata；测试里统一解包，避免每处 `as_ref().unwrap()`。
    fn meta(event: &DiagnosticEvent) -> &serde_json::Map<String, Json> {
        event.metadata.as_ref().expect("事件必须带 metadata")
    }

    /// 用与 `file_workspace::op_diagnostic_events` 相同的参数形状跑一遍。
    fn run(
        counts: BatchCounts,
        failures: Vec<BatchFailure>,
        critical: &[&str],
        expected: &[&str],
    ) -> Vec<DiagnosticEvent> {
        let mode = Json::from("copy");
        events(&BatchSpec {
            module: "file",
            action: "workspace_copy",
            operation_id: "op-test-1",
            counts,
            failures,
            duration_ms: 42,
            noun: "文件操作",
            success_event: "op_completed",
            failed_event: "op_failed",
            partial_event: "op_partial",
            detail_event: "op_item_failed",
            extra_metadata: vec![("mode", mode.clone())],
            critical_codes: critical,
            expected_rejection_codes: expected,
            multi_failure_code: MULTI,
            category_of: cat,
        })
    }

    #[test]
    fn success_batch_is_info_without_failure_details() {
        let out = run(counts(3, 3, 0, 0, 0), vec![], CRITICAL, EXPECTED);
        assert_eq!(out.len(), 1, "全成功只允许一条汇总");
        let summary = &out[0];
        assert!(matches!(summary.level, DiagLevel::Info));
        assert!(matches!(summary.status, Some(DiagStatus::Success)));
        assert_eq!(summary.event, "op_completed");
        assert_eq!(summary.error_code, None);
        assert_eq!(meta(summary).get("success"), Some(&Json::from(3)));
        assert_eq!(meta(summary).get("failed"), Some(&Json::from(0)));
    }

    #[test]
    fn partial_batch_is_warn_and_keeps_counts() {
        let out = run(
            counts(5, 3, 1, 1, 0),
            vec![group("FS_OP_ACCESS_DENIED", "transfer", 1)],
            CRITICAL,
            EXPECTED,
        );
        // 汇总 + 1 条明细。
        assert_eq!(out.len(), 2);
        let summary = &out[0];
        assert!(matches!(summary.level, DiagLevel::Warn), "部分成功不能记成全部成功");
        assert_eq!(summary.event, "op_partial");
        assert_eq!(summary.error_code.as_deref(), Some("FS_OP_ACCESS_DENIED"));
        assert_eq!(
            meta(summary).get("partial"),
            Some(&Json::from(0)),
            "partial 计数必须原样落盘"
        );
        let detail = &out[1];
        assert_eq!(detail.stage.as_deref(), Some("transfer"));
        assert_eq!(meta(detail).get("count"), Some(&Json::from(1)));
        assert_eq!(meta(detail).get("mode"), Some(&Json::from("copy")));
        assert_eq!(detail.operation_id.as_deref(), Some("op-test-1"));
    }

    #[test]
    fn all_failed_with_real_io_failure_is_error() {
        let out = run(
            counts(2, 0, 0, 2, 0),
            vec![group("FS_OP_IO", "transfer", 2)],
            CRITICAL,
            EXPECTED,
        );
        let summary = &out[0];
        assert!(matches!(summary.level, DiagLevel::Error));
        assert_eq!(summary.event, "op_failed");
        assert_eq!(summary.error_code.as_deref(), Some("FS_OP_IO"));
        assert_eq!(summary.error_category.as_deref(), Some("io"));
    }

    #[test]
    fn all_failed_but_expected_rejection_stays_warn() {
        let out = run(
            counts(1, 0, 0, 1, 0),
            vec![group("FS_OP_VALIDATION", "prepare", 1)],
            CRITICAL,
            EXPECTED,
        );
        let summary = &out[0];
        assert!(
            matches!(summary.level, DiagLevel::Warn),
            "预期拒绝（校验失败）不该当内部故障报 ERROR"
        );
        assert_eq!(summary.error_code.as_deref(), Some("FS_OP_VALIDATION"));
    }

    #[test]
    fn critical_code_escalates_even_when_partial() {
        let out = run(
            counts(3, 2, 0, 0, 1),
            vec![group("FS_OP_DB_INCOMPATIBLE", "prepare", 1)],
            CRITICAL,
            EXPECTED,
        );
        let summary = &out[0];
        assert!(matches!(summary.level, DiagLevel::Error));
        assert_eq!(summary.event, "op_failed");
    }

    #[test]
    fn multiple_failure_groups_collapse_to_multi_failure_code() {
        let out = run(
            counts(4, 1, 0, 3, 0),
            vec![
                group("FS_OP_ACCESS_DENIED", "transfer", 2),
                group("FS_OP_FILE_BUSY", "transfer", 1),
            ],
            CRITICAL,
            EXPECTED,
        );
        let summary = &out[0];
        assert_eq!(summary.error_code.as_deref(), Some(MULTI));
        assert_eq!(meta(summary).get("failure_groups"), Some(&Json::from(2u64)));
        assert_eq!(out.len(), 3, "多组失败各一条明细，不合并成一条");
    }

    #[test]
    fn detail_events_are_capped_and_keep_biggest_group() {
        let mut failures = vec![];
        for i in 0..7 {
            failures.push(group(&format!("FS_OP_CODE_{i}"), "transfer", i as i64 + 1));
        }
        let out = run(counts(28, 0, 0, 28, 0), failures, CRITICAL, &[]);
        assert_eq!(out.len(), 1 + MAX_FAILURE_DETAIL_EVENTS, "明细必须有上限");
        // 最大的分组（7）必须留下，最小的几个被截断。
        let kept: Vec<i64> = out[1..]
            .iter()
            .filter_map(|e| meta(e).get("count").and_then(|v| v.as_i64()))
            .collect();
        assert_eq!(kept, vec![7, 6, 5, 4]);
    }

    #[test]
    fn partial_status_entries_are_aggregated_and_ok_entries_are_ignored() {
        let groups = aggregate_failures(
            vec![
                ("ok", None, None),
                ("skipped", None, None),
                ("failed", Some("FS_OP_ACCESS_DENIED"), Some("transfer")),
                ("failed", Some("FS_OP_ACCESS_DENIED"), Some("transfer")),
                ("partial", Some("FS_OP_IO"), Some("cleanup")),
                ("failed", None, None),
            ],
            "FS_OP_UNKNOWN",
        );
        assert_eq!(
            groups,
            vec![
                group("FS_OP_ACCESS_DENIED", "transfer", 2),
                group("FS_OP_IO", "cleanup", 1),
                // 缺码归 UNKNOWN，且不解析中文原因文本。
                group("FS_OP_UNKNOWN", "unknown", 1),
            ],
            "聚合只统计 failed/partial，并按 (码, 阶段) 分组"
        );
    }

    #[test]
    fn messages_never_contain_paths() {
        let out = run(
            counts(2, 0, 0, 2, 0),
            vec![group("FS_OP_ACCESS_DENIED", "transfer", 2)],
            CRITICAL,
            EXPECTED,
        );
        for event in &out {
            let message = event.message.as_deref().unwrap_or_default();
            assert!(!message.contains('\\'), "文案不得包含路径: {message}");
            for key in meta(event).keys() {
                assert!(
                    !["path", "full_path", "file_path", "content"].contains(&key.as_str()),
                    "metadata 不得带路径/正文键: {key}"
                );
            }
        }
    }
}
