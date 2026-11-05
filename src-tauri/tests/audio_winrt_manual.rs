//! 真机 WinRT 语音取证（默认 `#[ignore]`，只在有 Windows 语音包的环境手动执行）：
//!   cargo test --no-default-features --test audio_winrt_manual -- --ignored --nocapture
//!
//! 只输出语音元数据、耗时、字节数与缓存命中标记；不输出播报正文，不写用户目录。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use task_dock_lib::audio::AudioService;

fn temp_cache_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "taskdock-audio-acceptance-{}-{tag}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("创建临时缓存目录");
    dir
}

#[test]
#[ignore = "需要 Windows 系统语音包，手动真机执行"]
fn winrt_lists_system_voices() {
    // 构造不启动 WinRT 线程（P2-01 按需初始化）：分别记录构造与首次使用耗时。
    let construct_started = Instant::now();
    let service = AudioService::new(None);
    println!(
        "constructUs={} workerStarted={}",
        construct_started.elapsed().as_micros(),
        service.is_worker_initialized()
    );
    let first_use = Instant::now();
    let report = service.voices();
    println!(
        "firstUseMs={} (含常驻线程创建与 COM 初始化)",
        first_use.elapsed().as_millis()
    );
    println!(
        "voices ok={} code={} platform={} chineseMale={} chineseFemale={} count={}",
        report.ok,
        report.code,
        report.platform,
        report.has_chinese_male,
        report.has_chinese_female,
        report.voices.len()
    );
    for voice in &report.voices {
        println!(
            "voice name={:?} language={:?} gender={} available={}",
            voice.name, voice.language, voice.gender, voice.available
        );
    }
    assert!(report.ok, "系统语音枚举必须成功：{}", report.message);
}

#[test]
#[ignore = "需要 Windows 系统语音包，手动真机执行"]
fn winrt_synthesize_then_cache_hit() {
    let dir = temp_cache_dir("roundtrip");
    let service = AudioService::new(Some(dir.clone()));
    let started = Instant::now();
    let first = service.synthesize("任务已完成", None, "auto", 100, true, true, 50 * 1024 * 1024);
    println!(
        "first ok={} code={} cached={} persisted={} bytes={} latencyMs={} contentType={:?} voice={:?} fallback={}",
        first.ok,
        first.code,
        first.cached,
        first.persisted,
        first.bytes,
        first.latency_ms,
        first.content_type,
        first.voice_name,
        first.voice_fallback
    );
    assert!(first.ok, "首次合成失败：{}", first.message);
    assert!(!first.cached, "首次合成不应命中缓存");
    assert!(first.bytes > 0);

    let second = service.synthesize("任务已完成", None, "auto", 100, true, true, 50 * 1024 * 1024);
    println!(
        "second ok={} code={} cached={} persisted={} bytes={} latencyMs={}",
        second.ok, second.code, second.cached, second.persisted, second.bytes, second.latency_ms
    );
    assert!(second.ok);
    assert!(second.cached, "相同 Key 第二次必须命中本地缓存");
    let stats = service.cache_report(true, 50);
    println!(
        "cache files={} bytes={} hits={} misses={} writes={} evictions={}",
        stats.files, stats.bytes, stats.hits, stats.misses, stats.writes, stats.evictions
    );
    println!("elapsedMs={}", started.elapsed().as_millis());

    let shutdown_started = Instant::now();
    service.shutdown();
    println!("shutdownMs={}", shutdown_started.elapsed().as_millis());

    let cleared = service.clear_cache();
    println!(
        "clear ok={} removed={} freedBytes={}",
        cleared.ok, cleared.removed_files, cleared.freed_bytes
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
#[ignore = "需要 Windows 系统语音包，手动真机执行"]
fn winrt_voice_and_rate_use_separate_cache_entries() {
    let dir = temp_cache_dir("isolation");
    let service = AudioService::new(Some(dir.clone()));
    let voices = service.voices();
    let female = voices
        .voices
        .iter()
        .find(|v| v.language.to_ascii_lowercase().starts_with("zh") && v.gender == "female")
        .expect("需要中文女声");
    let male = voices
        .voices
        .iter()
        .find(|v| v.language.to_ascii_lowercase().starts_with("zh") && v.gender == "male")
        .expect("需要中文男声");

    let plain = service.synthesize("任务已完成", None, "auto", 100, true, true, 50 * 1024 * 1024);
    let slow = service.synthesize("任务已完成", None, "auto", 150, true, true, 50 * 1024 * 1024);
    // 显式语音使用 120 语速，与上面两种自动组合的 Key 必然不同。
    let by_female = service.synthesize(
        "任务已完成",
        Some(&female.id),
        "female",
        120,
        true,
        true,
        50 * 1024 * 1024,
    );
    let by_male = service.synthesize(
        "任务已完成",
        Some(&male.id),
        "male",
        120,
        true,
        true,
        50 * 1024 * 1024,
    );
    for (label, report) in [
        ("auto@100", &plain),
        ("auto@150", &slow),
        ("female", &by_female),
        ("male", &by_male),
    ] {
        println!(
            "isolation {label} ok={} cached={} voice={:?} fallback={}",
            report.ok, report.cached, report.voice_name, report.voice_fallback
        );
        assert!(report.ok, "{label} 合成失败：{}", report.message);
        assert!(!report.cached, "{label} 首次合成不应命中旧缓存");
    }
    assert_ne!(by_female.voice_id, by_male.voice_id);
    assert_eq!(by_female.voice_id.as_deref(), Some(female.id.as_str()));
    assert_eq!(by_male.voice_id.as_deref(), Some(male.id.as_str()));
    let stats = service.cache_report(true, 50);
    println!("isolation cache files={} bytes={}", stats.files, stats.bytes);
    assert!(stats.files >= 4, "不同语音/语速必须隔离为独立缓存条目");

    let again = service.synthesize(
        "任务已完成",
        Some(&female.id),
        "female",
        120,
        true,
        true,
        50 * 1024 * 1024,
    );
    assert!(again.ok && again.cached, "相同语音+语速必须命中缓存");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
#[ignore = "需要 Windows 系统语音包，手动真机执行"]
fn winrt_concurrent_same_key_synthesizes_once() {
    let dir = temp_cache_dir("concurrent");
    let service = Arc::new(AudioService::new(Some(dir.clone())));
    let mut handles = Vec::new();
    for _ in 0..4 {
        let shared = Arc::clone(&service);
        handles.push(std::thread::spawn(move || {
            shared.synthesize("任务已完成", None, "auto", 100, true, true, 50 * 1024 * 1024)
        }));
    }
    let mut cached_count = 0;
    for handle in handles {
        let report = handle.join().expect("合成线程不应 panic");
        println!(
            "concurrent ok={} cached={} code={} voice={:?}",
            report.ok, report.cached, report.code, report.voice_name
        );
        assert!(report.ok, "并发合成失败：{}", report.message);
        if report.cached {
            cached_count += 1;
        }
    }
    let stats = service.cache_report(true, 50);
    println!(
        "concurrent writes={} files={} hits={} misses={}",
        stats.writes, stats.files, stats.hits, stats.misses
    );
    assert_eq!(stats.writes, 1, "相同 Key 并发只能写一次缓存");
    assert_eq!(stats.files, 1);
    assert!(cached_count >= 3, "其余请求应共享缓存结果");
    let _ = std::fs::remove_dir_all(&dir);
}
