# 实测：工具集能否动态改，以及改一次对提示缓存的代价

- 任务：E1 / task-12
- 日期：2026-10-31
- 对象：`D:\APP\deepseek harness\resources\app.asar`（182 MB，只读解析）+ 本机会话日志
- 约束：未改 `metacog/src/`、未改 `package.json`、未 commit；临时脚本在 `_probe/`，用后清理

## 结论摘要

1. **Q1：能动态改。** `tools.restrict({allow})` 不是建时一次性设定：它把一条 restriction 追加到当前 agent 的 layer（`dsh-tools/lib/index.js:2991-3005`），立即生效并返回 disposer；可重复调用，多次限制取交集。
2. **`setup` 只在 create / 带 setup 的 resume 跑一次**（`dsh-agent-loop/lib/index.js:1909`、`:1931`、`:2012`），不是每轮。metacog 的 `applyMetacogScope` 就在这个 setup 里（`metacog/src/session.ts:455`）。
3. **中途改在现有类型下也可行**：setup 拿到的 `HostAgentScope` 是活对象，把它（或 `scope.get('tools')`）存下来，之后随时调 `restrict` 即可；不需要宿主新增 API。代价是要自己管理 disposer（交集语义，加工具必须先撤旧限制）。
4. **限制不持久化**：它是 ctx effect；agent 销毁/重建后消失。metacog 的恢复路径 `agents.resume({ resumeSessionId })` 不带 setup（`session.ts:539`），所以**恢复/重启后的会话没有白名单**。当前白名单只在「本进程 create 的那个 agent 实例」上有效。
5. **Q2：DSH 核心没有客户端 prompt cache**，缓存是 provider 侧的前缀缓存；工具 schema 是请求前缀的一部分。实测 7 次工具集中途变更：变更后第一条请求的 `cacheReadTokens` 只剩变更前的 **0.45%–16.7%**（5/7 次 <8%），未缓存输入跳到接近整个 prompt；下一条请求才重建缓存。
6. **一句话**：收窄工具集本身成本很低（开局 restrict 一次即可，还能减少每轮 schema token）；贵的是「中途改」——一次增删 ≈ 一次全量 prompt 的未缓存 prefill。

---

## 方法与证据来源

asar 在本机没有挂载成目录（runtime 里的 `app.asar\dsh\` 不是真实目录），所以写了一个只读 parser（`_probe/asar.mjs`）：按 asar header 解析出 18188 个文件，抽取核心包到 `_probe/asar/` 后阅读。本文所有 `dsh-*/lib/index.js:NNN` 均指这个安装包里的编译产物（asar mtime 2026-10-25）。

会话日志是多帧 zstd（一帧一批事件），Node 的 `zstdDecompressSync` 只解第一帧，所以按 magic 切帧逐段解压（`_probe/read-session-usage.mjs`）。日志里可直接读到三类证据：

- `request/header`：本次请求的 `config` 与**完整 tools schema**（`data.header.tools`）；
- `developer/message`，`data.message.source.kind === "tool-registry"`：`tool-addition` / `tool-removal` 清单；
- `assistant/message.data.usage`：`inputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `totalTokens`。

注意 `inputTokens` 是**未缓存**输入：`totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`（`dsh-llm-deepseek/lib/index.js:2017`）。

观测样本：

- `session-f90fdf5e-67eb-4ee0-ad41-31d012c655cc`：metacog 插件热重载，13 个工具整体移除后又加回，另有多次单工具/多工具增删；
- `session-7eaf8491-1a26-4f08-81d7-8661841908f2`：中途移除 1 个工具（`session_title_admin`）。

---

## Q1：工具集能否在同一 agent 生命周期内动态改

### 1.1 `restrict` 的实现语义

`dsh-tools/lib/index.js:2991-3005`：

```js
restrict(filter) {
  const scope = scopeOf(this.ctx);
  if (scope === void 0) throw new Error("tools.restrict() requires a scoped context (agent.ctx) ...");
  if (allow === void 0 && deny === void 0) throw new Error("tools.restrict({}) is a no-op ...");
  const compiled = { ...allow !== void 0 ? { allow: new Set(allow) } : {}, ...deny !== void 0 ? { deny: new Set(deny) } : {} };
  ...
  return this.layers.effect(this.ctx, (layer) => layer.restrictions.append(compiled), { label: "tools.restrict()" });
}
```

- 它**不是**在 agent 创建时把工具集算成一份快照，而是把一条 restriction 追加进当前 scope 的 layer；
- `layers.effect` 是 Cordis effect：立即执行 action、返回 disposer、默认触发 `tools/change`（`dsh-scope/lib/index.js:189-216`）；
- 限制在**读取时**才参与计算：`view(scope)` 每次沿 layer 链重算（`dsh-tools:3055-3080`），`schemas(scope)` 每次调 `view`（`dsh-tools:3119-3120`）；
- 工具 provider 挂在 systemPrompt 上：`ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope))`（`dsh-tools:2802`），而 `systemPrompt.assemble()` 在**每个 preStep** 调用（`dsh-agent-loop:907`）。

因此：**在两步之间调 `restrict`，下一步的请求装配就会用新工具集**。不需要重建 agent。

### 1.2 `setup` 的调用时机

- create：`dsh-agent-loop:1909` → `setupAndPublish(..., options.setup, ...)`；
- setup 执行点：`:1931` `(await raceAbort(setup?.(prepared.agent.ctx, prepared.agent), ...))?.commit()`；
- resume：`:2012` 同样把 `options.setup` 传进 `setupAndPublish`；
- 每轮/每步只调用 `systemPrompt.assemble`，**不调用 setup**。

metacog 侧：`session.ts:454-455` 在 `agents.create({ setup })` 里调 `applyMetacogScope(scope, knownTools)`；`host.ts:442-446` 的文档也写明 setup "Runs once ... before its first turn"。

### 1.3 中途改的三条路径与限制

1. **保留 setup 里的 scope（现有类型下可行）**：`HostAgentScope` 是活对象，setup 回调里把它存进 `Map<sessionId, HostAgentScope>`，之后 `scope.get('tools')?.restrict({ allow: [...] })`。`restrict` 返回的 disposer 要一起存，用来撤销旧限制。
2. **从 `agent.ctx` 直接调（需要类型放宽）**：真实 DSH agent 有 `ctx`（`dsh-agent-loop:757/779`；`dsh-tools:1493` 里就用了 `agent.ctx.effect(...)`），但 metacog 的 `HostAgent` 只声明了 `id/session/followup`（`host.ts:58-80`），没有 `ctx`。这条路要 cast 或扩类型。
3. **重建 agent**：dispose 当前 agent 再 resume（resume 可带 setup），但会打断当前轮，不适合作为中途改工具集的常规手段。

限制：

- **交集语义**：`view()` 用 `layers.every((layer) => layer.admits(name))`，`admits` 对 `allow`/`deny` 取反。先 `allow` 10 个、再 `allow` 11 个**不会**放宽——第二条 allow 里没有前 10 个，结果反而更窄。要加工具必须先 dispose 旧限制再重设。
- **只管继承来的工具**：`view()` 对 agent 自己 layer 注册的工具不走 restriction（own 分支），所以只限制全局/祖先工具。
- **未知名字直接 throw**（`dsh-tools:3004`），所以白名单要先与 `knownNames` 求交。
- **scope 生命周期**：scope 属于当前 agent ctx；agent 销毁后不可再用。

### 1.4 resume / 重启后限制是否保留

不保留。restriction 是 `ctx.effect`，agent ctx 销毁即撤销；resume 会建新的 ctx。resume **可以**带 setup（`dsh-agent-loop:2012`），但 metacog 的恢复路径没有带：

```ts
// metacog/src/session.ts:539
const handle = await agents.resume({ resumeSessionId: sessionId })
```

应用重启时，宿主从配置恢复会话，配置里也不可能序列化 setup 函数。结论：**当前白名单是「进程内、agent 实例级」的，不是「会话级」的**；同一进程内跨轮有效，跨 resume/重启失效（退化成全量工具，fail-open）。

### 1.5 有没有 `unrestrict` / `reset`

没有单独的方法；`restrict` 返回的 disposer 就是撤销机制（`dsh-scope:211-215` 的 `undo()` 删除该条 entry 并 `onChange`）。需要「放宽」时：dispose 旧 restriction → 用新 allow 重新 restrict。

### 1.6 边界：空 allow 是 fail-open

按当前 asar 的实现，`restrict({ allow: [] })` **不会**被拒：入口只拒绝 `{}`（`allow`/`deny` 都 undefined，`dsh-tools:2996`），`append` 也不校验空集合（`dsh-scope:98`）。也就是说注册表本身可以做到「一个工具都不给」。

但 metacog 在交集为空时**跳过** restrict：

```ts
// metacog/src/protocol.ts:170-180
} else if (allowed.length === 0) {
  // An empty allow list is rejected by the registry, and it would hide every tool anyway
  problems.push('no metacog tool is registered globally; the whitelist was not applied ...')
}
```

注释里的「rejected by the registry」与这个 build 的实现不符。实际行为是 **fail-open**：白名单一个都没匹配上时，会话拿到全量工具，而不是零工具。如果「收窄工具集」要当安全边界用，这里应改成 fail-closed（显式 `restrict({ allow: [] })` 或直接拒绝建会话）。

---

## Q2：改工具集对提示缓存的实际代价

### 2.1 DSH 层有没有缓存

- `dsh-llm` 核心没有 prompt cache：没有 `cache_control`、没有 `prompt_cache_key`；`dsh-session-projection-cache` 是会话投影缓存，与提示无关。
- 缓存完全在 provider 侧；DSH 只负责把 usage 记下来：`dsh-llm-deepseek/lib/index.js:1837-1838` 把 `cache_read_input_tokens` / `cache_creation_input_tokens` 映射为 `cacheReadTokens` / `cacheWriteTokens`，`TokenUsage` 类型在 `dsh-llm` 的 typert 里。
- 本次样本实际使用的 provider 是 `dsh-opencode-go`（profile 插件，Anthropic-messages 风格）。它会显式打断点：最后一个 tool 加 `cache_control`（`dsh-opencode-go/lib/index.js:26128`），最后一条消息块也加（`:26038`）。所以工具列表本身就是缓存前缀的一部分。

### 2.2 tools 在请求里的位置

- `buildRequest` 把 `tools` 放进 `request/header` 与请求体（`dsh-agent-loop:1220`、`:1225-1240`；`dsh-llm-deepseek:1736-1741` 序列化为顶层 `tools` 数组）。
- 工具集变化时：`toolsChanged()`（`dsh-agent-loop:929-936`）→ `startsSeries`（`:1059`）→ 记一条新的 `request/header`（reason=change）+ 一条 `developer/message`（tool-addition / tool-removal，`:1242-1257`），同时 `project()` 原位替换 system 消息（`:272`）。
- 所以「改工具集」不是只改一个数组：它同时开启新的 request series、重写 system 消息、移动 tools 缓存断点。

### 2.3 实测：7 次工具集中途变更

同一会话内前后两步即自身对照（`input` 为未缓存输入，`cacheRead` 为缓存命中）：

| # | 会话 | 变更（seq） | 变更前一步 | 变更后第一步 | 缓存保留率 | 额外未缓存 token |
|---|------|------------|-----------|-------------|-----------|------------------|
| 1 | 7eaf | -1 工具 `session_title_admin` @168 | 161: cacheRead 99,840 / input 1,600 / total 103,676 | 169: 7,680 / 95,240 / 104,651 | **7.7%** | ≈93,640 |
| 2 | f90f | -13 工具 @15630 | 15624: 369,152 / 134 / 369,334 | 15632: 1,664 / 362,650 / 364,780 | **0.45%** | ≈362,516 |
| 3 | f90f | +13 工具 @15845 | 15839: 376,960 / 323 / 377,330 | 15847: 9,728 / 372,574 / 382,326 | **2.6%** | ≈372,251 |
| 4 | f90f | +1 工具 @17250 | 17244: 545,280 / 505 / 545,867 | 17252: 7,040 / 539,694 / 546,830 | **1.3%** | ≈539,189 |
| 5 | f90f | +2 工具 @23025 | 23017: 261,376 / 808 / 262,538 | 23027: 43,648 / 219,694 / 263,618 | **16.7%** | ≈218,886 |
| 6 | f90f | +3 -1 @27022 | 27012: 543,488 / 558 / 544,625 | 27025: 43,520 / 501,542 / 545,238 | **8.0%** | ≈500,984 |
| 7 | f90f | +19 工具 @30658 | 30645: 166,784 / 547 / 167,956 | 30660: 7,808 / 167,963 / 177,189 | **4.7%** | ≈167,416 |

补充：

- 变更后第二步通常已重建缓存（如 #2 的 15639：364,416；#3 的 15852：382,208；#4 的 17259：546,816）；#6 因为紧接着又有一次 series 切换，第二步仍只有 43,648，第三步才回到 545,024。
- `total` 的变化很小（多数 <2%），说明这不是「多发了内容」，而是同一份 prompt 从「缓存价」变成「未缓存价」重新计费。唯一例外是工具 schema 本身的 token 增减（如 #2 移除 13 个工具后 total 少 4,554；#3 加回后多 4,996）。
- 样本 provider 为 `dsh-opencode-go` / `deepseek-v4.1-flash`，上下文 10 万–55 万 token 量级。

### 2.4 代价换算

- 一次工具集变更 ≈ **一次全量 prompt 的未缓存 prefill**：83%–99.5% 的缓存前缀失效（5/7 次 >92%），下一请求按未缓存输入计费；随后 1–2 步重建。
- 如果会话上下文是 50 万 token，一次中途改工具 ≈ 50 万 token 的未缓存输入；按常见 cache-read 折扣（约 1/10 输入价）算，相当于多付约 9 倍于「缓存命中」的输入成本。具体金额取决于 provider 单价，这里只给 token 事实。
- 反过来，**开局就收窄**没有这笔成本：前缀在会话内稳定，缓存正常命中；工具 schema 变少还会让每个请求的前缀略小。收窄本身是省 token 的，不是费 token 的。

### 2.5 局限（哪些是实测、哪些是推断）

- **实测**：7 次真实工具集变更前后同会话的 usage 计数；`request/header` 里的 tools 清单；`tool-addition`/`tool-removal` 事件。
- **不是人为 A/B**：没有向活 agent 注入 `restrict` 做对照（只读范围，且没有宿主内探针入口），用的是真实会话里自然发生的变更。每条变更前后都在同一会话、同一 provider、同一上下文，自身即对照；但没有随机化。
- **无法完全隔离「工具变化」与「新 series + system 消息重写」**：三者由同一个 registry 变化触发，从请求角度看是同一个事件，实际成本也是同一笔。若要隔离，需要宿主提供「只换 tools、不动 series」的开关。
- **provider 相关性**：断点行为来自 `dsh-opencode-go`（Anthropic-messages）；其他 provider 的缓存粒度可能不同。DSH 侧「tools 在请求里、usage 有 cacheRead」是 provider 无关的。

---

## 一句话回答

**给会话收窄工具集，实现成本低（开局 `restrict` 一次即可，现有 setup 已具备）；缓存代价在「中途改」时才大：实测一次工具增删会让下一请求的缓存命中掉 83%–99.5%，相当于把整个 prompt 按未缓存价重新计费一次。开局定死则没有这笔开销。**

## 推荐的调用时机与节奏

1. **开局定（推荐）**：在 `CreateAgentOptions.setup` 里一次 `restrict({ allow })`，整个会话保持不变。这是当前 metacog 已经采用的模式，缓存零额外成本。
2. **阶段切换（可接受，但要批量）**：如果任务确实从「诊断」进入「修复」需要换工具，在**一个边界**上一次性增删完，不要每轮调。预期付一次全量 prefill（按上下文大小 10 万–50 万 token 量级）。
3. **中途逐轮增删（不推荐）**：每次变更都接近一次全量 prefill，连续两步 miss 也出现过（#6）。
4. **resume/重启**：当前白名单不会自动重建。若依赖它，恢复时需要重新 setup（宿主需支持在 resume 路径注入 setup），否则会话回到全量工具。建议把这条当已知缺陷单独立项。
5. **空交集**：当前 fail-open（白名单全不匹配 → 不限制）。若收窄要当边界，改成 fail-closed。

## 复现

```powershell
# 1) 列/取 asar 内文件（只读）
node _probe\asar.mjs list '^dsh/node_modules/@deepseek-ai/dsh-tools/'
node _probe\asar.mjs extract 'dsh/node_modules/@deepseek-ai/dsh-tools' '_probe/asar/dsh-tools'

# 2) 解会话日志、看 usage/cache
node _probe\read-session-usage.mjs <session.v4.jsonl.zstd> 20

# 3) 扫出所有「工具集中途变化」的会话
node _probe\scan-toolset-cache.mjs 'C:\Users\30759\.dsh\sessions' 260

# 4) 看某个变化点前后的 usage
node _probe\usage-window.mjs <session.v4.jsonl.zstd> 15600 15660
```

> 按任务要求，`_probe/` 下的探查脚本与 asar 抽取物已清理到回收站；上面的命令保留，便于需要时按报告描述重建（脚本逻辑都很短，核心是 asar header 解析与多帧 zstd 切帧）。

样本日志：

- `C:\Users\30759\.dsh\sessions\--D-~6587~6863-dsh~4E34~65F6~5DE5~4F5C~533A--\session-f90fdf5e-67eb-4ee0-ad41-31d012c655cc\session.v4.jsonl.zstd`
- `C:\Users\30759\.dsh\sessions\--D-~6587~6863-dsh~4E34~65F6~5DE5~4F5C~533A--\session-7eaf8491-1a26-4f08-81d7-8661841908f2\session.v4.jsonl.zstd`

## 证据索引

宿主（`app.asar/dsh/node_modules/@deepseek-ai/`）：

- `dsh-tools/lib/index.js:2974` `register()`；`:2991-3005` `restrict()`；`:3055` `view()`；`:3119` `schemas()`；`:2802` `systemPrompt.tools(...)`；`:2783` `tools/change`。
- `dsh-scope/lib/index.js:189-216` `ScopedLayers.effect()`（立即执行、disposer、onChange）；`:98` `append()`（不校验空集合）。
- `dsh-agent-loop/lib/index.js:907` 每步 `systemPrompt.assemble`；`:929-936` `toolsChanged`；`:1059` `startsSeries`；`:1220` tools 进请求；`:1225-1257` header 记录与 tool-addition/removal；`:1909/1931/2012` setup 调用点。
- `dsh-system-prompt/lib/index.js:299-301` `tools(provider)`；`:356` `assemble()`；`:87` `orderTools`。
- `dsh-llm-deepseek/lib/index.js:1736-1741` tools 序列化；`:1837-1838` cache usage 映射；`:2017` totalTokens 组成。
- `dsh-token-meter/lib/index.js:321-330` cacheRead/cacheWrite 汇总。

metacog：

- `src/session.ts:455` setup 内 `applyMetacogScope`；`:539` `agents.resume` 不带 setup。
- `src/host.ts:409` `restrict(): Disposer`；`:442-446` setup "Runs once"；`:58-80` `HostAgent` 无 `ctx`。
- `src/protocol.ts:170-180` 空交集跳过 restrict；`:182` 调用 `restrict({ allow: allowed })`。

provider（profile 插件）：

- `dsh-opencode-go/lib/index.js:26128` 最后一个 tool 加 `cache_control`；`:26038` 最后一条消息块加断点；`:25416-25419` cache usage 解析。
