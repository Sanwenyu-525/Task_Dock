# 目标效果图资产（非验收证据）

本目录保存**经过人工确认**、可长期复用的设计效果图或组件视觉基准。

## 目录结构

```text
assets/design-refs/
├─ manifest.json          # 正式基准唯一权威清单（status=approved）
├─ candidates.json        # 候选图清单（status=candidate，不含副本）
├─ dock/                  # 停靠/分类胶囊正式基准（当前 4 张）
│  ├─ capsule-dock-tasks-v07.png
│  ├─ capsule-dock-agents-v07.png
│  ├─ capsule-dock-clipboard-v07.png
│  └─ capsule-dock-apps-v07.png
├─ panels/                # 面板正式基准（当前 1 张）
│  └─ task-card-scheme-d-v07.png
└─ README.md
```

目标模块目录为 `capsule/`、`dock/`、`panels/`、`clipboard/`、`agents/`、`notifications/`、`planning/`；**只创建有正式基准的目录，不建空目录**。候选图不复制，因此不会产生 `candidates/` 目录。

## 资产录入

1. 先人工检查 `docs/design-refs/` 的候选图片，确认属于可长期保存的设计输入，不含个人信息、用户数据或密钥。
2. 判定分类：A 正式基准必须有明确批准依据（文档写明“最终效果图/视觉基准”或用户当次确认）；否则只能登记 B 候选。
3. 正式基准：执行 `scripts/import_design_reference.py`，先不带 `--apply` 预览；确认元数据后加 `--approved --apply`。
4. 候选：加 `--candidate --apply`，只写 `candidates.json`，不复制图片、不标 approved。
5. 使用 `scripts/verify_design_refs.py --repo . --strict --require-approved` 验证路径、哈希、ID 与字段完整性。
6. 验收时根据组件/模块/主题/状态选对应图片，与实际桌面截图进行**人工视觉对比**；不得仅凭 SHA 一致或像素脚本判断视觉通过。

## 字段与幂等

- `manifest.json` 条目至少包含：`id`、`file`、`source`、`module`、`component`、`state`、`theme`、`sha256`、`note`、`spec`、`uncovered`、`status`。
- `candidates.json` 条目至少包含：`id`、`source`、`module`、`component`、`state`、`theme`、`sha256`、`note`、`spec`、`uncovered`、`status=candidate`。
- 重复执行相同导入命令返回 `ALREADY_IMPORTED` / `ALREADY_REGISTERED`，不重复创建、不覆盖已有文件；同 ID 但元数据不同会拒绝并退出 2。
- 导入只复制，不移动或删除源文件。`source` + `sha256` 保留出处，便于去重和漂移检测；**不要把源文件与导入副本都作为并行维护的权威基准**。

此目录的图片是**输入**：当次任务产生的 before/after 截图、日志和 `report.md` 必须留在 `tmp/acceptance/<task-name>/`。报告模板属于 `assets/templates/`，不是实际报告。
