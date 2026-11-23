//! Phase 1 领域受限文件导入（架构文档 §8.4）。
//!
//! 文件通道只开放**少量、可判定的更新型操作**，不把五个领域的写接口整体搬进目录：
//! - 只接受已注册的领域操作 ID（`novel.chapter.content.update` / `comic.media.update` /
//!   `comic.media.adopt`），未知类型在信封校验阶段就拒绝；
//! - 全部是更新类：**必须**带 `base_revision`，缺失即拒绝（防静默覆盖）；
//! - 项目归属只用数据库真实归属（章节/素材行），文件声明的 `project_id` 仅做一致性校验；
//! - 默认人工审核；`trusted` 目录仍要同时满足导入授权能力集合与真实资源归属；
//! - 单文件大小沿用 `MAX_IMPORT_BYTES`（256KiB），正文/备注不额外放大。
//!
//! 业务写入复用 `domains::{novel, comic}` 的事务内核心与既有导入租约守卫，
//! 不新建第二套幂等/审计：`sync::scan` 的 claim + `WriteGuard` 就是文件通道的幂等来源。

use serde_json::Value;

use crate::agent_access::store::{self, WriteGuard};
use crate::agent_access::{forbidden, permissions as perms, validation, Principal};
use crate::commands::comic_workspace::{owner_project_id, read_media};
use crate::commands::project_workspace::novel_chapter_updated_at;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::permissions::Capability;

use super::domains::{comic, novel, read_revision_snapshot, DomainKind};
use super::sync::{ImportEnvelope, ParsedDocument};

/// 文件通道开放的领域导入类型（与 `sync::KINDS` 保持同步）。
pub const KINDS: &[&str] = &[
    "novel.chapter.content.update",
    "comic.media.update",
    "comic.media.adopt",
];

/// 正文/备注上限：与单文件导入上限一致，不再额外放大。
const MAX_TEXT_BYTES: usize = super::MAX_IMPORT_BYTES as usize;

/// 文件通道可写入的素材状态：`adopted` 必须走 `comic.media.adopt`，
/// 否则会绕过「同镜头唯一采用 + 被替换版本 revision 推进」的业务语义。
const MEDIA_IMPORT_STATUSES: &[&str] = &["candidate", "rejected"];

pub fn is_domain_kind(kind: &str) -> bool {
    KINDS.contains(&kind)
}

/// 领域导入类型对应的真实写能力（与 `permissions::resolve_import_capability` 共用）。
pub fn capability(kind: &str) -> Option<Capability> {
    is_domain_kind(kind).then_some(Capability::ProjectsWrite)
}

pub fn domain_of(kind: &str) -> Option<DomainKind> {
    Some(match kind {
        "novel.chapter.content.update" => DomainKind::Novel,
        "comic.media.update" | "comic.media.adopt" => DomainKind::Comic,
        _ => return None,
    })
}

/// 信封校验：字段完整性 + 更新类必须带 `base_revision`。
pub fn validate_envelope(envelope: &ImportEnvelope) -> AppResult<()> {
    let kind = envelope.kind.as_str();
    let payload = envelope
        .payload
        .as_object()
        .ok_or_else(|| validation("payload 必须是对象"))?;
    match kind {
        "novel.chapter.content.update" => {
            require_text(payload, "chapter_id")?;
            let content = payload
                .get("content")
                .and_then(Value::as_str)
                .ok_or_else(|| validation("payload 缺少字符串字段 content"))?;
            if content.len() > MAX_TEXT_BYTES {
                return Err(validation(format!(
                    "正文超过 {MAX_TEXT_BYTES} 字节上限"
                )));
            }
        }
        "comic.media.update" => {
            require_text(payload, "media_id")?;
            require_text(payload, "version_label")?;
            if let Some(status) = payload.get("status").filter(|v| !v.is_null()) {
                let status = status
                    .as_str()
                    .ok_or_else(|| validation("字段 status 必须是字符串"))?;
                if !MEDIA_IMPORT_STATUSES.contains(&status) {
                    return Err(validation(format!(
                        "文件导入只能把素材状态改为 {}；采用版本请使用 comic.media.adopt",
                        MEDIA_IMPORT_STATUSES.join("|")
                    )));
                }
            }
            if let Some(note) = payload.get("review_note").filter(|v| !v.is_null()) {
                let note = note
                    .as_str()
                    .ok_or_else(|| validation("字段 review_note 必须是字符串"))?;
                if note.len() > MAX_TEXT_BYTES {
                    return Err(validation(format!(
                        "review_note 超过 {MAX_TEXT_BYTES} 字节上限"
                    )));
                }
            }
        }
        "comic.media.adopt" => {
            require_text(payload, "media_id")?;
        }
        other => {
            return Err(validation(format!("未支持的领域导入类型: {other}")));
        }
    }
    if envelope.base_revision.is_none() {
        return Err(validation(
            "更新类导入必须提供 base_revision（否则视为静默覆盖）",
        ));
    }
    Ok(())
}

/// 目标资源的真实项目归属（查不到返回 `None`，不猜、不读文件声明）。
pub fn resource_project(
    db: &Db,
    kind: &str,
    doc: &ParsedDocument,
) -> AppResult<Option<String>> {
    let id = match kind {
        "novel.chapter.content.update" => field(doc, "chapter_id")?,
        "comic.media.update" | "comic.media.adopt" => field(doc, "media_id")?,
        _ => return Ok(None),
    };
    let table = match domain_of(kind) {
        Some(DomainKind::Novel) => "novel_chapters",
        Some(DomainKind::Comic) => "comic_media_versions",
        _ => return Ok(None),
    };
    db.with_read(|conn| match owner_project_id(conn, table, &id) {
        Ok(project_id) => Ok(Some(project_id)),
        Err(AppError::NotFound(_)) => Ok(None),
        Err(err) => Err(err),
    })
}

/// 审计/冲突记录用的真实资源 ID（章节或素材版本）。
pub fn resource_id(doc: &ParsedDocument) -> String {
    resource_id_of(doc, doc.envelope.kind.as_str())
}

fn resource_id_of(doc: &ParsedDocument, kind: &str) -> String {
    let key = match kind {
        "novel.chapter.content.update" => "chapter_id",
        "comic.media.update" | "comic.media.adopt" => "media_id",
        _ => return String::new(),
    };
    doc.envelope
        .payload
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

/// 目标资源的**有效 revision**（把 UI 直接改业务行也计入）。
///
/// 冲突恢复时用它作为新的 `base_revision`，避免拿旧计数器继续冲突。
pub fn current_revision(db: &Db, doc: &ParsedDocument) -> AppResult<i64> {
    match doc.envelope.kind.as_str() {
        "novel.chapter.content.update" => {
            let id = field(doc, "chapter_id")?;
            db.with_read(|conn| {
                // 先确认章节存在，避免把「已删除」当成 revision=0。
                let updated_at = novel_chapter_updated_at(conn, &id)?;
                Ok(read_revision_snapshot(conn, "novel.chapter", &id, &updated_at)?.revision)
            })
        }
        "comic.media.update" | "comic.media.adopt" => {
            let id = field(doc, "media_id")?;
            db.with_read(|conn| {
                let media = read_media(conn, &id)?;
                Ok(read_revision_snapshot(
                    conn,
                    "comic.media_version",
                    &id,
                    &media.updated_at,
                )?
                .revision)
            })
        }
        _ => Ok(0),
    }
}

/// 执行一次领域文件导入。
///
/// `project_id` 必须是 `sync::effective_import_project` 推导出的**真实归属**；
/// 本函数在事务内再次用资源行核准，不采信文件声明。
pub fn import_document_guarded(
    db: &Db,
    principal: &Principal,
    doc: &ParsedDocument,
    project_id: &str,
    guard: &dyn WriteGuard,
) -> AppResult<String> {
    let kind = doc.envelope.kind.as_str();
    domain_of(kind).ok_or_else(|| validation(format!("未支持的领域导入类型: {kind}")))?;
    let base = doc.envelope.base_revision.ok_or_else(|| {
        validation("更新类导入必须提供 base_revision（否则视为静默覆盖）")
    })?;
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err(forbidden(
            "无法确定导入目标的真实项目归属；项目授权下不允许写入无归属资源",
        ));
    }
    // 入口层已判过；服务层不依赖调用方，写入前再验一次能力/身份。
    perms::require(db, principal, Capability::ProjectsWrite, project_id)?;

    let (message, resource_kind, resource_id, revision) = match kind {
        "novel.chapter.content.update" => {
            let chapter_id = field(doc, "chapter_id")?;
            let content = content_field(doc)?;
            let (summary, revision) = db.with_transaction(|conn| {
                guard.check(conn)?;
                let out = novel::update_chapter_content_in_conn(
                    conn,
                    principal,
                    project_id,
                    &chapter_id,
                    content,
                    base,
                    guard,
                )?;
                guard.complete(conn)?;
                Ok(out)
            })?;
            if summary.project_id != project_id {
                // 归属校验已在事务内完成；这里只做一次防御性断言，避免响应误导。
                return Err(super::domains::resource_access_error());
            }
            (
                format!("更新章节 {} 正文（revision {}）", chapter_id, revision),
                "novel.chapter",
                chapter_id,
                revision,
            )
        }
        "comic.media.update" => {
            let media_id = field(doc, "media_id")?;
            let version_label = field(doc, "version_label")?;
            let status = optional_text(doc, "status")?;
            let review_note = optional_text(doc, "review_note")?.unwrap_or_default();
            let (media, revision) = db.with_transaction(|conn| {
                guard.check(conn)?;
                let out = comic::update_media_in_conn(
                    conn,
                    principal,
                    project_id,
                    &media_id,
                    version_label,
                    status,
                    review_note,
                    base,
                    guard,
                )?;
                guard.complete(conn)?;
                Ok(out)
            })?;
            if media.project_id != project_id {
                return Err(super::domains::resource_access_error());
            }
            (
                format!("更新素材版本 {}（revision {}）", media_id, revision),
                "comic.media_version",
                media_id,
                revision,
            )
        }
        "comic.media.adopt" => {
            let media_id = field(doc, "media_id")?;
            let (media, revision) = db.with_transaction(|conn| {
                guard.check(conn)?;
                let out = comic::adopt_media_in_conn(
                    conn,
                    principal,
                    project_id,
                    &media_id,
                    base,
                    guard,
                )?;
                guard.complete(conn)?;
                Ok(out)
            })?;
            if media.project_id != project_id {
                return Err(super::domains::resource_access_error());
            }
            (
                format!("采用素材版本 {}（revision {}）", media_id, revision),
                "comic.media_version",
                media_id,
                revision,
            )
        }
        other => return Err(validation(format!("未支持的领域导入类型: {other}"))),
    };

    store::log_activity(
        db,
        &store::ActivityEntry {
            principal,
            action: kind,
            resource_kind,
            resource_id: &resource_id,
            project_id,
            // 文件通道没有调用方 requestId：幂等由导入租约（路径 + 内容 Hash）保证。
            request_id: "",
            success: true,
            error_code: "",
            detail: "文件导入：领域受限更新",
            revision: Some(revision),
            duration_ms: 0,
        },
    );
    Ok(message)
}

fn payload_object(doc: &ParsedDocument) -> AppResult<&serde_json::Map<String, Value>> {
    doc.envelope
        .payload
        .as_object()
        .ok_or_else(|| validation("payload 必须是对象"))
}

fn field(doc: &ParsedDocument, key: &str) -> AppResult<String> {
    let object = payload_object(doc)?;
    require_text(object, key)
}

fn require_text(object: &serde_json::Map<String, Value>, key: &str) -> AppResult<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| validation(format!("payload 缺少非空字段 {key}")))
}

fn content_field(doc: &ParsedDocument) -> AppResult<String> {
    let object = payload_object(doc)?;
    let content = object
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| validation("payload 缺少字符串字段 content"))?;
    if content.len() > MAX_TEXT_BYTES {
        return Err(validation(format!(
            "正文超过 {MAX_TEXT_BYTES} 字节上限"
        )));
    }
    Ok(content.to_string())
}

fn optional_text(doc: &ParsedDocument, key: &str) -> AppResult<Option<String>> {
    let object = payload_object(doc)?;
    match object.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(validation(format!("字段 {key} 必须是字符串"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_access::{permissions, sync, workspace, Source};
    use std::fs;
    use std::path::PathBuf;

    /// 临时工作空间 + 内存库（完整扫描路径需要真实目录与 marker）。
    struct Fixture {
        db: Db,
        root: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let db = Db::open_in_memory().expect("内存库");
            let root = std::env::temp_dir().join(format!(
                "taskdock-domain-import-{name}-{}",
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&root).expect("临时目录");
            workspace::init(&db, Some(root.to_str().unwrap()), Some("领域导入测试"))
                .expect("初始化工作空间");
            Self { db, root }
        }

        fn project(&self, kind: &str, status: &str) -> String {
            let id = format!("proj-{}", uuid::Uuid::new_v4().simple());
            self.db
                .with_conn(|conn| {
                    conn.execute(
                        "INSERT INTO workspace_projects
                           (id,name,kind,status,root_path,dev_project_id,note,created_at,updated_at)
                         VALUES (?1,'领域项目',?2,?3,'',NULL,'','2026-01-01','2026-01-01')",
                        rusqlite::params![id, kind, status],
                    )?;
                    Ok(())
                })
                .expect("创建项目");
            id
        }

        fn chapter(&self, project_id: &str, id: &str) {
            self.db
                .with_conn(|conn| {
                    conn.execute(
                        "INSERT INTO novel_volumes
                           (id, project_id, title, sort_order, created_at, updated_at)
                         VALUES ('v1', ?1, '第一卷', 0, '2026-01-01', '2026-01-01')",
                        rusqlite::params![project_id],
                    )
                    .ok();
                    conn.execute(
                        "INSERT INTO novel_chapters
                           (id,project_id,volume_id,title,content,word_count,sort_order,created_at,updated_at)
                         VALUES (?2,?1,'v1','第01章','初始正文',4,0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                        rusqlite::params![project_id, id],
                    )?;
                    Ok(())
                })
                .expect("创建章节");
        }

        fn comic_media(&self, project_id: &str) {
            self.db
                .with_conn(|conn| {
                    conn.execute(
                        "INSERT INTO comic_episodes
                           (id,project_id,episode_no,title,synopsis,script,status,progress,
                            character_ids_json,sort_order,created_at,updated_at)
                         VALUES ('ep1',?1,1,'第一集','','','draft',0,'[]',0,'2026-01-01','2026-01-01')",
                        rusqlite::params![project_id],
                    )?;
                    conn.execute(
                        "INSERT INTO comic_shots
                           (id,project_id,episode_id,shot_no,description,character_ids_json,scene_id,
                            dialogue,shot_size,camera_move,duration_sec,status,asset_refs_json,note,
                            sort_order,created_at,updated_at)
                         VALUES ('shot1',?1,'ep1',1,'镜头一','[]',NULL,'','','',0,'todo','[]','',0,
                                 '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                        rusqlite::params![project_id],
                    )?;
                    for (id, status) in [("m1", "adopted"), ("m2", "candidate")] {
                        conn.execute(
                            "INSERT INTO comic_media_versions
                               (id,project_id,shot_id,character_id,scene_id,file_path,media_kind,
                                version_label,status,review_note,source,created_at,updated_at)
                             VALUES (?1,?2,'shot1',NULL,NULL,?3,'image','v1',?4,'','imported',
                                     '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                            rusqlite::params![id, project_id, format!("C:/tmp/{id}.png"), status],
                        )?;
                    }
                    Ok(())
                })
                .expect("创建漫剧素材");
        }

        fn write(&self, name: &str, raw: &str) -> String {
            let inbox = self.root.join("inbox");
            fs::create_dir_all(&inbox).expect("inbox");
            fs::write(inbox.join(name), raw).expect("写入文件");
            format!("inbox/{name}")
        }

        fn policy(&self, mode: permissions::ImportMode, caps: &[&str], project: &str) {
            let row = workspace::active(&self.db).unwrap().unwrap();
            permissions::upsert_import_authorization(
                &self.db,
                &row.id,
                "inbox",
                mode,
                None,
                &caps.iter().map(|cap| cap.to_string()).collect::<Vec<_>>(),
                project,
            )
            .expect("写入策略");
        }

        fn scan(&self) -> sync::ScanReport {
            let row = workspace::active(&self.db).unwrap().unwrap();
            sync::scan(&self.db, &Principal::local(Source::Ui), &row).expect("扫描")
        }

        fn chapter_content(&self, id: &str) -> String {
            self.db
                .with_read(|conn| {
                    Ok(conn.query_row(
                        "SELECT content FROM novel_chapters WHERE id = ?1",
                        rusqlite::params![id],
                        |r| r.get::<_, String>(0),
                    )?)
                })
                .expect("读正文")
        }

        fn media_status(&self, id: &str) -> String {
            self.db
                .with_read(|conn| {
                    Ok(conn.query_row(
                        "SELECT status FROM comic_media_versions WHERE id = ?1",
                        rusqlite::params![id],
                        |r| r.get::<_, String>(0),
                    )?)
                })
                .expect("读素材状态")
        }

        fn media_revision(&self, id: &str) -> i64 {
            self.db
                .with_read(|conn| {
                    let updated_at: String = conn.query_row(
                        "SELECT updated_at FROM comic_media_versions WHERE id = ?1",
                        rusqlite::params![id],
                        |r| r.get(0),
                    )?;
                    Ok(read_revision_snapshot(conn, "comic.media_version", id, &updated_at)?.revision)
                })
                .expect("读素材版本")
        }

        fn request_status(&self, rel_path: &str) -> String {
            let row = workspace::active(&self.db).unwrap().unwrap();
            self.db
                .with_read(|conn| {
                    Ok(conn.query_row(
                        "SELECT status FROM agent_import_requests
                         WHERE workspace_row_id = ?1 AND rel_path = ?2",
                        rusqlite::params![row.id, rel_path],
                        |r| r.get::<_, String>(0),
                    )?)
                })
                .expect("读导入请求")
        }
    }

    fn markdown_chapter(chapter_id: &str, project_id: &str, base: i64, body: &str) -> String {
        format!(
            "---\nkind: novel.chapter.content.update\nproject_id: {project_id}\nchapter_id: {chapter_id}\nbase_revision: {base}\n---\n{body}\n"
        )
    }

    #[test]
    fn every_domain_kind_is_consistent_across_registry_sync_and_permissions() {
        // 单一事实源契约：文件 kind ↔ 注册中心操作 ↔ Manifest 接口 ↔ 能力映射。
        for kind in KINDS {
            assert!(sync::KINDS.contains(kind), "sync::KINDS 缺少 {kind}");
            assert_eq!(
                perms::resolve_import_capability(kind),
                Some(Capability::ProjectsWrite),
                "{kind} 的能力映射错误"
            );
            let op = super::super::domains::find_operation(kind)
                .unwrap_or_else(|| panic!("注册中心缺少 {kind}"));
            assert!(op.revision_required, "{kind} 必须要求 base revision");
            assert!(
                op.interfaces.contains(&super::super::domains::Interface::File),
                "{kind} 的 Manifest 未声明 file 接口"
            );
        }
    }

    #[test]
    fn markdown_chapter_update_parses_body_as_content() {
        let doc = sync::parse_external_document(
            &markdown_chapter("ch1", "p1", 3, "新的正文"),
            std::path::Path::new("inbox/a.md"),
        )
        .expect("解析 Markdown");
        assert_eq!(doc.envelope.kind, "novel.chapter.content.update");
        assert_eq!(doc.envelope.base_revision, Some(3));
        assert_eq!(
            doc.envelope.payload.get("chapter_id").and_then(Value::as_str),
            Some("ch1")
        );
        assert_eq!(
            doc.envelope.payload.get("content").and_then(Value::as_str),
            Some("新的正文")
        );
    }

    #[test]
    fn update_without_base_revision_is_rejected() {
        let raw = "---\nkind: novel.chapter.content.update\nchapter_id: ch1\n---\n正文\n";
        let err = sync::parse_external_document(raw, std::path::Path::new("inbox/a.md"))
            .unwrap_err();
        assert!(err.user_message().contains("base_revision"), "{err:?}");
    }

    #[test]
    fn media_update_cannot_set_adopted() {
        let raw = r#"{"schema":"taskdock.import/1","kind":"comic.media.update","base_revision":0,"payload":{"media_id":"m1","version_label":"v2","status":"adopted"}}"#;
        let err = sync::parse_external_document(raw, std::path::Path::new("inbox/a.json"))
            .unwrap_err();
        assert!(err.user_message().contains("comic.media.adopt"), "{err:?}");
    }

    #[test]
    fn trusted_policy_updates_chapter_and_advances_revision() {
        let fx = Fixture::new("trusted-chapter");
        let project = fx.project("novel", "active");
        fx.chapter(&project, "ch1");
        fx.policy(
            permissions::ImportMode::Trusted,
            &["projects.write"],
            &project,
        );
        fx.write("a.md", &markdown_chapter("ch1", &project, 0, "导入后的正文"));

        let report = fx.scan();
        assert_eq!(report.imported, 1, "{report:?}");
        assert_eq!(fx.chapter_content("ch1"), "导入后的正文");

        let revision = fx
            .db
            .with_read(|conn| {
                Ok(read_revision_snapshot(
                    conn,
                    "novel.chapter",
                    "ch1",
                    &novel_chapter_updated_at(conn, "ch1")?,
                )?
                .revision)
            })
            .unwrap();
        assert_eq!(revision, 1);
    }

    #[test]
    fn cross_project_chapter_update_is_rejected() {
        let fx = Fixture::new("cross-project");
        let a = fx.project("novel", "active");
        let b = fx.project("novel", "active");
        fx.chapter(&b, "ch-b");
        fx.policy(permissions::ImportMode::Trusted, &["projects.write"], &a);
        fx.write("a.md", &markdown_chapter("ch-b", &a, 0, "越权正文"));

        let report = fx.scan();
        assert_eq!(report.imported, 0, "{report:?}");
        assert_eq!(fx.chapter_content("ch-b"), "初始正文");
    }

    #[test]
    fn stale_base_revision_is_rejected_without_overwrite() {
        let fx = Fixture::new("stale-revision");
        let project = fx.project("novel", "active");
        fx.chapter(&project, "ch1");
        fx.policy(
            permissions::ImportMode::Trusted,
            &["projects.write"],
            &project,
        );
        fx.write("a.md", &markdown_chapter("ch1", &project, 0, "第一次导入"));
        assert_eq!(fx.scan().imported, 1);
        assert_eq!(fx.chapter_content("ch1"), "第一次导入");

        // 第二次以旧 base（0）提交不同内容：必须冲突且不覆盖。
        fx.write("b.md", &markdown_chapter("ch1", &project, 0, "旧版本覆盖"));
        let report = fx.scan();
        assert_eq!(report.imported, 0, "{report:?}");
        assert_eq!(report.conflicts, 1, "{report:?}");
        assert_eq!(fx.chapter_content("ch1"), "第一次导入");
    }

    #[test]
    fn missing_projects_write_capability_is_rejected() {
        let fx = Fixture::new("wrong-capability");
        let project = fx.project("novel", "active");
        fx.chapter(&project, "ch1");
        fx.policy(permissions::ImportMode::Trusted, &["tasks.write"], &project);
        fx.write("a.md", &markdown_chapter("ch1", &project, 0, "不应写入"));

        let report = fx.scan();
        assert_eq!(report.imported, 0, "{report:?}");
        assert_eq!(fx.chapter_content("ch1"), "初始正文");
    }

    #[test]
    fn review_mode_records_pending_request_without_writing() {
        let fx = Fixture::new("review-mode");
        let project = fx.project("novel", "active");
        fx.chapter(&project, "ch1");
        let rel = fx.write("a.md", &markdown_chapter("ch1", &project, 0, "待审核正文"));

        let report = fx.scan();
        assert_eq!(report.imported, 0, "{report:?}");
        assert_eq!(report.pending_review, 1, "{report:?}");
        assert_eq!(fx.request_status(&rel), "pending");
        assert_eq!(fx.chapter_content("ch1"), "初始正文");
    }

    #[test]
    fn adopt_import_advances_replaced_version_revision() {
        let fx = Fixture::new("comic-adopt");
        let project = fx.project("ai_comic", "active");
        fx.comic_media(&project);
        fx.policy(
            permissions::ImportMode::Trusted,
            &["projects.write"],
            &project,
        );
        fx.write(
            "a.json",
            &format!(
                r#"{{"schema":"taskdock.import/1","kind":"comic.media.adopt","project_id":"{project}","base_revision":0,"payload":{{"media_id":"m2"}}}}"#
            ),
        );

        let report = fx.scan();
        assert_eq!(report.imported, 1, "{report:?}");
        assert_eq!(fx.media_status("m2"), "adopted");
        assert_eq!(fx.media_status("m1"), "candidate");
        assert_eq!(fx.media_revision("m2"), 1);
        assert_eq!(fx.media_revision("m1"), 1, "被替换版本也必须推进 revision");
    }
}
