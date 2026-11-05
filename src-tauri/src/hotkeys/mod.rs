//! 自定义全局快捷键（P1 / `ux.custom-hotkeys`）。
//!
//! 设计要点：
//! - 动作以稳定 ID 管理（见 [`model::ACTIONS`]），配置不保存导航索引；
//! - 应用内（`app_local`）由前端 keydown 分发，系统级（`system_global`）经
//!   global-shortcut 插件常驻注册，两者在状态里明确区分，绝不把前者称作“系统全局”；
//! - 修改流程：校验组合 → 查内部冲突 → 尝试注册新组合 → 确认成功 → 原子持久化 →
//!   注销旧组合；任一步失败保留旧快捷键并回滚，失败原因原样返回；
//! - 启动时重新注册并按实际结果生成状态，避免“UI 显示正常但实际失效”。

pub mod model;
pub mod registry;
pub mod store;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};

pub use model::{
    find_def, ActionDef, HotkeyBinding, HotkeyConfigFile, HotkeyScope, ACTIONS, CONFIG_VERSION,
};
use registry::ShortcutRegistrar;

/// 配置变化后广播给设置页；payload 为空，前端收到后重新拉取快照。
pub const EVENT_CHANGED: &str = "hotkeys-changed";

static MANAGER: OnceLock<Arc<HotkeysManager>> = OnceLock::new();

/// 单条快捷键的前端视图：包含注册状态与可展示的失败原因。
#[derive(Clone, Debug, Serialize)]
pub struct HotkeyBindingView {
    pub action: String,
    pub label: String,
    pub description: String,
    pub scope: HotkeyScope,
    pub accelerator: String,
    pub default_accelerator: String,
    pub enabled: bool,
    pub is_default: bool,
    /// active / disabled / conflict / invalid / unavailable
    pub state: String,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct HotkeySnapshot {
    pub bindings: Vec<HotkeyBindingView>,
    /// 配置损坏 / 旧动作被忽略等加载期提示；正常时为 None。
    pub load_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct HotkeyChangeOutcome {
    pub ok: bool,
    pub action: String,
    /// 尝试后的实际绑定（失败时为原绑定，便于 UI 立即还原）。
    pub binding: HotkeyBindingView,
    pub previous_accelerator: String,
    /// 是否真的写入配置文件。
    pub persisted: bool,
    /// 是否执行了回滚（注册失败保持原样时为 false）。
    pub rolled_back: bool,
    /// 回滚是否完整成功（无回滚时为 None）。
    pub rollback_ok: Option<bool>,
    pub error: Option<String>,
    /// invalid / conflict / occupied / register_failed / persist_failed / unregister_failed
    pub error_kind: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct HotkeyResetOutcome {
    pub ok: bool,
    pub results: Vec<HotkeyChangeOutcome>,
    pub error: Option<String>,
}

/// 从备份恢复快捷键后的真实结果。
///
/// 不伪装成功：无法注册的组合会降级默认或禁用，并写入 `warnings`；
/// 未能完全按备份应用的原始配置另存为 `hotkeys.restore-pending.json`。
#[derive(Clone, Debug, Serialize)]
pub struct HotkeyRestoreReport {
    /// 实际注册成功的系统级组合数。
    pub applied: usize,
    /// 因冲突/无效而禁用（或降级后仍不可用）的条数。
    pub disabled: usize,
    pub warnings: Vec<String>,
    /// 是否写出待解决原始配置（`hotkeys.restore-pending.json`）。
    pub pending_saved: bool,
    /// 是否成功持久化最终生效配置。
    pub persisted: bool,
}

pub struct HotkeysManager {
    store: Arc<dyn store::HotkeyStore>,
    registrar: Arc<dyn ShortcutRegistrar>,
    inner: Mutex<Inner>,
    /// 串行化变更事务；不占用 `inner` 锁，避免注册（需主线程往返）期间
    /// 与主线程上的快捷键事件互相等待。
    change_lock: Mutex<()>,
}

#[derive(Clone, Default)]
struct BindingStatus {
    registered: bool,
    error: Option<String>,
    error_kind: Option<String>,
}

#[derive(Clone)]
struct Inner {
    bindings: Vec<HotkeyBinding>,
    statuses: HashMap<String, BindingStatus>,
    load_error: Option<String>,
    /// 实际注册成功的系统级组合，用于快速判定全局按键属于哪个动作。
    specs: Vec<(tauri_plugin_global_shortcut::Shortcut, String)>,
}

impl HotkeysManager {
    pub fn new(
        store: Arc<dyn store::HotkeyStore>,
        registrar: Arc<dyn ShortcutRegistrar>,
    ) -> Self {
        Self {
            store,
            registrar,
            inner: Mutex::new(Inner {
                bindings: Vec::new(),
                statuses: HashMap::new(),
                load_error: None,
                specs: Vec::new(),
            }),
            change_lock: Mutex::new(()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 启动引导：加载配置 → 补全默认动作 → 注册启用的系统级组合 → 记录真实状态。
    pub fn bootstrap(&self, legacy_system_enabled: bool) {
        let (saved, mut load_error) = match self.store.load() {
            Ok(saved) => (saved, None),
            Err(message) => (None, Some(message)),
        };
        let (bindings, issues) = model::build_bindings(saved.as_ref(), Some(legacy_system_enabled));
        if !issues.is_empty() {
            let joined = issues.join("；");
            load_error = Some(match load_error {
                Some(existing) => format!("{existing}；{joined}"),
                None => joined,
            });
        }

        let mut statuses = HashMap::new();
        for binding in &bindings {
            let mut status = BindingStatus::default();
            if binding.scope == HotkeyScope::AppLocal && binding.enabled {
                status.registered = true;
            }
            statuses.insert(binding.action.clone(), status);
        }

        for binding in &bindings {
            if binding.scope != HotkeyScope::SystemGlobal || !binding.enabled {
                continue;
            }
            match self.registrar.register(&binding.accelerator) {
                Ok(()) => {
                    if let Some(status) = statuses.get_mut(&binding.action) {
                        status.registered = true;
                        status.error = None;
                        status.error_kind = None;
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        action = binding.action.as_str(),
                        accelerator = binding.accelerator.as_str(),
                        "快捷键启动注册失败: {}",
                        error.message()
                    );
                    if let Some(status) = statuses.get_mut(&binding.action) {
                        status.registered = false;
                        status.error = Some(error.message().to_string());
                        status.error_kind = Some(error.kind().to_string());
                    }
                }
            }
        }

        let mut inner = Inner {
            bindings,
            statuses,
            load_error,
            specs: Vec::new(),
        };
        rebuild_specs(&mut inner);
        *self.lock() = inner;
    }

    /// 拉取快照，并复核系统级组合是否真的仍注册在插件里。
    pub fn snapshot(&self) -> HotkeySnapshot {
        let checks: Vec<(String, String)> = {
            let inner = self.lock();
            inner
                .bindings
                .iter()
                .filter(|b| b.scope == HotkeyScope::SystemGlobal && b.enabled)
                .map(|b| (b.action.clone(), b.accelerator.clone()))
                .collect()
        };

        // 注册表查询需要主线程往返，期间不持有 `inner` 锁（避免与主线程上的
        // 快捷键事件互相等待）；结果提交前会核对绑定是否已被并发修改。
        let actual: Vec<(String, String, bool)> = checks
            .iter()
            .map(|(action, accelerator)| {
                (
                    action.clone(),
                    accelerator.clone(),
                    self.registrar.is_registered(accelerator),
                )
            })
            .collect();

        let mut inner = self.lock();
        for (action, accelerator, registered) in actual {
            let current = inner
                .bindings
                .iter()
                .find(|b| b.action == action)
                .map(|b| b.accelerator.clone());
            if current.as_deref() != Some(accelerator.as_str()) {
                // 快照期间该动作已被修改：丢弃过期结果，不覆盖新的注册状态。
                continue;
            }
            let Some(status) = inner.statuses.get_mut(&action) else {
                continue;
            };
            if registered {
                status.registered = true;
                if status.error_kind.as_deref() == Some("verification") {
                    status.error = None;
                    status.error_kind = None;
                }
            } else if status.registered {
                status.registered = false;
                status.error = Some(
                    "系统级注册已失效（可能被其他程序抢占或注册被系统撤销），请重新应用或重启应用"
                        .to_string(),
                );
                status.error_kind = Some("verification".to_string());
            }
        }
        rebuild_specs(&mut inner);
        HotkeySnapshot {
            bindings: build_views(&inner),
            load_error: inner.load_error.clone(),
        }
    }

    /// 修改/禁用单条快捷键（安全替换 + 回滚）。
    ///
    /// 变更在本地副本上完成，注册/持久化期间不持有 `inner` 锁；
    /// 结束后一次性提交状态，避免主线程快捷键事件被长事务阻塞。
    pub fn change(
        &self,
        action: &str,
        accelerator: Option<&str>,
        enabled: Option<bool>,
    ) -> AppResult<HotkeyChangeOutcome> {
        let _transaction = self
            .change_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut working = {
            let inner = self.lock();
            Inner {
                bindings: inner.bindings.clone(),
                statuses: inner.statuses.clone(),
                load_error: inner.load_error.clone(),
                specs: Vec::new(),
            }
        };
        let result = self.change_work(&mut working, action, accelerator, enabled);
        {
            let mut inner = self.lock();
            inner.bindings = working.bindings;
            inner.statuses = working.statuses;
            rebuild_specs(&mut inner);
        }
        result
    }

    fn change_work(
        &self,
        inner: &mut Inner,
        action: &str,
        accelerator: Option<&str>,
        enabled: Option<bool>,
    ) -> AppResult<HotkeyChangeOutcome> {
        let def = find_def(action)
            .ok_or_else(|| AppError::NotFound(format!("未知快捷键动作：{action}")))?;
        let idx = inner
            .bindings
            .iter()
            .position(|b| b.action == action)
            .ok_or_else(|| AppError::NotFound(format!("快捷键动作未加载：{action}")))?;
        let current = inner.bindings[idx].clone();
        let previous_accelerator = current.accelerator.clone();

        let new_accelerator = match accelerator {
            Some(raw) => match model::validate_accelerator(raw) {
                Ok(accelerator) => accelerator,
                Err(message) => {
                    return Ok(make_outcome(
                        &*inner,
                        def,
                        &current,
                        &previous_accelerator,
                        false,
                        false,
                        false,
                        None,
                        Some(message),
                        Some("invalid"),
                    ));
                }
            },
            None => current.accelerator.clone(),
        };
        let new_enabled = enabled.unwrap_or(current.enabled);
        let current_status = inner
            .statuses
            .get(action)
            .cloned()
            .unwrap_or_default();
        // 系统级「已启用但注册已失效」的条目允许用相同组合重新应用：
        // 否则快照提示的「请重新应用」会变成空操作，用户只能重启应用。
        let needs_retry = def.scope == HotkeyScope::SystemGlobal
            && current.enabled
            && new_enabled
            && !current_status.registered;

        if new_accelerator == current.accelerator
            && new_enabled == current.enabled
            && !needs_retry
        {
            return Ok(make_outcome(
                &*inner,
                def,
                &current,
                &previous_accelerator,
                true,
                false,
                false,
                None,
                None,
                None,
            ));
        }

        if new_enabled {
            if let Some(other) = model::conflict_with(&inner.bindings, action, &new_accelerator) {
                let other_label = find_def(&other.action)
                    .map(|d| d.label)
                    .unwrap_or(other.action.as_str());
                return Ok(make_outcome(
                    &*inner,
                    def,
                    &current,
                    &previous_accelerator,
                    false,
                    false,
                    false,
                    None,
                    Some(format!(
                        "组合 {new_accelerator} 已分配给「{other_label}」，请先修改或禁用那一条"
                    )),
                    Some("conflict"),
                ));
            }
        }

        let candidate = HotkeyBinding {
            action: action.to_string(),
            scope: def.scope,
            accelerator: new_accelerator.clone(),
            enabled: new_enabled,
        };
        let mut next = inner.bindings.clone();
        next[idx] = candidate.clone();

        if def.scope == HotkeyScope::AppLocal {
            if let Err(message) = self.persist(&next) {
                return Ok(make_outcome(
                    &*inner,
                    def,
                    &current,
                    &previous_accelerator,
                    false,
                    false,
                    false,
                    None,
                    Some(format!("保存失败，快捷键未修改：{message}")),
                    Some("persist_failed"),
                ));
            }
            inner.bindings = next;
            inner.statuses.insert(
                action.to_string(),
                BindingStatus {
                    registered: new_enabled,
                    error: None,
                    error_kind: None,
                },
            );
            rebuild_specs(inner);
            return Ok(make_outcome(
                &*inner,
                def,
                &candidate,
                &previous_accelerator,
                true,
                true,
                false,
                None,
                None,
                None,
            ));
        }

        // 以下为系统级：每一步失败都保留原绑定。
        let status = inner
            .statuses
            .get(action)
            .cloned()
            .unwrap_or_default();
        let was_registered = status.registered;
        let old_accelerator = current.accelerator.clone();

        if !new_enabled {
            if was_registered {
                if let Err(message) = self.registrar.unregister(&old_accelerator) {
                    inner.statuses.insert(
                        action.to_string(),
                        BindingStatus {
                            registered: true,
                            error: Some(format!("注销失败，仍保持原快捷键：{message}")),
                            error_kind: Some("unregister_failed".to_string()),
                        },
                    );
                    return Ok(make_outcome(
                        &*inner,
                        def,
                        &current,
                        &previous_accelerator,
                        false,
                        false,
                        false,
                        None,
                        Some(format!("注销失败，仍保持原快捷键：{message}")),
                        Some("unregister_failed"),
                    ));
                }
            }
            if let Err(message) = self.persist(&next) {
                let rollback = if was_registered {
                    self.registrar.register(&old_accelerator)
                } else {
                    Ok(())
                };
                let rollback_ok = rollback.is_ok();
                let rollback_note = match rollback {
                    Ok(()) => "已重新注册原快捷键".to_string(),
                    Err(error) => {
                        format!("原快捷键重新注册失败：{}", error.message())
                    }
                };
                inner.statuses.insert(
                    action.to_string(),
                    BindingStatus {
                        registered: was_registered && rollback_ok,
                        error: Some(format!(
                            "保存禁用状态失败（{message}），{rollback_note}"
                        )),
                        error_kind: Some("persist_failed".to_string()),
                    },
                );
                return Ok(make_outcome(
                    &*inner,
                    def,
                    &current,
                    &previous_accelerator,
                    false,
                    false,
                    true,
                    Some(rollback_ok),
                    Some(format!("保存禁用状态失败（{message}），{rollback_note}")),
                    Some("persist_failed"),
                ));
            }
            inner.bindings = next;
            inner.statuses.insert(
                action.to_string(),
                BindingStatus {
                    registered: false,
                    error: None,
                    error_kind: None,
                },
            );
            rebuild_specs(inner);
            return Ok(make_outcome(
                &*inner,
                def,
                &candidate,
                &previous_accelerator,
                true,
                true,
                false,
                None,
                None,
                None,
            ));
        }

        let need_register = !(was_registered && old_accelerator == new_accelerator);
        if need_register {
            if let Err(error) = self.registrar.register(&new_accelerator) {
                let message = format!("注册失败，已保留原快捷键：{}", error.message());
                inner.statuses.insert(
                    action.to_string(),
                    BindingStatus {
                        registered: was_registered,
                        error: Some(message.clone()),
                        error_kind: Some(error.kind().to_string()),
                    },
                );
                return Ok(make_outcome(
                    &*inner,
                    def,
                    &current,
                    &previous_accelerator,
                    false,
                    false,
                    false,
                    None,
                    Some(message),
                    Some(error.kind()),
                ));
            }
        }

        if let Err(message) = self.persist(&next) {
            let mut rollback_ok = true;
            if need_register {
                if let Err(error) = self.registrar.unregister(&new_accelerator) {
                    rollback_ok = false;
                    tracing::warn!("新组合回滚注销失败: {error}");
                }
            }
            let message = if rollback_ok {
                format!("保存配置失败（{message}），已回滚到原快捷键")
            } else {
                format!("保存配置失败（{message}），且新组合注销失败，可能与原快捷键同时生效")
            };
            inner.statuses.insert(
                action.to_string(),
                BindingStatus {
                    registered: was_registered,
                    error: Some(message.clone()),
                    error_kind: Some("persist_failed".to_string()),
                },
            );
            return Ok(make_outcome(
                &*inner,
                def,
                &current,
                &previous_accelerator,
                false,
                false,
                true,
                Some(rollback_ok),
                Some(message),
                Some("persist_failed"),
            ));
        }

        if need_register && was_registered && old_accelerator != new_accelerator {
            if let Err(message) = self.registrar.unregister(&old_accelerator) {
                // 旧组合未注销成功：撤销新组合并回写旧配置，确保不会同时生效。
                let unregister_new = self.registrar.unregister(&new_accelerator);
                let restore = self.persist(&inner.bindings);
                let rollback_ok = unregister_new.is_ok() && restore.is_ok();
                let note = if rollback_ok {
                    format!("旧组合注销失败（{message}），已回滚到原快捷键")
                } else {
                    format!(
                        "旧组合注销失败（{message}），且回滚未完成：新旧组合可能同时生效，请重启应用"
                    )
                };
                inner.statuses.insert(
                    action.to_string(),
                    BindingStatus {
                        registered: was_registered,
                        error: Some(note.clone()),
                        error_kind: Some("unregister_failed".to_string()),
                    },
                );
                return Ok(make_outcome(
                    &*inner,
                    def,
                    &current,
                    &previous_accelerator,
                    false,
                    false,
                    true,
                    Some(rollback_ok),
                    Some(note),
                    Some("unregister_failed"),
                ));
            }
        }

        inner.bindings = next;
        inner.statuses.insert(
            action.to_string(),
            BindingStatus {
                registered: true,
                error: None,
                error_kind: None,
            },
        );
        rebuild_specs(inner);
        Ok(make_outcome(
            &*inner,
            def,
            &candidate,
            &previous_accelerator,
            true,
            true,
            false,
            None,
            None,
            None,
        ))
    }

    /// 从备份应用快捷键配置。
    ///
    /// 顺序：校验/合并 → 注销当前系统级组合 → 逐条注册 → 失败降级默认或禁用 →
    /// 持久化最终生效配置。任一步失败都如实返回；注册失败绝不被包装成成功。
    /// 未能完全按备份应用时，把原始配置另存为 `hotkeys.restore-pending.json`。
    pub fn apply_restored_config(
        &self,
        data_dir: &Path,
        config: &HotkeyConfigFile,
    ) -> HotkeyRestoreReport {
        let _transaction = self
            .change_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let working = {
            let inner = self.lock();
            Inner {
                bindings: inner.bindings.clone(),
                statuses: inner.statuses.clone(),
                load_error: inner.load_error.clone(),
                specs: Vec::new(),
            }
        };
        // build_bindings 负责：非法组合回退默认、重复组合自动禁用后一条、
        // 未知动作忽略，并把 issues 作为可展示警告返回。
        let (mut bindings, issues) = model::build_bindings(Some(config), None);
        let mut warnings = issues;

        // 当前真正注册在系统上的组合：只注销这些，避免误伤未注册配置。
        let mut old_system: Vec<String> = working
            .bindings
            .iter()
            .filter(|b| b.scope == HotkeyScope::SystemGlobal && b.enabled)
            .filter(|b| {
                working
                    .statuses
                    .get(&b.action)
                    .map(|s| s.registered)
                    .unwrap_or(false)
            })
            .map(|b| b.accelerator.clone())
            .collect();
        old_system.sort();
        old_system.dedup();

        let mut unregistered: Vec<String> = Vec::new();
        for accelerator in &old_system {
            if let Err(message) = self.registrar.unregister(accelerator) {
                // 尽量回到进入本函数前的注册状态，再如实报告失败。
                for done in &unregistered {
                    if let Err(error) = self.registrar.register(done) {
                        warnings.push(format!(
                            "回滚注册原快捷键 {done} 失败：{}",
                            error.message()
                        ));
                    }
                }
                warnings.push(format!(
                    "无法注销当前快捷键 {accelerator}（{message}），本次保留原快捷键配置"
                ));
                return HotkeyRestoreReport {
                    applied: 0,
                    disabled: 0,
                    warnings,
                    pending_saved: false,
                    persisted: false,
                };
            }
            unregistered.push(accelerator.clone());
        }

        let mut statuses: HashMap<String, BindingStatus> = HashMap::new();
        for binding in &bindings {
            statuses.insert(
                binding.action.clone(),
                BindingStatus {
                    // 应用内组合不需要 OS 注册；启用即视为生效。
                    registered: binding.scope == HotkeyScope::AppLocal && binding.enabled,
                    error: None,
                    error_kind: None,
                },
            );
        }

        let mut applied = 0usize;
        let mut disabled = 0usize;
        for index in 0..bindings.len() {
            if bindings[index].scope != HotkeyScope::SystemGlobal || !bindings[index].enabled {
                continue;
            }
            let original = bindings[index].accelerator.clone();
            match self.registrar.register(&original) {
                Ok(()) => {
                    applied += 1;
                    if let Some(status) = statuses.get_mut(&bindings[index].action) {
                        status.registered = true;
                    }
                }
                Err(error) => {
                    let Some(def) = find_def(&bindings[index].action) else {
                        continue;
                    };
                    let fallback = def.default_accelerator.to_string();
                    let fallback_taken = bindings.iter().enumerate().any(|(other, binding)| {
                        other != index && binding.enabled && binding.accelerator == fallback
                    });
                    let fallback_ok = fallback != original
                        && !fallback_taken
                        && self.registrar.register(&fallback).is_ok();
                    if fallback_ok {
                        warnings.push(format!(
                            "「{}」的组合 {} 无法注册（{}），已降级为默认 {}",
                            def.label,
                            original,
                            error.message(),
                            fallback
                        ));
                        bindings[index].accelerator = fallback;
                        applied += 1;
                        if let Some(status) = statuses.get_mut(&bindings[index].action) {
                            status.registered = true;
                            status.error = None;
                            status.error_kind = None;
                        }
                    } else {
                        let note = format!(
                            "「{}」的组合 {} 无法注册（{}），本次已禁用该快捷键；原配置已保留在 {}",
                            def.label,
                            original,
                            error.message(),
                            store::PENDING_RESTORE_FILE
                        );
                        warnings.push(note.clone());
                        bindings[index].enabled = false;
                        disabled += 1;
                        if let Some(status) = statuses.get_mut(&bindings[index].action) {
                            status.registered = false;
                            status.error = Some(note);
                            status.error_kind = Some(error.kind().to_string());
                        }
                    }
                }
            }
        }

        if let Err(error) = self.persist(&bindings) {
            // 配置文件未变：把系统级注册回滚到进入本函数前的状态。
            for binding in bindings
                .iter()
                .filter(|b| b.scope == HotkeyScope::SystemGlobal && b.enabled)
            {
                if !old_system.contains(&binding.accelerator) {
                    let _ = self.registrar.unregister(&binding.accelerator);
                }
            }
            let mut restore_failed = Vec::new();
            for accelerator in &old_system {
                if let Err(message) = self.registrar.register(accelerator) {
                    restore_failed.push(message.message().to_string());
                }
            }
            warnings.push(format!(
                "保存恢复后的快捷键失败（{error}），已尝试恢复原快捷键配置"
            ));
            if !restore_failed.is_empty() {
                warnings.push(format!(
                    "原快捷键重新注册失败：{}",
                    restore_failed.join("；")
                ));
            }
            return HotkeyRestoreReport {
                applied: 0,
                disabled: 0,
                warnings,
                pending_saved: false,
                persisted: false,
            };
        }

        {
            let mut inner = self.lock();
            inner.bindings = bindings;
            inner.statuses = statuses;
            rebuild_specs(&mut inner);
        }

        let pending_saved = if warnings.is_empty() {
            store::clear_pending_config(data_dir);
            false
        } else {
            match store::save_pending_config(data_dir, config) {
                Ok(()) => true,
                Err(error) => {
                    warnings.push(format!("保存待解决快捷键原配置失败：{error}"));
                    false
                }
            }
        };
        HotkeyRestoreReport {
            applied,
            disabled,
            warnings,
            pending_saved,
            persisted: true,
        }
    }

    /// 恢复默认：传 `action` 时只恢复一项，否则恢复全部（逐项安全应用）。
    pub fn reset(&self, action: Option<&str>) -> AppResult<HotkeyResetOutcome> {
        let targets: Vec<&'static ActionDef> = match action {
            Some(action) => vec![find_def(action)
                .ok_or_else(|| AppError::NotFound(format!("未知快捷键动作：{action}")))?],
            None => ACTIONS.iter().collect(),
        };
        let mut results = Vec::with_capacity(targets.len());
        for def in &targets {
            let result = self.change(def.id, Some(def.default_accelerator), Some(true))?;
            results.push(result);
        }
        // 第二遍：首遍可能只是默认组合仍被另一条「同样等待恢复默认」的快捷键占用
        // （例如两条组合互换）。其余动作已恢复默认后腾出了组合，这里只重试内部冲突。
        if action.is_none() {
            for (index, def) in targets.iter().enumerate() {
                let retry = !results[index].ok
                    && results[index].error_kind.as_deref() == Some("conflict");
                if !retry {
                    continue;
                }
                let result = self.change(def.id, Some(def.default_accelerator), Some(true))?;
                if result.ok {
                    results[index] = result;
                }
            }
        }
        let ok = results.iter().all(|r| r.ok);
        Ok(HotkeyResetOutcome {
            ok,
            results,
            error: if ok {
                None
            } else {
                Some("部分快捷键未能恢复默认，详见逐项结果".to_string())
            },
        })
    }

    /// 旧版「全局快捷键」总开关：统一启停所有系统级动作。
    pub fn set_all_system_enabled(&self, enabled: bool) -> AppResult<HotkeyResetOutcome> {
        let mut results = Vec::new();
        for def in ACTIONS.iter().filter(|d| d.scope == HotkeyScope::SystemGlobal) {
            let result = self.change(def.id, None, Some(enabled))?;
            results.push(result);
        }
        let ok = results.iter().all(|r| r.ok);
        Ok(HotkeyResetOutcome {
            ok,
            results,
            error: if ok {
                None
            } else {
                Some("部分系统级快捷键未能应用，详见逐项结果".to_string())
            },
        })
    }

    /// 全局按键 → 动作 ID；未注册/未启用时返回 None（不吞按键）。
    pub fn match_system_shortcut(
        &self,
        shortcut: &tauri_plugin_global_shortcut::Shortcut,
    ) -> Option<String> {
        let inner = self.lock();
        inner
            .specs
            .iter()
            .find(|(spec, _)| spec.mods == shortcut.mods && spec.key == shortcut.key)
            .map(|(_, action)| action.clone())
    }

    fn persist(&self, bindings: &[HotkeyBinding]) -> Result<(), String> {
        self.store.save(&HotkeyConfigFile::from_bindings(bindings))
    }
}

fn rebuild_specs(inner: &mut Inner) {
    inner.specs.clear();
    for binding in &inner.bindings {
        if binding.scope != HotkeyScope::SystemGlobal || !binding.enabled {
            continue;
        }
        let registered = inner
            .statuses
            .get(&binding.action)
            .map(|s| s.registered)
            .unwrap_or(false);
        if !registered {
            continue;
        }
        match model::to_plugin_accelerator(&binding.accelerator)
            .parse::<tauri_plugin_global_shortcut::Shortcut>()
        {
            Ok(shortcut) => inner.specs.push((shortcut, binding.action.clone())),
            Err(error) => {
                tracing::warn!(
                    accelerator = binding.accelerator.as_str(),
                    "已注册快捷键无法解析，跳过分发: {error}"
                );
            }
        }
    }
}

fn build_views(inner: &Inner) -> Vec<HotkeyBindingView> {
    inner
        .bindings
        .iter()
        .filter_map(|binding| {
            let def = find_def(&binding.action)?;
            let status = inner.statuses.get(&binding.action).cloned().unwrap_or_default();
            let state = if !binding.enabled {
                "disabled"
            } else if status.error_kind.as_deref() == Some("invalid") {
                "invalid"
            } else if binding.scope == HotkeyScope::SystemGlobal && !status.registered {
                // 已启用但当前没有注册成功：有失败原因时是冲突，否则是未注册。
                if status.error_kind.is_some() {
                    "conflict"
                } else {
                    "unavailable"
                }
            } else {
                "active"
            };
            Some(HotkeyBindingView {
                action: binding.action.clone(),
                label: def.label.to_string(),
                description: def.description.to_string(),
                scope: binding.scope,
                accelerator: binding.accelerator.clone(),
                default_accelerator: def.default_accelerator.to_string(),
                enabled: binding.enabled,
                is_default: binding.enabled
                    && binding.accelerator == def.default_accelerator,
                state: state.to_string(),
                message: status.error,
            })
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn make_outcome(
    inner: &Inner,
    def: &ActionDef,
    binding: &HotkeyBinding,
    previous_accelerator: &str,
    ok: bool,
    persisted: bool,
    rolled_back: bool,
    rollback_ok: Option<bool>,
    error: Option<String>,
    error_kind: Option<&str>,
) -> HotkeyChangeOutcome {
    let status = inner
        .statuses
        .get(&binding.action)
        .cloned()
        .unwrap_or_default();
    let state = if !binding.enabled {
        "disabled"
    } else if status.error_kind.as_deref() == Some("invalid") {
        "invalid"
    } else if binding.scope == HotkeyScope::SystemGlobal && !status.registered {
        if status.error_kind.is_some() {
            "conflict"
        } else {
            "unavailable"
        }
    } else {
        "active"
    };
    HotkeyChangeOutcome {
        ok,
        action: binding.action.clone(),
        binding: HotkeyBindingView {
            action: binding.action.clone(),
            label: def.label.to_string(),
            description: def.description.to_string(),
            scope: binding.scope,
            accelerator: binding.accelerator.clone(),
            default_accelerator: def.default_accelerator.to_string(),
            enabled: binding.enabled,
            is_default: binding.enabled && binding.accelerator == def.default_accelerator,
            state: state.to_string(),
            message: status.error,
        },
        previous_accelerator: previous_accelerator.to_string(),
        persisted,
        rolled_back,
        rollback_ok,
        error,
        error_kind: error_kind.map(|s| s.to_string()),
    }
}

/// 应用启动时调用一次（setup 内）：构建管理器并注册系统级快捷键。
///
/// 幂等：重复调用直接返回。否则第二份管理器会再次注册同一组合，注册失败
/// 后又被单例写入丢弃，可能留下无人分发的系统级注册（按键被消费但无动作）。
pub fn init(app: &AppHandle, legacy_system_enabled: bool) {
    if MANAGER.get().is_some() {
        tracing::warn!("快捷键模块已初始化，忽略重复调用");
        return;
    }
    let store = Arc::new(store::FileHotkeyStore::new(
        crate::app_data_dir(app).join("hotkeys.json"),
    ));
    let registrar = Arc::new(registry::TauriRegistrar::new(app.clone()));
    let manager = Arc::new(HotkeysManager::new(store, registrar));
    manager.bootstrap(legacy_system_enabled);
    if let Some(error) = manager.snapshot().load_error {
        tracing::warn!("快捷键配置加载提示: {error}");
    }
    if MANAGER.set(manager).is_err() {
        tracing::warn!("快捷键模块重复初始化，忽略后一次调用");
    }
}

pub fn manager() -> Option<&'static Arc<HotkeysManager>> {
    MANAGER.get()
}

/// 从备份恢复快捷键（供恢复流程调用）。
///
/// - 管理器已初始化：注销旧组合 → 注册新组合 → 校验 → 原子落盘；
/// - 启动续跑阶段管理器尚未初始化：只把归一化后的配置写入 `hotkeys.json`，
///   由随后的 `init()` 统一注册，并明确返回「将在下次启动注册」的警告；
/// - 任何情况下都不修改任务数据库。
pub fn restore_from_bundle(data_dir: &Path, config: &HotkeyConfigFile) -> HotkeyRestoreReport {
    if let Some(manager) = manager() {
        return manager.apply_restored_config(data_dir, config);
    }
    restore_config_file_only(data_dir, config)
}

/// 管理器未初始化时的文件级恢复（也可在单元测试中直接验证）。
pub(crate) fn restore_config_file_only(
    data_dir: &Path,
    config: &HotkeyConfigFile,
) -> HotkeyRestoreReport {
    let (bindings, issues) = model::build_bindings(Some(config), None);
    let normalized = HotkeyConfigFile::from_bindings(&bindings);
    let mut warnings = issues.clone();
    let path = data_dir.join("hotkeys.json");
    match store::save_config_atomic(&path, &normalized) {
        Ok(()) => {
            warnings.push(
                "快捷键模块尚未初始化：配置已写入，将在下次启动时注册并校验".to_string(),
            );
        }
        Err(error) => {
            warnings.push(format!("写入恢复后的快捷键配置失败：{error}"));
        }
    }
    let pending_saved = if issues.is_empty() {
        store::clear_pending_config(data_dir);
        false
    } else {
        match store::save_pending_config(data_dir, config) {
            Ok(()) => true,
            Err(error) => {
                warnings.push(format!("保存待解决快捷键原配置失败：{error}"));
                false
            }
        }
    };
    HotkeyRestoreReport {
        // 管理器未初始化时没有真正向系统注册，不能用“已应用条数”伪装成功。
        applied: 0,
        disabled: 0,
        warnings,
        pending_saved,
        persisted: path.exists(),
    }
}

/// global-shortcut 插件回调：匹配已注册的系统级动作并执行。
/// 返回 `true` 表示按键已消费；未知按键返回 `false`，不改变原有行为。
pub fn handle_shortcut(
    app: &AppHandle,
    shortcut: &tauri_plugin_global_shortcut::Shortcut,
) -> bool {
    let Some(manager) = manager() else {
        return false;
    };
    let action = manager.match_system_shortcut(shortcut);
    match action.as_deref() {
        Some("toggle_main_window") => {
            crate::toggle_main(app);
            true
        }
        Some("open_quick_capture") => {
            crate::quick_capture::toggle(app);
            true
        }
        Some(other) => {
            // 系统级动作尚未接执行器：明确告警，绝不伪装成功。
            tracing::warn!(action = other, "系统级快捷键缺少执行器");
            false
        }
        None => false,
    }
}

/// 修改后通知设置页刷新快照。
pub fn emit_changed(app: &AppHandle) {
    let _ = app.emit(EVENT_CHANGED, ());
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    use super::*;
    use crate::hotkeys::registry::RegisterError;

    #[derive(Default)]
    struct FakeRegistrar {
        registered: Mutex<Vec<String>>,
        fail_register: AtomicBool,
        /// 仅针对这个组合失败；None 表示所有注册都失败。
        fail_accelerator: Mutex<Option<String>>,
        fail_unregister: AtomicBool,
        /// 仅针对这个组合注销失败；None 表示不启用定向失败。
        fail_unregister_for: Mutex<Option<String>>,
    }

    impl FakeRegistrar {
        fn new() -> Arc<Self> {
            Arc::new(Self::default())
        }

        /// 所有系统级注册都返回“被占用”（用于验证启动状态展示）。
        fn occupied(_message: &str) -> Arc<Self> {
            let fake = Arc::new(Self::default());
            fake.fail_register.store(true, Ordering::SeqCst);
            *fake.fail_accelerator.lock().unwrap() = None;
            fake
        }

        /// 只让指定组合注册失败，其余正常（用于验证修改时保留旧绑定）。
        fn occupied_for(accelerator: &str) -> Arc<Self> {
            let fake = Arc::new(Self::default());
            fake.fail_register.store(true, Ordering::SeqCst);
            *fake.fail_accelerator.lock().unwrap() = Some(accelerator.to_string());
            fake
        }

        fn unregister_failure_for(accelerator: &str) -> Arc<Self> {
            let fake = Arc::new(Self::default());
            *fake.fail_unregister_for.lock().unwrap() = Some(accelerator.to_string());
            fake
        }
    }

    impl ShortcutRegistrar for FakeRegistrar {
        fn register(&self, accelerator: &str) -> Result<(), RegisterError> {
            if self.fail_register.load(Ordering::SeqCst) {
                let target = self.fail_accelerator.lock().unwrap().clone();
                let matches = target.as_deref().map(|t| t == accelerator).unwrap_or(true);
                if matches {
                    return Err(RegisterError::Occupied("该组合已被其他程序占用".to_string()));
                }
            }
            let mut registered = self.registered.lock().unwrap();
            if registered.iter().any(|a| a == accelerator) {
                return Err(RegisterError::Occupied("already registered".to_string()));
            }
            registered.push(accelerator.to_string());
            Ok(())
        }

        fn unregister(&self, accelerator: &str) -> Result<(), String> {
            let targeted = self.fail_unregister_for.lock().unwrap().clone();
            if self.fail_unregister.load(Ordering::SeqCst)
                || targeted.as_deref() == Some(accelerator)
            {
                return Err("模拟注销失败".to_string());
            }
            let mut registered = self.registered.lock().unwrap();
            registered.retain(|a| a != accelerator);
            Ok(())
        }

        fn is_registered(&self, accelerator: &str) -> bool {
            self.registered
                .lock()
                .unwrap()
                .iter()
                .any(|a| a == accelerator)
        }
    }

    struct MemStore {
        saved: Mutex<Option<HotkeyConfigFile>>,
        fail_save: AtomicBool,
        fail_save_times: Mutex<usize>,
    }

    impl MemStore {
        fn new(fail_save_times: usize) -> Arc<Self> {
            Arc::new(Self {
                saved: Mutex::new(None),
                fail_save: AtomicBool::new(fail_save_times > 0),
                fail_save_times: Mutex::new(fail_save_times),
            })
        }
    }

    impl store::HotkeyStore for MemStore {
        fn load(&self) -> Result<Option<HotkeyConfigFile>, String> {
            Ok(self.saved.lock().unwrap().clone())
        }

        fn save(&self, config: &HotkeyConfigFile) -> Result<(), String> {
            let mut times = self.fail_save_times.lock().unwrap();
            if *times > 0 {
                *times -= 1;
                self.fail_save.store(*times > 0, Ordering::SeqCst);
                return Err("模拟写入失败".to_string());
            }
            *self.saved.lock().unwrap() = Some(config.clone());
            Ok(())
        }
    }

    fn manager(
        store: Arc<MemStore>,
        registrar: Arc<FakeRegistrar>,
    ) -> HotkeysManager {
        let manager = HotkeysManager::new(store, registrar);
        manager.bootstrap(true);
        manager
    }

    fn system_action(manager: &HotkeysManager, action: &str) -> HotkeyBindingView {
        manager
            .snapshot()
            .bindings
            .into_iter()
            .find(|b| b.action == action)
            .unwrap()
    }

    #[test]
    fn bootstrap_registers_enabled_system_scopes_only() {
        let registrar = FakeRegistrar::new();
        let store = MemStore::new(0);
        let manager = manager(store, registrar.clone());
        let snapshot = manager.snapshot();
        assert_eq!(snapshot.bindings.len(), ACTIONS.len());
        assert!(snapshot.load_error.is_none());
        let toggle = system_action(&manager, "toggle_main_window");
        assert_eq!(toggle.state, "active");
        assert!(registrar.is_registered("Ctrl+Alt+T"));
        assert!(registrar.is_registered("Ctrl+Shift+Space"));
        // 应用内动作不会走 OS 注册器。
        assert!(!registrar.is_registered("Ctrl+K"));
        let quick = system_action(&manager, "quick_add_task");
        assert_eq!(quick.state, "active");
        assert_eq!(quick.scope, HotkeyScope::AppLocal);
    }

    #[test]
    fn bootstrap_marks_occupied_shortcut_as_conflict() {
        let registrar = FakeRegistrar::occupied("模拟被占用");
        let manager = manager(MemStore::new(0), registrar);
        let toggle = system_action(&manager, "toggle_main_window");
        assert_eq!(toggle.state, "conflict");
        assert!(toggle.message.unwrap().contains("占用"));
    }

    #[test]
    fn app_local_change_persists_and_updates_binding() {
        let store = MemStore::new(0);
        let manager = manager(store.clone(), FakeRegistrar::new());
        let outcome = manager
            .change("quick_add_task", Some("Ctrl+Shift+K"), None)
            .unwrap();
        assert!(outcome.ok);
        assert!(outcome.persisted);
        assert_eq!(outcome.binding.accelerator, "Ctrl+Shift+K");
        assert_eq!(outcome.previous_accelerator, "Ctrl+K");
        let saved = store.saved.lock().unwrap().clone().unwrap();
        assert!(saved
            .bindings
            .iter()
            .any(|b| b.action == "quick_add_task" && b.accelerator == "Ctrl+Shift+K"));
    }

    #[test]
    fn app_local_conflict_is_rejected_without_saving() {
        let store = MemStore::new(0);
        let manager = manager(store.clone(), FakeRegistrar::new());
        let outcome = manager
            .change("quick_add_task", Some("Ctrl+1"), None)
            .unwrap();
        assert!(!outcome.ok);
        assert_eq!(outcome.error_kind.as_deref(), Some("conflict"));
        assert_eq!(outcome.binding.accelerator, "Ctrl+K");
        assert!(outcome.error.unwrap().contains("切换到任务"));
        assert!(store.saved.lock().unwrap().is_none());
    }

    #[test]
    fn cross_scope_conflict_is_rejected() {
        let manager = manager(MemStore::new(0), FakeRegistrar::new());
        let outcome = manager
            .change("quick_add_task", Some("Ctrl+Alt+T"), None)
            .unwrap();
        assert!(!outcome.ok);
        assert_eq!(outcome.error_kind.as_deref(), Some("conflict"));
    }

    #[test]
    fn invalid_and_reserved_combinations_are_rejected() {
        let manager = manager(MemStore::new(0), FakeRegistrar::new());
        let outcome = manager.change("quick_add_task", Some("Ctrl"), None).unwrap();
        assert_eq!(outcome.error_kind.as_deref(), Some("invalid"));
        let outcome = manager
            .change("quick_add_task", Some("Alt+F4"), None)
            .unwrap();
        assert_eq!(outcome.error_kind.as_deref(), Some("invalid"));
        assert!(outcome.error.unwrap().contains("系统保留"));
    }

    #[test]
    fn system_change_registers_new_before_unregistering_old() {
        let registrar = FakeRegistrar::new();
        let manager = manager(MemStore::new(0), registrar.clone());
        let outcome = manager
            .change("toggle_main_window", Some("Ctrl+Alt+Y"), None)
            .unwrap();
        assert!(outcome.ok);
        assert_eq!(outcome.binding.accelerator, "Ctrl+Alt+Y");
        assert!(registrar.is_registered("Ctrl+Alt+Y"));
        assert!(!registrar.is_registered("Ctrl+Alt+T"));
        let matched = manager
            .match_system_shortcut(&"Ctrl+Alt+Y".parse().unwrap())
            .unwrap();
        assert_eq!(matched, "toggle_main_window");
    }

    #[test]
    fn system_registration_conflict_keeps_old_binding() {
        let registrar = FakeRegistrar::occupied_for("Ctrl+Alt+Y");
        let store = MemStore::new(0);
        let manager = manager(store.clone(), registrar.clone());
        let outcome = manager
            .change("toggle_main_window", Some("Ctrl+Alt+Y"), None)
            .unwrap();
        assert!(!outcome.ok);
        assert_eq!(outcome.binding.accelerator, "Ctrl+Alt+T");
        assert_eq!(outcome.error_kind.as_deref(), Some("occupied"));
        assert!(outcome.error.unwrap().contains("保留原快捷键"));
        assert!(outcome.rolled_back == false);
        // 旧绑定未被改动，且仍然注册着。
        assert!(!registrar.is_registered("Ctrl+Alt+Y"));
        assert_eq!(
            manager
                .match_system_shortcut(&"Ctrl+Alt+T".parse().unwrap())
                .unwrap(),
            "toggle_main_window"
        );
        assert!(store.saved.lock().unwrap().is_none());
    }

    #[test]
    fn persist_failure_rolls_back_new_registration() {
        let store = MemStore::new(1);
        let registrar = FakeRegistrar::new();
        let manager = manager(store.clone(), registrar.clone());
        let outcome = manager
            .change("toggle_main_window", Some("Ctrl+Alt+Y"), None)
            .unwrap();
        assert!(!outcome.ok);
        assert_eq!(outcome.error_kind.as_deref(), Some("persist_failed"));
        assert!(outcome.rolled_back);
        assert_eq!(outcome.rollback_ok, Some(true));
        assert!(!registrar.is_registered("Ctrl+Alt+Y"));
        assert!(registrar.is_registered("Ctrl+Alt+T"));
        assert!(store.saved.lock().unwrap().is_none());
        // 状态回到旧组合且仍可用。
        let binding = system_action(&manager, "toggle_main_window");
        assert_eq!(binding.accelerator, "Ctrl+Alt+T");
        assert_eq!(binding.state, "active");
    }

    #[test]
    fn old_unregister_failure_rolls_back_new_registration() {
        // 只让旧组合注销失败：新组合应被成功撤销，并回写旧配置。
        let registrar = FakeRegistrar::unregister_failure_for("Ctrl+Alt+T");
        let manager = manager(MemStore::new(0), registrar.clone());
        let outcome = manager
            .change("toggle_main_window", Some("Ctrl+Alt+Y"), None)
            .unwrap();
        assert!(!outcome.ok);
        assert_eq!(outcome.error_kind.as_deref(), Some("unregister_failed"));
        assert!(outcome.rolled_back);
        assert_eq!(outcome.rollback_ok, Some(true));
        assert!(!registrar.is_registered("Ctrl+Alt+Y"));
        assert!(registrar.is_registered("Ctrl+Alt+T"));
        let binding = system_action(&manager, "toggle_main_window");
        assert_eq!(binding.accelerator, "Ctrl+Alt+T");
        // 回滚写入了旧配置，避免重启后读到新组合。
        assert!(outcome.error.unwrap().contains("已回滚"));
    }

    #[test]
    fn disabling_system_shortcut_unregisters_and_persists() {
        let registrar = FakeRegistrar::new();
        let store = MemStore::new(0);
        let manager = manager(store.clone(), registrar.clone());
        let outcome = manager
            .change("toggle_main_window", None, Some(false))
            .unwrap();
        assert!(outcome.ok);
        assert!(!registrar.is_registered("Ctrl+Alt+T"));
        let binding = system_action(&manager, "toggle_main_window");
        assert_eq!(binding.state, "disabled");
        let saved = store.saved.lock().unwrap().clone().unwrap();
        assert!(saved
            .bindings
            .iter()
            .any(|b| b.action == "toggle_main_window" && !b.enabled));
        // 重新启用会重新注册。
        let outcome = manager
            .change("toggle_main_window", None, Some(true))
            .unwrap();
        assert!(outcome.ok);
        assert!(registrar.is_registered("Ctrl+Alt+T"));
    }

    #[test]
    fn disable_unregister_failure_keeps_binding_enabled() {
        let registrar = FakeRegistrar::new();
        let manager = manager(MemStore::new(0), registrar.clone());
        registrar.fail_unregister.store(true, Ordering::SeqCst);
        let outcome = manager
            .change("toggle_main_window", None, Some(false))
            .unwrap();
        assert!(!outcome.ok);
        assert_eq!(outcome.error_kind.as_deref(), Some("unregister_failed"));
        assert!(outcome.binding.enabled);
        assert!(registrar.is_registered("Ctrl+Alt+T"));
    }

    #[test]
    fn reset_restores_default_accelerator() {
        let manager = manager(MemStore::new(0), FakeRegistrar::new());
        let outcome = manager
            .change("quick_add_task", Some("Ctrl+Shift+K"), None)
            .unwrap();
        assert!(outcome.ok);
        let reset = manager.reset(Some("quick_add_task")).unwrap();
        assert!(reset.ok);
        assert_eq!(reset.results.len(), 1);
        assert_eq!(reset.results[0].binding.accelerator, "Ctrl+K");
        assert!(reset.results[0].binding.is_default);
    }

    #[test]
    fn set_all_system_enabled_toggles_both_system_actions() {
        let registrar = FakeRegistrar::new();
        let manager = manager(MemStore::new(0), registrar.clone());
        let outcome = manager.set_all_system_enabled(false).unwrap();
        assert!(outcome.ok);
        assert_eq!(outcome.results.len(), 2);
        assert!(!registrar.is_registered("Ctrl+Alt+T"));
        assert!(!registrar.is_registered("Ctrl+Shift+Space"));
        let outcome = manager.set_all_system_enabled(true).unwrap();
        assert!(outcome.ok);
        assert!(registrar.is_registered("Ctrl+Alt+T"));
    }

    #[test]
    fn same_accelerator_no_duplicate_registration() {
        let registrar = FakeRegistrar::new();
        let manager = manager(MemStore::new(0), registrar.clone());
        let outcome = manager
            .change("toggle_main_window", Some("Ctrl+Alt+T"), None)
            .unwrap();
        assert!(outcome.ok);
        assert!(!outcome.persisted);
        assert_eq!(outcome.binding.accelerator, "Ctrl+Alt+T");
        let count = registrar
            .registered
            .lock()
            .unwrap()
            .iter()
            .filter(|a| a.as_str() == "Ctrl+Alt+T")
            .count();
        assert_eq!(count, 1);
    }

    #[test]
    fn snapshot_detects_lost_registration() {
        let registrar = FakeRegistrar::new();
        let manager = manager(MemStore::new(0), registrar.clone());
        registrar
            .unregister("Ctrl+Alt+T")
            .unwrap();
        let binding = system_action(&manager, "toggle_main_window");
        assert_eq!(binding.state, "conflict");
        assert!(binding.message.unwrap().contains("已失效"));
        // 失效后不再参与全局分发，避免 UI 正常但实际无响应。
        assert!(manager
            .match_system_shortcut(&"Ctrl+Alt+T".parse().unwrap())
            .is_none());
    }

    #[test]
    fn bootstrap_with_legacy_switch_off_skips_registration() {
        let registrar = FakeRegistrar::new();
        let manager = HotkeysManager::new(MemStore::new(0), registrar.clone());
        manager.bootstrap(false);
        assert!(!registrar.is_registered("Ctrl+Alt+T"));
        let binding = system_action(&manager, "toggle_main_window");
        assert_eq!(binding.state, "disabled");
        let binding = system_action(&manager, "quick_add_task");
        assert_eq!(binding.state, "active");
    }

    #[test]
    fn reapplying_same_accelerator_retries_failed_system_registration() {
        let registrar = FakeRegistrar::occupied_for("Ctrl+Alt+T");
        let store = MemStore::new(0);
        let manager = manager(store.clone(), registrar.clone());
        // 启动注册失败：已启用但未注册，UI 会提示「重新应用或重启」。
        assert_eq!(system_action(&manager, "toggle_main_window").state, "conflict");
        assert!(!registrar.is_registered("Ctrl+Alt+T"));

        // 占用解除后，用相同组合重新应用必须真的重试，而不是被当成无变化空操作。
        registrar.fail_register.store(false, Ordering::SeqCst);
        let outcome = manager
            .change("toggle_main_window", Some("Ctrl+Alt+T"), None)
            .unwrap();
        assert!(outcome.ok);
        assert!(outcome.persisted);
        assert_eq!(outcome.binding.state, "active");
        assert!(registrar.is_registered("Ctrl+Alt+T"));
        assert_eq!(
            manager
                .match_system_shortcut(&"Ctrl+Alt+T".parse().unwrap())
                .unwrap(),
            "toggle_main_window"
        );
        assert!(store.saved.lock().unwrap().is_some());
    }

    #[test]
    fn reset_all_retries_after_conflicts_are_freed() {
        let manager = manager(MemStore::new(0), FakeRegistrar::new());
        // 制造组合互换：剪贴板占用「快速添加任务」的默认 Ctrl+K。
        assert!(manager
            .change("quick_add_task", Some("Ctrl+Alt+K"), None)
            .unwrap()
            .ok);
        assert!(manager
            .change("open_clipboard", Some("Ctrl+K"), None)
            .unwrap()
            .ok);

        let reset = manager.reset(None).unwrap();
        assert!(reset.ok, "全部恢复默认应在腾出组合后重试成功: {:?}", reset.error);
        let bindings = manager.snapshot().bindings;
        let quick = bindings
            .iter()
            .find(|b| b.action == "quick_add_task")
            .unwrap();
        let clipboard = bindings
            .iter()
            .find(|b| b.action == "open_clipboard")
            .unwrap();
        assert_eq!(quick.accelerator, "Ctrl+K");
        assert_eq!(clipboard.accelerator, "Ctrl+Shift+C");
    }

    #[test]
    fn meta_system_binding_matches_plugin_super_shortcut() {
        let registrar = FakeRegistrar::new();
        let manager = manager(MemStore::new(0), registrar.clone());
        let outcome = manager
            .change("toggle_main_window", Some("Meta+F9"), None)
            .unwrap();
        assert!(outcome.ok);
        assert_eq!(outcome.binding.accelerator, "Meta+F9");
        // 插件用 SUPER 表示 Windows 键；分发匹配必须走同一转换。
        assert_eq!(
            manager
                .match_system_shortcut(&"Super+F9".parse().unwrap())
                .unwrap(),
            "toggle_main_window"
        );
    }

    fn restore_temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "td-hotkey-restore-{}-{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn restore_config(bindings: Vec<HotkeyBinding>) -> HotkeyConfigFile {
        HotkeyConfigFile {
            version: CONFIG_VERSION,
            bindings,
        }
    }

    fn custom(
        action: &str,
        accelerator: &str,
        enabled: bool,
    ) -> HotkeyBinding {
        HotkeyBinding {
            action: action.to_string(),
            scope: find_def(action).unwrap().scope,
            accelerator: accelerator.to_string(),
            enabled,
        }
    }

    #[test]
    fn restore_applies_valid_config_and_persists() {
        let dir = restore_temp_dir("ok");
        let store = MemStore::new(0);
        let registrar = FakeRegistrar::new();
        let manager = manager(store.clone(), registrar.clone());
        let config = restore_config(vec![custom("quick_add_task", "Ctrl+Shift+K", true)]);
        let report = manager.apply_restored_config(&dir, &config);
        assert!(report.persisted);
        assert!(report.warnings.is_empty(), "{:?}", report.warnings);
        assert!(!report.pending_saved);
        assert_eq!(report.disabled, 0);
        // 两个系统级默认动作注册成功。
        assert_eq!(report.applied, 2);
        assert!(registrar.is_registered("Ctrl+Alt+T"));
        assert!(registrar.is_registered("Ctrl+Shift+Space"));
        let saved = store.saved.lock().unwrap().clone().unwrap();
        assert!(saved
            .bindings
            .iter()
            .any(|b| b.action == "quick_add_task" && b.accelerator == "Ctrl+Shift+K"));
        assert!(!dir.join(store::PENDING_RESTORE_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_occupied_custom_shortcut_falls_back_to_default() {
        let dir = restore_temp_dir("occupied");
        let store = MemStore::new(0);
        let registrar = FakeRegistrar::occupied_for("Ctrl+Alt+Y");
        let manager = manager(store.clone(), registrar.clone());
        let config = restore_config(vec![custom("toggle_main_window", "Ctrl+Alt+Y", true)]);
        let report = manager.apply_restored_config(&dir, &config);
        assert!(report.persisted);
        assert!(report.pending_saved, "未完全应用时必须保留原始配置");
        assert!(report.warnings.iter().any(|w| w.contains("已降级为默认")));
        assert!(registrar.is_registered("Ctrl+Alt+T"));
        assert!(!registrar.is_registered("Ctrl+Alt+Y"));
        let saved = store.saved.lock().unwrap().clone().unwrap();
        let toggle = saved
            .bindings
            .iter()
            .find(|b| b.action == "toggle_main_window")
            .unwrap();
        assert_eq!(toggle.accelerator, "Ctrl+Alt+T");
        let pending = crate::hotkeys::store::FileHotkeyStore::new(
            dir.join(store::PENDING_RESTORE_FILE),
        );
        assert!(pending.path().exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_invalid_or_duplicate_config_is_sanitized_with_warnings() {
        let dir = restore_temp_dir("invalid");
        let store = MemStore::new(0);
        let manager = manager(store.clone(), FakeRegistrar::new());
        let config = restore_config(vec![
            // 系统保留组合：回退默认并警告。
            custom("quick_add_task", "Alt+F4", true),
            // 与上一条默认 Ctrl+K 不同，但两条都用同一组合 → 后者被禁用。
            custom("toggle_main_window", "Ctrl+Alt+T", true),
            custom("open_clipboard", "Ctrl+Alt+T", true),
        ]);
        let report = manager.apply_restored_config(&dir, &config);
        assert!(report.persisted);
        assert!(report.pending_saved);
        assert!(report.warnings.iter().any(|w| w.contains("系统保留")));
        assert!(report.warnings.iter().any(|w| w.contains("相同组合")));
        let saved = store.saved.lock().unwrap().clone().unwrap();
        let quick = saved
            .bindings
            .iter()
            .find(|b| b.action == "quick_add_task")
            .unwrap();
        assert_eq!(quick.accelerator, "Ctrl+K");
        let clipboard = saved
            .bindings
            .iter()
            .find(|b| b.action == "open_clipboard")
            .unwrap();
        assert!(!clipboard.enabled);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_file_only_normalizes_and_reports_deferred_registration() {
        let dir = restore_temp_dir("file-only");
        let config = restore_config(vec![custom("quick_add_task", "Ctrl", true)]);
        let report = restore_config_file_only(&dir, &config);
        assert!(report.persisted);
        assert!(report.pending_saved);
        assert!(report
            .warnings
            .iter()
            .any(|w| w.contains("将在下次启动时注册")));
        let raw = std::fs::read_to_string(dir.join("hotkeys.json")).unwrap();
        let saved: HotkeyConfigFile = serde_json::from_str(&raw).unwrap();
        let quick = saved
            .bindings
            .iter()
            .find(|b| b.action == "quick_add_task")
            .unwrap();
        assert_eq!(quick.accelerator, "Ctrl+K");
        assert!(dir.join(store::PENDING_RESTORE_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
