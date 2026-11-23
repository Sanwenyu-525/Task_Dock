//! 项目领域能力 Manifest（架构文档 §10）。
//!
//! Manifest 是能力发现，不是授权凭证：它只展示**已实际注册**的操作，
//! 不暴露 planned 能力；每次实际调用仍走完整权限、归属与版本校验。

use rusqlite::OptionalExtension;
use serde::Serialize;

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::registry::{all_operations, DomainKind};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDomainInfo {
    pub project_id: String,
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
    pub domain: String,
    pub operations: Vec<DomainManifestOperation>,
}

/// 为指定项目领域生成 Manifest。
///
/// `domain` 由 `workspace_projects.kind` 显式解析得来，调用方（policy）须先校验
/// 真实项目 kind；传入的 kind 必须是已解析的 DomainKind，不接受字符串猜测。
pub fn build_manifest(
    project_id: &str,
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
            kind: domain.as_str().to_string(),
            lifecycle_status: lifecycle_status.to_string(),
        },
        domain: domain.as_str().to_string(),
        operations,
    }
}

/// 按真实项目记录生成 Manifest（供 CLI / MCP / REST 共用）。
pub fn build_for_project(db: &Db, project_id: &str) -> AppResult<DomainManifest> {
    db.with_read(|conn| {
        let (kind, status): (String, String) = conn
            .query_row(
                "SELECT kind, status FROM workspace_projects WHERE id = ?1",
                [project_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::NotFound("项目不存在".into()))?;
        let domain = DomainKind::parse(&kind).ok_or_else(|| {
            AppError::Validation(format!("项目类型 {kind} 没有对应的 Agent 领域"))
        })?;
        Ok(build_manifest(project_id, domain, &status))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_reports_schema_and_real_project_kind() {
        let m = build_manifest("proj-1", DomainKind::Novel, "active");
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json["schemaVersion"], "1.0");
        assert_eq!(json["project"]["projectId"], "proj-1");
        assert_eq!(json["project"]["kind"], "novel");
        assert_eq!(json["project"]["lifecycleStatus"], "active");
        assert_eq!(json["domain"], "novel");
    }

    #[test]
    fn manifest_does_not_expose_planned_capabilities() {
        // 只暴露注册中心里真实存在的操作；Phase 1 仅小说与漫剧，
        // 游戏 / 通用 / 开发的 planned 能力不得出现在 Manifest 中。
        let registered: Vec<&str> = all_operations().iter().map(|op| op.id).collect();
        for domain in DomainKind::ALL {
            let m = build_manifest("p", domain, "active");
            assert!(m.operations.iter().all(|op| registered.contains(&op.id.as_str())));
            if matches!(domain, DomainKind::Novel | DomainKind::Comic) {
                assert!(!m.operations.is_empty(), "{} 应有已注册操作", domain.as_str());
            } else {
                assert!(m.operations.is_empty(), "{} 不应暴露 planned 能力", domain.as_str());
            }
        }
    }
}
