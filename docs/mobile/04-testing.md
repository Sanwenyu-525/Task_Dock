# 手机端测试与真机验收

> 结论口径沿用根 `AGENTS.md` §7/§10：没执行写「未执行」，环境阻塞写 `ENVIRONMENT BLOCKED`，
> 证据不足写「证据不足」。模拟器结果不得写成真机结果。

## 1. 验收层级（对照根 AGENTS.md 的 A–F 路由）

| 层 | 手机端对应手段 | 能证明 | 不能证明 |
|---|---|---|---|
| A 静态与自动化 | `npx tsc --noEmit`；编译真实 `domain` 代码后跑断言脚本 | 类型、纯函数语义（重复规则、搜索） | 渲染、通知、数据库 |
| B 逻辑集成 | 设备上直接操作后读 SQLite / `uiautomator` 控件树 | 真实数据落库、界面状态 | 系统通知展示、后台行为 |
| C 真机视觉 | `adb exec-out screencap` + 像素扫描 | 颜色、表面、布局溢出 | 手势手感、TalkBack |
| D 系统能力 | `dumpsys notification --noredact` / `dumpsys alarm` | 通知是否真的排在系统里 | 用户是否看到 |
| E 物理操作 | 手动或 computer-use | 手感、系统弹窗 | 可重复性差，需标注 |

真机验收只认**真机**（当前设备 vivo V2323A / Android 16）。模拟器不作为证据。

## 2. 自动化命令

```bash
cd apps/mobile
npx tsc --noEmit          # exit 0 才算通过
```

纯函数断言（编译真实代码，不重写实现）：

```bash
cd apps/mobile
npx tsc --ignoreConfig src/domain/recurrence.ts src/domain/taskQuery.ts src/domain/noteText.ts \
  --outDir ../../tmp/acceptance/mobile-app-skeleton/logic/js \
  --target es2022 --module commonjs --skipLibCheck --strict
node ../../tmp/acceptance/mobile-app-skeleton/logic/check.cjs   # 期望 PASS 62 / FAIL 0（noteText 预览去标记 +17）
```

注意：仓库根 `package.json` 是 `"type": "module"`，编译产物目录里必须放
`{"type":"commonjs"}` 的 `package.json`，否则 `check.cjs` 会以 ESM 解析而报
`exports is not defined`。该目录在 `tmp/`（不入库），重建时补一行即可。

`check.cjs` 覆盖：星期编号；每天/每 3 天墙钟不变；每周/工作日跨周末；每月大小月收敛；
每月第 N 个/最后一个工作日；休眠补偿；提前完成推进；坏 JSON/未知频率/越界星期容错；
预设往返；搜索命中标题/描述/标签/分类/大小写/空查询；笔记文本（2026-11-08 起）：
摘要压平与截断、字数不含空白、加粗包裹（含无选区与越界）、片段插入光标、空标题回退链。

## 3. 真机环境与操作

设备：vivo V2323A / Android 16。无线调试序列号形如
`adb-10CE1P063L0017L-MA7LCw._adb-tls-connect._tcp`。

```bash
export MSYS_NO_PATHCONV=1          # Git Bash 会把 /data/local/tmp 转成 Windows 路径
adb devices                        # USB + 无线同时连会出现两条条目，必须 -s 指定
adb -s <serial> shell uiautomator dump /sdcard/ui.xml
adb -s <serial> pull /sdcard/ui.xml ./ui.xml
node tmp/debug/mobile-app-skeleton/ui.mjs dump            # 打印 文本 + 中心坐标
node tmp/debug/mobile-app-skeleton/ui.mjs tapContains 收集箱
node tmp/debug/mobile-app-skeleton/ui.mjs type hello
node tmp/debug/mobile-app-skeleton/ui.mjs key 66           # Enter
```

已知环境坑（不是应用缺陷）：

- **中文输入法吞字**：vivo IME 下 `adb shell input text` 的合成文本不提交，控件只收到 1 个字符。
  规避：输入后 `keyevent 66` 提交，再从 `uiautomator` 读控件值确认。要清空搜索框必须先让
  IME 失焦（点别的控件）再点「清除搜索」。
- **秒级时钟会让控件树 dump 失效**：页头时钟每秒刷新，`uiautomator dump` 持续返回
  `ERROR: could not get idle state`，`--compressed` 与 8 次重试都拿不到新文件（实测 6/6 失败）。
  规避：改用截图 + 像素定位（扫描纯白卡片带算出各行的 y 区间），不要用 `ui.mjs dump`
  的坐标；`ui.mjs` 已改为先删远端文件，dump 失败时报错而不是回退到旧控件树。
- **键盘遮挡底部 TabBar**：键盘弹起时点 Tab 会打到 IME 上，先按 Back 收起键盘。
- **vivo 安装器拒绝同版本重装**：升级 `versionCode` 再装（见 05-build.md §4）。

## 4. 用例矩阵

标记：PASS 本轮真机验证；BLOCKED 环境阻塞；未执行 未验证。

| # | 用例 | 通道 | 状态 |
|---|---|---|---|
| 1 | 新建任务并出现在「今天/无日期」正确分组 | B | PASS |
| 2 | 完成普通任务：完成态卡片、勾选动画、可恢复 | B | PASS |
| 3 | 完成重复任务：期次推进、任务保留、提示「下次 …」 | B | PASS |
| 4 | 重复规则推进（每 3 天 / 每周五 / 工作日 / 每月 31 日收敛） | A | PASS（33/33） |
| 5 | 软删除任务后列表与计数同步 | B | PASS |
| 6 | 编辑截止时间与提醒；清空截止时间（三态 `null`） | B | PASS |
| 7 | 「提前 10 分钟」保存后回读仍为相对模式（23:59 → 23:49） | B | PASS |
| 8 | 标签录入、行内显示 `#work`、搜索命中标签 | B/A | PASS（多标签未验证） |
| 9 | 搜索标题/描述/分类/标签、空查询不过滤 | B | PASS |
| 10 | 收集箱录入与 `client_id` 幂等 | B | PASS |
| 11 | 收集箱转任务（单事务，条目消失、任务出现） | B | PASS |
| 12 | 主题三态切换 + 深色表面 | C | PASS |
| 13 | 浅色无矩形白框（像素扫描） | C | PASS |
| 14 | 滑删红底不从圆角/边缘透出（像素扫描） | C | PASS |
| 15 | 通知权限状态、申请、测试通知 | D | PASS |
| 16 | 提醒排期写入系统（`dumpsys alarm` / notification） | D | PASS |
| 17 | 启动对账：force-stop 后重启，系统通知缺失时重排（1→0→1） | B/D | PASS |
| 18 | 通知动作「完成」改库 + 收起通知 | D | 部分：改库 PASS，收起修复后**未复验** |
| 19 | 通知动作「10 分钟后」 | D | 未执行（等待期间应用被系统清理） |
| 20 | 冷启动点击通知动作 | D | 未执行 |
| 21 | 应用退到后台后提醒投递 | D | **ENVIRONMENT BLOCKED**（见 §6） |
| 22 | 320dp 窄屏 / 大字体 / TalkBack | C/E | 未执行 |
| 23 | 数据库 v1 → v2 升级不丢数据 | B | PASS |
| 24 | 页头显示年月日时分秒，秒位实时跳动 | C | PASS |
| 25 | 360dp 宽下四块统计压成一行（不再 2×2） | C | PASS |
| 26 | 分组头点击折叠/展开，计数与箭头状态正确 | C | PASS |
| 27 | 只允许左滑露出删除；开启后卡片右侧为直角 | C | PASS |
| 28 | 右滑不露出删除，也不会误触完成 | C | PASS |
| 29 | 切回任务页的入场淡入期间不闪删除按钮（红像素 0） | C | PASS |
| 30 | 收集箱输入底色包住提示与记录按钮 | C | PASS |
| 31 | 滑删后点「删除」真的删掉并提示 | B/C | PASS |
| 32 | 桌面端开启/关闭手机接入：状态与监听同步，关闭后配对码失效 | C | PASS（CDP：关闭后 running=false，关闭态拒绝生成码） |
| 33 | 桌面端配对弹层：二维码可扫、6 位码、倒计时、重新生成 | C | PASS（OpenCV 解码弹层截图成功） |
| 34 | 手机端应用内扫码 → 确认指纹 → 配对成功（令牌进 SecureStore） | D | PASS（2026-11-09 物理机 vivo V2323A/Android 16：扫码配对成功，配对行 `last_ip=192.168.5.7`；强停重启后仍为已配对；证据 `tmp/acceptance/mobile-pairing-physical/`） |
| 35 | 手机端手动输入地址 + 6 位码配对 | D | PASS（x86_64 模拟器 Release APK） |
| 36 | 错误配对码/过期/尝试超限：提示可操作且不授权 | A/C | PASS（curl 错码 401；单测覆盖过期/次数上限） |
| 37 | 同步页「测试连接」成功并刷新桌面端最近连接时间 | C/D | PASS |
| 38 | 桌面端撤销设备后，手机端测试连接返回 401 并提示重新配对 | C/D | PASS（显示「令牌已失效 / 需重新配对」） |
| 39 | 手机端解除本机配对：令牌与元数据删除，桌面端列表仍保留待撤销 | D | PASS（模拟器：未配对空态 + toast；桌面端设备保留） |
| 40 | Release APK 在局域网明文 HTTP 下可配对（未被 Android 拦截） | D | PASS（2026-11-09 物理机 `192.168.5.7/24 wlan0` → 桌面 `192.168.5.6:47822`，Release APK 0.1.5；`/v1/ping` 200 并刷新 `last_seen_at`） |
| 41 | 扫描页取景框内扫描线上下往返；系统「减少动态」时静止居中 | C | PASS（x86_64 模拟器，APK 0.1.5：0.45s 间隔帧线位 y≈946→1222 往返；`transition_animation_scale=0` 后两帧静止 y≈1083，恢复后继续移动；2026-11-09 物理机复测三帧 y=1277→1205→1355，1080×2400） |
| 42 | 任务 pull：桌面任务（含已完成/标签/截止时间）同步到手机 | D | PASS（2026-11-09 物理机：接收 4 条，手机列表出现「开会 / 快速提醒 / 哈哈哈哈 / 你好」） |
| 43 | 任务 push：手机本地任务创建/修改/删除推送到桌面 | D | PASS（发送 21 条；桌面任务 4→22、`sync_ops=21`、`last_seen_at` 刷新；重放只 ack 由协议测试覆盖） |
| 44 | 冲突：两端改同一任务 → 手机出现待处理冲突 → 采用桌面端 | D | PASS（手机完成任务 + 桌面改名 → 同步显示「冲突 1」；冲突页两版并列，采用桌面端后标题/状态回到桌面版本、冲突清空） |
| 45 | 同步载荷加密与跨语言互通 | A | PASS（Rust 解密 tweetnacl 向量；手机 crypto 模块 KDF/双向信封/AAD 拒绝；Node 加密客户端跑通 pull/push） |

## 5. 证据与像素复核

- 截图：`adb exec-out screencap -p > tmp/acceptance/mobile-app-skeleton/screenshots/<name>.png`，
  文件名带序号与主题（如 `16-redesign-light.png`），不复用旧编号。
- 表面问题用像素扫描定量，而不是「看起来没问题」：例如白框检查扫卡片内部是否有
  与卡片底色不一致的矩形区域；红线检查扫 `r-g>28 && r-b>28` 的像素分布。
  扫描脚本放 `tmp/debug/mobile-app-skeleton/`，报告只写扫描条件与命中坐标范围。
- 通知/闹钟用 `adb shell dumpsys notification --noredact | grep <tag>` 与 `dumpsys alarm`。
- APK 校验：构建后记 `sha256sum`，装机后 `adb shell pm path` + `pull` 回来再算一次，
  两值必须一致（证明装的就是构建产物）。

## 6. 已知阻塞与限制

1. **后台提醒不投递（P1 环境限制）**：应用切后台（进程仍在）后，到点通知未出现；
   同安装包在前台正常。已确认 receiver `expo.modules.notifications.service.NotificationsService`
   已注册、`POST_NOTIFICATIONS` 已授权、standby bucket 10（ACTIVE）、省电模式关闭，
   且 `dumpsys alarm` 里该闹钟到点后消失——说明系统取走了闹钟但未展示。
   判断为 vivo 后台策略，需要把应用加入「自启动 / 后台高耗电」白名单。
   **不记为代码缺陷，也不记为通过。**
2. **默认精度排期**：不申请 `SCHEDULE_EXACT_ALARM`，触发有约 7.5 分钟窗口；
   验收时间点要留余量，不能用「延迟 3 分钟没响」判定失败。
3. 中文 IME 注入丢字（§3）。
4. 通知动作的冷启动路径需要设备保持前台 10 分钟以上，本轮被系统清理打断，未执行。

## 7. 报告规范

任务级报告：`tmp/acceptance/mobile-app-skeleton/report.md`，**追加分节**，不改写历史结论。
每节必须含：

- 触发与范围、检查依据（读了哪些代码/文档）；
- P0–P3 问题清单：现象 / 根因 / 影响 / 证据；
- 修改文件与关键位置；
- 命令 + 工作目录 + 退出码 + 时间；
- 已验证 / 未验证（写原因）/ 遗留风险 / 结论（通过 / 部分通过 / 不通过 / 证据不足）；
- 证据路径（必须真实存在）。

推翻旧结论时保留旧文件，新增带日期的更正条目。

## 变更记录

- 2026-11-08 首版：整理三层验收、真机命令、23 条用例矩阵与后台投递阻塞记录。
- 2026-11-08 真机走查（第二轮，原型 11 屏）：A/B/C/D/E 五组按批执行，缺陷批量修复后一次
  重建安装（不再逐条重建）。本轮新增/复验要点：笔记搜索正负例、工具栏光标落点（B→**、列表→
  
- 、标签→# 连击后仍在同一光标位置）、复制全文/分享面板/删除、深色模式、通知动作类别随
  开关切换（`dumpsys notification --noredact` 的 actions 数与通知栏按钮）、完成后收起两向。
  键盘遮挡与顶栏滚走两类缺陷的复验命令与坐标记入 `tmp/acceptance/mobile-app-skeleton/`。
- 2026-11-08 配对落轮：用例矩阵新增 32–40（桌面启停、二维码、扫码/输码、错误码、连通性、
  撤销、解除配对、Release 明文 HTTP）；本轮结果以 `tmp/acceptance/mobile-pairing/report.md` 为准。
- 2026-11-08 批次二：`check.cjs` 期望值 45 → **62**（新增 17 条 `plainPreview`/预览断言）；
  提醒：`uiautomator dump` 设置了 `FLAG_INCLUDE_NOT_IMPORTANT_VIEWS`，**不能**用来判定
  `importantForAccessibility="no-hide-descendants"` 是否生效，无障碍结论必须用 TalkBack 实测。
- 2026-11-09 TalkBack 通道实测（vivo V2323A / Android 16 / user 构建 / TalkBack 17.1）：
  `adb` 注入触摸**不经过** TalkBack 触摸浏览——`input tap` 单击直接激活控件（点「处理冲突」行
  整页跳转），`input swipe` 被应用当普通滑动/点按（在笔记卡片上滑动直接打开编辑器），
  `input keycombination` 无硬件键盘不生效，`sendevent /dev/input/event5` 被 SELinux 拒绝。
  结论：`uiautomator` 与 `adb input` 都不能作为无障碍判据，`importantForAccessibility` 只能由
  人手在 TalkBack 下遍历验证（步骤与证据见 `tmp/acceptance/mobile-app-skeleton/report.md` §15.12）。
  启用读屏会写入 TalkBack 首次教程标记；验收后需还原 `enabled_accessibility_services`（用
  `settings delete`，写空串会报 Bad arguments）、`accessibility_enabled=0`、
  `touch_exploration_enabled=0`，并 `am force-stop com.google.android.marvin.talkback`。
- 2026-11-09 任务页页头由「年月日 时分秒」改为 `今天 11月9日 周一` 后，**该页不再每秒刷新**，
  `uiautomator dump` 恢复可用（本轮实测成功，144 节点）；「秒级时钟导致 dump 失败」的限制
  只对仍带秒级刷新的页面成立。若 dump 仍失败，按原规则先删远端 `ui.xml` 再重试，并改用截图取证。
- 2026-11-09 扫描页动效：矩阵新增 41（扫描线上下往返 + 减少动态静止）；模拟器按
  `transition_animation_scale` 切换验证（不是 `animator_duration_scale`，RN 读的是前者）。
  证据 `tmp/acceptance/mobile-scan-line/`，APK 0.1.5 / versionCode 9。
- 2026-11-09 UI/UX 择优合并真机抽查：任务页「本机模式」蓝底标签、设置页节标题细线与
  `SQLite v3 · WAL/待同步操作 48 条`、版本直接读 `app.json`（0.1.5）、笔记图钉移入 footer、
  编辑页顶栏徽标对齐、小组件页徽标同行；浅色 217/218/219/220/221，深色 222/223，AppBar 225。
  Tab 图标按原型重画（勾选圆/收件箱托盘/折角文档/齿轮）后单独构建并复验：226（任务选中）、
  227（收集箱选中）、228（设置选中）。逾期行琥珀胶囊因当前无逾期数据未截图（已逾期 0），只完成
  代码级改动。证据 `tmp/acceptance/mobile-app-skeleton/screenshots/`。
- 2026-11-09 二次复查补齐：任务搜索占位、截止时间 accentSoft 胶囊 + 时钟、优先级完整文案、
  笔记编辑器 15/23 与摘要 15/21（新增 `font.reading`）、收集箱提示、设置「已排期提醒」。
  真机 229/230/231/232/233 通过；优先级完整文案因无带优先级任务未截图。
- 2026-11-09 Tab 图标修正：对照 `docs/mobile/prototypes/final/tasks/code.html`，原型图标是
  Material Symbols 的 `check_circle / inbox / description / settings`，inbox 为近方形托盘 +
  底部 U 形开口（不是竖长 V 形），勾选圆始终描边（不是实心选中）。已按 22dp 重画并复验
  234（任务）/235（收集箱）。末次 APK sha256
  `b82a846f873bb117a8d894310590433e0daaaa602e55d91a3572b6182ff376e6`。
- 2026-11-09 物理机扫码闭环：vivo V2323A / Android 16 上应用内扫码配对成功（`last_ip=192.168.5.7`），
  连接测试后桌面端 `last_seen_at=2026-11-09T04:03:34Z`；App 强停重启后配对保持；扫描线三帧
  `y=1277→1205→1355`。用例 34/40/41 由 ENVIRONMENT BLOCKED/部分改为 PASS；证据
  `tmp/acceptance/mobile-pairing-physical/`。
- 2026-11-09 任务同步：矩阵新增 42–45；物理机接收 4 / 发送 21、冲突 1 并由「采用桌面端」
  解决；Rust `mobile_sync` 16 项、备份注册 1 项、`db::tests` 41 项全过；证据
  `tmp/acceptance/mobile-sync/`。模拟器系统镜像损坏（QEMU 挂起）记 ENVIRONMENT BLOCKED，
  本轮真机结果不依赖模拟器。
