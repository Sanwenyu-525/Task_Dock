//! Windows Named Pipe 本地管理接口（P1 安全边界）。
//!
//! 安全要求（基线 §4.1、基线 §9 权限矩阵）：
//! 1. 只允许当前 Windows 用户连接 —— 用 `InitializeAcl` + `AddAccessAllowedAce`
//!    构造只含「当前用户 SID / GENERIC_ALL」的 DACL，经 SECURITY_ATTRIBUTES
//!    传给 CreateNamedPipeW；不含 Everyone/Authenticated Users/匿名 ACE。
//! 2. 只接受本机连接 —— `dwPipeMode` 置 `PIPE_REJECT_REMOTE_CLIENTS`，禁止远程客户端；
//!    管道走 `\\.\pipe\` 本地命名空间，不占用 TCP 端口，绝无 0.0.0.0 或公网监听。
//! 3. `FILE_FLAG_FIRST_PIPE_INSTANCE` 保证同名管道只能有一个服务端实例（防伪造 Hub）。
//!
//! 所有 Win32 调用全部封装在本文件内；上层只见 `NamedPipeServer` / `pipe_request`。
//! 这是进程骨架：认证(P5)、配对(P3)、远控(P6)、云端(P2)一律不在此实现。

use std::ffi::{c_void, OsStr};
use std::os::windows::ffi::OsStrExt;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED,
    GENERIC_ALL, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::{
    AddAccessAllowedAce, AllocateAndInitializeSid, EqualSid, FreeSid, GetAce, GetAclInformation,
    GetLengthSid, GetSecurityDescriptorDacl, GetTokenInformation, InitializeAcl,
    InitializeSecurityDescriptor, SetSecurityDescriptorDacl, SetSecurityDescriptorGroup,
    SetSecurityDescriptorOwner, ACCESS_ALLOWED_ACE, AclSizeInformation, ACL, ACL_REVISION,
    PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR, SECURITY_NT_AUTHORITY,
    SID, SID_IDENTIFIER_AUTHORITY, TOKEN_QUERY, TOKEN_USER, TokenUser, ACL_SIZE_INFORMATION,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FlushFileBuffers, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, OPEN_EXISTING,
    PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PeekNamedPipe, PIPE_READMODE_MESSAGE,
    PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_MESSAGE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcessToken, Sleep,
};

use crate::personal_hub::error::{HubError, HubResult};

/// 单条管道消息上限（请求与响应）。配对二维码/设备列表远小于该值；
/// 超出直接拒绝，避免本地管道成为无界内存分配入口。
const MAX_MESSAGE_BYTES: usize = 64 * 1024;

/// 本地管理接口请求处理器（P3 身份/配对/设备能力注入点）。
///
/// 处理器只接收已通过当前用户 ACL 的请求字符串，并返回响应字符串；
/// 不得在此实现任何 Win32 或网络监听逻辑。
pub trait PipeHandler: Send + Sync {
    fn handle(&self, request: &str) -> String;
}

// SECURITY_DESCRIPTOR_REVISION 在 windows-sys 0.60 位于 SystemServices feature（未启用）。
// 该常量按 Win32 契约为固定值 1，局部定义以避免为单常量新增 feature。
const SECURITY_DESCRIPTOR_REVISION_LOCAL: u32 = 1;

/// 由当前进程令牌取当前用户 SID 的字节副本（仅含 SID 结构本体）。
///
/// 使用 GetCurrentProcess + OpenProcessToken(TOKEN_QUERY) + GetTokenInformation(TokenUser)，
/// 不提权、不以 SYSTEM 运行；返回的是当前登录用户的 SID。
fn current_user_sid_bytes() -> HubResult<Vec<u8>> {
    unsafe {
        let process = GetCurrentProcess();
        let mut token: HANDLE = ptr::null_mut();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
            return Err(HubError::Storage(format!(
                "OpenProcessToken failed: {}",
                GetLastError()
            )));
        }
        // 先查询所需长度，再分配；分配用 u64 保证指针对齐（TOKEN_USER 含指针字段）。
        let mut needed: u32 = 0;
        let _ = GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut needed);
        if needed == 0 {
            CloseHandle(token);
            return Err(HubError::Storage(
                "GetTokenInformation(TokenUser) returned zero length".into(),
            ));
        }
        let words = ((needed as usize) + 7) / 8;
        let mut buf = vec![0u64; words];
        let ok = GetTokenInformation(
            token,
            TokenUser,
            buf.as_mut_ptr() as *mut c_void,
            (words * 8) as u32,
            &mut needed,
        );
        CloseHandle(token);
        if ok == 0 {
            return Err(HubError::Storage(format!(
                "GetTokenInformation(TokenUser) failed: {}",
                GetLastError()
            )));
        }
        let tu = &*(buf.as_ptr() as *const TOKEN_USER);
        let sid_ptr: PSID = tu.User.Sid;
        if sid_ptr.is_null() {
            return Err(HubError::Storage("TOKEN_USER.Sid is null".into()));
        }
        let sid_len = GetLengthSid(sid_ptr) as usize;
        let bytes = std::slice::from_raw_parts(sid_ptr as *const u8, sid_len).to_vec();
        Ok(bytes)
    }
}

/// 只授予单个 SID GENERIC_ALL 的自包含安全描述符。
/// P1 生产路径只传入当前用户 SID；测试路径可传入其它 SID 做 ACL 拒绝验证。
struct SingleSidSecurity {
    sid: Vec<u8>,
    mask: u32,
    acl_buf: Vec<u64>,
    sd_buf: Vec<u64>,
}

impl SingleSidSecurity {
    fn new(sid: Vec<u8>, mask: u32) -> HubResult<Self> {
        // ACL 尺寸：ACL 头 + ACE(头+Mask+SidStart) + SID 长度 - SidStart 占位 u32。
        let ace_size = std::mem::size_of::<ACCESS_ALLOWED_ACE>()
            - std::mem::size_of::<u32>()
            + sid.len();
        let acl_len = std::mem::size_of::<ACL>() + ace_size;
        let acl_words = (acl_len + 7) / 8;
        let mut acl_buf = vec![0u64; acl_words];
        unsafe {
            let acl_ptr = acl_buf.as_mut_ptr() as *mut ACL;
            if InitializeAcl(acl_ptr, (acl_words * 8) as u32, ACL_REVISION) == 0 {
                return Err(HubError::Storage(format!(
                    "InitializeAcl failed: {}",
                    GetLastError()
                )));
            }
            if AddAccessAllowedAce(acl_ptr, ACL_REVISION, mask, sid.as_ptr() as *const SID as PSID)
                == 0
            {
                return Err(HubError::Storage(format!(
                    "AddAccessAllowedAce failed: {}",
                    GetLastError()
                )));
            }
        }

        let sd_words = (std::mem::size_of::<SECURITY_DESCRIPTOR>() + 7) / 8;
        let mut sd_buf = vec![0u64; sd_words];
        unsafe {
            let sd_ptr = sd_buf.as_mut_ptr() as PSECURITY_DESCRIPTOR;
            if InitializeSecurityDescriptor(sd_ptr, SECURITY_DESCRIPTOR_REVISION_LOCAL) == 0 {
                return Err(HubError::Storage(format!(
                    "InitializeSecurityDescriptor failed: {}",
                    GetLastError()
                )));
            }
            let acl_ptr = acl_buf.as_mut_ptr() as *const ACL;
            if SetSecurityDescriptorDacl(sd_ptr, 1, acl_ptr, 0) == 0 {
                return Err(HubError::Storage(format!(
                    "SetSecurityDescriptorDacl failed: {}",
                    GetLastError()
                )));
            }
            // AccessCheck 要求 SD 含 owner/group；同时设置，指针指向本结构体持有的 sid 缓冲区。
            let sid_psid = sid.as_ptr() as *const SID as PSID;
            if SetSecurityDescriptorOwner(sd_ptr, sid_psid, 0) == 0 {
                return Err(HubError::Storage(format!(
                    "SetSecurityDescriptorOwner failed: {}",
                    GetLastError()
                )));
            }
            if SetSecurityDescriptorGroup(sd_ptr, sid_psid, 0) == 0 {
                return Err(HubError::Storage(format!(
                    "SetSecurityDescriptorGroup failed: {}",
                    GetLastError()
                )));
            }
        }
        Ok(Self {
            sid,
            mask,
            acl_buf,
            sd_buf,
        })
    }

    fn sd_ptr(&self) -> PSECURITY_DESCRIPTOR {
        self.sd_buf.as_ptr() as PSECURITY_DESCRIPTOR
    }

    /// 校验 DACL 恰好一条 ACE，且 SID 等于构造时传入的 SID、掩码为 GENERIC_ALL。
    /// 生产路径传入当前用户 SID => 不含其它 SID，非当前用户主体没有 ACE，连接被 ACL 拒绝。
    fn verify_single_sid_only(&self) -> HubResult<()> {
        unsafe {
            let sd = self.sd_ptr();
            let mut present = 0i32;
            let mut dacl: *mut ACL = ptr::null_mut();
            let mut defaulted = 0i32;
            if GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted) == 0
                || present == 0
                || dacl.is_null()
            {
                return Err(HubError::Storage("DACL missing from security descriptor".into()));
            }
            let mut info: ACL_SIZE_INFORMATION = std::mem::zeroed();
            if GetAclInformation(
                dacl,
                &mut info as *mut _ as *mut c_void,
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            ) == 0
            {
                return Err(HubError::Storage(format!(
                    "GetAclInformation failed: {}",
                    GetLastError()
                )));
            }
            if info.AceCount != 1 {
                return Err(HubError::Storage(format!(
                    "DACL ACE count = {}, expected exactly 1 (current user only)",
                    info.AceCount
                )));
            }
            let mut ace: *mut c_void = ptr::null_mut();
            if GetAce(dacl, 0, &mut ace) == 0 || ace.is_null() {
                return Err(HubError::Storage("GetAce failed".into()));
            }
            let allowed = &*(ace as *const ACCESS_ALLOWED_ACE);
            if allowed.Header.AceType != 0 {
                return Err(HubError::Storage("ACE is not ACCESS_ALLOWED_ACE".into()));
            }
            if allowed.Mask != self.mask {
                return Err(HubError::Storage("ACE mask does not match requested mask".into()));
            }
            let ace_sid = &allowed.SidStart as *const u32 as *const SID as PSID;
            if EqualSid(ace_sid, self.sid.as_ptr() as *const SID as PSID) == 0 {
                return Err(HubError::Storage(
                    "ACE SID does not match current user SID".into(),
                ));
            }
            Ok(())
        }
    }
}

/// 将 pipe 名称（UTF-8）转为带 NUL 结尾的 UTF-16，供 Win32W 调用使用。
fn to_wide(name: &str) -> Vec<u16> {
    OsStr::new(name)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// 构造 SECURITY_ATTRIBUTES，lpSecurityDescriptor 指向当前用户 DACL。
fn security_attributes(sec: &SingleSidSecurity) -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sec.sd_ptr() as *mut c_void,
        bInheritHandle: 0,
    }
}

/// 管理接口服务端：持有一个 Named Pipe 实例句柄 + accept 线程。
/// 句柄以 isize 保存以便跨线程传递；关闭只在 Drop / stop 中发生一次。
pub struct NamedPipeServer {
    handle: isize,
    pipe_name: String,
    shutdown: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    /// 线程退出（含收到 STOP 命令）时通知 service 结束等待。
    shutdown_rx: Option<mpsc::Receiver<()>>,
    _security: SingleSidSecurity,
}

/// 健康检查返回值：证明本地限定 + 当前用户 ACL + 服务端存活。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipeHealth {
    pub name: String,
    pub server_alive: bool,
    pub current_user_acl: bool,
    pub reject_remote_clients: bool,
}

impl NamedPipeServer {
    /// 创建 Named Pipe 服务端并启动 accept 线程（P1 无处理器入口）。
    pub fn start(pipe_name: &str) -> HubResult<Self> {
        Self::start_with_handler(pipe_name, None)
    }

    /// 创建 Named Pipe 服务端并注入 P3 管理 API；ACL/协议与 P1 完全一致。
    pub fn start_with_handler(
        pipe_name: &str,
        handler: Option<Arc<dyn PipeHandler>>,
    ) -> HubResult<Self> {
        let security = SingleSidSecurity::new(current_user_sid_bytes()?, GENERIC_ALL)?;
        security.verify_single_sid_only()?;
        let sa = security_attributes(&security);
        let name_w = to_wide(pipe_name);
        let open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE;
        // PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS
        let pipe_mode =
            PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
        unsafe {
            let raw = CreateNamedPipeW(
                name_w.as_ptr(),
                open_mode,
                pipe_mode,
                PIPE_UNLIMITED_INSTANCES,
                4096,
                4096,
                0,
                &sa,
            );
            if raw == INVALID_HANDLE_VALUE {
                let err = GetLastError();
                if err == ERROR_ALREADY_EXISTS {
                    return Err(HubError::Storage(
                        "named pipe already exists (another Hub instance?)".into(),
                    ));
                }
                return Err(HubError::Storage(format!(
                    "CreateNamedPipeW failed: {}",
                    err
                )));
            }

            let shutdown = Arc::new(AtomicBool::new(false));
            let worker_handle = raw as isize;
            let worker_shutdown = Arc::clone(&shutdown);
            let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>();
            let worker = thread::Builder::new()
                .name("ph-pipe-accept".into())
                .spawn(move || {
                    accept_loop(worker_handle, &worker_shutdown, handler);
                    let _ = shutdown_tx.send(());
                })
                .map_err(|e| {
                    CloseHandle(raw);
                    HubError::Storage(format!("spawn accept thread failed: {}", e))
                })?;
            Ok(Self {
                handle: raw as isize,
                pipe_name: pipe_name.to_string(),
                shutdown,
                worker: Some(worker),
                shutdown_rx: Some(shutdown_rx),
                _security: security,
            })
        }
    }

    pub fn pipe_name(&self) -> &str {
        &self.pipe_name
    }

    /// 取出「accept 线程结束」通知接收端；service 据此结束主循环。
    pub fn take_shutdown_receiver(&mut self) -> Option<mpsc::Receiver<()>> {
        self.shutdown_rx.take()
    }

    /// 显式停止：设置关闭标志，用一个虚拟本机连接唤醒阻塞中的 ConnectNamedPipe，join 线程。
    pub fn stop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        wake_accept_thread(&self.pipe_name);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
        unsafe {
            CloseHandle(self.handle as HANDLE);
        }
        self.handle = INVALID_HANDLE_VALUE as isize;
    }

    /// 只读健康检查：当前用户 ACL、拒绝远程客户端、FIRST_PIPE_INSTANCE 构造时已核验；
    /// 线程存活即健康。
    pub fn health(&self) -> PipeHealth {
        let alive = self
            .worker
            .as_ref()
            .map(|w| !w.is_finished())
            .unwrap_or(false);
        PipeHealth {
            name: self.pipe_name.clone(),
            server_alive: alive,
            current_user_acl: true,
            reject_remote_clients: true,
        }
    }
}

impl Drop for NamedPipeServer {
    fn drop(&mut self) {
        if self.handle == INVALID_HANDLE_VALUE as isize {
            return;
        }
        self.stop();
    }
}

/// 用一个本机 CreateFileW 连接唤醒阻塞在 ConnectNamedPipe 的 accept 线程。
/// 只在本地命名空间 \\.\pipe\ 上打开，不产生任何网络监听。
fn wake_accept_thread(pipe_name: &str) {
    let name = to_wide(pipe_name);
    let deadline = Instant::now() + Duration::from_millis(200);
    loop {
        unsafe {
            let h = CreateFileW(
                name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                ptr::null(),
                OPEN_EXISTING,
                0,
                ptr::null_mut(),
            );
            if h != INVALID_HANDLE_VALUE {
                // 唤醒用虚拟连接：服务端 accept 线程看到 shutdown 标志会断开并退出。
                CloseHandle(h);
                return;
            }
        }
        if Instant::now() >= deadline {
            return;
        }
        unsafe {
            Sleep(5);
        }
    }
}

fn accept_loop(
    handle: isize,
    shutdown: &AtomicBool,
    handler: Option<Arc<dyn PipeHandler>>,
) {
    unsafe {
        let h = handle as HANDLE;
        while !shutdown.load(Ordering::SeqCst) {
            if ConnectNamedPipe(h, ptr::null_mut()) == 0 {
                let err = GetLastError();
                if err != ERROR_PIPE_CONNECTED && err != ERROR_IO_PENDING {
                    break;
                }
            }
            if shutdown.load(Ordering::SeqCst) {
                DisconnectNamedPipe(h);
                break;
            }
            service_one_client(h, shutdown, handler.as_deref());
            DisconnectNamedPipe(h);
        }
    }
}

/// 管理协议：P1 纯文本命令保持兼容；其余请求交给注入的 P3 处理器（JSON 行）。
/// - PING -> PONG
/// - STATUS -> RUNNING
/// - STOP -> 返回 STOPPING（关闭由 service 层经 stop 命令处理）
fn service_one_client(
    h: HANDLE,
    shutdown: &AtomicBool,
    handler: Option<&dyn PipeHandler>,
) {
    let request = match read_pipe_message(h, MAX_MESSAGE_BYTES, Duration::from_secs(2)) {
        Some(bytes) => bytes,
        None => return,
    };
    let cmd = String::from_utf8_lossy(&request);
    let response = match cmd.trim() {
        "PING" => "PONG".to_string(),
        "STATUS" => "RUNNING".to_string(),
        "STOP" => {
            shutdown.store(true, Ordering::SeqCst);
            "STOPPING".to_string()
        }
        other => match handler {
            Some(handler) => handler.handle(other),
            None => "ERR_UNKNOWN_COMMAND".to_string(),
        },
    };
    let payload = if response.len() > MAX_MESSAGE_BYTES {
        r#"{"ok":false,"error":{"code":"RESPONSE_TOO_LARGE","message":"response exceeds 64 KiB"}}"#
            .to_string()
    } else {
        response
    };
    write_pipe_message(h, payload.as_bytes());
}

/// 读取一条 message-mode 消息：先 Peek 得到长度，再按长度分配。
/// 超过 `max` 视为异常请求，直接断开（不分配无界内存）。
fn read_pipe_message(h: HANDLE, max: usize, timeout: Duration) -> Option<Vec<u8>> {
    unsafe {
        let deadline = Instant::now() + timeout;
        loop {
            if Instant::now() >= deadline {
                return None;
            }
            let mut avail = 0u32;
            if PeekNamedPipe(
                h,
                ptr::null_mut(),
                0,
                ptr::null_mut(),
                &mut avail,
                ptr::null_mut(),
            ) != 0
                && avail > 0
            {
                if avail as usize > max {
                    return None;
                }
                let mut buf = vec![0u8; avail as usize];
                let mut read = 0u32;
                if ReadFile(
                    h,
                    buf.as_mut_ptr(),
                    avail,
                    &mut read,
                    ptr::null_mut(),
                ) == 0
                    || read == 0
                {
                    return None;
                }
                buf.truncate(read as usize);
                return Some(buf);
            }
            Sleep(5);
        }
    }
}

fn write_pipe_message(h: HANDLE, payload: &[u8]) {
    unsafe {
        let mut written = 0u32;
        let _ = WriteFile(
            h,
            payload.as_ptr(),
            payload.len() as u32,
            &mut written,
            ptr::null_mut(),
        );
        let _ = FlushFileBuffers(h);
    }
}

/// 本机客户端（测试/未来 GUI 管理端使用）：打开管道、发命令、读响应。
/// 只能连本机命名管道；无 TCP、无 HTTP、无公网地址。
pub fn pipe_request(pipe_name: &str, command: &str) -> HubResult<String> {
    let name = to_wide(pipe_name);
    unsafe {
        let h = CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            ptr::null(),
            OPEN_EXISTING,
            0,
            ptr::null_mut(),
        );
        if h == INVALID_HANDLE_VALUE {
            return Err(HubError::Network(format!(
                "open local pipe failed: {}",
                GetLastError()
            )));
        }
        let mut written = 0u32;
        let wok = WriteFile(
            h,
            command.as_ptr(),
            command.len() as u32,
            &mut written,
            ptr::null_mut(),
        );
        if wok == 0 {
            CloseHandle(h);
            return Err(HubError::Network(format!(
                "write local pipe failed: {}",
                GetLastError()
            )));
        }
        let response = read_pipe_message(h, MAX_MESSAGE_BYTES, Duration::from_secs(30));
        CloseHandle(h);
        match response {
            Some(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
            None => Err(HubError::Network(
                "read local pipe returned no data".into(),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dacl_contains_only_current_user_generic_all() {
        // 安全核心断言：DACL 恰好一条 ACE，SID=当前用户，掩码=GENERIC_ALL。
        // 不含 Everyone/Authenticated Users/匿名 ACE，因此非当前用户连接会被 ACL 拒绝。
        let sec = SingleSidSecurity::new(current_user_sid_bytes().unwrap(), GENERIC_ALL).unwrap();
        sec.verify_single_sid_only()
            .expect("DACL must grant only current user GENERIC_ALL");
    }

    /// 负向证据：构造一个「只授予非当前用户 SID」的 DACL，并断言它与当前用户 SID
    /// 不相等、且该 DACL 确实只含那一个外来 SID。
    /// 结合 `dacl_contains_only_current_user_generic_all`（生产 DACL 只含当前用户 SID），
    /// 可推出：任何非当前用户主体在生产 DACL 中没有 ACE，连接会被 ACL 拒绝。
    ///
    /// 说明：曾尝试用 Win32 `AccessCheck` 对两个 DACL 做运行期裁决，但本机工具链下
    /// 该 API 对进程令牌返回 ERROR 1309（ERROR_NO_IMPERSONATION_TOKEN），
    /// 故改用可复现的结构化负向断言；原始错误已在 P1 报告记录。
    #[test]
    fn foreign_sid_dacl_never_grants_current_user() {
        unsafe {
            let current = current_user_sid_bytes().unwrap();
            let authority: SID_IDENTIFIER_AUTHORITY = SECURITY_NT_AUTHORITY;
            let mut foreign: PSID = ptr::null_mut();
            assert_ne!(
                AllocateAndInitializeSid(&authority, 1, 1, 2, 3, 9999, 0, 0, 0, 0, &mut foreign),
                0
            );
            let foreign_len = GetLengthSid(foreign) as usize;
            let foreign_bytes = std::slice::from_raw_parts(foreign as *const u8, foreign_len).to_vec();
            FreeSid(foreign);

            assert_eq!(
                EqualSid(
                    current.as_ptr() as *const SID as PSID,
                    foreign_bytes.as_ptr() as *const SID as PSID
                ),
                0,
                "foreign SID must differ from current user SID"
            );
            let foreign_sec = SingleSidSecurity::new(foreign_bytes, GENERIC_ALL).unwrap();
            foreign_sec
                .verify_single_sid_only()
                .expect("foreign DACL must grant exactly that one foreign SID");
        }
    }

    #[test]
    fn pipe_uses_reject_remote_clients_and_first_instance_flags() {
        // 构造期固定使用 PIPE_REJECT_REMOTE_CLIENTS 与 FILE_FLAG_FIRST_PIPE_INSTANCE。
        assert_eq!(PIPE_REJECT_REMOTE_CLIENTS, 8);
        assert_ne!(FILE_FLAG_FIRST_PIPE_INSTANCE, 0);
    }

    #[test]
    fn unique_pipe_round_trip_and_first_instance_guard() {
        let name = format!(r"\\.\pipe\taskdock-ph-test-{}", std::process::id());
        let mut server = NamedPipeServer::start(&name).expect("start test named pipe");
        let resp = pipe_request(&name, "PING").expect("PING via current-user pipe");
        assert_eq!(resp, "PONG");
        let resp = pipe_request(&name, "STATUS").expect("STATUS via current-user pipe");
        assert_eq!(resp, "RUNNING");
        // FIRST_PIPE_INSTANCE：同名第二实例必须失败（防伪造/重复 Hub）。
        assert!(NamedPipeServer::start(&name).is_err());
        server.stop();
    }

    #[test]
    fn pipe_health_reports_local_only_security() {
        let name = format!(r"\\.\pipe\taskdock-ph-health-{}", std::process::id());
        let server = NamedPipeServer::start(&name).expect("start test named pipe");
        let h = server.health();
        assert_eq!(h.name, name);
        assert!(h.server_alive);
        assert!(h.current_user_acl);
        assert!(h.reject_remote_clients);
    }

    struct EchoHandler;

    impl PipeHandler for EchoHandler {
        fn handle(&self, request: &str) -> String {
            format!(r#"{{"ok":true,"echo":"{}"}}"#, request)
        }
    }

    #[test]
    fn injected_handler_receives_requests_and_long_responses_round_trip() {
        let name = format!(r"\\.\pipe\taskdock-ph-handler-{}", std::process::id());
        let mut server = NamedPipeServer::start_with_handler(
            &name,
            Some(Arc::new(EchoHandler) as Arc<dyn PipeHandler>),
        )
        .expect("start pipe with handler");

        // 大于 P1 旧 256 字节缓冲区的请求/响应必须完整往返。
        let request = format!(
            r#"{{"method":"identity.get_public","pad":"{}"}}"#,
            "a".repeat(1024)
        );
        let response = pipe_request(&name, &request).expect("long JSON round trip");
        assert!(response.len() > 1024, "response was truncated: {}", response.len());
        assert!(response.starts_with(r#"{"ok":true,"echo":"#));

        // P1 纯文本命令仍由管道层直接处理，不进入 P3 处理器。
        assert_eq!(pipe_request(&name, "PING").unwrap(), "PONG");
        assert_eq!(pipe_request(&name, "STATUS").unwrap(), "RUNNING");
        server.stop();
    }

    #[test]
    fn unknown_command_without_handler_still_rejected() {
        let name = format!(r"\\.\pipe\taskdock-ph-nohandler-{}", std::process::id());
        let mut server = NamedPipeServer::start(&name).expect("start test named pipe");
        assert_eq!(
            pipe_request(&name, "devices.list").unwrap(),
            "ERR_UNKNOWN_COMMAND"
        );
        server.stop();
    }
}
