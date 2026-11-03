# task_dock Skills V3 — 安装与边界

将此压缩包解压到 task_dock 仓库根目录。内部 `.agents/skills/` 为四个项目 Skill；若 V2 已存在，同名文件会被更新，旧版模板路径不再沿用（可自行对比后移除）。**不要覆盖其他 Agent 的工作树修改。**

## 核心内容
- `taskdock-acceptance`：功能验收的流程、参考矩阵、只读预检、证据清单校验、模板。
- `taskdock-ui-acceptance`：WebView2/原生 UI 验收、目标效果图资产登记与完整性校验、截图清单校验。
- `taskdock-performance-audit`：有界队列/内存/CPU 生命周期审计、CSV 统计、实验协议。
- `taskdock-remediation-prompt`：证据驱动的开发 Agent 交接和修复任务初稿。

## 重要原则
1. `assets/templates/` 仅放**模板**。实际截图、报告、JSON 清单、日志和性能指标都放 `tmp/acceptance/<task-name>/` 或 `tmp/debug/<task-name>/`。
2. `taskdock-ui-acceptance/assets/design-refs/` 才放**经过人工批准**的长期目标设计效果图，存入 `manifest.json` 并校验哈希；本包不包含任何未经审核的仓库图片。
3. 首次使用时必须先阅读根 `AGENTS.md`、`docs/ACCEPTANCE_ROUTING.md`；优先使用仓库现有 `scripts/acceptance/` 与 `scripts/perf/`。
4. 脚本以 Python 3.10+ 标准库为主，除设计图导入的 `--apply --approved` 外均只读；**导入只更改 Skill 资产目录，不碰用户数据**。

## 本地快速校验（从仓库根运行）

```bash
python .agents/skills/taskdock-acceptance/scripts/preflight.py --repo .
python .agents/skills/taskdock-ui-acceptance/scripts/verify_design_refs.py --repo .
```

### 把已批准效果图纳入 Skill（不会自动执行）

```bash
python .agents/skills/taskdock-ui-acceptance/scripts/import_design_reference.py --repo . --source "docs/design-refs/v07/规划中心效果图.png" --id planning-center-v07 --component planning-center --state overview --theme both --note "经用户确认的规划中心参考"  
# 手工确认图片内容、权限和 dry-run 输出后，在同一命令结尾加 --apply --approved。
```

缺失源图时不要假称已导入；应先在本地核实其真实路径。`manifest.json` 初始为空并非安装失败。

## 验收/证据
- `SKILL.md` 不能代替运行测试与真机交互。
- 不移动鼠标不等于未更改窗口状态；F 通道需要授权。
- `tmp/` 不随技能发布。证据不应被打包回 Skill。
