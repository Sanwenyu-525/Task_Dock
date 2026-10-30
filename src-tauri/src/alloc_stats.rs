//! 进程内堆分配统计：区分「Rust 活跃分配增长」与「分配器保留/原生内存增长」。
//!
//! 默认开启，每次分配/释放各两次 relaxed 原子操作；设置
//! `TASK_DOCK_ALLOC_STATS=0` 可关闭计数（关闭后仅一次 relaxed 读取）。
//! 计数只用于诊断，不参与任何业务判断。

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};

static ENABLED: AtomicBool = AtomicBool::new(true);
static LIVE: AtomicI64 = AtomicI64::new(0);
static PEAK: AtomicI64 = AtomicI64::new(0);
static ALLOC_CALLS: AtomicU64 = AtomicU64::new(0);
static DEALLOC_CALLS: AtomicU64 = AtomicU64::new(0);
static TOTAL_ALLOCATED: AtomicU64 = AtomicU64::new(0);

pub struct TrackingAllocator;

impl TrackingAllocator {
    #[inline]
    fn record_alloc(size: usize) {
        if !ENABLED.load(Ordering::Relaxed) {
            return;
        }
        ALLOC_CALLS.fetch_add(1, Ordering::Relaxed);
        TOTAL_ALLOCATED.fetch_add(size as u64, Ordering::Relaxed);
        let live = LIVE.fetch_add(size as i64, Ordering::Relaxed) + size as i64;
        PEAK.fetch_max(live, Ordering::Relaxed);
    }

    #[inline]
    fn record_free(size: usize) {
        if !ENABLED.load(Ordering::Relaxed) {
            return;
        }
        DEALLOC_CALLS.fetch_add(1, Ordering::Relaxed);
        LIVE.fetch_sub(size as i64, Ordering::Relaxed);
    }

    #[inline]
    fn record_resize(old: usize, new: usize) {
        if !ENABLED.load(Ordering::Relaxed) {
            return;
        }
        if new >= old {
            let grow = new - old;
            TOTAL_ALLOCATED.fetch_add(grow as u64, Ordering::Relaxed);
            let live = LIVE.fetch_add(grow as i64, Ordering::Relaxed) + grow as i64;
            PEAK.fetch_max(live, Ordering::Relaxed);
        } else {
            LIVE.fetch_sub((old - new) as i64, Ordering::Relaxed);
        }
    }
}

unsafe impl GlobalAlloc for TrackingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc(layout);
        if !ptr.is_null() {
            Self::record_alloc(layout.size());
        }
        ptr
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc_zeroed(layout);
        if !ptr.is_null() {
            Self::record_alloc(layout.size());
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
        Self::record_free(layout.size());
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let out = System.realloc(ptr, layout, new_size);
        if !out.is_null() {
            Self::record_resize(layout.size(), new_size);
        }
        out
    }
}

pub fn init_from_env() {
    let enabled = std::env::var("TASK_DOCK_ALLOC_STATS")
        .map(|v| v != "0" && !v.eq_ignore_ascii_case("false"))
        .unwrap_or(true);
    ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn snapshot() -> serde_json::Value {
    let live = LIVE.load(Ordering::Relaxed);
    serde_json::json!({
        "alloc_stats_enabled": ENABLED.load(Ordering::Relaxed),
        "live_bytes": live,
        "peak_bytes": PEAK.load(Ordering::Relaxed),
        "alloc_calls": ALLOC_CALLS.load(Ordering::Relaxed),
        "dealloc_calls": DEALLOC_CALLS.load(Ordering::Relaxed),
        "total_allocated_bytes": TOTAL_ALLOCATED.load(Ordering::Relaxed),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_reports_consistent_counters() {
        init_from_env();
        let snap = snapshot();
        let live = snap["live_bytes"].as_i64().unwrap();
        let peak = snap["peak_bytes"].as_i64().unwrap();
        assert!(live > 0, "进程自身分配应大于 0");
        assert!(peak >= live, "峰值不应低于当前活跃分配");
        assert!(snap["alloc_calls"].as_u64().unwrap() > 0);
    }
}
