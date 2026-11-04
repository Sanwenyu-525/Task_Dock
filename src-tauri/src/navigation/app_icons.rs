//! Windows 真实应用图标：按需提取、内存缓存、有限并发。
//!
//! 安全边界：
//! - 前端只能传「已保存目标 id」或「扫描发现的 app_key」，后端据此解析身份；
//! - 绝不把前端传入的字符串当作任意文件路径读取；
//! - HICON/HBITMAP/DC 句柄全部释放，提取在 spawn_blocking 中执行，不阻塞 IPC 线程；
//! - 缓存按「稳定身份 + 文件修改时间」失效，避免文件替换后长期显示旧图标。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[cfg(windows)]
use windows::core::{GUID, HSTRING, Interface};
#[cfg(windows)]
use windows::Win32::Foundation::SIZE;
#[cfg(windows)]
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, IPersistFile, STGM_READ};
#[cfg(windows)]
use windows::Win32::UI::Shell::{IShellLinkW, IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY};

#[cfg(windows)]
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, SelectObject,
    BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ,
};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
#[cfg(windows)]
use windows_sys::Win32::UI::Shell::{ExtractIconExW, SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

use crate::db::Db;
use crate::error::{AppError, AppResult};
use super::app_discovery::DiscoveredApp;
use super::target_resolver;

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
    url: Option<String>,
}

fn icon_cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CELL: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
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
    secs.wrapping_mul(1_000_000_000)
        .wrapping_add(nanos)
        ^ (meta.len() << 32)
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
) -> AppResult<Option<String>> {
    let source = if let Some(id) = target_id.filter(|s| !s.is_empty()) {
        source_from_target(db, id)?
    } else if let Some(key) = app_key.filter(|s| !s.is_empty()) {
        source_from_app_key(key)?
    } else {
        return Err(AppError::Validation("缺少应用身份".into()));
    };

    Ok(extract_with_cache(&source))
}

/// 按已验证的进程可执行路径提取图标（目标窗口场景）。
/// 路径先走导航层安全校验（绝对路径 / .exe / 存在 / 非解释器），
/// 不把前端字符串当作任意文件读取；同一 exe 复用同一份缓存。
pub fn extract_icon_for_exe(exe_path: &str) -> Option<String> {
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
fn extract_with_cache(source: &IconSource) -> Option<String> {
    let cache_key = if !source.aumid.is_empty() {
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
                return e.url.clone();
            }
        }
    }

    let url = platform_extract(source);
    {
        let mut cache = icon_cache().lock().unwrap();
        if cache.len() >= 512 {
            cache.clear();
        }
        cache.insert(
            cache_key,
            CacheEntry {
                stamp,
                url: url.clone(),
            },
        );
    }
    url
}

#[cfg(windows)]
fn platform_extract(source: &IconSource) -> Option<String> {
    // COM 只用于 UWP 包图标；失败不影响普通 exe。
    if !source.aumid.is_empty() {
        return unsafe { png_from_aumid(&source.aumid) };
    }
    unsafe { png_from_exe(&source.exe_path) }
}

#[cfg(not(windows))]
fn platform_extract(_source: &IconSource) -> Option<String> {
    None
}

#[cfg(windows)]
fn wide(src: &str) -> Vec<u16> {
    src.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
unsafe fn png_from_exe(exe: &str) -> Option<String> {
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
unsafe fn hicon_to_png(hicon: HICON) -> Option<String> {
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
unsafe fn png_from_shell_item(path: &str, size: i32) -> Option<String> {
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
unsafe fn png_from_aumid(aumid: &str) -> Option<String> {
    png_from_shell_item(&format!("shell:AppsFolder\\{}", aumid), 48)
}

/// 把 32bpp 位图转成 PNG data URL；mask 为图标 AND 掩码（普通位图传 null）。
#[cfg(windows)]
unsafe fn bitmap_to_png(hbm: HBITMAP, hbm_mask: HBITMAP) -> Option<String> {
    if hbm.is_null() {
        return None;
    }
    let mut bmp: BITMAP = std::mem::zeroed();
    if GetObjectW(hbm as HGDIOBJ, std::mem::size_of::<BITMAP>() as i32, &mut bmp as *mut _ as *mut _) == 0 {
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
    png_data_url(w as u32, h as u32, &rgba)
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
        let link: IShellLinkW =
            CoCreateInstance(&clsid, None::<&windows::core::IUnknown>, CLSCTX_INPROC_SERVER)
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
    fn utf16_uses_first_nul() {
        assert_eq!(utf16_to_string(&[b'A' as u16, b'B' as u16, 0, b'C' as u16]), "AB");
        assert_eq!(utf16_to_string(&[]), "");
    }

    #[test]
    fn file_stamp_changes_when_file_is_replaced() {
        let path = std::env::temp_dir().join(format!(
            "task-dock-icon-stamp-{}.bin",
            std::process::id()
        ));
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

        let exe = std::env::current_exe().unwrap().to_string_lossy().to_string();
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
        let src = source_from_app_key("Tencent.WeChat_123!App")
            .expect("UWP 身份应按 AUMID 解析");
        assert!(src.exe_path.is_empty());
        assert_eq!(src.aumid, "Tencent.WeChat_123!App");
        build_discovered(Vec::new());
    }

    /// 真实 Win32 提取：测试二进制自身就是一个 exe，必须能拿到 PNG data URL。
    #[cfg(windows)]
    #[test]
    fn extracts_real_icon_png_from_current_exe() {
        let exe = std::env::current_exe().unwrap().to_string_lossy().to_string();
        let src = IconSource {
            exe_path: exe,
            aumid: String::new(),
        };
        let url = platform_extract(&src).expect("Windows Shell 应能提取 exe 图标");
        assert!(
            url.starts_with("data:image/png;base64,"),
            "必须是真实 PNG data URL：{}",
            &url[..url.len().min(32)]
        );
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
            })
            .collect();
        register_discovered(&apps);
    }
}
