//! 项目领域能力 Manifest（架构文档 §10）。
//!
//! Manifest 是能力发现，不是授权凭证；但它本身也不是免授权接口：
//! 生成前必须先通过项目读取授权（身份/scope/能力/项目 grant），
//! 再按真实项目类型解析领域。未授权主体无法通过 Manifest 推断项目类型。

use rusqlite::OptionalExtension;
use serde::Serialize;

use crate::agent_access::{permissions, Principal};
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::mcp::permissions::Capability;

use super::registry::{all_operations, DomainKind};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDomainInfo {
    pub project_id: String,
    /// 真实数据库项目类型（如 `ai_comic`），不是领域名称。
    pub kind: String,
    pub lifecycle_status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainManifestOperation {
    pub id: String,
    pub access: String,
    pub resource_kind: String,
    pub permission: String,
    pub interfaces: Vec<String>,
    pub revision_required: bool,
    pub request_id_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_payload_bytes: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainManifest {
    pub schema_version: String,
    pub project: ProjectDomainInfo,
    /// 领域名称，用于操作 ID 前缀与能力分组。
    pub domain: String,
    pub operations: Vec<DomainManifestOperation>,
}

/// 为指定项目领域生成 Manifest。
///
/// `project_kind` 必须是 `workspace_projects.kind` 的原始值（如 `ai_comic`），
/// `domain` 是解析后的领域类型（`comic`）。二者不得混用：
/// `ai_comic` 是数据库项目类型，`comic` 只是 Agent 领域名称。
pub fn build_manifest(
    project_id: &str,
    project_kind: &str,
    domain: DomainKind,
    lifecycle_status: &str,
) -> DomainManifest {
    let operations = all_operations()
        .iter()
        .filter(|op| op.domain == domain)
        .map(|op| DomainManifestOperation {
            id: op.id.to_string(),
            access: op.access.as_str().to_string(),
            resource_kind: op.resource_kind.to_string(),
            permission: op.permission.as_str().to_string(),
            interfaces: op.interfaces.iter().map(|i| i.as_str().to_string()).collect(),
            revision_required: op.revision_required,
            request_id_required: op.request_id_required,
            max_payload_bytes: op.max_payload_bytes,
        })
        .collect();

    DomainManifest {
        schema_version: "1.0".to_string(),
        project: ProjectDomainInfo {
            project_id: project_id.to_string(),
            kind: project_kind.to_string(),
            lifecycle_status: lifecycle_status.to_string(),
        },
        domain: domain.as_str().to_string(),
        operations,
    }
}

/// 带授权的 Manifest 读取入口（CLI / MCP / REST 共用，唯一入口）。
///
/// 判定顺序：解析项目根 → 项目读取授权（身份/scope/能力/项目 grant）
/// → 读取真实 kind/status → 领域解析。缺少任一步都拒绝，不返回项目类型。
pub fn build_for_principal(
    db: &Db,
    principal: &Principal,
    project_ref: &str,
) -> AppResult<DomainManifest> {
    let raw = project_ref.trim();
    if raw.is_empty() {
        return Err(AppError::Validation("项目 ID 不能为空".into()));
    }
    db.with_read(|conn| {
        let root = permissions::resolve_project_root(conn, raw)?
            .ok_or_else(|| AppError::NotFound("项目不存在".into()))?;
        permissions::require_in_conn(conn, principal, Capability::ProjectsRead, &root)?;
        let (kind, status): (String, String) = conn
            .query_row(
                "SELECT kind, status FROM workspace_projects WHERE id = ?1",
                [&root],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("项目不存在".into()))?;
        let domain = DomainKind::parse(&kind).ok_or_else(|| {
            AppError::Validation(format!("项目类型 {kind} 没有对应的 Agent 领域"))
        })?;
        Ok(build_manifest(&root, &kind, domain, &status))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_reports_schema_and_real_project_kind() {
        let m = build_manifest("proj-1", "novel", DomainKind::Novel, "active");
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json["schemaVersion"], "1.0");
        assert_eq!(json["project"]["projectId"], "proj-1");
        assert_eq!(json["project"]["kind"], "novel");
        assert_eq!(json["project"]["lifecycleStatus"], "active");
        assert_eq!(json["domain"], "novel");
    }

    #[test]
    fn comic_project_kind_and_domain_are_not_conflated() {
        let m = build_manifest("p-comic", "ai_comic", DomainKind::Comic, "active");
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json["project"]["kind"], "ai_comic");
        assert_eq!(json["domain"], "comic");
    }

    #[test]
    fn all_five_project_kinds_map_to_the_expected_domain() {
        for (kind, expected) in [
            ("novel", "novel"),
            ("ai_comic", "comic"),
            ("game", "game"),
            ("general", "general"),
            ("development", "development"),
        ] {
            let domain = DomainKind::parse(kind).unwrap_or_else(|| panic!("{kind} 应可解析"));
            let m = build_manifest("p", kind, domain, "active");
            let json = serde_json::to_value(&m).unwrap();
            assert_eq!(json["project"]["kind"], kind, "项目类型必须是原始 kind");
            assert_eq!(json["domain"], expected);
        }
    }

    #[test]
    fn manifest_does_not_expose_planned_capabilities() {
        let registered: Vec<&str> = all_operations().iter().map(|op| op.id).collect();
        for domain in DomainKind::ALL {
            let m = build_manifest("p", domain.as_str(), domain, "active");
            assert!(!m.operations.is_empty(), "{} 应有已注册操作", domain.as_str());
            assert!(m.operations.iter().all(|op| registered.contains(&op.id.as_str())
                && op.id.split('.').next() == Some(domain.as_str())));
        }
    }
}
