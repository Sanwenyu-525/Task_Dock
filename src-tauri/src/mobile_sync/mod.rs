//! 手机端配对与局域网连接（v0.16）。
//!
//! 设计边界（对应 docs/mobile/01-architecture.md 与 MOBILE_STACK.md §3）：
//! - 桌面端是配对授权中心：只有用户显式开启「允许手机连接」后才监听局域网 IPv4；
//! - 配对使用**一次性 6 位码 + 120 秒窗口 + 最多 5 次尝试**，成功后签发高熵设备令牌；
//! - 数据库只保存令牌的 SHA-256 哈希，明文令牌只在配对响应里返回一次，绝不写日志；
//! - 本轮传输为局域网 HTTP（用户已确认的 v1 基线），不提供 TLS；威胁模型与后续
//!   TLS/指纹固定计划见验收报告与 docs/mobile/06-pairing.md；
//! - 服务只接受配对与连通性探测（`/v1/ping`），不提供任何业务数据读写；
//! - 撤销设备写 `revoked_at` 软删除，已撤销令牌立即失效；
//! - 所有网络任务可取消：应用退出信号、设置关闭、端口变更都会让监听循环退出。
//!
//! 安全约束：
//! - 牌令牌比较走常量时间；配对码比较同样不使用 `==`；
//! - 请求体上限 4KB、头部读取超时、请求处理超时、连接/在途并发上限；
//! - 日志不记录请求体、配对码、令牌、设备名与精确设备指纹。

use std::net::UdpSocket;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::db::{Db, Settings};
use crate::error::{AppError, AppResult};

pub mod server;
pub mod sync;

/// 协议版本：手机端据此拒绝不兼容的桌面端。
pub const API_VERSION: u32 = 1;
/// 配对码有效期：足够用户扫码/输码，又限制可暴力尝试窗口。
pub const PAIRING_TTL_SECS: u64 = 120;
/// 单个配对会话允许的错误尝试次数；超过后必须重新生成配对码。
pub const MAX_PAIR_ATTEMPTS: u32 = 5;
/// 实例 ID 的内部设置键（不是公开设置键，不进入 ALLOWED_KEYS）。
const INSTANCE_KEY: &str = "mobile_sync_instance_id";
/// 设备名/平台字段的展示上限，防止异常客户端写入超长文本。
const MAX_DEVICE_NAME_CHARS: usize = 64;
const MAX_PLATFORM_CHARS: usize = 32;

/// 共享状态：命令层与 HTTP 监听共用一个实例。
#[derive(Clone)]
pub struct MobileSyncState {
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    session: Option<PairingSession>,
    running: bool,
    bound_port: Option<u16>,
    error: Option<String>,
    server_name: String,
    instance_id: String,
}

struct PairingSession {
    /// 会话 ID：配对请求处理期间若用户取消/重新生成，用于识别过期会话并补偿。
    id: String,
    code: String,
    expires_at: Instant,
    attempts: u32,
    paired: Option<PairedNotice>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PairedNotice {
    pub device_id: String,
    pub name: String,
    pub platform: String,
    pub paired_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MobileDevice {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub created_at: String,
    pub last_seen_at: Option<String>,
    pub last_ip: Option<String>,
    pub revoked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PairingStatus {
    pub code: String,
    pub expires_in_secs: u64,
}

/// `mobile_sync_status` 返回给设置页的完整快照。
#[derive(Debug, Clone, Serialize)]
pub struct MobileSyncStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub lan_ip: Option<String>,
    pub base_url: Option<String>,
    pub server_name: String,
    pub instance_id: String,
    pub fingerprint: String,
    pub error: Option<String>,
    pub pairing: Option<PairingStatus>,
    pub paired_device: Option<PairedNotice>,
    pub devices: Vec<MobileDevice>,
}

/// `mobile_sync_start_pairing` 的响应：桌面端只负责展示，不保存二维码内容。
#[derive(Debug, Clone, Serialize)]
pub struct PairingOffer {
    pub code: String,
    pub expires_in_secs: u64,
    pub lan_ip: String,
    pub port: u16,
    pub server_name: String,
    pub instance_id: String,
    pub fingerprint: String,
    pub qr_payload: String,
}

/// 配对请求（HTTP 层反序列化）。
#[derive(Debug, Deserialize)]
pub struct PairRequest {
    pub code: String,
    #[serde(default)]
    pub device_name: String,
    #[serde(default)]
    pub platform: String,
}

/// 配对成功响应（只在此处返回一次明文令牌）。
#[derive(Debug, Serialize)]
pub struct PairOutcome {
    pub token: String,
    pub device_id: String,
    pub server_name: String,
    pub api_version: u32,
    pub paired_at: String,
}

/// 配对失败分类：HTTP 层映射为稳定错误码与状态码。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairFailure {
    /// 没有活动会话、已过期、已成功使用，或并发取消。
    Closed,
    /// 配对码错误（仍在尝试次数内）。
    InvalidCode,
    /// 尝试次数耗尽或会话被锁定。
    TooManyAttempts,
}

impl MobileSyncState {
    /// 创建状态并确保实例 ID 持久化。实例 ID 只用于二维码里的设备身份展示，
    /// 不是密钥；写入失败时使用临时 ID，配对仍可工作（重启后指纹变化）。
    pub fn new(db: &Db) -> Self {
        let instance_id = load_or_create_instance_id(db);
        let server_name = host_display_name();
        Self {
            inner: Arc::new(Mutex::new(Inner {
                session: None,
                running: false,
                bound_port: None,
                error: None,
                server_name,
                instance_id,
            })),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn clear_session(&self) {
        self.lock().session = None;
    }

    fn set_running(&self, port: u16) {
        let mut inner = self.lock();
        inner.running = true;
        inner.bound_port = Some(port);
        inner.error = None;
    }

    fn set_stopped(&self) {
        let mut inner = self.lock();
        inner.running = false;
        inner.bound_port = None;
        inner.session = None;
    }

    fn set_error(&self, message: String) {
        let mut inner = self.lock();
        inner.running = false;
        inner.bound_port = None;
        inner.error = Some(message);
        inner.session = None;
    }

    fn is_running(&self) -> bool {
        self.lock().running
    }

    fn bound_port(&self) -> Option<u16> {
        self.lock().bound_port
    }

    fn server_name(&self) -> String {
        self.lock().server_name.clone()
    }
}

/// 后台监听主管：跟随设置启停与端口变更，负责绑定/释放监听。
///
/// 与 Agent HTTP 接入相同的策略：1s 轮询配置、绑定失败 5s 重试（日志限流），
/// 应用退出信号到达时立即停止，不留下悬挂任务。
pub fn spawn_supervisor(db: Arc<Db>, state: MobileSyncState) {
    tauri::async_runtime::spawn(async move {
        run_supervisor(db, state).await;
    });
}

async fn run_supervisor(db: Arc<Db>, state: MobileSyncState) {
    // 状态错误只在变化时记录，避免每个重试周期刷日志。
    let mut last_error: Option<String> = None;
    loop {
        if crate::agents::shutdown_signal::is_set() {
            state.set_stopped();
            tracing::info!("应用退出：手机接入监听停止");
            return;
        }

        let settings = Settings::load(&db).unwrap_or_default();
        if !settings.mobile_sync_enabled {
            if state.is_running() || state.bound_port().is_some() {
                tracing::info!("手机接入已关闭");
            }
            state.set_stopped();
            wait_or_shutdown(Duration::from_secs(1)).await;
            continue;
        }

        let port = settings.mobile_sync_port;
        if state.bound_port() == Some(port) {
            wait_or_shutdown(Duration::from_secs(1)).await;
            continue;
        }

        match server::bind(port).await {
            Ok(listener) => {
                last_error = None;
                state.set_running(port);
                tracing::info!("手机接入监听 0.0.0.0:{}（仅局域网，需用户开启）", port);
                server::serve(listener, db.clone(), state.clone(), port).await;
                state.set_stopped();
            }
            Err(e) => {
                let message = format!("端口 {port} 绑定失败：{e}");
                // 绑定失败可能含系统错误（地址占用/权限），属于可诊断信息，
                // 不含用户数据；只在错误变化时记录一次，避免日志洪水。
                if last_error.as_deref() != Some(message.as_str()) {
                    tracing::warn!("手机接入{}", message);
                    last_error = Some(message.clone());
                }
                state.set_error(message);
                wait_or_shutdown(Duration::from_secs(5)).await;
            }
        }
    }
}

async fn wait_or_shutdown(duration: Duration) {
    tokio::select! {
        _ = crate::agents::shutdown_signal::wait() => {}
        _ = tokio::time::sleep(duration) => {}
    }
}

/// 设置页状态快照。DB 读取失败不影响监听状态展示；设备列表退化为空。
pub fn status(db: &Db, state: &MobileSyncState) -> MobileSyncStatus {
    let settings = Settings::load(db).unwrap_or_default();
    let lan_ip = detect_lan_ip();
    let devices = list_active_devices(db).unwrap_or_default();

    // 只在快照期间持锁：设备列表/网卡探测在上面完成，避免慢 DB 读阻塞配对请求。
    let (
        running,
        bound_port,
        server_name,
        instance_id,
        error,
        pairing,
        paired_device,
    ) = {
        let mut inner = state.lock();

        // 过期会话在这里清理：状态查询是 UI 唯一轮询入口，避免过期码继续可用。
        let now = Instant::now();
        if let Some(session) = inner.session.as_ref() {
            if session.paired.is_none() && now >= session.expires_at {
                inner.session = None;
            }
        }

        let pairing = inner.session.as_ref().and_then(|session| {
            if session.paired.is_some() {
                return None;
            }
            let remaining = session.expires_at.saturating_duration_since(now);
            if remaining.is_zero() {
                return None;
            }
            Some(PairingStatus {
                code: session.code.clone(),
                expires_in_secs: remaining.as_secs(),
            })
        });
        let paired_device = inner
            .session
            .as_ref()
            .and_then(|session| session.paired.clone());

        (
            inner.running,
            inner.bound_port,
            inner.server_name.clone(),
            inner.instance_id.clone(),
            inner.error.clone(),
            pairing,
            paired_device,
        )
    };

    let port = bound_port.unwrap_or(settings.mobile_sync_port);
    MobileSyncStatus {
        enabled: settings.mobile_sync_enabled,
        running,
        port,
        lan_ip: lan_ip.clone(),
        base_url: lan_ip.as_ref().map(|ip| format!("http://{ip}:{port}")),
        server_name,
        fingerprint: fingerprint_of(&instance_id),
        instance_id,
        error,
        pairing,
        paired_device,
        devices,
    }
}

/// 开始一次配对：同一时刻只保留一个会话，重新开始会作废旧码。
pub fn start_pairing(db: &Db, state: &MobileSyncState) -> AppResult<PairingOffer> {
    let settings = Settings::load(db).unwrap_or_default();
    if !settings.mobile_sync_enabled {
        return Err(AppError::Validation(
            "请先开启「允许手机连接」，再生成配对码".into(),
        ));
    }
    let lan_ip = detect_lan_ip().ok_or_else(|| {
        AppError::Unavailable(
            "未检测到局域网 IPv4 地址；请确认已连接 Wi-Fi/有线网络后重试".into(),
        )
    })?;

    let (server_name, instance_id, port, code) = {
        let mut inner = state.lock();
        let Some(bound_port) = inner.bound_port else {
            return Err(AppError::Unavailable(
                "手机接入服务尚未就绪，请稍后重试".into(),
            ));
        };
        if bound_port != settings.mobile_sync_port {
            return Err(AppError::Unavailable(
                "手机接入端口正在切换，请稍后重试".into(),
            ));
        }
        let now = Instant::now();
        let session = PairingSession {
            id: Uuid::new_v4().simple().to_string(),
            code: generate_pairing_code(),
            expires_at: now + Duration::from_secs(PAIRING_TTL_SECS),
            attempts: 0,
            paired: None,
        };
        let code = session.code.clone();
        inner.session = Some(session);
        (
            inner.server_name.clone(),
            inner.instance_id.clone(),
            bound_port,
            code,
        )
    };

    let fingerprint = fingerprint_of(&instance_id);
    let qr_payload = build_pairing_uri(
        &lan_ip,
        port,
        &code,
        &server_name,
        &instance_id,
        &fingerprint,
    );

    Ok(PairingOffer {
        code,
        expires_in_secs: PAIRING_TTL_SECS,
        lan_ip,
        port,
        server_name,
        instance_id,
        fingerprint,
        qr_payload,
    })
}

/// 取消当前配对会话（幂等）。
pub fn cancel_pairing(state: &MobileSyncState) {
    state.clear_session();
}

/// 列出未撤销设备。
pub fn list_active_devices(db: &Db) -> AppResult<Vec<MobileDevice>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, platform, created_at, last_seen_at, last_ip, revoked_at
             FROM mobile_devices
             WHERE revoked_at IS NULL
             ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], map_device_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    })
}

/// 撤销设备：令牌立即失效，记录保留用于审计。返回是否命中有效设备。
pub fn revoke_device(db: &Db, device_id: &str) -> AppResult<bool> {
    if device_id.trim().is_empty() {
        return Err(AppError::Validation("设备 ID 不能为空".into()));
    }
    let now = now_iso();
    db.with_conn(|conn| {
        let changed = conn.execute(
            "UPDATE mobile_devices SET revoked_at = ?1
             WHERE id = ?2 AND revoked_at IS NULL",
            rusqlite::params![now, device_id],
        )?;
        Ok(changed > 0)
    })
}

/// 完成配对：由 HTTP 层调用，返回一次性令牌。
///
/// 分三段加锁：校验（不持锁做 DB IO）→ 落库 → 回填会话。第二段期间用户取消或
/// 重新生成会话时，落库后的设备会补偿删除，避免出现「已取消但仍被授权」。
pub fn complete_pairing(
    db: &Db,
    state: &MobileSyncState,
    request: PairRequest,
    peer_ip: Option<String>,
) -> Result<PairOutcome, PairFailure> {
    let code = request.code.trim().to_string();
    let name = sanitize_device_name(&request.device_name);
    let platform = sanitize_platform(&request.platform);

    // 0. 关闭开关可能先于监听循环生效（最长 2s 窗口）：以设置为准 fail-closed，
    // 绝不在用户已关闭手机接入后继续签发令牌。
    if !Settings::load(db)
        .map(|settings| settings.mobile_sync_enabled)
        .unwrap_or(false)
    {
        return Err(PairFailure::Closed);
    }

    // 1. 校验码与尝试次数
    let session_id = {
        let mut inner = state.lock();
        let Some(session) = inner.session.as_mut() else {
            return Err(PairFailure::Closed);
        };
        if session.paired.is_some() {
            return Err(PairFailure::Closed);
        }
        if Instant::now() >= session.expires_at {
            inner.session = None;
            return Err(PairFailure::Closed);
        }
        if session.attempts >= MAX_PAIR_ATTEMPTS {
            return Err(PairFailure::TooManyAttempts);
        }
        if !constant_time_eq(&session.code, &code) {
            session.attempts = session.attempts.saturating_add(1);
            if session.attempts >= MAX_PAIR_ATTEMPTS {
                return Err(PairFailure::TooManyAttempts);
            }
            return Err(PairFailure::InvalidCode);
        }
        session.id.clone()
    };

    // 2. 落库：明文令牌不落库，只保存 SHA-256 哈希
    let token = generate_device_token();
    let token_hash = hash_token(&token);
    let device_id = Uuid::new_v4().to_string();
    let paired_at = now_iso();
    let server_name = state.lock().server_name.clone();
    let last_ip = peer_ip.filter(|ip| !ip.is_empty());

    let inserted = db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO mobile_devices
               (id, name, platform, token_hash, created_at, last_seen_at, last_ip, revoked_at)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, NULL)",
            rusqlite::params![device_id, name, platform, token_hash, paired_at, last_ip],
        )?;
        Ok(())
    });
    if let Err(e) = inserted {
        tracing::warn!("手机配对写入设备失败: {e}");
        return Err(PairFailure::Closed);
    }

    // 3. 回填会话；若会话已被取消/替换，撤销刚落库的设备（补偿）
    let notice = PairedNotice {
        device_id: device_id.clone(),
        name: name.clone(),
        platform: platform.clone(),
        paired_at: paired_at.clone(),
    };
    let accepted = {
        let mut inner = state.lock();
        match inner.session.as_mut() {
            Some(session) if session.id == session_id && session.paired.is_none() => {
                session.paired = Some(notice);
                // 成功即作废配对码（单次使用）
                session.code.clear();
                true
            }
            _ => false,
        }
    };
    if !accepted {
        let _ = db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM mobile_devices WHERE id = ?1",
                rusqlite::params![device_id],
            )?;
            Ok(())
        });
        return Err(PairFailure::Closed);
    }

    // last_ip 已在插入时记录配对来源；后续 ping 会刷新 last_seen_at。

    Ok(PairOutcome {
        token,
        device_id,
        server_name,
        api_version: API_VERSION,
        paired_at,
    })
}

/// 校验设备令牌并刷新最近连接时间。令牌无效/已撤销返回 `None`。
pub fn authenticate_device(db: &Db, token: &str, peer_ip: Option<&str>) -> AppResult<Option<MobileDevice>> {
    let token = token.trim();
    // 令牌固定 64 位十六进制；格式不符直接拒绝，避免无意义的哈希查询。
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(None);
    }
    let hash = hash_token(token);
    let device = db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, platform, created_at, last_seen_at, last_ip, revoked_at
             FROM mobile_devices
             WHERE token_hash = ?1 AND revoked_at IS NULL",
        )?;
        stmt.query_row(rusqlite::params![hash], map_device_row)
            .optional()
            .map_err(AppError::from)
    })?;

    if let Some(device) = device.as_ref() {
        let now = now_iso();
        let ip = peer_ip.unwrap_or("").to_string();
        let _ = db.with_conn(|conn| {
            if ip.is_empty() {
                conn.execute(
                    "UPDATE mobile_devices SET last_seen_at = ?1 WHERE id = ?2",
                    rusqlite::params![now, device.id],
                )?;
            } else {
                conn.execute(
                    "UPDATE mobile_devices SET last_seen_at = ?1, last_ip = ?2 WHERE id = ?3",
                    rusqlite::params![now, ip, device.id],
                )?;
            }
            Ok(())
        });
    }
    Ok(device)
}

fn map_device_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MobileDevice> {
    Ok(MobileDevice {
        id: row.get(0)?,
        name: row.get(1)?,
        platform: row.get(2)?,
        created_at: row.get(3)?,
        last_seen_at: row.get(4)?,
        last_ip: row.get(5)?,
        revoked_at: row.get(6)?,
    })
}

/// 检测默认路由使用的局域网 IPv4。UDP connect 不发送任何数据包，只让内核选源地址。
pub fn detect_lan_ip() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        None
    } else if let std::net::IpAddr::V4(v4) = ip {
        Some(v4.to_string())
    } else {
        None
    }
}

/// 二维码内容：手机端扫码后可直接解析，也可退回手动输入。
///
/// 固定字段顺序便于测试与跨端解析；所有值做百分号编码，设备名可包含中文/空格。
pub fn build_pairing_uri(
    host: &str,
    port: u16,
    code: &str,
    server_name: &str,
    instance_id: &str,
    fingerprint: &str,
) -> String {
    format!(
        "taskdock://pair?v={}&host={}&port={}&code={}&name={}&instance={}&fp={}",
        API_VERSION,
        percent_encode(host),
        port,
        percent_encode(code),
        percent_encode(server_name),
        percent_encode(instance_id),
        percent_encode(fingerprint),
    )
}

/// RFC 3986 unreserved 之外的字节全部百分号编码（UTF-8）。
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let keep = byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~');
        if keep {
            out.push(*byte as char);
        } else {
            out.push('%');
            out.push_str(&format!("{byte:02X}"));
        }
    }
    out
}

fn load_or_create_instance_id(db: &Db) -> String {
    if let Ok(Some(value)) = db.get_setting(INSTANCE_KEY) {
        if let Some(id) = value.as_str() {
            let id = id.trim();
            if (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric()) {
                return id.to_string();
            }
        }
    }
    let id = Uuid::new_v4().simple().to_string();
    if let Err(e) = db.set_setting(INSTANCE_KEY, serde_json::Value::String(id.clone())) {
        tracing::warn!("持久化手机接入实例 ID 失败（本次使用临时 ID）: {e}");
    }
    id
}

fn host_display_name() -> String {
    let raw = std::env::var("COMPUTERNAME").unwrap_or_default();
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_DEVICE_NAME_CHARS)
        .collect();
    if cleaned.is_empty() {
        "Task Dock".to_string()
    } else {
        cleaned
    }
}

fn sanitize_device_name(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_DEVICE_NAME_CHARS)
        .collect();
    if cleaned.is_empty() {
        "Android 设备".to_string()
    } else {
        cleaned
    }
}

fn sanitize_platform(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .take(MAX_PLATFORM_CHARS)
        .collect();
    if cleaned.is_empty() {
        "unknown".to_string()
    } else {
        cleaned
    }
}

/// 6 位十进制配对码。uuid v4 自带 122 位随机性，取模偏差可忽略；
/// 这里的码只是「屏幕到手机的短时信道」，真正凭据是成功后的 256 位令牌。
fn generate_pairing_code() -> String {
    let value = Uuid::new_v4().as_u128() % 1_000_000;
    format!("{value:06}")
}

/// 256 位设备令牌（64 位十六进制），只在配对响应里出现一次。
fn generate_device_token() -> String {
    let a = Uuid::new_v4().simple().to_string();
    let b = Uuid::new_v4().simple().to_string();
    format!("{a}{b}")
}

pub(crate) fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn fingerprint_of(instance_id: &str) -> String {
    let digest = Sha256::digest(instance_id.as_bytes());
    let mut out = String::with_capacity(8);
    for byte in digest.iter().take(4) {
        out.push_str(&format!("{byte:02X}"));
    }
    out
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

// rusqlite OptionalExtension 是可选结果所需
use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state(db: &Db) -> MobileSyncState {
        db.set_setting("mobile_sync_enabled", serde_json::json!(true))
            .unwrap();
        let state = MobileSyncState::new(db);
        state.set_running(47822);
        state
    }

    fn start_session(state: &MobileSyncState) -> PairingOffer {
        // 测试环境不保证有局域网 IP：直接读取状态里的实例信息构造 offer，
        // 避免依赖宿主机网络。
        let mut inner = state.lock();
        let now = Instant::now();
        let code = generate_pairing_code();
        inner.session = Some(PairingSession {
            id: Uuid::new_v4().simple().to_string(),
            code: code.clone(),
            expires_at: now + Duration::from_secs(PAIRING_TTL_SECS),
            attempts: 0,
            paired: None,
        });
        PairingOffer {
            code,
            expires_in_secs: PAIRING_TTL_SECS,
            lan_ip: "192.0.2.10".into(),
            port: 47822,
            server_name: inner.server_name.clone(),
            instance_id: inner.instance_id.clone(),
            fingerprint: fingerprint_of(&inner.instance_id),
            qr_payload: String::new(),
        }
    }

    #[test]
    fn pairing_code_is_always_six_digits() {
        for _ in 0..200 {
            let code = generate_pairing_code();
            assert_eq!(code.len(), 6);
            assert!(code.bytes().all(|b| b.is_ascii_digit()));
            assert!(code.parse::<u32>().unwrap() < 1_000_000);
        }
    }

    #[test]
    fn pairing_uri_is_stable_and_percent_encodes_display_name() {
        let uri = build_pairing_uri(
            "192.168.1.10",
            47822,
            "042913",
            "我的 台式机",
            "abc123def456",
            "1A2B3C4D",
        );
        assert_eq!(
            uri,
            "taskdock://pair?v=1&host=192.168.1.10&port=47822&code=042913&\
             name=%E6%88%91%E7%9A%84%20%E5%8F%B0%E5%BC%8F%E6%9C%BA&instance=abc123def456&fp=1A2B3C4D"
        );
    }

    #[test]
    fn token_hash_is_sha256_and_never_equals_token() {
        let token = generate_device_token();
        assert_eq!(token.len(), 64);
        assert!(token.bytes().all(|b| b.is_ascii_hexdigit()));
        let hash = hash_token(&token);
        assert_eq!(hash.len(), 64);
        assert_ne!(hash, token);
        assert_eq!(hash, hash_token(&token));
    }

    #[test]
    fn pairing_succeeds_once_and_rejects_replay() {
        let db = Db::open_in_memory().unwrap();
        let state = test_state(&db);
        let offer = start_session(&state);

        let outcome = complete_pairing(
            &db,
            &state,
            PairRequest {
                code: offer.code.clone(),
                device_name: "Pixel 9".into(),
                platform: "android".into(),
            },
            Some("192.168.1.20".into()),
        )
        .unwrap();
        assert_eq!(outcome.api_version, API_VERSION);
        assert_eq!(outcome.token.len(), 64);

        // 同一配对码不能再次使用
        let replay = complete_pairing(
            &db,
            &state,
            PairRequest {
                code: offer.code.clone(),
                device_name: "Pixel 9".into(),
                platform: "android".into(),
            },
            None,
        );
        assert_eq!(replay.unwrap_err(), PairFailure::Closed);

        // 只有哈希落库，明文令牌查不到
        let count: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM mobile_devices WHERE token_hash = ?1",
                    rusqlite::params![outcome.token],
                    |row| row.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(count, 0);

        let devices = list_active_devices(&db).unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].name, "Pixel 9");
        assert_eq!(devices[0].last_ip.as_deref(), Some("192.168.1.20"));

        // 令牌可鉴权，撤销后立即失效
        assert!(authenticate_device(&db, &outcome.token, Some("192.168.1.21"))
            .unwrap()
            .is_some());
        assert!(revoke_device(&db, &outcome.device_id).unwrap());
        assert!(authenticate_device(&db, &outcome.token, None)
            .unwrap()
            .is_none());
        assert!(list_active_devices(&db).unwrap().is_empty());
    }

    #[test]
    fn wrong_code_locks_session_after_max_attempts() {
        let db = Db::open_in_memory().unwrap();
        let state = test_state(&db);
        let _offer = start_session(&state);

        for attempt in 1..MAX_PAIR_ATTEMPTS {
            let failure = complete_pairing(
                &db,
                &state,
                PairRequest {
                    code: "000000".into(),
                    device_name: String::new(),
                    platform: String::new(),
                },
                None,
            );
            assert_eq!(failure.unwrap_err(), PairFailure::InvalidCode, "第 {attempt} 次");
        }
        let last = complete_pairing(
            &db,
            &state,
            PairRequest {
                code: "000000".into(),
                device_name: String::new(),
                platform: String::new(),
            },
            None,
        );
        assert_eq!(last.unwrap_err(), PairFailure::TooManyAttempts);
    }

    #[test]
    fn expired_session_is_closed_before_db_write() {
        let db = Db::open_in_memory().unwrap();
        let state = test_state(&db);
        let offer = start_session(&state);
        {
            let mut inner = state.lock();
            inner.session.as_mut().unwrap().expires_at = Instant::now();
        }
        let failure = complete_pairing(
            &db,
            &state,
            PairRequest {
                code: offer.code,
                device_name: "晚到的手机".into(),
                platform: "android".into(),
            },
            None,
        );
        assert_eq!(failure.unwrap_err(), PairFailure::Closed);
        assert!(list_active_devices(&db).unwrap().is_empty());
    }

    #[test]
    fn cancelling_during_pair_write_is_compensated() {
        let db = Db::open_in_memory().unwrap();
        let state = test_state(&db);
        let offer = start_session(&state);
        // 模拟并发取消：请求已通过校验后会话被替换
        let mut inner = state.lock();
        inner.session = None;
        drop(inner);

        let failure = complete_pairing(
            &db,
            &state,
            PairRequest {
                code: offer.code,
                device_name: "被取消的设备".into(),
                platform: "android".into(),
            },
            None,
        );
        assert_eq!(failure.unwrap_err(), PairFailure::Closed);
        assert!(list_active_devices(&db).unwrap().is_empty());
    }

    #[test]
    fn disabled_setting_rejects_pairing_even_with_active_session() {
        let db = Db::open_in_memory().unwrap();
        let state = test_state(&db);
        let offer = start_session(&state);
        db.set_setting("mobile_sync_enabled", serde_json::json!(false))
            .unwrap();

        let failure = complete_pairing(
            &db,
            &state,
            PairRequest {
                code: offer.code,
                device_name: "关闭后到达的手机".into(),
                platform: "android".into(),
            },
            None,
        );
        assert_eq!(failure.unwrap_err(), PairFailure::Closed);
        assert!(list_active_devices(&db).unwrap().is_empty());
    }

    #[test]
    fn device_name_and_platform_are_sanitized() {
        assert_eq!(sanitize_device_name("  \u{0007}  "), "Android 设备");
        assert_eq!(sanitize_device_name("Pixel\n9"), "Pixel9");
        assert_eq!(sanitize_platform("ANDROID 16!"), "android16");
    }
}
