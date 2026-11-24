//! 领域受限文件导入。更新要求 base_revision，创建由服务端生成 ID。
//! 文件声明只用于一致性校验。游戏、通用、开发写入要求显式绑定项目的目录授权。
//! 默认人工审核，业务写入复用各领域核心及导入租约守卫。

use serde_json::Value;

use crate::agent_access::store::{self, WriteGuard};
use crate::agent_access::{forbidden, permissions as perms, validation, Principal};
use crate::commands::comic_workspace::{
    owner_project_id, read_media, validate_media_meta,
};
use crate::commands::general_workspace::general_milestone_read_in_conn;
use crate::commands::project_workspace::novel_chapter_updated_at;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::permissions::Capability;

use super::domains::{comic, development, game, general, novel, read_revision_snapshot, registry, DomainKind};
use super::sync::{ImportEnvelope, ParsedDocument};

/// 文件通道开放的领域导入类型（与 `sync::KINDS` 保持同步）。
pub const KINDS: &[&str] = &[
    "novel.chapter.content.update",
    "comic.media.update",
    "comic.media.adopt",
    "game.build.create",
    "game.test.create",
    "general.milestone.save",
    "development.task_link.create",
];

/// 正文上限：与单文件导入上限一致，不再额外放大。
const MAX_TEXT_BYTES: usize = super::MAX_IMPORT_BYTES as usize;

pub fn is_domain_kind(kind: &str) -> bool {
    KINDS.contains(&kind)
}

pub fn requires_project_policy(kind: &str) -> bool {
    matches!(kind, "game.build.create" | "game.test.create" | "general.milestone.save" | "development.task_link.create")
}

/// 领域导入类型对应的真实写能力（与 `permissions::resolve_import_capability` 共用）。
pub fn capability(kind: &str) -> Option<Capability> {
    is_domain_kind(kind).then_some(Capability::ProjectsWrite)
}

pub fn domain_of(kind: &str) -> Option<DomainKind> {
    Some(match kind {
        "novel.chapter.content.update" => DomainKind::Novel,
        "comic.media.update" | "comic.media.adopt" => DomainKind::Comic,
        "game.build.create" | "game.test.create" => DomainKind::Game,
        "general.milestone.save" => DomainKind::General,
        "development.task_link.create" => DomainKind::Development,
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
            let version_label = payload
                .get("version_label")
                .and_then(Value::as_str)
                .ok_or_else(|| validation("payload 缺少字符串字段 version_label"))?;
            let status = match payload.get("status").filter(|v| !v.is_null()) {
                None => None,
                Some(value) => Some(
                    value
                        .as_str()
                        .ok_or_else(|| validation("字段 status 必须是字符串"))?,
                ),
            };
            let review_note = match payload.get("review_note").filter(|v| !v.is_null()) {
                None => "",
                Some(value) => value
                    .as_str()
                    .ok_or_else(|| validation("字段 review_note 必须是字符串"))?,
            };
            // 文件导入与 IPC / Agent 领域共用同一套业务校验：
            // version_label 240 字符、review_note 4000 字符、status 只允许
            // candidate/rejected，且拒绝控制字符。不得把备注放宽到 256KiB。
            validate_media_meta(version_label, status, review_note)?;
        }
        "comic.media.adopt" => {
            require_text(payload, "media_id")?;
        }
        "general.milestone.save" => {
            read_general_input(envelope)?;
            return Ok(());
        }
        "game.build.create" | "game.test.create" | "development.task_link.create" => {
            if envelope.base_revision.is_some() {
                return Err(validation("创建类导入禁止提供 base_revision"));
            }
            match kind {
                "game.build.create" => { read_payload::<game::CreateBuildInput>(envelope)?; }
                "game.test.create" => { read_payload::<game::CreateTestInput>(envelope)?; }
                _ => { read_payload::<development::CreateTaskLinkInput>(envelope)?; }
            }
            return Ok(());
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

fn read_payload<T: serde::de::DeserializeOwned>(envelope: &ImportEnvelope) -> AppResult<T> {
    registry::validate_payload_size(&envelope.kind, envelope.payload.to_string().len())?;
    serde_json::from_value(envelope.payload.clone())
        .map_err(|_| validation("payload 不符合该领域操作的参数契约"))
}

fn read_general_input(envelope: &ImportEnvelope) -> AppResult<general::SaveMilestoneInput> {
    let mut input: general::SaveMilestoneInput = read_payload(envelope)?;
    if input.expected_revision.is_some() {
        return Err(validation("里程碑文件版本只使用信封 base_revision"));
    }
    match (&input.id, envelope.base_revision) {
        (None, None) => Ok(input),
        (Some(id), Some(revision)) if !id.trim().is_empty() && revision >= 0 => {
            input.expected_revision = Some(revision);
            Ok(input)
        }
        _ => Err(validation("创建里程碑省略 id 与 base_revision，更新需同时提供两者")),
    }
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
        "general.milestone.save" => "id",
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
        "general.milestone.save" => {
            let id = field(doc, "id")?;
            db.with_read(|conn| {
                let milestone = general_milestone_read_in_conn(conn, &id)?;
                Ok(read_revision_snapshot(conn, "general.milestone", &id, &milestone.updated_at)?.revision)
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
    validate_envelope(&doc.envelope)?;
    let base = doc.envelope.base_revision.unwrap_or(0);
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err(forbidden(
            "无法确定导入目标的真实项目归属；项目授权下不允许写入无归属资源",
        ));
    }
    // 入口层已判过；服务层不依赖调用方，写入前再验一次能力/身份。
    perms::require(db, principal, Capability::ProjectsWrite, project_id)?;

    if requires_project_policy(kind) {
        let grant = principal.import.as_ref().ok_or_else(|| forbidden("领域写入缺少项目导入授权"))?;
        if grant.project_id.trim().is_empty()
            || grant.project_id.trim() != project_id
            || grant.authorization_id == "manual-approval"
        {
            return Err(forbidden("领域写入需要显式绑定同一项目的目录授权"));
        }
    }

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
            if summary.chapter.project_id != project_id {
                // 归属校验已在事务内完成；这里只做一次防御性断言，避免响应误导。
                return Err(super::domains::resource_access_error());
            }
            (
                format!("更新章节 {} 正文（revision {}）", chapter_id, revision),
                "novel.chapter",
                chapter_id,
                Some(revision),
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
                Some(revision),
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
                Some(revision),
            )
        }
        "game.build.create" => {
            let input = read_payload(&doc.envelope)?;
            let row = db.with_transaction(|conn| {
                guard.check(conn)?;
                let row = game::create_build_in_conn(conn, principal, project_id, input, guard)?;
                guard.complete(conn)?;
                Ok(row)
            })?;
            (format!("登记构建 {}（未独立验证，revision {}）", row.id, row.revision),
                "game.build", row.id, Some(row.revision))
        }
        "game.test.create" => {
            let input = read_payload(&doc.envelope)?;
            let row = db.with_transaction(|conn| {
                guard.check(conn)?;
                let row = game::create_test_in_conn(conn, principal, project_id, input, guard)?;
                guard.complete(conn)?;
                Ok(row)
            })?;
            (format!("登记测试 {}（未独立验证，revision {}）", row.id, row.revision),
                "game.test", row.id, Some(row.revision))
        }
        "general.milestone.save" => {
            let input = read_general_input(&doc.envelope)?;
            let row = general::save_milestone_with_guard(db, principal, project_id, input, guard)?;
            (format!("保存通用里程碑 {}（revision {}）", row.id, row.revision),
                "general.milestone", row.id, Some(row.revision))
        }
        "development.task_link.create" => {
            let input = read_payload(&doc.envelope)?;
            let link = development::create_task_link_with_guard(db, principal, project_id, input, guard)?;
            let id = link["id"].as_str()
                .ok_or_else(|| AppError::Unavailable("缺少开发证据关联 ID".into()))?;
            (format!("关联开发任务证据 {id}"), "development.task_link", id.to_string(), None)
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
            detail: "文件导入：领域受限写入",
            revision,
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
            assert_eq!(op.revision_required, !requires_project_policy(kind), "{kind} 的固定 revision 要求不一致");
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

    fn game_envelope(kind: &str, project: Option<&str>, payload: Value) -> String {
        serde_json::json!({
            "schema": "taskdock.import/1", "kind": kind,
            "project_id": project, "payload": payload,
        }).to_string()
    }

    fn game_build_payload() -> Value {
        serde_json::json!({"target": "Windows", "status": "success", "note": "登记备注"})
    }

    fn game_counts(fx: &Fixture) -> (i64, i64) {
        fx.db.with_read(|conn| Ok((
            conn.query_row("SELECT COUNT(*) FROM game_builds", [], |r| r.get(0))?,
            conn.query_row("SELECT COUNT(*) FROM game_tests", [], |r| r.get(0))?,
        ))).unwrap()
    }

    #[test]
    fn game_creation_defaults_to_review_and_approval_cannot_trust_file_project() {
        let fx = Fixture::new("game-review-default");
        let project = fx.project("game", "active");
        let rel = fx.write("build.json", &game_envelope("game.build.create", Some(&project), game_build_payload()));
        let report = fx.scan();
        assert_eq!(report.pending_review, 1, "{report:?}");
        assert_eq!(game_counts(&fx), (0, 0));
        let request = sync::list_import_requests(&fx.db, Some("pending")).unwrap().into_iter().find(|r| r.rel_path == rel).unwrap();
        assert!(sync::approve_import(&fx.db, &Principal::local(Source::Ui), &request.id, "批准").is_err());
        assert_eq!(game_counts(&fx), (0, 0));
    }

    #[test]
    fn game_review_approval_uses_bound_project_without_file_declaration() {
        let fx = Fixture::new("game-review-bound");
        let project = fx.project("game", "active");
        fx.policy(permissions::ImportMode::Review, &["projects.write"], &project);
        fx.write("build.json", &game_envelope("game.build.create", None, game_build_payload()));
        assert_eq!(fx.scan().pending_review, 1);
        let request = sync::list_import_requests(&fx.db, Some("pending")).unwrap().remove(0);
        let result = sync::approve_import(&fx.db, &Principal::local(Source::Ui), &request.id, "确认登记").unwrap();
        assert!(result.contains("未独立验证"));
        assert_eq!(game_counts(&fx), (1, 0));
        let (builds, _) = game::list_builds(&fx.db, &Principal::local(Source::Ui), &project, None, None).unwrap();
        assert_eq!(builds[0].project_id, project);
        assert_eq!(builds[0].note, "登记备注");
        assert_eq!(builds[0].source, "imported");
        assert_eq!(builds[0].revision, 1);
        assert_eq!(builds[0].verification_status, "unverified");
    }

    #[test]
    fn game_trusted_creation_round_trip_and_same_file_is_imported_once() {
        let fx = Fixture::new("game-trusted-roundtrip");
        let project = fx.project("game", "active");
        fx.policy(permissions::ImportMode::Trusted, &["projects.write"], &project);
        let raw = game_envelope("game.build.create", None, game_build_payload());
        fx.write("build.json", &raw);
        let report = fx.scan();
        assert_eq!(report.imported, 1, "{report:?}");
        let (builds, _) = game::list_builds(&fx.db, &Principal::local(Source::Ui), &project, None, None).unwrap();
        fx.write("build.json", &raw);
        let duplicate = fx.scan();
        assert_eq!(duplicate.imported, 0, "{duplicate:?}");
        assert_eq!(duplicate.skipped, 1, "{duplicate:?}");
        fx.write("test.json", &game_envelope("game.test.create", Some(&project), serde_json::json!({
            "build_id": builds[0].id, "title": "首章回归", "result": "passed"
        })));
        assert_eq!(fx.scan().imported, 1);
        assert_eq!(game_counts(&fx), (1, 1));
        fx.db.with_read(|conn| {
            let (kind, id, revision, owner): (String, String, i64, String) = conn.query_row(
                "SELECT resource_kind,resource_id,revision,project_id FROM agent_operations
                 WHERE action = 'import.create' AND resource_kind = 'game.test' AND status = 'committed'",
                [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?;
            assert_eq!(kind, "game.test");
            assert!(!id.is_empty());
            assert_eq!(revision, 1);
            assert_eq!(owner, project);
            let source: String = conn.query_row(
                "SELECT source FROM agent_resource_revisions WHERE resource_kind='game.test' AND resource_id=?1",
                [&id], |r| r.get(0),
            )?;
            assert_eq!(source, "file");
            let event: (String, i64) = conn.query_row(
                "SELECT resource_id,revision FROM agent_sync_events WHERE event_kind='game.test.create' AND status='ok'",
                [], |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            assert_eq!(event, (id, 1));
            Ok(())
        }).unwrap();
    }

    #[test]
    fn game_creation_rejects_global_grant_wrong_project_wrong_kind_and_archive() {
        let fx = Fixture::new("game-import-boundaries");
        let project = fx.project("game", "active");
        let other = fx.project("game", "active");
        fx.policy(permissions::ImportMode::Trusted, &["projects.write"], "");
        fx.write("global.json", &game_envelope("game.build.create", Some(&project), game_build_payload()));
        assert_eq!(fx.scan().imported, 0);
        fs::remove_file(fx.root.join("inbox/global.json")).unwrap();
        fx.policy(permissions::ImportMode::Trusted, &["projects.write"], &project);
        fx.write("wrong-project.json", &game_envelope("game.build.create", Some(&other), game_build_payload()));
        assert_eq!(fx.scan().imported, 0);
        let wrong_kind = fx.project("general", "active");
        fx.policy(permissions::ImportMode::Trusted, &["projects.write"], &wrong_kind);
        fx.write("wrong-kind.json", &game_envelope("game.build.create", None, game_build_payload()));
        assert_eq!(fx.scan().imported, 0);
        let archived = fx.project("game", "archived");
        fx.policy(permissions::ImportMode::Trusted, &["projects.write"], &archived);
        fx.write("archived.json", &game_envelope("game.build.create", None, game_build_payload()));
        assert_eq!(fx.scan().imported, 0);
        assert_eq!(game_counts(&fx), (0, 0));
    }

    #[test]
    fn game_creation_rejects_base_revision_execution_fields_and_oversized_payload() {
        let fx = Fixture::new("game-invalid-inputs");
        let project = fx.project("game", "active");
        fx.policy(permissions::ImportMode::Trusted, &["projects.write"], &project);
        let mut base: Value = serde_json::from_str(&game_envelope("game.build.create", Some(&project), game_build_payload())).unwrap();
        base["base_revision"] = serde_json::json!(0);
        fx.write("base.json", &base.to_string());
        let mut execution = game_build_payload();
        execution["command"] = serde_json::json!("do-not-run");
        fx.write("execution.json", &game_envelope("game.build.create", Some(&project), execution));
        let mut oversize = game_build_payload();
        oversize["note"] = serde_json::json!("x".repeat(game::MAX_CREATE_PAYLOAD_BYTES));
        fx.write("oversized.json", &game_envelope("game.build.create", Some(&project), oversize));
        let report = fx.scan();
        assert_eq!(report.failed, 3, "{report:?}");
        assert_eq!(report.imported, 0);
        assert_eq!(game_counts(&fx), (0, 0));
    }

    #[test]
    fn game_review_rechecks_bound_agent_identity_capability_and_revocation() {
        let fx = Fixture::new("game-review-agent");
        let project = fx.project("game", "active");
        let agent = crate::mcp::auth::create_agent(&fx.db, "game-file-agent", "文件导入测试").unwrap();
        crate::mcp::auth::set_agent_scope(&fx.db, &agent.info.id, "project_rw").unwrap();
        crate::mcp::auth::grant_project(&fx.db, &agent.info.id, &project).unwrap();
        crate::mcp::permissions::grant(&fx.db, &agent.info.id, "projects.write", "").unwrap();
        let row = workspace::active(&fx.db).unwrap().unwrap();
        permissions::upsert_import_authorization(&fx.db, &row.id, "inbox", permissions::ImportMode::Review,
            Some(&agent.info.id), &["projects.write".to_string()], &project).unwrap();
        let mut value: Value = serde_json::from_str(&game_envelope("game.build.create", None, game_build_payload())).unwrap();
        value["agent_id"] = serde_json::json!("impersonated-agent");
        fx.write("impersonated.json", &value.to_string());
        assert_eq!(fx.scan().pending_review, 1);
        let request = sync::list_import_requests(&fx.db, Some("pending")).unwrap().remove(0);
        assert!(sync::approve_import(&fx.db, &Principal::local(Source::Ui), &request.id, "").is_err());
        value["agent_id"] = serde_json::json!(agent.info.agent_id);
        fx.write("valid.json", &value.to_string());
        assert_eq!(fx.scan().pending_review, 2);
        let request = sync::list_import_requests(&fx.db, Some("pending")).unwrap().into_iter().find(|r| r.rel_path == "inbox/valid.json").unwrap();
        sync::approve_import(&fx.db, &Principal::local(Source::Ui), &request.id, "").unwrap();
        fx.db.with_conn(|conn| {
            conn.execute("UPDATE mcp_agents SET revoked_at='2026-11-24' WHERE id=?1", [&agent.info.id])?;
            Ok(())
        }).unwrap();
        fx.write("revoked.json", &value.to_string());
        fx.scan();
        let request = sync::list_import_requests(&fx.db, Some("pending")).unwrap().into_iter().find(|r| r.rel_path == "inbox/revoked.json").unwrap();
        assert!(sync::approve_import(&fx.db, &Principal::local(Source::Ui), &request.id, "").is_err());
        assert_eq!(game_counts(&fx), (1, 0));
    }

    #[test]
    fn general_milestone_file_create_update_and_conflict_resolution_use_real_revision() {
        let fx = Fixture::new("general-file");
        let project = fx.project("general", "active");
        fx.policy(permissions::ImportMode::Trusted, &["projects.write"], &project);
        let principal = Principal::local(Source::Ui);
        let kind = "general.milestone.save";
        let mut doc = serde_json::json!({
            "schema": "taskdock.import/1", "kind": kind, "payload": { "title": "首次登记" }
        });
        fx.write("create.json", &doc.to_string());
        assert_eq!(fx.scan().imported, 1);
        let (rows, _) = general::list_milestones(&fx.db, &principal, &project, None, None).unwrap();
        assert_eq!(rows[0].revision, 1);
        doc["base_revision"] = serde_json::json!(rows[0].revision);
        doc["payload"] = serde_json::json!({ "id": rows[0].id, "title": "文件更新" });
        fx.write("update.json", &doc.to_string());
        assert_eq!(fx.scan().imported, 1);
        doc["payload"]["title"] = serde_json::json!("人工接受外部版本");
        fx.write("stale.json", &doc.to_string());
        assert_eq!(fx.scan().conflicts, 1);
        let conflict = sync::list_conflicts(&fx.db).unwrap().remove(0);
        assert_eq!(conflict.resource_id, rows[0].id);
        assert_eq!(conflict.db_revision, 2);
        sync::resolve_conflict(&fx.db, &principal, &conflict.id, "file").unwrap();
        let (final_rows, _) = general::list_milestones(&fx.db, &principal, &project, None, None).unwrap();
        assert_eq!(final_rows.len(), 1);
        assert_eq!(final_rows[0].revision, 3);
        assert_eq!(final_rows[0].title, "人工接受外部版本");
    }

    #[test]
    fn development_file_link_requires_bound_agent_with_task_read() {
        use crate::mcp::{auth, permissions as mcp_permissions};

        let fx = Fixture::new("development-file");
        let project = fx.project("development", "active");
        fx.db.with_conn(|conn| {
            conn.execute("INSERT INTO tasks (id,title,created_at,updated_at)
                VALUES ('task','验证任务','2026-11-24','2026-11-24')", [])?;
            conn.execute("INSERT INTO workspace_task_links (project_id,task_id,created_at)
                VALUES (?1,'task','2026-11-24')", [&project])?;
            conn.execute("INSERT INTO dev_acceptance_records (id,subject_kind,subject_id,verdict,created_at)
                VALUES ('acceptance','task','task','pass','2026-11-24')", [])?;
            Ok(())
        }).unwrap();
        fx.policy(permissions::ImportMode::Trusted, &["projects.write"], &project);
        let doc = serde_json::json!({
            "schema": "taskdock.import/1", "kind": "development.task_link.create",
            "payload": { "task_id": "task", "acceptance_record_id": "acceptance" }
        });
        fx.write("link.json", &doc.to_string());
        assert_eq!(fx.scan().imported, 0);
        let agent = auth::create_agent(&fx.db, "dev-file-agent", "文件关联测试").unwrap();
        auth::set_agent_scope(&fx.db, &agent.info.id, "project_rw").unwrap();
        auth::grant_project(&fx.db, &agent.info.id, &project).unwrap();
        mcp_permissions::grant(&fx.db, &agent.info.id, "projects.write", "").unwrap();
        let workspace = workspace::active(&fx.db).unwrap().unwrap();
        permissions::upsert_import_authorization(
            &fx.db, &workspace.id, "inbox", permissions::ImportMode::Trusted,
            Some(&agent.info.id), &["projects.write".to_string()], &project,
        ).unwrap();
        assert_eq!(fx.scan().imported, 0);
        mcp_permissions::grant(&fx.db, &agent.info.id, "tasks.read", "task").unwrap();
        let report = fx.scan();
        assert_eq!(report.imported, 1, "{report:?}");
        let (items, _) = development::list_task_evidence(
            &fx.db, &Principal::local(Source::Ui), &project, "task", None, None,
        ).unwrap();
        assert_eq!(items[0]["linked"], true);
        assert_eq!(items[0]["verdict"], "pass");
    }
}
