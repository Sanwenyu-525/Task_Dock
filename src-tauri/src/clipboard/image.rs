//! PNG 编解码、缩略图与 Windows DIB 转换。
//!
//! 不依赖图形库：png crate 负责编解码，缩放采用区域平均（缩略图足够）。

use std::io::Cursor;

use super::{CapturedImage, THUMB_MAX_EDGE};
use crate::error::{AppError, AppResult};

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
    if w > 20_000 || h > 20_000 || w.checked_mul(h)? > 100_000_000 {
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
    // CF_DIB 的 32bpp BI_RGB 常常 Alpha 全 0（表示不使用），不能当成全透明
    if bit_count == 32 && compression == 0 && !any_alpha {
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
}
