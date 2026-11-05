//! 剪贴板 OCR 真机集成测试（Windows.Media.Ocr）。
//!
//! 依赖本机已安装中文 / 英文 OCR 语言包，默认 `#[ignore]`：
//! 显式运行 `cargo test --test ocr -- --ignored --test-threads=1` 才会执行。
//! 所有输入均为仓库内自造测试图（`tests/fixtures/ocr/`），不读取用户剪贴板。
//!
//! 断言只覆盖可稳定复核的部分：状态、是否含 CJK/拉丁字符、尺寸与长度；
//! 不把「逐字完全正确」写进断言（Windows OCR 对小字与半角符号存在已知误识）。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use task_dock_lib::clipboard::image;
use task_dock_lib::clipboard::ocr::{
    contains_cjk, OcrService, STATUS_CANCELLED, STATUS_EMPTY, STATUS_ERROR, STATUS_OK,
    STATUS_TOO_LARGE, STATUS_UNAVAILABLE,
};
use task_dock_lib::clipboard::store;
use task_dock_lib::clipboard::{CapturedContent, CapturedImage};
use task_dock_lib::db::{Db, Settings};

struct TempRoot(PathBuf);

impl TempRoot {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("td-ocr-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("ocr")
        .join(name)
}

/// 把自造图片写入剪贴板库，返回条目 id（走与产品一致的入库路径）。
fn image_item(db: &Db, root: &Path, name: &str) -> String {
    image_item_with(db, root, name, &Settings::default())
}

fn image_item_with(db: &Db, root: &Path, name: &str, settings: &Settings) -> String {
    let png = std::fs::read(fixture(name)).expect("fixture 存在");
    let (rgba, width, height) = image::decode_png_rgba(&png).expect("fixture 可解码");
    insert_image_item(db, root, png, rgba, width, height, settings)
}

/// 走与产品一致的入库路径写入一张图片，返回条目 id。
fn insert_image_item(
    db: &Db,
    root: &Path,
    png: Vec<u8>,
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    settings: &Settings,
) -> String {
    let payload = CapturedContent {
        kind: "image".into(),
        text: String::new(),
        html: String::new(),
        preview: String::new(),
        file_paths: vec![],
        image: Some(CapturedImage {
            png,
            width,
            height,
            rgba,
        }),
        source_app: "ocr-fixture".into(),
        source_title: "自造测试图".into(),
        source_kind: "owner".into(),
        byte_size: 0,
    };
    store::record_capture(db, root, &payload, settings)
        .expect("入库成功")
        .item
        .id
}

fn recognize(service: &OcrService, db: &Db, root: &Path, id: &str, req: &str) -> task_dock_lib::clipboard::ocr::OcrReport {
    service.recognize(db, root, id, req)
}

/// 生成不依赖 fixtures 的合成图：让识别在删除操作完成后仍持续一段时间，
/// 便于验证「删除成功后旧任务才结束」时的迟到写回。
fn synthetic_image_item(db: &Db, root: &Path, width: u32, height: u32) -> String {
    synthetic_image_item_with(db, root, width, height, &Settings::default())
}

fn synthetic_image_item_with(
    db: &Db,
    root: &Path,
    width: u32,
    height: u32,
    settings: &Settings,
) -> String {
    let mut rgba = vec![255u8; width as usize * height as usize * 4];
    for y in (0..height as usize).step_by(96) {
        let row = y * width as usize;
        for x in 0..width as usize {
            let i = (row + x) * 4;
            rgba[i] = 0;
            rgba[i + 1] = 0;
            rgba[i + 2] = 0;
        }
    }
    let png = image::encode_png(&rgba, width, height).expect("合成图可编码");
    insert_image_item(db, root, png, rgba, width, height, settings)
}

/// 确定性同步点：等识别任务登记完成（已占用配额），不用 sleep 猜节奏。
fn wait_active(service: &OcrService, request_id: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while service.active_request().as_deref() != Some(request_id) {
        assert!(
            Instant::now() < deadline,
            "识别任务未在 5s 内登记：{request_id}（active={:?}）",
            service.active_request()
        );
        std::thread::yield_now();
    }
}

#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn recognizes_chinese() {
    let root = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let id = image_item(&db, root.path(), "zh.png");
    let report = recognize(&OcrService::new(), &db, root.path(), &id, "req-zh");
    assert_eq!(report.status, STATUS_OK, "reason={:?}", report.reason);
    assert!(report.chars > 0);
    assert!(contains_cjk(&report.text), "中文图应包含 CJK 字符");
    // 只断言长度，不把完整文本写进测试输出。
    eprintln!(
        "zh: status={} lines={} chars={} duration={}ms",
        report.status, report.lines, report.chars, report.duration_ms
    );
}

#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn recognizes_english() {
    let root = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let id = image_item(&db, root.path(), "en.png");
    let report = recognize(&OcrService::new(), &db, root.path(), &id, "req-en");
    assert_eq!(report.status, STATUS_OK, "reason={:?}", report.reason);
    assert!(
        report.text.chars().any(|c| c.is_ascii_alphabetic()),
        "英文图应包含拉丁字母"
    );
    eprintln!(
        "en: status={} lines={} chars={} engine={:?}",
        report.status, report.lines, report.chars, report.engine
    );
}

#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn recognizes_mixed_chinese_english() {
    let root = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let id = image_item(&db, root.path(), "mixed.png");
    let report = recognize(&OcrService::new(), &db, root.path(), &id, "req-mixed");
    assert_eq!(report.status, STATUS_OK, "reason={:?}", report.reason);
    assert!(contains_cjk(&report.text), "混排图应保留中文");
    assert!(
        report.text.chars().any(|c| c.is_ascii_alphabetic()),
        "混排图应保留英文"
    );
    eprintln!(
        "mixed: status={} lines={} chars={}",
        report.status, report.lines, report.chars
    );
}

#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn recognizes_digits() {
    let root = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let id = image_item(&db, root.path(), "digits.png");
    let report = recognize(&OcrService::new(), &db, root.path(), &id, "req-digits");
    assert_eq!(report.status, STATUS_OK, "reason={:?}", report.reason);
    assert!(
        report.text.chars().any(|c| c.is_ascii_digit()),
        "数字图应包含数字"
    );
    eprintln!(
        "digits: status={} lines={} chars={} engine={:?}",
        report.status, report.lines, report.chars, report.engine
    );
}

#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn blank_image_has_no_text() {
    let root = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let id = image_item(&db, root.path(), "blank.png");
    let report = recognize(&OcrService::new(), &db, root.path(), &id, "req-blank");
    assert_eq!(report.status, STATUS_EMPTY);
    assert_eq!(report.chars, 0);
    assert!(report.text.is_empty());
}

#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn shapes_without_text_has_no_text() {
    let root = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let id = image_item(&db, root.path(), "shapes.png");
    let report = recognize(&OcrService::new(), &db, root.path(), &id, "req-shapes");
    assert_eq!(report.status, STATUS_EMPTY);
    assert!(report.text.is_empty());
}

#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn tiny_font_returns_structured_result_without_panic() {
    // 11px 小字是 Windows OCR 的已知弱项（spike 实测为乱码）。
    // 这里只验证：有明确状态、不崩溃、不放大后仍宣称准确。
    let root = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let id = image_item(&db, root.path(), "tiny11.png");
    let report = recognize(&OcrService::new(), &db, root.path(), &id, "req-tiny");
    assert!(
        matches!(report.status.as_str(), STATUS_OK | STATUS_EMPTY),
        "小字应返回结构化结果，实际 status={} reason={:?}",
        report.status,
        report.reason
    );
    eprintln!(
        "tiny11: status={} lines={} chars={}（不校验识别准确率）",
        report.status, report.lines, report.chars
    );
}

#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn large_image_keeps_original_dimensions_under_limit() {
    let root = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let id = image_item(&db, root.path(), "big.png");
    let report = recognize(&OcrService::new(), &db, root.path(), &id, "req-big");
    assert_eq!(report.status, STATUS_OK, "reason={:?}", report.reason);
    // 3000×2000 在 24M 像素与 10000 单边以内，原样识别。
    assert_eq!((report.width, report.height), (3000, 2000));
    eprintln!(
        "big: status={} lines={} chars={} duration={}ms",
        report.status, report.lines, report.chars, report.duration_ms
    );
}

#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn second_request_hits_session_cache() {
    let root = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let id = image_item(&db, root.path(), "zh.png");
    let service = OcrService::new();
    let first = recognize(&service, &db, root.path(), &id, "req-1");
    let second = recognize(&service, &db, root.path(), &id, "req-2");
    assert!(!first.cached);
    assert!(second.cached, "同一条目同内容应命中缓存，不重复识别");
    assert_eq!(second.duration_ms, 0);
    assert_eq!(first.text, second.text);
}

#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn different_item_does_not_reuse_other_result() {
    let root = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let zh = image_item(&db, root.path(), "zh.png");
    let en = image_item(&db, root.path(), "en.png");
    let service = OcrService::new();
    let a = recognize(&service, &db, root.path(), &zh, "req-zh");
    let b = recognize(&service, &db, root.path(), &en, "req-en");
    assert!(!b.cached, "不同条目不得命中彼此缓存");
    assert_ne!(a.text, b.text);
}

#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn non_image_item_is_unavailable() {
    let root = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let payload = CapturedContent {
        kind: "text".into(),
        text: "纯文本条目".into(),
        html: String::new(),
        preview: String::new(),
        file_paths: vec![],
        image: None,
        source_app: "ocr-fixture".into(),
        source_title: "自造文本".into(),
        source_kind: "owner".into(),
        byte_size: 0,
    };
    let id = store::record_capture(&db, root.path(), &payload, &Settings::default())
        .unwrap()
        .item
        .id;
    let report = recognize(&OcrService::new(), &db, root.path(), &id, "req-text");
    assert_eq!(report.status, STATUS_UNAVAILABLE);
    assert_eq!(report.code, "not_image");
}

#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn missing_item_is_unavailable() {
    let root = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let report = recognize(&OcrService::new(), &db, root.path(), "no-such-id", "req-missing");
    assert_eq!(report.status, STATUS_UNAVAILABLE);
}

#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn corrupt_png_reports_error_and_releases_gate() {
    let root = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    // blank.png 正常入库后，用非法 PNG 覆盖同一资产路径，模拟磁盘上的图片被破坏。
    let id = image_item(&db, root.path(), "blank.png");
    let bad = std::fs::read(fixture("bad.png")).unwrap();
    std::fs::write(root.path().join("images").join(format!("{id}.png")), bad).unwrap();

    let service = OcrService::new();
    let report = recognize(&service, &db, root.path(), &id, "req-bad");
    assert_eq!(report.status, STATUS_ERROR);
    assert_eq!(report.code, "decode_failed");

    // 失败后闸门必须已释放：随后同一服务识别正常图仍应成功。
    let ok_id = image_item(&db, root.path(), "zh.png");
    let ok = recognize(&service, &db, root.path(), &ok_id, "req-after");
    assert_eq!(ok.status, STATUS_OK, "失败后应恢复，实际 {:?}", ok.reason);
}

#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn concurrent_request_gets_explicit_state_and_gate_recovers() {
    let root = TempRoot::new();
    let db = Arc::new(Db::open_in_memory().unwrap());
    let big = image_item(&db, root.path(), "big.png");
    let other = image_item(&db, root.path(), "zh.png");
    let service = Arc::new(OcrService::new());

    let handle = {
        let db = db.clone();
        let service = service.clone();
        let root_path = root.path().to_path_buf();
        let big = big.clone();
        std::thread::spawn(move || {
            recognize(&service, &db, &root_path, &big, "req-first")
        })
    };
    // 第二个请求在第一个进行中发出：并发上限保证它得到 busy，或第一个已结束而成功。
    let second = recognize(&service, &db, root.path(), &other, "req-second");
    let first = handle.join().unwrap();
    for (label, report) in [("first", &first), ("second", &second)] {
        assert!(
            matches!(report.status.as_str(), "busy" | "ok" | "empty"),
            "{label} 必须得到明确状态，实际 {}（{}）",
            report.status,
            report.code
        );
    }
    assert!(
        [&first, &second]
            .iter()
            .any(|r| matches!(r.status.as_str(), "ok" | "empty")),
        "并发请求中至少有一个完成识别"
    );
    // 结束后闸门必须释放，可继续识别（join 之后不存在其他识别任务）。
    let after = recognize(&service, &db, root.path(), &other, "req-after");
    assert!(
        matches!(after.status.as_str(), "ok" | "empty"),
        "闸门应可恢复，实际 {}（{}）",
        after.status,
        after.code
    );
}

#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn cancel_hits_running_task_and_releases_resources() {
    let root = TempRoot::new();
    let db = Arc::new(Db::open_in_memory().unwrap());
    let big = image_item(&db, root.path(), "big.png");
    let other = image_item(&db, root.path(), "zh.png");
    let service = Arc::new(OcrService::new());

    let handle = {
        let db = db.clone();
        let service = service.clone();
        let root_path = root.path().to_path_buf();
        let big = big.clone();
        std::thread::spawn(move || recognize(&service, &db, &root_path, &big, "req-cancel"))
    };

    // 同步点：任务登记完成即视为“已开始”，不靠 sleep 猜测节奏。
    // 登记发生在读文件/解码/调用引擎之前，此时取消必然赶在引擎完成前生效。
    let deadline = Instant::now() + Duration::from_secs(5);
    while service.active_request().as_deref() != Some("req-cancel") {
        assert!(
            Instant::now() < deadline,
            "识别任务未在 5s 内登记（active={:?}）",
            service.active_request()
        );
        std::thread::yield_now();
    }

    // 错误 request_id 不得影响当前任务。
    assert!(!service.cancel("req-other"), "错误 request_id 不应命中");
    // 正确 request_id 必须命中。
    let cancelled_at = Instant::now();
    assert!(service.cancel("req-cancel"), "正确 request_id 必须命中运行中的任务");

    let report = handle.join().expect("识别线程不应 panic");
    // 已开始后取消必须确定生效；不再接受 ok/empty 作为通过。
    assert_eq!(
        report.status, STATUS_CANCELLED,
        "任务已登记后取消必须生效，实际 status={} code={}",
        report.status, report.code
    );
    // operation.Cancel() 后能及时返回（WinRT 内部计算不保证瞬间停止，见文档）。
    assert!(
        cancelled_at.elapsed() < Duration::from_secs(5),
        "取消后应在 5s 内返回，实际 {:?}",
        cancelled_at.elapsed()
    );
    // 取消结果不缓存，配额与登记全部释放。
    assert_eq!(service.cached_entries(), 0, "取消结果不得写入缓存");
    assert!(!service.is_busy(), "取消后必须释放单任务配额");
    assert!(service.active_request().is_none(), "取消后不得残留进行中任务");

    // 可立即开始下一次识别。
    let after = recognize(&service, &db, root.path(), &other, "req-after");
    assert!(
        matches!(after.status.as_str(), STATUS_OK | STATUS_EMPTY),
        "取消后应可立即识别，实际 {}（{}）",
        after.status,
        after.code
    );
}

#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn oversized_image_is_rejected_before_decode() {
    let root = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    // 正常入库后把资产替换成“只有超大 IHDR 头”的 PNG：
    // 解码前闸门必须拒绝，绝不进入引擎、也绝不报成「没有识别到文字」。
    let id = image_item(&db, root.path(), "blank.png");
    let png = std::fs::read(fixture("blank.png")).unwrap();
    let mut huge = png[..24].to_vec();
    huge[16..20].copy_from_slice(&20_000u32.to_be_bytes());
    huge[20..24].copy_from_slice(&20_000u32.to_be_bytes());
    std::fs::write(
        root.path().join("images").join(format!("{id}.png")),
        huge,
    )
    .unwrap();

    let service = OcrService::new();
    let report = recognize(&service, &db, root.path(), &id, "req-huge");
    assert_eq!(report.status, STATUS_TOO_LARGE, "reason={:?}", report.reason);
    assert_eq!(report.code, "image_too_large");
    assert_eq!((report.width, report.height), (20_000, 20_000));
    assert!(report.text.is_empty());
    assert!(!report.cached);
    assert!(
        report.reason.as_deref().unwrap_or("").contains("截取"),
        "提示应建议截取局部"
    );
    // 超限路径不得占用配额，随后仍可识别正常图。
    assert!(!service.is_busy());
    let ok = recognize(
        &service,
        &db,
        root.path(),
        &image_item(&db, root.path(), "zh.png"),
        "req-after",
    );
    assert!(
        matches!(ok.status.as_str(), STATUS_OK | STATUS_EMPTY),
        "超限拒绝后闸门应可复用，实际 {}（{}）",
        ok.status,
        ok.code
    );
}

#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn deleting_one_item_invalidates_only_its_cache_entry() {
    let root = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let zh = image_item(&db, root.path(), "zh.png");
    let en = image_item(&db, root.path(), "en.png");
    let service = OcrService::new();
    recognize(&service, &db, root.path(), &zh, "req-zh");
    recognize(&service, &db, root.path(), &en, "req-en");
    assert_eq!(service.cached_entries(), 2);

    store::delete_items(&db, root.path(), &[zh.clone()]).unwrap();
    service.invalidate_items(&[zh.clone()]);
    assert_eq!(service.cached_entries(), 1, "只应失效被删条目");
    let again = recognize(&service, &db, root.path(), &en, "req-en-2");
    assert!(again.cached, "未删除条目应继续命中缓存");
}

#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn auto_expiry_cleanup_evicts_cache_entries() {
    let root = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let id = image_item(&db, root.path(), "zh.png");
    let service = OcrService::new();
    assert!(
        matches!(
            recognize(&service, &db, root.path(), &id, "req-zh").status.as_str(),
            STATUS_OK | STATUS_EMPTY
        )
    );
    assert_eq!(service.cached_entries(), 1);

    // 把条目的最后出现时间改到 100 天前，触发真实的自动过期清理（1 天保留期）。
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE clipboard_items
                SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now', '-100 days')
              WHERE id = ?1",
            [&id],
        )
        .map_err(task_dock_lib::error::AppError::from)?;
        Ok(())
    })
    .unwrap();
    let settings = Settings {
        clipboard_retention_days: 1,
        ..Settings::default()
    };
    let report = store::cleanup(&db, root.path(), &settings).unwrap();
    assert_eq!(report.items_deleted, 1, "过期条目应被清理");

    service.retain_existing(&db, report.items_deleted > 0);
    assert_eq!(service.cached_entries(), 0, "自动过期后缓存必须失效");
    let unresolved = recognize(&service, &db, root.path(), &id, "req-gone");
    assert_eq!(unresolved.status, STATUS_UNAVAILABLE);
}

/// 缓存为空、识别在跑时删掉整组：即使本次没有淘汰任何缓存条目，
/// 也必须推进失效代数，避免迟到结果写回。
#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn delete_group_during_recognition_does_not_cache_late_result() {
    let root = TempRoot::new();
    let db = Arc::new(Db::open_in_memory().unwrap());
    // 关闭自动分组，保证「共享/非共享」只由本用例创建的组决定。
    let no_auto_group = Settings {
        clipboard_auto_group: false,
        ..Settings::default()
    };
    // 识别对象与待删除条目同组，但被另一个分组共享：删组不会删掉它的图片文件，
    // 识别能完整走完引擎，才验证得到「迟到结果不写回」。
    let running = synthetic_image_item_with(&db, root.path(), 2400, 1800, &no_auto_group);
    let removed = image_item_with(&db, root.path(), "zh.png", &no_auto_group);
    let group = store::create_manual_group(
        &db,
        "并发删除组",
        &[running.clone(), removed.clone()],
    )
    .expect("建组成功");
    store::create_manual_group(&db, "共享组", &[running.clone()]).expect("共享组建立成功");
    let service = Arc::new(OcrService::new());
    assert_eq!(service.cached_entries(), 0, "用例前提：缓存为空");

    let handle = {
        let db = db.clone();
        let service = service.clone();
        let root_path = root.path().to_path_buf();
        let running = running.clone();
        std::thread::spawn(move || recognize(&service, &db, &root_path, &running, "req-group"))
    };
    wait_active(&service, "req-group");
    assert!(service.is_busy());

    let report = store::delete_group(&db, root.path(), &group.id, true).expect("删组成功");
    assert!(report.deleted > 0, "应实际删除组内非共享条目");
    // 关键：缓存为空时也按 deleted 标志推进代数（删除路径不得依赖快照是否为空）。
    service.retain_existing(&db, report.deleted > 0);
    assert_eq!(service.cached_entries(), 0);
    // 同步点校验：删除必须发生在识别结束之前，否则本用例不构成证据。
    assert_eq!(
        service.active_request().as_deref(),
        Some("req-group"),
        "删除完成时识别应仍在进行"
    );

    let late = handle.join().expect("识别线程不应 panic");
    assert!(
        matches!(late.status.as_str(), STATUS_OK | STATUS_EMPTY),
        "识别对象仍存在，应正常完成，实际 {}（{}）",
        late.status,
        late.code
    );
    assert_eq!(service.cached_entries(), 0, "迟到结果不得写回缓存");
    assert!(!service.is_busy(), "结束后必须释放单任务配额");
    assert!(service.active_request().is_none(), "结束后不得残留进行中任务");
}

/// 过期清理发生在识别期间：清理删除了其他条目也必须推进代数。
#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn cleanup_during_recognition_does_not_cache_late_result() {
    let root = TempRoot::new();
    let db = Arc::new(Db::open_in_memory().unwrap());
    let running = synthetic_image_item(&db, root.path(), 2400, 1800);
    let expired = image_item(&db, root.path(), "zh.png");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE clipboard_items
                SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%S+00:00', 'now', '-100 days')
              WHERE id = ?1",
            [&expired],
        )
        .map_err(task_dock_lib::error::AppError::from)?;
        Ok(())
    })
    .unwrap();
    let service = Arc::new(OcrService::new());
    assert_eq!(service.cached_entries(), 0);

    let handle = {
        let db = db.clone();
        let service = service.clone();
        let root_path = root.path().to_path_buf();
        let running = running.clone();
        std::thread::spawn(move || recognize(&service, &db, &root_path, &running, "req-cleanup"))
    };
    wait_active(&service, "req-cleanup");

    let settings = Settings {
        clipboard_retention_days: 1,
        ..Settings::default()
    };
    let report = store::cleanup(&db, root.path(), &settings).expect("清理成功");
    assert!(report.items_deleted > 0, "过期条目应被清理");
    service.retain_existing(&db, report.items_deleted > 0);
    assert_eq!(service.cached_entries(), 0);
    assert_eq!(
        service.active_request().as_deref(),
        Some("req-cleanup"),
        "清理完成时识别应仍在进行"
    );

    let late = handle.join().expect("识别线程不应 panic");
    assert!(
        matches!(late.status.as_str(), STATUS_OK | STATUS_EMPTY),
        "识别对象未过期，应正常完成，实际 {}（{}）",
        late.status,
        late.code
    );
    assert_eq!(service.cached_entries(), 0, "过期清理后的迟到结果不得写回");
    assert!(!service.is_busy());
    assert!(service.active_request().is_none());
}

/// 清空发生在识别期间：缓存为空时也必须让在跑任务失效。
#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn clear_history_during_recognition_discards_late_result() {
    let root = TempRoot::new();
    let db = Arc::new(Db::open_in_memory().unwrap());
    let running = synthetic_image_item(&db, root.path(), 2400, 1800);
    let service = Arc::new(OcrService::new());
    assert_eq!(service.cached_entries(), 0);

    let handle = {
        let db = db.clone();
        let service = service.clone();
        let root_path = root.path().to_path_buf();
        let running = running.clone();
        std::thread::spawn(move || recognize(&service, &db, &root_path, &running, "req-clear"))
    };
    wait_active(&service, "req-clear");

    service.clear_cache();
    assert_eq!(service.cached_entries(), 0);
    assert_eq!(
        service.active_request().as_deref(),
        Some("req-clear"),
        "清空时识别应仍在进行"
    );

    let late = handle.join().expect("识别线程不应 panic");
    assert!(
        matches!(late.status.as_str(), STATUS_OK | STATUS_EMPTY),
        "清空不删除数据库条目，识别应正常完成，实际 {}（{}）",
        late.status,
        late.code
    );
    assert_eq!(service.cached_entries(), 0, "清空后的迟到结果不得写回");
    assert!(!service.is_busy(), "结束后必须释放单任务配额");
    assert!(service.active_request().is_none());
}
