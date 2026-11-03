//! 真机验收工具：在**真实 Windows 剪贴板**上跑一遍 v0.5 剪贴板链路。
//!
//! 默认 `#[ignore]`（会短暂占用本机剪贴板，常规 `cargo test` 直接跳过）。
//! 真机验收时显式运行：
//!
//! ```bash
//! TD_REAL_CLIPBOARD=1 \
//!   cargo test --test real_clipboard -- --ignored --nocapture
//! ```
//!
//! 覆盖：红 A / 绿 B / 文本 C / 蓝 D 的顺序与分组、逐条写入真实剪贴板后的
//! 像素与 Alpha 回读、自写不被重复入库、图片/文件/富文本真实格式往返、
//! 用户中途复制不被覆盖、写入中途失败必须放回原内容、结束时恢复用户原内容、
//! 真机目标窗口层只读预检。
//!
//! 真实剪贴板是全局单例：会写入的用例之间用进程内互斥锁串行，
//! 因此可以直接 `-- --ignored` 并行运行，无需 `--test-threads=1`。
//!
//! 边界与诚实性：
//! - 开始前先快照真实剪贴板；**若快照无法恢复（有内容但读不出可写回载荷，或原剪贴板为空、
//!   无法恢复成空）直接中止**，绝不冒丢失用户内容的风险；
//! - 写入型用例使用 RAII `ClipboardRestoreGuard`：正常结束与 panic 栈展开合计最多恢复一次，
//!   恢复仍走 `restore_if_own_content` 的内容归属比较；用户中途复制返回 `KeepUserCopy`
//!   并保留新内容。**强杀、`panic=abort`、系统崩溃/断电不执行 `Drop`，不宣称 100% 可靠**；
//! - 全程只打印类型/尺寸/字节数/计数，绝不打印正文、路径或像素内容；
//! - 「用户中途复制」由本工具在平台边界写入一段模拟内容触发——写入守卫只比较内容归属，
//!   与第三方程序写入等价，但本次写入仍来自本进程，故结论标注为「平台级等价验证」；
//! - 键盘注入（Ctrl+V）与目标应用（微信/浏览器/记事本/Office/Agent 输入框）的实际落地
//!   需要运行中的 GUI，本工具**不做按键注入**，那部分必须人工验收单独记录；
//!   第二个用例只做真机窗口层只读校验（可见目标不含本进程、目标身份可复核、
//!   提权目标按规则拒绝），不向任何窗口发送输入。

use std::cell::{Cell, RefCell};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicU32, Ordering};

use task_dock_lib::clipboard::image;
use task_dock_lib::clipboard::paste::{self, payload_for_item};
use task_dock_lib::clipboard::platform::{
    self, ClipboardMatch, ClipboardPayload, ClipboardRead, RestoreOutcome, Snapshot, WriteGuard,
    WriteOutcome,
};
use task_dock_lib::clipboard::{store, CapturedContent, CapturedImage};
use task_dock_lib::db::{Db, Settings};
use task_dock_lib::error::{AppError, AppResult};

/// 真实剪贴板是**全局单例**：三个用例必须串行，否则互相覆盖内容，
/// 断言会看到对方刚写入的东西（这不是缺陷，是用例并发问题）。
static REAL_CLIPBOARD_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn lock_real_clipboard() -> std::sync::MutexGuard<'static, ()> {
    REAL_CLIPBOARD_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

struct TempRoot(PathBuf);

impl TempRoot {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("td-real-clip-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn solid_image(rgba_color: [u8; 4], w: u32, h: u32) -> CapturedContent {
    let rgba: Vec<u8> = rgba_color
        .iter()
        .copied()
        .cycle()
        .take((w * h * 4) as usize)
        .collect();
    CapturedContent {
        kind: "image".into(),
        text: String::new(),
        html: String::new(),
        preview: String::new(),
        file_paths: vec![],
        image: Some(CapturedImage {
            png: image::encode_png(&rgba, w, h).unwrap(),
            width: w,
            height: h,
            rgba,
        }),
        source_app: "snippingtool.exe".into(),
        source_title: "截图工具".into(),
        source_kind: "owner".into(),
        byte_size: 0,
    }
}

fn text_content(text: &str) -> CapturedContent {
    CapturedContent {
        kind: "text".into(),
        text: text.into(),
        html: String::new(),
        preview: String::new(),
        file_paths: vec![],
        image: None,
        source_app: "notepad.exe".into(),
        source_title: "记事本".into(),
        source_kind: "owner".into(),
        byte_size: 0,
    }
}

/// 只描述载荷，绝不输出正文/路径/像素内容。
fn describe(payload: &ClipboardPayload) -> String {
    match payload {
        ClipboardPayload::Text { text, html } => format!(
            "Text{{text_bytes={}, html={}}}",
            text.len(),
            html.as_ref().map_or(0, |h| h.len())
        ),
        ClipboardPayload::Image { width, height, .. } => format!("Image{{{}x{}}}", width, height),
        ClipboardPayload::Files { paths } => format!("Files{{count={}}}", paths.len()),
    }
}

/// 恢复后端：真实实现复用平台层的 `restore_if_own_content`（同一把访问锁内
/// 先比较内容再写回）；模拟实现用于验证守卫语义，绝不触碰真实剪贴板。
trait RestoreBackend {
    fn restore(
        &self,
        snapshot: &Snapshot,
        last_written: &ClipboardPayload,
    ) -> AppResult<RestoreOutcome>;
}

struct PlatformRestorer<'a> {
    self_write: &'a AtomicU32,
}

impl RestoreBackend for PlatformRestorer<'_> {
    fn restore(
        &self,
        snapshot: &Snapshot,
        last_written: &ClipboardPayload,
    ) -> AppResult<RestoreOutcome> {
        platform::restore_if_own_content(snapshot, last_written, self.self_write)
    }
}

/// 真机写入型测试的 RAII 恢复守卫。
///
/// - 只在调用方**已经取得可恢复快照**后才构造；快照不可安全恢复时调用方必须拒绝启动写入；
/// - 每次成功写入都通过 `note_written` 记录「本进程最后一次写入」，恢复只针对这条内容；
/// - 正常结束走 `finish`；panic 栈展开时 `Drop` 尽力恢复，且同一守卫最多执行一次恢复；
/// - 恢复前的内容归属判断完全交给 `restore_if_own_content`：剪贴板已被用户/其他程序
///   改写时返回 `KeepUserCopy`，绝不覆盖用户新内容；
/// - `Drop` 内不做任何可能再次 panic 的操作，日志只输出类型/字节数与结果，不含正文。
///
/// **能力边界（不宣称 100% 可靠）**：进程被强杀、`panic=abort`、系统崩溃或断电时
/// `Drop` 不会执行，用户剪贴板可能保留测试内容；因此写入型真机测试只允许在
/// 明确授权、可接受短暂占用剪贴板的隔离验收环境运行。
struct ClipboardRestoreGuard<'a> {
    snapshot: Snapshot,
    backend: Box<dyn RestoreBackend + 'a>,
    last_written: Option<ClipboardPayload>,
    restored: bool,
}

impl<'a> ClipboardRestoreGuard<'a> {
    fn new(snapshot: Snapshot, backend: Box<dyn RestoreBackend + 'a>) -> Self {
        Self {
            snapshot,
            backend,
            last_written: None,
            restored: false,
        }
    }

    /// 记录本进程最后一次成功写入；未记录时 `Drop` 不会写回任何内容。
    fn note_written(&mut self, payload: &ClipboardPayload) {
        self.last_written = Some(payload.clone());
    }

    /// 正常结束路径：显式恢复一次；之后 `Drop` 不再重复恢复。
    fn finish(&mut self, label: &str) -> AppResult<RestoreOutcome> {
        if self.restored {
            println!("  {label}：恢复守卫已执行过，跳过重复恢复");
            return Ok(RestoreOutcome::NoSnapshot);
        }
        self.restored = true; // 先标记：即使写回失败也不允许 Drop 再试一次
        let Some(last) = self.last_written.clone() else {
            println!("  {label}：本进程没有成功写入，无需恢复");
            return Ok(RestoreOutcome::NoSnapshot);
        };
        self.backend.restore(&self.snapshot, &last)
    }
}

impl Drop for ClipboardRestoreGuard<'_> {
    fn drop(&mut self) {
        if self.restored {
            return;
        }
        self.restored = true;
        let Some(last) = self.last_written.clone() else {
            // 没有任何成功写入：剪贴板仍是用户原内容，不执行写回。
            return;
        };
        let backend = &self.backend;
        let snapshot = &self.snapshot;
        // 恢复后端理论上不应 panic，但 Drop 处于栈展开中，必须兜住二次 panic。
        let result = catch_unwind(AssertUnwindSafe(|| backend.restore(snapshot, &last)));
        match result {
            Ok(Ok(RestoreOutcome::Restored)) => {
                eprintln!("[恢复守卫] 测试异常退出：已尽力恢复用户原剪贴板");
            }
            Ok(Ok(RestoreOutcome::KeepUserCopy)) => {
                eprintln!(
                    "[恢复守卫] 测试异常退出：剪贴板已被更晚的复制接管，保留当前内容（用户接管，未覆盖）"
                );
            }
            Ok(Ok(RestoreOutcome::NoSnapshot)) => {
                eprintln!("[恢复守卫] 测试异常退出：用户原剪贴板为空，无可恢复快照");
            }
            Ok(Err(e)) => {
                eprintln!("[恢复守卫] 测试异常退出：恢复失败，剪贴板可能仍含测试内容：{e}");
            }
            Err(_) => {
                eprintln!("[恢复守卫] 测试异常退出：恢复过程自身 panic，已吞掉；请人工确认剪贴板");
            }
        }
    }
}

fn read_content(label: &str) -> CapturedContent {
    match platform::read_clipboard(true) {
        ClipboardRead::Content { content: c, .. } => *c,
        ClipboardRead::Skip(reason) => panic!("{label}：真实剪贴板读取被跳过：{reason}"),
        ClipboardRead::Empty(reason) => {
            panic!("{label}：真实剪贴板为空，写入未生效：{reason}")
        }
    }
}

fn write_and_verify(
    payload: &ClipboardPayload,
    watermark: &AtomicU32,
    guard: &mut ClipboardRestoreGuard<'_>,
    label: &str,
) -> u32 {
    let outcome = platform::write_guarded_notifying(payload, WriteGuard::Unconditional, watermark)
        .unwrap_or_else(|e| panic!("{label}：真实剪贴板写入失败：{e}"));
    let WriteOutcome::Written { seq, .. } = outcome else {
        panic!("{label}：无条件写入必须成功，实际 {outcome:?}");
    };
    // 写入成功后立刻登记：后续任何断言 panic 时，Drop 都知道要恢复哪一次内容。
    guard.note_written(payload);
    // 立即比较一次；若真机存在「写入已关闭、格式尚未发布完」的瞬态窗口，
    // 记录下来并再复核，绝不静默放宽成「只要最终一致就算通过」。
    if platform::clipboard_match(payload) != ClipboardMatch::Same {
        let mut recovered_at = None;
        for (i, delay) in [20u64, 40, 80, 150].into_iter().enumerate() {
            std::thread::sleep(std::time::Duration::from_millis(delay));
            if platform::clipboard_match(payload) == ClipboardMatch::Same {
                recovered_at = Some((i + 2, delay));
                break;
            }
        }
        match recovered_at {
            Some((attempt, delay)) => println!(
                "  {label}：立即比较不一致，第 {attempt} 次复核（+{delay}ms）才一致 —— 真机存在瞬态发布窗口"
            ),
            None => panic!(
                "{label}：写入后真实剪贴板内容始终与载荷不一致\n{}",
                mismatch_report(label, payload, seq)
            ),
        }
    }
    println!(
        "  写入 {label} · {} · 回读一致（seq={seq}）",
        describe(payload)
    );
    seq
}

/// 失败诊断：只打印序列号、类型、尺寸与字节数，绝不打印正文/路径/像素内容。
///
/// 序列号用于区分两种完全不同的原因：第三方程序在我们之后写入（真机上的外部干扰），
/// 还是我们自己写入/读回的内容不一致（真实缺陷）。
fn mismatch_report(label: &str, expected: &ClipboardPayload, written_seq: u32) -> String {
    let now = platform::current_sequence();
    let read = platform::read_clipboard(true);
    let current = match &read {
        ClipboardRead::Content { content: c, .. } => format!(
            "kind={} byte_size={} text_len={} html_len={} files={} image={}",
            c.kind,
            c.byte_size,
            c.text.len(),
            c.html.len(),
            c.file_paths.len(),
            c.image
                .as_ref()
                .map(|i| format!("{}x{}", i.width, i.height))
                .unwrap_or_else(|| "-".into()),
        ),
        ClipboardRead::Skip(reason) => format!("skip={reason}"),
        ClipboardRead::Empty(_) => "empty".into(),
    };
    // 图片不一致时进一步区分：PNG 容器差异还是像素差异。
    let text_detail = match (expected, &read) {
        (ClipboardPayload::Text { text: et, html }, ClipboardRead::Content { content: c, .. }) => {
            // 探针：期望「文本完全相同 + 空 HTML 片段」时是否判定一致。
            // 若探针一致而原断言不一致，唯一差别就是剪贴板上存在空的 HTML Format。
            let probe = platform::clipboard_match(&ClipboardPayload::Text {
                text: et.clone(),
                html: Some(String::new()),
            });
            format!(
                " · 文本诊断：文本完全相等={} 期望html={} 空html探针={:?}",
                &c.text == et,
                html.is_some(),
                probe,
            )
        }
        _ => String::new(),
    };
    let image_detail = match (expected, &read) {
        (
            ClipboardPayload::Image {
                png: expect_png,
                width,
                height,
                ..
            },
            ClipboardRead::Content { content: c, .. },
        ) => match c.image.as_ref() {
            Some(img) => {
                let same_png = img.png == *expect_png;
                let (rgba, w, h) = image::decode_png_rgba(expect_png)
                    .unwrap_or_else(|e| panic!("诊断：期望 PNG 必须可解码：{e}"));
                format!(
                    " · 图片诊断：期望png={} 实际png={} png相同={same_png} 期望尺寸={width}x{height} 实际尺寸={}x{} 重解码期望像素={w}x{h} 像素一致={} alpha一致={}",
                    expect_png.len(),
                    img.png.len(),
                    img.width,
                    img.height,
                    img.rgba == rgba,
                    img.rgba
                        .chunks_exact(4)
                        .zip(rgba.chunks_exact(4))
                        .all(|(a, b)| a[3] == b[3]),
                )
            }
            None => " · 实际无图片".into(),
        },
        _ => String::new(),
    };
    format!(
        "{label}：期望 {} · 写入序列号 {written_seq} · 当前序列号 {now} · 当前内容 {current}{image_detail}{text_detail}",
        describe(expected)
    )
}

/// 只有在「结束后确实能把原内容写回去」时才允许开始真机写入。
/// CF_HDROP 的路径可能已被删除，这类快照读得到却写不回，必须提前中止；
/// 同理，读不出可写回载荷（超大图、只支持私有格式）也一律不开始。
fn restorable_snapshot() -> Option<Snapshot> {
    let snapshot = platform::snapshot();
    match snapshot.payload.as_ref() {
        None => match platform::read_clipboard(true) {
            ClipboardRead::Empty(_) => {
                eprintln!(
                    "中止：本机剪贴板为空，平台层没有「恢复为空」的写回能力；为避免测试内容留在剪贴板，拒绝开始写入型真机测试。请先复制一段测试专用内容再运行"
                );
                None
            }
            ClipboardRead::Content { content: c, .. } => {
                eprintln!(
                    "中止：本机剪贴板有内容（kind={}）但无法读成可写回载荷，拒绝开始真机写入以免丢失用户内容",
                    c.kind
                );
                None
            }
            ClipboardRead::Skip(reason) => {
                eprintln!("中止：本机剪贴板当前不可读（{reason}），无法保证可恢复");
                None
            }
        },
        Some(ClipboardPayload::Files { paths })
            if paths.iter().any(|p| !Path::new(p).is_file()) =>
        {
            eprintln!(
                "中止：本机剪贴板里的 {} 个文件路径已不存在，恢复写入必然失败；请先复制一段文本或图片再运行真机验收",
                paths.len()
            );
            None
        }
        Some(_) => Some(snapshot),
    }
}

/// 一次真实读取的只读采样（类型/计数/序列号，绝不含正文、路径或像素）。
fn sample_line(tag: &str) -> String {
    let read = platform::read_clipboard(true);
    let seq = platform::current_sequence();
    let desc = match &read {
        ClipboardRead::Content { content: c, .. } => format!(
            "kind={} files={} text_len={} html_len={} image={}",
            c.kind,
            c.file_paths.len(),
            c.text.len(),
            c.html.len(),
            c.image
                .as_ref()
                .map(|i| format!("{}x{}", i.width, i.height))
                .unwrap_or_else(|| "-".into()),
        ),
        ClipboardRead::Skip(reason) => format!("skip={reason}"),
        ClipboardRead::Empty(_) => "empty".into(),
    };
    format!("{tag}: seq={seq} {desc}")
}

/// 真机上可能存在的第三方干扰：剪贴板历史、剪贴板管理工具、杀毒软件都会在写入后
/// 立刻异步接管剪贴板。写入瞬间的一致性已由 `clipboard_match` 强断言证明；
/// 这里允许在 150ms 内重复读取，只用于**判定能否在本机继续验证后续项**，
/// 任何一次成功都必须是真的读回同一内容，绝不放宽成「跳过即可通过」。
fn read_content_within(label: &str, expect: &ClipboardPayload) -> Option<CapturedContent> {
    for attempt in 0..5 {
        if platform::clipboard_match(expect) == ClipboardMatch::Same {
            let content = read_content(label);
            return Some(content);
        }
        println!(
            "  {label} 第 {} 次读取被外部改写：{}",
            attempt + 1,
            sample_line("采样")
        );
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    None
}

/// 恢复写入后的最终一致性校验。
///
/// `CloseClipboard` 之后 Windows 仍会继续合成/发布延迟渲染格式，即时读取
/// 可能只拿到部分格式（大图尤其明显）。这里用有限次重读确认「用户内容确实
/// 回到剪贴板」，并把实测到的发布窗口打印出来；超过窗口仍不一致就返回最后
/// 一次结果，由调用方带完整诊断失败——不接受“多等一会儿就算通过”之外的放宽。
fn eventual_match(label: &str, expect: &ClipboardPayload) -> ClipboardMatch {
    let delays = [0u64, 20, 40, 80, 150];
    let mut waited = 0u64;
    let mut last = ClipboardMatch::Unavailable;
    for (idx, delay) in delays.iter().enumerate() {
        if idx > 0 {
            std::thread::sleep(std::time::Duration::from_millis(*delay));
            waited += *delay;
        }
        last = platform::clipboard_match(expect);
        if last == ClipboardMatch::Same {
            if waited > 0 {
                println!(
                    "  {label}：即时读取只看到部分格式，{waited}ms 后与用户原内容一致（实测瞬态发布窗口）"
                );
            }
            return last;
        }
        println!(
            "  {label}：第 {} 次读取仍不一致（已等待 {waited}ms）· {}",
            idx + 1,
            sample_line("采样")
        );
    }
    last
}

#[test]
#[ignore = "真机验收工具：会短暂占用本机剪贴板（结束前恢复原内容），需 TD_REAL_CLIPBOARD=1"]
fn real_clipboard_roundtrip_keeps_order_alpha_and_user_content() {
    if std::env::var("TD_REAL_CLIPBOARD")
        .map(|v| v != "1")
        .unwrap_or(true)
    {
        eprintln!("跳过：未设置 TD_REAL_CLIPBOARD=1（常规测试不触碰本机剪贴板）");
        return;
    }
    if !cfg!(windows) {
        eprintln!("跳过：本工具只在 Windows 真机上有意义（非 Windows 走 stub 实现）");
        return;
    }

    // ── 0. 先确认真实剪贴板可恢复，否则一律不开始 ──────────────────
    let _serial = lock_real_clipboard();
    let Some(snapshot) = restorable_snapshot() else {
        return;
    };
    let original = snapshot.payload.clone();
    let original_desc = original.as_ref().map(describe).unwrap_or_else(|| "空".into());
    println!("开始真机验收；用户原剪贴板={original_desc}");

    let tmp = TempRoot::new("roundtrip");
    let root = tmp.0.join("clipboard");
    let db = Db::open(&tmp.0.join("app.db")).expect("真机验收需要本地库");
    let settings = Settings {
        clipboard_auto_group: true,
        clipboard_group_window_secs: 60,
        ..Default::default()
    };

    // ── 1. 红 A / 绿 B / 文本 C / 蓝 D 采集入库 ────────────────────
    // D 用半透明蓝（alpha 128），专门验证真实 Alpha 通道不被丢掉。
    let seq = [
        solid_image([220, 40, 40, 255], 37, 23),
        solid_image([40, 180, 80, 255], 53, 31),
        text_content("文本 C · 真机验收 · mixed 123"),
        solid_image([40, 80, 220, 128], 61, 17),
    ];
    let mut group_id: Option<String> = None;
    for p in &seq {
        let out = store::record_capture(&db, &root, p, &settings)
            .unwrap_or_else(|e| panic!("采集入库失败：{e}"));
        assert!(out.created, "四种内容互不相同，必须各建一条");
        if p.kind == "image" {
            group_id = group_id.or(out.group_id);
        }
    }
    let group_id = group_id.expect("首张图片必须自动成组");
    let group = store::get_group(&db, &group_id).expect("分组必须可查");
    assert_eq!(
        group
            .items
            .iter()
            .map(|i| i.kind.as_str())
            .collect::<Vec<_>>(),
        vec!["image", "image", "text", "image"],
        "A/B/C/D 的实际复制顺序不得被分组打乱"
    );
    assert_eq!(group.image_count, 3);
    println!(
        "分组顺序正确：{} 项 / {} 图",
        group.items.len(),
        group.image_count
    );

    // ── 2. 逐条写入真实剪贴板并回读校验像素/文本 ───────────────────
    let watermark = AtomicU32::new(0);
    // 快照已确认可恢复；守卫从这里接管生命周期，panic 时由 Drop 尽力恢复。
    let mut restore_guard =
        ClipboardRestoreGuard::new(snapshot, Box::new(PlatformRestorer { self_write: &watermark }));
    for (idx, item) in group.items.iter().enumerate() {
        let label = format!("第 {} 项({})", idx + 1, item.kind);
        let payload = payload_for_item(&db, &root, item)
            .unwrap_or_else(|e| panic!("{}：载荷构造失败：{e}", label));
        write_and_verify(&payload, &watermark, &mut restore_guard, &label);

        let back = read_content_within(&label, &payload).unwrap_or_else(|| {
            panic!(
                "环境阻塞：{label} 写入成功后 150ms 内剪贴板被第三方持续改写，本机无法回读判定（写入瞬间一致性已单独断言通过）"
            )
        });
        match item.kind.as_str() {
            "text" => {
                assert_eq!(back.kind, "text", "{}：类型判定必须为文本", label);
                assert_eq!(back.text, item.text, "{}：文本必须逐字符回读一致", label);
            }
            _ => {
                let img = back
                    .image
                    .as_ref()
                    .unwrap_or_else(|| panic!("{label}：读不回图片"));
                assert_eq!(
                    (img.width, img.height),
                    (
                        item.image_width.unwrap_or(0),
                        item.image_height.unwrap_or(0)
                    ),
                    "{label}：真实剪贴板回读尺寸必须与入库一致"
                );
                let src = seq[idx].image.as_ref().expect("样例图片载荷");
                assert_eq!(
                    img.rgba, src.rgba,
                    "{label}：像素（含 Alpha）必须与源图完全一致"
                );
            }
        }
        // 自写不得被重复入库：把真实回读内容再走一次采集，必须命中去重。
        let again = store::record_capture(&db, &root, &back, &settings)
            .unwrap_or_else(|e| panic!("{label}：自写复核采集失败：{e}"));
        assert!(
            !again.created,
            "{label}：本进程写入的内容必须去重而不是新建"
        );
        assert_eq!(again.item.id, item.id, "{label}：去重必须命中原条目");
    }

    // ── 3. 全透明图：Windows 合成路径的 Alpha 归一化 ────────────────
    let ghost = solid_image([10, 200, 90, 0], 24, 18);
    let ghost_img = ghost.image.as_ref().expect("全透明样例载荷");
    let ghost_payload = ClipboardPayload::Image {
        png: ghost_img.png.clone(),
        rgba: Some(ghost_img.rgba.clone()),
        width: ghost_img.width,
        height: ghost_img.height,
    };
    write_and_verify(&ghost_payload, &watermark, &mut restore_guard, "全透明图");
    let ghost_back = read_content_within("全透明图", &ghost_payload)
        .unwrap_or_else(|| panic!("环境阻塞：全透明图写入后被第三方改写，本机不可判定"));
    let ghost_read = ghost_back
        .image
        .unwrap_or_else(|| panic!("全透明图必须能从真实剪贴板读回"));
    assert!(
        ghost_read.rgba.chunks_exact(4).all(|px| px[3] == 255),
        "Alpha 全 0 的合成 PNG 必须归一化为不透明，绝不能存成空白"
    );
    println!("  全透明图回读：Alpha 已按文档归一化为不透明（RGB 保持源色）");
    assert_eq!(ghost_read.rgba[0], 10);
    assert_eq!(ghost_read.rgba[1], 200);
    assert_eq!(ghost_read.rgba[2], 90);

    // ── 4. 文件与富文本格式的真实往返 ──────────────────────────────
    let mut files = Vec::new();
    for n in 0..2 {
        let f = tmp.0.join(format!("real-clip-{n}.txt"));
        std::fs::write(&f, format!("真机验收文件 {n}")).unwrap();
        files.push(f.to_string_lossy().to_string());
    }
    let files_payload = ClipboardPayload::Files {
        paths: files.clone(),
    };
    write_and_verify(&files_payload, &watermark, &mut restore_guard, "文件");
    println!("  {}", sample_line("文件写入后即时采样"));
    let files_back = read_content_within("文件", &files_payload)
        .unwrap_or_else(|| panic!("环境阻塞：CF_HDROP 在写入后被第三方剥离，本机不可判定"));
    println!("  {}", sample_line("文件回读成功采样"));
    assert_eq!(files_back.kind, "files", "CF_HDROP 必须判定为文件");
    let mut got = files_back.file_paths.clone();
    got.sort();
    let mut want = files.clone();
    want.sort();
    assert_eq!(got, want, "CF_HDROP 必须原样带回全部路径");

    let rich = ClipboardPayload::Text {
        text: "真机富文本 TD-REAL-HTML-MARKER".into(),
        html: Some("<b>真机富文本</b> TD-REAL-HTML-MARKER".into()),
    };
    write_and_verify(&rich, &watermark, &mut restore_guard, "富文本");
    // 富文本是模拟接管前本进程的最后一次写入；守卫已记录，用于内容守卫与最终恢复。
    let rich_back = read_content_within("富文本", &rich)
        .unwrap_or_else(|| panic!("环境阻塞：CF_HTML 写入后被第三方改写，本机不可判定"));
    assert!(
        rich_back.text.contains("TD-REAL-HTML-MARKER"),
        "纯文本备用必须可读"
    );
    assert!(
        rich_back.html.contains("TD-REAL-HTML-MARKER"),
        "CF_HTML 片段必须可读回"
    );

    // ── 5. 用户中途复制：守卫拒绝覆盖 ──────────────────────────────
    let takeover = ClipboardPayload::Text {
        text: "用户中途复制 TD-REAL-TAKEOVER-MARKER".into(),
        html: None,
    };
    platform::write_payload(&takeover).expect("模拟用户中途复制必须写入成功");
    println!("  已写入模拟的用户内容（平台边界：守卫只看内容归属）");
    let guarded_next = ClipboardPayload::Text {
        text: "队列里的下一项 TD-REAL-SHOULD-NOT-LAND".into(),
        html: None,
    };
    let blocked = platform::write_guarded(&guarded_next, WriteGuard::Content(&rich))
        .expect("守卫写入调用本身不得报错");
    assert_eq!(
        blocked,
        WriteOutcome::SequenceChanged,
        "内容已不是本进程最后一次写入时，守卫必须拒绝 EmptyClipboard"
    );
    assert_eq!(
        eventual_match("用户接管", &takeover),
        ClipboardMatch::Same,
        "用户中途复制的内容必须原样保留，绝不被队列覆盖\n{}",
        mismatch_report("用户接管", &takeover, platform::current_sequence()),
    );
    assert_ne!(
        platform::clipboard_match(&guarded_next),
        ClipboardMatch::Same,
        "被拒绝的写入不得落到真实剪贴板"
    );
    // 这段「模拟用户内容」是测试自己写入的，登记为最后一次写入以便结束时清理；
    // 真实用户中途复制不会经过本进程，内容归属比较会返回 KeepUserCopy 并保留用户内容。
    restore_guard.note_written(&takeover);

    // ── 6. 恢复用户原内容 ─────────────────────────────────────────
    let restored = restore_guard
        .finish("恢复用户原内容")
        .expect("恢复调用本身不得报错");
    match (original.as_ref(), restored) {
        (None, RestoreOutcome::NoSnapshot) => println!("用户原剪贴板为空：无需恢复"),
        (Some(p), RestoreOutcome::Restored) => {
            assert_eq!(
                eventual_match("恢复用户内容", p),
                ClipboardMatch::Same,
                "恢复后真实剪贴板必须与用户原内容一致\n{}",
                mismatch_report("恢复用户内容", p, platform::current_sequence()),
            );
            println!("用户原剪贴板已恢复：{}", describe(p));
        }
        (Some(p), RestoreOutcome::KeepUserCopy) => {
            println!(
                "未执行覆盖：验收期间剪贴板被更晚的复制接管（原内容 {} 已过时），按设计绝不覆盖用户后来的内容",
                describe(p)
            );
        }
        (Some(p), other) => {
            panic!(
                "真机验收结束时必须恢复用户内容，实际 {other:?}（原内容 {}）",
                describe(p)
            );
        }
        (None, other) => panic!("无快照却执行了恢复：{other:?}"),
    }

    let stats = store::stats(&db, &settings).expect("统计必须可读");
    assert_eq!(stats.items, 4, "4 次首采 + 4 次自写复核，条目必须仍是 4 条");
    assert!(Path::new(&root).exists(), "图片资产目录必须存在（落盘）");
    assert!(
        watermark.load(Ordering::SeqCst) > 0,
        "必须登记过本进程自写序列号"
    );
    println!(
        "真机验收完成：{} 条历史 / 顺序与像素全部一致 / 自写去重生效 / 用户内容已恢复",
        stats.items
    );
}

/// 只读校验真机目标窗口层：不发送任何按键，绝不把内容送进别人的窗口。
#[test]
#[ignore = "真机验收工具：只读枚举本机可见窗口并做目标预检，不注入按键"]
fn real_visible_targets_exclude_self_and_pass_precheck() {
    if std::env::var("TD_REAL_CLIPBOARD")
        .map(|v| v != "1")
        .unwrap_or(true)
    {
        eprintln!("跳过：未设置 TD_REAL_CLIPBOARD=1");
        return;
    }
    if !cfg!(windows) {
        eprintln!("跳过：非 Windows 走 stub 实现");
        return;
    }
    let own = std::process::id();
    let targets = platform::visible_targets();
    assert!(
        !targets.iter().any(|t| t.pid == own),
        "可见粘贴目标绝不能包含本进程，否则按键会打进自己的输入框"
    );
    let mut checked = 0usize;
    let mut elevated_refused = 0usize;
    for t in &targets {
        assert!(!t.exe_path.trim().is_empty(), "目标必须带可执行路径");
        assert!(t.pid > 0 && t.hwnd != 0, "目标必须带有效进程/窗口身份");
        // 枚举与预检之间窗口可能已关闭：先确认窗口身份仍然存在再判定。
        if platform::window_target(t.hwnd).is_none() {
            continue;
        }
        match paste::precheck_target(t.hwnd) {
            Ok(target) => {
                assert_eq!(target.pid, t.pid, "预检必须回到同一个进程身份");
                assert_eq!(target.hwnd, t.hwnd, "预检必须回到同一个窗口句柄");
                checked += 1;
            }
            Err(e) => {
                let msg = e.to_string();
                assert!(msg.contains("管理员权限"), "可见目标预检意外失败：{msg}");
                assert!(
                    platform::target_is_elevated(t.pid) && !platform::current_is_elevated(),
                    "以管理员权限为由拒绝时，权限判定必须与拒绝理由一致"
                );
                elevated_refused += 1;
            }
        }
    }
    println!(
        "真机目标层只读校验通过：可见目标 {} 个（本进程已排除）/ 预检通过 {} 个 / 提权拒绝 {} 个",
        targets.len(),
        checked,
        elevated_refused
    );
    assert!(
        !targets.is_empty(),
        "真机上必须能枚举到至少一个可见窗口，否则目标选择功能不可用"
    );
}

/// 真机验证「写入中途失败绝不丢用户剪贴板」：`EmptyClipboard` 已执行、
/// 随后写入失败时，必须把写入前的内容原样放回，而不是留下空剪贴板。
#[test]
#[ignore = "真机验收工具：会写入本机剪贴板（失败恢复路径），需 TD_REAL_CLIPBOARD=1"]
fn real_failed_write_restores_previous_content() {
    if std::env::var("TD_REAL_CLIPBOARD")
        .map(|v| v != "1")
        .unwrap_or(true)
    {
        eprintln!("跳过：未设置 TD_REAL_CLIPBOARD=1");
        return;
    }
    if !cfg!(windows) {
        eprintln!("跳过：非 Windows 走 stub 实现");
        return;
    }
    let _serial = lock_real_clipboard();
    let Some(snapshot) = restorable_snapshot() else {
        return;
    };
    let Some(previous) = snapshot.payload.clone() else {
        eprintln!("跳过：本机剪贴板为空，无法验证失败恢复（没有需要放回的内容）");
        return;
    };
    println!("开始写入失败恢复验证；用户剪贴板={}", describe(&previous));
    // 快照可恢复；若「无效文件载荷」意外写入成功并触发断言 panic，由守卫恢复用户内容。
    let watermark = AtomicU32::new(0);
    let mut restore_guard =
        ClipboardRestoreGuard::new(snapshot, Box::new(PlatformRestorer { self_write: &watermark }));

    // 全部路径都无效的文件载荷：守卫放行后 EmptyClipboard 已执行，
    // write_formats 必然失败——这正是「清空成功、写入失败」的真实窗口。
    let broken = ClipboardPayload::Files {
        paths: vec![r"Z:\taskdock-not-here\missing.bin".into()],
    };
    let outcome = platform::write_guarded(&broken, WriteGuard::Content(&previous));
    let err = match outcome {
        Err(err) => err,
        // 快照之后用户真的复制了新内容：守卫拒绝，本身就是「不覆盖」的正确行为。
        Ok(WriteOutcome::SequenceChanged) => {
            println!(
                "提前结束：守卫拒绝了写入（剪贴板在快照后已被更晚的复制接管），无需再验证失败恢复"
            );
            return;
        }
        Ok(WriteOutcome::Written { .. }) => {
            // 意外写入成功：先登记，保证随后 panic 时 Drop 能按内容归属恢复。
            restore_guard.note_written(&broken);
            panic!("无效文件载荷绝不能报告写入成功");
        }
    };
    let msg = err.to_string();
    assert!(
        msg.contains("写入剪贴板失败"),
        "失败原因必须是写入剪贴板失败，实际：{msg}"
    );
    assert_eq!(
        eventual_match("失败恢复", &previous),
        ClipboardMatch::Same,
        "写入失败后必须把写入前的内容放回：清空成功而写入失败绝不能吃掉用户剪贴板\n{}",
        mismatch_report("失败恢复", &previous, platform::current_sequence()),
    );
    println!("写入失败恢复验证通过：用户内容仍在剪贴板中");
}

// ─────────────────────────────────────────────────────────────────────────
// 恢复守卫语义（模拟剪贴板状态 + 可控失败注入；**不触碰真实剪贴板**）
//
// 真机 panic 无法在不污染用户剪贴板的前提下复现，因此这里用 FakeRestorer
// 模拟平台层的「内容比较 → 写回 / KeepUserCopy」语义，验证守卫在正常结束、
// 栈展开、用户接管、恢复失败与恢复过程自身 panic 时的行为。
// ─────────────────────────────────────────────────────────────────────────

fn fake_text(text: &str) -> ClipboardPayload {
    ClipboardPayload::Text {
        text: text.into(),
        html: None,
    }
}

struct FakeClipboard {
    current: RefCell<Option<ClipboardPayload>>,
    restore_calls: Cell<u32>,
    fail_next: Cell<u32>,
    panic_on_restore: Cell<bool>,
    last_outcome: Cell<Option<RestoreOutcome>>,
}

impl FakeClipboard {
    fn new(current: Option<ClipboardPayload>) -> Self {
        Self {
            current: RefCell::new(current),
            restore_calls: Cell::new(0),
            fail_next: Cell::new(0),
            panic_on_restore: Cell::new(false),
            last_outcome: Cell::new(None),
        }
    }
}

struct FakeRestorer {
    clip: Rc<FakeClipboard>,
}

impl RestoreBackend for FakeRestorer {
    fn restore(
        &self,
        snapshot: &Snapshot,
        last_written: &ClipboardPayload,
    ) -> AppResult<RestoreOutcome> {
        self.clip.restore_calls.set(self.clip.restore_calls.get() + 1);
        if self.clip.panic_on_restore.get() {
            panic!("模拟恢复过程 panic（必须由 Drop 吞掉）");
        }
        if self.clip.fail_next.get() > 0 {
            self.clip.fail_next.set(self.clip.fail_next.get() - 1);
            return Err(AppError::Validation("模拟恢复失败".into()));
        }
        let Some(target) = snapshot.payload.as_ref() else {
            self.clip.last_outcome.set(Some(RestoreOutcome::NoSnapshot));
            return Ok(RestoreOutcome::NoSnapshot);
        };
        let current = self.clip.current.borrow();
        if current.as_ref() != Some(last_written) {
            self.clip
                .last_outcome
                .set(Some(RestoreOutcome::KeepUserCopy));
            return Ok(RestoreOutcome::KeepUserCopy);
        }
        drop(current);
        *self.clip.current.borrow_mut() = Some(target.clone());
        self.clip.last_outcome.set(Some(RestoreOutcome::Restored));
        Ok(RestoreOutcome::Restored)
    }
}

fn guard_for(
    original: Option<ClipboardPayload>,
    clip: &Rc<FakeClipboard>,
) -> ClipboardRestoreGuard<'static> {
    ClipboardRestoreGuard::new(
        Snapshot {
            sequence: 0,
            payload: original,
        },
        Box::new(FakeRestorer { clip: clip.clone() }),
    )
}

#[test]
fn restore_guard_restores_original_once_after_normal_finish() {
    let original = fake_text("原内容");
    let written = fake_text("测试写入");
    let clip = Rc::new(FakeClipboard::new(Some(original.clone())));
    let mut guard = guard_for(Some(original.clone()), &clip);
    guard.note_written(&written);
    // 模拟平台层写入成功：真实剪贴板此时已是测试内容。
    *clip.current.borrow_mut() = Some(written.clone());

    let outcome = guard.finish("模拟正常结束").expect("模拟恢复不得报错");
    assert_eq!(outcome, RestoreOutcome::Restored);
    assert_eq!(clip.restore_calls.get(), 1, "正常结束必须只恢复一次");
    assert_eq!(*clip.current.borrow(), Some(original), "必须写回原内容");

    drop(guard);
    assert_eq!(
        clip.restore_calls.get(),
        1,
        "同一快照不得在 Drop 中重复恢复"
    );
}

#[test]
fn restore_guard_restores_during_panic_unwind() {
    let original = fake_text("原内容");
    let clip = Rc::new(FakeClipboard::new(Some(original.clone())));

    let written = fake_text("测试写入");
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut guard = guard_for(Some(original.clone()), &clip);
        guard.note_written(&written);
        // 模拟平台层写入成功后再触发断言 panic。
        *clip.current.borrow_mut() = Some(written.clone());
        panic!("模拟断言失败，触发栈展开");
    }));

    assert!(result.is_err(), "闭包必须真的 panic");
    assert_eq!(clip.restore_calls.get(), 1, "Drop 必须尝试恢复一次");
    assert_eq!(
        clip.last_outcome.get(),
        Some(RestoreOutcome::Restored),
        "栈展开路径必须尽力恢复原内容"
    );
    assert_eq!(
        *clip.current.borrow(),
        Some(original),
        "panic 后剪贴板必须回到原内容"
    );
}

#[test]
fn restore_guard_keeps_user_takeover_copy() {
    let original = fake_text("原内容");
    let takeover = fake_text("用户接管的新内容");
    let clip = Rc::new(FakeClipboard::new(Some(original.clone())));
    let mut guard = guard_for(Some(original.clone()), &clip);
    guard.note_written(&fake_text("测试写入"));

    // 模拟用户/其他程序在测试期间改写剪贴板：不属于本进程最后一次写入。
    *clip.current.borrow_mut() = Some(takeover.clone());
    drop(guard);

    assert_eq!(clip.restore_calls.get(), 1);
    assert_eq!(
        clip.last_outcome.get(),
        Some(RestoreOutcome::KeepUserCopy),
        "内容归属不匹配时必须保留用户新内容"
    );
    assert_eq!(
        *clip.current.borrow(),
        Some(takeover),
        "用户接管的内容绝不被恢复覆盖"
    );
}

#[test]
fn restore_guard_reports_failure_without_panicking() {
    let original = fake_text("原内容");
    let written = fake_text("测试写入");
    let clip = Rc::new(FakeClipboard::new(Some(original.clone())));
    clip.fail_next.set(1);
    let mut guard = guard_for(Some(original), &clip);
    guard.note_written(&written);
    *clip.current.borrow_mut() = Some(written.clone());

    drop(guard);

    assert_eq!(clip.restore_calls.get(), 1);
    assert_eq!(clip.last_outcome.get(), None, "失败结果不得伪报成功");
    assert_eq!(
        *clip.current.borrow(),
        Some(written),
        "恢复失败时如实保留当前内容，不假装已还原"
    );
}

#[test]
fn restore_guard_swallows_backend_panic_in_drop() {
    let original = fake_text("原内容");
    let written = fake_text("测试写入");
    let clip = Rc::new(FakeClipboard::new(Some(original)));
    clip.panic_on_restore.set(true);
    let mut guard = guard_for(Some(fake_text("原内容")), &clip);
    guard.note_written(&written);
    *clip.current.borrow_mut() = Some(written.clone());

    // Drop 内 catch_unwind 必须吞掉后端 panic；测试线程不能再次 panic。
    drop(guard);

    assert_eq!(clip.restore_calls.get(), 1);
    assert_eq!(*clip.current.borrow(), Some(written));
}

#[test]
fn restore_guard_handles_empty_snapshot_without_panic() {
    let written = fake_text("测试写入");
    let clip = Rc::new(FakeClipboard::new(Some(written.clone())));
    let mut guard = guard_for(None, &clip);
    guard.note_written(&written);

    drop(guard);

    assert_eq!(clip.restore_calls.get(), 1);
    assert_eq!(
        clip.last_outcome.get(),
        Some(RestoreOutcome::NoSnapshot),
        "原剪贴板为空时平台返回 NoSnapshot"
    );
    // 平台层没有「恢复为空」的写回能力；真实写入型测试在快照为空时直接拒绝启动，
    // 这里只验证守卫不 panic、不伪报恢复成功。
    assert_eq!(*clip.current.borrow(), Some(written));
}

