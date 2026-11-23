//! 项目领域类型、领域操作元数据与静态注册中心（架构文档 §3.2 / §3.3）。
//!
//! 这里是唯一的领域操作事实源：CLI / MCP / REST / 文件入口的领域工具清单
//! 必须通过契约测试与本注册中心的操作 ID 对齐，不得各自维护一份。
//! 注册中心只声明元数据，**不执行业务**，也不做动态反射分发。

use crate::mcp::permissions::Capability;

/// 五类项目领域。与 `workspace_projects.kind` 一一对应，显式匹配，未知类型拒绝。
/// UI 在未知 kind 时可回退 general，Agent 入口绝不允许（架构文档 §3.2）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DomainKind {
    Development,
    General,
    Novel,
    Comic,
    Game,
}

impl DomainKind {
    /// 从数据库 `workspace_projects.kind` 解析；未知类型返回 None（由调用方拒绝）。
    pub fn parse(kind: &str) -> Option<Self> {
        Some(match kind {
            "development" => DomainKind::Development,
            "general" => DomainKind::General,
            "novel" => DomainKind::Novel,
            "ai_comic" => DomainKind::Comic,
            "game" => DomainKind::Game,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            DomainKind::Development => "development",
            DomainKind::General => "general",
            DomainKind::Novel => "novel",
            DomainKind::Comic => "comic",
            DomainKind::Game => "game",
        }
    }

    /// 稳定领域前缀，用于资源类型命名（如 `novel.chapter`）与操作 ID 前缀。
    pub fn prefix(self) -> &'static str {
        self.as_str()
    }

    pub const ALL: [DomainKind; 5] = [
        DomainKind::Development,
        DomainKind::General,
        DomainKind::Novel,
        DomainKind::Comic,
        DomainKind::Game,
    ];
}

/// 操作读写属性。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OperationAccess {
    Read,
    Write,
}

impl OperationAccess {
    pub fn as_str(self) -> &'static str {
        match self {
            OperationAccess::Read => "read",
            OperationAccess::Write => "write",
        }
    }
}

/// Agent 接入入口。Manifest 用它声明每个操作实际支持的接口范围。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Interface {
    Cli,
    Mcp,
    Rest,
    File,
}

impl Interface {
    pub fn as_str(self) -> &'static str {
        match self {
            Interface::Cli => "cli",
            Interface::Mcp => "mcp",
            Interface::Rest => "rest",
            Interface::File => "file",
        }
    }
}

/// 领域操作的静态元数据定义。
///
/// `id` 采用 `domain.resource.action` 形式（如 `novel.chapter.content.update`），
/// 一经注册即稳定，不允许随接口重命名而改变。
#[derive(Clone, Copy, Debug)]
pub struct DomainOperationDef {
    pub id: &'static str,
    pub domain: DomainKind,
    pub access: OperationAccess,
    pub resource_kind: &'static str,
    pub permission: Capability,
    pub interfaces: &'static [Interface],
    /// 写操作是否要求 expectedRevision / expectedUpdatedAt。
    pub revision_required: bool,
    /// 写操作是否要求 requestId（幂等键）。
    pub request_id_required: bool,
    pub max_payload_bytes: Option<usize>,
}

impl DomainOperationDef {
    /// 静态元数据自检：ID 前缀与领域一致；写操作必须要求 requestId。
    /// 供注册单元测试调用，防止各领域注册时写错前缀或漏掉幂等要求。
    pub fn validate(self) -> Result<(), &'static str> {
        let prefix = self.domain.prefix();
        if !self.id.starts_with(prefix) {
            return Err("operation id 必须以领域前缀开头");
        }
        if !self.resource_kind.starts_with(prefix) {
            return Err("resource_kind 必须以领域前缀开头");
        }
        if self.access == OperationAccess::Write && !self.request_id_required {
            return Err("写操作必须要求 requestId");
        }
        if self.interfaces.is_empty() {
            return Err("操作必须声明至少一个接入接口");
        }
        Ok(())
    }
}

/// 已注册的领域操作汇总（Manifest 与四入口契约测试的唯一来源）。
/// 各领域只维护自己文件里的 `OPERATIONS` 常量，此处按领域拼接；
/// 未注册的领域操作不会出现在 Manifest 中。
static REGISTERED_OPERATIONS: std::sync::LazyLock<Vec<DomainOperationDef>> =
    std::sync::LazyLock::new(|| {
        let mut all = Vec::new();
        let mut push = |defs: &[DomainOperationDef]| {
            for def in defs {
                def.validate()
                    .unwrap_or_else(|err| panic!("领域操作注册非法（{}）：{err}", def.id));
                all.push(*def);
            }
        };
        push(super::novel::OPERATIONS);
        push(super::comic::OPERATIONS);
        all
    });

/// 全部已注册的领域操作（Manifest 与四入口契约测试的唯一来源）。
pub fn all_operations() -> &'static [DomainOperationDef] {
    &REGISTERED_OPERATIONS
}

/// 按操作 ID 精确查找。
pub fn find_operation(id: &str) -> Option<&'static DomainOperationDef> {
    REGISTERED_OPERATIONS.iter().find(|op| op.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_kind_maps_project_kind_explicitly() {
        assert_eq!(DomainKind::parse("development"), Some(DomainKind::Development));
        assert_eq!(DomainKind::parse("general"), Some(DomainKind::General));
        assert_eq!(DomainKind::parse("novel"), Some(DomainKind::Novel));
        assert_eq!(DomainKind::parse("ai_comic"), Some(DomainKind::Comic));
        assert_eq!(DomainKind::parse("game"), Some(DomainKind::Game));
        // 未知类型不能回退 general
        assert_eq!(DomainKind::parse("unknown"), None);
        assert_eq!(DomainKind::parse("comic"), None);
        assert_eq!(DomainKind::parse(""), None);
    }

    #[test]
    fn operation_def_validation_enforces_prefix_and_idempotency() {
        let good = DomainOperationDef {
            id: "novel.chapter.content.update",
            domain: DomainKind::Novel,
            access: OperationAccess::Write,
            resource_kind: "novel.chapter",
            permission: Capability::ProjectsWrite,
            interfaces: &[Interface::Cli, Interface::Mcp, Interface::Rest, Interface::File],
            revision_required: true,
            request_id_required: true,
            max_payload_bytes: Some(256 * 1024),
        };
        assert!(good.validate().is_ok());

        let mut bad_prefix = good;
        bad_prefix.id = "comic.chapter.content.update";
        assert!(bad_prefix.validate().is_err());

        let mut no_request_id = good;
        no_request_id.request_id_required = false;
        assert!(no_request_id.validate().is_err());

        let mut no_interface = good;
        no_interface.interfaces = &[];
        assert!(no_interface.validate().is_err());
    }

    #[test]
    fn registered_operations_are_valid_and_unique() {
        let ops = all_operations();
        assert!(!ops.is_empty(), "Phase 1 至少注册小说与漫剧操作");
        let mut ids = std::collections::HashSet::new();
        for op in ops {
            op.validate().unwrap_or_else(|err| panic!("{} 非法：{err}", op.id));
            assert!(ids.insert(op.id), "操作 ID 重复：{}", op.id);
        }
        // 只开放 Phase 1 领域；游戏/通用/开发留待后续阶段。
        assert!(ops.iter().all(|op| matches!(
            op.domain,
            DomainKind::Novel | DomainKind::Comic
        )));
    }

    #[test]
    fn phase1_operations_cover_novel_and_comic_workflows() {
        for id in [
            "novel.chapter.list",
            "novel.chapter.content.read",
            "novel.chapter.content.update",
            "comic.shot.list",
            "comic.media.list",
            "comic.media.adopt",
        ] {
            let op = find_operation(id).unwrap_or_else(|| panic!("缺少操作 {id}"));
            assert_eq!(op.domain.as_str(), id.split('.').next().unwrap());
        }
    }
}
