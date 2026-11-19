//! Personal Hub v1.0 — Windows 独立后台进程（P1 骨架 + P3 身份/配对）。
//!
//! 架构事实源：`docs/personal-hub/ARCHITECTURE_BASELINE_v1.0.md` §4 / §6 / §11.1 / §12。
//! 三端接口契约：`docs/personal-hub/P3-SHARED-CONTRACT.md`。
//!
//! 已实现：
//! - P1：`PersonalHubService` 生命周期、当前用户 ACL 的 Named Pipe、健康检查/恢复；
//! - P3：Ed25519 设备身份（DPAPI 保护私钥）、二维码邀请、PC 本机批准、设备撤销；
//!   全部经同一 Named Pipe 的 JSON 行方法暴露（`api::HubApi`）。
//!
//! 明确不做（属于其它阶段，禁止提前实现）：
//! - P2 云端服务端、P4 WebRTC/信令、P5 本机认证、P6 远控采集与输入。
//! - 不监听 0.0.0.0 或任何公网网卡；不启用无鉴权 localhost HTTP。
//!
//! 所有 Win32 调用只在本模块内（`ipc::named_pipe` 与 `crypto::dpapi`）出现。

pub mod api;
pub mod cloud;
pub mod crypto;
pub mod devices;
pub mod error;
pub mod health;
pub mod identity;
pub mod ipc;
pub mod pairing;
pub mod service;
pub mod store;
pub mod types;

pub use api::HubApi;
pub use cloud::{ControlPlane, HttpControlPlane};
pub use devices::{DeviceManager, DeviceRegistration, PairedDevice, PAIRED_CAPABILITIES};
pub use error::{HubError, HubResult};
pub use health::HealthMonitor;
pub use identity::{DeviceIdentity, IdentityManager, Signature};
pub use pairing::{InvitationClaims, PairingDecision, PairingInvitation, PairingManager};
pub use service::PersonalHubService;
pub use store::HubStore;
pub use types::{
    ComponentHealth, HealthReport, HubConfig, HubState, HubStatus, RecoveryResult, StopReason,
};
