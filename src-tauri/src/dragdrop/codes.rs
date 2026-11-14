//! 拖入通道的稳定错误码与分类。
//!
//! 口径与既有诊断/错误体系一致（`error::ErrorCategory` 的字符串取值）：
//! 前端按 `code` 做机读分类，诊断中心按 `error_code`/`error_category` 聚合。
//! 新增码只在这里定义，不在调用点写字面量。

/// 系统提供的格式里没有任何可读内容（例如只有私有格式、加密对象）。
pub const DRAG_FORMAT_UNSUPPORTED: &str = "DRAG_FORMAT_UNSUPPORTED";
/// 收到了拖入事件，但所有候选格式都读不出数据（GetData 全部失败/为空）。
pub const DRAG_NO_READABLE_CONTENT: &str = "DRAG_NO_READABLE_CONTENT";
/// 数据对象本身不合法（空指针、格式描述异常、描述符无法解析）。
pub const DRAG_PAYLOAD_INVALID: &str = "DRAG_PAYLOAD_INVALID";
/// 图片字节存在但解码失败（魔数不符、DIB 头非法、PNG 损坏）。
pub const DRAG_IMAGE_DECODE_FAILED: &str = "DRAG_IMAGE_DECODE_FAILED";
/// 虚拟文件流读取失败（流为空、中途 IO 错误、超时）。
pub const DRAG_VIRTUAL_FILE_READ_FAILED: &str = "DRAG_VIRTUAL_FILE_READ_FAILED";
/// 描述符里有这一项，但 `FileContents` 给不出对应索引（`lindex` 不匹配/缺失）。
///
/// 与「读取失败」分开：这通常意味着来源的 `FileGroupDescriptorW` 与
/// `FileContents` 不一致，重试无意义，用户需要知道是**来源**只给了一部分。
pub const DRAG_VIRTUAL_INDEX_INVALID: &str = "DRAG_VIRTUAL_INDEX_INVALID";
/// 来源只提供内存块（`TYMED_HGLOBAL`）且超过安全读取上限。
///
/// 内存块必须在 `Drop` 回调内整块复制，无法像 `IStream` 那样流式写盘；
/// 超过上限时明确拒绝，**不**假装支持到虚拟文件的 2GB 上限。
pub const DRAG_MEMORY_CONTENT_TOO_LARGE: &str = "DRAG_MEMORY_CONTENT_TOO_LARGE";
/// 单次拖入的虚拟文件条数超过 `MAX_ITEMS`。
///
/// 与「大小超限」分开：这是条数上限，不是字节/像素上限。
pub const DRAG_TOO_MANY_ITEMS: &str = "DRAG_TOO_MANY_ITEMS";
/// 远端获取被安全策略拒绝（内网地址/重定向/非白名单协议）。
///
/// **保留码**：本轮不实现自动下载，任何来源都不会走到这里；
/// 保留是为了让未来的受控导入有稳定契约，而不是临时新编号。
pub const DRAG_REMOTE_FETCH_DENIED: &str = "DRAG_REMOTE_FETCH_DENIED";
/// 远端获取失败（网络错误/超时/响应超限）。同上，本轮保留。
pub const DRAG_REMOTE_FETCH_FAILED: &str = "DRAG_REMOTE_FETCH_FAILED";
/// 超过大小/条数/像素上限。
pub const DRAG_SIZE_LIMIT_EXCEEDED: &str = "DRAG_SIZE_LIMIT_EXCEEDED";
/// 目标目录不可用、无写权限、磁盘空间不足。
pub const DRAG_PERMISSION_DENIED: &str = "DRAG_PERMISSION_DENIED";
/// 目标卡片已删除/目录不存在。
pub const DRAG_TARGET_UNAVAILABLE: &str = "DRAG_TARGET_UNAVAILABLE";
/// 原生接收桥安装失败（或未安装）——此时只有 Tauri 内置的路径拖入可用。
pub const DRAG_NATIVE_BRIDGE_FAILED: &str = "DRAG_NATIVE_BRIDGE_FAILED";
/// 原生接收桥只接管了部分窗口（其余窗口仍拿不到富内容）。
pub const DRAG_NATIVE_BRIDGE_PARTIAL: &str = "DRAG_NATIVE_BRIDGE_PARTIAL";
/// 后端持久化/落盘失败。
pub const DRAG_COMMIT_FAILED: &str = "DRAG_COMMIT_FAILED";
/// 暂存会话不存在、已过期或已被消费（重复提交）。
pub const DRAG_OPERATION_EXPIRED: &str = "DRAG_OPERATION_EXPIRED";
/// 会话已受理，但后台仍在读取内容：可稍后重试，不是永久失败。
pub const DRAG_PAYLOAD_PENDING: &str = "DRAG_PAYLOAD_PENDING";

/// 全部已定义码（用于「从错误文本提取稳定码」与完整覆盖测试）。
pub const ALL: &[&str] = &[
    DRAG_FORMAT_UNSUPPORTED,
    DRAG_NO_READABLE_CONTENT,
    DRAG_PAYLOAD_INVALID,
    DRAG_IMAGE_DECODE_FAILED,
    DRAG_VIRTUAL_FILE_READ_FAILED,
    DRAG_VIRTUAL_INDEX_INVALID,
    DRAG_MEMORY_CONTENT_TOO_LARGE,
    DRAG_TOO_MANY_ITEMS,
    DRAG_REMOTE_FETCH_DENIED,
    DRAG_REMOTE_FETCH_FAILED,
    DRAG_SIZE_LIMIT_EXCEEDED,
    DRAG_PERMISSION_DENIED,
    DRAG_TARGET_UNAVAILABLE,
    DRAG_NATIVE_BRIDGE_FAILED,
    DRAG_NATIVE_BRIDGE_PARTIAL,
    DRAG_COMMIT_FAILED,
    DRAG_OPERATION_EXPIRED,
    DRAG_PAYLOAD_PENDING,
];

/// 是否为已定义的拖入错误码。
///
/// 命令层用它从 `AppError` 文本里取出稳定码：`commit` 层以
/// `DRAG_*：说明` 的形式表达语义，诊断中心才能按码聚合，
/// 而不是只看到通用的 `CONFLICT`/`NOT_FOUND`。
pub fn is_known(code: &str) -> bool {
    ALL.contains(&code)
}

/// 错误码 → 诊断分类字符串。
pub fn category(code: &str) -> &'static str {
    match code {
        DRAG_FORMAT_UNSUPPORTED | DRAG_NO_READABLE_CONTENT => "unsupported",
        DRAG_PAYLOAD_INVALID
        | DRAG_IMAGE_DECODE_FAILED
        | DRAG_VIRTUAL_FILE_READ_FAILED
        | DRAG_VIRTUAL_INDEX_INVALID
        | DRAG_MEMORY_CONTENT_TOO_LARGE
        | DRAG_TOO_MANY_ITEMS
        | DRAG_PAYLOAD_PENDING
        | DRAG_SIZE_LIMIT_EXCEEDED => "validation",
        DRAG_PERMISSION_DENIED => "permission",
        DRAG_TARGET_UNAVAILABLE | DRAG_OPERATION_EXPIRED => "not_found",
        DRAG_REMOTE_FETCH_DENIED => "permission",
        DRAG_REMOTE_FETCH_FAILED
        | DRAG_NATIVE_BRIDGE_FAILED
        | DRAG_NATIVE_BRIDGE_PARTIAL
        | DRAG_COMMIT_FAILED => "io",
        _ => "unknown",
    }
}

/// 给用户看的一句话（不含路径、不含内容）。
pub fn message(code: &str) -> &'static str {
    match code {
        DRAG_FORMAT_UNSUPPORTED => "此来源的数据格式暂不支持",
        DRAG_NO_READABLE_CONTENT => "来源没有提供可读取的内容",
        DRAG_PAYLOAD_INVALID => "拖入的数据不完整",
        DRAG_IMAGE_DECODE_FAILED => "图片数据无法解码",
        DRAG_VIRTUAL_FILE_READ_FAILED => "虚拟文件读取失败",
        DRAG_VIRTUAL_INDEX_INVALID => "来源没有提供该序号的虚拟文件",
        DRAG_MEMORY_CONTENT_TOO_LARGE => "来源只提供内存数据，超过安全读取上限",
        DRAG_TOO_MANY_ITEMS => "虚拟文件数量超过单次上限",
        DRAG_REMOTE_FETCH_DENIED => "已拒绝从该地址获取内容",
        DRAG_REMOTE_FETCH_FAILED => "从来源地址获取内容失败",
        DRAG_SIZE_LIMIT_EXCEEDED => "内容超过大小上限",
        DRAG_PERMISSION_DENIED => "没有写入目标目录的权限",
        DRAG_TARGET_UNAVAILABLE => "目标目录不可用",
        DRAG_NATIVE_BRIDGE_FAILED => "原生拖入接收不可用（部分窗口可能完全收不到拖入）",
        DRAG_NATIVE_BRIDGE_PARTIAL => "部分窗口未能接管拖入接收",
        DRAG_COMMIT_FAILED => "保存失败",
        DRAG_OPERATION_EXPIRED => "这次拖入已结束，请重新拖一次",
        DRAG_PAYLOAD_PENDING => "拖入内容仍在读取，请稍后重试",
        _ => "拖入失败",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 每个错误码都有分类与文案() {
        for code in ALL {
            assert_ne!(category(code), "unknown", "{code} 缺少分类");
            assert!(!message(code).is_empty(), "{code} 缺少文案");
            assert!(is_known(code), "{code} 未登记进 ALL");
        }
        assert!(!is_known("DRAG_NOT_A_REAL_CODE"));
    }
}
