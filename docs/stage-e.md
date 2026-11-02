# Stage E：接入经核验的会话/工具事件监听

验证结果：`node test/stage-e.test.mjs` → 39 passed, 0 failed。回归 A/B/C/D 全绿（40 / 64 / 78 / 108），累计 329。

## 核验依据

订阅的是 `session/event`，契约来自 `cordis_inspect_query`（host `Event.listEvents`，`event: "session/event"`），签名：

```
'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
```

字段级确认了三件事，都影响实现：

- payload 在 `event.data` 下，不在 `event` 顶层。
- `tool/call` 的 `arguments` 是 **JSON 字符串**，需要 `JSON.parse`。
- `user/message` 的 `data` 就是 `UserMessage` 本身（`content` 块数组），不是 `{ message: ... }` 包装。

监听与清理的写法对照了已装插件 `dsh-notify/lib/index.js`（`ctx.on(...)` 返回 disposer，在 `ctx.effect` 里统一释放）。

## 新增模块

`src/collect.ts`：

| 导出 | 职责 |
| :--- | :--- |
| `collectToolCall(sessionId, data)` | 把一次 `tool/call` 变成候选活动，含证据提取与等级判定 |
| `collectUserMessage(sessionId, seq, data)` | 把一条 `user/message` 变成候选活动 |
| `installCollector(options)` | 订阅、串行化、错误兜底，返回 `{ stats, dispose }` |
| `collectorBoundary(available)` | 供核验表与日志使用的能力边界描述 |

`src/config.ts` 新增 `collection: { enabled, summaryMaxChars }`。
`src/index.ts` 在工具注册之后挂载采集器，经 `mount.claim` 收口 disposer。

## 关键设计判断

### 只订阅一个事件，且只观察不拦截

`session/event` 是 post-commit 的 fire-and-forget 广播，host 明确会「记录并吞掉观察者失败」。这意味着两件事：采集器抛错等于静默丢数据，所以每个 handler 都包了 `try`，失败降级为 `warn`；以及采集器改不了任何已提交的东西，这是对的——监控层不该有写权限。

`tool/result` 故意不记录。一次调用已经产生了一条活动，再记录结果会让每个计数翻倍，而升级阈值读的正是这些计数。

### 等级判定按 payload 诚实降级

Grade A 的门槛是「可验证支持」（spec 4.1）。工具调用的参数里出现 artifact 形状的值（`file_path` / `command` / `url` / `commit` 等键，或长度合理的字符串）才算 A，否则是 B。B 的置信度被 `gradeConfidenceCap` 封在 0.5，低于 `minConfidence` 0.6，结构上无法开卡。

用户消息直接判 A：用户亲手描述自己在做什么，spec 4.1 里「用户直接提供的活动描述」就是 Grade A 的定义，消息文本本身即证据。

### 自调用与噪声工具不记录

`goal_tree_view`、`check_drift` 这些插件自己的工具如果被记录，会形成反馈环：读一次目标树看起来就像「推进了所有目标」，漂移计数会被监控器自己填满。`todo_write`、`ask_user_question` 这类也不记录——它们不携带项目信号，记进去只会把真实信号埋掉。

这类事件计入 `stats.ignored` 而不是假装没看见。

### 未确认项目不采集

草稿树的节点 `confirmedByUser: false`，按 spec 2.1 不作为告警依据。此时记录活动只会产生一堆 `uncertain` 行，污染报告要读的统计口径。所以 `storeForSession` 在 `state.confirmed === false` 时返回 `undefined`，事件计入 `skippedUninitialized`。

### 串行化

feed 会在同一个 tick 内投递多个事件，而每次落盘都要读改写文件。用一个 promise 链串行化，既保证记录顺序与 feed 一致，也把并发文件操作限制为 1 条链，而不是 N 条竞争链。

## 顺带修正的一处规格偏差

`mayEscalate` 原本在 `observationPolicy.gradeCStaticOnly === false` 时允许 Grade B 升级到 Level 2/3。spec 4.1 写的是无条件「不得直接触发 Level 2/3 告警」，没有配置空间。Stage E 让 Grade B 数据成为常态（无 artifact 的工具调用都是 B），这个口子必须先堵上，否则阈值会被采样证据撑开。

现在 `mayEscalate` 只认 Grade A，参数保留但不再读配置，注释里写明了为什么不留逃生门。

## 验收覆盖

| 编号 | 覆盖 | 结果 |
| :--- | :--- | :--- |
| E1 | 只订阅 `session/event`，无其他通道 | 通过 |
| E2 | 带 artifact 的工具调用记 Grade A | 通过 |
| E3 | 无 artifact 的工具调用记 Grade B，且不升级 | 通过 |
| E4 | 用户消息记 Grade A，文本作证据 | 通过 |
| E5 | 同一事件投递 4 次只记 1 条 | 通过 |
| E6 | 轮次边界、自调用、噪声工具、过短消息全部忽略 | 通过 |
| E7 | 未确认项目不采集 | 通过 |
| E8 | `collection.enabled: false` 时监听器在位但不动作 | 通过 |
| E9 | 畸形 payload 不抛错进 feed | 通过 |
| E10 | disposer 后监听器移除、不再采集 | 通过 |
| E11 | 白名单活动记 exploratory/aligned，不开卡 | 通过 |
| E12 | 重复偏离活动经采集器升级，最多一张卡 | 通过 |
| E13 | 同项目两会话共享一条项目流 | 通过 |
| E14 | 能力边界如实上报 | 通过 |

## 能力边界

- 工具参数解析失败时证据为空，该条降级为 Grade B 而不是丢弃——调用确实发生了。
- `resolveSessionRoot` 优先用 `session.header.cwd`，回退 `workingDirectory.defaultDirectory`。live 的 `workingDirectory.get(session)` 需要 session 句柄，而 feed 不保留句柄，所以采集路径用不到它；工具路径仍然可用。
- 卸载时不 await 在途链：`dispose` 按宿主契约是同步的，在途任务持有的文件句柄会自行关闭，丢引用即可阻止新工作入队。
