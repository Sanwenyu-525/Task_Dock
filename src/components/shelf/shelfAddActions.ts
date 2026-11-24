//! 暂存架「添加方式」动作清单的唯一来源（2026-11-24）。
//!
//! 工具栏「添加 ⋯」下拉与列表空白处右键菜单共用这一份顺序、文案与模式语义，
//! 避免两个入口各自维护「添加文件/文件夹/链接/文本/剪贴板/截图」而逐渐走样。
//! 视觉（图标、勾选位、下拉/右键的分组样式）仍由调用方决定：
//! 本文件只描述「有哪些动作、属于哪一组、当前选中的添加方式是哪一个」。

/** 调用方提供的动作实现与当前状态。 */
export interface ShelfAddActionContext {
  /** true = 保存副本到托管目录；false = 引用原文件。 */
  copyOnAdd: boolean;
  onPickFiles: () => void;
  onPickFolder: () => void;
  /** 打开「添加链接」输入行（不是 toggle：再次触发不应关掉已打开的输入）。 */
  onAddLink: () => void;
  /** 打开「添加文本」输入行。 */
  onAddText: () => void;
  /** 打开剪贴板历史选择面板。 */
  onAddFromClipboard: () => void;
  /** 只暂存剪贴板图片（截图）。 */
  onPasteScreenshot: () => void;
  onCopyOnAddChange: (value: boolean) => void;
}

/** 单个动作/分组标题。 */
export interface ShelfAddAction {
  key: string;
  label: string;
  /** 只在带说明的菜单（工具栏下拉）展示，右键菜单保持紧凑。 */
  description?: string;
  /** 分组标题：不可执行，只表示下面的单选项属于「添加方式」。 */
  heading?: true;
  /** 添加方式单选：reference = 引用原文件，managed = 保存副本。 */
  mode?: "reference" | "managed";
  /** 单选当前是否生效。 */
  checked?: boolean;
  onSelect?: () => void;
}

/** 与工具栏下拉完全一致的顺序：先添加入口，再添加方式（模式单选）。 */
export function shelfAddActions(ctx: ShelfAddActionContext): ShelfAddAction[] {
  return [
    { key: "file", label: "添加文件…", onSelect: ctx.onPickFiles },
    { key: "folder", label: "添加文件夹…", onSelect: ctx.onPickFolder },
    { key: "link", label: "添加网页链接…", onSelect: ctx.onAddLink },
    { key: "text", label: "添加文本片段…", onSelect: ctx.onAddText },
    { key: "clip", label: "从剪贴板添加…", onSelect: ctx.onAddFromClipboard },
    {
      key: "screenshot",
      label: "暂存剪贴板截图",
      description: "只保存图片字节；系统截图完成后直接可用",
      onSelect: ctx.onPasteScreenshot,
    },
    {
      key: "mode-heading",
      label: "添加方式",
      description: "拖入与剪贴板添加同样遵循",
      heading: true,
    },
    {
      key: "reference",
      label: "引用原文件（不复制）",
      mode: "reference",
      checked: !ctx.copyOnAdd,
      onSelect: () => ctx.onCopyOnAddChange(false),
    },
    {
      key: "managed",
      label: "保存副本到托管目录",
      mode: "managed",
      checked: ctx.copyOnAdd,
      onSelect: () => ctx.onCopyOnAddChange(true),
    },
  ];
}
