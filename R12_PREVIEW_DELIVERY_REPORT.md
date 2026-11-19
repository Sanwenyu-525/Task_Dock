# TaskDock R12 交付报告：文件工作区交互收尾与第一阶段文件内容预览

- 日期：2026-11-19
- 范围：R11 交互验收收尾（右键菜单关闭）+ 刷新目录前端反馈 + 第一阶段文件内容预览（FW-PREVIEW-001）
- 功能台账：[docs/features/files-workspace.md](docs/features/files-workspace.md)
- 架构：[docs/architecture/files-workspace.md](docs/architecture/files-workspace.md) §14
- 验收矩阵：[docs/acceptance/files-workspace.md](docs/acceptance/files-workspace.md) §13
- 测试记录：[docs/testing/files-workspace.md](docs/testing/files-workspace.md) §13

---

## 1. 本轮修改摘要

1. **右键菜单生命周期收尾**：`FreeMenu` 按坐标 `x:y` 重建实例，连续右键不同位置只保留一个菜单；
   外部点击 / 窗口失焦 / Escape / 菜单项执行后关闭、重新打开、卸载清理全部固化测试。
2. **刷新目录统一入口与反馈**：新增 `dirCache.refreshDir(path, showHidden, force?)`（并发合并、乱序裁决、
   失败保留旧列表）；工具栏刷新按钮出现旋转 + `aria-busy`，状态条显示「正在刷新… / 已更新」，
   失败给出行内错误条与重试；工具栏、右键菜单、分页停滞重试、目录错误重试共用同一入口。
3. **第一阶段文件内容预览**：新建 `src/components/files/preview/` 模块（类型判定 / 媒体与 Blob 资源跟踪 /
   图片 / 文本代码 / PDF / 视频 / 音频 / 统一状态占位），重写 `QuickPreviewDialog` 为唯一容器，
   新增 `fs_read_binary` IPC（Rust）与 `pdfjs-dist` 本地打包的 PDF 渲染链路。
4. **PDF 资源本地化**：`scripts/pdfjs-assets.mjs` 把 pdfjs 的 CMap / 标准字体 / WASM 同步到 `public/pdfjs/`
   （`vite.config.ts` 配置求值时调用），worker 走 `?url` 本地资源，**无 CDN、无上传**。

## 2. 修改文件清单

**新增**

| 文件 | 说明 |
|---|---|
| `src/components/files/preview/previewKind.ts` | 预览类型判定唯一入口（纯函数） |
| `src/components/files/preview/mediaToken.ts` | 媒体 token / Blob URL 跟踪器、base64 解码 |
| `src/components/files/preview/useMediaPreviewUrl.ts` | 音视频 URL 获取与释放（video/audio 共用） |
| `src/components/files/preview/FileImagePreview.tsx` | 图片预览（原始字节 / Shell 回退 / 缩放 / 适应 / 1:1） |
| `src/components/files/preview/FileTextPreview.tsx` | 文本与代码预览（编码 / 行号 / 高亮 / 复制 / 截断提示） |
| `src/components/files/preview/FilePdfPreview.tsx` | PDF 预览（pdf.js 单页渲染 / 翻页 / 适应宽度 / 适应页面 / 缩放） |
| `src/components/files/preview/FileVideoPreview.tsx` | 视频预览（原生控制条 + 错误态） |
| `src/components/files/preview/FileAudioPreview.tsx` | 音频预览（自定义控制条） |
| `src/components/files/preview/PreviewState.tsx` | 统一加载 / 错误 / 不支持占位 |
| `src/components/files/preview/previewKind.test.ts` | 格式矩阵单测（63 用例） |
| `src/components/files/QuickPreviewDialog.preview.test.tsx` | 预览矩阵 / 竞态 / 释放单测（26 用例） |
| `src/components/files/FilePane.refresh.test.tsx` | 刷新反馈单测（4 用例） |
| `src/components/files/FilePane.contextMenuClose.test.tsx` | 右键菜单生命周期单测（8 用例） |
| `src/lib/filesWorkspace/dirCache.refresh.test.ts` | 刷新入口单测（6 用例） |
| `scripts/pdfjs-assets.mjs` | pdfjs 静态资源同步脚本 |

**修改**

| 文件 | 说明 |
|---|---|
| `src/components/files/QuickPreviewDialog.tsx` | 重写为容器：头部元信息、底部导航、键盘守卫、代际控制 |
| `src/components/files/FilePane.tsx` | `refreshActiveDir` 统一刷新入口 + 旋转/状态条/错误条；`FreeMenu` 按坐标重建 |
| `src/components/files/files.css` | 预览样式重写（舞台、HUD、信息芯片、PDF 工具条、音频控制条、自定义滑杆） |
| `src/lib/filesWorkspace/dirCache.ts` | 新增 `refreshDir`；`invalidateDirs` 改走强制刷新 |
| `src/lib/bridge.ts` | 新增 `fsReadBinary` |
| `src/lib/contracts/models.ts` | 新增 `FsBinaryPreview`；`FsTextPreview` 增 `encoding` |
| `src/locales/zh-CN/index.ts`、`src/locales/en-US/index.ts` | 新增 30+ 预览/刷新文案键 |
| `src-tauri/src/commands/file_workspace.rs` | 新增 `fs_read_binary` 命令 |
| `src-tauri/src/file_workspace/mod.rs` | `FsBinaryPreview`、文本编码识别（UTF-8/BOM/UTF-16/lossy）、字符边界截断 |
| `src-tauri/src/file_workspace/preview.rs` | `mime_for_path` 扩展为图片/PDF MIME 并对媒体协议共用 |
| `src-tauri/src/lib.rs` | 注册 `fs_read_binary` |
| `vite.config.ts` | 配置求值时同步 pdfjs 静态资源 |
| `.gitignore` | 忽略自动生成的 `public/pdfjs/` |
| `scripts/make-preview.mjs` | 走查夹具：预览目录（SVG/PDF/TS/MD/LOG/WAV/DOCX）+ `fs_read_binary`/`fs_read_text`/`fs_preview_media_url` 桩 + `PREVIEW_DIST` 开关 |
| `scripts/serve-preview.mjs` | 增加 `.wav` / `.mp4` MIME |
| `docs/features/files-workspace.md`、`docs/architecture/files-workspace.md`、`docs/acceptance/files-workspace.md`、`docs/testing/files-workspace.md` | 功能登记 / 架构 / 验收 / 测试记录同步 |

## 3. 新增或修改的方法清单

**Rust**：`read_binary_preview`（新）、`decode_text_preview`（新）、`read_text_preview`（改：编码 + 字符边界截断）、
`mime_for_path`（由 `mime_for` 改名并扩展）、`fs_read_binary`（新命令）。

**TypeScript（`src/lib/filesWorkspace/dirCache.ts`）**：`refreshDir(path, showHidden, force = false): Promise<boolean>`（新）、
`invalidateDirs`（改：走 `refreshDir(force=true)`）。

**TypeScript（`src/components/files/preview/`）**：`getPreviewKind`、`isPreviewSupported`、`getPreviewSizeLimit`、
`previewLanguage`、`previewTypeLabel`、`isCodeLike`、`extOf`（新纯函数）；`createPreviewTokenTracker`、
`releaseMediaToken`、`createObjectUrlTracker`、`base64ToBytes`（资源生命周期）；`useMediaPreviewUrl`（新 Hook）。

**React 组件**：`QuickPreviewDialog`（重写）、`FileImagePreview`、`FileTextPreview`、`FilePdfPreview`、
`FileVideoPreview`、`FileAudioPreview`、`PreviewLoading/PreviewError/PreviewUnsupported`（新增）。

**FilePane**：`refreshActiveDir`（新，统一刷新入口）、刷新状态 `refreshing` / `refreshNote`（新）、
`FreeMenu` 按坐标 `key`（改）。

## 4. 预览格式支持矩阵（第一阶段实际实现）

| kind | 扩展名 | 数据来源 | 渲染 | 失败回退 |
|---|---|---|---|---|
| image | png jpg jpeg webp gif bmp svg avif ico tif tiff | `fs_read_binary`（≤32 MiB；SVG ≤8 MiB；>24 MiB 直接走 Shell） | `<img>` + 适应/缩放/1:1/双击 | Blob 解码失败 → `fs_preview_image`（Shell 解码 PNG）→ 错误态 + 外部打开 |
| text | txt md json csv log yaml yml toml xml html css js mjs cjs ts jsx tsx py rs sql ini cfg conf sh bat cmd ps1 c/h/cpp/hpp java go env gitignore | `fs_read_text`（前 512 KiB，后端拒绝二进制） | 等宽 + 行号 + 轻量高亮 + 复制 | 截断/乱码提示；失败显示文件名与错误 |
| pdf | pdf | `fs_read_binary`（≤64 MiB） | pdf.js 本地单页 canvas：翻页/适应宽度/适应页面/缩放 | 超限/损坏/加密 → 错误态 + 外部打开 |
| video | mp4 webm mov m4v mkv avi | `fs_preview_media_url`（token + Range） | `<video controls>` | 编码不支持 → 错误态 |
| audio | mp3 wav flac m4a aac ogg oga | `fs_preview_media_url` | 自定义控制条（播放/进度/时长/音量/静音） | 同上 |
| unsupported | docx xlsx pptx doc xls ppt zip 7z exe dll 等 | 不读取内容 | 「暂不支持内嵌预览」+ 外部打开 | 绝不把二进制丢给 `fs_read_text` |

## 5. 刷新交互改进说明

- 唯一入口：`refreshDir(path, showHidden, force?)`；同键并发合并为同一 Promise，连续点击不产生额外 IPC；
  `reqSeq` 裁决乱序（旧响应不得覆盖新目录）；失败**保留上一次成功列表**。
- UI：工具栏刷新按钮 `aria-busy` + 图标旋转；状态条「正在刷新… / 已更新」（约 2.2 s 自动消退）；
  失败时内容区上方出现行内错误条（含重试按钮），列表照旧保留，不整块报错、不变空目录。
- 作用域：只刷新本窗格当前目录；切换目录/关闭标签/卸载时作废在途回调；不同窗格状态互不影响。

## 6. 右键关闭验收结果

| 场景 | 结论 | 证据 |
|---|---|---|
| 外部点击关闭 | PASS | B 通道 `MENU_AFTER_OUTSIDE 0`；自动化用例 |
| 窗口失焦关闭 | PASS | 自动化用例 |
| Escape 关闭 | PASS | B 通道 `MENU_AFTER_ESCAPE 0`；自动化用例 |
| 菜单项执行后关闭 | PASS | 自动化用例（并触发新建文件夹对话框） |
| 关闭后重新打开 | PASS | B 通道 `MENU_REOPEN 1`；自动化用例 |
| 连续右键唯一实例 | PASS | 自动化用例（实现为按坐标重建实例） |
| 卸载无残留 | PASS | 自动化用例 |
| 菜单内部 pointerdown 不误关 | PASS | 自动化用例 |

## 7. 自动化测试结果

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx tsc --noEmit` | 0 | 通过 |
| `npx vitest run src/components/files src/lib/filesWorkspace --maxWorkers=1` | 0 | **49 文件 / 520 用例通过** |
| `npx vitest run src/components/files/QuickPreviewDialog.preview.test.tsx` | 0 | 26/26 |
| `npx vitest run src/components/files/FilePane.contextMenuClose.test.tsx` | 0 | 8/8 |
| `npx vitest run src/components/files/FilePane.refresh.test.tsx` | 0 | 4/4 |
| `npx vitest run src/lib/filesWorkspace/dirCache.refresh.test.ts` | 0 | 6/6 |
| `npx vitest run src/components/files/preview/previewKind.test.ts` | 0 | 63/63 |
| `npx vite build --outDir dist-r12 --emptyOutDir=false` | 0 | 通过（pdf.js 独立 chunk + worker + `/pdfjs` 资源） |

> `--maxWorkers=1` 是本机内存约束（并行跑 jsdom 套件会被 OOM 杀掉），不是用例要求。

## 8. TypeScript / Rust 测试结果

- TypeScript：**PASS**（`npx tsc --noEmit` exit 0）。
- Rust：**BLOCKED** —— `cargo test --manifest-path src-tauri/Cargo.toml file_workspace::` 在本环境两次失败：
  1. 首次编译依赖时 rustc 崩溃（`image` / `windows` crate，`STATUS_STACK_BUFFER_OVERRUN`）；
  2. 重试时 `src-tauri/target/debug/.cargo-lock` 拒绝访问（共享 target 目录被其他在途构建占用）。
  本轮 Rust 侧改动（`fs_read_binary`、编码识别、字符边界截断）**已写入并附单测，但未在本环境执行成功**，
  不得据此宣称 Rust 通过。

## 9. 实际截图（B 通道，真实 Chromium + 真实 pdf.js 渲染）

| 截图 | 内容 |
|---|---|
| `tmp/acceptance/files-workspace/round12/shots/preview-image-svg.png` | 图片预览（SVG → Blob URL，居中 + 缩放 HUD） |
| `tmp/acceptance/files-workspace/round12/shots/preview-code-ts.png` | 代码预览（信息芯片 + 行号 + 高亮 + 复制按钮） |
| `tmp/acceptance/files-workspace/round12/shots/preview-text-md.png` | Markdown 文本预览 |
| `tmp/acceptance/files-workspace/round12/shots/preview-text-truncated.png` | 大文本截断提示 |
| `tmp/acceptance/files-workspace/round12/shots/preview-pdf.png` | PDF 第 1 页真实渲染 + 页码/适应/缩放工具条 |
| `tmp/acceptance/files-workspace/round12/shots/preview-pdf-page2.png` | PDF 翻页到第 2 页（计数「第 2 / 3 页」） |
| `tmp/acceptance/files-workspace/round12/shots/preview-audio.png` | 音频自定义控制条（播放/进度/时长/音量） |
| `tmp/acceptance/files-workspace/round12/shots/preview-unsupported.png` | DOCX「暂不支持内嵌预览」+ 外部打开入口 |
| `tmp/acceptance/files-workspace/round12/shots/pane-refreshing.png` | 刷新中（图标旋转 + 状态条「正在刷新…」，旧列表保留） |
| `tmp/acceptance/files-workspace/round12/shots/pane-refreshed.png` | 刷新完成（状态条「已更新」） |
| `tmp/acceptance/files-workspace/round12/shots/pane-context-menu.png` | 右键菜单打开 |
| `tmp/acceptance/files-workspace/round12/shots/pane-context-closed.png` | 外部点击后菜单关闭 |
| `tmp/acceptance/files-workspace/round12/shots/pane-context-escape.png` | Escape 后菜单关闭 |

> 走查环境限制：headless Chromium 缺中文字体，截图中汉字呈窄形占位；**布局、几何、交互结论有效，字形需在原生 WebView2 复核**。

## 10-12. snapshotId / buildId / commit

| 项 | 值 |
|---|---|
| snapshotId | **未生成**（正式构建受阻，见 §13） |
| buildId | **未生成** |
| commit | **未提交**：本轮未执行 Git 写操作（共享工作树中同时存在其他任务的在途改动，按 AGENTS.md §3.2 由主 Agent 统一协调提交） |
| 前端构建产物 | `dist-r12/`（`npx vite build --outDir dist-r12`，exit 0），用于验证 pdfjs 分包与静态资源 |

## 13. 尚未完成的功能

- Office（DOCX/XLSX/PPTX）内嵌渲染：第一阶段明确标记不支持 + 外部打开入口（未做本地解析器）。
- Markdown 富文本渲染（当前按纯文本 + 语法高亮）。
- PDF 文本选择/搜索、连续预加载、目录大纲。
- 视频首阶段只保留原生控制条，未做缩略图进度条与轨道预览。
- 正式构建包（安装包）上的原生走查（C 通道）与中文字形复核。
- Rust 侧 `cargo test file_workspace::` 在本环境的执行。

## 14. 遗留风险

1. **Rust 验证缺口**：新增 `fs_read_binary` 与编码识别的 Rust 单测未在本环境跑通；若集成时发现编译或逻辑问题，
   需在有稳定 Rust 工具链的机器上重跑 `cargo test file_workspace::`。
2. **PDF 内存占用**：base64 中转使 64 MiB PDF 的瞬时内存峰值约 170 MiB；建议后续改为分块或 ArrayBuffer 传输。
3. **PDF 静态资源 3.6 MiB** 进入安装包（`public/pdfjs/`），由依赖同步生成，不入库但会随包发布。
4. **中文 CMap 依赖**：`public/pdfjs/cmaps` 为 CJK 预定义 CMap 提供来源；若某个 PDF 只依赖外部 CMap 而未内嵌字体，
   仍可能无法显示对应字形（需在真实中文 PDF 上复核）。
5. **图片大文件路径**：>24 MiB 的图片走 Shell 解码（1400 px 上限），超大图看不到原始像素；1:1 视图仅对 ≤24 MiB 生效。
6. **共享工作树并发**：本轮观察到其他任务同时在途修改（`src/lib/crossTab/*`、`src/workbench/WorkbenchShell.tsx`），
   并发构建导致 `dist/` 与 `src-tauri/target` 出现竞争；交付提交与正式构建必须由主 Agent 统一调度。

## 15. 最终状态

| 范围 | 状态 |
|---|---|
| R11 右键菜单关闭收尾 | **PASS**（自动化 + B 通道真实事件） |
| R12 刷新目录反馈 | **PASS**（自动化 + B 通道真实事件） |
| FW-PREVIEW-001 第一阶段文件内容预览 | **PARTIAL**（图片/文本代码/PDF/音频已实现并真实渲染验证；视频未取得样本；原生验收与 Rust 验证未完成） |
| 本轮整体 | **PARTIAL** |
