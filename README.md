# dsh-metacog

**中文** | [English](README.en.md)

给 [DeepSeek Harness](https://github.com/deepseek-ai)（dsh）加一层元认知监控：把「这个会话到底在为什么目标干活」显式建模成一棵目标树，把「哪些结构性张力在拖慢它」建模成一棵矛盾树，然后用工具调用的真实轨迹去判定当前活动是否还在服务目标，跑偏就出卡片。

插件以 Cordis 插件形式挂进 dsh profile，服务端跑分析，前端提供树编辑与设置卡。

## 它解决的问题

长会话里模型很容易越走越偏：一开始要做的是 A，十几轮之后在忙 B，而没有任何一处地方记录过 A 还在不在。事后回看，只有一堆工具调用，没有一个可对照的基准。

dsh-metacog 把基准写下来（目标树 + 判据），然后每一步都拿轨迹去对：

- 目标树：L0 根目标 → L1 → …，每个叶子节点带可检查的完成判据（`successCriteria`）和活动对齐规则（`relevantActivities` / `allowedMethods` / `excludedActivities`）
- 矛盾树：区分 core（结构性、不会靠努力消失）与 main（当前最限制进展的那一个），带强度读数和由观测历史推算的趋势
- 漂移判定：活动被分成 `aligned` / `exploratory` / `scope_drift` / `uncertain`，只有 A 级证据才升级成打断卡片
- 周期产出：日报 / 周报 / 月报，只陈述事实——动了哪些目录、产生了哪些文件、各自占多少时间，不给建议

## 工具

服务端注册 20 个工具：

| 分组 | 工具 |
|---|---|
| 目标树 | `goal_tree_init` `goal_tree_confirm` `goal_tree_view` `goal_tree_edit` `generate_report` |
| 矛盾树 | `contradiction_observe` `contradiction_tree_edit` |
| 判定 | `check_drift` `resolve_intervention` |
| 计划 | `metacog_declare_plan` `metacog_revise_plan` |
| 其他 | `metacog_scan` `metacog_draft_criteria` `metacog_merge_tree` `metacog_revise` `metacog_archive` `metacog_archive_milestone` `metacog_purge` `metacog_read_document` `metacog_ask_user` |

另有 Web 端 HTTP 端点（`metacog/tree`、`metacog/settings`、`metacog/reports`、`metacog/verdicts` 等 17 个），以及一个手写的 Web 设置卡 `client.js`。

## 安装

插件未发布到 npm registry，按本地目录挂载：

```bash
git clone https://github.com/<your-account>/dsh-metacog.git
cd dsh-metacog
npm install
npm run build
```

然后在 dsh profile（如 `~/.dsh/profiles/desktop/`）下，把包目录挂进 `node_modules`，并在 `cordis.patch.yml` 里插入挂载行：

```yaml
- insert:
    - id: dsh-metacog
      name: dsh-metacog
```

Windows 下用目录 junction 比复制更省事：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-metacog" `
  -Target "D:\path\to\dsh-metacog"
```

重启 dsh 后生效。

## 配置

运行时配置写在 `~/.dsh/cordis.patch.yml` 中该插件条目的 `config` 下，常用的几项：

```yaml
- id: dsh-metacog
  name: dsh-metacog
  config:
    schedule:
      checkIntervalMinutes: 60
    thresholds:
      windowMinutes: 120
      repeatThreshold: 3
      minConfidence: 0.6
      highIntensityThreshold: 4
      staleDaysThreshold: 7
```

设置卡也可写入 `~/.dsh/metacog-overrides.yml`；两处等价，改完都需重启生效。

## 数据落在哪

每个项目的数据写在 `<project>/.metacog/` 下：`activities/`（活动流）、`signals/`（判定信号）、`audit/`（哈希链审计，append-only）、`snapshots/`（目标树快照）、`reports/`、`state/`。

跨工作区的汇总报告在 `~/.dsh/metacog-global/`。项目注册表在 `~/.dsh/metacog-projects.json`。

这些都是运行时数据，不随源码分发；`.metacog/` 已在 `.gitignore` 中排除。

## 开发

```bash
npm run build        # tsc 编译 src/ → lib/
npm run check:fresh  # 校验构建产物是否落后于源码
npm test             # 单元测试
npm run test:all     # 全量测试（含验收、集成、行为追踪）
```

源码在 `src/`（60 个文件，纯 ESM TypeScript），编译产物在 `lib/`。`client.js` 是手写 JS，不经构建。

设计文档在 `docs/`，入口是 `docs/architecture.md`：

| 文件 | 内容 |
|---|---|
| `architecture.md` | 架构设计，当前实现依据 |
| `design-goal-contradiction.md` | 目标树与矛盾树的识别规则 |
| `session-protocol.md` | 会话协议层 |
| `plugin-contract.md` | Cordis 依赖声明语义 |
| `known-issues.md` | 已知缺陷，刻意暂不修复 |

## 已知限制

- 插件写的是 Cordis 插件契约，不是通用 npm 中间件；离开 dsh 宿主跑不起来
- `src/evidence/pdf.ts` 需要外部 `python`（或 `python3`）加 `pypdf`，缺了只影响 PDF 证据抽取
- `package.json` 标了 `private: true`，这是刻意的，避免误发布
- 目前没有发布版本号语义；`0.1.0` 是初始版本

## 许可

尚未指定许可证。在补上之前请按「保留所有权利」对待。
