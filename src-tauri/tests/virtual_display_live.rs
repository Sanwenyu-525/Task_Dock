//! 真机联调（显式启用）：直接调用 command 层，验证真实 ADB/scrcpy 会话闭环。
//!
//! 默认不执行，避免 CI/无设备环境误跑。显式运行：
//! `TASK_DOCK_VD_LIVE=1 cargo test --test virtual_display_live -- --nocapture`
//!
//! 覆盖：工具链/设备、可启动应用枚举、镜像启动→running→定位→截图→关闭、
//! 虚拟屏启动→running→关闭、并发/重复创建拦截、参数注入拒绝。
//! 不覆盖：物理触控、锁屏/解锁、中英文输入（需人工验收）。

use std::thread::sleep;
use std::time::{Duration, Instant};

use task_dock_lib::commands::virtual_display as vd;

fn live_enabled() -> bool {
    std::env::var("TASK_DOCK_VD_LIVE").ok().as_deref() == Some("1")
}

fn online_device() -> Option<vd::VdDevice> {
    let list = vd::vd_devices().expect("vd_devices");
    list.devices.into_iter().find(|device| device.state == "device")
}

fn wait_for(id: &str, wanted: &[&str], timeout: Duration) -> vd::VdSession {
    let deadline = Instant::now() + timeout;
    let mut last: Option<vd::VdSession> = None;
    loop {
        let sessions = vd::vd_sessions().expect("vd_sessions");
        if let Some(session) = sessions.iter().find(|session| session.id == id) {
            last = Some(session.clone());
            if wanted.contains(&session.status.as_str()) {
                return session.clone();
            }
            if matches!(session.status.as_str(), "error" | "disconnected" | "stopped") {
                panic!("会话提前结束: {session:?}");
            }
        }
        if Instant::now() >= deadline {
            panic!("等待 {wanted:?} 超时，最后状态: {last:?}");
        }
        sleep(Duration::from_millis(150));
    }
}

fn wait_gone(id: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        let sessions = vd::vd_sessions().expect("vd_sessions");
        let still_active = sessions
            .iter()
            .any(|session| session.id == id && session.alive);
        if !still_active {
            return;
        }
        if Instant::now() >= deadline {
            panic!("会话未在 {timeout:?} 内回收: {sessions:?}");
        }
        sleep(Duration::from_millis(150));
    }
}

fn capture_with_retry(id: &str) -> vd::VdScreenshot {
    for attempt in 0..6 {
        match vd::vd_screenshot(id) {
            Ok(shot) => {
                let bytes = std::fs::read(&shot.path).expect("读取截图文件");
                assert!(
                    bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
                    "截图不是 PNG: {}",
                    shot.path
                );
                assert!(shot.width > 0 && shot.height > 0);
                return shot;
            }
            Err(err) if attempt < 5 => {
                eprintln!("截图第 {} 次失败（{}），重试…", attempt + 1, err);
                sleep(Duration::from_millis(600));
            }
            Err(err) => panic!("截图失败: {err}"),
        }
    }
    unreachable!()
}

#[test]
fn live_mirror_and_virtual_session_roundtrip() {
    if !live_enabled() {
        eprintln!("跳过真机联调：设置 TASK_DOCK_VD_LIVE=1 启用");
        return;
    }
    let probe = vd::vd_probe().expect("vd_probe");
    assert!(probe.adb_path.is_some(), "未找到 adb: {probe:?}");
    assert!(probe.scrcpy_path.is_some(), "未找到 scrcpy: {probe:?}");
    assert!(probe.supports_new_display, "scrcpy 不支持 --new-display");
    let device = online_device().expect("没有在线的 ADB 设备");
    eprintln!(
        "设备: model={:?} connection={} transports={}",
        device.model, device.connection, device.transports.len()
    );

    // 可启动应用枚举：com.android.settings 应存在且未被标记为无入口。
    let apps = vd::vd_list_apps(device.serial.clone(), Some(false)).expect("vd_list_apps");
    assert!(!apps.apps.is_empty(), "应用列表为空");
    assert!(apps.device_uid == device.uid, "设备身份不一致");
    let settings = apps
        .apps
        .iter()
        .find(|app| app.package == "com.android.settings")
        .expect("缺少 com.android.settings");
    assert_ne!(settings.launchable, Some(false));

    // 参数注入/非法尺寸在启动前拒绝。
    assert!(vd::vd_start(
        device.serial.clone(),
        "virtual".into(),
        Some("--help".into()),
        None,
        None,
        None
    )
    .is_err());
    assert!(vd::vd_start(
        device.serial.clone(),
        "virtual".into(),
        Some("com.android.settings".into()),
        Some("100x100".into()),
        None,
        None
    )
    .is_err());

    // 屏幕镜像：running → 定位 → 截图 → 关闭。
    let mirror = vd::vd_start(
        device.serial.clone(),
        "mirror".into(),
        None,
        None,
        Some(false),
        Some(false),
    )
    .expect("启动镜像");
    let running = wait_for(&mirror.id, &["running"], Duration::from_secs(25));
    assert_eq!(running.mode, "mirror");
    assert!(running.alive);

    // 同设备重复镜像应被拦截。
    let duplicate = vd::vd_start(
        device.serial.clone(),
        "mirror".into(),
        None,
        None,
        Some(false),
        Some(false),
    );
    assert!(duplicate.is_err(), "重复启动未被拦截: {duplicate:?}");

    let focus = vd::vd_focus(&mirror.id).expect("定位镜像窗口");
    assert!(focus.found, "未找到镜像窗口");
    let shot = capture_with_retry(&mirror.id);
    eprintln!("镜像截图: {} {}x{}", shot.path, shot.width, shot.height);

    assert!(vd::vd_stop(&mirror.id).expect("关闭镜像"));
    wait_gone(&mirror.id, Duration::from_secs(12));

    // 独立虚拟屏：running → 截图 → 关闭。
    let virtual_session = vd::vd_start(
        device.serial.clone(),
        "virtual".into(),
        Some("com.android.settings".into()),
        Some("1080x1920/384".into()),
        Some(false),
        Some(false),
    )
    .expect("启动虚拟屏");
    let running = wait_for(&virtual_session.id, &["running"], Duration::from_secs(30));
    assert_eq!(running.mode, "virtual");
    assert_eq!(running.package.as_deref(), Some("com.android.settings"));
    assert!(
        matches!(running.stage.as_str(), "ready" | "video"),
        "虚拟屏 stage={}",
        running.stage
    );
    let shot = capture_with_retry(&virtual_session.id);
    eprintln!("虚拟屏截图: {} {}x{}", shot.path, shot.width, shot.height);

    assert!(vd::vd_stop(&virtual_session.id).expect("关闭虚拟屏"));
    wait_gone(&virtual_session.id, Duration::from_secs(12));
    eprintln!("真机联调完成：镜像与虚拟屏均已启动、截图并回收");
}
