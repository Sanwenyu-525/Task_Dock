# 手机端规范索引（TaskDock Mobile / Android）

本目录是 `apps/mobile` 的正式规范集，对应桌面端的 `docs/ARCHITECTURE.md` /
`docs/DEVELOPMENT.md` / `docs/TESTING.md` / `docs/ui-themes/` 分工。

**权威顺序**：代码与可复现输出 > 真机证据 > 本目录文档。文档与实现冲突时以代码为准，
并按本目录各篇末尾的「变更记录」追加带日期的更正，不覆盖历史结论。

## 文档地图

| 文档 | 内容 | 对应桌面端 |
|---|---|---|
| [01-architecture.md](01-architecture.md) | 分层、依赖方向、启动序列、提醒子系统、状态刷新 | `docs/ARCHITECTURE.md` |
| [02-data-model.md](02-data-model.md) | 表结构、迁移策略、三态补丁、`rev`/outbox、重复规则契约 | `docs/ARCHITECTURE.md` 数据章 |
| [03-ui-spec.md](03-ui-spec.md) | 设计 Token、表面硬规则、组件约束、字阶与交互 | `docs/ui-themes/01-design-spec.md` |
| [04-testing.md](04-testing.md) | 自动化、真机通道、用例矩阵、证据要求、已知阻塞 | `docs/TESTING.md`、`docs/ACCEPTANCE_ROUTING.md` |
| [05-build.md](05-build.md) | Windows 构建 Android 的工具链、版本管理、产物校验、故障表 | `docs/DEVELOPMENT.md` |
| [06-pairing.md](06-pairing.md) | 配对协议、二维码/深链、令牌存储、安全偏差与验收证据 | `docs/ARCHITECTURE.md` 手机配对章 |
| [07-sync.md](07-sync.md) | 任务 / 收集箱 / 笔记双向增量同步、载荷加密、冲突处理、真机验收 | `docs/ARCHITECTURE.md` 手机同步章 |
| [08-file-transfer.md](08-file-transfer.md) | 文件互传 v1：双向分块加密、SAF 接收目录、桌面文件列表与验收 | `docs/ARCHITECTURE.md` 手机文件互传章 |
| [prototypes/](prototypes/README.md) | Stitch 页面原型：v2 终版 11 屏 + 33 个导出变体（按页面归组，含画廊 `index.html`） | 设计稿/参考图 |
| [../MOBILE_STACK.md](../MOBILE_STACK.md) | 选型与共享边界**设计稿**（含未实现能力的规划，不是现状） | 选型报告 |
| [../../apps/mobile/AGENTS.md](../../apps/mobile/AGENTS.md) | 本目录的开发红线与提交前自检 | 根 `AGENTS.md` |

任务级验收报告在 `tmp/acceptance/mobile-app-skeleton/report.md`（`tmp/` 不入库）。

## 当前状态（2026-11-09）

### 已实现并在真机验证

- 配对与连接（2026-11-09 物理机）：应用内扫码配对、连接测试、强停重启后配对保持；
  桌面端设备列表/撤销。同步能力见 [07-sync.md](07-sync.md)。
- 任务同步（2026-11-09 物理机）：手动 pull/push、载荷加密、冲突页；真机接收 4 条、
  发送 21 条通过。
- 收集箱 / 笔记同步（2026-11-09 物理机）：笔记整篇双向、收集箱仅 `inbox`（handled 为
  墓碑）、真机 push/pull 与恢复通过；后台/自动同步仍未实现，详见 [07-sync.md](07-sync.md)。
- 文件互传（2026-11-09 物理机）：双向分块加密、SAF 接收目录、打开预览与删除清理；
  真机下载 640B 内容一致、上传 54B SHA-256 一致，详见 [08-file-transfer.md](08-file-transfer.md)。
- 任务：新建 / 编辑 / 完成 / 软删除 / 优先级 / 分类 / 标签 / 截止时间 / 提前提醒
- 重复任务：按日/周/月推进期次，完成只推进不落地为「已完成」
- 列表：今天 / 本周 / 以后 / 无日期 / 已完成分组，逾期提示，搜索（标题、描述、分类、标签）
- 收集箱：录入（`client_id` 幂等）、删除、一键转任务（单事务）、搜索
- 设置：主题三态、通知权限状态与申请、测试通知、本地数据概览
- 提醒：本地通知排期（上限 64）、启动对账、通知动作「完成 / 10 分钟后」、处理完收起通知
- 数据：SQLite v5（WAL）、迁移事务化、`rev` 自增、`outbox` 同事务入队

### 已实现（本轮 UI 落地，真机未走查）

- 导航：底部 Tab 扩为 5 个（任务/收集箱/笔记/设备/设置），App 内栈推送页（隐藏 TabBar，硬件返回）
- 笔记：本机 CRUD（SQLite v3 `notes` 表）、置顶/收藏/搜索/筛选、编辑器（返回即保存、
  加粗/列表/待办/标签/分享，字数与 revision 展示）
- 通知与后台页：权限/测试通知真实；「完成后收起通知」「10 分钟后动作」两个开关持久化 kv
  并分别作用于动作收起与排期类别（对之后排期的提醒生效）；vivo 后台警告卡（跳系统设置）
- 规划屏结构（真实状态 + 规划徽标，无假数据）：配对新设备、同步（待发送=本机 outbox 实数）、
  处理冲突（空态+规则）、主屏小组件（偏好存 kv）、分享接收（参数化，可真实存收集箱）

### 未实现（明确边界）

| 能力 | 状态 |
|---|---|
| 配对 / 设备身份 / 连通性测试 | **已实现并在物理机验证**（2026-11-09），见 [06-pairing.md](06-pairing.md) |
| 任务同步 / 冲突检测 / 墓碑 | **已实现并在物理机验证**（2026-11-09），见 [07-sync.md](07-sync.md)；仅任务 |
| 收集箱 / 笔记同步、字段级自动合并、后台同步 | 未实现；任务冲突为整条记录级，由用户选择保留哪一端 |
| `server_rev` / 墓碑日志（收集箱、笔记） | 任务已建；其他实体未建 |
| 主屏小组件（AppWidgetProvider）、系统分享接收（intent-filter）、远程推送 | 原生能力未实现；页面为规划态结构 |
| iOS | 未验证（本机无 macOS/Xcode），本轮只做 Android |

### 已记录的已知限制

- 应用退到后台后提醒未投递（vivo Funtouch / Android 16），判定为厂商后台策略，
  见 [04-testing.md](04-testing.md) §6。
- 提醒使用默认精度排期（约 7.5 分钟窗口），不申请 `SCHEDULE_EXACT_ALARM`。
- 重复规则按自然日/自然周计算，不支持法定节假日与调休。
- 任务同步需手动点「立即同步」：无后台/自动同步，失败只做客户端退避重试。
- 同步冲突按整条记录处理，没有字段级自动合并；`sync_changes` 日志尚无保留期清理。

## 变更记录

- 2026-11-08 首版：按桌面端文档分工建立手机端规范集，全部条目以当时代码为准。
- 2026-11-08 原型落轮：按 Stitch v2 原型补齐 8 屏 UI + 笔记数据层（schema v3）+ 4 Tab
  栈导航 + 通知动作开关；真机走查未执行，状态分区已相应拆分。
- 2026-11-08 配对落轮：新增 [06-pairing.md](06-pairing.md)；状态表把「配对/连接」移到已实现，
  数据同步仍明确未实现；补充 expo-camera、SecureStore 与明文 HTTP 偏差说明。
- 2026-11-08 原型归档：33 个导出变体按页面归组迁入 `prototypes/variants/`，v2 终版 11 屏
  归档到 `prototypes/final/`，新增画廊 `index.html` 与 `mapping.json`；`03-ui-spec.md`
  变更记录中的 `tmp/acceptance/stitch-mobile-prototypes/` 为生成期记录，归档后以
  `prototypes/` 为准。
- 2026-11-09 物理机扫码验证：配对与连接从「真机未走查」移入「已实现并在真机验证」；
  扫码配对、连接测试、强停重启后配对保持与扫描线动效均在 vivo V2323A / Android 16 上通过；
  数据同步仍未实现。证据 `tmp/acceptance/mobile-pairing-physical/`。
- 2026-11-09 任务同步落轮：新增 [07-sync.md](07-sync.md)；桌面 SQLite v43 变更日志与
  `/v1/changes`、`/v1/ops`，手机端 schema v4（`server_rev`、`sync_conflicts`），
  载荷 XSalsa20-Poly1305 加密；真机接收 4 / 发送 21 通过，冲突页真机复现并由「采用桌面端」
  解决；收集箱/笔记、后台同步、字段级合并仍为未实现。
- 2026-11-09 收集箱/笔记同步：桌面 SQLite v44 触发器覆盖 `notes` / `quick_capture_items`，
  手机 schema v5；笔记整篇同步、收集箱仅 `inbox`（handled/converted 为墓碑）、长笔记按体积
  分批；真机 APK 0.1.6（versionCode 13）完成 push/pull、handled 墓碑与恢复。后台同步、
  字段级合并与日志清理仍未实现。
- 2026-11-09 文件互传 v1：新增 [08-file-transfer.md](08-file-transfer.md)；桌面 SQLite v45
  `mobile_files`、`/v1/files` 分块端点、设置页文件列表；手机端 `expo-file-system` 58
  （文件选择/SAF 目录/FileHandle/预览）与文件互传页。协议级 20/20；vivo V2323A 真机完成
  640B 下载、54B 上传与删除清理，最终 APK 0.1.6/vc13 sha256 `6356f581…`。
- 2026-11-09 文件互传 UI 真机走查：底部固定操作区、方向分组、字节进度与分方向空态在
  vivo V2323A / vc18 复验；2.4MB 下载、640B 打开、20MB 上传（SHA-256 一致）与 100MB
  取消通过；修复取消竞态与 SAF 半成品清理。最终 APK 0.1.6/vc18 sha256 `605cbc8a…`，
  证据 `tmp/acceptance/file-transfer-ui/`。
- 2026-11-09 设备 Tab：配对/同步/文件互传/冲突/小组件/分享从设置页迁到一级「设备」Tab，
  底部 Tab 变为 5 个；设置页只留外观/提醒/本地数据/关于。文件行改为 13 种 View 自绘
  文件类型图标（不再写扩展名），类型决定形状、方向决定底色。真机 vc20/vc21 复验
  5 Tab、设备页、13 种图标与明暗主题；vc21 补齐入口文案后的空态。桌面端左侧导航
  新增「手机互传」页，设置页移除「手机与同步」。最终 APK 0.1.6/vc21（sha256 见验收报告）。
