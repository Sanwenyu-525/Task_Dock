# 系统分享接收（Android ACTION_SEND text/plain）

> 状态：**已实现（2026-11-12）**，`apps/mobile` 独占 Android 侧；构建层验证 + 真机验证情况
> 见文末「验证状态」。本文是正式规范；任务级证据在 `tmp/acceptance/mobile-feature-dev/`。

## 1. 范围与边界

| 做什么 | 不做什么 |
|---|---|
| 接收 `ACTION_SEND` + `text/*` mimeType 的文本分享（URL / 纯文本） | 图片 / 文件分享（`EXTRA_STREAM`）不接收：无 `EXTRA_TEXT` 的 Intent 静默忽略 |
| 冷启动（`getInitialURL` 之外的原生拉取通道）与已运行（`onNewIntent`） | iOS（`NSExtension` 另需独立方案，本轮不做） |
| 用户在分享页确认后才写入收集箱 | 收到 Intent 就静默落库（明确禁止） |

mimeType 匹配用 `text/*` 前缀（`text/plain` 为主，浏览器分享多为 `text/plain`）；
`ACTION_SEND_MULTIPLE` 未注册。

## 2. 组件与注册链路

```
浏览器/应用「分享到 TaskDock」
  └─ ACTION_SEND text/plain ──► MainActivity（launchMode=singleTask，插件追加 intent-filter）
       ├─ 冷启动：JS 挂载后 ShareIntent.takePendingShare()（原生读 Activity.intent）
       └─ 已运行：OnNewIntent → 原生 sendEvent("onShareReceived")
            └─ App.tsx 订阅 → offerShare() 入队 → push("share")
                 └─ ShareScreen 消费队列 → 用户点「保存到收集箱」→ addCapture()
                      └─ onDataChanged() → App version++ → 列表与小组件刷新
```

| 组件 | 路径 | 职责 |
|---|---|---|
| 本地 Expo module | `apps/mobile/modules/share-intent/` | Intent 解析、截断、去重、待处理槽、事件；由 autolinking 自动链接（`npx expo-modules-autolinking resolve -p android` 已验证） |
| Config plugin | `apps/mobile/plugins/withShareTargetActivity.js` | prebuild 时给 `.MainActivity` 追加 SEND intent-filter（幂等，不重复叠加） |
| JS 队列 | `apps/mobile/src/lib/pendingShare.ts` | 内存队列（上限 5）+ 订阅 + offerId 去重 + 取消清空 |
| 屏幕 | `apps/mobile/src/screens/ShareScreen.tsx` | 消费载荷、确认保存、取消清空 |

`app.json` 的 plugins 数组含 `./plugins/withShareTargetActivity.js`；`android/` 是 prebuild
生成物（gitignore，顶层 `/android/` 锚定），不要手改。

## 3. 载荷契约

原生 `onShareReceived` 事件与 `takePendingShare()` 返回同一形状：

```ts
interface ShareIntentPayload {
  offerId: number;        // 原生侧单调递增；JS 按它去重双通道重复投递
  text: string;           // 已截断后的文本
  truncated: boolean;     // 原文超长被截断
  originalLength: number; // 截断前长度（Unicode 码点）
  receivedAt: number;     // epoch ms
}
```

处理规则：

1. **空文本 / 无 EXTRA_TEXT**：`extractSharedText()` 返回 null，不投递、不导航
   （分享面板其他应用发来的非文本 Intent 不打扰用户）。
2. **超长截断**：超过 4000 码点（与 `src/db/captures.ts` 的 `MAX_CONTENT`、桌面端收集箱
   上限一致）按码点截断到 4000 并置 `truncated=true`；分享页显示
   「原文 N 字，超出收集箱上限已截断为 4000 字」。这样保存不会再被 `addCapture` 的
   校验拒绝，也不会把不可同步的超长内容写进 outbox。
3. **去重**（原生侧，`ShareIntentModule.kt`）：
   - 待处理槽已有同文本 → 重复投递（同一 Intent 重放）直接忽略；
   - `onNewIntent` 800ms 内同文本二次到达 → 判定系统双投递，忽略第二次；
   - 冷启动 Intent 只在首次 `takePendingShare()` 时解析一次（进程内闩住），Activity
     因旋转/主题切换重建不会把已消费的分享重新弹出来。
4. **双通道收敛**：冷启动走拉取、运行中走事件，读写同一个待处理槽，先到先得；
   JS `offerShare()` 按 `offerId > lastOfferId` 过滤重复。
5. **用户返回键/取消**：`ShareScreen` 卸载时无条件 `discardPendingShare()`（清 JS 队列 +
   原生槽），不残留待处理载荷；保存成功同样先 discard 再返回。
6. **进程死亡残留**：待处理载荷只在内存。若用户停在分享页时进程被杀，从最近任务
   冷启动可能再次收到同一分享（重新弹出分享页）——视为「未完成的保存」，可接受。

## 4. 分享页 UI 语义（2026-11-12 变更）

- 顶栏徽标 `已接入`（Badge tone="active"），不再是「规划中」。
- 移除「标签」「补充备注」两个输入。原因：`captures` 表没有 tags/note 列（schema 与桌面端
  收集箱对齐，见 `docs/mobile/02-data-model.md`），而 SQLite 迁移文件不在该任务的所有权内，
  无法可靠持久化；按「不允许用户填写后被静默丢弃」的红线选择移除输入，并在表单里提示
  「保存后可在收集箱一键转为任务并补充标签、备注」。后续若桌面端收集箱扩展字段，
  再按迁移流程补列并恢复输入。
- 保存动作：`addCapture(text)`（`client_id` 幂等）→ `onDataChanged()` → 返回。
- **页脚隐私文案（修正）**：改为「保存后进入本机收集箱；已配对桌面端时，内容会随同步
  发送到桌面端。分享内容不会进入剪贴板历史。」——旧文案「不随同步外发」与真实同步行为
  矛盾，已废弃。

## 5. 安全边界

- 分享正文只在内存流转（原生单槽 + JS 队列），**不落盘、不写日志、不进剪贴板历史**；
  原生模块无任何 `Log` 调用。
- `discardPendingShare()` 是唯一的清理入口，返回键 / 取消 / 保存都会走到。
- 不申请任何权限；intent-filter 只加在主 Activity 上，不新增组件导出面（`singleTask`
  的 MainActivity 本就 exported，SEND 过滤器只扩大它能被「谁启动」的方式，不增加攻击面）。

## 6. 测试矩阵与验证状态

| 用例 | 通道 | 状态（2026-11-12） |
|---|---|---|
| prebuild 生成清单含 SEND intent-filter、`singleTask` | A（静态） | PASS（grep 生成物，见验收报告） |
| typecheck | A | PASS（exit 0） |
| 原生编译（assembleDebug/assembleRelease） | A | 见验收报告命令记录 |
| 冷启动分享 → 分享页 → 保存 → 收集箱出现且列表刷新 | D/真机 | 见验收报告（未执行则写明） |
| 已运行分享（onNewIntent）→ 分享页就地更新 | D/真机 | 同上 |
| 返回键取消后再次进入分享页为空态 | D/真机 | 同上 |
| 超长文本截断提示 | D/真机 | 同上 |
| 图片分享（EXTRA_STREAM）不弹页 | D/真机 | 同上 |

## 变更记录

- 2026-11-12 首版：分享接收原生接入（module + plugin + pendingShare + ShareScreen 改造），
  移除标签/备注输入（captures 表无列、迁移文件不在所有权内），修正页脚同步隐私说明。
