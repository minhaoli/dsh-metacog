# Cordis 依赖声明语义（实测）

验证日期：2026-10-27
验证方式：读 asar 内 `@deepseek-ai/cordis/lib/index.js` 实现 + 真实挂载日志

记录这份文档是因为这里有一个**反直觉且会致命**的语义，我已踩过一次。

---

## 一、`inject` 是硬门控，不是声明

```js
// Fiber._refresh()
_refresh() {
  let epoch = '';
  for (const name of Object.keys(this.inject)) {
    const impl = this._store[name];
    if (!impl) { epoch = INACTIVE; break; }   // ← 任一缺失，整插件不运行
    epoch += ':' + impl.fiber.uid;
  }
  this._setEpoch(epoch);
}

_setEpoch(epoch) {
  const oldEpoch = this._runner.epoch;
  if (epoch === oldEpoch) return;
  this._runner.epoch = epoch;
  if (this.inertia) return;
  this._updateState(() => {
    if (epoch !== INACTIVE && oldEpoch === INACTIVE) {
      this.inertia = this._reload();          // 全部就绪 → 加载
      return 1;
    }
    this.inertia = this._unload();            // 任一缺失 → 卸载
    return 5;
  });
}
```

**结论**：`inject` 里列出的每一项都是**强制依赖**。
命中任何一个缺失（`_store[name]` 为空），插件整体进入 INACTIVE 状态、`apply` 根本不执行。

所以 `inject` **不是**"我会用这些服务"的清单，
而是"**这些服务缺一个我就不工作**"的清单。

### 实际后果

我曾把 `subagents`、`agents`、`systemPrompt` 等 6 个可选服务加进 `inject`，
期望它们"可选"。实际效果会是：在任何不提供 `subagents` 的部署上
（headless、精简 profile、旧版本），插件**完全消失**，连工具都不注册。

这已回退。当前 `inject = ['tools']`，只有 `tools` 是硬依赖。

---

## 二、`ctx.get()` 不检查 `inject`，缺失时返回 `undefined`

```js
get(name, strict = true) {
  return getTraceable(this.ctx, this._getImpl(name, strict)?.value);
}

_getImpl(name, strict = true) {
  const key = this.ctx[symbols.isolate][name];
  const impl = key && this.store[key];
  if (!impl) return;                              // 未提供 → undefined
  if (strict && impl.fiber.state !== 2) return;   // 未就绪 → undefined
  return impl;
}
```

`get` 只查 `store`，**不读 `inject`**。服务不存在时返回 `undefined`，不抛错。

这正是可选依赖探测该走的路：

```ts
const subagents = ctx.get('subagents')
if (subagents !== undefined) { /* 可用 */ } else { /* 降级 */ }
```

### `strict` 参数的含义

- `strict = true`（默认）：只有 provider fiber 处于 state 2（活跃）时才返回值
- `strict = false`：只要注册过就返回，不论状态

插件侧用默认值即可——拿到未就绪的服务比拿到 `undefined` 更危险。

---

## 三、属性访问 `ctx.xxx` 会抛错

```js
// ReflectService.handler.get
if (Reflect.has(target, prop)) return getTraceable(...);
const error = new Error(`cannot get property "${prop}" without inject`);
// 然后沿 fiber 链找 store，找不到就 throw
```

- `ctx.systemPrompt` —— 若 `systemPrompt` 未被 mixin 到 ctx 上，抛
  `cannot get property "systemPrompt" without inject`
- 即使该属性是某个服务的 accessor，找到后仍可能抛
  `cannot get required service "X" in inactive context`

**所以可选服务必须用 `ctx.get(name)`，绝不能用 `ctx.xxx`。**

这条我在 Stage A 就写进了文档，但 18:54 那次启动仍出现了该错误——
来自一个临时的 `diag-metacog` 诊断 profile（已删除），它的代码版本用了属性访问。

---

## 四、由此确定的三条实现规则

### 规则 1：`inject` 只放真正不能缺的

本插件：`['tools']`。
理由：注册不了工具，监控就没有任何可观测面。

其余全部走 `ctx.get` 探测。

### 规则 2：所有可选服务用 `ctx.get(name)` 探测

```ts
const capabilities = {
  systemPrompt: ctx.get('systemPrompt') !== undefined,
  timer: ctx.get('timer') !== undefined,
  fs: ctx.get('fs') !== undefined,
  workingDirectory: ctx.get('workingDirectory') !== undefined,
  subagents: ctx.get('subagents') !== undefined,
  agents: ctx.get('agents') !== undefined,
}
```

`undefined` 就是能力边界，如实记日志、如实降级。

### 规则 3：需要"服务出现后重新驱动"时用 `ctx.inject`

若某功能必须在服务就绪后才挂载（例如只有 `subagents` 出现才注册推导工具），
用 `ctx.inject(['subagents'], (childCtx) => {...})`。
它注册的是**带依赖的子作用域**，不满足时该子作用域不执行，但不影响主插件。

这与把名字放进入口 `inject` 有本质区别：

| 方式 | 服务缺失时 |
| :--- | :--- |
| 入口 `inject` 列出 | 整个插件不加载 |
| `ctx.inject([...], cb)` | 只有该回调不执行，插件其余部分正常 |

---

## 五、验证记录

```ts
// 当前产物
inject = ["tools"]
```

模拟三种场景均正常挂载：

```
场景 1 服务齐全：subagents: present, providers=[spawn], maxDepth=2
场景 2 无 subagents：subagents: absent; derivation will degrade to the two-step path
场景 3 无 initiator：agents: present, initiator at mount=none
```

三种都不影响 `apply()` 完成与 9 个工具注册。
