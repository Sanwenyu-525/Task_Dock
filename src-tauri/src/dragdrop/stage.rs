//! 暂存区的磁盘部分：**只有**虚拟文件字节与图片字节会落到这里。
//!
//! 生命周期（谁建、谁删）：
//! - 建：真实 `Drop` 通过后才 `DragDropState::begin` 建目录，`enter`/`over`
//!   绝不建目录（否则每次鼠标移动都会留下垃圾）；
//! - 删：提交成功/失败、放弃、过期回收、进程退出、启动时清扫遗留目录；
//! - 命名：目录名是 `operation_id`（UUID），文件名经过 `names` 清洗，
//!   绝不使用来源给的路径，因此不存在路径穿越；
//! - 写入一律 `*.part` → `sync` → 原子改名，中断只会留下可回收的 `.part`。

use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

use super::names::sanitize_file_name;
use super::MAX_STAGE_OPS;

/// 暂存目录前缀内的临时后缀。
const PART_SUFFIX: &str = "taskdock-part";

/// `AppError::Io` 只接受 `std::io::Error`，这里统一把自定义消息包一层。
fn io_error(message: String) -> AppError {
    AppError::Io(std::io::Error::new(std::io::ErrorKind::Other, message))
}

/// 创建本次会话的暂存目录。
pub fn ensure_dir(dir: &Path) -> AppResult<()> {
    std::fs::create_dir_all(dir)
        .map_err(|e| io_error(format!("无法创建暂存目录: {e}")))
}

/// 递归删除本次会话的暂存目录（失败只记 warn，不影响业务结果）。
pub fn remove_dir(dir: &Path) {
    if !dir.exists() {
        return;
    }
    match std::fs::remove_dir_all(dir) {
        Ok(()) => {}
        Err(e) => tracing::warn!("暂存目录清理失败: {e}"),
    }
}

/// 原子写入一段字节（图片/小文件），返回最终路径。
pub fn write_bytes(dir: &Path, name: &str, bytes: &[u8]) -> AppResult<PathBuf> {
    ensure_dir(dir)?;
    // 防御性再清洗一次：调用方理应已清洗，但这层不依赖调用方的自觉。
    let safe_name = sanitize_file_name(name, "拖入文件");
    let dest = dir.join(&safe_name);
    let part = dir.join(format!(
        ".{safe_name}.{}.{PART_SUFFIX}",
        uuid::Uuid::new_v4()
    ));
    if let Err(e) = std::fs::write(&part, bytes) {
        let _ = std::fs::remove_file(&part);
        return Err(io_error(format!("暂存写入失败: {e}")));
    }
    if let Err(e) = std::fs::rename(&part, &dest) {
        let _ = std::fs::remove_file(&part);
        return Err(io_error(format!("暂存提交失败: {e}")));
    }
    Ok(dest)
}

/// 为一个虚拟文件创建目标路径（内容由调用方流式写入同一 `.part`，
/// 完成后调用 [`finalize`]）。
pub fn open_part(dir: &Path, name: &str) -> AppResult<(PathBuf, std::fs::File)> {
    ensure_dir(dir)?;
    let safe_name = sanitize_file_name(name, "附件");
    let part = dir.join(format!(
        ".{safe_name}.{}.{PART_SUFFIX}",
        uuid::Uuid::new_v4()
    ));
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&part)
        .map_err(|e| io_error(format!("无法创建暂存文件: {e}")))?;
    Ok((part, file))
}

/// 把 `.part` 原子改名为最终文件。
pub fn finalize(part: &Path, dest: &Path) -> AppResult<()> {
    std::fs::rename(part, dest).map_err(|e| {
        let _ = std::fs::remove_file(part);
        io_error(format!("暂存提交失败: {e}"))
    })
}

/// 清理某个 `.part`（失败路径必须调用，避免半边文件被误当完整文件）。
pub fn drop_part(part: &Path) {
    if part
        .file_name()
        .map(|n| n.to_string_lossy().ends_with(PART_SUFFIX))
        .unwrap_or(false)
    {
        let _ = std::fs::remove_file(part);
    }
}

/// 清扫暂存根目录下的遗留项：只删除「不是当前活跃会话、且不是 `.part` 之外的
/// 未知文件」的目录，绝不递归删除来路不明的路径。
///
/// 单次清扫是 O(目录项) 且只在真实 drop / 启动时执行，不做常驻轮询。
pub fn sweep_orphans(root: &Path, active_ids: &[String]) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let active: Vec<&str> = active_ids.iter().map(|s| s.as_str()).collect();
    let mut seen_ops = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            // 根目录下不应出现文件；只清理本模块自己的 `.part` 残留。
            if path
                .file_name()
                .map(|n| n.to_string_lossy().ends_with(PART_SUFFIX))
                .unwrap_or(false)
            {
                let _ = std::fs::remove_file(&path);
            }
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if active.contains(&name) {
            seen_ops += 1;
            continue;
        }
        // 只认「UUID 形状的会话目录」；其它目录可能是用户的，不碰。
        if uuid::Uuid::try_parse(name).is_err() {
            continue;
        }
        remove_dir(&path);
    }
    // 超过上限时最老的在 `DragDropState::begin` 里已经淘汰，这里无需再动手。
    let _ = (seen_ops, MAX_STAGE_OPS);
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("taskdock-stage-{}", uuid::Uuid::new_v4())))
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn 原子写入后可读回内容() {
        let tmp = TempRoot::new();
        let dir = tmp.path().join("op");
        let got = write_bytes(&dir, "a.txt", b"hello").unwrap();
        assert_eq!(std::fs::read_to_string(&got).unwrap(), "hello");
        // 不残留 .part
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(PART_SUFFIX))
            .collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn 未完成的分片可被清理且不会变成正式文件() {
        let tmp = TempRoot::new();
        let dir = tmp.path().join("op");
        let (part, mut file) = open_part(&dir, "big.bin").unwrap();
        use std::io::Write;
        file.write_all(b"partial").unwrap();
        drop(file);
        drop_part(&part);
        assert!(!part.exists());
        assert!(!dir.join("big.bin").exists());
    }

    #[test]
    fn 清扫只删除_uuid_形状的非活跃目录() {
        let tmp = TempRoot::new();
        std::fs::create_dir_all(tmp.path()).unwrap();
        let active = uuid::Uuid::new_v4().to_string();
        let stale = uuid::Uuid::new_v4().to_string();
        std::fs::create_dir_all(tmp.path().join(&active)).unwrap();
        std::fs::create_dir_all(tmp.path().join(&stale)).unwrap();
        // 用户自己的目录（不是 UUID）不得被删
        std::fs::create_dir_all(tmp.path().join("用户目录")).unwrap();
        sweep_orphans(tmp.path(), &[active.clone()]);
        assert!(tmp.path().join(&active).exists(), "活跃会话必须保留");
        assert!(!tmp.path().join(&stale).exists(), "过期会话目录应被清除");
        assert!(
            tmp.path().join("用户目录").exists(),
            "不认识的目录绝不能删"
        );
    }

    #[test]
    fn 清扫根目录下的分片残留() {
        let tmp = TempRoot::new();
        std::fs::create_dir_all(tmp.path()).unwrap();
        let part = tmp.path().join(format!("x.{}.taskdock-part", uuid::Uuid::new_v4()));
        std::fs::write(&part, b"x").unwrap();
        sweep_orphans(tmp.path(), &[]);
        assert!(!part.exists());
    }
}
