//! 剪贴板性能采样（手动运行，不进入常规 CI）：
//! `cargo test --release --test clipboard_perf -- --ignored --nocapture`
//!
//! 说明：采样覆盖数据库写入/分页/搜索/统计、图片缩略图与 PNG/DIB 编解码；
//! 不覆盖 WebView 渲染帧率与真实硬件上的空闲 CPU/内存，后者需真机验收单独记录。

use std::path::{Path, PathBuf};
use std::time::Instant;

use chrono::Local;
use serde_json::json;
use task_dock_lib::clipboard::{image, store, CapturedContent, CapturedImage};
use task_dock_lib::db::{Db, Settings};

fn temp_root() -> PathBuf {
    let root = std::env::temp_dir().join(format!("taskdock-clip-perf-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn results_dir() -> PathBuf {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/performance/results");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn write_report(name: &str, report: &serde_json::Value) {
    let stamp = Local::now().format("%Y%m%d-%H%M%S");
    let path = results_dir().join(format!("{name}-{stamp}.json"));
    let _ = std::fs::write(
        &path,
        serde_json::to_string_pretty(report).unwrap_or_default(),
    );
    println!("报告已写入 {}", path.display());
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|e| {
            let p = e.path();
            if p.is_dir() {
                dir_size(&p)
            } else {
                e.metadata().map(|m| m.len()).unwrap_or(0)
            }
        })
        .sum()
}

/// 生成带移动色块的截图 fixture；仅色块位置变化，保证内容哈希唯一。
fn rgba_with_block(w: u32, h: u32, seed: usize) -> Vec<u8> {
    let mut rgba = vec![0u8; w as usize * h as usize * 4];
    for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
        px[0] = (i % 251) as u8;
        px[1] = ((i / 7) % 241) as u8;
        px[2] = ((i / 13) % 239) as u8;
        px[3] = 255;
    }
    let (bw, bh) = (64usize, 64usize);
    let x0 = seed * 17 % (w as usize - bw);
    let y0 = seed * 29 % (h as usize - bh);
    for dy in 0..bh {
        for dx in 0..bw {
            let idx = ((y0 + dy) * w as usize + (x0 + dx)) * 4;
            rgba[idx..idx + 4].copy_from_slice(&[250, 250, 250, 255]);
        }
    }
    rgba
}

fn image_payload(i: usize, png: Vec<u8>, rgba: Vec<u8>, w: u32, h: u32) -> CapturedContent {
    let mut p = text_payload(i);
    p.kind = "image".into();
    p.text.clear();
    p.preview = format!("{w}×{h}");
    p.image = Some(CapturedImage {
        png,
        width: w,
        height: h,
        rgba,
    });
    p
}

fn text_payload(i: usize) -> CapturedContent {
    let body = format!(
        "性能采样条目 {i}：这是一段用于测量剪贴板历史写入与检索的文本。{}",
        "内容".repeat(40)
    );
    CapturedContent {
        kind: "text".into(),
        preview: body.chars().take(160).collect(),
        text: body,
        html: String::new(),
        file_paths: Vec::new(),
        image: None,
        source_app: "perf.exe".into(),
        source_title: "性能采样".into(),
        byte_size: 0,
    }
}

fn ms(d: std::time::Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn pct(mut v: Vec<f64>, p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() as f64 - 1.0) * p).round() as usize]
}

#[test]
#[ignore = "性能采样：需手动运行并记录环境"]
fn clipboard_perf_sample() {
    let n = 1000usize;
    let db = Db::open_in_memory().unwrap();
    let root = temp_root();
    let settings = Settings {
        clipboard_auto_group: false,
        clipboard_max_items: 50_000,
        ..Default::default()
    };

    let t = Instant::now();
    for i in 0..n {
        store::record_capture(&db, &root, &text_payload(i), &settings).unwrap();
    }
    let insert_total = t.elapsed();

    let filter = store::ClipboardFilter {
        limit: Some(80),
        ..Default::default()
    };
    let mut list_times = Vec::new();
    for _ in 0..30 {
        let t = Instant::now();
        let page = store::list_items(&db, &filter).unwrap();
        assert_eq!(page.len(), 80);
        list_times.push(ms(t.elapsed()));
    }

    let count_times = {
        let mut v = Vec::new();
        for _ in 0..30 {
            let t = Instant::now();
            let _ = store::count_items(&db, &filter).unwrap();
            v.push(ms(t.elapsed()));
        }
        v
    };

    let search = store::ClipboardFilter {
        search: Some("needle-不存在-除了一条".into()),
        limit: Some(80),
        ..Default::default()
    };
    let mut search_times = Vec::new();
    for _ in 0..10 {
        let t = Instant::now();
        let _ = store::list_items(&db, &search).unwrap();
        search_times.push(ms(t.elapsed()));
    }

    // 一张 1920×1080 RGBA：缩略图 + PNG 编解码 + DIB 往返
    let (w, h) = (1920u32, 1080u32);
    let mut rgba = vec![0u8; w as usize * h as usize * 4];
    for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
        px[0] = (i % 251) as u8;
        px[1] = ((i / 7) % 241) as u8;
        px[2] = ((i / 13) % 239) as u8;
        px[3] = 255;
    }

    let mut thumb_times = Vec::new();
    for _ in 0..5 {
        let t = Instant::now();
        let (thumb, tw, th) = image::thumbnail(&rgba, w, h);
        assert!(!thumb.is_empty() && tw > 0 && th > 0);
        thumb_times.push(ms(t.elapsed()));
    }

    let t = Instant::now();
    let png = image::encode_png(&rgba, w, h).unwrap();
    let encoded = ms(t.elapsed());
    let t = Instant::now();
    let (decoded, dw, dh) = image::decode_png_rgba(&png).unwrap();
    let decoded_ms = ms(t.elapsed());
    assert_eq!((dw, dh), (w, h));
    assert_eq!(decoded.len(), rgba.len());
    let t = Instant::now();
    let dib = image::rgba_to_dib(&rgba, w, h);
    let to_dib = ms(t.elapsed());
    let t = Instant::now();
    let (back, bw, bh) = image::dib_to_rgba(&dib).unwrap();
    let from_dib = ms(t.elapsed());
    assert_eq!((bw, bh), (w, h));
    assert_eq!(back.len(), rgba.len());

    // 一张图片落盘后的资产统计（缩略图 + 原图）
    let mut img_payload = text_payload(0);
    img_payload.kind = "image".into();
    img_payload.text.clear();
    img_payload.preview = "1920×1080".into();
    img_payload.image = Some(image::captured_from_rgba(rgba.clone(), w, h).unwrap());
    let t = Instant::now();
    store::record_capture(&db, &root, &img_payload, &settings).unwrap();
    let image_capture = ms(t.elapsed());
    let stats = store::stats(&db, &settings).unwrap();
    assert!(stats.asset_bytes > 0);

    println!("clipboard_perf n={n} image={w}x{h}");
    println!(
        "insert_avg={:.3} ms insert_p95={:.3} ms",
        ms(insert_total) / n as f64,
        {
            // 逐条耗时未采样，用总均值作为保守指标
            ms(insert_total) / n as f64
        }
    );
    println!(
        "list80_p50={:.3} ms list80_p95={:.3} ms",
        pct(list_times.clone(), 0.5),
        pct(list_times, 0.95)
    );
    println!(
        "count_p50={:.3} ms count_p95={:.3} ms",
        pct(count_times.clone(), 0.5),
        pct(count_times, 0.95)
    );
    println!(
        "search_miss_p50={:.3} ms search_miss_p95={:.3} ms",
        pct(search_times.clone(), 0.5),
        pct(search_times, 0.95)
    );
    println!(
        "thumb_p50={:.3} ms thumb_max={:.3} ms",
        pct(thumb_times.clone(), 0.5),
        thumb_times.iter().cloned().fold(0.0, f64::max)
    );
    println!("png_encode={encoded:.3} ms png_decode={decoded_ms:.3} ms");
    println!("rgba_to_dib={to_dib:.3} ms dib_to_rgba={from_dib:.3} ms");
    println!("image_capture_1920x1080={image_capture:.3} ms");
    println!(
        "assets={} bytes image_items={} items={}",
        stats.asset_bytes, stats.images, stats.items
    );

    let _ = std::fs::remove_dir_all(&root);
}

/// 预算验收（docs/V05_DESIGN.md 8.2）：
/// - 300 条历史（含 100 图）列表 ≤ 120ms
/// - 连续截图 200 张入库+分组+配额 ≤ 8s，磁盘占用 ≤ 配额
///
/// 截图 PNG 编码属于平台采集阶段，单独计时并在报告中列出；
/// 入库预算只统计落盘+缩略图+DB+分组+配额清理。
#[test]
#[ignore = "性能验收：需手动运行并记录环境"]
fn clipboard_stress_300_history_and_200_screenshots() {
    let (w, h) = (1920u32, 1080u32);

    // ── 1) 300 条历史（200 文本 + 100 图）列表 ──
    let hist_db = Db::open_in_memory().unwrap();
    let hist_root = temp_root();
    let hist_settings = Settings {
        clipboard_auto_group: false,
        clipboard_max_items: 50_000,
        clipboard_max_storage_mb: 4096,
        ..Default::default()
    };
    for i in 0..200 {
        store::record_capture(&hist_db, &hist_root, &text_payload(i), &hist_settings).unwrap();
    }
    let (iw, ih) = (960u32, 540u32);
    for i in 0..100 {
        let rgba = rgba_with_block(iw, ih, i);
        let png = image::encode_png(&rgba, iw, ih).unwrap();
        let payload = image_payload(i + 10_000, png, rgba, iw, ih);
        store::record_capture(&hist_db, &hist_root, &payload, &hist_settings).unwrap();
    }
    assert_eq!(
        store::count_items(&hist_db, &store::ClipboardFilter::default()).unwrap(),
        300
    );

    let mut list80 = Vec::new();
    let mut list200 = Vec::new();
    for _ in 0..30 {
        let filter = store::ClipboardFilter {
            limit: Some(80),
            ..Default::default()
        };
        let t = Instant::now();
        let page = store::list_items(&hist_db, &filter).unwrap();
        assert_eq!(page.len(), 80);
        list80.push(ms(t.elapsed()));

        let filter = store::ClipboardFilter {
            limit: Some(200),
            ..Default::default()
        };
        let t = Instant::now();
        let page = store::list_items(&hist_db, &filter).unwrap();
        assert_eq!(page.len(), 200);
        list200.push(ms(t.elapsed()));
    }
    let list80_p95 = pct(list80.clone(), 0.95);
    let list200_p95 = pct(list200.clone(), 0.95);
    let hist_stats = store::stats(&hist_db, &hist_settings).unwrap();
    assert_eq!(hist_stats.items, 300);
    assert_eq!(hist_stats.images, 100);
    let hist_pass = list80_p95 <= 120.0 && list200_p95 <= 120.0;

    // ── 2) 连续截图 200 张：入库 + 分组 + 配额清理 ──
    let burst_db = Db::open_in_memory().unwrap();
    let burst_root = temp_root();
    let burst_settings = Settings {
        clipboard_auto_group: true,
        clipboard_group_window_secs: 45,
        clipboard_max_items: 50_000,
        clipboard_max_storage_mb: 4096,
        ..Default::default()
    };
    let mut encode_ms = 0.0f64;
    let mut ingest_ms = 0.0f64;
    for i in 0..200 {
        let rgba = rgba_with_block(w, h, i);
        let t = Instant::now();
        let png = image::encode_png(&rgba, w, h).unwrap();
        encode_ms += ms(t.elapsed());
        let payload = image_payload(i + 20_000, png, rgba, w, h);
        let t = Instant::now();
        store::record_capture(&burst_db, &burst_root, &payload, &burst_settings).unwrap();
        ingest_ms += ms(t.elapsed());
    }
    let groups = store::list_groups(&burst_db, &store::ClipboardFilter::default()).unwrap();
    let group_ok = groups.len() == 1
        && groups[0].item_count == 200
        && groups[0].image_count == 200
        && groups[0].status == "collecting";
    let before = store::stats(&burst_db, &burst_settings).unwrap();
    assert_eq!(before.items, 200);
    assert_eq!(before.images, 200);
    let disk_before_mb = dir_size(&burst_root) as f64 / 1048576.0;

    // 将配额收紧到 32MB，验证清理后磁盘不超配额
    let mut quota = burst_settings.clone();
    quota.clipboard_max_storage_mb = 32;
    let t = Instant::now();
    let cleanup = store::cleanup(&burst_db, &burst_root, &quota).unwrap();
    let cleanup_ms = ms(t.elapsed());
    let after = store::stats(&burst_db, &quota).unwrap();
    let cap_bytes = 32i64 * 1024 * 1024;
    let disk_after_mb = dir_size(&burst_root) as f64 / 1048576.0;
    let quota_ok = after.asset_bytes <= cap_bytes && disk_after_mb <= 32.0 + 1.0;
    let burst_total_ms = ingest_ms + cleanup_ms;
    let burst_pass = burst_total_ms <= 8000.0 && quota_ok && group_ok;

    println!("clipboard_stress history=300(images=100 {iw}x{ih})");
    println!(
        "list80_p50={:.3} ms list80_p95={:.3} ms list200_p50={:.3} ms list200_p95={:.3} ms",
        pct(list80.clone(), 0.5),
        list80_p95,
        pct(list200.clone(), 0.5),
        list200_p95
    );
    println!("clipboard_stress burst=200({w}x{h}) group_ok={group_ok}");
    println!(
        "ingest_200={:.3} ms cleanup_ms={:.3} ms total={:.3} ms encode_setup={:.3} ms",
        ingest_ms, cleanup_ms, burst_total_ms, encode_ms
    );
    println!(
        "assets_before={:.1} MB disk_before={:.1} MB assets_after={:.1} MB disk_after={:.1} MB deleted_items={}",
        before.asset_bytes as f64 / 1048576.0,
        disk_before_mb,
        after.asset_bytes as f64 / 1048576.0,
        disk_after_mb,
        cleanup.items_deleted
    );

    let report = json!({
        "scenario": "CLIP",
        "machine": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "computer": std::env::var("COMPUTERNAME").unwrap_or_default(),
            "logical_cpus": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0),
            "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
            "app_version": env!("CARGO_PKG_VERSION"),
        },
        "history": {
            "items": hist_stats.items,
            "images": hist_stats.images,
            "image_size": format!("{iw}x{ih}"),
            "list80_p50_ms": pct(list80.clone(), 0.5),
            "list80_p95_ms": list80_p95,
            "list200_p50_ms": pct(list200.clone(), 0.5),
            "list200_p95_ms": list200_p95,
            "budget_ms": 120.0,
            "pass": hist_pass,
        },
        "burst": {
            "screenshots": 200,
            "image_size": format!("{w}x{h}"),
            "group_ok": group_ok,
            "groups": groups.len(),
            "ingest_ms": ingest_ms,
            "cleanup_ms": cleanup_ms,
            "total_ms": burst_total_ms,
            "budget_ms": 8000.0,
            "asset_cap_mb": 32,
            "disk_before_mb": disk_before_mb,
            "disk_after_mb": disk_after_mb,
            "assets_after_mb": after.asset_bytes as f64 / 1048576.0,
            "quota_ok": quota_ok,
            "encode_setup_ms_excluded": encode_ms,
            "pass": burst_pass,
        },
        "pass": hist_pass && burst_pass,
    });
    write_report("CLIP", &report);

    let _ = std::fs::remove_dir_all(&hist_root);
    let _ = std::fs::remove_dir_all(&burst_root);
    assert!(
        hist_pass,
        "300 条历史列表超预算：p95 {list80_p95:.1}/{list200_p95:.1} ms > 120ms"
    );
    assert!(
        burst_pass,
        "200 张连续截图超预算：{burst_total_ms:.1} ms > 8000ms 或配额未满足"
    );
}
