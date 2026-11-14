//! 文件缩略图（Windows Shell IShellItemImageFactory）。
//!
//! 复用系统缩略图管线（图片/视频/PDF 等有注册处理器的类型），不引入额外解码依赖。
//! 失败（无处理器/被占用/超限）返回 None，前端回落文件类型图标——不伪造占位成功。
//! 资源边界：单次像素上限 256、进程级 LRU 缓存 256 条（键含 mtime+size）、
//! 并发信号量 4；HBITMAP 用后即删；COM 按线程初始化（S_FALSE 时不 Uninitialize）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// 缩略图最大边长（CSS 像素 × 2 供高分屏，仍保守）。
pub const MAX_THUMB_PX: u32 = 256;
const CACHE_MAX: usize = 256;
const CONCURRENCY: usize = 4;

static CACHE: OnceLock<Mutex<ThumbCache>> = OnceLock::new();
static SEMAPHORE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();

struct ThumbCache {
    map: HashMap<String, Vec<u8>>,
    /// 插入顺序（LRU 淘汰最旧）。
    order: Vec<String>,
}

impl ThumbCache {
    fn new() -> Self {
        Self {
            map: HashMap::new(),
            order: Vec::new(),
        }
    }
    fn get(&self, key: &str) -> Option<Vec<u8>> {
        self.map.get(key).cloned()
    }
    fn put(&mut self, key: String, bytes: Vec<u8>) {
        if self.map.contains_key(&key) {
            return;
        }
        if self.order.len() >= CACHE_MAX {
            let oldest = self.order.remove(0);
            self.map.remove(&oldest);
        }
        self.order.push(key.clone());
        self.map.insert(key, bytes);
    }
}

fn cache() -> &'static Mutex<ThumbCache> {
    CACHE.get_or_init(|| Mutex::new(ThumbCache::new()))
}

fn semaphore() -> &'static tokio::sync::Semaphore {
    SEMAPHORE.get_or_init(|| tokio::sync::Semaphore::new(CONCURRENCY))
}

/// 缓存键：路径 + mtime + 大小（内容变化后旧缩略图自动失效）。
fn cache_key(path: &Path, mtime_ms: Option<i64>, size: Option<u64>) -> String {
    format!(
        "{}|{}|{}",
        path.to_string_lossy().to_ascii_lowercase(),
        mtime_ms.unwrap_or(0),
        size.unwrap_or(0)
    )
}

/// 取缩略图（PNG 字节）；无处理器或失败返回 None。带缓存与并发上限。
pub async fn thumbnail_png(path: PathBuf, max_px: u32) -> Option<Vec<u8>> {
    let max_px = max_px.clamp(32, MAX_THUMB_PX);
    // 读取元数据用于缓存键（在阻塞线程外做一次轻量 stat 即可）。
    let meta = std::fs::symlink_metadata(&path).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).timestamp_millis());
    let key = cache_key(&path, mtime_ms, (!meta.is_dir()).then_some(meta.len()));
    if let Some(hit) = cache().lock().ok()?.get(&key) {
        return Some(hit);
    }
    let _permit = semaphore().acquire().await.ok()?;
    // 阻塞线程内做 COM + 位图转换；spawn_blocking 失败（任务被中止）按无缩略图处理。
    let bytes = tokio::task::spawn_blocking(move || shell_thumbnail(&path, max_px))
        .await
        .ok()??;
    if let Ok(mut guard) = cache().lock() {
        guard.put(key, bytes.clone());
    }
    Some(bytes)
}

/// Shell 缩略图：SHCreateItemFromParsingName → IShellItemImageFactory::GetImage
/// → HBITMAP → 32bpp DIB → RGBA → PNG。
fn shell_thumbnail(path: &Path, max_px: u32) -> Option<Vec<u8>> {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{DeleteObject, HBITMAP};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::UI::Shell::{SHCreateItemFromParsingName, IShellItemImageFactory, SIIGBF_BIGGERSIZEOK, SIIGBF_THUMBNAILONLY};

    if !path.is_file() {
        return None;
    }
    // COM 初始化：S_OK=本线程首次初始化（需要 Uninitialize）；S_FALSE=已初始化（不能动）。
    let com_owned = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let _com_guard = ComGuard { owned: com_owned.is_ok() };

    let wide: Vec<u16> = path
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let item: IShellItemImageFactory = unsafe {
        SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)
    }
    .ok()?;
    let size = max_px as i32;
    let hbmp: HBITMAP = unsafe {
        item.GetImage(windows::Win32::Foundation::SIZE { cx: size, cy: size }, SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK)
    }
    .ok()?;
    let result = hbmp_to_png(hbmp);
    unsafe { DeleteObject(windows::Win32::Graphics::Gdi::HGDIOBJ(hbmp.0)) };
    result
}

struct ComGuard {
    owned: bool,
}
impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.owned {
            unsafe {
                use windows::Win32::System::Com::CoUninitialize;
                CoUninitialize();
            }
        }
    }
}

/// HBITMAP → PNG（32bpp top-down DIB 读取，BGRA→RGBA）。
fn hbmp_to_png(hbmp: windows::Win32::Graphics::Gdi::HBITMAP) -> Option<Vec<u8>> {
    use windows::Win32::Graphics::Gdi::{
        GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS,
    };
    let mut bm = BITMAP::default();
    let got = unsafe {
        GetObjectW(
            windows::Win32::Graphics::Gdi::HGDIOBJ(hbmp.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut _ as *mut _),
        )
    };
    if got == 0 || bm.bmWidth <= 0 || bm.bmHeight <= 0 {
        return None;
    }
    let (w, h) = (bm.bmWidth as i32, bm.bmHeight as i32);
    let mut bi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            // 负高度 = top-down 行序
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        bmiColors: [Default::default(); 1],
    };
    let mut buf = vec![0u8; (w as usize) * (h as usize) * 4];
    let hdc = unsafe { GetDC(None) };
    let lines = unsafe {
        GetDIBits(
            hdc,
            hbmp,
            0,
            h as u32,
            Some(buf.as_mut_ptr() as *mut _),
            &mut bi,
            DIB_RGB_COLORS,
        )
    };
    unsafe { ReleaseDC(None, hdc) };
    if lines == 0 {
        return None;
    }
    // BGRA → RGBA（Shell 缩略图不透明，A 直接置 255；避免半透明预乘误差）。
    let mut rgba = buf;
    for px in rgba.chunks_exact_mut(4) {
        px.swap(0, 2);
        px[3] = 255;
    }
    encode_png(&rgba, w as u32, h as u32)
}

fn encode_png(rgba: &[u8], w: u32, h: u32) -> Option<Vec<u8>> {
    use std::io::Write;
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
        writer.finish().ok()?;
    }
    let _ = std::io::Write::flush(&mut out);
    Some(out)
}
