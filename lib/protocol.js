/**
 * The standing protocol of a metacognitive session.
 *
 * The guidance a metacog session needs is not a one-off message: it is the
 * conversation's whole job description, and every turn of that conversation is
 * governed by it. Sending it as the first user message worked but was wrong in
 * three ways — it burned a large user turn on text the model cannot revisit once
 * it scrolls out of context, it made the instruction look like something the user
 * said, and it meant every re-entry had to restate everything.
 *
 * So it is registered as a scoped system-prompt section instead, and the user
 * message that wakes the session is reduced to a one-line kickoff.
 *
 * The same scope also carries the tool whitelist. A metacognitive conversation
 * derives a yardstick; it must not be able to rewrite the project it is measuring.
 *
 * @module dsh-metacog/protocol
 */
/** Section name. Global sections with the same name are shadowed, never duplicated. */
export const METACOG_PROTOCOL_SECTION = 'dsh-metacog/session-protocol';
/**
 * Placement order.
 *
 * Late enough to follow the deployment's own persona and tooling sections: this
 * text is a task protocol, and it reads as an addition to "who you are", not a
 * replacement for it.
 */
export const METACOG_PROTOCOL_ORDER = 860;
/**
 * Tools a metacognitive session may use.
 *
 * Derivation is delegated to `goal_tree_init`, which runs its own subagent, but
 * the session still has to inspect material: `read`/`glob`/`grep` for text,
 * `metacog_read_document` for Office containers, and `pwsh` for everything those
 * cover poorly (PDF scraping, unzipping, a document the extractor chokes on).
 *
 * `ask_user_question` is preferred whenever the deployment provides it. Writing
 * the questions as prose and ending the turn reaches nobody: the user gets a wall
 * of text and no answer control, and the session simply stops. But a deployment
 * that never registers the tool must not be forced into that dead end — the
 * protocol therefore carries a prose fallback that keeps the work moving.
 */
export const METACOG_SESSION_TOOLS = [
    'metacog_scan',
    'metacog_read_document',
    'goal_tree_init',
    'goal_tree_confirm',
    'goal_tree_view',
    'goal_tree_edit',
    'contradiction_tree_edit',
    'metacog_revise',
    'metacog_ask_user',
    'ask_user_question',
    'read',
    'glob',
    'grep',
    'pwsh',
    'load_workspace_dependencies',
    'skill',
];
/** The protocol text carried by the section. */
export const METACOG_PROTOCOL = `这个会话是本工作区的认知监控会话。它唯一的职责是建立并维护两样东西：目标树（这个项目为什么存在，分成哪几个可验收的部分）和矛盾树（阻碍目标的结构性张力）。具体开发工作不在这里做。

## 树是标尺，不是笔记

目标树推导一次、经用户确认后固定。文档后来怎么改，都不是重新推导的理由——重推会让此前所有「这次工作是否服务于目标」的判断失去参照。只有用户明确说目标变了、或某个矛盾已经解决，才用 metacog_revise 修改。

## 先对齐，再推导

不要一上来就替用户推导目标。顺序是固定的：

1. 列材料：调用 metacog_scan。它只扫描、不推导、不写盘。
2. 判断读哪些：看标题自己决定，不要全读，也不要凭印象编。read 只接受文本文件；要看某个子目录里有什么，用 glob（path 指目录，pattern 如 "**/*.md"）。Office 文档（docx/xlsx/pptx）与 PDF 用 metacog_read_document 取正文，它能抽出段落和表格。PDF 若返回「无文本层」，说明是扫描件，按标题与大小判断并记为未核实，别反复硬试。全项目清单以 metacog_scan 为准，它的 reader 字段已经标好每个文件该用哪个工具。
3. **第一轮提问（推导前）：先问用户，再推导。** 优先调用 metacog_ask_user（插件自带，一定可用）；它不可用时再用 ask_user_question；两者都不可用时按下面「提问」一节在正文列编号问题。一次问清三项：
   - 他在项目里是什么角色；
   - 这个项目/这些事务为什么存在（意图）；
   - 已知约束（截止时间、预算、人力、合规）。
   用户回答之前，**不要调用 goal_tree_init，也不要 goal_tree_confirm**。缺背景不是「置信度低」的正常状态，而是还没有对齐；拿文件猜测代替提问，会把整棵树建在猜测上。
4. 按回答推导：调用 goal_tree_init。L1 与任务目录由程序按标题匹配绑定 paths，你不需要抄目录名；deadline 暂时留空，等第二轮问。
5. **第二轮提问（推导后、预览前）：** 用 metacog_ask_user 逐个 L1 问预期截止时间，并把材料里读到的日期作为候选线索（例如换届 11-07、教材 12-31），让用户确认或修正，不要让他从零填。用户明确说「没有截止时间」时，把这个事实记进 noDeadlineGoalRefs（目标标题）；确认时缺 deadline 且不在这个清单里的 L1 会被 DEADLINE_REQUIRED 拒绝。
6. 把结果摊开：读了什么、根目标是什么、依据在哪、有哪些备选解读、识别到哪些矛盾、哪里不确定。**如果矛盾树为空，必须明确写「未发现结构性矛盾」并请用户确认确实没有**，不能沉默地显示一棵空树。
7. **先预览，再确认。** 调用 goal_tree_confirm 时传 preview: true，把返回的两棵树**人可读文本**原样给用户看（按父子关系缩进，不是按 depth 平铺）。用户看过并明确同意后，再用**同一版本**调用 goal_tree_confirm，传 userApproved: true 和 approvalNote（记录用户说了什么）。版本变了要重新预览；没有预览过的版本会被 PREVIEW_REQUIRED 拒绝。
8. 落库后告诉用户：树已冻结，此后只报告、不自动改。

projectContext 里的角色、意图、约束必须来自用户回答。不要写「未确认：从文件看是…」「待确认」这类占位当答案——那等于没问，确认时会被 CONTEXT_UNCONFIRMED 拦下；确实要带着未确认背景推进，必须显式传 allowUnconfirmedContext: true 并写明 reason。

## 重建已有关卡

已确认的树要重推时，goal_tree_init 必须同时给 force: true 和 expectedVersion（当前版本号，先用 goal_tree_view 读出）。缺一不可——工具需要确认你真的看过那棵即将被替换的树。旧树会备份到 .metacog/rebuilds/，并在审计链上留一条 tree_reset 记录。

## 提问：优先用工具，工具不可用时用正文兜底

需要用户回答时，先调用 metacog_ask_user（插件自带，优先）：问题落在工具参数里，用户才有可点选项。它不可用时再用 ask_user_question；两者都不可用时按下面的正文兜底。把问题写成正文再结束回合，用户看到的是几段文字加一个没有可点选项的空档——问等于没问，会话也就停在那里，没人知道该继续什么。

- 一次问完，不要分几轮挤牙膏。
- 每个问题都给选项，选项之间要能区分出不同的答案。
- 正文里可以说明为什么问，但问题本身必须落在工具参数里。
- 用户回答之前，不要假装已经知道答案继续往下做。

若 metacog_ask_user 与 ask_user_question 都不可用（本部署没有提供任何提问工具），不要因此跳过提问，也不要只回一句「我没有这个工具」：

- 在正文里用编号列表把四项问题逐条写清楚（1. 2. 3. 4.），每个问题后附上可选项；
- 明确写「请直接回复编号+答案」；
- 可以继续扫描材料，但在用户回答之前不要推导、不要确认、不要落库；不允许因为工具不可用就跳过提问直接确认。

## 不要做的事

- 不要用 read 去探目录（用 glob），也不要凭印象列文件清单。
- 不要因为 read 读不出某个 Office 文件就断言「这个项目无法分析」——先看 metacog_scan 的 reader 字段，再决定用哪个工具。
- 不要替用户决定角色、目标或约束。
- 不要在 ask_user_question 可用时，改用正文罗列问题然后结束回合。
- 不要在用户没有要求的情况下重新推导已确认的树。
- 不要把工具返回的 JSON 整段复述给用户，只挑结论与依据。`;
/**
 * Apply the metacognitive protocol and tool whitelist to one agent's scope.
 *
 * Called from `CreateAgentOptions.setup`, whose context *is* the agent's scope, so
 * the section and the restriction apply to that one conversation and nothing else.
 *
 * A whitelisted tool this build does not provide is dropped instead of passed
 * through: `restrict` treats an unknown name as a programming error and throws,
 * which would take the whole session down over a tool the model never needed.
 *
 * @param scope - the agent context handed to the setup callback.
 * @param known - names this deployment actually registers globally.
 */
export function applyMetacogScope(scope, known) {
    const problems = [];
    let section = false;
    const prompt = scope.get('systemPrompt');
    if (prompt === undefined) {
        problems.push('host exposes no systemPrompt service; the protocol was not installed');
    }
    else {
        try {
            prompt.section({
                name: METACOG_PROTOCOL_SECTION,
                order: METACOG_PROTOCOL_ORDER,
                text: METACOG_PROTOCOL,
            });
            section = true;
        }
        catch (error) {
            problems.push(`could not register the protocol section: ${String(error)}`);
        }
    }
    const allowed = METACOG_SESSION_TOOLS.filter((name) => known.has(name));
    const skipped = METACOG_SESSION_TOOLS.filter((name) => !known.has(name));
    let restricted = false;
    const tools = scope.get('tools');
    if (tools === undefined) {
        problems.push('host exposes no tools registry; the whitelist was not applied');
    }
    else if (allowed.length === 0) {
        // An empty allow list is rejected by the registry, and it would hide every
        // tool anyway — refusing loudly is better than a session that cannot act.
        // The refusal names every dropped tool: a whitelist that matches nothing is
        // indistinguishable from a working one unless the skipped names are reported,
        // which is exactly the blind spot this diagnostic exists to close.
        problems.push('no metacog tool is registered globally; the whitelist was not applied ' +
            `(allowed: none; skipped: ${skipped.join(', ')})`);
    }
    else {
        try {
            tools.restrict({ allow: allowed });
            restricted = true;
        }
        catch (error) {
            problems.push(`could not apply the tool whitelist: ${String(error)}`);
        }
    }
    return { section, restricted, allowed, skipped, problems };
}
