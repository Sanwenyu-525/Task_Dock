//! 开发工作台支撑层（v48）：只读 git 探测与敏感内容扫描。
//!
//! 数据边界：
//! - 本层不做任何写操作（git 探测全部只读，不落库、不缓存）；
//! - 扫描输出只含位置与类型，绝不包含命中原文（凭证内容不进入日志/事件/库）。

pub mod git;
pub mod secrets;

#[cfg(test)]
mod tests {
    /// 两个子模块各自带真实可跑的测试；这里只保证模块公开面可从 crate 内引用。
    #[test]
    fn submodules_are_reachable() {
        // 常量路径检查：不实际执行探测，只验证类型与函数签名存在。
        let _probe: fn(&str) -> crate::devwork::git::DevGitInfo = crate::devwork::git::probe;
        let _scan: fn(&[String]) -> crate::devwork::secrets::ScanOutcome =
            crate::devwork::secrets::scan;
    }
}
