# Task Dock v0.4 最终发布验收报告

- 验收日期：2026-10-28
- 验收基线：main 分支，基线提交 dcd120b → 本轮整改提交 c3921f1（+本次报告提交）
- 验收环境：Windows 11 23H2（10.0.22631 x64），本机真实数据目录参与只读/迁移验证
- 结论：**CONDITIONAL PASS**（全部 P0/P1 发布阻断项闭环并有真机证据；MSI 静默安装
  与少量依赖人工/极端环境的非阻断项如实标记"未验证"，见第七节）

---

## 一、本轮整改提交

| 提交 | 内容 |
| --- | --- |
| `c3921f1` | P0 资源入库；P1 备份恢复/关联所有权/测试进程安全；P2 窗口身份与 UWP 偏好；前端窗口选择链路与 DOM 交互测试 |

**未推送声明**：远程 `origin`（github.com/Sanwenyu-525/Task_Dock）存在推送通道，
但按验收纪律**未经授权不推送**，所有提交仅保留在本地。是否推送由项目所有者决定。

---

## 二、P0/P1/P2 问题闭环表

| # | 级别 | 问题 | 修复 | 验证证据 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | P0 | `src-tauri/icons/tray-app.png` 未入库，`lib.rs:37` `include_bytes!` 与 `tauri.conf.json` 托盘配置依赖它，干净检出必然编译失败 | 核实为编译期必需资源后 `git add`；`docs/screenshots/` 验收截图一并入库；`.gitignore` 审计确认无其他必需资源被排除 | 干净克隆（file:// 全新 clone）：`npm ci`/`cargo check`/`npm run build`/`npm run tauri build` 四步全部 exit 0，双安装包产出；克隆内 `tray-app.png` 存在 | ✅ 闭环 |
| 2 | P1 | 删除 Agent 来源后备份无法恢复：导入严格校验来源/会话存在性，合法备份整体恢复失败 | 导入校验分两层（见 data.rs 模块注释）：伪造/损坏（空身份、会话 ID 不过白名单、类型非法、有外键的悬空引用）→ 整体拒绝；历史失效（来源/会话已不存在的 agent_session 目标与 task_agent_links）→ 接受保留，恢复后 UI 如实显示 `unavailable` | E2E 回归 `delete_source_backup_restore_roundtrip_preserves_tasks_and_marks_unavailable`：建任务/来源/会话/关联 → 删来源 → 备份 → 导入全新库 → 任务/关联/失效状态完整 + `PRAGMA foreign_key_check` 零违规；真实 v0.3 时代 v1/v2 备份文件恢复通过（集成测试，见 4.3） | ✅ 闭环 |
| 3 | P1 | 新旧 Agent 关联所有权冲突：`unlink_task()` 按三元组删旧表记录，可能误删用户手工关联 | 迁移 v5 为 `task_agent_links` 增加 `origin` 列（user=手工 / auto=导航兼容影子记录），按"同事务时间戳严格相等 + 同身份导航关联存在"回填；`link_task` 影子记录标 auto；`unlink_task`/`delete_target` 只删 auto | 迁移测试（手工关联保持 user、影子记录回填 auto、幂等）；所有权回归 8 场景全绿（只旧版/只新版/新旧并存/重复关联/重复解除/删导航目标/删来源/备份恢复 origin 一致）；真机：本机真实库 v4→v5 迁移成功、origin 列就位、外键零违规 | ✅ 闭环 |
| 4 | P1 | Windows 测试误伤用户进程：窗口快照差集 + taskkill 存在竞态，用户测试期间打开的记事本可能被杀 | 删除快照差集策略。测试只拉起自己专属子进程并持有 `Child` 句柄；RAII 守卫（Drop）清理：Toolhelp 按「父 PID == 测试子进程 PID 且镜像名 == notepad.exe」归属（真机实证 Win11 存根形态：System32\notepad.exe 立即退出、真实窗口进程为 WindowsApps 包且父 PID 保留）；无法归属一律不碰；互斥锁规避打包版记事本单进程多标签形态；panic 时 Drop 同样清理；无任何 `taskkill /IM` | `cargo test`（真机）记事本测试真实执行（非跳过）、断言"已有窗口必须唤醒而非再启动"通过、测试后 `tasklist` 无残留记事本；并发跑套件无互相误杀 | ✅ 闭环 |
| 5 | P2 | 精准窗口选择链路断裂：选择器保存 exe+标题提示，所选窗口身份未传递到导航 | `WindowMemory` 增加 `origin` 语义；新命令 `nav_pick_window_identity` 由后端**即时**解析 hwnd 为类名+标题稳定身份落库（HWND 绝不持久化）；导航优先级：显式 hwnd > 用户显式记忆（偏好关闭时仍生效）> 自动记忆（偏好开启时）> 标题最长；自动记忆不覆盖用户显式选择；AppPicker 选择窗口后固化身份；AppManagement 显示窗口记忆徽标 + 可见清除按钮（接入 `nav_forget_window`） | 后端单测：`user_memory_origin_persists_and_reads_back`（旧数据反序列化为 Auto）、`effective_memory_honors_user_pick_even_when_remember_disabled`、记忆落库不含 HWND 断言；前端 DOM 测试：窗口选择 → navSaveTarget + navPickWindowIdentity 双调用、身份记录失败如实降级提示；多窗口纯函数测试（精确记忆→同类名→最长标题） | ✅ 闭环 |
| 6 | P2 | UWP 启动分支绕过 `nav_allow_launch`，无动作语义区分 | `uwp_decision` 纯函数：显式 `open_app` 直接启动（不算降级）；默认/`focus_window` 按偏好降级启动（fallback=true + 如实原因）或明确拒绝（"无法按窗口唤醒且当前设置不允许自动启动"），绝不静默绕过 | `uwp_decision_respects_launch_preference` 四分支单测 + `uwp_target_refused_before_any_process_spawn_when_launch_disallowed`（决策在 spawn 前拒绝）；真机烟测：`explorer.exe shell:AppsFolder\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App` 真实拉起计算器（pid 17636，WindowsApps 路径）后精确关闭 | ✅ 闭环 |
| 7 | P2 | UI 交互验收缺乏真实 DOM 测试 | 新增 jsdom + @testing-library 真实 DOM 交互测试 4 个文件（AppPicker/TargetMenu/QuickAdd/TasksPanel），覆盖点击、键盘（方向键循环/Enter/Escape）、弹窗关闭、焦点、连续快速操作（busyKey 防重复提交）、异步失败（错误 toast 可见且输入不丢） | `npm test`：10 个文件 80 用例全绿（旧 6 纯函数 + 新 4 DOM）；`npm run build`（tsc --noEmit）通过 | ✅ 闭环 |

---

## 三、数据库迁移与兼容性说明

- **v5（本轮新增）**：`ALTER TABLE task_agent_links ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'`
  + 条件回填（同事务时间戳严格相等 + 同身份 agent_session 导航目标存在 → auto）。
  - v0.3 及更早的手工关联默认 user，**任何自动逻辑不得删除**；
  - 迁移在单事务内原子执行，失败整体回滚（沿用既有 `apply_migrations` 机制）。
- **不破坏 v1～v4**：迁移链 v1→v5 单测覆盖（v0.1 库升级保留数据、v3→v5 新表齐备旧关联不动、
  迁移中途失败原子回滚可重试）；真实库（v4）经安装版应用打开迁移至 v5，任务/来源/会话数据保留。
- **新旧数据恢复**：v1（v0.3 旧格式，孤儿 run 自动合成占位会话）、v2（无导航表视为空表）、
  v3（导航三表）恢复路径均有自动化回归；真实 v1/v2 备份文件恢复验证通过（见 4.3）。
- 外键约束全程开启，未以任何形式关闭；导入保持"校验 → 单事务 → `PRAGMA foreign_key_check`
  闸门 → 任一失败整体回滚"。

## 四、验收执行记录（全部为本机真实执行）

### 4.1 主仓完整验收序列

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npm ci` | 依赖按 lockfile 安装 | 0 |
| `npm test` | 10 文件 / 80 用例全过 | 0 |
| `npm run build` | tsc --noEmit + vite build | 0 |
| `cargo fmt --all -- --check` | 无格式差异 | 0 |
| `cargo clippy --all-targets -- -D warnings` | 0 警告 | 0 |
| `cargo test` | 145 lib 用例 + 集成测试全过（1 ignored=真机工具） | 0 |
| `cargo check` | 通过 | 0 |
| `npm run tauri build` | 双安装包产出 | 0 |

产物（版本 0.4.0）：
- `src-tauri/target/release/bundle/nsis/Task Dock_0.4.0_x64-setup.exe`（3.52 MiB）
- `src-tauri/target/release/bundle/msi/Task Dock_0.4.0_x64_en-US.msi`（5.48 MiB）

### 4.2 干净检出构建（P0 验收标准）

`git clone file:///…/task_dock` → 全新目录，**无任何手动复制资源**：

| 步骤 | 结果 | 退出码 |
| --- | --- | --- |
| `npm ci` | 通过 | 0 |
| `cargo check`（冷编译 1m32s） | 通过 | 0 |
| `npm run build` | 通过 | 0 |
| `npm run tauri build` | 通过，产出 NSIS + MSI 双安装包 | 0 |

### 4.3 Windows 真机验收

| 项 | 结果 | 证据 |
| --- | --- | --- |
| NSIS 静默安装（currentUser） | ✅ | 安装至 `%LOCALAPPDATA%\Task Dock`，HKCU 卸载注册表 DisplayVersion=0.4.0 |
| 启动 | ✅ | 进程 + 主窗口出现（MainWindowTitle="Task Dock"） |
| 单实例保护 | ✅ | 二次启动后 `process-count=1` |
| 关闭 → 托盘 | ✅ | WM_CLOSE 后进程存活（按设计隐藏到托盘） |
| 退出 | ✅ | 进程终止 |
| NSIS 卸载 | ✅ | 安装目录移除、注册表项移除、`%APPDATA%` 用户数据保留 |
| 既有数据库迁移 v4→v5 | ✅ | 真实库 `user_version` 4→5、`task_agent_links` 新增 origin 列、外键零违规（迁移前文件备份 `.acceptance-backup/task-dock.db.pre-v5.bak`） |
| 既有数据保留 | ✅ | 迁移前后任务/来源/会话计数一致，`foreign_key_check`=0 |
| 真实 v0.3 备份恢复 | ✅ | 本机真实 `backup-20261025-162633.json`（v1）与 `backup-20261026-221546.json`（v2）导入全新库通过、外键零违规（`tests/real_backup_restore.rs`，`#[ignore]` 真机工具） |
| 真实 Agent 事件接入 | ✅ | release 二进制运行 + 真实 HTTP（127.0.0.1:47821）：running→completed 状态机、同 event_id 去重（2 发 1 存）、错误 Token HTTP 401、真实事件将 codex 置 verified=1 |
| 会话恢复（失联语义） | ✅ | 强杀进程 → 测试 run 回拨 20 分钟 → 重启 → status `running→disconnected` + `agent_disconnected` 通知（失联与失败语义分离） |
| 普通软件跳转（L1/L2） | ✅（记事本真实链路） | 记事本测试真机执行：拉起专属进程 → 导航唤醒已有窗口（actual=focus_window）→ 清理无残留 |
| UWP 启动（shell:AppsFolder） | ✅ | 计算器真实拉起并关闭（见 2#6） |
| 验收测试数据清理 | ✅ | 测试会话/轮次/事件/通知精确删除，外键零违规，`acc-%` 残留 0 |
| MSI 安装→启动→退出→卸载 | ⚠️ **未验证** | 本会话非管理员（IsAdmin=False），perMachine MSI 静默安装挂起无 UAC 可批准；安装包本身经两次构建产出且校验一致。需在管理员会话人工执行 `msiexec /i "Task Dock_0.4.0_x64_en-US.msi"` 验证 |
| 休眠唤醒提醒补偿 | ⚠️ 未验证 | 需真实休眠/唤醒周期，无法安全自动化；调度器补偿逻辑有既有单测覆盖 |
| 微信/浏览器等第三方人工跳转走查 | ⚠️ 未验证（本轮） | 避免干扰用户桌面未自动执行；L1/L2 由记事本真实链路、L3 委托语义由单测与 v0.3 已有真机走查（`APP_NAVIGATION_MATRIX.md`）覆盖 |
| 三模式/三主题/320px/400px/DPI 125%、150% 人工走查 | ⚠️ 未重复执行 | 本轮 UI 改动仅 AppPicker 身份固化与 AppManagement 记忆徽标（DOM 测试覆盖交互逻辑）；整体视觉走查沿用 v0.4 已有真机记录（`docs/screenshots/`、`UI_UX_ACCEPTANCE.md`）；Mica/Acrylic 原生效果仍以真机人工确认为准，不以 Mock 截图为证 |

## 五、安全与稳定性回归确认

以下既有保障**全部保留**并有对应测试（未被本轮修改弱化）：

- URL 协议白名单（`url_scheme_whitelist`）；EXE 绝对路径/.exe/解释器黑名单（`exe_path_rules`、`dangerous_targets_rejected`）
- 启动参数控制字符校验 + 结构化 `Command::new(args)` 启动（不经 shell）；AUMID 白名单字符集
- HTTP 回环绑定（netstat 实证 127.0.0.1:47821）与 Token 鉴权（错误 Token 401 真机实证）
- Agent 事件去重（真机 2 发 1 存）与乱序保护、失联/失败语义区别（真机 disconnected 实证）
- 事务化任务与提醒更新；数据导入失败整体回滚（`import_rejects_dangling_navigation_links_and_rolls_back` 等）
- 旧版迁移兼容（v1/v2/v3 单测 + 真实备份）；模拟事件不标记真实验证；任务完成状态不受启动/轮次结束影响（既有语义未触碰）
- 本轮未引入新的锁嵌套/死锁：唯一新增共享锁是测试互斥锁（仅测试代码）；`nav_window_memory`
  仍为单键 JSON 读改写（与 v0.4 既有行为一致）；无新增后台轮询。

## 六、Git 变更清单

提交 `c3921f1`（本地，未推送）共 38 个文件：

- 新增：`src-tauri/tests/real_backup_restore.rs`（真机备份恢复工具）、前端 DOM 测试 4 个、
  `docs/screenshots/`（含 v04/ 子目录）、`src-tauri/icons/tray-app.png`
- 修改：`src-tauri/src/db/mod.rs`（迁移 v5）、`commands/{data,agents,navigation}.rs`、
  `navigation/{target_resolver,router,window_manager}.rs`、`lib.rs`、`Cargo.toml`（ToolHelp feature）、
  前端 `AppPicker/AppManagement/navigation.ts/vite.config.ts/package.json`（新增 jsdom + testing-library dev 依赖）
- 本报告提交另含：`.gitignore`（排除 `.acceptance-backup/` 本地验收产物）

## 七、遗留问题与风险

1. **MSI 真机安装未验证**（非阻断）：需管理员会话人工执行一次安装→卸载；安装包构建已被
   主仓与干净克隆双重验证。
2. **Win11 打包版记事本的 exe 身份形态**：System32\notepad.exe 为存根，真实窗口进程在
   WindowsApps 下。用户若以 `C:\Windows\notepad.exe` 保存目标，按 exe 匹配窗口会落空而走启动
   分支（不会误启动第二个实例，系统层面仍单实例多标签）。建议用户从「当前运行的窗口选择」
   保存此类应用（本轮已把窗口身份固化进该链路）。
3. **导航兼容影子记录的 v0.4-dev 残留**：迁移按时间戳启发式回填，理论极端（手工关联与导航
   关联同纳秒创建）不存在实际风险；v0.3 正式版数据不受影响。
4. **休眠唤醒补偿、第三方软件人工走查、DPI 缩放人工走查**未在本轮重跑（见 4.3 标注），
   发布前建议按清单人工过一遍。

## 八、结论

**CONDITIONAL PASS** —— 全部发布阻断项（P0 构建可复现、P1 数据安全三项）已修复并以
真机证据闭环；测试规模 145（Rust）+ 80（前端 DOM/纯函数）全绿、全套验收命令退出码 0；
双安装包构建成功且干净检出可复现。非阻断的未验证项（MSI 人工安装、休眠唤醒、第三方
软件人工走查、DPI 人工走查）已在 4.3/第七节如实标注，不构成发布阻断。
