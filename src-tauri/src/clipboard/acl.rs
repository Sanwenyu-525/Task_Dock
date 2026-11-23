//! 剪贴板数据目录 ACL 加固（ADR-0012 批次 9）。
//!
//! 目标：不依赖 `%APPDATA%` 的继承权限，把剪贴板相关数据显式限制为
//! 「当前 Windows 用户 + BUILTIN\\Administrators」可读写，并保护 DACL
//! 不被父目录继承 ACE 重新放宽。
//!
//! 边界：
//! - 只处理本机 NTFS/ReFS 等支持 ACL 的文件系统；FAT/网络盘失败时只计数并告警；
//! - 不跟随符号链接/junction，避免把外部目录纳入加固或误改其它项目；
//! - 不改变文件 owner，不处理管理员取得所有权等 Windows 模型固有风险。

use std::path::Path;

/// 一次启动加固的计数；失败不阻塞应用启动，但必须可观测。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct AclReport {
    pub applied: usize,
    pub skipped: usize,
    pub failed: usize,
    /// 只保留首个 Win32/IO 错误码，不记录具体用户路径。
    pub first_error: Option<String>,
}

impl AclReport {
    pub fn ok(&self) -> bool {
        self.failed == 0
    }
}

/// 加固剪贴板相关数据目录。
///
/// 覆盖：
/// 1. `data_dir` 根（设置可继承的受限 DACL，保护后续新建文件/目录）；
/// 2. `clipboard/`（正文密文、图片资产、transient 明文副本）；
/// 3. `clipboard-exports/`（Agent 导出明文包）；
/// 4. `backups/`（含剪贴板段的备份包）；
/// 5. `restore/`（恢复 staging）；
/// 6. `shelf/`（可能包含剪贴板快照）；
/// 7. `task-dock.db` 与 `-wal`/`-shm`（剪贴板历史所在库文件）。
///
/// 已存在目录递归处理；不存在的路径跳过。非 Windows 返回空报告。
pub fn harden_clipboard_storage(data_dir: &Path) -> AclReport {
    #[cfg(windows)]
    {
        imp::harden(data_dir)
    }
    #[cfg(not(windows))]
    {
        let _ = data_dir;
        AclReport::default()
    }
}

#[cfg(windows)]
mod imp {
    use super::AclReport;
    use std::ffi::{c_void, OsStr};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::MetadataExt;
    use std::path::Path;
    use std::ptr;

    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree, HANDLE, HLOCAL};
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSidToSidW, SetNamedSecurityInfoW, SE_FILE_OBJECT,
    };
    use windows_sys::Win32::Security::{
        AddAccessAllowedAceEx, GetLengthSid, GetTokenInformation, InitializeAcl, ACL,
        ACCESS_ALLOWED_ACE, ACL_REVISION, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION,
        OBJECT_INHERIT_ACE, PROTECTED_DACL_SECURITY_INFORMATION, PSID, TOKEN_QUERY, TOKEN_USER,
        TokenUser,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ALL_ACCESS, FILE_ATTRIBUTE_REPARSE_POINT,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// 需要递归加固的、可能承载剪贴板内容或明文派生物的目录。
    const PRIVATE_SUBDIRS: &[&str] = &[
        "clipboard",
        "clipboard-exports",
        "clipboard-backups",
        "backups",
        "restore",
        "shelf",
    ];

    /// SQLite 主库与 WAL/SHM；WAL 可能包含尚未 checkpoint 的明文页。
    const PRIVATE_FILES: &[&str] = &[
        "task-dock.db",
        "task-dock.db-wal",
        "task-dock.db-shm",
        "task-dock.db-journal",
    ];

    struct ExplicitDacl {
        buffer: Vec<u64>,
    }

    impl ExplicitDacl {
        fn build(sids: &[Vec<u8>], directory: bool) -> Result<Self, String> {
            let ace_flags = if directory {
                OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
            } else {
                0
            };
            let ace_size: usize = sids
                .iter()
                .map(|sid| {
                    std::mem::size_of::<ACCESS_ALLOWED_ACE>() - std::mem::size_of::<u32>()
                        + sid.len()
                })
                .sum();
            let acl_len = std::mem::size_of::<ACL>() + ace_size;
            let words = acl_len.div_ceil(8);
            let mut buffer = vec![0u64; words];
            let byte_len = (words * 8) as u32;
            unsafe {
                let acl = buffer.as_mut_ptr() as *mut ACL;
                if InitializeAcl(acl, byte_len, ACL_REVISION) == 0 {
                    return Err(format!("InitializeAcl 失败，Win32 错误 {}", GetLastError()));
                }
                for sid in sids {
                    if AddAccessAllowedAceEx(
                        acl,
                        ACL_REVISION,
                        ace_flags,
                        FILE_ALL_ACCESS,
                        sid.as_ptr() as PSID,
                    ) == 0
                    {
                        return Err(format!(
                            "AddAccessAllowedAceEx 失败，Win32 错误 {}",
                            GetLastError()
                        ));
                    }
                }
            }
            Ok(Self { buffer })
        }

        fn as_ptr(&self) -> *const ACL {
            self.buffer.as_ptr() as *const ACL
        }
    }

    struct Applier<'a> {
        dir_acl: &'a ExplicitDacl,
        file_acl: &'a ExplicitDacl,
        report: AclReport,
    }

    impl Applier<'_> {
        fn apply(&mut self, path: &Path, directory: bool) {
            let wide = wide_path(path);
            let acl = if directory {
                self.dir_acl.as_ptr()
            } else {
                self.file_acl.as_ptr()
            };
            let result = unsafe {
                SetNamedSecurityInfoW(
                    wide.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    acl,
                    ptr::null_mut(),
                )
            };
            if result == 0 {
                self.report.applied += 1;
            } else {
                self.report.failed += 1;
                self.report
                    .first_error
                    .get_or_insert_with(|| format!("SetNamedSecurityInfoW 失败，Win32 错误 {result}"));
            }
        }

        fn walk(&mut self, path: &Path, directory: bool) {
            self.apply(path, directory);
            if !directory {
                return;
            }
            let entries = match std::fs::read_dir(path) {
                Ok(entries) => entries,
                Err(err) => {
                    self.report.failed += 1;
                    let message = format!(
                        "读取目录失败，IO 错误 {}",
                        err.raw_os_error().unwrap_or_default()
                    );
                    self.report.first_error.get_or_insert(message);
                    return;
                }
            };
            for entry in entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(err) => {
                        self.report.failed += 1;
                        let message = format!(
                            "读取目录项失败，IO 错误 {}",
                            err.raw_os_error().unwrap_or_default()
                        );
                        self.report.first_error.get_or_insert(message);
                        continue;
                    }
                };
                let path = entry.path();
                let metadata = match std::fs::symlink_metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(err) => {
                        self.report.failed += 1;
                        let message = format!(
                            "读取文件属性失败，IO 错误 {}",
                            err.raw_os_error().unwrap_or_default()
                        );
                        self.report.first_error.get_or_insert(message);
                        continue;
                    }
                };
                // 不跟随符号链接与 junction：目标可能在其它用户目录/项目之外。
                if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    self.report.skipped += 1;
                    continue;
                }
                self.walk(&path, metadata.is_dir());
            }
        }
    }

    pub(super) fn harden(data_dir: &Path) -> AclReport {
        if !data_dir.is_dir() {
            return AclReport {
                failed: 1,
                first_error: Some("数据目录不存在或不是目录".into()),
                ..AclReport::default()
            };
        }
        let user = match current_user_sid_bytes() {
            Ok(sid) => sid,
            Err(err) => return failed_report(err),
        };
        let admin = match well_known_sid_bytes("S-1-5-32-544") {
            Ok(sid) => sid,
            Err(err) => return failed_report(err),
        };
        let mut sids = vec![user];
        if !same_sid(&sids[0], &admin) {
            sids.push(admin);
        }
        let dir_acl = match ExplicitDacl::build(&sids, true) {
            Ok(acl) => acl,
            Err(err) => return failed_report(err),
        };
        let file_acl = match ExplicitDacl::build(&sids, false) {
            Ok(acl) => acl,
            Err(err) => return failed_report(err),
        };

        let mut applier = Applier {
            dir_acl: &dir_acl,
            file_acl: &file_acl,
            report: AclReport::default(),
        };
        // 根只设置自身 DACL；递归范围限定到剪贴板相关目录，避免启动时扫描整个数据目录。
        applier.apply(data_dir, true);
        for name in PRIVATE_SUBDIRS {
            let path = data_dir.join(name);
            if path.is_dir() {
                applier.walk(&path, true);
            } else {
                applier.report.skipped += 1;
            }
        }
        for name in PRIVATE_FILES {
            let path = data_dir.join(name);
            if path.is_file() {
                applier.walk(&path, false);
            } else {
                applier.report.skipped += 1;
            }
        }
        applier.report
    }

    fn failed_report(error: String) -> AclReport {
        AclReport {
            failed: 1,
            first_error: Some(error),
            ..AclReport::default()
        }
    }

    fn wide_path(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn same_sid(left: &[u8], right: &[u8]) -> bool {
        left == right
    }

    fn current_user_sid_bytes() -> Result<Vec<u8>, String> {
        unsafe {
            let process = GetCurrentProcess();
            let mut token: HANDLE = ptr::null_mut();
            if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
                return Err(format!("OpenProcessToken 失败，Win32 错误 {}", GetLastError()));
            }
            let mut needed: u32 = 0;
            let _ = GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut needed);
            if needed == 0 {
                CloseHandle(token);
                return Err("GetTokenInformation(TokenUser) 返回零长度".into());
            }
            // TOKEN_USER 含指针字段，按 8 字节对齐分配。
            let words = (needed as usize).div_ceil(8);
            let mut buffer = vec![0u64; words];
            let ok = GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr() as *mut c_void,
                (words * 8) as u32,
                &mut needed,
            );
            CloseHandle(token);
            if ok == 0 {
                return Err(format!(
                    "GetTokenInformation(TokenUser) 失败，Win32 错误 {}",
                    GetLastError()
                ));
            }
            let token_user = &*(buffer.as_ptr() as *const TOKEN_USER);
            sid_bytes(token_user.User.Sid)
        }
    }

    fn well_known_sid_bytes(value: &str) -> Result<Vec<u8>, String> {
        let wide: Vec<u16> = OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            let mut sid: PSID = ptr::null_mut();
            if ConvertStringSidToSidW(wide.as_ptr(), &mut sid) == 0 {
                return Err(format!(
                    "ConvertStringSidToSidW({value}) 失败，Win32 错误 {}",
                    GetLastError()
                ));
            }
            let bytes = sid_bytes(sid);
            LocalFree(sid as HLOCAL);
            bytes
        }
    }

    unsafe fn sid_bytes(sid: PSID) -> Result<Vec<u8>, String> {
        if sid.is_null() {
            return Err("SID 为空".into());
        }
        let len = unsafe { GetLengthSid(sid) } as usize;
        if len == 0 {
            return Err("GetLengthSid 返回零".into());
        }
        Ok(unsafe { std::slice::from_raw_parts(sid as *const u8, len) }.to_vec())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::path::PathBuf;
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{
            GetNamedSecurityInfoW, SE_FILE_OBJECT,
        };
        use windows_sys::Win32::Security::{
            GetAce, GetAclInformation, GetSecurityDescriptorControl,
            ACCESS_ALLOWED_ACE, ACL_SIZE_INFORMATION, AclSizeInformation,
            DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SE_DACL_PROTECTED,
        };

        fn temp_data_dir() -> PathBuf {
            let dir = std::env::temp_dir().join(format!(
                "td-clipboard-acl-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(dir.join("clipboard/images")).unwrap();
            std::fs::create_dir_all(dir.join("backups")).unwrap();
            std::fs::write(dir.join("clipboard/images/a.png"), b"png").unwrap();
            std::fs::write(dir.join("backups/b.json"), b"{}").unwrap();
            std::fs::write(dir.join("task-dock.db"), b"db").unwrap();
            dir
        }

        fn read_dacl(path: &Path) -> (bool, Vec<Vec<u8>>) {
            let wide = wide_path(path);
            let mut dacl: *mut ACL = ptr::null_mut();
            let mut sd: PSECURITY_DESCRIPTOR = ptr::null_mut();
            let result = unsafe {
                GetNamedSecurityInfoW(
                    wide.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    &mut dacl,
                    ptr::null_mut(),
                    &mut sd,
                )
            };
            assert_eq!(result, 0, "GetNamedSecurityInfoW 失败: {result}");
            let mut control: u16 = 0;
            let mut revision: u32 = 0;
            assert_eq!(
                unsafe { GetSecurityDescriptorControl(sd, &mut control, &mut revision) },
                1
            );
            let mut info = ACL_SIZE_INFORMATION::default();
            assert_eq!(
                unsafe {
                    GetAclInformation(
                        dacl,
                        &mut info as *mut _ as *mut c_void,
                        std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                        AclSizeInformation,
                    )
                },
                1
            );
            let mut sids = Vec::new();
            for index in 0..info.AceCount {
                let mut ace: *mut c_void = ptr::null_mut();
                assert_eq!(unsafe { GetAce(dacl, index, &mut ace) }, 1);
                let allowed = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
                let sid = &allowed.SidStart as *const u32 as PSID;
                let sid_len = unsafe { GetLengthSid(sid) } as usize;
                sids.push(unsafe { std::slice::from_raw_parts(sid as *const u8, sid_len) }.to_vec());
            }
            unsafe { LocalFree(sd as HLOCAL) };
            (control & SE_DACL_PROTECTED != 0, sids)
        }

        #[test]
        fn harden_sets_protected_current_user_and_admin_dacl_recursively() {
            let data = temp_data_dir();
            let report = harden(&data);
            assert_eq!(report.failed, 0, "{:?}", report);
            assert!(report.applied >= 7, "{:?}", report);

            let user = current_user_sid_bytes().unwrap();
            let admin = well_known_sid_bytes("S-1-5-32-544").unwrap();
            for path in [
                data.clone(),
                data.join("clipboard"),
                data.join("clipboard/images"),
                data.join("clipboard/images/a.png"),
                data.join("backups"),
                data.join("backups/b.json"),
                data.join("task-dock.db"),
            ] {
                let (protected, sids) = read_dacl(&path);
                assert!(protected, "DACL 必须为 protected: {}", path.display());
                assert_eq!(sids.len(), 2, "只应保留当前用户+管理员: {}", path.display());
                assert!(sids.iter().any(|sid| sid == &user));
                assert!(sids.iter().any(|sid| sid == &admin));
            }
            std::fs::remove_dir_all(data).ok();
        }

        #[test]
        fn harden_is_idempotent_and_skips_missing_paths() {
            let data = temp_data_dir();
            let first = harden(&data);
            let second = harden(&data);
            assert_eq!(first, second);
            assert_eq!(second.failed, 0, "{:?}", second);
            assert!(second.skipped >= 3);
            std::fs::remove_dir_all(data).ok();
        }
    }
}
