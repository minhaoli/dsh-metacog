# 诊断：认知监控会话丢失 `ask_user_question`

调查对象：`D:\文档\dsh临时工作区\metacog`（只读，未改任何 `src/` 文件）
故障现场：`D:\文档\杂活` 工作区，会话 `metacog-mvuzoquz3010v3bp`（2026-10-30 21:09 创建）

---

## 结论摘要

1. **任务前提不成立**：`!hasTree` 分支**确实传了** `knownTools`（`src/index.ts:1191`），源码与编译产物 `lib/index.js:1055` 均已包含该修复。
2. **会话拿到的工具集本身就不对**：该会话实收 27 个工具，缺 `ask_user_question`/`glob`/`grep`/`pwsh`/`skill`/`load_workspace_dependencies`，却多出 18 个**不在白名单里**的工具（`automation_*`、`team_task_*`、`spawn_teammate` 等）。这说明 `restrict` **没有作为白名单生效**，工具缺失发生在更上游。
3. **真正根因（有直接证据）**：缺失是**工作区/注册表级**的，不是 metacog 白名单造成的——同日在 `D:\文档\dsh临时工作区` 的会话（同 provider `xdpool`）有 142–155 个工具且包含 `ask_user_question`，而 `D:\文档\杂活` 的**两个**会话（metacog 会话 + 它的子代理）都缺同一组工具。模型因此只能正文提问。

---

## 逐问回答

### Q1：`startInitialisation` 在 `!hasTree` 分支传没传 `knownTools`？

**传了。** 精确行号 `src/index.ts:1190-1192`：

```ts
1190:        inheritFrom: session,
1191:        knownTools: knownToolNames,
1192:      })
```

`runInitialisation` 的形参声明在 `src/index.ts:1805`（`knownTools?: ReadonlySet<string>`），透传在 `:1821`：

```ts
1821:      ...(input.knownTools === undefined ? {} : { knownTools: input.knownTools }),
```

编译产物 `lib/index.js:1050-1056` 与源码一致，说明已构建。

> **但发现一处真实不一致**：**重建分支**（`hasTree: true` 那条）`src/index.ts:1228-1236` **没有传** `knownTools`。走「保持/重建」路径时会退化成空集合。这不是本次故障路径，但是同一类 bug。

---

### Q2：空集合下 `applyMetacogScope` 会发生什么？`restrict` 被跳过吗？

**会，且是静默降级。** 三段代码：

`src/session.ts:455`（`agents.create({ setup })` 内）：

```ts
455:        const applied = applyMetacogScope(scope, options.knownTools ?? new Set<string>())
```

`src/protocol.ts:155-156`：空集合 ⇒ `allowed = []`。

`src/protocol.ts:158-167`：

```ts
158:  let restricted = false
159:  const tools = scope.get('tools')
160:  if (tools === undefined) {
161:    problems.push('host exposes no tools registry; the whitelist was not applied')
162:  } else if (allowed.length === 0) {
163:    // An empty allow list is rejected by the registry, and it would hide every
164:    // tool anyway — refusing loudly is better than a session that cannot act.
165:    problems.push('no metacog tool is registered globally; the whitelist was not applied')
166:  } else {
167:    try { tools.restrict({ allow: allowed }); restricted = true } ...
```

结论：`allowed.length === 0` ⇒ **`tools.restrict` 被跳过**，`restricted` 保持 `false`，工具**全部保留**（不限制）。

**但这与现场不符**：现场缺了 6 个宿主角工具。所以本次故障**不是**「空集合 ⇒ 跳过 restrict」这条路径。

---

### Q3：若 restrict 被跳过，会话为何还认为自己没有该工具？

**因为它真的没有。** 这不是自我认知问题，是工具列表里确实没有。

**直接证据一** —— 会话日志 `request/header`（`seq:13`）记录宿主实际下发给模型的 27 个工具：

```
automation_create, automation_delete, automation_list, automation_run_now,
automation_runs, automation_update, contradiction_tree_edit, edit,
goal_tree_confirm, goal_tree_edit, goal_tree_init, goal_tree_view,
interrupt_agent, list_agents, metacog_read_document, metacog_revise,
metacog_scan, read, send_message, spawn_teammate, str_replace_editor,
team_task_create, team_task_get, team_task_list, team_task_update,
undo_last_edit, wait_agent
```

`has ask_user_question: false`。

**直接证据二** —— 模型自己在 reasoning（`seq:47`）里记了这件事：

> "Wait — I don't have ask_user_question in my tool list! ... The system prompt mentions `ask_user_question` but the function list doesn't include it."

并在正文里向用户说明「这个会话里没有 `ask_user_question`」，改为正文列问题——即用户看到的现象。

**关键反证（推翻「metacog 白名单裁剪」假设）**：白名单 `METACOG_SESSION_TOOLS` 只有 15 项（`src/protocol.ts:46-60`）。实收 27 项中有 **18 项根本不在白名单内**（`automation_*` 6 个、`team_task_*` 4 个、`spawn_teammate`、`interrupt_agent`、`list_agents`、`wait_agent`、`send_message`、`str_replace_editor`、`undo_last_edit`、`edit`）。若 `restrict({allow})` 正常生效，这些必须被过滤掉。**它们还在 ⇒ `restrict` 没有作为白名单起作用。**

**工作区对照（决定性）**：同一台机器、同一天、同 provider `xdpool/deepseek-v4.1-flash`：

| 时间 | 工作区 | 会话 | 工具数 | `ask_user_question` |
|---|---|---|---|---|
| 10-30 07:31 | dsh临时工作区 | 普通会话 | 142 | ✅ |
| 10-30 13:09 | **杂活** | **metacog 会话** | **27** | ❌ |
| 10-30 13:10 | **杂活** | metacog 的子代理 | 116 | ❌ |
| 10-30 15:19 | dsh临时工作区 | 普通会话 | 154 | ✅ |
| 10-30 15:55 | dsh临时工作区 | 普通会话 | 142 | ✅ |

缺的工具组在**杂活工作区内部一致**（父会话与子代理都缺 `ask_user_question`/`glob`/`grep`/`pwsh`/`skill`），而别的工作区不缺。**缺失与工作区/宿主注册状态相关，与 metacog 的 `restrict` 无关。**

`agents.create` 侧也已核查：`src/session.ts` 中 `inheritFrom` **只用于取 `agentPreset`**（`session.ts:445`）：

```ts
445:  const preset = options.inheritFrom?.header?.agentPreset
...
451:        ...(preset === undefined ? {} : { agentPreset: preset }),
```

**没有**把调用方的工具限制继承过来（无 `parentAgent`、无工具集传递）。该会话 `agentPreset: "standard"`，与普通会话相同，因此 preset 也不是差异来源。

---

### Q4：`tools.schemas()` 的时序与可靠性

**时序：在 `startInitialisation` 之前。** 赋值在插件挂载期同步执行（`src/index.ts:1126-1137`），而 `startInitialisation` 定义在 `:1142`、由斜杠命令在用户触发时才调用。顺序没问题。

**可靠性：无法确认，且这是本次修复的薄弱点。**

- `HostToolScope` 类型**只声明了 `restrict`**（`src/host.ts:408-410`），`schemas` 是靠强制类型转换拿的：
  ```ts
  1126:  const globalSchemas = (tools as unknown as { schemas?: () => { name?: unknown }[] }).schemas
  ```
  即**没有类型保障**，宿主不提供时静默走 `typeof !== 'function'` 分支。
- 一旦 `schemas` 缺失或抛错，`knownToolNames` 只剩 `registeredTools`（`:1125`），而 `registeredTools` 只收集**本插件自己注册的工具**（`:394`、`:428`）。此时所有宿主工具（含 `ask_user_question`）都被判为「不认识」→ 从 `allowed` 里剔除（`protocol.ts:155`）。
- 源码注释 `:1122-1126` 描述的正是这个历史 bug：「Seeding the set from `registeredTools` alone dropped every host tool from the allow list — including `ask_user_question`」。
- **未能验证**：宿主 checkout 在 `app.asar` 归档内（`D:\APP\deepseek harness\resources\app.asar`，182 MB，非目录），无法读取 `tools` 服务实现来确认 `schemas()` 是否存在及其返回时点。

---

### Q5：最小改动建议（**未实施**）

按优先级：

**① 补上重建分支遗漏的 `knownTools`** —— `src/index.ts:1234` 后加一行

```ts
      ...{ model },
      inheritFrom: session,
+     knownTools: knownToolNames,
    })
```

（当前 `:1228-1236` 两个分支行为不一致，重建路径必然退化为空集合 ⇒ 不限制。）

**② 空集合不再静默降级** —— `src/session.ts:455`，把默认值改成显式告警，避免「以为限制了其实没限制」：

```ts
-        const applied = applyMetacogScope(scope, options.knownTools ?? new Set<string>())
+        const known = options.knownTools
+        if (known === undefined) {
+          ctx.logger.warn('[dsh-metacog] session scope: knownTools missing; whitelist cannot be computed')
+        }
+        const applied = applyMetacogScope(scope, known ?? new Set<string>())
+        ctx.logger.info(
+          `[dsh-metacog] session scope: restricted=${applied.restricted} ` +
+            `allowed=${applied.allowed.length} skipped=${applied.skipped.join(',')}`,
+        )
```

**③ 让「被丢弃的工具」可见** —— `src/protocol.ts` 的 `ScopeApplication.skipped` 字段（`:112`）**当前无人消费**：全仓检索 `.skipped` 只命中 `collect.ts`/`gate.ts` 里的同名无关字段。`session.ts:456-458` 只打印 `problems`。上面的 ② 已顺带补上。

**④ 白名单失效时给出可读提问兜底** —— `src/protocol.ts` 的 `METACOG_PROTOCOL` 里硬性要求「用 `ask_user_question`，不要在正文罗列问题」。一旦该工具不可用（本次情形），协议反而把模型逼进死角。建议改为条件式：先探测工具是否可用，不可用时要求输出结构化问题清单并明确告知用户「本会话无弹窗工具」。

> **②③④ 属于防御性改进；真正让 `ask_user_question` 回来的修复在宿主/工作区一侧**（见「不确定项」），不在 metacog 内。

---

## 不确定项（无确凿证据，标注为推测）

1. **【推测】杂活工作区为何缺宿主工具** —— 已证明缺失与工作区相关，但**未找到具体机制**。已排查且**排除**的方向：工作区目录内无 `.dsh`/`AGENTS.md` 类配置（仅有 `.git`、`.metacog`）；`~/.dsh/metacog-projects.json` 只记录一个项目；profiles（desktop/default/headless/web）配置里没有按工作区分工具的逻辑。可能与该工作区会话由另一个 bundle/preset 实例创建有关，**未证实**。
2. **【推测】`tools.restrict` 在本宿主上的实际语义** —— 现场「18 个非白名单工具仍在」说明它没有按 allow-list 硬过滤。可能是 `allow` 只作用于某个子集、或被后续注册覆盖。宿主源码不可读，**无法验证**。
3. **【未核实】`tools.schemas()` 是否存在于当前宿主** —— 见 Q4。若不存在，`knownToolNames` 会退化为仅含 metacog 自有工具，这是**下一个**会踩的坑。
4. **【未能执行】任务板操作** —— 本子代理的可用工具中没有 `team_task_get`/`team_task_update`，**无法领取或结单 task-4**，需由 team lead 代为处理。
5. **【未验证】子代理的 116 工具集** —— 该子代理属于杂活工作区、缺同一组工具，支持「工作区级」结论；但其工具集为何是 116 而非 27，未深究。
