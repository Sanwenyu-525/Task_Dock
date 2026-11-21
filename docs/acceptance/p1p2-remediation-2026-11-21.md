# P1/P2 治理 · P0 批次（保险箱 / 回收站一致性 / 重复删除）验收记录

- 日期：2026-11-21
- 基线：`main` @ `eabfbc6`（工作区含其他并行任务的未提交改动，本批次只提交下列文件）
- 范围：A（Secure Vault 锁定安全）、C（回收站索引一致性）、D（重复文件删除身份安全）
- 结论：**代码与单元/组件测试通过；原生（`npm run tauri dev`）走查未执行**，理由见 §5。
- 本文只记录实际执行过的命令与结果；未执行项明确标注，不含推断。

## 1. 实际修改

### A. Secure Vault

| 文件 | 改动 |
|---|---|
| `src-tauri/src/clipboard/platform.rs` | 新增 `ScrubOutcome` 与 `try_scrub_text_if_digest`：一次 `try_lock` 内完成「读文本 → 比对 SHA-256 → 清空 + 写空文本 → 登记自写序列」，忙返回 `Busy` 不等待；非 Windows 桩返回 `Unavailable` |
| `src-tauri/src/secure_vault/session.rs` | `SecretField.value` → `Zeroizing<String>`（手写 serde 适配，JSON 契约不变）；`VaultSession.generation`；`ScrubTicket`；`lock_now()` 原子步骤 + `LockTransition` |
| `src-tauri/src/secure_vault/mod.rs` | `VaultState.scrub` 独立票据槽；`lock()` 改为 `&Arc<Self>`：同锁内取票据 + 递增世代 + 清空会话 → 同步试一次 → 后台 5s 预算退避重试（120/300/700/1200/2000ms）；审计区分 `ok/changed_by_user/write_failed/clipboard_busy` |
| `src-tauri/src/secure_vault/commands.rs` | `require_unlocked/require_writable` 返回 `(DEK, generation)`；`still_current()`；`vault_record_get` 解密后复核世代；`vault_copy_secret` 登记票据与复核同锁内、失配立即按指纹清除并启动重试；`clear_clipboard_if_unchanged` 改用同一原语；`vault_clipboard_clear_now` 支持锁定后的票据 |
| `src/store/useVaultStore.ts` | `epoch` 世代；`selectRecord/refreshList/copyField` 响应到达时比对世代；`resetAfterLock` 递增世代并复位 `loading`；锁定/状态订阅提升为模块级 `ensureVaultWatch()` |
| `src/components/vault/VaultPanel.tsx` | 移除面板内的重复事件订阅（由 store 统一处理，面板卸载后仍生效） |

### C. 回收站一致性

| 文件 | 改动 |
|---|---|
| `src-tauri/src/recycle/mod.rs` | 新增 `note_deleted_paths()` + 纯函数 `targets_for()`：路径 → 卷 → `bin_root` 去重 → `mark_reconcile_required(stale, FS_DELETE)` → `start_sync(force=false)` |
| `src-tauri/src/fsops/mod.rs` | `start_delete` 在任务收尾（`finish()` 后）整批调用一次；`permanent=true` 或 `ok==0` 不标记 |
| `src/components/files/RecycleWorkspaceView.tsx` | `syncDoneMessage()` 纯函数：取消 / 全部失败 / 部分失败（点名卷 + 错误码）/ 全部成功分级 |
| `src/locales/{zh-CN,en-US}/index.ts` | 新增 `fw.recycle.syncCancelled/syncFailed/syncPartial` 与 `fw.queue.deleteDuplicates`、`fw.duplicates.deleteUnknown` |
| `src-tauri/src/resource_cleanup/user_junk.rs` | 索引新鲜度测试补 `stale` 状态（删除失效后必须回退实时遍历） |

### D. 重复文件删除

| 文件 | 改动 |
|---|---|
| `src-tauri/src/file_workspace/identity.rs`（新） | `FileIdentity`（卷序列号 + 文件索引 + 大小 + FILETIME）、`identity_of_handle`、`verify_path`（含句柄最终路径比对）；非 Windows 为弱身份并标注 |
| `src-tauri/src/file_workspace/duplicates.rs`（新） | `DuplicateDeleteGroup`、`plan()`（形状校验 → 哈希+身份 → 内容复核）、`delete_plan()`（提交前逐文件复核 → 只走回收站）；跳过项带 `IDENTITY_CHANGED/FILE_GONE/UNVERIFIABLE/KEEP_CHANGED` |
| `src-tauri/src/file_workspace/mod.rs` | `FsHashEntry` 旁新增 `HashProgress`/`HashedFile`；`hash_files_detailed()`（同句柄取身份+哈希、4MB/200ms 进度节流、取消检查）；`hash_files()` 变薄封装 |
| `src-tauri/src/fsops/mod.rs` | `JobSnapshot` 增 `bytes_done/bytes_total`；`start_delete_duplicates()`（`kind=delete_duplicates`，复用任务注册表/取消/报告） |
| `src-tauri/src/commands/duplicate_delete.rs` | 改为薄命令，返回 `JobSnapshot`（原 `FsOpReport` 由 `fs_job_report` 读取） |
| `src/components/files/FilesWorkspacePanel.tsx` | `registerFileJob` → `finishFileJob` → `reportFromJob` 兜底；任务不可追踪时如实报错不计成功 |
| `src/components/files/OperationQueueBar.tsx`、`src/lib/bridge.ts`、`src/lib/contracts/models.ts` | 新任务类型与 `bytesDone/bytesTotal`（向后兼容的可选字段） |

### 文档

`docs/features/secure-vault/{security-architecture,threat-model}.md`、
`docs/features/files-workspace.md`、`docs/RESOURCE_CLEANUP.md`。

## 2. Rust 测试

构建：
```
cd src-tauri && cargo test --lib --no-run
# exit 0，产物 target/debug/deps/task_dock_lib-89b9c4144dff6e3a.exe
```

`cargo test` 直接执行失败（环境问题，见 §5）：
```
error: test failed ... exit code: 0xc0000139, STATUS_ENTRYPOINT_NOT_FOUND
```

补齐旁挂清单后**直接执行同一构建产物**（与 cargo 运行的是同一个 exe，行为等价）：

| 命令 | 结果 |
|---|---|
| `task_dock_lib-89b9….exe secure_vault::` | **29 passed; 0 failed** |
| `task_dock_lib-89b9….exe recycle::` | **65 passed; 0 failed; 3 ignored** |
| `task_dock_lib-89b9….exe fsops::` | **45 passed; 0 failed** |
| `task_dock_lib-89b9….exe file_workspace::` | **100 passed; 0 failed; 1 ignored**（含新增 16 个 identity/duplicates 用例） |
| `task_dock_lib-89b9….exe fs_safety` | **6 passed; 0 failed** |
| `task_dock_lib-89b9….exe resource_cleanup::` | **70 passed; 0 failed** |

本批次新增的关键用例：

- `secure_vault::session::tests::lock_now_hands_out_pending_copy_before_clearing`（T-CLP-04 前置）
- `lock_now_ignores_already_locked_session_without_vault`
- `secret_field_json_contract_is_unchanged`（`Zeroizing<String>` 不改变 JSON 契约）
- `recycle::tests::{deleted_paths_of_one_volume_collapse_into_one_target, deleted_paths_on_multiple_volumes_are_marked_separately, unresolved_volumes_are_skipped}`
- `file_workspace::duplicates::tests::{file_replaced_between_plan_and_delete_is_skipped, cancel_during_hashing_aborts_the_plan, progress_reports_bytes_and_file_counts, …}`
- `file_workspace::identity::tests::{same_size_rewrite_is_detected, replaced_file_is_detected_by_identity, missing_file_is_reported_as_missing}`

未覆盖：锁定路径的**真实剪贴板**清理（需要 Win32 剪贴板与 `AppHandle`），由原生走查承担。

## 3. 前端

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npx vitest run src/components/files src/components/vault src/store src/lib/filesWorkspace src/lib/crossTab src/components/transfer` | **89 files / 1116 tests passed** |
| `npx vitest run src/store/useVaultStore.test.ts` | 6 passed（含 3 个锁定并发用例） |
| `npm run build` | exit 0（vite 12.30s，仅原有 chunk 体积警告） |

新增前端用例：

- `useVaultStore 锁定与在飞请求`：详情/复制回执/列表三条路径在锁定后到达都必须丢弃；对照组未锁定时正常写入；`resetAfterLock` 世代递增。
- `syncDoneMessage 分级`：成功 / 取消 / 部分失败（含卷名与错误码）/ 全部失败。

## 4. 契约与兼容

| 契约 | 变化 | 兼容性 |
|---|---|---|
| `fs_delete_verified_duplicates` 返回值 | `FsOpReport` → `JobSnapshot` | 唯一调用点 `FilesWorkspacePanel` 已同步；逐项结果由既有 `fs_job_report` 读取 |
| `JobSnapshot` | 新增 `bytesDone/bytesTotal`（序列化恒在） | 前端类型为可选字段，旧前端忽略 |
| `ClipboardItem` 等剪贴板契约 | 未改 | — |
| 保险箱数据格式 | `SecretField.value` 仍是 JSON 字符串 | 旧库/旧备份可直接读取 |
| DB schema | **未改**（无新迁移） | — |

## 5. 环境问题（非本批次代码缺陷）

`cargo test --lib` 的测试进程在加载阶段失败：`0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND`。

根因与处理：

1. `src-tauri/build.rs` 用 `embed_resource::compile_for_tests(...).manifest_required()` 把
   Common-Controls v6 清单编进测试目标；缺少该清单时 `TaskDialogIndirect` 无法解析，
   测试进程在加载阶段即失败（build.rs 注释已描述该症状）。
2. 本次构建只生成了 `tests-manifest.lib` 的 `cargo:rustc-link-arg-tests`，未在 lib 单测
   harness 旁生成 `<exe>.manifest`；仓库内既有的旁挂清单（`task_dock_lib-89b9….exe.manifest`，
   394 字节，v6 依赖声明）证明历史上曾正常生成。
3. 临时处置：把既有旁挂清单复制为当前测试 exe 的 `<exe>.manifest` 后，进程可正常加载并跑完
   上述全部用例。**这是构建产物层面的环境修复，不在提交内容中**。
4. 建议（未在本批次实施，属共享构建配置）：让 `build.rs` 对 lib 单测 harness 也产出旁挂清单
   （或在测试脚本中显式复制），否则任何一次全量重建后 `cargo test --lib` 都会再次失败。

并行任务干扰：构建期间 `target/debug` 被其他会话的构建复用（工作区还有 `agent_access/project_hub`
未提交改动，另见 `task_dock_head_check` 构建目录残留），出现过一次 2 MiB 截断的测试 exe；
删除该产物重新链接后恢复。测试结果的最终依据是 §2 列出的 exe 与用例清单
（`--list` 中可见 `file_workspace::identity|duplicates` 共 16 项、`secure_vault::session::lock_now_*`）。

## 6. 未执行 / 未验证

- **原生走查（`npm run tauri dev`）未执行**：本批次需要真实剪贴板、真实回收站与 Shell 删除；
  共享工作区当前有其他任务的未提交改动的构建在跑，按项目规范不与其争用 dev 实例。
- 剪贴板被第三方长期占用时的 5s 预算耗尽行为（审计 `clipboard_busy`）只有代码路径，无真机证据。
- `ReadDirectoryChangesW`、复制暂存恢复（E）、批次监控退避（F）、剪贴板授权与静态加密（B）
  属后续批次，尚未实施。
- 未执行 Release 集成/安装包流程（本批次不涉及 Release 专属需求）。

## 7. 剩余风险

| # | 风险 | 说明 |
|---|---|---|
| 1 | 锁定清理受剪贴板占用限制 | 5s 预算内无法获得剪贴板时只记 `clipboard_busy`，不能证明已清除 |
| 2 | 身份复核与 Shell 删除之间仍有窗口 | 复核后到 `delete_paths` 提交之间（毫秒级）被替换仍可能命中；不做句柄级删除是复用 Shell 回收站的代价 |
| 3 | 非 Windows 弱身份 | 只有大小 + 修改时间，无文件索引；本项目不发布非 Windows 版本 |
| 4 | 删除失效的合并粒度 | 每个完成的删除任务最多贡献一次扫描；同时刻并发请求由 `follow_up` 合并为一次补扫 |
| 5 | 前端 JS 明文不可清零 | 只保证「锁定后不再持有 + 不持久化」 |
