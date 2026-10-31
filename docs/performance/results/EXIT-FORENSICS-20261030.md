# 被测实例「自行退出」取证（第四轮内存实测）

- 记录时间：2026-10-30 23:00–23:35
- 涉及二进制：`C:/Users/ASUS/AppData/Local/Temp/taskdock-measure-bin/tdmeas.exe`
  （15,389,184 B，sha256 `a0d17ab672f60b6009144355e98a09711b682f70e9799e823106f214efba6b7e`）
- 涉及脚本：`scripts/perf/memory-scenario.py`、`scripts/perf/memory-compare.py`、
  `scripts/perf/quit-under-load.py`、新增 `scripts/perf/exit-forensics.py`

## 1. 现象

第四轮三臂对照里，N2、N3 两臂的实例在观察窗口内**自行退出**，导致 `memory-compare.py`
拒绝输出三臂差值归因（`process_exited_during_run=true`）。四次「自行退出」记录：

| 臂 | 启动时刻(本地) | 退出时刻 | 存活 | 退出码 | `last-shutdown-report.json` |
|---|---|---|---|---|---|
| N2-load-notify-off | 22:38:59 | 22:47:20 | 515.5 s | 0 | 有 |
| N3-idle | 22:48:51 | 22:51:15 | 144.3 s | 0 | 有 |
| reproA-notifyoff | 22:57:40 | 22:58:22 | 42.1 s | 0 | 有 |
| reproB-notifyon | 22:57:29 | 22:57:56 | 26.8 s | 0 | 有 |

（证据：`docs/performance/results/DIAG-N{2,3}-*-meta.json`、`DIAG-repro{A,B}-*-meta.json`，
以及同名 `-app.log`。）

应用日志里退出前**没有任何 WARN/ERROR**，退出序列固定为：

```
应用退出：关闭 HTTP 接入监听，不再接受新事件
应用退出：HTTP 接入适配器停止
接入管线退出排空完成 lifecycle=stopped timed_out=false drained=0 unfinished=0 spooled=0 unsaved=0 elapsed_ms=0
[ERROR:ui\gfx\win\window_impl.cc:172] Failed to unregister class Chrome_WidgetWin_0. Error = 1412
```

## 2. 排除项（都有证据）

| 假设 | 结论 | 依据 |
|---|---|---|
| 被外部 `taskkill` 杀掉 | 否 | 退出码 0，且写出 `last-shutdown-report.json`（强杀不会有）。被测二进制已改名为 `tdmeas.exe`，按镜像名的误杀脚本打不中它 |
| 前端调用 `quitApp` | 否 | `src/lib/bridge.ts` 导出但前端从未调用；Rust 侧只有 `commands/system.rs:15` 一处 |
| 通知开关导致 | 否 | 通知开（reproB）与通知关（reproA）都退 |
| HTTP 端口/接入负载导致 | 否 | N3 全程空闲、reproA/B 无任何事件接入（`events_received=0`）也退 |
| 单实例锁冲突 | 否 | 插件在 Windows 上用互斥体 + 隐藏窗口，重复启动走 `std::process::exit(0)`（硬退、无退出报告）；实例标识已按数据目录隔离（`src-tauri/src/lib.rs:320-345`） |
| WebView2 / 原生崩溃 | 否 | Windows 应用程序事件日志无对应崩溃记录；退出前无任何错误日志 |
| dev 模式预检失败 | 否 | 产物由 `npx tauri build --no-bundle` 构建（启用 `custom-protocol`），日志无「开发服务器预检失败」 |

## 3. 源码级收敛：退出只能由三条路径触发

`request_exit()`（`src-tauri/src/lib.rs:797`）是唯一的优雅退出入口，调用方只有三处：

1. 托盘菜单 `quit`（`lib.rs:205`）
2. `commands/system.rs:15` 的 `quit_app` 命令（前端从未调用）
3. `RunEvent::ExitRequested`（`lib.rs:782-787`）

而 `RunEvent::ExitRequested` 在 `tauri-runtime-wry` 里**只有两个来源**：

- `TaoWindowEvent::Destroyed`：最后一个窗口被销毁 → 窗口为空 → 触发退出
- `Message::RequestExit(code)`：即 `app.exit()`，本产品里只有 `request_exit` 末尾自己调用

也就是说：**要么有人点了托盘「退出」，要么主窗口被销毁**。

## 4. 复现：托盘自动化误伤别的实例

`scripts/perf/quit-under-load.py` 用 `tray-quit5.ps1` 自动化点击托盘「退出」，
而该脚本按**通知区图标名**定位实例：

```powershell
if($n.StartsWith("Task Dock") -and $el.Current.ClassName -eq "SystemTray.NormalButton") { $res+=$el }
$icon=(FindIcon | Select-Object -First 1)   # 取第一个匹配项，不区分实例
```

所有 Task Dock 实例的托盘提示词都是 `Task Dock`，因此当机器上同时跑着别的
Task Dock 实例（并行会话的验收实例、其它测量实例）时，这个自动化**会退掉别人的实例**。

用 `scripts/perf/exit-forensics.py` 做了受控复现（当时机器上没有别的 Task Dock 实例）：

```
[  20.1s] 执行托盘退出自动化
[  20.1s] 托盘脚本输出: icon=2084,1233 menu=2084,934,205,299 quit=2144,1208
[  20.1s] 窗口失效 hwnd=0x15f0dec ...（全部顶层窗口同时失效）
[  29.2s] 进程退出 {"exited_after_s": 29.2, "exit_code": 0, "shutdown_report": true}
[verdict] GRACEFUL_REQUEST_EXIT
```

应用日志尾与历史四次退出**逐行一致**（同样的三条 INFO + 同一条 Chromium 收尾 ERROR），
退出码 0、`last-shutdown-report.json` 同样写出。

**结论**：第四轮 N2/N3 的「自行退出」不是被测二进制的缺陷，而是
**托盘自动化按图标名误伤其它 Task Dock 实例**——与此前记录的「按镜像名 `taskkill` 误杀」
（`docs/PERFORMANCE_TESTING.md` §9.5）同类的跨实例污染，只是选择器换成了托盘图标名。

## 5. 处置

1. `scripts/perf/quit-under-load.py` 增加前置检查：机器上存在除本实例外的其它
   Task Dock 进程时**拒绝执行**托盘自动化（托盘自动化无法按 PID 定位），
   检查结果写入证据 JSON 的 `other_taskdock_instances` 字段。
2. 测量侧继续保留「实例中途退出即判该臂无效」的硬失败（`memory-scenario.py` /
   `memory-compare.py` 已有），避免把死掉的实例读成「内存回落到 0」。
3. 新增 `scripts/perf/exit-forensics.py`：盯住被测实例的全部顶层窗口句柄，
   区分「窗口先失效 → 产品优雅退出」与「被外部杀掉」，并用退出报告判别二者。

## 6. 复现命令

```bash
# 受控复现托盘误伤（需机器上没有其它 Task Dock 实例）
python scripts/perf/exit-forensics.py \
  "C:/Users/ASUS/AppData/Local/Temp/taskdock-measure-bin/tdmeas.exe" \
  <fresh-data-dir> <fresh-appdata> 90 --seed \
  --tray-quit-at 20 \
  --tray-quit-script "C:/Users/ASUS/AppData/Local/Temp/taskdock-accept-v05/tray-quit5.ps1"

# 只观察、不干预（对照组：同配置下实例可稳定存活）
python scripts/perf/exit-forensics.py \
  "C:/Users/ASUS/AppData/Local/Temp/taskdock-measure-bin/tdmeas.exe" \
  <fresh-data-dir> <fresh-appdata> 240 --seed --scenario
```
