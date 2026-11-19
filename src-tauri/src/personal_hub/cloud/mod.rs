//! Control Plane 客户端（P3）：HTTPS + 契约 §1 签名。

pub mod client;
pub mod types;

pub use client::{ControlPlane, HttpControlPlane};
pub use types::{CloudDevice, CreatedInvitation, DecideOutcome, PendingPairingRequest};
