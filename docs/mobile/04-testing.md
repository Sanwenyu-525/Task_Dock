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
npx tsc --ignoreConfig src/domain/recurrence.ts src/domain/taskQuery.ts \
  --outDir ../../tmp/acceptance/mobile-app-skeleton/logic/js \
  --target es2022 --module commonjs --skipLibCheck --strict
node ../../tmp/acceptance/mobile-app-skeleton/logic/check.cjs   # 期望 PASS 33 / FAIL 0
```

注意：仓库根 `package.json` 是 `"type": "module"`，编译产物目录里必须放
`{"type":"commonjs"}` 的 `package.json`，否则 `check.cjs` 会以 ESM 解析而报
`exports is not defined`。该目录在 `tmp/`（不入库），重建时补一行即可。

`check.cjs` 覆盖：星期编号；每天/每 3 天墙钟不变；每周/工作日跨周末；每月大小月收敛；
每月第 N 个/最后一个工作日；休眠补偿；提前完成推进；坏 JSON/未知频率/越界星期容错；
预设往返；搜索命中标题/描述/标签/分类/大小写/空查询。

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
