# 验收标准与测试计划

## 1. 判定原则

- 只认**真实执行**：命令、工作目录、退出码、时间、证据路径；
- 编译通过不算验收；必须验证真实链路（真实文件写入、真实 DB 行、真实剪贴板数据）；
- 环境阻塞写 `ENVIRONMENT BLOCKED`，不算通过；
- 未实现项必须写「未完成」，不得用「已优化」代替。

## 2. 自动化测试矩阵

| 层 | 文件 | 覆盖 |
|---|---|---|
| Rust 单元 | `src-tauri/src/transfer/tests.rs` | 去重键、正文分级阈值、排序写回、状态迁移、清理不动 pinned、关联去重与方向校验 |
| Rust 单元 | `src-tauri/src/fsops/mod.rs`（`#[cfg(test)]`） | `write` 文件名清洗、冲突跳过/重命名/覆盖、目标禁止目录 |
| 前端纯函数 | `src/lib/crossTab/*.test.ts` | 动作可见性/可执行性、上下文目标解析、事件总线循环与退订、面板模式阈值、目标校验 |
| 前端组件 | `src/components/transfer/*.test.tsx` | 多选、发送按钮禁用原因、预览计数渲染、失败清单渲染、Escape 关闭 |

命令：

```bash
# 前端类型与单测（经调度器）
npm run typecheck
npm test -- --run src/lib/crossTab src/components/transfer
# Rust（经调度器，在 src-tauri 内）
npm run cargo -- test --lib transfer
npm run cargo -- test --lib fsops
```

## 3. 手工验收清单（真实链路）

### A. 工作篮面板

- [ ] 工作台顶栏按钮打开/关闭；`Ctrl+Shift+B` 在任意页面切换；
- [ ] 固定后成为右侧列，宽度拖拽 260–520，重启后保持；
- [ ] 工作台宽度 < 1080 时自动抽屉，内容区不被压到 < 420；
- [ ] 切换 Tab 内容不丢；重启后固定内容恢复；
- [ ] 多选、全选、反选、删除、拖拽排序；
- [ ] 100 条内容加载不卡顿（分页 80，滚动补页）。

### B. 剪贴板 → 工作篮

- [ ] 多段文本批量加入；顺序与剪贴板列表一致；
- [ ] 多张图片批量加入，只存引用（DB 中无 base64）；
- [ ] 多个文件批量加入；
- [ ] 混合内容加入；重复项提示「已存在」；
- [ ] 剪贴板历史清理后，对应条目失效并提示；发送时该条失败、其余成功。

### C. 工作篮 → 文件工作区

- [ ] 文本 → TXT；文本 → Markdown；
- [ ] 多段合并 / 分开；
- [ ] 图片批量保存，格式 PNG，尺寸不变；
- [ ] 文件批量复制；文件批量移动（二次确认）；
- [ ] 链接 → `.url` / Markdown；
- [ ] 混合内容预览计数正确；
- [ ] 同名冲突三种策略各验证一次；
- [ ] 目标目录被删除后提示无效，不写入；
- [ ] 只读目录 → 失败原因「权限不足」，其余条目成功；
- [ ] 部分成功时 UI 显示「成功 N / 失败 M」；
- [ ] 重试只重跑失败项；
- [ ] 撤销把生成/复制的文件移入回收站。

### D. 跨模块

- [ ] 工作篮文本 → 新建任务，任务出现在任务列表且带 `derived` 关联；
- [ ] 文件 → 关联项目，`entity_links` 有记录；
- [ ] 知识条目 → 工作篮 → 关联任务；
- [ ] 采集 → 工作篮 → 知识库；
- [ ] 同一关联重复创建不产生第二行。

### E. 架构不变量

- [ ] 新增动作只改适配器；
- [ ] 无第二套文件复制/移动/删除；
- [ ] 无第二套剪贴板监听；
- [ ] 页面卸载后订阅清零（`bus.stats()` 为 0）；
- [ ] 事件循环防护生效（单测）；
- [ ] 迁移与备份登记通过（`cargo test` 的 schema 覆盖测试）。

## 4. 性能观测点

| 指标 | 方法 | 目标 |
|---|---|---|
| 面板首次打开 | 从点击到首屏列表渲染 | < 300ms（本地 DB，100 条内） |
| 工作篮加载 | `transfer_list_items` 50 条 | < 50ms |
| 批量加入 100 条 | 端到端 | < 500ms |
| 批量写入 50 个文本 | fsops 任务完成 | 记录实际耗时（不设硬指标，按磁盘） |
| 事件重复执行 | `bus.stats()` + 单测 | 同一订阅只执行一次 |
| 面板隐藏时刷新 | 代码审查 | 无轮询/无定时器 |

## 5. 证据要求

- 命令输出重定向到 `tmp/acceptance/cross-tab-integration/logs/`；
- 手工验收截图放 `tmp/acceptance/cross-tab-integration/shots/`；
- 报告 `tmp/acceptance/cross-tab-integration/report.md` 必含：
  任务范围、检查依据、P0–P3 问题清单、修改文件、命令与退出码、已验证/未验证项、
  遗留风险、结论（通过/部分通过/不通过/证据不足）。

## 9. 2026-11-19 实际执行状态（覆盖上文目标态）

| 检查 | 状态 | 证据/限制 |
|---|---|---|
| `npm run typecheck` | 通过 | exit 0 |
| `cargo test transfer::tests --lib` | 通过 | 7 passed / 0 failed，`m-mwnar8a9-30aff0.log` |
| `vitest src/lib/crossTab` | 通过 | 8 passed，`l-mwn9u4cg-c280d4.log` |
| `vitest src/components/transfer` | 通过 | 2 passed，`l-mwnav9w1-fece25.log` |
| `vitest src/lib/crossTab/modules/tasks.test.ts` | 通过 | 3 passed（创建/关联/失败），`l-mwnc6wqs-264074.log` |
| `vitest src/components/clipboard` | 通过 | 109 passed，`l-mwn9vcc8-38d4ba.log` |
| `write_one` 真实写盘/复制/冲突 | 通过（单测） | `m-mwnbi3pm-6a8f70.log` |
| 真机手工 A–E | 未执行 | 未打开真实窗口操作 |
| 正式构建/安装包 | 部分 | 首轮 `npm run tauri -- build` 成功（`h-mwnbnl54-09ca63.log`），但早于最新 UI；重建被 11.54 GB 磁盘阈值阻止（**未执行**最终代码构建） |
| 性能采样 | 未执行 | 无样本数据 |

未实现、不得勾选：`Ctrl+Shift+B` 快捷键、反选、拖拽排序、260–520 固定宽度区间
（当前为 240–900，固定列阈值 1080）、`SendToMenu`、P1 模块动作。
