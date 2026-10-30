//! PNG 编解码、缩略图与 Windows DIB 转换。
//!
//! 不依赖图形库：png crate 负责编解码，缩放采用区域平均（缩略图足够）。

use std::io::Cursor;

use super::{CapturedImage, MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS, THUMB_MAX_EDGE};
use crate::error::{AppError, AppResult};

/// 解码前的尺寸闸门。
///
/// 解码后的 RGBA 是 `像素数 ×4`，而纯色/低熵 PNG 的容器可以只有几十 KB，
/// 只按容器字节设限会让一次采集分配出几百 MB～几 GB。所有会解码像素的路径
/// （PNG 与 CF_DIB）都必须在分配前过这道闸门。
pub fn within_image_limits(width: usize, height: usize) -> bool {
    width <= MAX_IMAGE_EDGE as usize
        && height <= MAX_IMAGE_EDGE as usize
        && width
            .checked_mul(height)
            .is_none_or(|n| (n as u64) <= MAX_IMAGE_PIXELS)
}

/// Alpha 通道全为 0 表示「没有被使用」，按不透明归一；有任一非 0 值就是真实透明信息。
///
/// 采集侧对 32bpp CF_DIB 就是这么处理的，内容比较两侧也必须用同一条规则，
/// 否则入库版本（Alpha=255）与 Windows 合成出的 PNG 容器（Alpha=0）
/// 永远判为不同内容。
pub fn canonicalize_unused_alpha(rgba: &mut [u8]) {
    let len = rgba.len() / 4 * 4;
    let body = &mut rgba[..len];
    if len == 0 || !body.chunks_exact(4).all(|px| px[3] == 0) {
        return;
    }
    for px in body.chunks_exact_mut(4) {
        px[3] = 255;
    }
}

pub fn encode_png(rgba: &[u8], width: u32, height: u32) -> AppResult<Vec<u8>> {
    if width == 0 || height == 0 {
        return Err(AppError::Validation("图片尺寸无效".into()));
    }
    let expected = width as usize * height as usize * 4;
    if rgba.len() < expected {
        return Err(AppError::Validation("图片像素数据不完整".into()));
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        // 截图在剪贴板监听线程上编码，速度优先于压缩率（fdeflate）
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(png_err)?;
        writer
            .write_image_data(&rgba[..expected])
            .map_err(png_err)?;
    }
    Ok(out)
}

pub fn decode_png_rgba(bytes: &[u8]) -> AppResult<(Vec<u8>, u32, u32)> {
    let decoder = png::Decoder::new(Cursor::new(bytes));
    let mut reader = decoder.read_info().map_err(png_err)?;
    // 分配前按像素数封顶：纯色/低熵 PNG 容器可以只有几十 KB，
    // 但解码后的 RGBA 是像素数 ×4，不设上限会让监听线程一次性分配几百 MB。
    let (hdr_w, hdr_h) = {
        let info = reader.info();
        (info.width, info.height)
    };
    if !within_image_limits(hdr_w as usize, hdr_h as usize) {
        return Err(AppError::Validation("PNG 图片过大，无法解码".into()));
    }
    let size = reader
        .output_buffer_size()
        .ok_or_else(|| AppError::Validation("PNG 图片过大，无法解码".into()))?;
    let mut buf = vec![0u8; size];
    let info = reader.next_frame(&mut buf).map_err(png_err)?;
    let (w, h) = (info.width, info.height);
    if w == 0 || h == 0 {
        return Err(AppError::Validation("图片尺寸无效".into()));
    }
    let data = &buf[..info.buffer_size()];
    let rgba = match info.color_type {
        png::ColorType::Rgba => data.to_vec(),
        png::ColorType::Rgb => {
            let mut out = Vec::with_capacity(w as usize * h as usize * 4);
            for px in data.chunks_exact(3) {
                out.extend_from_slice(&[px[0], px[1], px[2], 255]);
            }
            out
        }
        png::ColorType::Grayscale => {
            let mut out = Vec::with_capacity(w as usize * h as usize * 4);
            for &g in data {
                out.extend_from_slice(&[g, g, g, 255]);
            }
            out
        }
        png::ColorType::GrayscaleAlpha => {
            let mut out = Vec::with_capacity(w as usize * h as usize * 4);
            for px in data.chunks_exact(2) {
                out.extend_from_slice(&[px[0], px[0], px[0], px[1]]);
            }
            out
        }
        png::ColorType::Indexed => {
            let palette = reader
                .info()
                .palette
                .clone()
                .ok_or_else(|| AppError::Validation("PNG 调色板缺失".into()))?;
            let trns = reader.info().trns.clone();
            let mut out = Vec::with_capacity(w as usize * h as usize * 4);
            for &idx in data {
                let i = idx as usize * 3;
                if i + 2 >= palette.len() {
                    out.extend_from_slice(&[0, 0, 0, 255]);
                    continue;
                }
                let alpha = trns
                    .as_ref()
                    .and_then(|t| t.get(idx as usize).copied())
                    .unwrap_or(255);
                out.extend_from_slice(&[palette[i], palette[i + 1], palette[i + 2], alpha]);
            }
            out
        }
    };
    Ok((rgba, w, h))
}

fn png_err<E: std::fmt::Display>(e: E) -> AppError {
    AppError::Validation(format!("PNG 处理失败: {e}"))
}

/// 剪贴板 PNG 的 Alpha 全为 0 时按“不使用 Alpha”处理，返回是否需要重编码。
///
/// Windows 会给 32bpp BI_RGB 的 DIB 合成一份 PNG，而这类 DIB 的 Alpha 字节
/// 常常全 0（表示不使用）。若原样保存，历史里和粘贴出去的图片会完全透明。
/// 与 `dib_to_rgba` 的兜底保持一致；只有**全部**像素透明时才改写，
/// 部分透明的图标/贴纸保持不变。
pub fn opaque_when_fully_transparent(rgba: &mut [u8]) -> bool {
    if rgba.is_empty() || rgba.len() % 4 != 0 {
        return false;
    }
    if rgba.chunks_exact(4).any(|px| px[3] != 0) {
        return false;
    }
    for px in rgba.chunks_exact_mut(4) {
        px[3] = 255;
    }
    true
}

/// 解析剪贴板 PNG。
///
/// `dib_alpha_unused` 表示同一份剪贴板里存在可证明「Alpha 未被使用」的
/// 32bpp DIB（Windows 会据此合成 Alpha 全 0 的 PNG）。只有这种来源的
/// 全透明 PNG 才会被归一化为不透明；没有 DIB 佐证或 DIB 带真实 Alpha 时，
/// 合法的全透明 PNG 必须原样保留。
pub fn normalize_clipboard_png(
    bytes: Vec<u8>,
    dib_alpha_unused: bool,
) -> AppResult<(Vec<u8>, Vec<u8>, u32, u32)> {
    let (mut rgba, w, h) = decode_png_rgba(&bytes)?;
    if dib_alpha_unused && opaque_when_fully_transparent(&mut rgba) {
        let png = encode_png(&rgba, w, h)?;
        return Ok((png, rgba, w, h));
    }
    Ok((bytes, rgba, w, h))
}

/// 生成最长边不超过 192px 的缩略图（区域平均）。原图更小时原样返回副本。
pub fn thumbnail(rgba: &[u8], width: u32, height: u32) -> (Vec<u8>, u32, u32) {
    let longest = width.max(height);
    if longest <= THUMB_MAX_EDGE {
        return (rgba.to_vec(), width, height);
    }
    let scale = THUMB_MAX_EDGE as f64 / longest as f64;
    let dw = ((width as f64 * scale).round() as u32).max(1);
    let dh = ((height as f64 * scale).round() as u32).max(1);
    let mut out = vec![0u8; dw as usize * dh as usize * 4];
    for dy in 0..dh {
        let y0 = (dy as u64 * height as u64 / dh as u64) as u32;
        let y1 = (((dy + 1) as u64 * height as u64).div_ceil(dh as u64))
            .max(y0 as u64 + 1)
            .min(height as u64) as u32;
        for dx in 0..dw {
            let x0 = (dx as u64 * width as u64 / dw as u64) as u32;
            let x1 = (((dx + 1) as u64 * width as u64).div_ceil(dw as u64))
                .max(x0 as u64 + 1)
                .min(width as u64) as u32;
            let mut sums = [0u64; 4];
            let mut n = 0u64;
            for sy in y0..y1 {
                let row = sy as usize * width as usize * 4;
                for sx in x0..x1 {
                    let i = row + sx as usize * 4;
                    for c in 0..4 {
                        sums[c] += rgba[i + c] as u64;
                    }
                    n += 1;
                }
            }
            let o = (dy as usize * dw as usize + dx as usize) * 4;
            for c in 0..4 {
                out[o + c] = (sums[c] / n) as u8;
            }
        }
    }
    (out, dw, dh)
}

/// DIB 是否**没有提供 Alpha 信息**（Windows 据此合成 Alpha 全 0 的 PNG）。
///
/// 只承认两种可证明情形，用于决定是否可以把同源全透明 PNG 归一化为不透明：
/// - 32bpp BI_RGB：Alpha 字节不属于颜色定义，且整幅像素的 Alpha 字节全为 0；
/// - 32bpp BI_BITFIELDS：Alpha 掩码为 0（40 字节头没有 Alpha 掩码，也按 0 处理）。
///
/// 其余情形（24bpp、带 Alpha 掩码、像素 Alpha 有非零值）一律返回 false，
/// 避免把用户本来希望保留的透明图像误改成不透明。
pub fn dib_alpha_is_unused(data: &[u8]) -> bool {
    if data.len() < 40 {
        return false;
    }
    let header_size = match data[0..4].try_into() {
        Ok(v) => u32::from_le_bytes(v) as usize,
        Err(_) => return false,
    };
    if header_size < 40 || header_size > data.len() {
        return false;
    }
    let width = match data[4..8].try_into() {
        Ok(v) => i32::from_le_bytes(v),
        Err(_) => return false,
    };
    let raw_height = match data[8..12].try_into() {
        Ok(v) => i32::from_le_bytes(v),
        Err(_) => return false,
    };
    let bit_count = match data[14..16].try_into() {
        Ok(v) => u16::from_le_bytes(v),
        Err(_) => return false,
    };
    let compression = match data[16..20].try_into() {
        Ok(v) => u32::from_le_bytes(v),
        Err(_) => return false,
    };
    if width <= 0 || raw_height == 0 || bit_count != 32 {
        return false;
    }
    let w = width as usize;
    let h = raw_height.unsigned_abs() as usize;
    if !within_image_limits(w, h) {
        return false;
    }
    match compression {
        0 => {
            let Some(needed) = (w * 4).checked_mul(h) else {
                return false;
            };
            let Some(end) = header_size.checked_add(needed) else {
                return false;
            };
            if end > data.len() {
                return false;
            }
            (header_size..end).step_by(4).all(|off| data[off + 3] == 0)
        }
        3 => {
            if header_size >= 56 {
                match data[52..56].try_into() {
                    Ok(v) => u32::from_le_bytes(v) == 0,
                    Err(_) => false,
                }
            } else {
                // 40 字节头 + BI_BITFIELDS 只有 RGB 掩码，没有 Alpha 掩码
                header_size == 40
            }
        }
        _ => false,
    }
}

/// 解析 CF_DIB（BITMAPINFOHEADER / V4 / V5）为 RGBA。
/// 仅支持未压缩的 24/32bpp 与调色板 8bpp；无法安全解析时返回 None（不记录坏数据）。
pub fn dib_to_rgba(data: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    if data.len() < 40 {
        return None;
    }
    let header_size = u32::from_le_bytes(data[0..4].try_into().ok()?) as usize;
    if header_size < 40 || header_size > data.len() {
        return None;
    }
    let width = i32::from_le_bytes(data[4..8].try_into().ok()?);
    let raw_height = i32::from_le_bytes(data[8..12].try_into().ok()?);
    let planes = u16::from_le_bytes(data[12..14].try_into().ok()?);
    let bit_count = u16::from_le_bytes(data[14..16].try_into().ok()?);
    let compression = u32::from_le_bytes(data[16..20].try_into().ok()?);
    let clr_used = u32::from_le_bytes(data[32..36].try_into().ok()?);
    if width <= 0 || raw_height == 0 || planes != 1 {
        return None;
    }
    let w = width as usize;
    let h = raw_height.unsigned_abs() as usize;
    if !within_image_limits(w, h) {
        return None;
    }
    let top_down = raw_height < 0;
    if !matches!(compression, 0 | 3) {
        return None;
    }

    let mut masks: [u32; 4] = [0, 0, 0, 0];
    let mut pixel_offset = header_size;
    if compression == 3 {
        if bit_count != 32 {
            return None;
        }
        if header_size >= 56 {
            masks[0] = u32::from_le_bytes(data[40..44].try_into().ok()?);
            masks[1] = u32::from_le_bytes(data[44..48].try_into().ok()?);
            masks[2] = u32::from_le_bytes(data[48..52].try_into().ok()?);
            let alpha = u32::from_le_bytes(data[52..56].try_into().ok()?);
            masks[3] = alpha;
        } else if header_size == 40 {
            if data.len() < 52 {
                return None;
            }
            masks[0] = u32::from_le_bytes(data[40..44].try_into().ok()?);
            masks[1] = u32::from_le_bytes(data[44..48].try_into().ok()?);
            masks[2] = u32::from_le_bytes(data[48..52].try_into().ok()?);
            pixel_offset = 52;
        } else {
            return None;
        }
        if masks[0] == 0 || masks[1] == 0 || masks[2] == 0 {
            return None;
        }
    }

    let mut palette: Vec<[u8; 4]> = Vec::new();
    if bit_count == 8 {
        if compression != 0 {
            return None;
        }
        let count = if clr_used == 0 {
            256
        } else {
            clr_used as usize
        };
        if count > 256 {
            return None;
        }
        let start = header_size;
        let end = start.checked_add(count * 4)?;
        if end > data.len() {
            return None;
        }
        for i in 0..count {
            let p = &data[start + i * 4..start + i * 4 + 4];
            palette.push([p[2], p[1], p[0], 255]);
        }
        pixel_offset = end;
    } else if bit_count != 24 && bit_count != 32 {
        return None;
    }

    let bytes_pp = (bit_count / 8) as usize;
    let stride = (w * bytes_pp).div_ceil(4) * 4;
    let needed = stride.checked_mul(h)?;
    if pixel_offset.checked_add(needed)? > data.len() {
        return None;
    }

    let mut out = vec![0u8; w * h * 4];
    let mut any_alpha = false;
    for y in 0..h {
        let src_row = if top_down { y } else { h - 1 - y };
        let row_start = pixel_offset + src_row * stride;
        for x in 0..w {
            let si = row_start + x * bytes_pp;
            let (r, g, b, a) = match bit_count {
                8 => {
                    let idx = data[si] as usize;
                    let c = palette.get(idx).copied().unwrap_or([0, 0, 0, 255]);
                    (c[0], c[1], c[2], c[3])
                }
                24 => (data[si + 2], data[si + 1], data[si], 255),
                _ => {
                    let px = u32::from_le_bytes(data[si..si + 4].try_into().ok()?);
                    if compression == 3 {
                        let r = mask_component(px, masks[0]);
                        let g = mask_component(px, masks[1]);
                        let b = mask_component(px, masks[2]);
                        let a = mask_component(px, masks[3]);
                        (r, g, b, a)
                    } else {
                        (data[si + 2], data[si + 1], data[si], data[si + 3])
                    }
                }
            };
            if a != 0 {
                any_alpha = true;
            }
            let o = (y * w + x) * 4;
            out[o] = r;
            out[o + 1] = g;
            out[o + 2] = b;
            out[o + 3] = a;
        }
    }
    // CF_DIB 的 32bpp BI_RGB 常常 Alpha 全 0（表示不使用）；BI_BITFIELDS
    // 没有 Alpha 掩码时根本没有透明度信息。两者都不能当成全透明。
    if bit_count == 32 && (compression == 0 || masks[3] == 0) && !any_alpha {
        for px in out.chunks_exact_mut(4) {
            px[3] = 255;
        }
    }
    Some((out, w as u32, h as u32))
}

fn mask_component(pixel: u32, mask: u32) -> u8 {
    if mask == 0 {
        return 0;
    }
    let shift = mask.trailing_zeros();
    let max = mask >> shift;
    if max == 0 {
        return 0;
    }
    (((pixel & mask) >> shift) as u64 * 255 / max as u64) as u8
}

/// RGBA → CF_DIB（32bpp BI_RGB，自下而上）。
pub fn rgba_to_dib(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let w = width as usize;
    let h = height as usize;
    let mut out = vec![0u8; 40 + w * h * 4];
    let put = |out: &mut [u8], off: usize, v: u32| {
        out[off..off + 4].copy_from_slice(&v.to_le_bytes());
    };
    put(&mut out, 0, 40);
    put(&mut out, 4, width);
    put(&mut out, 8, height);
    out[12..14].copy_from_slice(&1u16.to_le_bytes());
    out[14..16].copy_from_slice(&32u16.to_le_bytes());
    put(&mut out, 16, 0);
    put(&mut out, 20, (w * h * 4) as u32);
    for y in 0..h {
        let src = y * w * 4;
        let dst = 40 + (h - 1 - y) * w * 4;
        for x in 0..w {
            let s = src + x * 4;
            let d = dst + x * 4;
            out[d] = rgba[s + 2];
            out[d + 1] = rgba[s + 1];
            out[d + 2] = rgba[s];
            out[d + 3] = rgba[s + 3];
        }
    }
    out
}

/// 供 platform 使用的便捷构造。
pub fn captured_from_rgba(rgba: Vec<u8>, width: u32, height: u32) -> AppResult<CapturedImage> {
    let png = encode_png(&rgba, width, height)?;
    Ok(CapturedImage {
        png,
        width,
        height,
        rgba,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dib_24(width: i32, height: i32, top_down: bool) -> Vec<u8> {
        let w = width as usize;
        let h = height as usize;
        let stride = (w * 3).div_ceil(4) * 4;
        let mut data = vec![0u8; 40 + stride * h];
        data[0..4].copy_from_slice(&40u32.to_le_bytes());
        data[4..8].copy_from_slice(&width.to_le_bytes());
        let signed_h = if top_down { -height } else { height };
        data[8..12].copy_from_slice(&signed_h.to_le_bytes());
        data[12..14].copy_from_slice(&1u16.to_le_bytes());
        data[14..16].copy_from_slice(&24u16.to_le_bytes());
        for y in 0..h {
            // 每行一个固定颜色：BGR
            let row = 40 + y * stride;
            for x in 0..w {
                data[row + x * 3] = 10 + y as u8; // B
                data[row + x * 3 + 1] = 20; // G
                data[row + x * 3 + 2] = 30; // R
            }
        }
        data
    }

    #[test]
    fn decodes_bottom_up_and_top_down_dib() {
        let (rgba, w, h) = dib_to_rgba(&dib_24(2, 2, false)).unwrap();
        assert_eq!((w, h), (2, 2));
        // 自下而上：输出的第一行应来自文件最后一行（B=11）
        assert_eq!(&rgba[0..4], &[30, 20, 11, 255]);
        let (rgba2, _, _) = dib_to_rgba(&dib_24(2, 2, true)).unwrap();
        assert_eq!(&rgba2[0..4], &[30, 20, 10, 255]);
    }

    #[test]
    fn rejects_truncated_or_compressed_dib() {
        let mut d = dib_24(10, 10, false);
        d.truncate(80);
        assert!(dib_to_rgba(&d).is_none(), "截断的 DIB 不得返回坏图");
        let mut d2 = dib_24(2, 2, false);
        d2[16..20].copy_from_slice(&4u32.to_le_bytes()); // BI_JPEG
        assert!(dib_to_rgba(&d2).is_none(), "压缩 DIB 不在支持范围");
    }

    #[test]
    fn png_roundtrip_and_thumbnail_bounds() {
        let w = 400u32;
        let h = 200u32;
        let mut rgba = vec![0u8; (w * h * 4) as usize];
        for (i, px) in rgba.chunks_exact_mut(4).enumerate() {
            px[0] = (i % 256) as u8;
            px[1] = 100;
            px[2] = 200;
            px[3] = 255;
        }
        let png = encode_png(&rgba, w, h).unwrap();
        let (back, bw, bh) = decode_png_rgba(&png).unwrap();
        assert_eq!((bw, bh), (w, h));
        assert_eq!(back.len(), rgba.len());
        assert_eq!(&back[0..4], &rgba[0..4]);

        let (thumb, tw, th) = thumbnail(&back, bw, bh);
        assert_eq!(tw, 192);
        assert_eq!(th, 96);
        assert_eq!(thumb.len(), (tw * th * 4) as usize);
    }

    #[test]
    fn rgba_dib_roundtrip_preserves_visible_colors() {
        let rgba = vec![1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255];
        let dib = rgba_to_dib(&rgba, 2, 2);
        let (back, w, h) = dib_to_rgba(&dib).unwrap();
        assert_eq!((w, h), (2, 2));
        assert_eq!(back, rgba);
    }

    #[test]
    fn fully_transparent_png_is_treated_as_opaque() {
        let mut rgba = vec![200, 40, 40, 0, 40, 160, 60, 0];
        assert!(opaque_when_fully_transparent(&mut rgba));
        assert_eq!(&rgba[3..4], &[255]);
        assert_eq!(&rgba[7..8], &[255]);
        // 已经不透明或部分透明时绝不改动
        let mut visible = vec![1, 2, 3, 255, 4, 5, 6, 255];
        assert!(!opaque_when_fully_transparent(&mut visible));
        assert_eq!(visible, vec![1, 2, 3, 255, 4, 5, 6, 255]);
        let mut mixed = vec![1, 2, 3, 0, 4, 5, 6, 200];
        assert!(!opaque_when_fully_transparent(&mut mixed));
        assert_eq!(&mixed[3..4], &[0]);
        assert_eq!(&mixed[7..8], &[200]);
    }

    #[test]
    fn transparent_png_from_clipboard_is_reencoded_visible() {
        let w = 2u32;
        let h = 2u32;
        let rgba = vec![
            220, 40, 40, 0, 40, 160, 60, 0, 40, 70, 200, 0, 255, 255, 255, 0,
        ];
        let png = encode_png(&rgba, w, h).unwrap();
        let (fixed_png, fixed_rgba, bw, bh) = normalize_clipboard_png(png, true).unwrap();
        assert_eq!((bw, bh), (w, h));
        assert!(fixed_rgba.chunks_exact(4).all(|px| px[3] == 255));
        assert_eq!(&fixed_rgba[0..3], &[220, 40, 40]);
        let (again, _, _) = decode_png_rgba(&fixed_png).unwrap();
        assert!(again.chunks_exact(4).all(|px| px[3] == 255));
        assert_eq!(&again[0..3], &[220, 40, 40]);
    }

    #[test]
    fn legitimate_transparent_png_without_dib_provenance_is_preserved() {
        let rgba = vec![200, 40, 40, 0, 40, 160, 60, 0];
        let png = encode_png(&rgba, 2, 1).unwrap();
        let (same_png, same_rgba, _, _) = normalize_clipboard_png(png.clone(), false).unwrap();
        assert_eq!(same_png, png, "没有 DIB 佐证时不得改动合法透明图");
        assert_eq!(same_rgba, rgba);
    }

    #[test]
    fn partially_transparent_png_is_never_normalized() {
        let rgba = vec![200, 40, 40, 0, 40, 160, 60, 200];
        let png = encode_png(&rgba, 2, 1).unwrap();
        let (same_png, same_rgba, _, _) = normalize_clipboard_png(png.clone(), true).unwrap();
        assert_eq!(same_png, png, "部分透明是用户语义，不得改成不透明");
        assert_eq!(same_rgba, rgba);
    }

    #[test]
    fn opaque_clipboard_png_is_kept_byte_identical() {
        let rgba = vec![1, 2, 3, 255, 4, 5, 6, 200];
        let png = encode_png(&rgba, 2, 1).unwrap();
        let (same_png, same_rgba, _, _) = normalize_clipboard_png(png.clone(), false).unwrap();
        assert_eq!(same_png, png, "有可见像素时不得无谓重编码");
        assert_eq!(same_rgba, rgba);
    }

    /// 32bpp BI_RGB DIB；`alphas` 为逐像素 Alpha（不足复用最后一项）。
    fn dib_32_rgb(width: i32, height: i32, top_down: bool, alphas: &[u8]) -> Vec<u8> {
        let w = width as usize;
        let h = height as usize;
        let stride = w * 4;
        let mut data = vec![0u8; 40 + stride * h];
        data[0..4].copy_from_slice(&40u32.to_le_bytes());
        data[4..8].copy_from_slice(&width.to_le_bytes());
        let signed_h = if top_down { -height } else { height };
        data[8..12].copy_from_slice(&signed_h.to_le_bytes());
        data[12..14].copy_from_slice(&1u16.to_le_bytes());
        data[14..16].copy_from_slice(&32u16.to_le_bytes());
        for y in 0..h {
            let row = 40 + y * stride;
            for x in 0..w {
                let i = y * w + x;
                data[row + x * 4] = 10u8.wrapping_add(y as u8); // B：用于校验行方向
                data[row + x * 4 + 1] = 20; // G
                data[row + x * 4 + 2] = 30; // R
                data[row + x * 4 + 3] = alphas
                    .get(i)
                    .copied()
                    .or_else(|| alphas.last().copied())
                    .unwrap_or(0);
            }
        }
        data
    }

    /// 32bpp BI_BITFIELDS DIB（BITMAPV4HEADER，含 Alpha 掩码）。
    fn dib_32_bitfields(width: i32, height: i32, alpha_mask: u32) -> Vec<u8> {
        let w = width as usize;
        let h = height as usize;
        let header = 108usize;
        let stride = w * 4;
        let mut data = vec![0u8; header + stride * h];
        data[0..4].copy_from_slice(&(header as u32).to_le_bytes());
        data[4..8].copy_from_slice(&width.to_le_bytes());
        data[8..12].copy_from_slice(&height.to_le_bytes());
        data[12..14].copy_from_slice(&1u16.to_le_bytes());
        data[14..16].copy_from_slice(&32u16.to_le_bytes());
        data[16..20].copy_from_slice(&3u32.to_le_bytes()); // BI_BITFIELDS
        data[20..24].copy_from_slice(&((stride * h) as u32).to_le_bytes());
        data[40..44].copy_from_slice(&0x00FF_0000u32.to_le_bytes()); // R
        data[44..48].copy_from_slice(&0x0000_FF00u32.to_le_bytes()); // G
        data[48..52].copy_from_slice(&0x0000_00FFu32.to_le_bytes()); // B
        data[52..56].copy_from_slice(&alpha_mask.to_le_bytes());
        for y in 0..h {
            let row = header + y * stride;
            for x in 0..w {
                let mut px = (200u32 << 16) | (100u32 << 8) | 50;
                if alpha_mask != 0 {
                    let a = if x == 0 && y == 0 { 0u32 } else { 128u32 };
                    px |= a << 24;
                }
                data[row + x * 4..row + x * 4 + 4].copy_from_slice(&px.to_le_bytes());
            }
        }
        data
    }

    #[test]
    fn dib_32bpp_bi_rgb_with_zero_alpha_is_visible() {
        let dib = dib_32_rgb(2, 2, false, &[0]);
        assert!(
            dib_alpha_is_unused(&dib),
            "32bpp BI_RGB 全 0 Alpha 应判定为未使用"
        );
        let (rgba, w, h) = dib_to_rgba(&dib).unwrap();
        assert_eq!((w, h), (2, 2));
        assert!(
            rgba.chunks_exact(4).all(|px| px[3] == 255),
            "不得保存成全透明"
        );
        assert_eq!(&rgba[0..3], &[30, 20, 11], "自下而上：首行来自最后一行");
    }

    #[test]
    fn dib_32bpp_with_real_alpha_keeps_transparency() {
        let dib = dib_32_rgb(2, 2, false, &[0, 128, 255, 64]);
        assert!(!dib_alpha_is_unused(&dib), "像素 Alpha 非零时必须保留");
        let (rgba, _, _) = dib_to_rgba(&dib).unwrap();
        // 自下而上：输出首行来自最后一行（Alpha 255/64），末行来自首行（0/128）
        assert_eq!(&rgba[0..4], &[30, 20, 11, 255]);
        assert_eq!(&rgba[4..8], &[30, 20, 11, 64]);
        assert_eq!(&rgba[8..12], &[30, 20, 10, 0]);
        assert_eq!(&rgba[12..16], &[30, 20, 10, 128]);
    }

    #[test]
    fn dib_bitfields_without_alpha_mask_is_visible() {
        let dib = dib_32_bitfields(2, 2, 0);
        assert!(dib_alpha_is_unused(&dib), "没有 Alpha 掩码即没有透明度");
        let (rgba, w, h) = dib_to_rgba(&dib).unwrap();
        assert_eq!((w, h), (2, 2));
        assert!(rgba.chunks_exact(4).all(|px| px[3] == 255));
        assert_eq!(&rgba[0..3], &[200, 100, 50]);
    }

    #[test]
    fn dib_bitfields_with_alpha_mask_keeps_transparency() {
        let dib = dib_32_bitfields(2, 2, 0xFF00_0000);
        assert!(!dib_alpha_is_unused(&dib), "带 Alpha 掩码时不得改写");
        let (rgba, _, _) = dib_to_rgba(&dib).unwrap();
        // 自下而上：输出首行来自最后一行，那里 Alpha=128
        assert_eq!(&rgba[0..4], &[200, 100, 50, 128]);
        // 文件首行（输出末行）第一个像素 Alpha=0
        assert_eq!(&rgba[8..12], &[200, 100, 50, 0]);
    }

    #[test]
    fn dib_32bpp_top_down_and_large_screenshot() {
        let dib = dib_32_rgb(3, 2, true, &[0]);
        assert!(dib_alpha_is_unused(&dib));
        let (rgba, w, h) = dib_to_rgba(&dib).unwrap();
        assert_eq!((w, h), (3, 2));
        assert_eq!(&rgba[0..3], &[30, 20, 10], "自上而下：首行来自文件首行");
        assert!(rgba.chunks_exact(4).all(|px| px[3] == 255));

        let big = dib_32_rgb(1920, 1080, false, &[0]);
        assert!(dib_alpha_is_unused(&big));
        let (rgba, w, h) = dib_to_rgba(&big).unwrap();
        assert_eq!((w, h), (1920, 1080));
        assert!(rgba.chunks_exact(4).all(|px| px[3] == 255));
    }

    #[test]
    fn repeated_copy_paste_roundtrip_keeps_visible_pixels() {
        let dib = dib_32_rgb(2, 2, false, &[0]);
        let (rgba, w, h) = dib_to_rgba(&dib).unwrap();
        let first = captured_from_rgba(rgba.clone(), w, h).unwrap();
        // 模拟从历史再次复制：PNG → RGBA → DIB → RGBA
        let (roundtrip_rgba, bw, bh) = decode_png_rgba(&first.png).unwrap();
        assert_eq!((bw, bh), (w, h));
        let dib2 = rgba_to_dib(&roundtrip_rgba, bw, bh);
        let (again, _, _) = dib_to_rgba(&dib2).unwrap();
        assert_eq!(again, rgba, "重复复制粘贴不得丢失可见像素或引入透明");
        assert!(again.chunks_exact(4).all(|px| px[3] == 255));
    }

    #[test]
    fn malformed_dib_is_not_reported_as_alpha_unused() {
        assert!(!dib_alpha_is_unused(&[]));
        let mut d = dib_32_rgb(2, 2, false, &[0]);
        d.truncate(48);
        assert!(!dib_alpha_is_unused(&d), "截断 DIB 不能当成可证明来源");
        let mut d2 = dib_32_rgb(2, 2, false, &[0]);
        d2[14..16].copy_from_slice(&24u16.to_le_bytes());
        assert!(!dib_alpha_is_unused(&d2), "24bpp 没有 Alpha 语义");
    }

    #[test]
    fn png_decode_refuses_dimensions_beyond_the_cap() {
        // 闸门必须先于分配生效：像素数 ×4 才是真实驻留，容器字节会骗人。
        assert!(within_image_limits(7680, 4320), "8K 拼接截图在闸门内");
        assert!(within_image_limits(MAX_IMAGE_EDGE as usize, 1));
        assert!(
            !within_image_limits(MAX_IMAGE_EDGE as usize + 1, 1),
            "边长超限"
        );
        assert!(
            !within_image_limits(19_999, 5_001),
            "边长合规但像素总数超限同样必须拒绝"
        );
        assert!(
            !within_image_limits(usize::MAX, usize::MAX),
            "像素数溢出必须拒绝"
        );

        // 端到端：一张合法但边长超限的小 PNG（约 80KB 像素）必须被拒绝解码
        let wide = (MAX_IMAGE_EDGE + 1) as usize;
        let png = encode_png(&vec![0u8; wide * 4], wide as u32, 1).unwrap();
        let err = decode_png_rgba(&png).unwrap_err();
        assert!(
            err.to_string().contains("过大"),
            "超限 PNG 必须明确拒绝而不是尝试解码：{err}"
        );
        // 闸门内的小图必须照常解码
        let rgba = vec![7u8; 2 * 2 * 4];
        let ok = encode_png(&rgba, 2, 2).unwrap();
        let (back, w, h) = decode_png_rgba(&ok).unwrap();
        assert_eq!((back, w, h), (rgba, 2, 2));
    }

    #[test]
    fn canonicalize_unused_alpha_covers_the_last_pixel_and_keeps_real_transparency() {
        // 全 0 Alpha = 未使用通道：含最后一个像素在内都必须置为不透明，
        // 否则「入库版本」与「Windows 合成容器」的最后一个像素永远对不上。
        let mut unused: Vec<u8> = (0..4 * 4).flat_map(|i| [i as u8, 9, 7, 0u8]).collect();
        canonicalize_unused_alpha(&mut unused);
        assert!(unused.chunks_exact(4).all(|px| px[3] == 255));
        let rgb_before: Vec<u8> = unused
            .chunks_exact(4)
            .flat_map(|px| [px[0], px[1], px[2]])
            .collect();
        canonicalize_unused_alpha(&mut unused);
        let rgb_after: Vec<u8> = unused
            .chunks_exact(4)
            .flat_map(|px| [px[0], px[1], px[2]])
            .collect();
        assert_eq!(rgb_before, rgb_after, "归一只能改 Alpha，不得动颜色");

        // 任一非 0 Alpha 就是真实透明信息，绝不当成未使用通道。
        let mut real: Vec<u8> = (0..4 * 4).flat_map(|_| [3u8, 4, 5, 0u8]).collect();
        real[4 * 4 * 4 - 1] = 128;
        canonicalize_unused_alpha(&mut real);
        assert!(real.chunks_exact(4).any(|px| px[3] == 0));

        // 空数据与不足一个像素的数据不能被写坏。
        let mut empty: Vec<u8> = Vec::new();
        canonicalize_unused_alpha(&mut empty);
        assert!(empty.is_empty());
        let mut short = vec![0u8; 3];
        canonicalize_unused_alpha(&mut short);
        assert_eq!(short, vec![0u8; 3]);
    }
}
