//! 图片另存为的原子写入（导出执行边界）。
//!
//! 覆盖授权来自调用方的显式布尔参数，但授权不是系统保存对话框给的：系统对话框只负责
//! 选路径，前端在目标已存在时先经应用内确认框取得授权，才传 `overwrite=true`。
//! 本模块只负责“拿到授权后如何安全地写”：
//!
//! - 未授权：`create_new` 原子排他创建，目标已存在即冲突，绝不截断既有文件；
//! - 授权：同目录临时文件写满、校验长度后再 `rename` 替换（Windows 走
//!   `MoveFileExW(REPLACE_EXISTING)`）；替换失败（占用/只读/权限）时原文件完整保留，
//!   临时文件清理干净。
//!
//! 不做「先 exists() 再 write()」：检查与写入之间的竞态会静默覆盖用户文件。
//!
//! 失败清理只作用于本次 `create_new` 创建的文件对象：Windows 上通过句柄设置
//! delete-on-close，而不是「关闭句柄后按路径 remove_file」——后者在句柄释放到删除之间
//! 若路径被其他进程替换，会误删对方的新文件。设置失败时宁可不清理，也不回退成按路径删除。

use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// 将 PNG 字节写入 `target`，返回写入的字节数。
///
/// - `overwrite=false`：原子排他创建；目标已存在返回 `AppError::Conflict`，
///   既有文件内容保持不变。
/// - `overwrite=true`：先写同目录临时文件 `.{filename}.{uuid}.tmp` 并校验长度，
///   再 `rename` 到目标；替换失败时目标文件保持原样，临时文件不残留。
///
/// 公共前置校验：空数据、空/相对/非 `.png` 路径、父目录不存在（或不是目录）、
/// 目标是目录都会被拒绝。
pub fn save_png_bytes(target: &Path, bytes: &[u8], overwrite: bool) -> AppResult<u64> {
    if bytes.is_empty() {
        return Err(AppError::Validation("图片数据为空，拒绝写入".into()));
    }
    validate_target(target)?;
    let parent = target.parent().ok_or_else(|| {
        AppError::Validation(format!("保存路径没有父目录：{}", target.display()))
    })?;
    if !parent.is_dir() {
        return Err(AppError::NotFound(format!(
            "目标目录不存在：{}",
            parent.display()
        )));
    }
    if target.is_dir() {
        return Err(AppError::Validation(format!(
            "保存路径是目录，无法写入：{}",
            target.display()
        )));
    }
    if overwrite {
        write_replace(target, parent, bytes)
    } else {
        write_new(target, bytes)
    }
}

/// 路径形态校验（命令层已用 `validate_save_path` 校验一次，这里在执行边界再校验一次，
/// 防止绕过命令层直接调用本模块时写出错误格式）。
fn validate_target(target: &Path) -> AppResult<()> {
    if target.as_os_str().is_empty() {
        return Err(AppError::Validation("保存路径为空".into()));
    }
    if !target.is_absolute() {
        return Err(AppError::Validation("保存路径必须是绝对路径".into()));
    }
    match target.extension().and_then(|e| e.to_str()) {
        Some(ext) if ext.eq_ignore_ascii_case("png") => Ok(()),
        _ => Err(AppError::Validation(
            "保存路径必须以 .png 结尾（存储格式为 PNG）".into(),
        )),
    }
}

/// 排他创建文件。
///
/// Windows 上额外申请 `DELETE` 权限，仅用于失败时做句柄级删除；创建语义
/// （`create_new` 原子裁定“不存在才创建”）不变。
#[cfg(windows)]
fn create_new_file(path: &Path) -> std::io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{DELETE, FILE_GENERIC_WRITE};

    // `write(true)` 是 std 的前置校验（create_new 必须伴随写/追加语义），实际访问权限
    // 由 access_mode 覆盖为 FILE_GENERIC_WRITE | DELETE。
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .access_mode(FILE_GENERIC_WRITE | DELETE)
        .open(path)
}

#[cfg(not(windows))]
fn create_new_file(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

/// 失败清理：只删除本次调用通过 `create_new` 创建的那个文件对象。
///
/// Windows 用 `SetFileInformationByHandle(FileDispositionInfo)` 在**句柄上**标记
/// delete-on-close，删除对象由文件对象而非路径标识：即使失败后路径已被其他进程
/// 替换，也不会误删对方的新文件。标记失败时不回退到按路径删除（`path` 只用于日志），
/// 宁可留下一个半成品，也不承担删除用户/他人文件的风险。
#[cfg(windows)]
fn cleanup_created_file(file: File, path: &Path) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        SetFileInformationByHandle, FileDispositionInfo, FILE_DISPOSITION_INFO,
    };

    let info = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: 句柄来自本函数独占持有的 `file`，在 `SetFileInformationByHandle` 返回前
    // 保持有效；`FILE_DISPOSITION_INFO` 的布局与 Win32 定义一致（单字节布尔），
    // 缓冲区大小按该结构体自身大小传入，指针在调用期间有效。
    let ok = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE,
            FileDispositionInfo,
            &info as *const FILE_DISPOSITION_INFO as *const core::ffi::c_void,
            std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    };
    if ok == 0 {
        tracing::warn!(
            "图片保存失败后的句柄级清理未生效，保留文件不动：{}（{}）",
            path.display(),
            std::io::Error::last_os_error()
        );
    }
    drop(file);
}

#[cfg(not(windows))]
fn cleanup_created_file(file: File, path: &Path) {
    drop(file);
    let _ = std::fs::remove_file(path);
}

/// 未授权分支：`create_new` 保证“不存在才创建”由文件系统原子裁定。
fn write_new(target: &Path, bytes: &[u8]) -> AppResult<u64> {
    let mut file = match create_new_file(target) {
        Ok(f) => f,
        Err(e) => return Err(map_create_error(target, e)),
    };
    // 从这里开始目标文件由本次调用独占创建：失败时只清理这个文件对象。
    if let Err(e) = write_all_sync(&mut file, bytes) {
        cleanup_created_file(file, target);
        return Err(map_write_error(target, e));
    }
    Ok(bytes.len() as u64)
}

/// 授权分支：同目录临时文件写满 + 长度校验后 rename 替换。
fn write_replace(target: &Path, parent: &Path, bytes: &[u8]) -> AppResult<u64> {
    let tmp = temp_path(parent, target)?;
    let mut file = match create_new_file(&tmp) {
        Ok(f) => f,
        Err(e) => return Err(map_write_error(&tmp, e)),
    };
    if let Err(e) = write_all_sync(&mut file, bytes) {
        cleanup_created_file(file, &tmp);
        return Err(map_write_error(&tmp, e));
    }
    // 落盘长度必须与请求一致；不一致说明写入被截断，宁可不替换。
    // 在句柄关闭前校验，失败时才能做句柄级清理而不是按路径删除。
    match file.metadata() {
        Ok(meta) if meta.len() == bytes.len() as u64 => {}
        Ok(meta) => {
            let message = format!(
                "临时文件长度校验失败（写入 {} 字节，期望 {} 字节）：{}",
                meta.len(),
                bytes.len(),
                tmp.display()
            );
            cleanup_created_file(file, &tmp);
            return Err(AppError::Io(std::io::Error::new(ErrorKind::InvalidData, message)));
        }
        Err(e) => {
            cleanup_created_file(file, &tmp);
            return Err(map_write_error(&tmp, e));
        }
    }
    drop(file);
    match std::fs::rename(&tmp, target) {
        Ok(()) => Ok(bytes.len() as u64),
        Err(e) => {
            // Windows MoveFileExW(REPLACE_EXISTING)：目标被占用/只读/权限不足会失败，
            // 此时原文件没有被截断，只需清掉临时文件。临时名含随机 UUID 且由本次
            // create_new 独占创建，句柄已关闭后按路径清理不会被外部替换利用。
            let _ = std::fs::remove_file(&tmp);
            Err(AppError::Io(std::io::Error::new(
                e.kind(),
                format!(
                    "替换失败（目标可能被占用、只读或无权限）：{}：{}",
                    target.display(),
                    e
                ),
            )))
        }
    }
}

/// 同目录唯一临时文件名 `.{filename}.{uuid}.tmp`（与目标同卷，rename 才是原子替换）。
fn temp_path(parent: &Path, target: &Path) -> AppResult<PathBuf> {
    let name = target
        .file_name()
        .ok_or_else(|| AppError::Validation(format!("保存路径缺少文件名：{}", target.display())))?;
    Ok(parent.join(format!(
        ".{}.{}.tmp",
        name.to_string_lossy(),
        uuid::Uuid::new_v4().simple()
    )))
}

/// 写满 + 刷盘：返回错误由调用方决定清理策略。
fn write_all_sync(file: &mut File, bytes: &[u8]) -> std::io::Result<()> {
    file.write_all(bytes)?;
    file.flush()?;
    file.sync_all()
}

fn map_create_error(target: &Path, err: std::io::Error) -> AppError {
    match err.kind() {
        ErrorKind::AlreadyExists => {
            AppError::Conflict(format!("目标文件已存在，未覆盖：{}", target.display()))
        }
        ErrorKind::NotFound => {
            let dir = target
                .parent()
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            AppError::NotFound(format!("目标目录不存在：{}", dir))
        }
        ErrorKind::PermissionDenied => AppError::Io(std::io::Error::new(
            ErrorKind::PermissionDenied,
            format!(
                "写入失败（无权限访问目标文件）：{}：{}",
                target.display(),
                err
            ),
        )),
        _ => map_write_error(target, err),
    }
}

fn map_write_error(target: &Path, err: std::io::Error) -> AppError {
    AppError::Io(std::io::Error::new(
        err.kind(),
        format!("写入失败（{}）：{}", target.display(), err),
    ))
}

#[cfg(test)]
mod tests {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Barrier};

    use super::*;

    /// 独立的临时目录（temp_dir + uuid），Drop 时只清理本次创建的这一份。
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "task-dock-export-{}-{}-{}",
                tag,
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&path).expect("创建测试临时目录");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }

        fn join(&self, name: &str) -> PathBuf {
            self.path.join(name)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            force_remove_dir_all(&self.path);
        }
    }

    /// 递归清理只读属性后删除目录；只用于测试自己创建的目录。
    fn force_remove_dir_all(dir: &Path) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    force_remove_dir_all(&path);
                } else {
                    make_writable(&path);
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        let _ = std::fs::remove_dir(dir);
    }

    fn make_writable(path: &Path) {
        if let Ok(meta) = std::fs::metadata(path) {
            let mut perms = meta.permissions();
            if perms.readonly() {
                perms.set_readonly(false);
                let _ = std::fs::set_permissions(path, perms);
            }
        }
    }

    /// 生成带有 PNG 文件头的确定性字节（测试不依赖解码，只验证写入/替换语义）。
    fn png_bytes(seed: u8, len: usize) -> Vec<u8> {
        let mut out = vec![
            0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x49, 0x48, 0x44, 0x52,
        ];
        for i in 0..len.saturating_sub(out.len()) {
            out.push(seed.wrapping_add((i % 251) as u8));
        }
        out
    }

    fn digest(path: &Path) -> u64 {
        let bytes = std::fs::read(path).expect("读取文件用于哈希");
        let mut hasher = DefaultHasher::new();
        bytes.hash(&mut hasher);
        hasher.finish()
    }

    /// 目录中残留的临时文件（`.xxx.tmp`）。
    fn tmp_leftovers(dir: &Path) -> Vec<String> {
        let mut leftovers = Vec::new();
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') && name.ends_with(".tmp") {
                    leftovers.push(name);
                }
            }
        }
        leftovers
    }

    #[test]
    fn save_new_png_succeeds_and_returns_len() {
        let dir = TempDir::new("new");
        let target = dir.join("clip.png");
        let bytes = png_bytes(0x11, 300);
        let written = save_png_bytes(&target, &bytes, false).expect("新建保存应成功");
        assert_eq!(written, bytes.len() as u64);
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
        assert!(tmp_leftovers(dir.path()).is_empty(), "新建分支不应留下临时文件");
    }

    #[test]
    fn save_new_refuses_existing_file_and_keeps_hash() {
        let dir = TempDir::new("existing");
        let target = dir.join("clip.png");
        let original = png_bytes(0x22, 128);
        std::fs::write(&target, &original).unwrap();
        let before = digest(&target);

        let err = save_png_bytes(&target, &png_bytes(0x33, 256), false).expect_err("不得覆盖");
        match err {
            AppError::Conflict(msg) => {
                assert!(msg.contains("目标文件已存在，未覆盖"), "冲突文案: {msg}");
                assert!(
                    msg.contains(&target.display().to_string()),
                    "冲突文案应包含路径: {msg}"
                );
            }
            other => panic!("已存在目标应返回 Conflict，实际: {other:?}"),
        }
        assert_eq!(digest(&target), before, "未授权失败后原文件哈希必须不变");
        assert_eq!(std::fs::read(&target).unwrap(), original);
    }

    #[test]
    fn save_new_rejects_target_created_right_before_call() {
        // 目标在调用前的“检查窗口”内出现（本实现没有 exists() 预检查，
        // 由 create_new 原子裁定），同样不得被覆盖。
        let dir = TempDir::new("appeared");
        let target = dir.join("clip.png");
        std::fs::write(&target, b"pre-existing-user-file").unwrap();
        let before = digest(&target);

        let err = save_png_bytes(&target, &png_bytes(0x44, 64), false).expect_err("不得覆盖");
        assert!(matches!(err, AppError::Conflict(_)), "实际: {err:?}");
        assert_eq!(digest(&target), before, "既有文件必须保持字节级不变");
    }

    #[test]
    fn save_overwrite_replaces_existing_content() {
        let dir = TempDir::new("overwrite");
        let target = dir.join("clip.png");
        std::fs::write(&target, png_bytes(0x55, 900)).unwrap();
        let new_bytes = png_bytes(0x66, 4096);

        let written = save_png_bytes(&target, &new_bytes, true).expect("授权覆盖应成功");
        assert_eq!(written, new_bytes.len() as u64);
        assert_eq!(std::fs::read(&target).unwrap(), new_bytes, "覆盖后内容应为新字节");
        assert!(
            tmp_leftovers(dir.path()).is_empty(),
            "覆盖成功后不得残留临时文件: {:?}",
            tmp_leftovers(dir.path())
        );
    }

    #[test]
    fn save_overwrite_creates_missing_target() {
        let dir = TempDir::new("overwrite-missing");
        let target = dir.join("new.png");
        let bytes = png_bytes(0x77, 200);
        let written = save_png_bytes(&target, &bytes, true).expect("目标不存在时应创建");
        assert_eq!(written, bytes.len() as u64);
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
        assert!(tmp_leftovers(dir.path()).is_empty());
    }

    #[test]
    fn save_overwrite_readonly_target_fails_without_damage() {
        let dir = TempDir::new("readonly");
        let target = dir.join("clip.png");
        let original = png_bytes(0x88, 512);
        std::fs::write(&target, &original).unwrap();
        let before = digest(&target);
        let mut perms = std::fs::metadata(&target).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&target, perms).unwrap();

        let result = save_png_bytes(&target, &png_bytes(0x99, 1024), true);
        // 先恢复可写，避免后续断言失败时清理受阻（Drop 也会兜底）。
        make_writable(&target);

        assert!(result.is_err(), "只读目标上的覆盖必须报错: {result:?}");
        assert_eq!(digest(&target), before, "替换失败后原文件哈希必须不变");
        assert_eq!(std::fs::read(&target).unwrap(), original);
        assert!(
            tmp_leftovers(dir.path()).is_empty(),
            "替换失败后不得残留临时文件: {:?}",
            tmp_leftovers(dir.path())
        );
    }

    #[test]
    fn save_rejects_empty_bytes() {
        let dir = TempDir::new("empty-bytes");
        let target = dir.join("clip.png");
        let err = save_png_bytes(&target, &[], false).expect_err("空图片数据必须拒绝");
        assert!(matches!(err, AppError::Validation(_)), "实际: {err:?}");
        assert!(!target.exists(), "拒绝时不得创建目标文件");
        assert!(tmp_leftovers(dir.path()).is_empty());
    }

    #[test]
    fn save_rejects_empty_relative_and_non_png_paths() {
        let bytes = png_bytes(0xaa, 32);
        for bad in ["", "   "] {
            let err = save_png_bytes(Path::new(bad), &bytes, false).expect_err("空路径必须拒绝");
            assert!(matches!(err, AppError::Validation(_)), "{bad:?} 实际: {err:?}");
        }
        for bad in ["clip.png", r"out\clip.png"] {
            let err = save_png_bytes(Path::new(bad), &bytes, true).expect_err("相对路径必须拒绝");
            assert!(matches!(err, AppError::Validation(_)), "{bad:?} 实际: {err:?}");
        }
        let dir = TempDir::new("bad-ext");
        for name in ["clip.jpg", "clip", "clip.png.txt"] {
            let target = dir.join(name);
            let err = save_png_bytes(&target, &bytes, false).expect_err("非 .png 必须拒绝");
            assert!(matches!(err, AppError::Validation(_)), "{name} 实际: {err:?}");
            assert!(!target.exists());
        }
        // .PNG 大写应被接受（与命令层大小写不敏感规则一致）。
        let upper = dir.join("UPPER.PNG");
        save_png_bytes(&upper, &bytes, false).expect(".PNG 大写扩展名应允许");
    }

    #[test]
    fn save_rejects_missing_parent_dir_with_not_found() {
        let dir = TempDir::new("missing-parent");
        let target = dir.join("no-such-dir").join("clip.png");
        let err = save_png_bytes(&target, &png_bytes(0xbb, 16), false)
            .expect_err("父目录不存在应报错");
        match err {
            AppError::NotFound(msg) => {
                assert!(msg.contains("目标目录不存在"), "文案: {msg}");
                assert!(
                    msg.contains(&dir.join("no-such-dir").display().to_string()),
                    "文案应包含缺失目录: {msg}"
                );
            }
            other => panic!("应返回 NotFound，实际: {other:?}"),
        }
        // 父路径是文件（不是目录）同样拒绝。
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, b"x").unwrap();
        let err = save_png_bytes(&blocker.join("clip.png"), &png_bytes(0xcc, 16), true)
            .expect_err("父路径是文件应报错");
        assert!(matches!(err, AppError::NotFound(_)), "实际: {err:?}");
    }

    #[test]
    fn save_rejects_directory_target() {
        let dir = TempDir::new("dir-target");
        let target = dir.join("clip.png");
        std::fs::create_dir(&target).unwrap();
        let err = save_png_bytes(&target, &png_bytes(0xdd, 64), true).expect_err("目标是目录应拒绝");
        assert!(matches!(err, AppError::Validation(_)), "实际: {err:?}");
        assert!(target.is_dir(), "拒绝时不得删除/替换目录");
        assert!(tmp_leftovers(dir.path()).is_empty());
    }

    #[test]
    fn concurrent_create_without_overwrite_has_exactly_one_winner() {
        let dir = TempDir::new("race-create");
        let target = dir.join("clip.png");
        let payloads = [png_bytes(0xe0, 1024), png_bytes(0xe1, 2048)];
        let barrier = Arc::new(Barrier::new(3));

        let mut handles = Vec::new();
        for payload in payloads.iter().cloned() {
            let target = target.clone();
            let barrier = Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                save_png_bytes(&target, &payload, false)
            }));
        }
        barrier.wait();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();

        let ok_count = results.iter().filter(|r| r.is_ok()).count();
        let conflict_count = results
            .iter()
            .filter(|r| matches!(r, Err(AppError::Conflict(_))))
            .count();
        assert_eq!(ok_count, 1, "并发无授权创建必须恰好一个成功: {results:?}");
        assert_eq!(
            conflict_count, 1,
            "另一个线程必须得到 Conflict（不得覆盖）: {results:?}"
        );
        // 最终文件内容必须完整等于成功者的字节。
        let final_bytes = std::fs::read(&target).unwrap();
        assert!(
            final_bytes == payloads[0] || final_bytes == payloads[1],
            "最终文件应是完整的一份写入"
        );
        assert!(tmp_leftovers(dir.path()).is_empty());
    }

    /// 失败清理动作本身：删除的是本次 create_new 创建的文件对象。
    ///
    /// 触发真实的 write_all/flush/sync_all 失败需要制造磁盘级错误（本机不可控），
    /// 因此这里直接覆盖写失败时执行的清理函数；生产路径与测试共用同一个函数。
    #[test]
    fn failure_cleanup_removes_file_created_by_this_call() {
        let dir = TempDir::new("cleanup-own");
        let target = dir.join("clip.png");
        let mut file = create_new_file(&target).expect("排他创建");
        file.write_all(b"partial").expect("写入半成品");
        cleanup_created_file(file, &target);
        assert!(!target.exists(), "失败清理后本次创建的目标文件不得残留");
        assert!(tmp_leftovers(dir.path()).is_empty());
    }

    /// 句柄释放与删除之间路径被替换时，清理不得误删替换者的新文件。
    #[test]
    #[cfg(windows)]
    fn failure_cleanup_deletes_by_handle_not_by_path() {
        let dir = TempDir::new("cleanup-race");
        let target = dir.join("clip.png");
        let moved = dir.join("created-by-us.png");
        let mut file = create_new_file(&target).expect("排他创建");
        file.write_all(b"partial").expect("写入半成品");

        // 模拟：清理前其他进程把本次创建的文件移走，并在同一路径放入自己的新文件。
        std::fs::rename(&target, &moved).expect("移动仍打开的本次文件");
        let replacement = png_bytes(0xfe, 96);
        std::fs::write(&target, &replacement).expect("替换者写入新文件");
        let before = digest(&target);

        cleanup_created_file(file, &target);

        assert!(
            target.exists(),
            "路径上的新文件不属于本次调用，清理不得删除它"
        );
        assert_eq!(digest(&target), before, "替换者文件必须字节级不变");
        assert_eq!(std::fs::read(&target).unwrap(), replacement);
        assert!(!moved.exists(), "本次创建的文件对象应被句柄级删除");
    }

    /// 句柄缺少 DELETE 权限导致句柄级清理失败时，不得回退成按路径删除。
    #[test]
    #[cfg(windows)]
    fn failure_cleanup_without_delete_access_keeps_file_intact() {
        let dir = TempDir::new("cleanup-denied");
        let target = dir.join("clip.png");
        let original = png_bytes(0xfd, 64);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .expect("不带 DELETE 权限创建");
        file.write_all(&original).expect("写入半成品");
        let before = digest(&target);

        cleanup_created_file(file, &target);

        assert!(target.exists(), "清理失败时不得按路径删除文件");
        assert_eq!(digest(&target), before, "清理失败不得改动文件内容");
    }

    #[test]
    fn concurrent_overwrite_leaves_complete_file() {
        let dir = TempDir::new("race-overwrite");
        let target = dir.join("clip.png");
        std::fs::write(&target, png_bytes(0xf0, 64)).unwrap();
        let payloads = [png_bytes(0xf1, 3000), png_bytes(0xf2, 7000)];
        let barrier = Arc::new(Barrier::new(3));

        let mut handles = Vec::new();
        for payload in payloads.iter().cloned() {
            let target = target.clone();
            let barrier = Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                save_png_bytes(&target, &payload, true)
            }));
        }
        barrier.wait();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert!(
            results.iter().all(|r| r.is_ok()),
            "并发授权覆盖都应成功: {results:?}"
        );

        let final_bytes = std::fs::read(&target).unwrap();
        assert!(
            final_bytes == payloads[0] || final_bytes == payloads[1],
            "并发覆盖后最终文件必须是完整的一份写入（不能是半截/交错）"
        );
        assert!(tmp_leftovers(dir.path()).is_empty(), "并发覆盖不得残留临时文件");
    }
}
