//! 剪贴板 OCR 资源与耗时验收（默认 `#[ignore]`，不计入常规测试通过数）。
//!
//! 运行：`cargo test --test ocr_perf -- --ignored --nocapture --test-threads=1`
//!
//! 采样的是测试进程自身的 working set / private bytes 与 CPU 时间：
//! - 「单张峰值」与「连续多张峰值」由后台采样线程每 2ms 记录一次；
//! - 结论只写「该条件下未观察到无界增长」，不做长期泄漏推断；
//! - 输入全部为仓库内自造图（`tests/fixtures/ocr/`），不读取用户剪贴板。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use task_dock_lib::clipboard::image;
use task_dock_lib::clipboard::ocr::OcrService;
use task_dock_lib::clipboard::{store, CapturedContent, CapturedImage};
use task_dock_lib::db::{Db, Settings};
use windows_sys::Win32::System::ProcessStatus::{
    GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};

struct TempRoot(PathBuf);

impl TempRoot {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("td-ocr-perf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
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

fn image_item(db: &Db, root: &Path, name: &str) -> String {
    let png = std::fs::read(fixture(name)).expect("fixture 存在");
    let (rgba, width, height) = image::decode_png_rgba(&png).expect("fixture 可解码");
    insert_image(db, root, png, rgba, width, height)
}

fn insert_image(
    db: &Db,
    root: &Path,
    png: Vec<u8>,
    rgba: Vec<u8>,
    width: u32,
    height: u32,
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
        source_app: "ocr-perf".into(),
        source_title: "自造测试图".into(),
        source_kind: "owner".into(),
        byte_size: 0,
    };
    store::record_capture(db, root, &payload, &Settings::default())
        .expect("入库成功")
        .item
        .id
}

/// 生成指定尺寸的合成图（横向色带），用于 1080p/4K/接近预算的尺寸覆盖。
/// 不依赖字体与外部素材，内容哈希随尺寸与色调不同而变化。
fn synthetic_item(db: &Db, root: &Path, width: u32, height: u32, tint: u8) -> String {
    let mut row = Vec::with_capacity(width as usize * 4);
    for x in 0..width {
        let band = ((x / 16) % 2) as u8;
        let v = if band == 0 { tint } else { tint / 2 };
        row.extend_from_slice(&[v, v, 255 - v, 255]);
    }
    let mut rgba = Vec::with_capacity(width as usize * height as usize * 4);
    for _ in 0..height {
        rgba.extend_from_slice(&row);
    }
    let png = image::encode_png(&rgba, width, height).expect("合成图可编码");
    insert_image(db, root, png, rgba, width, height)
}

fn status_ok(status: &str) -> bool {
    matches!(status, "ok" | "empty")
}

/// 当前进程内存：working set 与 private bytes（字节）。
fn mem() -> (usize, usize) {
    unsafe {
        let mut counters: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        let ok = GetProcessMemoryInfo(
            GetCurrentProcess(),
            &mut counters as *mut _ as *mut _,
            counters.cb,
        );
        if ok == 0 {
            (0, 0)
        } else {
            (counters.WorkingSetSize, counters.PrivateUsage)
        }
    }
}

/// 当前进程累计 CPU 时间（秒，含内核）。
fn cpu_seconds() -> f64 {
    unsafe {
        let mut create = std::mem::zeroed();
        let mut exit = std::mem::zeroed();
        let mut kernel = std::mem::zeroed();
        let mut user = std::mem::zeroed();
        if GetProcessTimes(
            GetCurrentProcess(),
            &mut create,
            &mut exit,
            &mut kernel,
            &mut user,
        ) == 0
        {
            return 0.0;
        }
        let f = |t: windows_sys::Win32::Foundation::FILETIME| {
            (t.dwHighDateTime as u64 * 1_000_000_000 + t.dwLowDateTime as u64 * 100) as f64
                / 1e9
        };
        f(kernel) + f(user)
    }
}

struct Sampler {
    stop: Arc<AtomicBool>,
    peak: Arc<Mutex<(usize, usize)>>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl Sampler {
    fn start() -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let peak = Arc::new(Mutex::new(mem()));
        let (s, p) = (stop.clone(), peak.clone());
        let handle = std::thread::spawn(move || {
            while !s.load(Ordering::Relaxed) {
                let (ws, private) = mem();
                if let Ok(mut m) = p.lock() {
                    if ws > m.0 {
                        m.0 = ws;
                    }
                    if private > m.1 {
                        m.1 = private;
                    }
                }
                std::thread::sleep(Duration::from_millis(2));
            }
        });
        Self {
            stop,
            peak,
            handle: Some(handle),
        }
    }

    fn finish(mut self) -> (usize, usize) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
        *self.peak.lock().unwrap()
    }
}

#[test]
#[ignore = "资源/耗时验收，需本机 Windows OCR 语言包；结果只代表本机当次条件"]
fn ocr_memory_and_latency_profile() {
    let root = TempRoot::new();
    let db = Db::open_in_memory().unwrap();
    let service = OcrService::new();
    let names = ["zh.png", "mixed.png", "digits.png", "en.png", "big.png", "dark.png"];
    let ids: Vec<String> = names
        .iter()
        .map(|n| image_item(&db, &root.0, n))
        .collect();

    // 尺寸覆盖：1080p / 4K / 接近解码预算（6000×4000 = 2400 万像素）。
    let hd = synthetic_item(&db, &root.0, 1920, 1080, 40);
    let uhd = synthetic_item(&db, &root.0, 3840, 2160, 90);
    let near = synthetic_item(&db, &root.0, 6000, 4000, 60);

    // 超预算：只写超大 IHDR 头（20 000×20 000 = 4 亿像素），不分配像素也不启动引擎。
    let over = image_item(&db, &root.0, "blank.png");
    let png = std::fs::read(fixture("blank.png")).unwrap();
    let mut huge = png[..24].to_vec();
    huge[16..20].copy_from_slice(&20_000u32.to_be_bytes());
    huge[20..24].copy_from_slice(&20_000u32.to_be_bytes());
    std::fs::write(root.0.join("images").join(format!("{over}.png")), huge).unwrap();

    let cpu0 = cpu_seconds();
    let (ws0, pv0) = mem();
    println!("baseline: ws={ws0} private={pv0}");

    // 采样单次识别的耗时与内存峰值。
    let timed = |label: &str, id: &str| {
        let sampler = Sampler::start();
        let t = Instant::now();
        let report = service.recognize(&db, &root.0, id, &format!("perf-{label}"));
        let ms = t.elapsed().as_millis();
        let (ws_peak, pv_peak) = sampler.finish();
        println!(
            "{label}: status={} cached={} duration={}ms peak_ws={ws_peak} peak_private={pv_peak}",
            report.status, report.cached, ms
        );
        (report, ms, (ws_peak, pv_peak))
    };

    // 1) 首次调用（冷启动 COM/WinRT 引擎 + 解码 + 识别）
    let t = Instant::now();
    let first = service.recognize(&db, &root.0, &ids[0], "perf-first");
    let first_ms = t.elapsed().as_millis();
    let (ws1, pv1) = mem();
    println!(
        "first: status={} duration={}ms ws={ws1} private={pv1}",
        first.status, first_ms
    );
    assert!(status_ok(&first.status), "首次中文识别应成功：{}", first.status);

    // 2) 单张尺寸梯度（每项独立采样峰值）
    let _ = timed("3000x2000", &ids[4]);
    let (hd_report, hd_ms, hd_peak) = timed("1080p", &hd);
    let (uhd_report, uhd_ms, uhd_peak) = timed("4k", &uhd);
    let (near_report, near_ms, near_peak) = timed("near_budget_6000x4000", &near);
    let (over_report, over_ms, _) = timed("over_budget_20000x20000", &over);
    println!(
        "size_ladder: 1080p={hd_ms}ms 4k={uhd_ms}ms near={near_ms}ms over={over_ms}ms"
    );
    println!(
        "size_peak_private: 1080p={} 4k={} near={}",
        hd_peak.1, uhd_peak.1, near_peak.1
    );
    assert!(status_ok(&hd_report.status));
    assert!(status_ok(&uhd_report.status));
    assert!(status_ok(&near_report.status));
    // 超预算必须是明确状态，且不得占用配额。
    assert_eq!(over_report.status, "too_large", "超预算状态应明确");
    assert!(!service.is_busy());

    // 3) 连续 10 张（6 个固定图 + 4 个不同色调的 960×540 变体，避免全部命中缓存）
    let variants: Vec<String> = (0..4)
        .map(|i| synthetic_item(&db, &root.0, 960, 540, 110 + i * 20))
        .collect();
    let mut seq: Vec<String> = ids.clone();
    seq.extend(variants);
    let sampler = Sampler::start();
    let t = Instant::now();
    let mut per_item = Vec::new();
    for (i, id) in seq.iter().enumerate() {
        let t = Instant::now();
        let r = service.recognize(&db, &root.0, id, &format!("perf-seq-{i}"));
        per_item.push((r.status.clone(), r.cached, t.elapsed().as_millis()));
    }
    let seq_total = t.elapsed().as_millis();
    let (ws_peak_seq, pv_peak_seq) = sampler.finish();
    println!("sequence_10: total={seq_total}ms per_item={per_item:?}");
    println!("sequence_peak: peak_ws={ws_peak_seq} peak_private={pv_peak_seq}");

    // 4) 识别中取消：登记后立即取消，必须及时返回且不留缓存。
    let worker = {
        let service = std::sync::Arc::new(OcrService::new());
        let s = service.clone();
        let db = Db::open_in_memory().unwrap();
        // 为取消单独构造一张大图条目（避免与上面的缓存/闸门状态混在一起）。
        let id = synthetic_item(&db, &root.0, 3000, 2000, 70);
        let root_path = root.0.clone();
        let handle = std::thread::spawn(move || {
            s.recognize(&db, &root_path, &id, "perf-cancel")
        });
        (service, handle)
    };
    let (cancel_service, handle) = worker;
    let deadline = Instant::now() + Duration::from_secs(5);
    while cancel_service.active_request().as_deref() != Some("perf-cancel") {
        assert!(Instant::now() < deadline, "取消任务未在 5s 内登记");
        std::thread::yield_now();
    }
    let cancelled_at = Instant::now();
    assert!(cancel_service.cancel("perf-cancel"), "取消应命中运行中的任务");
    let cancelled = handle.join().unwrap();
    println!(
        "cancel: status={} response={}ms cached={} busy={}",
        cancelled.status,
        cancelled_at.elapsed().as_millis(),
        cancel_service.cached_entries(),
        cancel_service.is_busy()
    );
    assert_eq!(cancelled.status, "cancelled");
    assert!(!cancel_service.is_busy());

    // 5) 删除与清空后缓存释放
    store::delete_items(&db, &root.0, &[ids[0].clone()]).unwrap();
    service.invalidate_items(&[ids[0].clone()]);
    println!("after_delete: cache_entries={}", service.cached_entries());
    service.clear_cache();
    println!("after_clear: cache_entries={}", service.cached_entries());
    assert_eq!(service.cached_entries(), 0, "清空后缓存必须释放");

    // 6) 完成后等待 2s，观察是否回落到稳定平台
    std::thread::sleep(Duration::from_secs(2));
    let (ws2, pv2) = mem();
    println!("settled: ws={ws2} private={pv2}");
    println!(
        "delta_vs_baseline: ws={} private={}",
        ws2 as i64 - ws0 as i64,
        pv2 as i64 - pv0 as i64
    );
    println!(
        "cpu_total={:.3}s busy={}",
        cpu_seconds() - cpu0,
        service.is_busy()
    );

    // 宽松上界只用于防止明显回归；具体数值以打印结果为准。
    // 接近预算（2400 万像素）本身需要约 400MB 瞬时峰值，故上界按尺寸档位放宽。
    assert!(
        pv_peak_seq < pv0.saturating_add(300 * 1024 * 1024),
        "连续识别的 private 峰值增长超过 300MB"
    );
    assert!(
        near_peak.1 < pv0.saturating_add(768 * 1024 * 1024),
        "接近预算单张的 private 峰值超过 768MB"
    );
    assert!(
        pv2 <= pv0.saturating_add(300 * 1024 * 1024),
        "完成后 private 未回落到合理区间"
    );
    assert!(!service.is_busy(), "识别结束后忙碌闸门必须释放");
}
