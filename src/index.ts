/**
 * dsh-inspect — 发现问题 → 修复交付 → 质量复查 的简单闭环。
 *
 * 把用户的 harness-fault-hunting / agent-deliver / agent-review 三个技能合并成
 * 一个轻量插件，三个朴素工具共享同一套"检查"机制：
 *
 *   checkup  发现问题：几个检查代理各看一个角度（质量/边界/安全…）→ 合并去重 → 问题清单
 *   fix      修复交付：拆解任务（或直接接收 checkup 的问题）→ 并行实现（各自跑样例自证）
 *            → 检查一遍 → 有严重/一般问题就修一轮 → 收敛后交付
 *   review   质量复查：几个审查代理并行检查交付物 → 汇总分级（严重/一般/建议）
 *
 * 闭环：checkup 的问题清单直接喂给 fix 作为修复任务；fix 的产物用 review 把关；
 * 复查不通过（或人的反馈）重新进入 fix。三个工具可以单独用，也可以串起来用。
 *
 * 设计原则：简单优先——用直白的"检查/问题/修复"语言，不堆砌复杂术语；
 * 技能的价值在于激活正确的行为，而不是用复杂的模式词汇表达。
 * 底座复用官方 workflow 引擎（ctx.workflows）与内置工具（bash/fs/glob…）。
 *
 * Native TypeScript source: the package entry points at this file and no build
 * step exists. In a dsh profile the package lives under node_modules, so it
 * loads through the dsh source launcher's whole-process tsx hook (Node's
 * native type stripping refuses files under node_modules); a checkout run
 * outside node_modules can also load via Node >=22.18 native stripping.
 * Syntax must stay erasable-only (no enums/namespaces/parameter properties).
 *
 * @module @dsh-external/dsh-inspect
 */

import z from 'schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: brings the `ctx.workflows` Context augmentation into this program.
import type { WorkflowMeta } from '@deepseek-ai/dsh-workflow'

export const name = 'dsh-inspect'

/**
 * Activate once the tool registry is available. The workflow engine is a hard
 * runtime requirement but is deliberately NOT statically injected: cordis
 * gates `apply` on every statically injected service, and in a profile where
 * no plugin provides `workflows` (e.g. the standard web composition) the
 * entry would sit `pending (waiting for service: workflows)` forever, hanging
 * the whole entry group until the host silently exits. The plugin therefore
 * loads (and registers its tools) in any profile; `runWorkflow` reads the
 * service through `ctx.get()` and reports a clear, actionable error when a
 * tool is invoked without a provider — see `requireWorkflows` below.
 */
export const inject = ['tools']

/** Loader-validated plugin config (all keys optional: z.object keys default to optional). */
export interface Config {
  /** Child-provider override passed to every workflow run. */
  subagentProvider?: string
  /** Per-run total-child ceiling for every workflow run. */
  maxTotalAgents?: number
  /** Role-level model overrides, one per checkup/fix/review role. */
  plannerModel?: string
  workerModel?: string
  checkerModel?: string
  reviewerModel?: string
  mergerModel?: string
  redteamModel?: string
}

/**
 * Plugin configuration, validated by the cordis loader against this
 * schemastery schema before `apply` runs (official annotation pattern:
 * packages/workflow/tool-workflow/src/index.ts). Values that are present but
 * type-invalid (or violate constraints) fail loud at load; missing keys are
 * treated as optional by schemastery (z.object keys default to optional) and
 * pass silently, so defaults are applied by `apply` via optionalString /
 * positiveInt.
 */
export const Config: z<Config> = z.object({
  /** Child-provider override passed to every workflow run. */
  subagentProvider: z.string(),
  /** Per-run total-child ceiling for every workflow run. */
  maxTotalAgents: z.natural().min(1),
  /** Role-level model overrides, one per checkup/fix/review role. */
  plannerModel: z.string(),
  workerModel: z.string(),
  checkerModel: z.string(),
  reviewerModel: z.string(),
  mergerModel: z.string(),
  redteamModel: z.string(),
})

/** Config key → script-side role field for the role-level model overrides. */
const MODEL_KEYS = [
  ['plannerModel', 'planner'],
  ['workerModel', 'worker'],
  ['checkerModel', 'checker'],
  ['reviewerModel', 'reviewer'],
  ['mergerModel', 'merger'],
  ['redteamModel', 'redteam'],
] as const satisfies readonly (readonly [keyof Config, string])[]

// ── 共享 schema（workflow 引擎子集：顶层与嵌套 required 数组均受支持并被使用）──────

const ISSUES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          level: { type: 'string', enum: ['严重', '一般', '建议'] },
          issue: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['level', 'issue'],
      },
    },
  },
  required: ['issues'],
}

// 工具输出 schema 里的 issues 形状（DSL 版：嵌套 value 节点不能用 required 数组，
// 只能逐属性 required: true；与 ISSUES_SCHEMA 保持 level/issue 必填语义一致）。
// `as const` keeps the DSL literal types (type/enum/required) for defineTool's
// inference — runtime behavior is identical.
const ISSUES_OUTPUT_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      level: { type: 'string', enum: ['严重', '一般', '建议'], required: true },
      issue: { type: 'string', required: true },
      evidence: { type: 'string' },
    },
  },
} as const

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          acceptance: { type: 'string' },
        },
        required: ['title'],
      },
    },
  },
  required: ['steps'],
}

/** One graded issue as produced by the checkup/review pipelines. */
type Issue = { level: '严重' | '一般' | '建议'; issue: string; evidence?: string }

// ── checkup：发现问题 ───────────────────────────────────────────────────────

const CHECKUP_SCRIPT = String.raw`const ISSUES_SCHEMA = ${JSON.stringify(ISSUES_SCHEMA)}
const { target, angles, context, models } = args
const M = models ?? {}
const ANGLES = Array.isArray(angles) && angles.length > 0 ? angles : ['实现质量', '边界与错误处理', '安全与资源']

const ADVERSARIAL = '你是对抗式检查员。默认怀疑一切：主动找反例、尝试推翻结论；'
  + '不轻信代码注释、README 和模型自己的说法；只认可能当场验证的证据；'
  + '宁可漏报也不虚报——没有证据的问题不要写。'
  + '判断问题前，先按数据流理清系统：输入 → 处理 → 存储 → 输出，每一步谁写谁读；'
  + '系统状态由数据流决定——问题就是数据流某处状态偏离了预期。'
  + '每个问题必须给出可互相校验的验证方式（重跑复现 / 日志对照 / 输入输出对照 / 双路径对照），'
  + '并写明预期状态与实际观测；无法通过系统反馈验证的，不要报。'

phase('检查')
const findings = await parallel(ANGLES.map((a, i) => () => agent(
  ADVERSARIAL + '\n\n'
  + '目标：' + target
  + (context ? '\n背景：' + context : '')
  + '\n\n你负责的角度：' + a + '\n\n要求：\n'
  + '- 每条问题给出：级别（严重=会出错或不可用 / 一般=应该修 / 建议=可以更好）、问题描述、证据（文件/行号/现象）；\n'
  + '- 没有问题时 issues 为空数组；\n'
  + '- 只输出 JSON。',
  {
    label: '检查·' + a,
    phase: '检查',
    schema: ISSUES_SCHEMA,
    ...(M.checker ? { model: M.checker } : {}),
  },
)))

// 引擎契约：child 失败 → agent() 解析为 null。统计未返回结果的检查代理，
// 报告如实标注——与红队 null 同标准：不静默丢弃、不把失败伪装成"没问题"。
const failedCheckers = findings.filter((f) => !f || !Array.isArray(f.issues)).length

// 红队：攻击最强的问题声明，尝试推翻（对抗式验证，必须做）
phase('红队')
const flat = []
for (const f of findings) {
  if (f && Array.isArray(f.issues)) for (const it of f.issues) flat.push(it)
}
const top = flat.filter((x) => x.level !== '建议').slice(0, 5)
let redteamResult = null
if (top.length > 0) {
  const red = await agent(
    '你是攻击员。针对下面的问题声明逐条攻击，尝试推翻它们：找反例、找更简单的解释、'
    + '检查证据是否真实可验证。推不翻的才保留。\n\n'
    + '问题声明：\n' + JSON.stringify(top)
    + '\n\n只输出 JSON（survived 为攻击后仍然成立的问题，refuted 为被推翻的问题，reasoning 为理由）。',
    {
      label: '红队',
      phase: '红队',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          survived: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { level: { type: 'string', enum: ['严重', '一般', '建议'] }, issue: { type: 'string' }, evidence: { type: 'string' } }, required: ['level', 'issue'] } },
          refuted: { type: 'array', items: { type: 'string' } },
          reasoning: { type: 'string' },
        },
        required: ['survived'],
      },
      ...(M.redteam ? { model: M.redteam } : {}),
    },
  )
  redteamResult = red
}

// 汇总：红队只审查 top（非建议前 5 条）。被推翻的剔除；幸存条目与未被红队
// 审查的剩余条目（全部建议级 + top-5 之外的严重/一般 + top 内红队未提及的条目）
// 一起回流，保证汇总代理看到完整清单——红队成功与失败的行为一致。
// 「已审查」只认红队实际提及的条目（survived 的 issue + refuted 的 issue）：
// survived/refuted 是选择性结论列表，红队输出部分覆盖或自相矛盾时（top 项
// 两个列表都未出现），该 top 项视为未审查，全量回流，绝不静默剔除。
// 红队有效成功 = 返回了至少一条 survived 或 refuted；全空数组是 schema 合法但
// 内容退化的输出（等于没审查任何声明），按红队失败处理：全量回流，不剔除任何条目。
// 红队返回 null（子代理运行失败/无结果）同样按红队失败处理：全量回流，报告如实标注。
// survived 成员校验：红队只收到 top 声明，返回的 survived 条目必须 issue 文本命中
// 检查员实际发现集合（flat）——红队输出是自由格式，可能包含未见于任何检查员输出的
// 幻觉/新增声明，直接并入会把幻觉注入最终清单（与「宁可漏报也不虚报」冲突）。未命中
// 的剔除并在红队记录标注，绝不注入 candidates。
let candidates = flat
let unreviewedCount = 0
let droppedSurvived = 0
const redteamRefuted = redteamResult && Array.isArray(redteamResult.refuted) ? redteamResult.refuted : []
const redteamValid = !!redteamResult
  && Array.isArray(redteamResult.survived)
  && (redteamResult.survived.length > 0 || redteamRefuted.length > 0)
if (redteamValid) {
  const refuted = new Set(redteamRefuted)
  const mentioned = new Set([
    ...redteamResult.survived.map((x) => x.issue),
    ...redteamRefuted,
  ])
  unreviewedCount = top.filter((x) => !mentioned.has(x.issue)).length
  const flatIssues = new Set(flat.map((x) => x.issue))
  droppedSurvived = redteamResult.survived.filter((x) => !flatIssues.has(x.issue)).length
  candidates = [
    ...redteamResult.survived.filter((x) => !refuted.has(x.issue) && flatIssues.has(x.issue)),
    ...flat.filter((x) => !mentioned.has(x.issue)),
  ]
}
const merged = await agent(
  '你是汇总员。把下面几份检查结果合并去重，去掉重复项，保留最准确的描述。'
  + '被红队推翻的问题已经剔除；未被红队审查的条目（含建议级）已全部保留。\n'
  + '级别定义：严重=会出错或不可用 / 一般=应该修 / 建议=可以更好。\n'
  + '只输出 JSON（issues 为合并后的清单）。\n\n检查结果：\n' + JSON.stringify(candidates),
  {
    label: '汇总',
    phase: '检查',
    schema: ISSUES_SCHEMA,
    ...(M.merger ? { model: M.merger } : {}),
  },
)

// 汇总代理失败（null / 无 issues）不得静默归零：与红队 null 同标准——候选问题
// 全量保留（未去重）+ 报告如实标注，绝不把失败伪装成"没发现问题"。
const mergerFailed = !merged || !Array.isArray(merged.issues)
const issues = mergerFailed ? candidates : merged.issues

const noteParts = []
if (failedCheckers > 0) noteParts.push(failedCheckers + ' 个检查代理未返回结果')
if (mergerFailed) noteParts.push('汇总代理未返回结果（候选问题全量保留，未合并去重）')
const failNote = noteParts.join('；')
const report = [
  '# 检查报告',
  '',
  '目标：' + target,
  '检查角度：' + ANGLES.join('、'),
  '',
  '## 发现的问题（' + issues.length + ' 个）',
  ...(issues.length === 0
    ? [(failNote ? '（存在未返回结果的代理，无法确认无问题）' : '（没发现问题）')]
    : issues.map((x, i) => (i + 1) + '. [' + x.level + '] ' + x.issue + (x.evidence ? '（证据：' + x.evidence + '）' : ''))),
  '',
  '## 统计',
  '严重：' + issues.filter((x) => x.level === '严重').length,
  '一般：' + issues.filter((x) => x.level === '一般').length,
  '建议：' + issues.filter((x) => x.level === '建议').length,
  ...(failNote ? ['', '## 检查记录', failNote] : []),
  '',
  '## 红队记录',
  (redteamValid
    ? (redteamRefuted.length > 0
      ? '被推翻：' + redteamRefuted.join('；')
      : '攻击后问题声明仍然成立。')
    + (unreviewedCount > 0 ? '\n未提及 ' + unreviewedCount + ' 项已保留（视为未审查）。' : '')
    + (droppedSurvived > 0 ? '\n' + droppedSurvived + ' 条红队新增声明未命中检查结果，已剔除。' : '')
    + (redteamResult.reasoning ? '\n理由：' + redteamResult.reasoning : '')
    : (redteamResult
      ? '（红队未返回有效结果，视为未审查，全部问题保留。）'
      : (top.length > 0
        ? '（红队未返回结果，视为未审查，全部问题保留。）'
        : '（无高优先级问题可攻击）'))),
].join('\n')
return { issues, report }
`

// ── fix：修复交付 ───────────────────────────────────────────────────────────

const FIX_SCRIPT = String.raw`const PLAN_SCHEMA = ${JSON.stringify(PLAN_SCHEMA)}
const ISSUES_SCHEMA = ${JSON.stringify(ISSUES_SCHEMA)}
const { task, issues, acceptance, models } = args
const M = models ?? {}
const MAX_ROUNDS = 3

// ── 1. 拆解：直接用问题清单，或规划子任务 ─────────────────────────────────
phase('拆解')
let steps = null
if (Array.isArray(issues) && issues.length > 0) {
  steps = issues.map((it, i) => {
    const problem = it.issue ?? it.title ?? ('问题' + (i + 1))
    return {
      title: '修复：' + problem,
      acceptance: '修复 ' + problem + (it.evidence ? '（证据：' + it.evidence + '）' : ''),
      problem,
      evidence: it.evidence ?? '',
    }
  })
} else {
  const plan = await agent(
    '你是规划员。把下面的任务拆成 3-6 个能独立完成、独立验收的小步骤。\n\n'
    + '任务：' + task
    + (acceptance ? '\n验收标准：' + acceptance : '')
    + '\n\n每步给出 title 和 acceptance（怎样算完成、能验证）。只输出 JSON。',
    {
      label: '规划',
      phase: '拆解',
      schema: PLAN_SCHEMA,
      ...(M.planner ? { model: M.planner } : {}),
    },
  )
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error('规划没有返回有效步骤')
  }
  steps = plan.steps.map((s) => ({ title: s.title, acceptance: s.acceptance ?? '', problem: s.title, evidence: '' }))
}

// ── 2. 实现（数据判断：找根因 → 直接实施 → 验证）→ 检查 → 修复，直到干净 ──
const done = []
const checkLogs = []
let round = 0
// 跨轮上下文：原始任务/验收标准始终在作用域（args 的 task/acceptance），
// roundExcerpt 累积前几轮产出摘录（每轮限长 + 总量封顶），第2轮起的
// worker/checker 提示词附带它，避免实现员脱离被检查对象从零重查。
let roundExcerpt = ''
let pending = steps.slice()
while (pending.length > 0 && round < MAX_ROUNDS) {
  round += 1
  phase('实现·第' + round + '轮')
  const outputs = await parallel(pending.map((s, i) => () => agent(
    '你是实现员。按"找根因 → 实施 → 验证"三步做。\n\n'
    + '问题：' + s.problem
    + (s.acceptance ? '\n验收标准：' + s.acceptance : '')
    + (s.evidence ? '\n已知证据：' + s.evidence : '')
    + (s.fix ? '\n补充要求：' + s.fix : '')
    + (round > 1
      ? '\n\n原始任务：' + task
        + (acceptance ? '\n原始验收标准：' + acceptance : '')
        + '\n上一轮产出（被检查对象，摘录）：\n' + roundExcerpt
      : '')
    + '\n\n第1步【找根因】：不要修表面。沿数据流追踪：输入 → 处理 → 存储 → 输出，'
    + '数据在哪一步开始偏离预期、谁写谁读、状态在哪一点开始错——找到状态偏离的源头（根因），'
    + '用证据（文件/行号/逻辑链/复现现象）说明。如果源头不清楚，先做最小复现来确认，不要猜。\n'
    + '第2步【实施】：根据数据判断选择最合理的方案直接实施（方案由根因自然决定，不空谈不犹豫），'
    + '实施时保持改动最小。\n'
    + '第3步【验证】：重跑问题原来的复现步骤（反馈闭合：观测输出与预期比较），'
    + '确认数据流状态恢复、问题真的消失；同时确认没有引入新问题。'
    + '如果验证失败（问题还在），说明根因或方案有误，明确报告"验证失败"，不要假装成功。\n'
    + '\n输出（Markdown）：根因（含证据）、实施内容、验证结果（复现/验证输出）。',
    {
      label: '实现' + (i + 1) + '·第' + round + '轮',
      phase: '实现·第' + round + '轮',
      ...(M.worker ? { model: M.worker } : {}),
    },
  )))

  const artifact = pending.map((s, i) => '【任务】' + s.title + '\n' + (outputs[i] ?? '（没有返回结果）')).join('\n\n')
  const checked = await agent(
    '你是对抗式检查员。默认怀疑一切：主动找反例、尝试推翻结论；只认可能当场验证的证据。'
    + '检查下面的产出，找出必须修的问题。\n\n'
    + '产出：\n' + artifact
    + (round > 1
      ? '\n\n原始任务：' + task
        + (acceptance ? '\n原始验收标准：' + acceptance : '')
        + '\n上一轮产出（被检查对象，摘录）：\n' + roundExcerpt
      : '')
    + '\n\n重点检查三件事（都按数据流核对：输入→处理→存储→输出，状态是否回到预期）：\n'
    + '1. 修复是否针对根因（如果只是绕过症状/表面改动，报"一般"级别问题并说明）；\n'
    + '2. 问题是否真的消失（重跑复现步骤验证，验证输出可疑或实现员自报"验证失败"就报"严重"）；\n'
    + '3. 是否引入了新问题。\n'
    + '\n只报"严重"（会出错或不可用）和"一般"（应该修）级别的问题；'
    + '没问题则 issues 为空数组。每条给出证据。只输出 JSON。',
    {
      label: '检查·第' + round + '轮',
      phase: '检查·第' + round + '轮',
      schema: ISSUES_SCHEMA,
      ...(M.checker ? { model: M.checker } : {}),
    },
  )
  // 检查代理必须返回有效结果才算「验证过」：checked 为 null（子代理失败/无结果）
  // 或结构无效时，本轮标为「未验证」，绝不进入收敛分支——否则门本身失效会被误报
  // 为「通过」（假收敛）。未验证的轮次：步骤保持 pending 进入下一轮重查（消耗轮次），
  // 轮次耗尽则如实呈现「未收敛」。
  // 实现代理失败（agent() 解析为 null）与检查代理失败同守卫：任一实现输出为 null
  // 本轮即「未验证」——否则检查代理返回空 issues 时，失败实现会被当作「通过」计入
  // done，完成情况显示「（无输出）」（与检查代理 null→假「通过」同类的假收敛路径）。
  const workerFailed = outputs.some((o) => o == null)
  const verified = !workerFailed && !!checked && Array.isArray(checked.issues)
  const problems = verified ? checked.issues.filter((x) => x.level === '严重' || x.level === '一般') : []
  checkLogs.push({ round, problems, verified, workerFailed })

  // 本轮产出归档进跨轮上下文（每轮摘录限长、总量封顶），供下一轮 worker/checker 附带。
  roundExcerpt = (roundExcerpt ? roundExcerpt + '\n\n' : '')
    + '第' + round + '轮产出摘录：\n' + artifact.slice(0, 1200)
  if (roundExcerpt.length > 3600) roundExcerpt = roundExcerpt.slice(-3600)

  if (!verified) continue

  if (problems.length === 0) {
    pending.forEach((s, i) => { done.push({ step: s, output: outputs[i] }) })
    pending = []
    break
  }

  pending.forEach((s, i) => { done.push({ step: s, output: outputs[i], hadProblems: true }) })
  // 全部问题进入下一轮，绝不 slice 丢弃：被检查出的每个问题都必须得到修复尝试；
  // 轮次上限由 MAX_ROUNDS 兜底，轮次耗尽时剩余问题在「结论」如实列出（含问题明细）。
  pending = problems.map((p) => ({
    title: '修复：' + p.issue.slice(0, 50),
    acceptance: '修复 ' + p.issue,
    problem: p.issue,
    evidence: p.evidence ?? '',
    fix: p.issue + (p.evidence ? '（证据：' + p.evidence + '）' : ''),
  }))
}

const parts = ['# 交付报告', '', '任务：' + task, '轮次：' + round, '', '## 完成情况']
for (const d of done) {
  parts.push('### ' + d.step.title + (d.hadProblems ? '（本轮被检查出问题，已进入修复）' : ''))
  parts.push((d.output ?? '（无输出）').slice(0, 1200))
}
parts.push('', '## 检查记录')
for (const c of checkLogs) {
  if (!c.verified) {
    parts.push('第' + c.round + '轮：' + (c.workerFailed ? '实现代理未返回结果，未验证' : '检查代理未返回结果，未验证'))
    continue
  }
  parts.push('第' + c.round + '轮：' + (c.problems.length === 0 ? '通过' : c.problems.length + ' 个问题'))
  for (const p of c.problems) parts.push('- [' + p.level + '] ' + p.issue)
}
parts.push('', '## 交付说明')
parts.push('- 请把交付结果给用户看实际效果（运行/演示/输出），由数据说话；')
parts.push('- 用户不满意的地方，把反馈作为新的问题重新进入修复循环。')
if (pending.length > 0) {
  parts.push('', '## 结论')
  parts.push('未收敛：剩余 ' + pending.length + ' 个问题（超出 ' + MAX_ROUNDS + ' 轮上限）：')
  for (const p of pending) parts.push('- ' + p.problem)
  parts.push('把剩余问题重新喂给 fix 继续修复。')
}
return { report: parts.join('\n'), rounds: round }
`

// ── review：质量复查 ────────────────────────────────────────────────────────

const REVIEW_SCRIPT = String.raw`const ISSUES_SCHEMA = ${JSON.stringify(ISSUES_SCHEMA)}
const { target, dimensions, context, fixed_issues, models } = args
const M = models ?? {}
const DIMS = Array.isArray(dimensions) && dimensions.length > 0 ? dimensions : ['实现质量', '边界与错误处理', '安全与资源']

const ADVERSARIAL = '你是对抗式审查员。默认怀疑一切：主动找反例、尝试推翻结论；'
  + '不轻信代码注释、README 和模型自己的说法；只认可能当场验证的证据；'
  + '宁可漏报也不虚报——没有证据的问题不要写。'
  + '判断问题前，先按数据流理清系统：输入 → 处理 → 存储 → 输出，每一步谁写谁读；'
  + '系统状态由数据流决定——问题就是数据流某处状态偏离了预期。'
  + '每个问题必须给出可互相校验的验证方式（重跑复现 / 日志对照 / 输入输出对照 / 双路径对照），'
  + '并写明预期状态与实际观测；无法通过系统反馈验证的，不要报。'

phase('复查')
const reviews = await parallel(DIMS.map((d, i) => () => agent(
  ADVERSARIAL + '\n\n'
  + '交付物：' + target
  + (context ? '\n背景：' + context : '')
  + (fixed_issues ? '\n\n需要验证的修复（逐条重跑复现/检查，确认问题真的消失；没消失报"严重"）：\n' + JSON.stringify(fixed_issues) : '')
  + '\n\n你负责的角度：' + d + '\n\n要求：\n'
  + '- 每条问题给出：级别（严重=会出错或不可用 / 一般=应该修 / 建议=可以更好）、描述、证据；\n'
  + '- 没有问题时 issues 为空数组；\n'
  + '- 只输出 JSON。',
  {
    label: '复查·' + d,
    phase: '复查',
    schema: ISSUES_SCHEMA,
    ...(M.reviewer ? { model: M.reviewer } : {}),
  },
)))

// 引擎契约：child 失败 → agent() 解析为 null。统计未返回结果的审查代理，
// 报告如实标注——与红队 null 同标准：不静默丢弃、不把失败伪装成"没问题"。
const failedReviewers = reviews.filter((r) => !r || !Array.isArray(r.issues)).length

const merged = await agent(
  '你是汇总员。把下面几份复查结果合并去重。\n'
  + '级别定义：严重=会出错或不可用 / 一般=应该修 / 建议=可以更好。\n'
  + '只输出 JSON。\n\n复查结果：\n' + JSON.stringify(reviews.filter(Boolean)),
  {
    label: '汇总',
    phase: '复查',
    schema: ISSUES_SCHEMA,
    ...(M.merger ? { model: M.merger } : {}),
  },
)

// 汇总代理失败（null / 无 issues）不得静默归零：与红队 null 同标准——审查结果
// 全量保留（未去重）+ 报告如实标注，绝不把失败伪装成"没问题"。
const mergerFailed = !merged || !Array.isArray(merged.issues)
const issues = mergerFailed
  ? reviews.filter((r) => r && Array.isArray(r.issues)).flatMap((r) => r.issues)
  : merged.issues

const noteParts = []
if (failedReviewers > 0) noteParts.push(failedReviewers + ' 个审查代理未返回结果')
if (mergerFailed) noteParts.push('汇总代理未返回结果（审查结果全量保留，未合并去重）')
const failNote = noteParts.join('；')
const report = [
  '# 复查报告',
  '',
  '交付物：' + target,
  '复查角度：' + DIMS.join('、'),
  '',
  '## 问题（' + issues.length + ' 个）',
  ...(issues.length === 0
    ? [(failNote ? '（存在未返回结果的代理，无法确认无问题）' : '（没发现问题）')]
    : issues.map((x, i) => (i + 1) + '. [' + x.level + '] ' + x.issue + (x.evidence ? '（证据：' + x.evidence + '）' : ''))),
  '',
  '## 结论',
  '严重/一般问题：' + issues.filter((x) => x.level !== '建议').length + ' 个'
    + (issues.some((x) => x.level !== '建议')
      ? ' —— 建议先修复再交付。'
      : (failNote ? ' —— 存在未返回结果的代理，交付结论未确认。' : ' —— 可以交付，建议项可选跟进。')),
  ...(failNote ? ['', '## 检查记录', failNote] : []),
].join('\n')
return {
  report,
  issues,
  // 有代理未返回结果或汇总失败时 passed 不得为 true：如实降级为"未确认"。
  passed: !issues.some((x) => x.level !== '建议') && !mergerFailed && failedReviewers === 0,
}
`

// ── 工具注册 ────────────────────────────────────────────────────────────────

/**
 * Runtime guard for the hard dependency. `ctx.workflows` is typed as always
 * present by the dsh-workflow Context augmentation, but in a profile without
 * a workflows provider the service is simply absent — read it through
 * `ctx.get()` (the lenient, inject-free read); touching the `ctx.workflows`
 * proxy accessor without a static inject declaration throws
 * `cannot get property "workflows" without inject`. Thrown from
 * `runWorkflow` only, NOT from `apply`: an entry that fails during apply
 * drags its whole loader group down (observed as a silent hang and the host
 * exiting ~40s later), so the profile must stay bootable and the tools must
 * report the missing engine only when actually invoked.
 */
function requireWorkflows(ctx: Context): Context['workflows'] {
  const workflows = ctx.get('workflows')
  if (workflows === void 0) {
    throw new Error(
      'dsh-inspect: no "workflows" service in this profile — checkup/fix/review all run on '
      + 'the official workflow engine (@deepseek-ai/dsh-workflow). Use a profile whose '
      + 'composition provides workflows (official base bundles) or add a provider plugin first.',
    )
  }
  return workflows
}

/** Script-side role overrides from the validated config (omitted keys stay absent). */
function modelsFrom(config: Config): Record<string, string> {
  const models: Record<string, string> = {}
  for (const [key, field] of MODEL_KEYS) {
    const value = config[key]
    if (value !== undefined) models[field] = value
  }
  return models
}

/** One workflow run request as built by the tool registrations below. */
interface WorkflowRunRequest {
  script: string
  meta: WorkflowMeta
  args?: unknown
}

/** The tool result shape all three tools share (script-owned fields pass through). */
type ToolResult = {
  ok: boolean
  report: string
  issues?: Issue[]
  rounds?: number
  passed?: boolean
}

export function apply(ctx: Context, config: Config = {}) {
  // Deliberately NOT checking the workflows dependency here: see
  // requireWorkflows — an apply-time failure hangs the whole loader group.
  // The exported Config schema validates at load; these checks keep
  // misconfiguration loud for programmatic callers that skip the loader.
  const subagentProvider = optionalString(config.subagentProvider, 'subagentProvider')
  for (const [key] of MODEL_KEYS) optionalString(config[key], key)
  // null/undefined both mean "leave the engine default" (old JS contract:
  // positiveInt(..., undefined, ...) omitted the key — keep it omitted).
  const maxTotalAgents = config.maxTotalAgents === undefined || config.maxTotalAgents === null
    ? undefined
    : positiveInt(config.maxTotalAgents, 0, 'maxTotalAgents')
  const models = modelsFrom(config)
  const common: { subagentProvider?: string; maxTotalAgents?: number } = {
    ...(subagentProvider !== undefined ? { subagentProvider } : {}),
    ...(maxTotalAgents !== undefined ? { maxTotalAgents } : {}),
  }

  ctx.tools.register(defineTool({
    name: 'checkup',
    description:
      '找问题工具：派几个对抗式检查代理从不同角度检查目标（代码/系统/方案），红队攻击验证'
      + '（尝试推翻问题声明，推不翻的才保留——发现是怀疑，验证是定罪），合并去重后给出问题清单'
      + '（严重/一般/建议，含证据）。发现的问题可以直接传给 fix 工具作为修复任务。'
      + '触发场景：找茬、审计、体检、审查可疑行为、验证问题是否成立。',
    parameters: {
      target: { type: 'string', required: true, description: '检查目标（路径或描述，检查代理会自己去看）。' },
      angles: { type: 'string', description: '可选：检查角度（逗号分隔，1 个起，数量不限，建议 2-6 个，引擎 maxTotalAgents 兜底）；缺省为 实现质量/边界与错误处理/安全与资源。' },
      context: { type: 'string', description: '可选：背景信息（范围、已知限制、对照物）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
          issues: ISSUES_OUTPUT_SCHEMA,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? value.report : `checkup 未能完成：${value.report}`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error('checkup requires a calling agent (exec.agent was undefined)')
      const target = String(args.target).trim()
      if (target.length === 0) throw new Error('checkup: target must not be empty')
      const angles = splitList(args.angles)
      return runWorkflow(ctx, common, {
        script: CHECKUP_SCRIPT,
        meta: {
          name: 'inspect-checkup',
          description: 'Parallel problem finding with deduped, graded issues.',
          phases: [
            { title: '检查', detail: 'Parallel checkers + merge' },
            { title: '红队', detail: 'Adversarial red-team attack on top claims' },
          ],
        } satisfies WorkflowMeta,
        args: {
          target,
          ...(angles.length > 0 ? { angles } : {}),
          ...(args.context !== undefined ? { context: String(args.context) } : {}),
          ...(Object.keys(models).length > 0 ? { models } : {}),
        },
      }, parent, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'fix',
    description:
      '修复交付工具：拆解任务（或接收 checkup 的问题清单）→ 并行实现，每个实现员按'
      + '"找根因 → 实施 → 验证"三步做（沿数据流找到状态偏离的源头，根据数据判断直接实施，'
      + '修完重跑复现步骤确认问题真的消失；验证失败说明根因或方案有误，明确报告不假装成功）'
      + '→ 对抗式检查（查表面修复/问题是否真消失/新问题）→ 有严重/一般问题自动修一轮再查，'
      + '直到收敛 → 交付报告（含检查记录与交付说明：给用户看实际效果，不满意反馈重新进入循环）。'
      + '触发场景：自主实现、工程交付、修复 checkup 发现的问题。',
    parameters: {
      task: { type: 'string', required: true, description: '要完成的任务（或修复目标）描述。' },
      issues: { type: 'string', description: '可选：checkup 的问题清单（JSON 数组文本：[{level, issue, evidence}]），作为修复任务。' },
      acceptance: { type: 'string', description: '可选：总体验收标准。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
          rounds: { type: 'number' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? value.report : `fix 未能完成：${value.report}`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error('fix requires a calling agent (exec.agent was undefined)')
      const task = String(args.task).trim()
      if (task.length === 0) throw new Error('fix: task must not be empty')
      const issues = parseIssueList(args.issues, 'fix: issues')
      return runWorkflow(ctx, common, {
        script: FIX_SCRIPT,
        meta: {
          name: 'inspect-fix',
          description: 'Root cause (dataflow) → implement by data judgment → verify via repro → adversarial gate loop.',
          phases: [
            { title: '拆解', detail: 'Steps with acceptance (or checkup issues)' },
            // The engine matches phase() calls by exact title (workflow/types.ts), so each
            // concrete round is declared — MAX_ROUNDS is 3 in the script.
            { title: '实现·第1轮', detail: 'Root cause → implement → verify via repro' },
            { title: '实现·第2轮', detail: 'Root cause → implement → verify via repro' },
            { title: '实现·第3轮', detail: 'Root cause → implement → verify via repro' },
            { title: '检查·第1轮', detail: 'Adversarial check, fix loop' },
            { title: '检查·第2轮', detail: 'Adversarial check, fix loop' },
            { title: '检查·第3轮', detail: 'Adversarial check, fix loop' },
          ],
        } satisfies WorkflowMeta,
        args: {
          task,
          ...(issues !== undefined ? { issues } : {}),
          ...(args.acceptance !== undefined ? { acceptance: String(args.acceptance) } : {}),
          ...(Object.keys(models).length > 0 ? { models } : {}),
        },
      }, parent, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'review',
    description:
      '质量复查工具：派几个对抗式审查代理从不同角度复查交付物（代码/方案/文档），合并去重后给出'
      + '分级问题报告（严重/一般/建议）。可传入 fixed_issues（要验证的修复清单），审查员会逐条'
      + '重跑复现确认问题真的消失（没消失报"严重"）。触发场景：任务完成后的质量把关、'
      + '提交/交付前复查、方案评审。',
    parameters: {
      target: { type: 'string', required: true, description: '待复查的交付物（路径或描述）。' },
      dimensions: { type: 'string', description: '可选：复查角度（逗号分隔，1 个起，数量不限，建议 2-6 个，引擎 maxTotalAgents 兜底）；缺省为 实现质量/边界与错误处理/安全与资源。' },
      context: { type: 'string', description: '可选：背景信息（需求、验收标准）。' },
      fixed_issues: { type: 'string', description: '可选：需要验证的修复清单（JSON 数组文本：[{level, issue, evidence}]），审查员逐条确认问题是否真的消失。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          report: { type: 'string', required: true },
          issues: ISSUES_OUTPUT_SCHEMA,
          passed: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? value.report : `review 未能完成：${value.report}`,
      }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error('review requires a calling agent (exec.agent was undefined)')
      const target = String(args.target).trim()
      if (target.length === 0) throw new Error('review: target must not be empty')
      const dims = splitList(args.dimensions)
      const fixedIssues = parseIssueList(args.fixed_issues, 'review: fixed_issues')
      return runWorkflow(ctx, common, {
        script: REVIEW_SCRIPT,
        meta: {
          name: 'inspect-review',
          description: 'Parallel multi-angle quality review with deduped graded issues.',
          phases: [{ title: '复查', detail: 'Parallel reviewers + merge' }],
        } satisfies WorkflowMeta,
        args: {
          target,
          ...(dims.length > 0 ? { dimensions: dims } : {}),
          ...(args.context !== undefined ? { context: String(args.context) } : {}),
          ...(fixedIssues !== undefined ? { fixed_issues: fixedIssues } : {}),
          ...(Object.keys(models).length > 0 ? { models } : {}),
        },
      }, parent, exec.signal)
    },
  }))
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function runWorkflow(
  ctx: Context,
  common: { subagentProvider?: string; maxTotalAgents?: number },
  request: WorkflowRunRequest,
  parent: Agent,
  signal: AbortSignal,
): Promise<ToolResult> {
  // Covers both a provider that was never there and one revoked mid-session —
  // same clear error instead of a TypeError on `.start`.
  const workflows = requireWorkflows(ctx)
  const run = workflows.start({ ...request, ...common, parent, signal })

  // Bridge the tool's abort signal to the run: if the parent step is aborted
  // while the script is in flight, cancel the whole run. The signal also
  // enters the engine directly, but this local bridge preserves the tool
  // contract even if an implementation ignores it (official tool-workflow:
  // packages/workflow/tool-workflow/src/index.ts:199-222).
  const onAbort = () => { run.cancel('parent step aborted') }
  signal.addEventListener('abort', onAbort, { once: true })

  try {
    const result = await run.result
    if (result.stopReason !== 'completed') {
      throw new Error(`workflow run ${result.stopReason}${result.error !== undefined ? ` (${result.error})` : ''}`)
    }
    const raw: unknown = result.value
    if (raw === null || typeof raw !== 'object') {
      throw new Error('workflow returned no report')
    }
    const record = raw as Record<string, unknown>
    if (typeof record.report !== 'string') {
      throw new Error('workflow returned no report')
    }
    // 透传各脚本实际返回的结构化字段（checkup: issues / fix: rounds /
    // review: issues+passed），脚本没返回的字段不给。
    const out: ToolResult = { ok: true, report: record.report }
    if (record.issues !== undefined) out.issues = record.issues as Issue[]
    if (record.rounds !== undefined) out.rounds = record.rounds as number
    if (record.passed !== undefined) out.passed = record.passed as boolean
    return out
  } finally {
    signal.removeEventListener('abort', onAbort)
    // Always reach run quiescence — never leak a live script or children.
    await run.dispose()
  }
}

function splitList(raw: string | undefined): string[] {
  if (typeof raw !== 'string') return []
  return raw.split(/[,，]/).map((s) => s.trim()).filter((s) => s.length > 0)
}

/**
 * Parse the issues/fixed_issues JSON-array text parameter (declared shape
 * [{level, issue, evidence}]). 缺省/空串按未提供处理；解析失败、结果非数组、
 * 或条目不是对象（null / 数组 / 其他原始值）时抛错——绝不静默降级。
 * @returns parsed array of issue objects, or undefined when not provided.
 */
function parseIssueList(raw: string | undefined, label: string): Issue[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') {
    throw new Error(`${label} 必须是 JSON 数组（[{level, issue, evidence}]）`)
  }
  const text = raw.trim()
  if (text.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${label} 必须是 JSON 数组（[{level, issue, evidence}]）`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 数组（[{level, issue, evidence}]）`)
  }
  for (const item of parsed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${label} 的每个条目必须是对象（{level, issue, evidence}），收到：${JSON.stringify(item)}`)
    }
    // 契约（类型 Issue 与工具描述）要求 level + issue 必填：缺字段的条目
    // 一旦进入脚本会让级别过滤/问题文本静默退化，这里 fail loud，绝不透传。
    const record = item as Record<string, unknown>
    if (typeof record.issue !== 'string' || record.issue.trim().length === 0) {
      throw new Error(`${label} 的每个条目必须有字符串 issue，收到：${JSON.stringify(item)}`)
    }
    if (typeof record.level !== 'string' || record.level.trim().length === 0) {
      throw new Error(`${label} 的每个条目必须有字符串 level，收到：${JSON.stringify(item)}`)
    }
  }
  return parsed as Issue[]
}

function positiveInt(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`dsh-inspect: ${label} must be a positive integer`)
  }
  return n
}

function optionalString(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`dsh-inspect: ${label} must be a string`)
  }
  return value
}
