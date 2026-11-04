//! 快捷键配置持久化：写入应用数据目录的 `hotkeys.json`。
//!
//! 不写入 SQLite：避免改动共享的 `ALLOWED_KEYS`/迁移，也避免同一设置键被多个
//! 模块并行争用；旧版 `hotkey_enabled` 仍由调用方读取后作为默认值传入。
//!
//! 写入流程：临时文件 → `sync_all` → rename 覆盖，保证不出现半截配置。

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::hotkeys::model::HotkeyConfigFile;

pub trait HotkeyStore: Send + Sync {
    fn load(&self) -> Result<Option<HotkeyConfigFile>, String>;
    fn save(&self, config: &HotkeyConfigFile) -> Result<(), String>;
}

pub struct FileHotkeyStore {
    path: PathBuf,
}

impl FileHotkeyStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    #[cfg(test)]
    pub fn path(&self) -> &PathBuf {
        &self.path
    }
}

fn stamp() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos}")
}

impl HotkeyStore for FileHotkeyStore {
    fn load(&self) -> Result<Option<HotkeyConfigFile>, String> {
        let raw = match fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                // 读不出来（被占用/权限不足/路径是目录等）时也不要静默覆盖：
                // 先尝试改名保留现场，后续保存才会写新的默认配置。
                let backup = self
                    .path
                    .with_extension(format!("unreadable-{}.json", stamp()));
                let backup_note = match fs::rename(&self.path, &backup) {
                    Ok(()) => format!("已备份到 {}", backup.display()),
                    Err(e) => format!("备份失败：{e}"),
                };
                return Err(format!(
                    "读取快捷键配置失败（{error}），{backup_note}；本次使用默认配置"
                ));
            }
        };
        match serde_json::from_str::<HotkeyConfigFile>(&raw) {
            Ok(config) => Ok(Some(config)),
            Err(error) => {
                // 不静默覆盖损坏文件：先备份，下一次保存才会写新配置。
                let backup = self
                    .path
                    .with_extension(format!("corrupt-{}.json", stamp()));
                let backup_note = match fs::rename(&self.path, &backup) {
                    Ok(()) => format!("已备份到 {}", backup.display()),
                    Err(e) => format!("备份失败：{e}"),
                };
                Err(format!(
                    "快捷键配置解析失败（{error}），{backup_note}；本次使用默认配置"
                ))
            }
        }
    }

    fn save(&self, config: &HotkeyConfigFile) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建快捷键配置目录失败：{e}"))?;
        }
        let data = serde_json::to_vec_pretty(config)
            .map_err(|e| format!("序列化快捷键配置失败：{e}"))?;
        let tmp = self
            .path
            .with_extension(format!("tmp-{}.json", stamp()));
        {
            let mut file = fs::File::create(&tmp)
                .map_err(|e| format!("创建临时快捷键配置失败：{e}"))?;
            file.write_all(&data)
                .map_err(|e| format!("写入临时快捷键配置失败：{e}"))?;
            file.sync_all()
                .map_err(|e| format!("刷新临时快捷键配置失败：{e}"))?;
        }
        fs::rename(&tmp, &self.path).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("替换快捷键配置失败：{e}")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "taskdock-hotkeys-test-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn roundtrip_and_missing_file() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("hotkeys.json");
        let store = FileHotkeyStore::new(path.clone());
        assert!(store.load().unwrap().is_none());

        let config = HotkeyConfigFile {
            version: 1,
            bindings: vec![crate::hotkeys::model::HotkeyBinding {
                action: "quick_add_task".into(),
                scope: crate::hotkeys::model::HotkeyScope::AppLocal,
                accelerator: "Ctrl+Shift+K".into(),
                enabled: true,
            }],
        };
        store.save(&config).unwrap();
        let loaded = store.load().unwrap().unwrap();
        assert_eq!(loaded.bindings.len(), 1);
        assert_eq!(loaded.bindings[0].accelerator, "Ctrl+Shift+K");
        assert_eq!(store.path(), &path);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_is_backed_up_not_overwritten() {
        let dir = temp_dir("corrupt");
        let path = dir.join("hotkeys.json");
        fs::write(&path, "{ not-json").unwrap();
        let store = FileHotkeyStore::new(path.clone());
        let error = store.load().unwrap_err();
        assert!(error.contains("已备份"));
        assert!(!path.exists());
        let backups: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("corrupt"))
            .collect();
        assert_eq!(backups.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_config_is_backed_up_before_defaults() {
        let dir = temp_dir("unreadable");
        let path = dir.join("hotkeys.json");
        // 用目录让读取失败（非 NotFound），验证不会被后续保存静默覆盖。
        fs::create_dir(&path).unwrap();
        let store = FileHotkeyStore::new(path.clone());
        let error = store.load().unwrap_err();
        assert!(error.contains("已备份"));
        assert!(!path.exists());
        let backups: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("unreadable"))
            .collect();
        assert_eq!(backups.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }
}
