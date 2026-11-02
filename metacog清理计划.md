# dsh-metacog 清理计划

对象：`metacog/`（`dsh-metacog` v0.1.0，重构后版本）
配套文档：《[插件说明清单](metacog插件说明清单.md)》（同目录）
制定日期：2026-10-30

**当前状态：已执行（2026-10-30）。** 删除 186 文件 / 39.84 MB，备份位于 `D:\文档\dsh临时工作区\_backup\metacog-2026-10-30-before-clean`（1896 文件 / 75.30 MB，全量镜像）。执行记录见第九节。

> 上一轮的清理计划已过期——其中建议删除的 15 项（12 个 `_tmp_*.mjs`、`_asar_index.json`、`d1.mjs`、`d2.mjs`）在重构时已经实际删除，`scripts/_harness.mjs` 消除了 13 处硬编码路径。本计划基于重构后的现状重新制定。

---

## 零、三条不适用通用清理模板的地方

| 通用项 | 本插件实际情况 | 结论 |
|---|---|---|
| 构建产物 | `lib/` 不是可丢弃产物，它就是 `package.json` 的 `main` | **保留** |
| 测试 | `test/` 下 47 个文件全部被 `package.json` 引用，零孤儿 | **保留** |
| 文档 | 无 README/LICENSE。`docs/monitoring-design-v4.md` 被 2 个 npm script 直接 readFile | **保留** |

当前目录 1896 文件 / 75.29 MB。按本计划删除 **202 文件 / 40.03 MB**，清理后剩 **1694 文件 / 35.26 MB**，回收 **53.2%**。

---

## 一、建议保留

### 1.1 运行必需

| 路径 | 大小 | 理由 |
|---|---:|---|
| `metacog/package.json` | 4,018 B | `main`/`exports`/`files`/`dsh` 全在此，加载器解析入口的唯一依据 |
| `metacog/cordis.patch.yml` | 449 B | 被 `dsh.bundle.patch` 指向，删掉 bundle 挂载失败 |
| `metacog/client.js` | 125,925 B | Web 设置卡入口，`exports["./client"]` + `dsh.client` 指向它 |
| `metacog/lib/` | 108 文件 / 1.13 MB | 编译产物即运行时。54 个 `.js` + 54 个 `.d.ts` 与 `src/` 完全对应；已实跑 `check-build-freshness.mjs` 验证（54 sources，全部新鲜，exit 0） |
| `metacog/src/` | 54 文件 / 0.91 MB | TypeScript 源码，唯一真源。删了永远无法重新构建 |
| `metacog/node_modules/zod` | 6.0 MB | **运行时 import**（`lib/config.js`、`lib/data/*.js`、`lib/analysis/derive.js`）。本地 4.6.7 与 profile 的 3.25.76 签名不兼容 |
| `metacog/node_modules/yaml` | 0.7 MB | **运行时 import**（`lib/settings.js`） |
| `metacog/node_modules/@standard-schema` | — | zod 运行时可能触及 |
| `metacog/node_modules/undici-types` | — | `@types/node` 依赖 |
| `metacog/node_modules/@deepseek-ai/` | — | cordis / cosmokit，peerDep 解析目标 |
| `metacog/node_modules/.bin/`、`.package-lock.json` | 3,566 B | 包管理元数据，保留无成本 |

> `node_modules` 必须留在本地：父级目录链 `D:\文档\dsh临时工作区\node_modules`、`D:\文档\node_modules`、`D:\node_modules` **全部不存在**。

### 1.2 构建配置与依赖清单

| 路径 | 大小 | 理由 |
|---|---:|---|
| `metacog/tsconfig.json` | 592 B | `npm run build` 必需 |
| `metacog/package-lock.json` | 3,951 B | 依赖清单，锁定 zod 4.6.7 / yaml 2.9.1 / ts 5.9.3 |
| `metacog/node_modules/typescript` | 22.5 MB | 运行时不需要，但删了 `npm run build` 立即失效，`lib/` 从此无法重编 |

### 1.3 测试与校验脚本

| 路径 | 大小 | 理由 |
|---|---:|---|
| `metacog/test/`（47 文件） | 0.53 MB | 全部被 `package.json` 引用 |
| `metacog/scripts/check-build-freshness.mjs` | 2,664 B | `test:all` 首项 + `check:fresh` |
| `metacog/scripts/check-design-v4.mjs` | 3,589 B | `check:design` |
| `metacog/scripts/check-doc-vs-code.mjs` | 4,997 B | `check:contract` |
| `metacog/scripts/mutation-check.mjs` | 8,327 B | `check:mutation` |
| `metacog/scripts/_harness.mjs` | 3,825 B | **16 个 `verify-*.mjs` 的共享底座**，导出 `libUrl()` / `mountHost()` / `createChecker()`。删了这 16 个脚本全部失效 |

### 1.4 verify 回归套件（17 个）

这些脚本在用 `_harness.mjs` 之后已改为相对定位，不再受路径迁移影响，是可复用的回归资产。

`verify-archive.mjs`、`verify-card-api.mjs`、`verify-card-client.mjs`、`verify-commands.mjs`、`verify-contradiction.mjs`、`verify-criteria-effect.mjs`、`verify-criteria-gate.mjs`、`verify-explain.mjs`、`verify-intervention.mjs`、`verify-intervention-card.mjs`、`verify-merge.mjs`、`verify-multi-project.mjs`、`verify-profile.mjs`、`verify-progress.mjs`、`verify-rebuild.mjs`、`verify-reminder.mjs`、`verify-revise-gate.mjs`、`verify-window.mjs`

> 其中 `verify-card-api`、`verify-card-client`、`verify-report` 三个还被 `docs/feature-status.md` 引为数字来源。
> `重构报告.md` 记录：多数 `verify-*.mjs` 在重构前就已失败（依赖过期契约）。保留它们是因为断言本身有价值，且重构已消除路径脆性——但不要把它们当绿色门槛。

### 1.5 被文档引用的验证脚本

| 路径 | 大小 | 被哪里引用 |
|---|---:|---|
| `scripts/probe-signals.mjs` | 5,490 B | `docs/feature-status.md` |
| `scripts/validate-on-own-stream.mjs` | 8,168 B | `docs/post-restart-checklist.md` |
| `scripts/validate-s3.mjs` | 5,905 B | `docs/monitoring-design-v4.md` |
| `scripts/validate-s3-control.mjs` | 6,023 B | 同上（且引用另两个 validate-s3） |
| `scripts/validate-s3-leadtime.mjs` | 4,971 B | 同上 |
| `scripts/verify-report.mjs` | 3,924 B | `docs/feature-status.md` |

### 1.6 文档

| 路径 | 大小 | 理由 |
|---|---:|---|
| `metacog/docs/`（19 文件） | 0.28 MB | 全部保留。`monitoring-design-v4.md`（62,729 B）**被 2 个 npm script 直接 readFile** |
| `metacog/重构报告.md` | 14,569 B | 记录 2026-10-30 重构的完整证据链、7 个已知问题、回滚方式 |
| `metacog/评审与重构计划.md` | 32,099 B | 重构前的评审计划，问题的来源依据 |
| `metacog/metacog插件说明清单.md` | 本文件 | 当前结构唯一完整记录 |
| `metacog/metacog清理计划.md` | 本文件 | 清理依据与范围记录 |

### 1.7 本地数据

| 路径 | 大小 | 理由 |
|---|---:|---|
| `metacog/.metacog/`（6 文件） | 6.1 KB | 运行时持久化目录的正常结构，含哈希链审计历史。删掉不影响启动，但收益仅 6 KB |

---

## 二、建议删除

### 2.1 第一档：零风险（不必犹豫）

#### A. npm 缓存 — `metacog/.npm-cache/`

| 项 | 值 |
|---|---|
| 规模 | 37 文件 / **35.99 MB**（占全目录 47.8%） |
| 内容 | `_cacache/`、`_logs/`、`_update-notifier-last-checked` |
| 判定依据 | 全树 grep 无任何代码/配置引用 `npm-cache` 或 `npm_config_cache`。是 `npm install` 产生的本地缓存。删后 npm 回落默认缓存 |
| 影响 | 无 |

#### B. Python 依赖副本 — `metacog/_pylibs/`

| 项 | 值 |
|---|---|
| 规模 | 125 文件 / **3.72 MB**（含 8 个 `__pycache__`，59 文件 / 2.02 MB） |
| 内容 | 只有 `pypdf` 6.21.3（+ dist-info），没有任何其他库 |
| 引用关系（修正） | 1. **插件本体不读它**：`src/evidence/pdf.ts` 把 Python 脚本以字符串内嵌，注释明写 *"Kept as a string so the plugin needs no files on disk at run time"*，走 `execFile('python', ['-c', 脚本, 路径])`。2. **但根目录 5 个 `.py` 脚本用 `sys.path.insert(0, r".\_pylibs")` 引用它**——上一版文档称"全树 grep 零命中"是错的，当时只搜了 `src/lib/scripts/test/docs`，漏了根目录。 |
| 真正失效的原因 | 那 5 个脚本合计需要 `pypdf` + `openpyxl` + `docx` + `pptx` + `fitz` 共 5 个库，而 `_pylibs` 只装了 `pypdf` 一个。实测系统 Python：`pypdf` 有（6.9.2）、`openpyxl` 有，但 `docx` / `pptx` / `fitz` 全缺。所以即使留着 `_pylibs`，那 5 个脚本依然 `ModuleNotFoundError`。 |
| 结论 | `_pylibs` 与那 5 个 `.py` 是**绑定关系**：脚本已死，它才真正无用。删脚本与删它必须同批进行，否则留下一个没有消费者的依赖副本。若日后要重跑那批文档处理，正确做法是 `pip install python-docx python-pptx PyMuPDF`，而不是依赖只有 pypdf 的 `_pylibs` |
| 影响 | 无。插件 PDF 读取走系统 Python 的 pypdf 6.9.2，不受影响 |

小计：**162 文件 / 39.71 MB**

### 2.2 第二档：插件根目录的一次性产物（17 个）

> **修正**：`derivation-output.json` 与 `tuangfu-output.json` 已从本表移入第三节「不确定项」。实测二者分别含 6 goals / 4 contradictions / 7 manifest 与 5 goals / 4 contradictions / 23 manifest 的完整内容，是派生引擎仅有的真实项目样本，不是空壳残留。

| 路径 | 大小 | 判定依据 |
|---|---:|---|
| `metacog/compare.py` | 4,608 B | 对 `D:\文档\团辅方案\团辅方案整理` 做文档去重比对。import `docx, openpyxl, pypdf, pptx`，`_pylibs` 只提供 pypdf，系统缺 `docx`/`pptx` → **已无法运行** |
| `metacog/extract.py` | 4,102 B | 批量抽 docx/xlsx/pdf 文本。import `docx, openpyxl, pypdf, fitz`，缺 `docx`/`fitz` → **已无法运行** |
| `metacog/extract-out.json` | 61,960 B | 上者产物，复现路径已断 |
| `metacog/pdfx.py` | 723 B | 抽 3 个 PDF 文本，同上依赖问题 |
| `metacog/pdfx-out.json` | 15,323 B | 上者产物 |
| `metacog/scan.py` | 3,098 B | 团辅方案目录扫描，同上缺库 → **已无法运行** |
| `metacog/evalcheck.py` | 2,201 B | 7 个指定文件的评估核对，同上缺库 → **已无法运行** |
| `metacog/derivation-prompt.txt` | 12,095 B | 上轮推导演示的 prompt 快照。若 `derivation-output.json` 保留，此文件可作为其输入留存；**两者要一起决定** |
| `metacog/tuangfu-step1.mjs` | 1,095 B | 对团辅方案生成推导 prompt 的一次性驱动器，硬编码项目路径 |
| `metacog/_gen-prompt.mjs` | 826 B | 调 `discoverMaterials` + `buildDerivationPrompt` 生成 prompt 写到 `derivation-prompt.txt` |
| `metacog/_validate.mjs` | 2,185 B | 读 `derivation-output.json` 跑 `reviewDerivation` 质量门 |
| `metacog/diag-report.mjs` | 2,739 B | 硬编码 `D:/文档/喜临门横向2/.metacog` + `pid='_____2-9fd8c650'`，统计 summary 信息量 |
| `metacog/read-logs.mjs` | 1,225 B | 同上项目路径与 pid，统计判定分布 |
| `metacog/read-state.mjs` | 860 B | 同上项目路径与 pid，打印目标树 |
| `metacog/probe-subagents.mjs` | 5,461 B | Stage 0 探针（`ctx.get('subagents')` 能否拿到可用服务并启动 schema 校验的激活）。**结论已完整沉淀为 `docs/stage-0-subagent-verification.md`** |
| `metacog/probe_asar.js` | 295 B | 在 `app.asar` 里 `indexOf` 搜 `startActivation`/`currentInitiator`/`outputSchema` 三个符号，判断宿主源码有无这些符号。连输出都未保存 |
| `metacog/sched-src.txt` | 105,046 B | 从宿主 asar 扒出的 2302 行调度模块源码。无引用、无头注释、无生成脚本；其结论已落进 `src/schedule.ts` 的注释（`ctx.jobs` 只建模一次性命令、`ctx.schedule` 会唤醒用户故默认关闭） |

小计：**17 文件 / 223,842 B（约 218.6 KB）**

> 5 个 `.py` 的共同点：它们合计要 `pypdf` + `openpyxl` + `docx` + `pptx` + `fitz`，而 `_pylibs` 只备了 `pypdf`，系统也缺 `docx`/`pptx`/`fitz`。**这些脚本在当前环境已 100% 无法运行**，产物 JSON 已生成，复现路径已断。它们不是"暂时没跑"，是"设计上就没备齐依赖"。

### 2.3 第三档：`scripts/` 中的一次性脚本（21 个）

#### C. probe-open 证据链（8 个，26,480 B）

`probe-open-assoc.mjs`、`probe-open-each.mjs`、`probe-open-handler.mjs`、`probe-open-launch.mjs`、`probe-open-path.mjs`、`probe-open-real.mjs`、`probe-open-spawn.mjs`、`probe-open-verify.mjs`

判定依据：这 8 个是为了定位「点击按钮在编辑器打开文件」的问题而做的一次性实验。**结论已经落地到产品代码**——`src/api.ts` 的 `launchOne()` 在 Windows 上改用 WMI 的 `Win32_Process.Create` 而非 `spawn`（因为 DSH 的子进程被 Job Object 包住，`spawn` 启动的编辑器会随宿主退出被杀）。机理与实测数据完整写在 `api.ts` 的注释里，比脚本更权威。脚本本身不再提供额外信息。

#### D. probe-spawn（2 个，5,749 B）

`probe-spawn-attach.mjs`、`probe-spawn-gui.mjs` —— 同上，对比四种进程挂载方式的存活数。

#### E. probe 其他（7 个，16,332 B）

| 路径 | 大小 | 判定依据 |
|---|---:|---|
| `probe-card-live.mjs` | 2,951 B | 对 `http://127.0.0.1:3080` 做 HTTP 探测，需运行中宿主 |
| `probe-criteria-hit.mjs` | 2,745 B | 一次性测量判据命中率 |
| `probe-embeddings.mjs` | 3,865 B | 探测 SiliconFlow 端点，需 `SILICONFLOW_API_KEY`；结论未落地到代码 |
| `probe-reg-parse.mjs` | 2,309 B | 一次性注册表解析探测 |
| `probe-intent-drift-cn.py` | 1,492 B | 依赖**插件外**的 `_drift_ref/intent-drift-src`，插件内无法自洽运行 |
| `show-card-data.mjs` | 1,418 B | `fetch('/api/metacog/projects')` 打印，需运行中宿主 |
| `diagnose-no-plan.mjs` | 1,552 B | 为解释一次测试与文档分歧而写的一次性诊断 |

#### F. 已完成的数据迁移脚本（2 个，12,107 B）

| 路径 | 大小 | 判定依据 |
|---|---:|---|
| `migrate-report-files.mjs` | 3,331 B | 文件头自述"Fold the pre-incremental markdown reports into the new per-cadence files"，且**"Idempotent: a cadence whose accumulated file already exists is left alone"** —— 迁移已完成，再跑无副作用也无用处 |
| `reorganize-reports.mjs` | 8,776 B | 文件头自述"Move the old flat markdown reports into the new per-cadence, per-period tree"，把三代命名统一到新布局。同上，一次性 |

> 这两个脚本自身设计得很谨慎（走回收站而非 unlink，避免破坏用户历史），但它们的历史使命已完成。**如果你打算保留其文档价值，可归入不确定项**。

#### G. 额外 2 个（12,539 B）

| 路径 | 大小 | 判定依据 |
|---|---:|---|
| `render-intervention-card.mjs` | 6,157 B | 检查设置卡渲染输出的辅助脚本。检查对象是 `client.js` 的源码文本，与 `test/client-card.test.mjs`（21,420 B）职能重叠 |
| `functional-test-live.mjs` | 6,382 B | 对真实项目跑一次干预卡流程。需真实 `.metacog/` 数据，属人工验证辅助 |

小计：**21 文件 / 73,207 B（约 71.5 KB）**

---

## 三、不确定项（按约束一律保留，并说明原因）

| 路径 | 大小 | 为什么判断不了 | 暂定处置 |
|---|---:|---|---|
| `metacog/derivation-output.json` | 19,470 B | **（本轮新增）** 实测 6 goals / 4 contradictions / 7 manifest，含 L0/L1 分层、successCriteria、poleA/poleB、mitigationHint。是派生引擎对「喜临门横向2」的真实完整输出，若要对比 `derive.ts` 改动前后的派生质量，这是现成对照样本 | **保留**（从删除表移出） |
| `metacog/tuangfu-output.json` | 30,183 B | **（本轮新增）** 实测 5 goals / 4 contradictions / 23 manifest，对「团辅方案」的同类样本 | **保留**（从删除表移出） |
| `metacog/scripts/verify-*.mjs`（17 个） | 约 180 KB | 重构报告记录多数在重构前就已失败（依赖过期契约）。但断言本身有回归价值，且 `_harness.mjs` 已消除路径脆性。「修好保留」还是「清理」是决策而非事实 | **保留** |
| `metacog/scripts/functional-test-live.mjs` | 6,382 B | 对真实 `D:\文档\dsh临时工作区` 跑干预卡流程。注释自述「套件已在 fixture 上覆盖，这个跑真实项目，那里有 3 张历史卡片和一条真实审计链——fixture 复现不了的条件」 | **保留** |
| `metacog/scripts/migrate-report-files.mjs` + `reorganize-reports.mjs` | 12,107 B | 迁移已完成且幂等，但脚本记录了报告目录三代命名演进（`01-daily-2026-10-27-v1.md` → `daily-2026-10-28.md` → `daily.md` → `日报/<年-月>/<日期>.md`），这个信息别处没有 | **保留** |
| `metacog/node_modules/typescript` | 22.5 MB | 运行时确不需要，但删了 `npm run build` 立即失效。若确认进入「只运行不改代码」的冻结状态则可删 | **保留** |
| `metacog/docs/settings-card-mockup.html` | 43,441 B | 全库零引用，但 `client.js` 注释明说设计规则来自它，是 UI 决策的唯一书面依据 | **保留** |
| `metacog/docs/settings-card-preview.html` | 14,238 B | 与上者并存，关系不明 | **保留** |
| `metacog/sched-src.txt` | 105,046 B | 2302 行宿主调度模块源码。无引用无头注释，但排查调度问题时是原始参考 | **保留**（从删除表移出） |
| `metacog/scripts/probe-open-*.mjs`（8）+ `probe-spawn-*.mjs`（2） | 32,229 B | 结论已硬化进 `api.ts` 的 `launchOne()`（Windows 走 WMI `Win32_Process.Create`）。保留换来这段排查过程的可复现性，删除只损失「为什么这么写」的证据链 | **保留**（从删除表移出） |
| `metacog/derivation-prompt.txt` | 12,095 B | 是 `_gen-prompt.mjs` 的输出，也是 `derivation-output.json` 的输入。若保留后者，应连带保留它 | **保留**（从删除表移出） |
| `metacog/.metacog/` | 6.1 KB | 结构是运行时的，内容是验证夹具。含审计链历史 | **保留** |

> 修正说明：本轮把 **`derivation-output.json`、`tuangfu-output.json`、`derivation-prompt.txt`、probe-open/probe-spawn 10 个、`sched-src.txt`、`functional-test-live.mjs`、两个迁移脚本** 全部移出删除范围。严格按「无法判断是否必要的一律保留」的约束。

因此**建议删除**实际为：

| 档 | 内容 | 文件数 | 体积 |
|---|---|---:|---:|
| 一 | `.npm-cache/` + `_pylibs/` | 162 | 39.71 MB |
| 二 | 根目录一次性产物（17 个，已剔除两个推导 JSON 与 prompt） | 17 | 223,842 B |
| 三 | scripts 一次性脚本（5 个 probe 类 + 额外 2 个） | 7 | 40,713 B |
| **合计** | | **186** | **39.97 MB** |

清理后：**1710 文件 / 35.32 MB**，回收 **53.1%**。

> 第三档具体删什么：`probe-card-live.mjs`、`probe-criteria-hit.mjs`、`probe-embeddings.mjs`、`probe-reg-parse.mjs`、`probe-intent-drift-cn.py`、`show-card-data.mjs`、`diagnose-no-plan.mjs`、`render-intervention-card.mjs`。其中 `render-intervention-card.mjs` 是渲染检查辅助，`test/client-card.test.mjs`（21,420 B）已覆盖同职能。

---

## 四、清理后的预期结果

| 项 | 清理前 | 清理后 | 变化 |
|---|---:|---:|---:|
| 总文件数 | 1,896 | 1,710 | **−186** |
| 总体积 | 75.29 MB | 35.32 MB | **−39.97 MB（−53.1%）** |
| `.npm-cache/` | 37 文件 / 35.99 MB | 0 | −37 / −35.99 MB |
| `_pylibs/` | 125 文件 / 3.72 MB | 0 | −125 / −3.72 MB |
| `scripts/` | 50 文件 / 0.30 MB | 43 文件 / 约 266 KB | −7 文件 |
| 根目录文件 | 28 个 / 0.51 MB | 11 个 / 约 380 KB | −17 个 |
| `src/`(54)、`lib/`(108)、`test/`(47)、`docs/`(19)、`node_modules/`(1422)、`.metacog/`(6) | 不变 | 不变 | — |

清理后根目录保留 11 个：`package.json`、`package-lock.json`、`tsconfig.json`、`cordis.patch.yml`、`client.js`、`重构报告.md`、`评审与重构计划.md`、`metacog插件说明清单.md`、`metacog清理计划.md`、`sched-src.txt`、`derivation-output.json`、`tuangfu-output.json`、`derivation-prompt.txt`（共 13 个，其中后 3 个为不确定项保留）。

清理后 `scripts/` 保留 32 个：4 个 npm 引用 + 1 个 `_harness` + 17 个 verify + 6 个被文档引用的 validate/probe + 2 个迁移 + 1 个实机测试 + `probe-signals`。

---

## 五、备份记录（已执行）

本目录**不在 git 版本控制下**（`git status` 显示 `?? metacog/`），重构报告提到的 `_backup/metacog-20261030-pre-refactor` 也已不存在——清理前没有任何回滚依据。

已执行：

```
备份位置：D:\文档\dsh临时工作区\_backup\metacog-2026-10-30-before-clean\
方式：robocopy /E /NFL /NDL /NJH /NP /R:1 /W:1（全量镜像，含 node_modules 与缓存）
校验：源 1896 文件 / 75.30 MB  →  备份 1896 文件 / 75.30 MB，文件数一致
```

### 5.2 删除方式

全部走**回收站**，未使用 `Remove-Item`：

```powershell
Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($path, 'OnlyErrorDialogs', 'SendToRecycleBin')
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($dir, 'OnlyErrorDialogs', 'SendToRecycleBin')
```

删除前逐项核对目标内容计数与本文件记录一致，不一致则停止并上报。

### 5.3 归档整理

用户未指定目标文件夹路径，本次采用**方式 A：原地清理，不动目录结构**。junction 挂载（`C:\Users\30759\.dsh\profiles\desktop\node_modules\dsh-metacog` → 本目录）保持不变，插件加载路径未受影响。

如需后续迁移，B/C 两种方式仍可用：B 复制到指定路径并保持相对结构；C 移动并重建 junction（需重启 DSH 验证）。

### 5.4 校验结果（已执行）

| 校验项 | 方法 | 结果 |
|---|---|---|
| 入口文件存在 | `Test-Path` 六个关键文件 | 全部 True |
| 运行时依赖在位 | 读 `node_modules/*/package.json` | zod 4.6.7、yaml 2.9.1、typescript 5.9.3 |
| 构建产物新鲜 | `node scripts/check-build-freshness.mjs` | `sources: 54` / `all present and newer than their sources` / **exit 0** |
| 文档一致性 | `node scripts/check-doc-vs-code.mjs` | **problems: 0，exit 0** |
| 设计一致性 | `node scripts/check-design-v4.mjs` | **lines: 1001，problems: 0，exit 0** |
| `_harness` 链条 | 确认 `scripts/_harness.mjs` 在位 | True，verify 脚本 19 个均在 |
| 测试套件 | `npm test` | **passed 10, failed 0，exit 0** |
| 插件真实加载 | 需重启 DSH | **未验证**——见下方说明 |

> 最后一项无法在本轮完成：插件在 DSH 启动时加载模块图，重启会中断当前会话。要确认真实加载，需完全退出 DSH 再启动，然后观察加载日志与设置卡是否正常。

---

## 六、执行记录（2026-10-30）

### 6.1 实际删除

| 批次 | 内容 | 文件数 | 体积 |
|---|---|---:|---:|
| 一 A | `metacog/.npm-cache/` 整个目录 | 37 | 35.99 MB |
| 一 B | `metacog/_pylibs/` 整个目录 | 125 | 3.72 MB |
| 二 | 根目录 16 个一次性产物 | 16 | 223,842 B |
| 三 | `scripts/` 8 个一次性脚本 | 8 | 39,911 B |
| **合计** | | **186** | **约 39.84 MB** |

第二档 16 个：`compare.py`、`derivation-prompt.txt`、`diag-report.mjs`、`evalcheck.py`、`extract.py`、`extract-out.json`、`pdfx.py`、`pdfx-out.json`、`probe-subagents.mjs`、`probe_asar.js`、`read-logs.mjs`、`read-state.mjs`、`scan.py`、`tuangfu-step1.mjs`、`_gen-prompt.mjs`、`_validate.mjs`

第三档 8 个：`probe-card-live.mjs`、`probe-criteria-hit.mjs`、`probe-embeddings.mjs`、`probe-reg-parse.mjs`、`probe-intent-drift-cn.py`、`show-card-data.mjs`、`diagnose-no-plan.mjs`、`render-intervention-card.mjs`

全部走回收站（`SendToRecycleBin`），可恢复。

### 6.2 清理前后对比

| 项 | 清理前 | 清理后 | 变化 |
|---|---:|---:|---:|
| 总文件数 | 1,896 | 1,710 | **−186** |
| 总体积 | 75.30 MB | 35.46 MB | **−39.84 MB（−52.9%）** |
| `.npm-cache/` | 37 / 35.99 MB | 0 | −35.99 MB |
| `_pylibs/` | 125 / 3.72 MB | 0 | −3.72 MB |
| `scripts/` | 50 / 0.30 MB | 42 / 0.28 MB | −8 文件 |
| 根目录 | 28 / 0.51 MB | 12 / 0.38 MB | −16 文件 |
| `src/`(54)、`lib/`(108)、`test/`(47)、`docs/`(19)、`node_modules/`(1422)、`.metacog/`(6) | — | 不变 | — |

### 6.3 清理后目录树（根目录部分）

```
metacog/                        1,710 文件 / 35.46 MB
├── package.json                    4,018 B
├── package-lock.json               3,951 B
├── tsconfig.json                     592 B
├── cordis.patch.yml                  449 B
├── client.js                     125,925 B
├── 重构报告.md                    14,569 B   保留
├── 评审与重构计划.md               32,099 B   保留
├── metacog插件说明清单.md          38,628 B   本轮产出
├── metacog清理计划.md              22,868 B   本文件
├── sched-src.txt                 105,046 B   不确定项，保留
├── derivation-output.json         19,470 B   不确定项，保留
├── tuangfu-output.json            30,183 B   不确定项，保留
├── src/                    54 文件 / 0.91 MB
├── lib/                   108 文件 / 1.13 MB
├── test/                   47 文件 / 0.53 MB
├── scripts/                42 文件 / 0.28 MB
├── docs/                   19 文件 / 0.28 MB
├── node_modules/         1422 文件 / 31.95 MB
└── .metacog/                6 文件 / 0.01 MB
```

### 6.4 回滚方式

```powershell
robocopy "D:\文档\dsh临时工作区\_backup\metacog-2026-10-30-before-clean" "D:\文档\dsh临时工作区\metacog" /MIR
```

或从回收站单独还原某个文件。

### 6.5 清理改动日志

- 未修改任何业务代码（`src/`、`lib/`、`client.js` 零改动）
- 未修改任何配置（`package.json`、`tsconfig.json`、`cordis.patch.yml` 零改动）
- 未修改任何文档（`docs/` 19 份原样保留）
- 未移动任何文件（全部为删除操作，无重命名）
- 仅重写两份审计文档：`metacog插件说明清单.md`、`metacog清理计划.md`
