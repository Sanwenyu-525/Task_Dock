//! Windows 真实应用图标：按需提取、内存缓存、有限并发。
//!
//! 安全边界：
//! - 前端只能传「已保存目标 id」「扫描发现的 app_key」或「真实窗口给出的 exe 路径」，
//!   后端逐项校验身份（exe 路径走绝对路径/.exe/存在/非解释器校验）；
//! - 绝不把未经校验的前端字符串当作任意文件读取；
//! - HICON/HBITMAP/DC 句柄全部释放，提取在 spawn_blocking 中执行，不阻塞 IPC 线程；
//! - 缓存按「稳定身份 + 文件修改时间」失效，避免文件替换后长期显示旧图标。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

#[cfg(windows)]
use windows::core::{Interface, GUID, HSTRING};
#[cfg(windows)]
use windows::Win32::Foundation::SIZE;
#[cfg(windows)]
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    STGM_READ,
};
#[cfg(windows)]
use windows::Win32::UI::Shell::{
    IShellItemImageFactory, IShellLinkW, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK,
    SIIGBF_ICONONLY,
};

#[cfg(windows)]
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC,
    SelectObject, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC,
    HGDIOBJ,
};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
#[cfg(windows)]
use windows_sys::Win32::UI::Shell::{
    ExtractIconExW, SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON,
};
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

use super::app_discovery::DiscoveredApp;
use super::target_resolver;
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// 扫描发现过的应用身份（app_key → 图标来源）。
/// 只有在本次进程扫描中登记过的身份才允许提取图标，杜绝任意路径请求。
#[derive(Clone)]
struct IconSource {
    exe_path: String,
    aumid: String,
}

fn discovered_registry() -> &'static Mutex<HashMap<String, IconSource>> {
    static CELL: OnceLock<Mutex<HashMap<String, IconSource>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 真实图标载荷：PNG data URL + 自适应对比度提示（近白图标需要浅色主题底衬）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppIconData {
    pub url: String,
    /// 平均亮度 ≥ 200 的近白/浅色图标（由后端在编码前用原始 RGBA 判定，零额外解码）。
    #[serde(default)]
    pub light: bool,
}

/// 渐进扫描的批次登记：只追加本批身份，不清空旧登记。
/// 扫描完成前保留旧身份，避免重扫期间已显示图标因登记被清空而请求失败；
/// 扫描结束后由 [`register_discovered`] 整体收敛（清掉已卸载应用）。
pub fn register_discovered_batch(apps: &[DiscoveredApp]) {
    let mut reg = discovered_registry().lock().unwrap();
    for a in apps {
        if a.app_key.is_empty() {
            continue;
        }
        reg.insert(
            a.app_key.clone(),
            IconSource {
                exe_path: a.exe_path.clone(),
                aumid: a.app_user_model_id.clone(),
            },
        );
    }
}

/// 每次扫描成功后登记身份（旧结果整体替换，避免删除的应用长期驻留）。
pub fn register_discovered(apps: &[DiscoveredApp]) {
    let mut reg = discovered_registry().lock().unwrap();
    reg.clear();
    for a in apps {
        if a.app_key.is_empty() {
            continue;
        }
        reg.insert(
            a.app_key.clone(),
            IconSource {
                exe_path: a.exe_path.clone(),
                aumid: a.app_user_model_id.clone(),
            },
        );
    }
}

#[derive(Clone)]
struct CacheEntry {
    stamp: u64,
    icon: Option<AppIconData>,
    /// 插入序号（单调递增），用于达到容量上限时淘汰最旧条目。
    inserted: u64,
}

/// 图标缓存上限与单次淘汰量：达到上限时淘汰最旧的一批，而不是整体清空。
const ICON_CACHE_LIMIT: usize = 512;
const ICON_CACHE_EVICT: usize = 64;

fn icon_cache_seq() -> u64 {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    SEQ.fetch_add(1, Ordering::Relaxed)
}

fn icon_cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CELL: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 容量到顶时淘汰最旧的一批（不是整体清空）。抽成独立函数便于单测：
/// 清空策略会让界面上已显示的图标全部重新提取，滚动列表时形成 IPC 尖峰。
fn evict_oldest_if_full(cache: &mut HashMap<String, CacheEntry>) {    if cache.len() < ICON_CACHE_LIMIT {
        return;
    }
    let mut by_age: Vec<(u64, String)> =
        cache.iter().map(|(k, v)| (v.inserted, k.clone())).collect();
    by_age.sort_unstable_by_key(|(seq, _)| *seq);
    for (_, key) in by_age.into_iter().take(ICON_CACHE_EVICT) {
        cache.remove(&key);
    }
}

/// 图标内存缓存统计：返回（条目数，data URL 字符串的保留字节数）。
pub fn icon_cache_stats() -> (usize, usize) {
    match icon_cache().lock() {
        Ok(cache) => cache_stats(&cache),
        Err(_) => (0, 0),
    }
}

/// 清空图标内存缓存，返回实际释放的（条目数，字节数）。
///
/// 只丢弃本进程缓存的图标副本；系统图标源与磁盘文件不受影响，下次请求会重新提取。
pub fn clear_icon_cache() -> (usize, usize) {
    match icon_cache().lock() {
        Ok(mut cache) => {
            let stats = cache_stats(&cache);
            cache.clear();
            stats
        }
        Err(_) => (0, 0),
    }
}

fn cache_stats(cache: &HashMap<String, CacheEntry>) -> (usize, usize) {
    let bytes = cache
        .values()
        .filter_map(|entry| entry.icon.as_ref())
        .map(|icon| icon.url.len())
        .sum();
    (cache.len(), bytes)
}

/// 文件修改时间（含纳秒）+ 大小，用于缓存失效；取不到时间时仍保留大小维度。
fn file_stamp(path: &str) -> u64 {
    let Ok(meta) = std::fs::metadata(path) else {
        return 0;
    };
    let (secs, nanos) = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| (d.as_secs(), d.subsec_nanos() as u64))
        .unwrap_or((0, 0));
    // 修改时间（含纳秒）+ 文件大小：同名文件被覆盖更新时缓存能失效
    secs.wrapping_mul(1_000_000_000).wrapping_add(nanos) ^ (meta.len() << 32)
}

/// 目标 id → 图标来源（只认数据库里已保存的目标）。
fn source_from_target(db: &Db, target_id: &str) -> AppResult<IconSource> {
    let t = target_resolver::get_target(db, target_id)?
        .ok_or_else(|| AppError::NotFound("目标不存在".into()))?;
    if !t.app_user_model_id.is_empty() {
        super::validate_aumid(&t.app_user_model_id)?;
        return Ok(IconSource {
            exe_path: String::new(),
            aumid: t.app_user_model_id,
        });
    }
    if t.exe_path.is_empty() {
        return Err(AppError::Validation("该目标没有可执行文件".into()));
    }
    // 复用导航层安全校验：绝对路径 + .exe + 存在 + 非解释器
    super::validate_exe_path(&t.exe_path)?;
    Ok(IconSource {
        exe_path: t.exe_path,
        aumid: String::new(),
    })
}

fn source_from_app_key(app_key: &str) -> AppResult<IconSource> {
    let reg = discovered_registry().lock().unwrap();
    let src = reg
        .get(app_key)
        .cloned()
        .ok_or_else(|| AppError::NotFound("应用身份未登记，请刷新应用列表".into()))?;
    if !src.exe_path.is_empty() {
        super::validate_exe_path(&src.exe_path)?;
    }
    Ok(src)
}

/// 提取图标（阻塞调用，调用方负责放进 spawn_blocking）。
/// 返回 `None` 表示该应用没有可用图标（前端回退字母图标），不视为错误。
pub fn extract_icon(
    db: &Db,
    target_id: Option<&str>,
    app_key: Option<&str>,
    exe_path: Option<&str>,
) -> AppResult<Option<AppIconData>> {
    if let Some(id) = target_id.filter(|s| !s.is_empty()) {
        let source = source_from_target(db, id)?;
        return Ok(extract_with_cache(&source));
    }
    if let Some(key) = app_key.filter(|s| !s.is_empty()) {
        let source = source_from_app_key(key)?;
        return Ok(extract_with_cache(&source));
    }
    if let Some(exe) = exe_path.filter(|s| !s.trim().is_empty()) {
        // 目标窗口场景：路径已由窗口枚举产生，仍走导航层安全校验；
        // 校验失败返回错误，前端统一回退字母图标，不打断列表。
        super::validate_exe_path(exe)?;
        return Ok(extract_icon_data_for_exe(exe));
    }
    Err(AppError::Validation("缺少应用身份".into()))
}

/// 按已验证的进程可执行路径提取图标（目标窗口场景）。
/// 路径先走导航层安全校验（绝对路径 / .exe / 存在 / 非解释器），
/// 不把前端字符串当作任意文件读取；同一 exe 复用同一份缓存。
pub fn extract_icon_for_exe(exe_path: &str) -> Option<String> {
    // 旧调用方（剪贴板窗口图标）只需要 data URL；显式路径不走向导出的身份登记。
    extract_icon_data_for_exe(exe_path).map(|i| i.url)
}

/// 带对比度提示的图标载荷（导航应用列表需要 `light` 判定）。
pub fn extract_icon_data_for_exe(exe_path: &str) -> Option<AppIconData> {
    let exe_path = exe_path.trim();
    if exe_path.is_empty() {
        return None;
    }
    super::validate_exe_path(exe_path).ok()?;
    let source = IconSource {
        exe_path: exe_path.to_string(),
        aumid: String::new(),
    };
    extract_with_cache(&source)
}

/// 带缓存的提取：缓存键 = 稳定身份；exe 额外按文件修改时间失效。
fn extract_with_cache(source: &IconSource) -> Option<AppIconData> {    let cache_key = if !source.aumid.is_empty() {
        format!("aumid:{}", source.aumid)
    } else {
        format!("exe:{}", source.exe_path.to_lowercase())
    };
    let stamp = if source.aumid.is_empty() {
        file_stamp(&source.exe_path)
    } else {
        0
    };
    {
        let cache = icon_cache().lock().unwrap();
        if let Some(e) = cache.get(&cache_key) {
            if e.stamp == stamp {
                return e.icon.clone();
            }
        }
    }

    let icon = platform_extract(source);
    {
        let mut cache = icon_cache().lock().unwrap();
        evict_oldest_if_full(&mut cache);
        cache.insert(
            cache_key,
            CacheEntry {
                stamp,
                icon: icon.clone(),
                inserted: icon_cache_seq(),
            },
        );
    }
    icon
}

#[cfg(windows)]
fn platform_extract(source: &IconSource) -> Option<AppIconData> {
    // COM 只用于 UWP 包图标；失败不影响普通 exe。
    if !source.aumid.is_empty() {
        return unsafe { png_from_aumid(&source.aumid) };
    }
    unsafe { png_from_exe(&source.exe_path) }
}

#[cfg(not(windows))]
fn platform_extract(_source: &IconSource) -> Option<AppIconData> {
    None
}

#[cfg(windows)]
fn wide(src: &str) -> Vec<u16> {
    src.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
unsafe fn png_from_exe(exe: &str) -> Option<AppIconData> {
    // 优先让 Shell 直接按 48px 取图标（保留 alpha、适配 HiDPI）；
    // 失败再回退到 SHGetFileInfoW / PE 资源图标。
    if let Some(png) = png_from_shell_item(exe, 48) {
        return Some(png);
    }
    let w = wide(exe);
    // windows-sys 结构体只实现 Clone/Copy，不实现 Default
    let mut shfi: SHFILEINFOW = std::mem::zeroed();
    let ok = SHGetFileInfoW(
        w.as_ptr(),
        FILE_ATTRIBUTE_NORMAL,
        &mut shfi,
        std::mem::size_of::<SHFILEINFOW>() as u32,
        SHGFI_ICON | SHGFI_LARGEICON,
    );
    let mut hicon: HICON = std::ptr::null_mut();
    if ok != 0 && !shfi.hIcon.is_null() {
        hicon = shfi.hIcon;
    } else {
        // Shell 取不到时回退到 PE 资源里的第一个图标。
        let mut large: HICON = std::ptr::null_mut();
        let mut small: HICON = std::ptr::null_mut();
        let n = ExtractIconExW(w.as_ptr(), 0, &mut large, &mut small, 1);
        if !small.is_null() {
            DestroyIcon(small);
        }
        if n > 0 && !large.is_null() {
            hicon = large;
        }
    }
    if hicon.is_null() {
        return None;
    }
    let png = hicon_to_png(hicon);
    DestroyIcon(hicon);
    png
}

#[cfg(windows)]
unsafe fn hicon_to_png(hicon: HICON) -> Option<AppIconData> {
    let mut info: ICONINFO = std::mem::zeroed();
    if GetIconInfo(hicon, &mut info) == 0 {
        return None;
    }
    let out = bitmap_to_png(info.hbmColor, info.hbmMask);
    if !info.hbmColor.is_null() {
        DeleteObject(info.hbmColor as HGDIOBJ);
    }
    if !info.hbmMask.is_null() {
        DeleteObject(info.hbmMask as HGDIOBJ);
    }
    out
}

/// 用 Shell 的 IShellItemImageFactory 按指定尺寸取图标（exe / UWP 通用）。
#[cfg(windows)]
unsafe fn png_from_shell_item(path: &str, size: i32) -> Option<AppIconData> {
    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    let hs = HSTRING::from(path);
    let item: IShellItemImageFactory =
        SHCreateItemFromParsingName(&hs, None::<&windows::Win32::System::Com::IBindCtx>).ok()?;
    let hbmp = item
        .GetImage(
            SIZE { cx: size, cy: size },
            SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK,
        )
        .ok()?;
    // windows crate 的 HBITMAP 是 newtype，内部指针与 windows-sys 句柄一致
    let raw = hbmp.0 as HBITMAP;
    let out = bitmap_to_png(raw, std::ptr::null_mut());
    DeleteObject(raw as HGDIOBJ);
    out
}

#[cfg(windows)]
unsafe fn png_from_aumid(aumid: &str) -> Option<AppIconData> {
    png_from_shell_item(&format!("shell:AppsFolder\\{}", aumid), 48)
}

/// 把 32bpp 位图转成 PNG data URL；mask 为图标 AND 掩码（普通位图传 null）。
#[cfg(windows)]
unsafe fn bitmap_to_png(hbm: HBITMAP, hbm_mask: HBITMAP) -> Option<AppIconData> {
    if hbm.is_null() {
        return None;
    }
    let mut bmp: BITMAP = std::mem::zeroed();
    if GetObjectW(
        hbm as HGDIOBJ,
        std::mem::size_of::<BITMAP>() as i32,
        &mut bmp as *mut _ as *mut _,
    ) == 0
    {
        return None;
    }
    let w = bmp.bmWidth;
    let h = bmp.bmHeight;
    if w <= 0 || h <= 0 || w > 1024 || h > 1024 {
        return None;
    }
    let mut rgba = read_bgra(hbm, w, h)?;
    let mut any_alpha = false;
    for px in rgba.chunks_exact(4) {
        if px[3] != 0 {
            any_alpha = true;
            break;
        }
    }
    if !any_alpha {
        // 旧式图标没有 alpha 通道：用 AND 掩码恢复透明区域。
        if let Some(mask) = read_bgra(hbm_mask, w, h) {
            for i in 0..(w * h) as usize {
                let transparent = mask[i * 4] != 0 || mask[i * 4 + 1] != 0 || mask[i * 4 + 2] != 0;
                rgba[i * 4 + 3] = if transparent { 0 } else { 255 };
            }
        } else {
            for px in rgba.chunks_exact_mut(4) {
                px[3] = 255;
            }
        }
    }
    let url = png_data_url(w as u32, h as u32, &rgba)?;
    Some(AppIconData {
        url,
        light: is_light_icon(&rgba),
    })
}

/// 近白/浅色图标判定：只统计可见像素的平均亮度。
/// 用于给白色/浅色 logo（浅色主题下几乎不可见）加克制底衬与轮廓；
/// 彩色图标保持原始形状与配色，不做统一加底。
#[cfg_attr(not(windows), allow(dead_code))]
fn is_light_icon(rgba: &[u8]) -> bool {
    let mut sum = 0f64;
    let mut count = 0u64;
    for px in rgba.chunks_exact(4) {
        if px[3] < 64 {
            continue;
        }
        sum += 0.2126 * px[0] as f64 + 0.7152 * px[1] as f64 + 0.0722 * px[2] as f64;
        count += 1;
    }
    count > 0 && sum / count as f64 >= 200.0
}

/// 读取位图像素为 RGBA（GDI 返回 BGRA）。
#[cfg(windows)]
unsafe fn read_bgra(hbm: HBITMAP, w: i32, h: i32) -> Option<Vec<u8>> {
    if hbm.is_null() {
        return None;
    }
    let screen: HDC = GetDC(std::ptr::null_mut());
    if screen.is_null() {
        return None;
    }
    let mem = CreateCompatibleDC(screen);
    if mem.is_null() {
        ReleaseDC(std::ptr::null_mut(), screen);
        return None;
    }
    let old = SelectObject(mem, hbm as HGDIOBJ);
    let mut bi: BITMAPINFO = std::mem::zeroed();
    bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h; // 负高度 = top-down，避免行序翻转
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    let mut buf = vec![0u8; (w * h * 4) as usize];
    let got = GetDIBits(
        mem,
        hbm,
        0,
        h as u32,
        buf.as_mut_ptr() as *mut _,
        &mut bi,
        DIB_RGB_COLORS,
    );
    SelectObject(mem, old);
    DeleteDC(mem);
    ReleaseDC(std::ptr::null_mut(), screen);
    if got == 0 {
        return None;
    }
    for px in buf.chunks_exact_mut(4) {
        px.swap(0, 2); // BGRA → RGBA
    }
    Some(buf)
}

#[cfg(windows)]
fn png_data_url(w: u32, h: u32, rgba: &[u8]) -> Option<String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    use base64::Engine;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&out)
    ))
}

// ── 快捷方式目标解析（.lnk 的 LinkInfo 可能是过期路径，IDList 才是真实目标）──

/// 用 Windows Shell（IShellLinkW）解析 .lnk 的真实目标与参数。
/// 返回 (目标路径, 参数, 工作目录)；失败返回 None，由调用方回退到 lnk 解析库。
#[cfg(windows)]
pub fn resolve_shortcut(lnk_path: &str) -> Option<(String, String, String)> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        // CLSID_ShellLink = {00021401-0000-0000-C000-000000000046}
        let clsid = GUID::from_u128(0x00021401_0000_0000_c000_0000_0000_0046);
        let link: IShellLinkW = CoCreateInstance(
            &clsid,
            None::<&windows::core::IUnknown>,
            CLSCTX_INPROC_SERVER,
        )
        .ok()?;
        let file: IPersistFile = link.cast().ok()?;
        let path = HSTRING::from(lnk_path);
        file.Load(&path, STGM_READ).ok()?;

        let mut target = [0u16; 1024];
        link.GetPath(&mut target, std::ptr::null_mut(), 0).ok()?;
        let target = utf16_to_string(&target);
        if target.is_empty() {
            return None;
        }
        let mut args = [0u16; 512];
        let args = match link.GetArguments(&mut args) {
            Ok(()) => utf16_to_string(&args),
            Err(_) => String::new(),
        };
        let mut cwd = [0u16; 512];
        let cwd = match link.GetWorkingDirectory(&mut cwd) {
            Ok(()) => utf16_to_string(&cwd),
            Err(_) => String::new(),
        };
        Some((target, args, cwd))
    }
}

#[cfg(not(windows))]
pub fn resolve_shortcut(_lnk_path: &str) -> Option<(String, String, String)> {
    None
}

/// 取到第一个 NUL 前的字符串（Win32 输出缓冲区）。
pub fn utf16_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// 测试用：清空缓存，避免用例互相污染。
#[allow(dead_code)]
pub fn clear_cache() {
    icon_cache().lock().unwrap().clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 修改全局身份登记表的用例必须串行，避免并行测试互相清空。
    static REGISTRY_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn icon_cache_stats_and_clear_only_touch_cached_copies() {
        // 直接向缓存注入条目，验证统计口径与实际释放量一致（不依赖系统图标提取）。
        let (before_entries, before_bytes) = icon_cache_stats();
        {
            let mut cache = icon_cache().lock().unwrap();
            cache.insert(
                "test:icon-cache-probe".into(),
                CacheEntry {
                    stamp: 0,
                    icon: Some(AppIconData {
                        url: "data:image/png;base64,AAAA".into(),
                        light: false,
                    }),
                    inserted: icon_cache_seq(),
                },
            );
        }
        let (entries, bytes) = icon_cache_stats();
        assert_eq!(entries, before_entries + 1);
        assert_eq!(bytes, before_bytes + "data:image/png;base64,AAAA".len());

        let (cleared_entries, cleared_bytes) = clear_icon_cache();
        assert_eq!(cleared_entries, entries);
        assert_eq!(cleared_bytes, bytes);
        assert_eq!(icon_cache_stats(), (0, 0));
    }

    #[test]
    fn utf16_uses_first_nul() {
        assert_eq!(
            utf16_to_string(&[b'A' as u16, b'B' as u16, 0, b'C' as u16]),
            "AB"
        );
        assert_eq!(utf16_to_string(&[]), "");
    }

    #[test]
    fn file_stamp_changes_when_file_is_replaced() {
        let path =
            std::env::temp_dir().join(format!("task-dock-icon-stamp-{}.bin", std::process::id()));
        std::fs::write(&path, vec![1u8; 16]).unwrap();
        let first = file_stamp(&path.to_string_lossy());
        std::fs::write(&path, vec![2u8; 32]).unwrap();
        let second = file_stamp(&path.to_string_lossy());
        assert_ne!(first, second, "文件更新后缓存键必须变化");
        assert_eq!(file_stamp("C:\\definitely\\missing\\file.exe"), 0);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn extraction_requires_registered_identity() {
        let _guard = REGISTRY_LOCK.lock().unwrap();
        clear_cache();
        build_discovered(Vec::new());
        assert!(
            source_from_app_key("c:\\unknown\\app.exe").is_err(),
            "未登记的 app_key 不得被当作可信文件目标"
        );

        let exe = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let key = exe.to_ascii_lowercase();
        build_discovered(vec![(key.clone(), exe.clone(), String::new())]);
        let src = source_from_app_key(&key).expect("已登记身份应能取到图标来源");
        assert_eq!(src.exe_path, exe);

        build_discovered(Vec::new());
        assert!(source_from_app_key(&key).is_err(), "重新扫描后旧身份应失效");
    }

    #[test]
    fn registry_accepts_uwp_identity_without_exe() {
        let _guard = REGISTRY_LOCK.lock().unwrap();
        build_discovered(vec![(
            "Tencent.WeChat_123!App".into(),
            String::new(),
            "Tencent.WeChat_123!App".into(),
        )]);
        let src = source_from_app_key("Tencent.WeChat_123!App").expect("UWP 身份应按 AUMID 解析");
        assert!(src.exe_path.is_empty());
        assert_eq!(src.aumid, "Tencent.WeChat_123!App");
        build_discovered(Vec::new());
    }

    /// 真实 Win32 提取：测试二进制自身就是一个 exe，必须能拿到 PNG data URL。
    #[cfg(windows)]
    #[test]
    fn extracts_real_icon_png_from_current_exe() {
        let exe = std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let src = IconSource {
            exe_path: exe,
            aumid: String::new(),
        };
        let icon = platform_extract(&src).expect("Windows Shell 应能提取 exe 图标");
        assert!(
            icon.url.starts_with("data:image/png;base64,"),
            "必须是真实 PNG data URL：{}",
            &icon.url[..icon.url.len().min(32)]
        );
    }

    /// 验证真实提取链路：PNG 保留 RGBA 透明通道（浅色主题下的白 logo 依赖透明背景而非白底）。
    #[cfg(windows)]
    #[test]
    fn extracted_shell_icon_png_keeps_alpha_channel() {
        use base64::Engine as _;
        let exe = r"C:\Windows\System32\notepad.exe";
        if !std::path::Path::new(exe).exists() {
            return;
        }
        let src = IconSource {
            exe_path: exe.to_string(),
            aumid: String::new(),
        };
        let icon = platform_extract(&src).expect("记事本图标应可提取");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(icon.url.trim_start_matches("data:image/png;base64,"))
            .expect("data URL 必须可解码");
        let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
            .read_info()
            .expect("必须是合法 PNG");
        let mut buf = vec![0; reader.output_buffer_size().expect("PNG 尺寸可计算")];
        let info = reader.next_frame(&mut buf).expect("PNG 必须可解码");
        assert_eq!(info.color_type, png::ColorType::Rgba, "必须保留 alpha 通道");
        let transparent = buf.chunks_exact(4).filter(|px| px[3] == 0).count();
        assert!(
            transparent > 0,
            "真实图标应存在透明像素（否则提取时被错误铺白底）"
        );
    }

    /// 白色/浅色 logo（透明背景）必须被识别为需要对比度保障；彩色与全透明图标不误判。
    #[test]
    fn light_icon_detection_uses_visible_pixel_luminance() {
        // 透明背景 + 白色字形（类似 ChatGPT/浅色 logo）
        let mut white_on_transparent = Vec::new();
        for _ in 0..8 {
            white_on_transparent.extend_from_slice(&[255, 255, 255, 255]);
            white_on_transparent.extend_from_slice(&[0, 0, 0, 0]);
        }
        assert!(is_light_icon(&white_on_transparent));

        // 彩色图标（Chrome 蓝/红/黄）不应被当成浅色图标
        let mut colored = Vec::new();
        for _ in 0..8 {
            colored.extend_from_slice(&[40, 120, 220, 255]);
            colored.extend_from_slice(&[220, 60, 60, 255]);
            colored.extend_from_slice(&[250, 200, 20, 255]);
        }
        assert!(!is_light_icon(&colored));

        // 全透明图标没有可见像素：不判定为浅色，交给统一字母回退
        let transparent = vec![0u8; 32];
        assert!(!is_light_icon(&transparent));
    }

    /// 资源不存在时返回 None（由前端回退统一图标），而不是报错/panic。
    #[cfg(windows)]
    #[test]
    fn missing_exe_returns_none() {
        let src = IconSource {
            exe_path: "C:\\definitely\\missing\\no-such-app.exe".into(),
            aumid: String::new(),
        };
        assert_eq!(platform_extract(&src), None);
    }

    fn build_discovered(items: Vec<(String, String, String)>) {
        let apps: Vec<DiscoveredApp> = items
            .into_iter()
            .map(|(app_key, exe_path, aumid)| DiscoveredApp {
                app_key,
                display_name: "test".into(),
                category: "other".into(),
                exe_path,
                launch_args: String::new(),
                working_dir: String::new(),
                app_user_model_id: aumid,
                window_title_hint: String::new(),
                source: "test".into(),
                tier: "normal".into(),
            })
            .collect();
        register_discovered(&apps);
    }

    /// 缓存到上限只淘汰最旧的一批：不能整体清空（否则在视图标全部重新提取）。
    #[test]
    fn cache_evicts_oldest_batch_instead_of_clearing_all() {
        let _guard = REGISTRY_LOCK.lock().unwrap();
        let mut cache: HashMap<String, CacheEntry> = HashMap::new();
        for i in 0..ICON_CACHE_LIMIT {
            cache.insert(
                format!("exe:c:\\app\\{}", i),
                CacheEntry {
                    stamp: 0,
                    icon: None,
                    inserted: i as u64,
                },
            );
        }
        evict_oldest_if_full(&mut cache);
        assert_eq!(
            cache.len(),
            ICON_CACHE_LIMIT - ICON_CACHE_EVICT,
            "只淘汰固定数量，不清空整体"
        );
        assert!(
            !cache.contains_key("exe:c:\\app\\0"),
            "最旧条目必须被淘汰"
        );
        assert!(
            cache.contains_key(&format!("exe:c:\\app\\{}", ICON_CACHE_LIMIT - 1)),
            "最新条目必须保留"
        );
        // 未到上限不做任何淘汰。
        let mut small: HashMap<String, CacheEntry> = HashMap::new();
        small.insert(
            "k".into(),
            CacheEntry {
                stamp: 0,
                icon: None,
                inserted: 1,
            },
        );
        evict_oldest_if_full(&mut small);
        assert_eq!(small.len(), 1);
    }
}
