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
/// 以 Windows SDK 为准（`windows` crate 0.62 的 `Win32::UI::Shell` 绑定，
/// `#[repr(C, packed(1))]`）：
/// dwFlags(4) + clsid(16) + sizel(8) + pointl(8) + dwFileAttributes(4)
/// + 3×FILETIME(24) + nFileSizeHigh/Low(8) + cFileName(260×WCHAR=520) = **592**。
///
/// 注意：`cAlternateFileName` **不是** `FILEDESCRIPTORW` 的字段（那是
/// `FILEDESCRIPTORW` 之外的旧结构/其它 API 的字段）。把单条长度当成 620
/// 会让合法的 596 字节单文件描述符组被判成截断——这是本轮修复的 P0。
pub const FILEDESCRIPTORW_LEN: usize = 592;
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
    /// 它在原始 `FILEGROUPDESCRIPTORW` 里的序号（= `FileContents.lindex`）。
    ///
    /// **不能**用过滤后数组的下标代替：空名/目录/超限条目会被跳过，
    /// 过滤后的下标会整体前移，导致把后一个文件的流读给前一个文件名。
    pub original_index: usize,
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
            // 原始序号：即使前面的条目被跳过，也不能重新编号。
            original_index: i,
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

    // ── 独立 ABI 样本 ──────────────────────────────────────
    //
    // 下面所有长度/偏移都按 Windows SDK 手写，**不引用**生产常量
    // `FILEDESCRIPTORW_LEN`，也不调用生产测试辅助 `descriptor()`。
    // 这样即使生产常量再次写错，这些用例仍会失败，而不是跟着一起错。

    /// 按 SDK 结构手写的一条 592 字节描述符。
    fn abi_descriptor(name: &str, size: Option<u64>, directory: bool) -> Vec<u8> {
        // 592 = 4 + 16 + 8 + 8 + 4 + 8×3 + 4 + 4 + 260×2（SDK FILEDESCRIPTORW）
        let mut buf = vec![0u8; 592];
        // dwFlags：FD_ATTRIBUTES(0x4) | FD_FILESIZE(0x40)
        let flags: u32 = 0x4 | if size.is_some() { 0x40 } else { 0 };
        buf[0..4].copy_from_slice(&flags.to_le_bytes());
        // dwFileAttributes：FILE_ATTRIBUTE_DIRECTORY(0x10)
        buf[36..40].copy_from_slice(&(if directory { 0x10u32 } else { 0 }).to_le_bytes());
        // nFileSizeHigh/Low；未知大小按 OLE 约定写 0xFFFFFFFF。
        let (hi, lo) = match size {
            Some(v) => ((v >> 32) as u32, v as u32),
            None => (u32::MAX, u32::MAX),
        };
        buf[64..68].copy_from_slice(&hi.to_le_bytes());
        buf[68..72].copy_from_slice(&lo.to_le_bytes());
        // cFileName：UTF-16LE，260 WCHAR，留一个 NUL。
        for (i, unit) in name.encode_utf16().take(259).enumerate() {
            let at = 72 + i * 2;
            buf[at..at + 2].copy_from_slice(&unit.to_le_bytes());
        }
        buf
    }

    fn abi_group(descs: &[Vec<u8>]) -> Vec<u8> {
        let mut out = Vec::with_capacity(4 + descs.len() * 592);
        out.extend_from_slice(&(descs.len() as u32).to_le_bytes());
        for d in descs {
            out.extend_from_slice(d);
        }
        out
    }

    #[test]
    fn windows_sdk_abi_布局是_592_字节() {
        use std::mem::{offset_of, size_of};
        use windows::Win32::UI::Shell::{FILEDESCRIPTORW, FILEGROUPDESCRIPTORW};

        assert_eq!(size_of::<FILEDESCRIPTORW>(), 592);
        assert_eq!(size_of::<FILEGROUPDESCRIPTORW>(), 596);
        assert_eq!(offset_of!(FILEDESCRIPTORW, dwFlags), 0);
        assert_eq!(offset_of!(FILEDESCRIPTORW, dwFileAttributes), 36);
        assert_eq!(offset_of!(FILEDESCRIPTORW, nFileSizeHigh), 64);
        assert_eq!(offset_of!(FILEDESCRIPTORW, nFileSizeLow), 68);
        assert_eq!(offset_of!(FILEDESCRIPTORW, cFileName), 72);
        // 不能直接对 packed 字段取引用（E0793）；先复制到本地数组。
        let fd = FILEDESCRIPTORW::default();
        let name: [u16; 260] = fd.cFileName;
        assert_eq!(name.len(), 260);
    }

    #[test]
    fn 独立样本_596_字节单文件可解析() {
        let bytes = abi_group(&[abi_descriptor("年度报告.pdf", Some(2048), false)]);
        assert_eq!(bytes.len(), 596, "4 字节数量头 + 592 字节描述符");
        let got = parse_file_group_descriptor_w(&bytes).expect("合法 596 字节不得判截断");
        assert_eq!(got.files.len(), 1);
        assert_eq!(got.files[0].name, "年度报告.pdf");
        assert_eq!(got.files[0].size, Some(2048));
        assert_eq!(got.files[0].original_index, 0);
        assert_eq!(got.skipped, 0);
    }

    #[test]
    fn 独立样本_1188_字节双文件可解析() {
        let bytes = abi_group(&[
            abi_descriptor("a.txt", Some(1), false),
            abi_descriptor("图片.png", Some(2), false),
        ]);
        assert_eq!(bytes.len(), 1188, "4 + 592 × 2");
        // 第二个描述符必须从 4 + 592 = 596 开始，文件名在其内偏移 72。
        assert_eq!(596 + 72, 668);
        let got = parse_file_group_descriptor_w(&bytes).unwrap();
        assert_eq!(got.files.len(), 2);
        assert_eq!(got.files[0].name, "a.txt");
        assert_eq!(got.files[1].name, "图片.png");
        assert_eq!(got.files[0].original_index, 0);
        assert_eq!(got.files[1].original_index, 1);
    }

    #[test]
    fn 独立样本_三文件描述符组可解析() {
        let bytes = abi_group(&[
            abi_descriptor("one.bin", Some(3), false),
            abi_descriptor("two.bin", Some(4), false),
            abi_descriptor("three.bin", Some(5), false),
        ]);
        assert_eq!(bytes.len(), 4 + 592 * 3);
        let got = parse_file_group_descriptor_w(&bytes).unwrap();
        assert_eq!(got.files.len(), 3);
        assert_eq!(
            got.files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            ["one.bin", "two.bin", "three.bin"]
        );
        assert_eq!(
            got.files.iter().map(|f| f.original_index).collect::<Vec<_>>(),
            [0, 1, 2]
        );
    }

    #[test]
    fn 合法尾部填充不拒绝() {
        let mut bytes = abi_group(&[abi_descriptor("padded.bin", Some(1), false)]);
        bytes.extend_from_slice(&[0xEE; 37]);
        let got = parse_file_group_descriptor_w(&bytes).expect("尾部填充是合法的");
        assert_eq!(got.files.len(), 1);
        assert_eq!(got.files[0].name, "padded.bin");
    }

    #[test]
    fn 少一个字节才是真截断() {
        let mut bytes = abi_group(&[abi_descriptor("cut.bin", Some(1), false)]);
        bytes.pop();
        assert_eq!(
            parse_file_group_descriptor_w(&bytes),
            Err(DescError::Truncated)
        );
    }

    #[test]
    fn 只有四字节数量头时按截断处理() {
        let mut bytes = 1u32.to_le_bytes().to_vec();
        assert_eq!(
            parse_file_group_descriptor_w(&bytes),
            Err(DescError::Truncated)
        );
        bytes[0..4].copy_from_slice(&0u32.to_le_bytes());
        let empty = parse_file_group_descriptor_w(&bytes).unwrap();
        assert!(empty.files.is_empty());
        assert_eq!(empty.skipped, 0);
    }

    #[test]
    fn 数量超过项目上限直接拒绝() {
        let bytes = ((MAX_ITEMS + 1) as u32).to_le_bytes().to_vec();
        assert_eq!(
            parse_file_group_descriptor_w(&bytes),
            Err(DescError::TooMany)
        );
    }

    #[test]
    fn 极大恶意数量不分配内存直接拒绝() {
        // 只有 4 字节头：若实现先按 u32::MAX 分配再检查，进程会直接 OOM。
        let bytes = u32::MAX.to_le_bytes().to_vec();
        assert_eq!(
            parse_file_group_descriptor_w(&bytes),
            Err(DescError::TooMany)
        );
    }

    #[test]
    fn 原始索引在跳过无效条目后保持不变() {
        let bytes = abi_group(&[
            abi_descriptor("文件夹", None, true),
            abi_descriptor("a.txt", Some(1), false),
            abi_descriptor("b.png", Some(2), false),
        ]);
        let got = parse_file_group_descriptor_w(&bytes).unwrap();
        assert_eq!(got.files.len(), 2);
        assert_eq!(got.skipped, 1);
        assert_eq!(got.files[0].name, "a.txt");
        assert_eq!(got.files[0].original_index, 1);
        assert_eq!(got.files[1].name, "b.png");
        assert_eq!(got.files[1].original_index, 2);
    }

    #[test]
    fn 连续无效条目后的第一个有效项保留原始索引() {
        let bytes = abi_group(&[
            abi_descriptor("", Some(1), false),
            abi_descriptor("dir", None, true),
            abi_descriptor("last.txt", Some(9), false),
        ]);
        let got = parse_file_group_descriptor_w(&bytes).unwrap();
        assert_eq!(got.files.len(), 1);
        assert_eq!(got.skipped, 2);
        assert_eq!(got.files[0].original_index, 2);
        assert_eq!(got.files[0].name, "last.txt");
        assert_eq!(got.files[0].size, Some(9));
    }

    #[test]
    fn 文件名字段偏移与非法路径清洗() {
        let mut desc = abi_descriptor(r"..\..\windows\evil.exe", Some(1), false);
        // 独立断言：名字确实写在 72，而不是靠生产常量猜。
        let first = u16::from_le_bytes([desc[72], desc[73]]);
        assert_eq!(first, u16::from(b'.'));
        // 在名字的 NUL 之后（第 23 个 WCHAR）写一个非零哨兵，确认解析器
        // 在 NUL 处停止，而不是继续吞掉结构内剩余字节。
        desc[72 + 23 * 2..72 + 24 * 2].copy_from_slice(&0x1234u16.to_le_bytes());
        let got = parse_file_group_descriptor_w(&abi_group(&[desc])).unwrap();
        assert_eq!(got.files[0].name, "evil.exe");
        assert!(!got.files[0].name.contains(".."));
        assert!(!got.files[0].name.contains('\\'));
    }

    #[test]
    fn 大小未知是合法状态() {
        let bytes = abi_group(&[abi_descriptor("unknown.bin", None, false)]);
        let got = parse_file_group_descriptor_w(&bytes).unwrap();
        assert_eq!(got.files[0].size, None);
        assert_eq!(got.files[0].original_index, 0);
    }

    #[test]
    fn 超大文件声明被跳过() {
        let bytes = abi_group(&[abi_descriptor(
            "huge.bin",
            Some(MAX_VIRTUAL_FILE_BYTES + 1),
            false,
        )]);
        let got = parse_file_group_descriptor_w(&bytes).unwrap();
        assert!(got.files.is_empty());
        assert_eq!(got.skipped, 1);
    }
}
