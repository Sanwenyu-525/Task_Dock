# 13 · 第五轮专项收尾验收（GUI 联合验收 · 工程门禁 · 隐私隔离 · 发布证据链）

> 日期：2026-10-31 · 版本：0.5.0（工作树含并行会话 v0.6 未提交改动） · 平台：Windows 11 x64 (22631) · 20 逻辑 CPU
> 原则：**未执行的不写成通过；测试逻辑 = 使用逻辑；环境问题如实单列，不伪装成通过或缺陷。**
> 本文只记录第五轮真实执行结果；第四轮历史见 `12-fourth-round-acceptance.md`（未改写）。

---

## 一、任务范围与结论速览

| 任务项 | 结论 |
|---|---|
| P1-01 GUI 脚本连接错误（连到 context-menu.html） | **已修复**（共享识别模块 + 21 项回归 + 3 次真机验证） |
| P1-02 可见主窗口剪贴板＋Agent 联合交互 | **已完成**（五类 UI 操作 n=4 有效样本、像素级颜色验证、截图 3 张） |
| P1-03 真实剪贴板压测隔离 | **已满足**（6 轮全部唯一测试标识、5 轮零外部混入、每轮恢复原剪贴板） |
| P1-04 当前整仓 fmt/clippy 收口 | **已收口**（fmt 10 处修复，clippy 0 警告，复跑验证） |
| P2-05 构建产物与 Git 状态核对 | **已核对**（precheck/report 可执行；清理需授权，未擅自删除） |
| P1-06 发布证据链（测试=构建=发布） | **已建立**（201 个源文件构建前后指纹一致） |
| **最终发布判定** | **CONDITIONAL PASS**（见第八节：一项环境相关的采集完整度缺口待受控复测） |

---

## 二、代码基线与并行协作

| 项 | 值 |
|---|---|
| 分支 / HEAD | `main` / `4918111a4cc0da6d101981cc9931a7f207e17bfe`（12:09 提交） |
| 工作树 | 脏（并行会话 v0.6 贴边吸附专项与本轮共用同一工作树，**全程未做任何 Git 清理/提交/回滚**） |
| 并行会话活动 | 全程活跃：14:39 起运行 `npm run tauri dev`（task-dock.exe PID 95548）；期间多次编辑 `window_shape.rs`/`system.rs`（fmt 差异两次新增，均按协议复跑门禁）；15:07 前后修复了其 `useEdgeSnap.integration.test.tsx` 的 3 个失败 |
| 本轮改动 | 仅 5 个文件（见第三节），均为验收自动化与格式修正；**未改任何产品行为代码** |
| 门禁与测试数据隔离 | cargo 在 `src-tauri/` 内运行；验收实例全部使用独立 `TASK_DOCK_DATA_DIR` + 改名二进制（`task-dock-p5gui.exe`），与并行实例互不串扰 |

**本轮修改的文件**

| 文件 | 内容 |
|---|---|
| `scripts/acceptance/cdp-main-window.mjs`（新增） | P1-01 主窗口识别模块（枚举/分类/身份验证/有限重试/全量日志） |
| `scripts/acceptance/cdp-main-window.d.mts`（新增） | 类型声明（tsc strict 要求） |
| `src/test/cdpMainWindow.test.ts`（新增） | 21 项回归（覆盖任务书 §3.3 全部场景） |
| `scripts/acceptance/joint-ui-drive.mjs` | 接入统一识别；重附着；Long Tasks/筛选/分组/像素场景 |
| `scripts/acceptance/cdp-bridge.mjs` | `findAppPage` 不再取「第一个页面」 |
| `scripts/acceptance/clipboard_stimulus.py` | 新增 `--marker`（默认值保持旧行为） |
| `scripts/perf/memory-scenario.py` | 透传 `--clipboard-marker` |
| `src-tauri/src/{context_menu,window_shape,commands/system,lib}.rs` | **仅 rustfmt 格式修正**（P1-04），无语义改动 |

---

## 三、P1-01 主窗口 CDP 目标识别（修复与验证）

### 3.1 根因

第四轮 GUI 验收实际连接到 `http://tauri.localhost/context-menu.html`（右键菜单辅助窗口）。
两个放大因素：① 辅助窗口的 `<title>` 同为 "Task Dock"，按标题/顺序选页必然踩坑；
② 旧逻辑「取第一个非 devtools 页面」在 context-menu 先注册时选错。真机证据：
`docs/clipboard/evidence/p1-05-gui-20261031/p1-05-ui-drive.json`（page_url=context-menu.html，6 轮全失败）。

### 3.2 修复设计（`scripts/acceptance/cdp-main-window.mjs`）

1. **全量枚举**：每轮 `GET /json/list` 取全部 targets（targetId/URL/标题/类型）；
2. **URL 分类**：`context-menu.html`（含查询串变体）→ 排除；devtools/非 page → 排除；其余为主候选；
3. **身份验证（复用现有机制，零新全局状态）**：页面内 `__TAURI_INTERNALS__.metadata.currentWindow.label === "main"`（`tauri.conf.json` 固定配置）+ `invoke` 可用；
4. **就绪验证**：`#root` 已挂载（React 渲染完成）；
5. **有限重试**：deadline 默认 20s、硬上限 60s、轮次硬上限 240——不允许无限等待；
6. **全程日志**：每轮记录 targetId/URL/标题/判定依据/各类计数；
7. **失败模式明确**：`not-found`（含原因与候选清单）/ `ambiguous`（≥2 个 label==="main" 立即失败不猜）/ 枚举持续失败（断线）均立即终止；
8. **运行中 target 失效**：驱动按同一逻辑重新附着（单次运行上限 3 次）。

### 3.3 回归测试（`src/test/cdpMainWindow.test.ts`，21 项全绿）

覆盖任务书 §3.3 全部场景：只有主窗口 / 只有右键菜单 / 两者并存 / 多辅助弹窗 / 未加载完成（loading→重试）/ 重建后 target 变化（两阶段重新识别）/ CDP 断开（有限重试后明确失败）/ devtools 与非 page 排除 / 双 main 候选 → ambiguous / invoke 不可用排除 / URL 正则边界 6 例 / deadline 钳制。测试与线上驱动共用同一模块（测试逻辑=使用逻辑）。

### 3.4 真机验证（3 次独立运行）

| 运行 | 选中 target | URL | identity |
|---|---|---|---|
| p5（15:25） | `179418E5…` | `http://tauri.localhost/` | label=main, mounted=true |
| p5e（16:16） | `259C06A1…` | `http://tauri.localhost/` | label=main, mounted=true |
| CDP 端点直查（15:25） | 首个 target 即 context-menu.html（标题同为 "Task Dock"）——被 URL 分类正确排除 | | |

三次运行 UI 驱动均零「找不到入口」失败（对比第四轮 6/6 失败）。

---

## 四、P1-02 可见窗口 GUI 联合验收（p5e 主臂 + p5 辅臂）

### 4.1 执行条件

| 项 | 值 |
|---|---|
| 被测产物 | 本轮 Release 构建 `task-dock.exe`（15:20:24，15,996,416 B，sha256 `fd3db23a…`，指纹链见第六节），复制为 `task-dock-p5gui.exe` |
| 场景 | `memory-scenario.py --duration 420 --post 60 --agents 4 --rate 5 --port 47870 --window visible --clipboard-stimulus on --clipboard-interval 3 --clipboard-image-every 6`（p5 主臂 240s/interval 3/image-every 10） |
| 隔离 | `TASK_DOCK_DATA_DIR` 独立、`WEBVIEW2_USER_DATA_FOLDER` 独立、CDP 端口 9231/9232 独立、二进制改名防采样混组 |
| 并发负载 | Agent 4×5 事件/s（20/s）持续整个可见窗口期；剪贴板激励真实写入系统剪贴板 |
| 环境干扰（如实记录） | 并行会话 dev 实例（PID 95548）与 506 个系统进程同机运行；这是第八节采集完整度现象的相关条件 |

### 4.2 UI 操作结果（p5e，全部真实 CDP 点击，n=4 有效样本，零失败）

| 操作 | p50 | p95 | max | n |
|---|---|---|---|---|
| 打开抽屉 | 43 ms | 49 ms | 175 ms | 4 |
| 搜索（含结果渲染） | 14 ms | 23 ms | 48 ms | 4 |
| **图片详情打开（含解码）** | **29 ms** | **37 ms** | 103 ms | 4 |
| 返回列表 | 44 ms | 47 ms | 65 ms | 4 |
| 关闭抽屉 | 38 ms | 40 ms | 50 ms | 4 |
| 筛选切换（文字/图片/全部） | 223/48/49 ms | | | 3 |
| 分组 tab / 分组详情 / 返回 | 59 / * / 29 ms | | | 1 |

辅助臂 p5（240s）：open p50=33/p95=39 ms，search p50=12/p95=15 ms，筛选切换 3 项全部 `aria-pressed=true`。

### 4.3 图片内容像素级验证（§4.1-6）

预览页画布采样（`canvas: "ok"`，asset 协议允许读取）：激励图为确定性 RGBA，
**左 [106,96,200,255]（不透明蓝）/ 中 [60,179,60,128]（半透明绿）/ 右 [0,0,0,0]（全透明）**
4 次预览全部一致——Alpha 语义（第四轮 P1-03 修复）在 UI 预览链路正确呈现。

### 4.4 截图证据（真实存在，相对仓库根）

| 文件 | 内容 |
|---|---|
| `tmp/acceptance/clipboard-fifth-round/test-results/p5e-ui-image-preview.png` | 图片详情：颜色块、元数据（120×80 · 283 B · 来源 · 使用次数） |
| `tmp/acceptance/clipboard-fifth-round/test-results/p5e-group-detail.png` | 自动分组「截图组 1」详情：收集中 · 2 项/1 图 · 组操作按钮 · 按序内容 |
| `tmp/acceptance/clipboard-fifth-round/screenshots/p5e-native-desktop.png` | 真机桌面：深色液态玻璃窗口悬浮实拍（capture-native.ps1） |

### 4.5 UI/UX 与稳定性检查（§4.2）

- 悬浮栏/抽屉操作全程无一假死：**Long Tasks = 0**（PerformanceObserver 全程观测）；
- 无 console error、无 pageerror、无重附着（target 全程稳定）；
- 布局无遮挡/溢出（见截图）；深色（桌面实拍）与浅色（CDP 截图）主题均清晰可读；
- 右键菜单窗口未被误认（P1-01）；Agent 20 事件/s 并发期间所有 UI 操作 p95 ≤ 49 ms；
- 真实提醒：创建 → 10s 到期 → `notification_inbox_stats` unread=1/total=1，**恰好一次触发**，期间剪贴板操作不受阻塞。
  系统通知 Toast 的桌面气泡显示未做视觉确认（依赖真实用户会话通知设置）——如实标注 NOT VERIFIED。
- 历史清理路径真实执行（max_items 30→执行 cleanup→恢复 1000）；当时仅 7 条 < 30，删除为空操作
  （items_deleted=0，前后统计一致）——「删除旧条目+资产」的删除路径由第四轮单测与 30 分钟压测覆盖，本轮未在 GUI 内重复产生 >30 条数据。

### 4.6 判定

**P1-02 完成**：主窗口识别、抽屉、搜索、筛选、图片预览（像素级）、分组详情、重复开关、Agent 并发期间操作、提醒、清理路径均有真实有效样本；无因测试工具误选窗口产生的虚假失败。

---

## 五、P1-03 真实剪贴板压测隔离

### 5.1 隔离措施（全部落实）

1. 专用测试数据目录（每轮独立 `TASK_DOCK_DATA_DIR`，单实例锁按目录哈希隔离）；
2. 不连接真实 Agent 服务（负载为本地 bench HTTP 注入，无外部会话）；
3. 每条文本激励带唯一标识（本轮新增 `--marker`：`taskdock-p5*-clipboard-probe-N`）；
4. 图片激励为确定性 seed 生成（可字节级复算比对）；
5. 只统计/验证带标记内容，外部内容**只计数、绝不落日志或报告正文**；
6. 每轮结束恢复原剪贴板（仅恢复类型记录，不记录内容）：6 轮全部 `restored=true`；
7. 测试数据库全部位于本轮任务数据目录，未删除任何历史隔离库。

### 5.2 六轮运行对账（外部内容 = 数据库条目 − 带标记文本 − 图片；只报计数）

| 运行 | 窗口 | 二进制 | 激励（文/图） | 入库（文/图） | 外部混入 | 恢复 |
|---|---|---|---|---|---|---|
| p5（15:24） | 可见+GUI 驱动 | 本轮 fd3db23a | 80/80 ok | 27 / 4 | **0** | ✓ |
| p5-min2（15:48） | 最小化 | 本轮 fd3db23a | 80/80 ok | 38 / 8 | **0** | ✓ |
| p5-old（15:59） | 最小化 | 10:44 版 918c03ec | 80/80 ok | 24 / 6 | **1**（html，计数） | ✓ |
| p5-ref（16:07） | 最小化 | 09:20 版 8900bd9d | 80/80 ok | 18 / 2 | **0** | ✓ |
| p5d（16:14） | 可见 | 本轮 fd3db23a | 150/150 ok | 51 / 14 | **0** | ✓ |
| p5e（16:20） | 可见+GUI 驱动 | 本轮 fd3db23a | 140/140 ok | 27 / 9 | **0** | ✓ |

**零内容泄露**：任何外部剪贴板内容的正文均未进入日志、报告或截图。

### 5.3 诚实说明：Windows 最新状态语义下的覆盖

p5 主臂 5 条文本探针未入库属「写入后被后续状态覆盖」（最新状态语义，与第四轮 §6.2.2 相同机制），
本轮如实按覆盖率报告，不宣称零丢失。

---

## 六、工程门禁与发布证据链（P1-04 / P1-06）

### 6.1 门禁结果（每条命令含工作目录与退出码）

| 门禁 | 命令（工作目录） | 退出码 | 结果 |
|---|---|---|---|
| rustfmt | `cargo fmt --all -- --check`（src-tauri） | 0 | 通过（修复 10 处后；期间并行会话两次新增差异，均按协议修复+复跑） |
| clippy | `cargo clippy --all-targets --all-features -- -D warnings`（src-tauri） | 0 | 0 警告（上轮 `empty_line_after_doc_comments` 已随 12:09 提交消除） |
| Rust 测试 | `cargo test --all-targets --no-fail-fast`（src-tauri） | 0 | **lib 488 passed / 0 failed / 3 ignored**（性能/真机套件按规矩 ignored，不计为通过）；并行会话改动后复跑同样全绿 |
| tsc | `npx tsc --noEmit`（仓库根） | 0 | 通过（本轮新增类型声明后） |
| vitest | `npx vitest run`（仓库根） | 0 | **45 文件 / 431 tests 全部通过**（含本轮 21 项） |
| 前端构建 | `npm run build` | 0 | 通过 |
| Release 构建 | `npx tauri build`（pretauri precheck 自动执行，exit 0） | 0 | EXE + NSIS + MSI 三产物（5m54s） |

原始输出：`tmp/acceptance/clipboard-fifth-round/logs/`（gate-test-all2.log、gate-frontend2.log、release-build.log、fmt-check-before.txt、clippy-before.txt）。

### 6.2 指纹链：被测源码 = 被构建源码 = 待发布源码

| 环节 | 证据 |
|---|---|
| 测试前指纹 | `logs/fingerprint-before-gates.txt`（HEAD + git status + 260 文件 sha256） |
| 构建前指纹（权威） | `logs/fingerprint-before-build.txt`（201 个发布相关源文件，16:00 前记录；期间并行会话两次编辑 Rust → 按 §八.10 协议复跑受影响门禁后重新冻结） |
| 构建后指纹 | `logs/fingerprint-after-build.txt` —— **201 个源文件与构建前逐一比对零差异** |
| 产物 | `sha256sum`：EXE `fd3db23ab52a59b87fee0beeeb3c0f5c8398a85a0f8c55776969759926d7ea95`（15,996,416 B）；NSIS `cf824298e9f208961c8f283c6dbd3feb947682edb0a5bdf8e6164b17cab60fd7`（4,535,305 B）；MSI `83ab7e6ec24d0f7953a954ce51c192fffd07981f5a867aef379a469e5a382adb`（6,889,472 B） |
| 路径 | `src-tauri/target/release/task-dock.exe`、`bundle/nsis/Task Dock_0.5.0_x64-setup.exe`、`bundle/msi/Task Dock_0.5.0_x64_en-US.msi` |

GUI/压测使用的 `task-dock-p5gui.exe` 与发布 EXE **同 sha256**（复制件，运行前复核）。
安装包的安装/启动/卸载与签名验证：**NOT VERIFIED**（未授权执行安装类操作，沿用第四轮条件）。

### 6.3 P2-05 构建目录核对

- `node scripts/build-guard.mjs precheck` / `report` 均可执行（exit 0），pretauri 钩子生效（Release 构建日志可见）；
- 磁盘 66.4 GB 空闲，满足构建阈值；
- 待授权清理清单（**本轮未删除任何目录**）：`src-tauri/src-tauri`（1.91 GB，第四轮相对路径事故产物，无归属标记，建议人工确认后手动删除）；`src-tauri/target-accept`（18.37 GB）、`target-accept-dbg`（6.59 GB）、`target-measure`（1.90 GB）、`target-test`（3.68 GB）为历史轮次缓存，可按 `docs/DEVELOPMENT.md` 第七章流程回收；
- `.gitignore` 检查：`target-*/` 通配已覆盖隔离目录，无构建缓存误入 Git。

---

## 七、重要发现：采集完整度的环境相关性（P1，非本轮引入）

**现象**：今日 15:24–16:20 的全部 240s 压测中，文本激励入库率仅 19–47%、图片 25–100%，
而同一构建族在今晨 09:43 的 30 分钟跑为 99.2%（第四轮 §6.2）。

**A/B 排除代码回归**（决定性证据）：

| 二进制 | 构建时间 | 今晨结果 | 今日复测（同场景） |
|---|---|---|---|
| `8900bd9d`（第四轮验收版） | 09:20:15 | **595/600 = 99.2%**（09:43，30 min） | **18/80 = 22.5%**（16:07，240 s） |
| `918c03ec`（10:44 版） | 10:44:55 | — | 24/80 = 30% |
| 本轮 `fd3db23a` | 15:20:24 | — | 38/80 = 47.5%（最小化）、27/80 = 34%（可见+GUI） |

同一二进制从 99.2% 跌到 22.5%，而本轮构建在同等条件下反而最好——**退化与今日午后机器负载相关
（506 进程、21 个 agent 进程、提交内存 35.8/68.3 GB、4 个 Task Dock 实例并存），不是本轮或当前源码引入的回归**。

**机制线索（未定论）**：GUI 臂监控计数显示通知在监听层即缺失（observed=33 << 系统级变更 ~76），
且丢失呈簇状；`empty_events` 计入 EmptyClipboard 阶段通知后账目闭合（33 = 9 captured + 24 empty + 1 skipped）。
消息泵为紧循环 `GetMessageW`、队列零丢弃，指向 OS 级通知延迟/抑制或跨进程剪贴板竞争，
需 ETW/受控环境复测定位——**超出本轮范围，如实登记为遗留 P1**。

**对发布的影响评估**：① 非本轮源码引入（A/B 证明）；② 依赖采集数据的全部验收项
（UI 操作、像素、分组、提醒）均以真实样本达成；③ 第四轮 30 分钟稳定性/内存结论在其条件下有效；
④ 图片（关键负载）在最小化臂 100% 入库。→ 按 CONDITIONAL PASS 处理，列为发布后第一个受控复测项。

---

## 八、发布阻断项与遗留风险

| 级别 | 项 | 状态 |
|---|---|---|
| P1 | 采集完整度环境性退化（第七节） | 遗留：需安静桌面/受控负载复测定根因（ETW）；非本轮引入 |
| P2 | `src-tauri/src-tauri` 嵌套目录 1.91 GB | 待授权删除（无归属标记，工具不自动删） |
| P2 | 历史构建缓存 ~30 GB（target-accept 等 4 项） | 待授权按流程回收 |
| P2 | 安装包安装/启动/卸载、签名验证 | NOT VERIFIED（未授权执行安装类操作） |
| P2 | 系统 Toast 气泡的桌面视觉确认 | NOT VERIFIED（依赖真实会话通知设置；收件箱链路已验证） |
| P3 | GUI 内 >30 条的清理删除路径未在本轮重复产生 | 由第四轮证据 + 单测覆盖 |
| 记录 | p5b 驱动轮次因调度撞上场景 teardown 而作废 | 已用 p5e 重跑替代，作废数据未计入任何结论 |

---

## 九、最终结论

**CONDITIONAL PASS**——发布条件 15 项中 14 项满足并有原始证据；唯一非阻断缺口是
第七节的环境相关采集完整度现象（非本轮引入、需受控复测定位）。

可以发布的判断依据：被测/被构建/待发布源码指纹一致；四类门禁全绿；GUI 联合验收在真实
并发负载下零失败；隐私隔离六轮零泄露；隐私事务、Alpha 语义、图文粘贴能力（本轮未触碰相关代码）
沿用第四轮已验证结论。建议发布动作：先取得清理授权与安装验证授权，随后按第十节清单执行。
