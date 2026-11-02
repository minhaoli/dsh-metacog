# 重启后验证清单

本文档是给"重启 DSH 之后要做的事"的清单，不是设计文档。设计见 `monitoring-design-v4.md`。

## 当前状态（2026-10-29 22:40 实测）

采集层的两条链路都已打通，四个信号都有数据源：

| 项 | 状态 | 证据 |
| :--- | :--- | :--- |
| `toolNames` 序列 | 已通 | 单条 turn 最多记到 37 次工具调用 |
| `toolResults` | 已通 | 实测 `tools=5 results=5`，结果按 callId 正确配对 |
| S3 工具越界 | 有输入 | 声明 allowedTools 后 coverage 从 0.5 升到 0.75 |
| S2 类别分布 | 有输入 | coverage 出现 0.5，说明它独立贡献过 |
| S4 计划匹配 | 有代码无数据 | 还没有会话声明过带 steps 的计划 |
| S5 推进真实性 | 有输入 | 实测算出 0.8（5 步中 1 步有 tests-pass） |

**不需要再为采集层重启了。** 剩下的问题是样本量，不是代码。

## 踩过的坑，别再踩

### 事件结构不对称

`tool/call` 有 `name`，`tool/result` 没有。result 的结果在 `message.content`，工具名要用 `message.source.callId` 反查。

任何在 `tool/result` 上读 `data.name` 的代码会静默丢弃事件——不报错，只是计数 +1。

### 测试用自己构造的 payload 等于没测

早先的测试构造 `{ name, content }`，与被测代码共享同一个错误假设，所以全绿而链路是断的。现在的 `test/tool-result-shape.test.mjs` 照抄 host 的真实字段布局。

### 界面刷新不重载后端

点刷新只重建前端 DOM，Node 侧的 ESM 模块仍在内存里。必须完全退出应用。判断方法：

```powershell
Get-Process -Name node | Select-Object Id, StartTime
```

启动时间必须晚于 `lib/\*.js` 的修改时间。

### asar 可以直接读

找不到类型定义时，别猜 payload 长什么样。`app.asar` 是可解析的：

```js
const buf = readFileSync(asarPath)
const jsonSize = buf.readUInt32LE(12)
const index = JSON.parse(buf.subarray(16, 16 + jsonSize))
// 文件内容偏移 = 16 + jsonSize（4 字节对齐）+ entry.offset
```

这次就是靠它从 `dsh-agent-loop` 里读到真实的事件结构，纠正了两次错误的重启猜测。

## 重启后第一步：确认采集器真的在工作

```powershell
cd 'D:\文档\dsh临时工作区\metacog'
node scripts\validate-on-own-stream.mjs
```

判断标准：

| 输出 | 含义 |
| :--- | :--- |
| `STOP` + "所有记录都早于采集改造" | 采集器没生效，或还没产生新活动。先随便做一次带工具调用的操作再看 |
| 有记录但 `toolNames` 全空 | 采集器在跑但没记到工具名——这是 bug，要查 `installCollector` 的 `tool/call` 分支 |
| 有 `toolNames` | 正常 |

这个脚本在数据不足时**明确 STOP 而不打印一排零**。原因是"零结果"与"监控正常工作且未发现异常"在输出上完全一样，后者会让人误以为系统在正常工作。

## 第二步：声明一个计划，让信号有输入

没有 `allowedTools` 时：

- S3 恒为 `not_applicable`
- S2 不报 absence（它不依赖计划），但不声明白名单的实际代价是**丢掉整整一类漂移的检出能力**——"反复使用同一个不该用的工具"这一类，S2 结构上抓不到（它测的是类别分布，而连续做同一件事恰是分布最稳定的情形）
- 实测 `coverage = 0.5`（不是 0.25），`final = 0.0000`

调用 `metacog_declare_plan`，至少给 `allowedTools`：

```
goal: "给 DSH 加元认知监控"
allowedTools: ["read", "edit", "write", "pwsh", "grep", "glob", ...]
```

`steps` 可给可不给。给了就要给每个步骤至少一条 `expects`，因为 `expects: {}` 永不判定完成。

## 第三步：跑一次报告，看成就小节是否在最前

```
generate_report(type: "daily")
```

期望：第一个二级标题是 `## 本期完成`。

如果它不在最前面，是 `report.ts` 的块顺序问题，不是数据问题。

## 第四步：观察 S3/S2/S5 在真实数据上的行为

这一步**没有自动化验收标准**，因为基准测不出来（见下）。

需要人工看的：

- S3 是否把正常操作报成越界。如果误报率高，先检查 `allowedTools` 是否漏了常用工具——漏一个就报一个
- S2 的 `classHistory` 是内存态，重启即清，所以重启后前 6 步 `MIN_HISTORY_STEPS` 内 S2 是 absence，这是设计如此
- S5 依赖 `tool/result` 解析。如果工具返回的内容格式与预期不符（比如 `pytest` 输出被截断），`classifyOutcome` 可能判不出 `tests-pass`。已知词表在 `collect.ts` 的 `classifyOutcome`

## 关于基准验证的结论（不要重做）

`scripts/validate-s3.mjs` 在 2288 样本 / 16065 步上报出 P 0.827 / R 0.904 / F1 0.864，与基准自报的 tight-scope 0.843 同量级。

但 `scripts/validate-s3-control.mjs` 推翻了它的意义：

| 预测器 | F1 |
| :--- | ---: |
| 我们的 S3 | 0.864 |
| **「步数 ≥ 4 就当漂移」（一无所知）** | **0.900** |
| 随机 | 0.363 |
| 全判漂移 | 0.521 |

一个什么都不知道的预测器比我们的还高。原因是基准的 schema 不变量 `drift_step >= 4` 加上"漂移持续到结束"，使"步数≥4"正好命中且零漏报。

**结论：这批标签测不出 S3 有没有用，只能测出实现没写错。**

所以任何在这个基准上报出的 F1，必须同时报出那个平凡基线的分数。只在报告里写 0.864 而不写 0.900 是在误导读者。

## 已知未完成项

| 项 | 状态 |
| :--- | :--- |
| `pathGlob` 期望评估 | 只能对 `toolNames` 生效，采集层没记工具参数里的路径 |
| 独立的 `achievement` 流 | 不做，成就由树时间戳派生（两份记录会不一致） |
| 小时级时间占比 | 做不到，采集层无耗时字段。`share` 是活动条数占比 |
| S1 兜底通道 | 代码已实现，但真实场景下还没触发过（需要三维度全不可用） |
| 校准 | 无正类样本，见设计文档六点五节 |

## 测试

```powershell
cd 'D:\文档\dsh临时工作区\metacog'
npm run build
npm test
```

当前 427 项全通过。分模块：

| 文件 | 项数 | 测什么 |
| :--- | ---: | :--- |
| `signals-contract` | 28 | 契约算术（覆盖度五值、EMA 曲线、分级门槛） |
| `signals-impl` | 31 | S3/S2/S5 实现 |
| `plan-match` | 27 | S4 glob 语义与 expects 匹配 |
| `pipeline` | 16 | scoreTurn 端到端 |
| `achievements` | 21 | 成就、urg、陷入细节（含三条负例） |
| `report-achievements` | 12 | 报告块顺序与内容 |
| 其余 | 292 | 既有功能回归 |
