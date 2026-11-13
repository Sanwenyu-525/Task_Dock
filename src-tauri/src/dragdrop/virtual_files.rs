//! Windows OLE 虚拟文件（`FileGroupDescriptorW` + `FileContents`）的描述符解析。
//!
//! 只解析**描述符**（谁叫什么、多大）；真正的字节由 `windows_ole` 从
//! `IStream` 流式读出。拆开的原因是：描述符解析是纯字节运算，
//! 可以在没有 COM / 没有 Outlook 的环境里完整单测，而流读取无法。
//!
//! 安全边界：
//! - 描述符只提供**名字与大小**，其中「路径」字段一律不采信，
//!   名字还要过 `names::sanitize_file_name`；
//! - 条数与单条大小都有硬上限，超出直接拒绝而不是先收下再截断；
//! - 大小未知（`0xFFFFFFFF`）是合法状态（流式来源可能不知道总长）。

use crate::dragdrop::names::sanitize_file_name;
use crate::dragdrop::{MAX_ITEMS, MAX_VIRTUAL_FILE_BYTES};

/// `FILEDESCRIPTORW` 单条结构长度（字节）。
///
/// 布局：dwFlags(4) + clsid(16) + sizel(8) + pointl(8) + dwFileAttributes(4)
/// + 3×FILETIME(24) + nFileSizeHigh/Low(8) + cFileName(260×WCHAR=520)
/// + cAlternateFileName(14×WCHAR=28) = 620。
pub const FILEDESCRIPTORW_LEN: usize = 620;
/// 文件名在结构内的偏移。
const NAME_OFFSET: usize = 72;
/// 文件名最大 WCHAR 数。
const NAME_WCHARS: usize = 260;
/// `FD_FILESIZE`：`nFileSizeHigh/Low` 有效。
const FD_FILESIZE: u32 = 0x0000_0040;
/// `FD_ATTRIBUTES`：目录属性有效（虚拟文件夹，本项目不支持）。
const FD_ATTRIBUTES: u32 = 0x0000_0004;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x0000_0010;

/// 一条虚拟文件描述符。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VirtualFileDesc {
    /// 已清洗、可直接当文件名使用的名字。
    pub name: String,
    /// 有大小信息时为 `Some`；来源没给（`0xFFFFFFFF`）时为 `None`。
    pub size: Option<u64>,
    pub is_directory: bool,
}

/// 解析结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileGroup {
    pub files: Vec<VirtualFileDesc>,
    /// 被跳过的条目数（目录、空名、超限等），用于如实报告「部分成功」。
    pub skipped: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub enum DescError {
    /// 数据不足以构成一个完整的 FILEGROUPDESCRIPTOR。
    Truncated,
    /// 条目数超过本通道上限。
    TooMany,
}

impl DescError {
    pub fn reason(&self) -> &'static str {
        match self {
            DescError::Truncated => "虚拟文件描述符不完整",
            DescError::TooMany => "虚拟文件数量超过单次上限",
        }
    }
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    bytes.get(at..at + 4).map(|s| {
        u32::from_le_bytes([s[0], s[1], s[2], s[3]])
    })
}

/// 解析 `FileGroupDescriptorW`。
pub fn parse_file_group_descriptor_w(bytes: &[u8]) -> Result<FileGroup, DescError> {
    let count = u32_at(bytes, 0).ok_or(DescError::Truncated)? as usize;
    if count == 0 {
        return Ok(FileGroup {
            files: Vec::new(),
            skipped: 0,
        });
    }
    // 上限优先判断：不允许「先分配再检查」。
    if count > MAX_ITEMS {
        return Err(DescError::TooMany);
    }
    let need = 4usize
        .checked_add(count.saturating_mul(FILEDESCRIPTORW_LEN))
        .ok_or(DescError::Truncated)?;
    if bytes.len() < need {
        return Err(DescError::Truncated);
    }

    let mut files = Vec::with_capacity(count);
    let mut skipped = 0usize;
    for i in 0..count {
        let base = 4 + i * FILEDESCRIPTORW_LEN;
        let flags = u32_at(bytes, base).unwrap_or(0);
        let attrs = u32_at(bytes, base + 36).unwrap_or(0);
        let size_high = u32_at(bytes, base + 64).unwrap_or(0);
        let size_low = u32_at(bytes, base + 68).unwrap_or(0);

        // 文件名：UTF-16LE，遇 NUL 截断。
        let raw_name: Vec<u16> = (0..NAME_WCHARS)
            .filter_map(|w| {
                let at = base + NAME_OFFSET + w * 2;
                bytes.get(at..at + 2).map(|s| u16::from_le_bytes([s[0], s[1]]))
            })
            .take_while(|u| *u != 0)
            .collect();
        let raw_name = String::from_utf16_lossy(&raw_name);
        if raw_name.trim().is_empty() {
            skipped += 1;
            continue;
        }
        let name = sanitize_file_name(&raw_name, "附件");
        let is_directory = (flags & FD_ATTRIBUTES) != 0 && (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0;
        if is_directory {
            // 虚拟文件夹不支持：跳过并计入「部分成功」，不假装已保存。
            skipped += 1;
            continue;
        }
        let size = if (flags & FD_FILESIZE) != 0
            && !(size_high == u32::MAX && size_low == u32::MAX)
        {
            let value = (u64::from(size_high) << 32) | u64::from(size_low);
            if value > MAX_VIRTUAL_FILE_BYTES {
                // 单条超限：跳过并上报，不进入读取队列。
                skipped += 1;
                continue;
            }
            Some(value)
        } else {
            None
        };
        files.push(VirtualFileDesc {
            name,
            size,
            is_directory,
        });
    }
    Ok(FileGroup { files, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一条描述符（只填本项目会读的字段）。
    fn descriptor(name: &str, size: Option<u64>, is_dir: bool) -> Vec<u8> {
        let mut buf = vec![0u8; FILEDESCRIPTORW_LEN];
        let flags: u32 = 0x0000_0004
            | if size.is_some() { FD_FILESIZE } else { 0 };
        buf[0..4].copy_from_slice(&flags.to_le_bytes());
        let attrs: u32 = if is_dir { FILE_ATTRIBUTE_DIRECTORY } else { 0 };
        buf[36..40].copy_from_slice(&attrs.to_le_bytes());
        let (hi, lo) = match size {
            Some(v) => (((v >> 32) as u32), (v as u32)),
            None => (u32::MAX, u32::MAX),
        };
        buf[64..68].copy_from_slice(&hi.to_le_bytes());
        buf[68..72].copy_from_slice(&lo.to_le_bytes());
        let units: Vec<u16> = name.encode_utf16().take(NAME_WCHARS - 1).collect();
        for (i, u) in units.iter().enumerate() {
            let at = NAME_OFFSET + i * 2;
            buf[at..at + 2].copy_from_slice(&u.to_le_bytes());
        }
        buf
    }

    fn group(desc: &[Vec<u8>]) -> Vec<u8> {
        let mut out = vec![0u8; 4];
        out[0..4].copy_from_slice(&(desc.len() as u32).to_le_bytes());
        for d in desc {
            out.extend_from_slice(d);
        }
        out
    }

    #[test]
    fn 解析单个带大小的附件() {
        let bytes = group(&[descriptor("年度报告.pdf", Some(2048), false)]);
        let got = parse_file_group_descriptor_w(&bytes).expect("应可解析");
        assert_eq!(got.files.len(), 1);
        assert_eq!(got.files[0].name, "年度报告.pdf");
        assert_eq!(got.files[0].size, Some(2048));
        assert_eq!(got.skipped, 0);
    }

    #[test]
    fn 大小未知的流式来源合法() {
        let bytes = group(&[descriptor("a.bin", None, false)]);
        let got = parse_file_group_descriptor_w(&bytes).unwrap();
        assert_eq!(got.files[0].size, None);
    }

    #[test]
    fn 文件名被清洗且不接受路径() {
        let bytes = group(&[descriptor(r"..\..\windows\evil.exe", Some(1), false)]);
        let got = parse_file_group_descriptor_w(&bytes).unwrap();
        assert_eq!(got.files[0].name, "evil.exe");
        assert!(!got.files[0].name.contains(".."));
    }

    #[test]
    fn 目录条目被跳过并计入部分成功() {
        let bytes = group(&[
            descriptor("文件夹", None, true),
            descriptor("真实.txt", Some(3), false),
        ]);
        let got = parse_file_group_descriptor_w(&bytes).unwrap();
        assert_eq!(got.files.len(), 1);
        assert_eq!(got.skipped, 1);
    }

    #[test]
    fn 空名条目被跳过() {
        let bytes = group(&[descriptor("", Some(1), false)]);
        let got = parse_file_group_descriptor_w(&bytes).unwrap();
        assert!(got.files.is_empty());
        assert_eq!(got.skipped, 1);
    }

    #[test]
    fn 超限与截断都明确报错() {
        // 声明 10 条但只给了 1 条的长度 → 截断
        let mut buf = vec![0u8; 4 + FILEDESCRIPTORW_LEN];
        buf[0..4].copy_from_slice(&10u32.to_le_bytes());
        assert_eq!(
            parse_file_group_descriptor_w(&buf),
            Err(DescError::Truncated)
        );
        // 声明多于上限 → 直接拒绝（上限判断优先于长度判断）
        let mut buf2 = vec![0u8; 4];
        buf2[0..4].copy_from_slice(&((MAX_ITEMS + 1) as u32).to_le_bytes());
        assert_eq!(
            parse_file_group_descriptor_w(&buf2),
            Err(DescError::TooMany)
        );
    }

    #[test]
    fn 单条超过虚拟文件上限被跳过() {
        let bytes = group(&[descriptor("huge.bin", Some(MAX_VIRTUAL_FILE_BYTES + 1), false)]);
        let got = parse_file_group_descriptor_w(&bytes).unwrap();
        assert!(got.files.is_empty());
        assert_eq!(got.skipped, 1);
    }
}
