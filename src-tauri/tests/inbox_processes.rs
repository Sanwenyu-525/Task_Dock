//! 真实跨进程投递：50 个 `--agent-hook` 进程并发写同一个投递目录。
//!
//! 验证：跨进程容量预留只允许完整文件落盘、不超总文件上限、不留下半写临时文件、
//! 每个事件都保留可幂等的 event_id。

use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn fifty_concurrent_hook_processes_write_complete_events() {
    let root = std::env::temp_dir().join(format!("td-inbox-proc-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let exe = env!("CARGO_BIN_EXE_task-dock");
    let mut children = Vec::new();
    for i in 0..50 {
        let mut child = Command::new(exe)
            .args(["--agent-hook", "--source", "codex", "--event", "Stop"])
            .env("APPDATA", &root)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("启动 Hook CLI 进程");
        let payload = format!(r#"{{"session_id":"proc-{i}","task_title":"并发投递"}}"#);
        child
            .stdin
            .take()
            .unwrap()
            .write_all(payload.as_bytes())
            .unwrap();
        children.push(child);
    }
    for child in children {
        let status = child.wait_with_output().unwrap().status;
        assert!(status.success(), "Hook CLI 必须以 0 退出");
    }

    let inbox = root.join("com.taskdock.desktop").join("agent-inbox");
    let mut events = 0usize;
    let mut temp_left = 0usize;
    for entry in std::fs::read_dir(&inbox).unwrap().flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".tmp") {
            temp_left += 1;
            continue;
        }
        if !name.ends_with(".json") {
            continue;
        }
        let raw = std::fs::read_to_string(entry.path()).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).expect("文件必须是完整 JSON");
        assert_eq!(value["state"], "completed");
        assert!(value["event_id"]
            .as_str()
            .map(|s| s.starts_with("hook-"))
            .unwrap_or(false));
        events += 1;
    }
    assert_eq!(events, 50, "50 个进程的事件都必须完整落盘");
    assert!(events <= task_dock_lib::agents::inbox::MAX_FILES);
    assert_eq!(temp_left, 0, "不得留下半写临时文件");
    std::fs::remove_dir_all(&root).ok();
}
