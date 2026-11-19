//! PersonalHubService —— 独立普通用户进程 `taskdock-personal-hub` 的核心。
//!
//! 方法签名对齐基线 §11.1 / `11-windows-method-design.md` §0.1：
//! start / stop / get_status / run_health_check / recover_after_failure。
//!
//! 生命周期解耦：Hub 在主进程之外独立运行；关闭 Tauri 主窗口不会调用本服务的 stop。
//! 只有显式停止（托盘/设置，经本地管道 STOP 或进程侧调用）才会终止服务。
//! 异常恢复不会覆盖用户的显式停止意图。

use std::sync::mpsc;
use std::sync::Arc;
use std::time::SystemTime;

use parking_lot::{Mutex, RwLock};

use crate::personal_hub::api::HubApi;
use crate::personal_hub::error::{HubError, HubResult};
use crate::personal_hub::health::HealthMonitor;
use crate::personal_hub::ipc::{NamedPipeServer, PipeHandler};
use crate::personal_hub::types::{
    ComponentHealth, HealthReport, HubConfig, HubState, HubStatus, RecoveryResult, StopReason,
};

pub struct PersonalHubService {
    config: RwLock<HubConfig>,
    status: RwLock<HubStatus>,
    pipe: Mutex<Option<NamedPipeServer>>,
    monitor: Mutex<HealthMonitor>,
    shutdown_rx: Mutex<Option<mpsc::Receiver<()>>>,
    /// P3 身份/配对/设备 API；恢复管道时复用同一实例（身份不重复初始化）。
    handler: RwLock<Option<Arc<dyn PipeHandler>>>,
}

impl Default for PersonalHubService {
    fn default() -> Self {
        Self::with_config(HubConfig::default())
    }
}

impl PersonalHubService {
    pub fn with_config(config: HubConfig) -> Self {
        let monitor = HealthMonitor::new(&config);
        Self {
            config: RwLock::new(config),
            status: RwLock::new(HubStatus::stopped()),
            pipe: Mutex::new(None),
            monitor: Mutex::new(monitor),
            shutdown_rx: Mutex::new(None),
            handler: RwLock::new(None),
        }
    }

    pub fn new() -> Self {
        Self::default()
    }

    /// 启动 Hub：创建当前用户 ACL 的 Named Pipe 并启动 accept 线程。
    /// 不初始化身份、不连云端（P2/P3 不属于 P1）。
    pub fn start(&self, config: HubConfig) -> HubResult<HubStatus> {
        {
            let mut status = self.status.write();
            if status.state == HubState::Running {
                return Ok(status.clone());
            }
            if status.state == HubState::Starting || status.state == HubState::Stopping {
                return Err(HubError::InvalidSession(format!(
                    "cannot start while {:?}",
                    status.state
                )));
            }
            status.state = HubState::Starting;
        }

        // P3：打开独立 hub.db 并加载/生成本机身份；失败则 fail closed（不启动管道）。
        let api = match HubApi::open_with_env(&config) {
            Ok(api) => api,
            Err(e) => {
                let mut status = self.status.write();
                status.state = HubState::Failed {
                    reason: e.to_string(),
                };
                return Err(e);
            }
        };
        let handler: Arc<dyn PipeHandler> = api;
        *self.handler.write() = Some(handler.clone());

        let mut server = match NamedPipeServer::start_with_handler(
            &config.pipe_name,
            Some(handler),
        ) {
            Ok(s) => s,
            Err(e) => {
                let mut status = self.status.write();
                status.state = HubState::Failed {
                    reason: e.to_string(),
                };
                return Err(e);
            }
        };
        let rx = server.take_shutdown_receiver();

        *self.config.write() = config.clone();
        *self.pipe.lock() = Some(server);
        *self.shutdown_rx.lock() = rx;
        self.monitor.lock().reset();

        let mut status = self.status.write();
        status.state = HubState::Running;
        status.pipe_name = Some(config.pipe_name);
        status.started_at = Some(SystemTime::now());
        status.stop_reason = None;
        Ok(status.clone())
    }

    /// 显式停止（仅托盘/设置触发；关闭主窗口不得调用）。
    pub fn stop(&self, reason: StopReason) -> HubResult<()> {
        {
            let mut status = self.status.write();
            if status.state == HubState::Stopped {
                return Ok(());
            }
            status.state = HubState::Stopping;
        }

        if let Some(mut server) = self.pipe.lock().take() {
            server.stop();
        }
        *self.shutdown_rx.lock() = None;

        let mut status = self.status.write();
        status.state = HubState::Stopped;
        status.pipe_name = None;
        status.started_at = None;
        status.stop_reason = Some(reason);
        Ok(())
    }

    /// 状态查询（本地 Named Pipe 或进程内调用）。
    pub fn get_status(&self) -> HubResult<HubStatus> {
        Ok(self.status.read().clone())
    }

    /// 健康检查：管道、服务端线程、状态一致性；失败累计由 HealthMonitor 记录。
    pub fn run_health_check(&self) -> HubResult<HealthReport> {
        let status = self.status.read().clone();
        let pipe_health = self.pipe.lock().as_ref().map(|p| p.health());
        let pipe_ok = pipe_health
            .as_ref()
            .map(|h| h.server_alive && h.current_user_acl && h.reject_remote_clients)
            .unwrap_or(false);
        let state_ok = status.state == HubState::Running;

        {
            let mut monitor = self.monitor.lock();
            if pipe_ok && state_ok {
                monitor.record_success();
            } else {
                monitor.record_failure();
            }
        }
        let degraded = self.monitor.lock().is_degraded();

        let pipe_detail = match &pipe_health {
            Some(h) => format!(
                "name={}, alive={}, current_user_acl={}, reject_remote={}",
                h.name, h.server_alive, h.current_user_acl, h.reject_remote_clients
            ),
            None => "no pipe server instance".into(),
        };
        let components = vec![
            ComponentHealth {
                name: "named_pipe",
                healthy: pipe_ok,
                detail: pipe_detail,
            },
            ComponentHealth {
                name: "service_state",
                healthy: state_ok,
                detail: format!("state={:?}", status.state),
            },
        ];
        Ok(HealthReport {
            healthy: pipe_ok && state_ok && !degraded,
            state: status.state,
            checked_at: SystemTime::now(),
            components,
        })
    }

    /// 异常恢复：重建失效的管道服务端；显式停止状态不自动重启。
    pub fn recover_after_failure(&self) -> HubResult<RecoveryResult> {
        let status = self.status.read().clone();
        match status.state {
            HubState::Stopped => {
                return Ok(RecoveryResult {
                    recovered: false,
                    actions: vec!["explicit stop honored; no auto-restart".into()],
                    status,
                });
            }
            HubState::Starting | HubState::Stopping => {
                return Ok(RecoveryResult {
                    recovered: false,
                    actions: vec!["transitional state; no recovery action".into()],
                    status,
                });
            }
            HubState::Running | HubState::Failed { .. } => {}
        }

        let mut actions = Vec::new();
        if let Some(mut server) = self.pipe.lock().take() {
            server.stop();
            actions.push("closed stale pipe server".into());
        }
        self.monitor.lock().reset();

        let config = self.config.read().clone();
        let handler = match self.handler.read().clone() {
            Some(handler) => handler,
            None => {
                let api = HubApi::open_with_env(&config)?;
                let handler: Arc<dyn PipeHandler> = api;
                *self.handler.write() = Some(handler.clone());
                handler
            }
        };
        let mut server = match NamedPipeServer::start_with_handler(
            &config.pipe_name,
            Some(handler),
        ) {
            Ok(s) => s,
            Err(e) => {
                let mut st = self.status.write();
                st.state = HubState::Failed {
                    reason: e.to_string(),
                };
                return Err(HubError::Network(format!("recovery failed: {}", e)));
            }
        };
        let rx = server.take_shutdown_receiver();
        *self.pipe.lock() = Some(server);
        *self.shutdown_rx.lock() = rx;
        actions.push("recreated named pipe with current-user ACL".into());

        let mut status = self.status.write();
        status.state = HubState::Running;
        status.pipe_name = Some(config.pipe_name);
        status.started_at = Some(SystemTime::now());
        status.stop_reason = None;
        Ok(RecoveryResult {
            recovered: true,
            actions,
            status: status.clone(),
        })
    }

    /// 供独立进程 main 使用：阻塞直到管道线程结束（STOP 命令或异常）。
    pub fn wait_for_shutdown(&self) {
        if let Some(rx) = self.shutdown_rx.lock().take() {
            let _ = rx.recv();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::personal_hub::ipc::pipe_request;

    fn test_config(tag: &str) -> HubConfig {
        HubConfig {
            pipe_name: format!(r"\\.\pipe\taskdock-ph-svc-{}-{}", tag, std::process::id()),
            health_failure_threshold: 2,
            // P3：每个测试独立 hub.db，避免污染真实用户数据目录。
            data_dir: Some(std::env::temp_dir().join(format!(
                "taskdock-ph-svc-data-{}-{}",
                tag,
                std::process::id()
            ))),
            control_plane_url: None,
        }
    }

    #[test]
    fn start_stop_status_transitions() {
        let svc = PersonalHubService::new();
        assert_eq!(svc.get_status().unwrap().state, HubState::Stopped);

        let started = svc.start(test_config("lifecycle")).unwrap();
        assert_eq!(started.state, HubState::Running);
        assert!(started.started_at.is_some());
        assert_eq!(svc.get_status().unwrap().state, HubState::Running);

        // 重复 start 幂等：返回当前状态，不重复创建管道。
        assert_eq!(svc.start(test_config("lifecycle")).unwrap().state, HubState::Running);

        svc.stop(StopReason::ExplicitUserRequest).unwrap();
        let stopped = svc.get_status().unwrap();
        assert_eq!(stopped.state, HubState::Stopped);
        assert_eq!(stopped.stop_reason, Some(StopReason::ExplicitUserRequest));
        assert!(stopped.pipe_name.is_none());
    }

    #[test]
    fn stop_is_idempotent() {
        let svc = PersonalHubService::new();
        svc.stop(StopReason::SessionLogoff).unwrap();
        assert_eq!(svc.get_status().unwrap().state, HubState::Stopped);
    }

    #[test]
    fn health_check_reflects_running_and_stopped() {
        let svc = PersonalHubService::new();
        let stopped_report = svc.run_health_check().unwrap();
        assert!(!stopped_report.healthy);
        assert_eq!(stopped_report.state, HubState::Stopped);

        svc.start(test_config("health")).unwrap();
        let running_report = svc.run_health_check().unwrap();
        assert!(running_report.healthy);
        assert_eq!(running_report.components.len(), 2);
        assert!(running_report.components.iter().all(|c| c.healthy));
    }

    #[test]
    fn recover_honors_explicit_stop() {
        let svc = PersonalHubService::new();
        svc.start(test_config("recover-stop")).unwrap();
        svc.stop(StopReason::ExplicitUserRequest).unwrap();

        let result = svc.recover_after_failure().unwrap();
        assert!(!result.recovered);
        assert!(result.actions.iter().any(|a| a.contains("explicit stop")));
        assert_eq!(result.status.state, HubState::Stopped);
    }

    #[test]
    fn recover_rebuilds_pipe_after_failure() {
        let svc = PersonalHubService::new();
        svc.start(test_config("recover-rebuild")).unwrap();
        // 模拟异常：显式关闭底层管道但保持状态为 Running，再执行恢复。
        {
            let mut pipe = svc.pipe.lock();
            if let Some(server) = pipe.as_mut() {
                server.stop();
            }
            *pipe = None;
        }
        let result = svc.recover_after_failure().unwrap();
        assert!(result.recovered);
        assert_eq!(result.status.state, HubState::Running);
        assert!(result.actions.iter().any(|a| a.contains("recreated")));
        assert!(svc.run_health_check().unwrap().healthy);
        svc.stop(StopReason::ExplicitUserRequest).unwrap();
    }

    #[test]
    fn status_query_over_pipe_returns_running() {
        let cfg = test_config("pipe-status");
        let svc = PersonalHubService::new();
        svc.start(cfg.clone()).unwrap();
        let resp = pipe_request(&cfg.pipe_name, "STATUS").expect("STATUS via management pipe");
        assert_eq!(resp, "RUNNING");
        svc.stop(StopReason::ExplicitUserRequest).unwrap();
    }

    #[test]
    fn p3_identity_is_exposed_over_the_same_named_pipe() {
        let cfg = test_config("p3-identity");
        let svc = PersonalHubService::new();
        svc.start(cfg.clone()).unwrap();
        let resp = pipe_request(&cfg.pipe_name, r#"{"method":"identity.get_public"}"#)
            .expect("identity.get_public via management pipe");
        let value: serde_json::Value = serde_json::from_str(&resp).expect("JSON response");
        assert_eq!(value["ok"], true);
        assert_eq!(value["result"]["fingerprint"].as_str().unwrap().len(), 32);
        assert!(!resp.to_ascii_lowercase().contains("private"));
        svc.stop(StopReason::ExplicitUserRequest).unwrap();
    }
}
