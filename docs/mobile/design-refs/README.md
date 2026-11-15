# 移动端设计参考图

用户选定的视觉参照，用于 `docs/mobile/03-ui-spec.md` 的高保真对照。**不要用 `tmp/` 存放**：`tmp` 会被定期清理（2026-11-15 已发生过一次，本目录即为此重建）。

## 文件清单

| 文件 | 尺寸 | 内容 | sha256 |
|---|---|---|---|
| `reference-blue-cyan-v5.png` | 1122×1402 | 概念排版稿：首页/工作台、任务、工作区/项目空间三块主画面 + 工具箱小图 + 设计亮点 | `E123E2B9…3F7B50D9` |
| `reference-blue-cyan-screen-home.png` | 1024×1536 | 首页：今日概览（3 进行中 / 12 待处理 / 68%）、当前进度、快捷进入 6 格、待处理任务 + 最近动态、文件暂存架 | `3D4D6482…40E53D` |
| `reference-blue-cyan-screen-tasks.png` | 1024×1536 | 任务：当前开发任务（70%）、Agent 运行状态、待处理事项 3、任务进度/验收状态/待验收、最近工作现场 + 任务交接、快捷入口 | `47B3C332…089ACF` |
| `reference-blue-cyan-screen-tools.png` | 1024×1536 | 工具：常用工具 5、已收藏 6、应用导航 5、快捷操作 5、诊断中心、更多功能（开发中） | `80B5381E…677EFC` |
| `reference-blue-cyan-screen-profile.png` | 1024×1536 | 我的：工作概览、最近访问项目、通知中心、数据同步、快捷设置、帮助/关于 v1.6.0 | `8AB938A5…E55EECC0` |
| `reference-blue-cyan-board-screens-01.png` | 1536×1024 | 12 屏总览：启动页、首页、任务、工作区、项目详情、功能看板、场景工作区、开发工作台、文件暂存架、工具箱、诊断中心、我的 | `28AC6C3E…8D5FCBDD` |
| `reference-blue-cyan-board-screens-02.png` | 1536×1024 | 12 屏总览：首页、任务、项目详情、功能看板、文件暂存架、工具页、场景工作区、开发工作台、诊断中心、拍照与上传、我的、设置 | `C13757D9…681F0984` |

表中哈希为省略形式，仅便于人工比对；完整校验值见下方「校验（sha256）」，以完整值为准。

## 校验（sha256）

```text
reference-blue-cyan-v5.png            E123E2B9702B753E92920599B7EE3E0B9F2E31D5D8E0613C4B3BE9313F7B50D9
reference-blue-cyan-screen-home.png   3D4D6482A5C9BF391BAA21CFB5039A09A98F287E6174514BB2E45213F840E53D
reference-blue-cyan-screen-tasks.png  47B3C332DF251FDDF4F877238EB06C774D5A1FFC84E5928BE6C21A2CC0089ACF
reference-blue-cyan-screen-tools.png  80B5381E01C4E704D18501629AA9E094ABF154B81EBF2D4F3EC9F6E69D677EFC
reference-blue-cyan-screen-profile.png 8AB938A555DD18DE51023C8E0374266DA1E7BDB3CEB40019E5F6BE6EE55EECC0
reference-blue-cyan-board-screens-01.png 28AC6C3E8EAFFD8061B036BBFFEB61B99000FC9D315F0DA2C29E2E2E8D5FCBDD
reference-blue-cyan-board-screens-02.png C13757D9ACA73D6DDC73BE3A3354F8307C4FF4507566BDE9CBB06C36681F0984
```

## 来源与性质

- 来源：用户在 ChatGPT 生成并在本会话提供的概念稿。`v5` 是最早一版排版稿（1122×1402），其余 6 张是后续的单屏细化与多屏总览；**版本号未标注**，因此文件名不写版本递增，按「单屏 / 总览」区分。
- 这些是**概念稿，不是真机截图**：画布比例、状态栏、机型边框均为示意，对照时以构图、层级、配色为准，不逐像素比对。
- 概念稿包含当前未实现的模块，不得据此判定功能已存在：Agent 运行状态、诊断中心、功能看板、场景工作区、开发工作台、AI 助手 / 自动化脚本 / 云同步 / 团队协作（标注「开发中」）、桌面联动（标注「占位」）。
- 配色基线：`#1677FF`（accent）/ `#35B8F5`（accent 渐变），浅深两套见 `apps/mobile/src/theme/`。

## 维护

- 新增图按 `<主题>-<页面/版式>.png` 命名，同步更新上表；避免覆盖同名文件。
- 与代码冲突时以「已实现页面 + 用户最新确认稿」为准；概念稿里超出现有能力的部分只作方向参考。
