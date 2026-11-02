# Stage F：周期调度与卸载清理

验证结果：`node test/stage-f.test.mjs` → 29 passed, 0 failed。

## 核验结论

recurring 原语是 `ctx.timer.interval(callback, delay)`，返回 disposer，绑定插件 fiber。

排除的两个候选：

- `ctx.jobs` 的 `JobKindMap` 只有 `'bash'`，每个 job 需要 owner 和 attached controller，语义是「一次性后台命令的输出环形缓冲」，不是周期脉冲。
- `ctx.schedule` 确实按计划触发，但语义是「向某个 Session 投递提醒消息」，会唤醒会话。对监控插件太侵入，所以不用它做周期巡检。早先为此留过一个 `schedule.persistentReminders` 开关，但那条推送路径从未实现，该配置项已删除。

## 实现

`src/schedule.ts`，`installScheduler(options)` 返回 `{ stats, dispose, sweep }`。

`schedule.enabled: false` 时**不创建定时器**，连惰性的都不建——这样「没建定时器」是事实，而不是「建了一个不干活的」。

首跑在一次 interval 之后，不是 t=0：挂载本身不是证据，此刻没有可检查的东西。

## 关键设计判断

### tick 是 Grade C，结构上无法开卡

定时触发没有会话上下文。`runStaticCheck` 传 `mayEscalate: false`，所以 tick 只能记录信号和提示，永远不能开 Level 2/3 卡片。测试 F5 连打四次 tick 断言 `interventions.length === 0`。

### 一个项目失败不影响其余

每个项目独立 `try`，失败记 `warn` 继续下一个。定时器回调抛错会被 runtime 取消，所以异常绝不能穿出去。

### 项目注册的两条路径

`monitored` 注册表由两处填充：事件 feed 首次解析到项目，以及任何工具解析到项目（在 `registerProject` 中包装 `execute` 完成）。后者保证 `goal_tree_confirm` 确认过的项目即使之后再无事件也会被监控。

注册表每次挂载重建，不持久化——活项目的集合是运行时事实，不是状态。

### 修掉的一个真 bug

`runStaticCheck` 原本要求 `sessionId: string`，定时器传空字符串，被 `SignalSchema` 的 `min(1)` 拒绝，导致每次 tick 都静默失败（只留一条 warn）。现在签名改为 `string | undefined`，`persistDrafts` 对空串也视同无会话、省略该字段。

这个 bug 只有在真实 tick 里才暴露：单元测试都带 sessionId，永远走不到这条路。

## 测试覆盖

| 用例 | 覆盖 | 结果 |
| :--- | :--- | :--- |
| F1 | 按配置间隔安装定时器 | 通过 |
| F2 | `enabled: false` 不创建定时器 | 通过 |
| F3 | 宿主无 timer 服务仍能挂载并如实上报 | 通过 |
| F4 | tick 只做静态检查，不虚构活动 | 通过 |
| F5 | tick 不开卡 | 通过 |
| F6 | disposer 清除定时器且不再触发 | 通过 |
| F7 | disposer 幂等 | 通过 |
| F8 | 无已确认项目时 idle 而非报错 | 通过 |
| F9 | tick 能检测出陈旧目标 | 通过 |
| F10 | 即使 `repeatThreshold: 1` 也不开卡 | 通过 |
| F11 | 间隔可配置 | 通过 |
| F12 | 能力边界如实上报 | 通过 |
| F13 | 多挂载各自独立定时器 | 通过 |
