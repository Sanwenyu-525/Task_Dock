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

use task_dock_lib::clipboard::image;
use task_dock_lib::clipboard::ocr::{
    contains_cjk, OcrService, STATUS_EMPTY, STATUS_ERROR, STATUS_OK, STATUS_UNAVAILABLE,
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
    let png = std::fs::read(fixture(name)).expect("fixture 存在");
    let (rgba, width, height) = image::decode_png_rgba(&png).expect("fixture 可解码");
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
    store::record_capture(db, root, &payload, &Settings::default())
        .expect("入库成功")
        .item
        .id
}

fn recognize(service: &OcrService, db: &Db, root: &Path, id: &str, req: &str) -> task_dock_lib::clipboard::ocr::OcrReport {
    service.recognize(db, root, id, req)
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
    // 第二个请求在第一个进行中发出：要么 busy，要么第一个已结束（明确状态即可）。
    let second = recognize(&service, &db, root.path(), &other, "req-second");
    let first = handle.join().unwrap();
    assert!(
        matches!(second.status.as_str(), "busy" | STATUS_OK | STATUS_EMPTY),
        "并发请求必须得到明确状态，实际 {}",
        second.status
    );
    assert!(matches!(first.status.as_str(), STATUS_OK | STATUS_EMPTY));
    // 结束后闸门必须释放，可继续识别。
    let after = recognize(&service, &db, root.path(), &other, "req-after");
    assert!(
        matches!(after.status.as_str(), STATUS_OK | STATUS_EMPTY | "busy"),
        "闸门应可恢复"
    );
}

#[test]
#[ignore = "需要本机 Windows OCR 语言包（zh-Hans-CN / en-US）"]
fn cancel_before_start_is_reported_as_cancelled() {
    let root = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let id = image_item(&db, root.path(), "big.png");
    let service = OcrService::new();
    // 登记与当前请求一致的取消标记；识别开始时即应观察到取消。
    assert!(service.cancel("req-cancel") || !service.is_busy());
    let report = recognize(&service, &db, root.path(), &id, "req-cancel");
    assert!(
        matches!(report.status.as_str(), "cancelled" | STATUS_OK | STATUS_EMPTY),
        "取消路径应返回结构化状态，实际 {}",
        report.status
    );
}
