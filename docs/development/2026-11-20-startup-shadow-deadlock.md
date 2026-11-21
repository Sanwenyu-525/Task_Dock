# Bug：工作台恢复时原生阴影重入导致主线程死锁

## 现象与证据

Dev 工作台可先正常进入，但最小化后重新加载/恢复时可能永久停在启动层，进程无响应。
前端模块加载和设置读取曾正常完成，因此仅调整启动超时或重新加载不能解决全部问题。

2026-11-19 隔离实例主线程栈已确认以下调用链（证据保存在
`tmp/acceptance/startup-usability-20261119/native-hang-stack.json`）：

```text
workbench_ui_ready → reveal_workbench → unminimize → ShowWindow
  → owner_proc → sync_state → SetWindowPos
    → owner_proc → registry Mutex::lock → WaitOnAddress
```

## 根因

`window_shadow::owner_proc` 持有阴影注册表互斥锁时执行 `sync_state`。其 Win32 调用会同步
触发宿主窗口回调，回调入口再次读取同一个注册表；普通 Mutex 不可重入，主线程等待自己
释放锁。`sync()` 也有同一持锁调用模式。首次 attach 则在初始化同步后才登记原窗口过程，
重入时还可能错误地走 `DefWindowProcW`。

## 修复

- 注册表保留原窗口过程、阴影句柄和可暂时取出的状态。
- 更新前取出状态并释放注册表锁，再调用 Win32；同一阴影的嵌套更新不重复执行，
  窗口过程仍能正确转交宿主。
- 返回后只归还仍属于同一阴影的状态；宿主已销毁/替换时释放位图、DC 与阴影窗口，
  不把旧状态插回注册表。销毁时同样先摘表、解锁，再调用原生资源释放。
- attach 先登记原窗口过程，再进行第一次同步。

修改范围：`src-tauri/src/window_shadow.rs`。无数据库、IPC、设置键或视觉参数变化。
不关闭阴影、不加重试/延迟、不把 Win32 调用移到后台线程。

## 验证

- 新增注册表同步重入、同步期间销毁两项 Rust 回归，验证锁不跨原生调用、原窗口过程仍可读、
  嵌套更新不重复、已销毁状态不复活。
- 原生复测场景：当前 Debug 二进制 + 隔离数据，重复“最小化 → WebView 重新加载 →
  工作台恢复”，核对真实 IPC、就绪阶段、进程响应及阴影宿主资源。
- 执行结果和二进制指纹见 `tmp/acceptance/startup-usability-20261119/` 的验收报告；安装态、
  Release 性能与多显示器不由本次 Dev 检查证明。

2026-11-20 实测：`npm run cargo -- test --lib window_shadow:: -- --test-threads=1`
通过 4/4（exit 0）；开启原生阴影的真实 Debug 实例连续 5 轮最小化、重新加载与恢复均通过，
每轮 `get_settings` IPC 正常、无前端异常，重载后仍能看到已完成任务。该实例通过 `quit_app`
正常退出。前端启动/页面/任务/设置定向回归通过 126/126。

## 防止复发

窗口过程可能由同步 Win32 API 重入。任何注册表/缓存锁均不得跨该类调用；重入保护也必须
保留宿主原窗口过程，不能简单跳过整个窗口消息链。测试不能仅覆盖阴影参数解析。
