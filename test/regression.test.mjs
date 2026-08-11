/**
 * dsh-inspect 回归测试 —— 前两轮 10 项修复的固化为可重跑用例。
 *
 * 运行：cd plugins/dsh-inspect && node --test
 *（零依赖：不 import src/index.ts 的依赖，纯 node + 内置 node:test/node:vm。
 *  Node ≤20 也可用 node --test test/；Node 22+ 把位置参数当 glob，目录参数
 *  需写成 node --test 'test/**' 或直接用默认发现 node --test。）
 *
 * 机制（镜像引擎）：
 * - 从 src/index.ts 抽取三个 String.raw 脚本（CHECKUP_SCRIPT / FIX_SCRIPT /
 *   REVIEW_SCRIPT），并按模块加载时的行为插值
 *   ${JSON.stringify(ISSUES_SCHEMA)} / ${JSON.stringify(PLAN_SCHEMA)}；
 * - 用与引擎 runtime.ts 相同的 vm.Script 包装 '(async () => { body })()' 求值，
 *   全局钩子 phase / log / args / agent（按 label 从 mock 队列取值）/
 *   parallel（Promise.all 并发执行 thunk）；
 * - 工具注册层（⑧⑨⑩）：优先动态 import 真实模块（tsx/DSH 环境，Node ≥22.18
 *   原生类型剥离直接 import .ts）；纯 node 下依赖不可解析
 *   （ERR_MODULE_NOT_FOUND）时退化为在 vm 中求值模块源码——先用 node:module 的
 *   stripTypeScriptTypes 剥离类型（原生剥离要求 erasable-only 语法，剥离失败
 *   会响亮抛错，防止不可移植语法混入）。vm 路径的 mock 镜像 dsh-tools 的关键
 *   契约（DSL→原始 schema 编译、受支持子集断言、execute 参数校验），真实路径
 *   可用 tsx 交叉验证；两条路径跑同一组断言。
 *
 * 场景映射（与前两轮验证脚本 t-harness2/3、verify_*.mjs 一一对应）：
 *   ① 转义无字面 '\n'            → test '①'
 *   ② 红队五态（有效/空数组/null/部分覆盖/幻觉剔除）→ tests '②'×5（+无top回归）
 *   ③ 子代理失败（checker/reviewer/merger/worker）如实标注 → tests '③'×4
 *      （worker null 与 checker null 同守卫：本轮标「未验证」，不假收敛）
 *   ④ passed 诚实三态            → test '④'
 *   ⑤ fix 假收敛防护（checker null、worker null）→ tests '⑤'×2（worker 并入③）
 *   ⑥ 4 问题全部重修             → test '⑥'
 *   ⑦ 未收敛明细                 → test '⑦'
 *   ⑧ runWorkflow 透传 issues/rounds/passed → test '⑧'
 *   ⑨ 参数校验抛错（非数组/条目非对象）→ test '⑨'
 *   ⑩ 输出 schema 编译通过       → test '⑩'
 *   ⑪ 跨轮上下文：第2轮起 worker/checker 附原始任务/验收标准/前几轮产出摘录 → test '⑪'×2
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

const LIB_URL = new URL('../src/index.ts', import.meta.url)
const SRC = readFileSync(LIB_URL, 'utf8')

// ── 脚本抽取：与 src/index.ts 中定义逐字一致的 schema 常量 ────────────────

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

/** 抽取 String.raw 脚本字面量并复现模块加载时的 ${...} 插值。 */
function extractScript(name) {
  const marker = `const ${name} = String.raw\``
  const start = SRC.indexOf(marker) + marker.length
  if (start < marker.length) throw new Error(`extract failed: ${name} marker not found`)
  const end = SRC.indexOf('`', start)
  if (end < 0) throw new Error(`extract failed: ${name} closing backtick not found`)
  let body = SRC.slice(start, end)
  body = body.replaceAll('${JSON.stringify(ISSUES_SCHEMA)}', JSON.stringify(ISSUES_SCHEMA))
  body = body.replaceAll('${JSON.stringify(PLAN_SCHEMA)}', JSON.stringify(PLAN_SCHEMA))
  if (body.includes('${')) {
    throw new Error(`unexpected interpolation remains in ${name}: ${body.match(/\$\{[^}]*\}/)?.[0] ?? ''}`)
  }
  return body
}

const SCRIPTS = {
  checkup: extractScript('CHECKUP_SCRIPT'),
  fix: extractScript('FIX_SCRIPT'),
  review: extractScript('REVIEW_SCRIPT'),
}

// ── 引擎包装镜像：vm.Script '(async () => { body })()' + 全局钩子 ───────────

const mk = (issues) => ({ issues })
/** checkup 汇总 mock：从提示词里原样回传 candidates（观测合并块实际输入）。 */
const echoMerger = (prompt) => mk(JSON.parse(prompt.slice(prompt.indexOf('['))))

/**
 * 在 vm 中执行脚本体。roles 按 agent label 提供 mock 队列（null = 子代理失败；
 * 函数 = 以 (prompt, opts) 调用）。队列耗尽或出现未预料的 label 时抛错（响亮失败）。
 * @returns {Promise<{result: any, prompts: Array<{label: string, prompt: string}>}>}
 */
async function runScript(body, args, roles = {}) {
  const state = { idx: {}, prompts: [] }
  const take = (key) => {
    const queue = roles[key]
    if (!queue) throw new Error(`unexpected agent call for role "${key}" (no mock provided)`)
    const i = state.idx[key] ?? 0
    if (i >= queue.length) throw new Error(`mock queue exhausted for role "${key}" (${queue.length} entries)`)
    state.idx[key] = i + 1
    return queue[i]
  }
  const context = vm.createContext({})
  context.phase = Object.freeze(() => {})
  context.log = Object.freeze(() => {})
  context.args = args
  context.parallel = Object.freeze((thunks) => Promise.all(thunks.map((t) => t())))
  context.agent = Object.freeze((prompt, opts = {}) => {
    const label = opts.label ?? ''
    state.prompts.push({ label, prompt, opts })
    const role = label.startsWith('检查·') ? 'checker'
      : label.startsWith('复查·') ? 'reviewer'
        : label.startsWith('实现') ? 'worker'
          : label === '红队' ? 'redteam'
            : label === '汇总' ? 'merger'
              : label === '规划' ? 'planner'
                : null
    if (!role) throw new Error('unexpected agent label: ' + label)
    // 引擎契约镜像（runtime.ts 对每个 agent() schema 执行 assertObjectJsonSchema）：
    // 结构化调用必须带 schema 且位于受支持子集（object 根）；接线被删或脚本内嵌
    // schema 出现不支持关键字都会在此响亮失败。
    if (role !== 'worker') {
      if (!opts.schema) throw new Error(`${label} 调用缺少 opts.schema（结构化 agent 契约）`)
      assertObjectJsonSchema(opts.schema)
    }
    const value = take(role)
    return typeof value === 'function' ? value(prompt, opts) : value
  })
  const script = new vm.Script(`(async () => {\n${body}\n})()`, { filename: 'workflow:inspect-test' })
  const result = await Promise.resolve(script.runInContext(context))
  return { result, prompts: state.prompts }
}

const issueNames = (issues) => issues.map((x) => x.issue).sort()
const promptsOf = (prompts, prefix) => prompts.filter((p) => p.label.startsWith(prefix)).map((p) => p.prompt)
/** vm 求值产生的数组/对象属于 vm realm，deepStrictEqual 会因原型不同误报——JSON 往返转宿主值。 */
const plain = (value) => JSON.parse(JSON.stringify(value))

// ════════════════════════════════════════════════════════════════════════════
// ① 转义：脚本提示词与报告用真实换行，无字面 '\n'（反斜杠 n）
// ════════════════════════════════════════════════════════════════════════════
test('① 转义无字面 \\n（真实换行）', async () => {
  const FINDINGS = [
    mk([{ level: '严重', issue: 'S1', evidence: 'e1' }, { level: '严重', issue: 'S2' }]),
    mk([{ level: '一般', issue: 'M1' }, { level: '一般', issue: 'M2' }]),
    mk([{ level: '建议', issue: 'A1' }, { level: '建议', issue: 'A2' }]),
  ]
  const { result, prompts } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: FINDINGS,
    redteam: [() => ({ survived: [{ level: '严重', issue: 'S1', evidence: 'e1' }], refuted: ['S2'], reasoning: 'r' })],
    merger: [echoMerger],
  })
  assert.ok(prompts.length >= 5, `checkup 应有 5 次 agent 调用，实际 ${prompts.length}`)
  for (const { label, prompt } of prompts) {
    assert.ok(prompt.includes('\n'), `${label} 提示词应含真实换行`)
    assert.ok(!prompt.includes('\\n'), `${label} 提示词不得含字面 '\\n'`)
  }
  assert.ok(result.report.includes('\n') && !result.report.includes('\\n'), 'checkup 报告应含真实换行且无字面 \\n')

  const fix = await runScript(SCRIPTS.fix, { task: 'T', issues: [{ level: '严重', issue: 'X1' }] }, {
    worker: ['## 根因\n数据流偏离。\n## 实施\n已修复。\n## 验证\n复现通过。'],
    checker: [mk([])],
  })
  for (const { label, prompt } of fix.prompts) {
    assert.ok(prompt.includes('\n'), `${label} 提示词应含真实换行`)
    assert.ok(!prompt.includes('\\n'), `${label} 提示词不得含字面 '\\n'`)
  }
  assert.ok(fix.result.report.includes('\n') && !fix.result.report.includes('\\n'), 'fix 报告应含真实换行且无字面 \\n')

  const review = await runScript(SCRIPTS.review, { target: 'T' }, {
    reviewer: [mk([]), mk([]), mk([])],
    merger: [mk([])],
  })
  for (const { label, prompt } of review.prompts) {
    assert.ok(prompt.includes('\n'), `${label} 提示词应含真实换行`)
    assert.ok(!prompt.includes('\\n'), `${label} 提示词不得含字面 '\\n'`)
  }
  assert.ok(review.result.report.includes('\n') && !review.result.report.includes('\\n'), 'review 报告应含真实换行且无字面 \\n')
})

// ════════════════════════════════════════════════════════════════════════════
// ② 红队五态
// ════════════════════════════════════════════════════════════════════════════
const RED_FINDINGS = [
  mk([{ level: '严重', issue: 'W' }, { level: '严重', issue: 'X' }, { level: '一般', issue: 'Y' }]),
  mk([]),
  mk([]),
]

test('② 红队·有效：被推翻的剔除、未提及回流', async () => {
  const FINDINGS = [
    mk([{ level: '严重', issue: 'S1', evidence: 'e1' }, { level: '严重', issue: 'S2' }]),
    mk([{ level: '一般', issue: 'M1' }, { level: '一般', issue: 'M2' }]),
    mk([{ level: '建议', issue: 'A1' }, { level: '建议', issue: 'A2' }]),
  ]
  const { result, prompts } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: FINDINGS,
    redteam: [() => ({ survived: [{ level: '严重', issue: 'S1', evidence: 'e1' }], refuted: ['S2'], reasoning: 'S2 证据不足' })],
    merger: [echoMerger],
  })
  assert.deepEqual(issueNames(result.issues), ['A1', 'A2', 'M1', 'M2', 'S1'], 'S2 被推翻剔除，其余全部保留')
  assert.ok(result.report.includes('被推翻：S2'), '报告红队记录应列出被推翻项')
  const redPrompt = promptsOf(prompts, '红队')[0] ?? ''
  assert.ok(redPrompt.includes('S1') && redPrompt.includes('S2'), '红队提示词应含 top 问题声明')
})

test('② 红队·空数组：{survived:[], refuted:[]} 视为未审查，全量保留', async () => {
  const { result } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: RED_FINDINGS,
    redteam: [() => ({ survived: [], refuted: [], reasoning: '所有声明都被证明是误报。' })],
    merger: [echoMerger],
  })
  assert.strictEqual(result.issues.length, 3, '空数组是 schema 合法但内容退化，一条都不剔除')
  assert.ok(result.report.includes('红队未返回有效结果'), '报告应标注红队未返回有效结果')
})

test('② 红队·null：子代理失败视为未审查，全量保留', async () => {
  const { result } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: RED_FINDINGS,
    redteam: [() => null],
    merger: [echoMerger],
  })
  assert.strictEqual(result.issues.length, 3, '红队 null 全量保留')
  assert.ok(result.report.includes('红队未返回结果'), '报告应标注红队未返回结果')
})

test('② 红队·部分覆盖：未提及的 top 项回流', async () => {
  const { result } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: RED_FINDINGS,
    redteam: [() => ({ survived: [{ level: '严重', issue: 'X' }], refuted: ['Y'], reasoning: '' })],
    merger: [echoMerger],
  })
  assert.deepEqual(issueNames(result.issues), ['W', 'X'], '未提及的 W 必须回流，Y 被推翻剔除')
  assert.ok(result.report.includes('未提及 1 项已保留'), '报告应标注未提及项已保留')
})

test('② 红队·幻觉剔除：survived 与 refuted 自相矛盾的条目被剔除', async () => {
  const { result } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: RED_FINDINGS,
    redteam: [() => ({ survived: [{ level: '严重', issue: 'X' }], refuted: ['X'], reasoning: 'X 自相矛盾' })],
    merger: [echoMerger],
  })
  assert.deepEqual(issueNames(result.issues), ['W', 'Y'], '自相矛盾的 X 剔除，W/Y 保留')
  assert.ok(result.report.includes('被推翻：X'), '报告应标注 X 被推翻')
})

test('② 红队·幻觉剔除：survived 未命中检查结果的新增声明被剔除，绝不注入', async () => {
  const { result } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: RED_FINDINGS,
    redteam: [() => ({ survived: [{ level: '严重', issue: 'H' }], refuted: ['Y'], reasoning: 'H 是红队幻觉' })],
    merger: [echoMerger],
  })
  // flat=[W,X,Y]；H 未见于任何检查员输出（幻觉/新增声明）→ 剔除，绝不并入 candidates
  assert.deepEqual(issueNames(result.issues), ['W', 'X'], '幻觉条目 H 不得注入，W/X 回流')
  assert.ok(result.report.includes('1 条红队新增声明未命中检查结果，已剔除。'), '红队记录应标注幻觉条目被剔除')
  assert.ok(result.report.includes('被推翻：Y'), '被推翻的 Y 照常剔除')
})

test('② 红队·回归：全部建议级（无 top）不调用红队', async () => {
  const { result, prompts } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: [mk([{ level: '建议', issue: 'A1' }]), mk([]), mk([])],
    merger: [echoMerger],
  })
  assert.deepEqual(issueNames(result.issues), ['A1'])
  assert.ok(!prompts.some((p) => p.label === '红队'), '无高优先级问题时不调用红队')
  assert.ok(result.report.includes('无高优先级问题可攻击'), '报告应标注无高优先级问题可攻击')
})

// ════════════════════════════════════════════════════════════════════════════
// ③ 子代理失败（checker/reviewer/merger/worker）如实标注，不假干净
// ════════════════════════════════════════════════════════════════════════════
test('③ checkup·检查代理 null：如实标注，不宣称没发现问题', async () => {
  const { result } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: [null, null, null],
    merger: [null],
  })
  assert.deepEqual(plain(result.issues), [], '无数据可保留时 issues=[]')
  assert.ok(result.report.includes('3 个检查代理未返回结果'), '报告应标注 3 个检查代理未返回结果')
  assert.ok(result.report.includes('汇总代理未返回结果'), '报告应标注汇总代理未返回结果')
  assert.ok(result.report.includes('无法确认无问题'), '报告应标注无法确认无问题')
  assert.ok(!result.report.includes('（没发现问题）'), '不得宣称「（没发现问题）」')
})

test('③ checkup·部分检查代理 null：统计如实', async () => {
  const { result } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: [
      mk([{ level: '严重', issue: 'S1', evidence: 'e1' }, { level: '一般', issue: 'M1', evidence: 'e5' }]),
      mk([{ level: '严重', issue: 'S2', evidence: 'e2' }, { level: '建议', issue: 'A1', evidence: 'e7' }]),
      null,
    ],
    redteam: [() => ({ survived: [{ level: '严重', issue: 'S1', evidence: 'e1' }], refuted: [], reasoning: '只确认了 S1' })],
    merger: [mk([{ level: '严重', issue: 'S1', evidence: 'e1' }, { level: '一般', issue: 'M1', evidence: 'e5' }])],
  })
  assert.strictEqual(result.issues.length, 2, 'issues=汇总结果')
  assert.ok(result.report.includes('1 个检查代理未返回结果'), '报告应标注 1 个检查代理未返回结果')
  assert.ok(!result.report.includes('（没发现问题）'), '不得宣称「（没发现问题）」')
})

test('③ checkup·汇总代理 null：候选问题全量保留', async () => {
  const { result } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: [
      mk([{ level: '严重', issue: 'S1', evidence: 'e1' }, { level: '一般', issue: 'M1', evidence: 'e5' }]),
      mk([{ level: '严重', issue: 'S2', evidence: 'e2' }, { level: '建议', issue: 'A1', evidence: 'e7' }]),
      mk([{ level: '严重', issue: 'S3', evidence: 'e3' }]),
    ],
    redteam: [() => ({ survived: [{ level: '严重', issue: 'S1', evidence: 'e1' }], refuted: ['S2'], reasoning: 'S2 是误报' })],
    merger: [null],
  })
  // flat=[S1,M1,S2,A1,S3] top=[S1,M1,S2,S3] mentioned={S1,S2}
  // candidates = [S1] + flat 未提及 [M1,A1,S3] = 4 条，全量保留
  assert.strictEqual(result.issues.length, 4, '候选问题全量保留（未静默归零）')
  assert.ok(result.issues.some((x) => x.issue === 'S3'), '未提及的严重项 S3 保留')
  assert.ok(result.report.includes('汇总代理未返回结果'), '报告应标注汇总代理未返回结果')
  assert.ok(result.report.includes('候选问题全量保留'), '报告应标注候选问题全量保留')
})

test('③ review·审查代理 null：passed=false + 交付结论未确认', async () => {
  const { result } = await runScript(SCRIPTS.review, { target: 'T' }, {
    reviewer: [null, null, null],
    merger: [null],
  })
  assert.deepEqual(plain(result.issues), [])
  assert.strictEqual(result.passed, false, 'passed 不得为 true')
  assert.ok(result.report.includes('3 个审查代理未返回结果'), '报告应标注 3 个审查代理未返回结果')
  assert.ok(result.report.includes('交付结论未确认'), '结论应标注交付结论未确认')
  assert.ok(!result.report.includes('（没发现问题）'), '不得宣称「（没发现问题）」')
  assert.ok(!result.report.includes('可以交付'), '不得宣称「可以交付」')
})

test('③ review·汇总代理 null：审查结果全量保留 + passed=false', async () => {
  const { result } = await runScript(SCRIPTS.review, { target: 'T' }, {
    reviewer: [
      mk([{ level: '严重', issue: 'R1', evidence: 'e1' }, { level: '建议', issue: 'R2', evidence: 'e2' }]),
      mk([{ level: '一般', issue: 'R3', evidence: 'e3' }]),
      mk([]),
    ],
    merger: [null],
  })
  assert.strictEqual(result.issues.length, 3, '审查结果全量保留（未静默归零）')
  assert.strictEqual(result.passed, false, 'merger null 时 passed 不得为 true')
  assert.ok(result.report.includes('汇总代理未返回结果'), '报告应标注汇总代理未返回结果')
  assert.ok(result.report.includes('审查结果全量保留'), '报告应标注审查结果全量保留')
})

test('③ fix·实现代理 null：与检查代理 null 同守卫——本轮未验证，不假收敛', async () => {
  const { result, prompts } = await runScript(SCRIPTS.fix, { task: 'T', issues: [{ level: '严重', issue: 'X1' }] }, {
    worker: [null, 'impl 2'],
    checker: [mk([]), mk([])],
  })
  assert.strictEqual(result.rounds, 2, 'worker null 的轮次不进入收敛分支，消耗轮次重查')
  const round1CheckerPrompt = promptsOf(prompts, '检查·')[0] ?? ''
  assert.ok(round1CheckerPrompt.includes('（没有返回结果）'), '检查门提示词必须标注实现代理未返回结果')
  assert.ok(result.report.includes('第1轮：实现代理未返回结果，未验证'), '第1轮应标「实现代理未返回结果，未验证」')
  assert.ok(result.report.includes('第2轮：通过'), '第2轮重查通过')
  assert.strictEqual((result.report.match(/第\d+轮：通过/g) ?? []).length, 1, '不得在失败轮次出现假「通过」')
  assert.ok(!result.report.includes('（无输出）'), '失败的实现不得被当作「通过」计入完成情况')
})

// ════════════════════════════════════════════════════════════════════════════
// ④ passed 诚实三态：true（干净）/ false（有问题）/ false（未确认）
// ════════════════════════════════════════════════════════════════════════════
test('④ passed 三态', async (t) => {
  await t.test('干净 → passed=true', async () => {
    const { result } = await runScript(SCRIPTS.review, { target: 'T' }, {
      reviewer: [mk([]), mk([]), mk([])],
      merger: [mk([])],
    })
    assert.strictEqual(result.passed, true)
    assert.ok(result.report.includes('（没发现问题）'), '确认无问题才宣称「（没发现问题）」')
    assert.ok(result.report.includes('可以交付'), '确认无问题才宣称「可以交付」')
  })

  await t.test('只有建议级 → passed=true', async () => {
    const { result } = await runScript(SCRIPTS.review, { target: 'T' }, {
      reviewer: [mk([{ level: '建议', issue: 'A' }]), mk([]), mk([])],
      merger: [mk([{ level: '建议', issue: 'A' }])],
    })
    assert.strictEqual(result.passed, true, '建议级不阻塞交付')
  })

  await t.test('有一般/严重 → passed=false', async () => {
    const { result } = await runScript(SCRIPTS.review, { target: 'T' }, {
      reviewer: [mk([{ level: '一般', issue: 'R1' }]), mk([]), mk([])],
      merger: [mk([{ level: '一般', issue: 'R1' }])],
    })
    assert.strictEqual(result.passed, false)
    assert.ok(result.report.includes('严重/一般问题：1 个'), '结论应如实统计')
    assert.ok(result.report.includes('建议先修复再交付'), '结论应建议先修复再交付')
  })

  await t.test('有代理未返回结果 → passed=false（未确认）', async () => {
    const { result } = await runScript(SCRIPTS.review, { target: 'T' }, {
      reviewer: [mk([]), mk([]), null],
      merger: [mk([])],
    })
    assert.strictEqual(result.passed, false, '有代理未返回结果时 passed 不得为 true')
    assert.ok(result.report.includes('1 个审查代理未返回结果'), '报告应标注 1 个审查代理未返回结果')
    assert.ok(result.report.includes('交付结论未确认'), '结论应标注交付结论未确认')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ⑤ fix 假收敛防护：检查代理 null 不得被当作「通过」
// ════════════════════════════════════════════════════════════════════════════
test('⑤ fix·检查代理 null×3：未验证标记、无假通过、轮次耗尽如实未收敛', async () => {
  const { result } = await runScript(SCRIPTS.fix, { task: 'T', issues: [{ level: '严重', issue: 'X1' }] }, {
    worker: ['fix attempt 1', 'fix attempt 2', 'fix attempt 3'],
    checker: [null, null, null],
  })
  assert.strictEqual(result.rounds, 3)
  const unverified = result.report.match(/第\d+轮：检查代理未返回结果，未验证/g) ?? []
  assert.strictEqual(unverified.length, 3, '三轮都应标「未验证」')
  assert.strictEqual((result.report.match(/第\d+轮：通过/g) ?? []).length, 0, '不得出现任何「通过」（假收敛）')
  assert.ok(result.report.includes('未收敛'), '轮次耗尽应如实呈现未收敛')
  const conclusion = result.report.slice(result.report.indexOf('## 结论'))
  assert.ok(conclusion.includes('X1'), '未收敛明细应列出剩余问题')
})

test('⑤ fix·检查 null 后重查通过：未验证轮次如实记录，不吞轮次', async () => {
  const { result } = await runScript(SCRIPTS.fix, { task: 'T', issues: [{ level: '严重', issue: 'X1' }] }, {
    worker: ['impl 1', 'impl 2'],
    checker: [null, mk([])],
  })
  assert.strictEqual(result.rounds, 2, '未验证的轮次不进入收敛分支，消耗轮次重查')
  assert.ok(result.report.includes('第1轮：检查代理未返回结果，未验证'), '第1轮应标未验证')
  assert.ok(result.report.includes('第2轮：通过'), '第2轮重查通过')
  assert.ok(!result.report.includes('未收敛'), '最终收敛')
})

// ════════════════════════════════════════════════════════════════════════════
// ⑥ 4 问题全部重修：不得 slice 丢弃超出 3 个的问题
// ════════════════════════════════════════════════════════════════════════════
test('⑥ 4 个问题全部进入下一轮重修', async () => {
  const P = (i) => ({ level: '一般', issue: 'P' + i })
  const issues4 = [P(1), P(2), P(3), P(4)]
  const { result } = await runScript(SCRIPTS.fix, { task: 'T', issues: issues4 }, {
    worker: ['impl P1', 'impl P2', 'impl P3', 'impl P4', 're-impl P1', 're-impl P2', 're-impl P3', 're-impl P4'],
    checker: [mk([P(1), P(2), P(3), P(4)]), mk([])],
  })
  assert.strictEqual(result.rounds, 2)
  assert.ok(result.report.includes('第1轮：4 个问题'), '检查记录应标第1轮 4 个问题')
  assert.ok(result.report.includes('第2轮：通过'), '第2轮收敛')
  assert.ok(result.report.includes('re-impl P4'), '第 4 个问题必须被重修（原缺陷：超出 3 个被静默丢弃）')
  const doneTitles = result.report.match(/^### .*$/gm) ?? []
  assert.strictEqual(doneTitles.length, 8, '完成情况应有 8 个步骤（4 原始 + 4 重修）')
  assert.ok(!result.report.includes('未收敛'), '最终收敛')
})

// ════════════════════════════════════════════════════════════════════════════
// ⑦ 未收敛明细：轮次耗尽时如实列出剩余问题
// ════════════════════════════════════════════════════════════════════════════
test('⑦ 轮次耗尽：未收敛段如实列出全部剩余问题', async () => {
  const P = (i) => ({ level: '严重', issue: '问题P' + i, evidence: '证据' + i })
  const issues4 = [P(1), P(2), P(3), P(4)]
  const { result } = await runScript(SCRIPTS.fix, { task: 'T', issues: issues4 }, {
    worker: [
      'w1', 'w2', 'w3', 'w4',
      'w5', 'w6', 'w7', 'w8',
      'w9', 'w10', 'w11', 'w12',
    ],
    checker: [mk([P(1), P(2), P(3), P(4)]), mk([P(1), P(2), P(3), P(4)]), mk([P(1), P(2), P(3), P(4)])],
  })
  assert.strictEqual(result.rounds, 3)
  assert.ok(result.report.includes('未收敛'), '应呈现未收敛')
  const conclusion = result.report.slice(result.report.indexOf('## 结论'))
  assert.ok(conclusion.includes('超出 3 轮上限'), '应标注超出轮次上限')
  for (const p of issues4) {
    assert.ok(conclusion.includes(p.issue), `未收敛明细应列出 ${p.issue}`)
  }
  assert.ok(conclusion.includes('把剩余问题重新喂给 fix 继续修复。'), '应给出下一步指引')
})

// ════════════════════════════════════════════════════════════════════════════
// ⑪ fix 跨轮上下文：第2轮起的 worker/checker 附带原始任务/验收标准/前几轮
// 产出摘录（每轮 slice(0,1200) 限长），实现员不脱离被检查对象从零重查
// ════════════════════════════════════════════════════════════════════════════
test('⑪ fix·第2轮 worker/checker 附带原始任务、验收标准与第1轮产出摘录', async () => {
  const LONG = 'y'.repeat(2000)
  const { result, prompts } = await runScript(SCRIPTS.fix, {
    task: '原始任务T',
    acceptance: '原始验收标准A',
    issues: [{ level: '严重', issue: 'X1', evidence: 'ev1' }],
  }, {
    worker: ['第1轮实现输出：' + LONG, '第2轮实现输出：修复了C1'],
    checker: [mk([{ level: '严重', issue: 'C1', evidence: 'e1' }]), mk([])],
  })
  assert.strictEqual(result.rounds, 2, '第1轮发现问题，第2轮收敛')

  const [w1, w2] = promptsOf(prompts, '实现')
  const [c1, c2] = promptsOf(prompts, '检查·')
  assert.ok(!w1.includes('原始任务'), '第1轮 worker 不带跨轮上下文（首轮问题即原始问题）')
  assert.ok(!c1.includes('原始任务'), '第1轮 checker 不带跨轮上下文')

  for (const p of [w2, c2]) {
    assert.ok(p.includes('原始任务：原始任务T'), '第2轮应附原始任务')
    assert.ok(p.includes('原始验收标准：原始验收标准A'), '第2轮应附原始验收标准')
    assert.ok(p.includes('上一轮产出（被检查对象，摘录）'), '第2轮应标注上一轮产出为被检查对象')
    assert.ok(p.includes('第1轮产出摘录：'), '第2轮应含第1轮产出摘录')
    assert.ok(p.includes('【任务】修复：X1'), '摘录应含原始步骤标题')
    assert.ok(p.includes('第1轮实现输出：'), '摘录应含第1轮实现输出')
    assert.ok(p.includes('y'.repeat(1000)), '摘录限长内应完整保留（slice 含【任务】前缀，正文保留约1180字符）')
    assert.ok(!p.includes(LONG), '产出摘录必须限长（slice(0,1200)），不得整段塞入')
  }
  assert.ok(w2.includes('问题：C1'), '第2轮 worker 仍以检查员问题为修复任务')
})

test('⑪ fix·第3轮摘录累积前两轮产出，检查员也能看到第1轮产物', async () => {
  const { result, prompts } = await runScript(SCRIPTS.fix, {
    task: '原始任务T',
    acceptance: '原始验收标准A',
    issues: [{ level: '严重', issue: 'X1' }],
  }, {
    worker: ['w1', 'w2', 'w3'],
    checker: [mk([{ level: '一般', issue: 'C1' }]), mk([{ level: '一般', issue: 'C2' }]), mk([])],
  })
  assert.strictEqual(result.rounds, 3)
  const [w3] = promptsOf(prompts, '实现').slice(2)
  const [c3] = promptsOf(prompts, '检查·').slice(2)
  for (const p of [w3, c3]) {
    assert.ok(p.includes('第1轮产出摘录：'), '第3轮应含第1轮产出摘录')
    assert.ok(p.includes('第2轮产出摘录：'), '第3轮应含第2轮产出摘录')
    assert.ok(p.includes('原始任务：原始任务T'), '第3轮仍附原始任务')
    assert.ok(p.includes('w1') && p.includes('w2'), '前两轮实现产物都在上下文中')
    assert.ok(p.includes('【任务】修复：X1'), '原始步骤标题仍可追溯')
  }
})



let pluginPromise = null
function loadPlugin() {
  if (!pluginPromise) {
    pluginPromise = (async () => {
      try {
        const mod = await import(LIB_URL.href)
        return { mod, mode: 'real-import' }
      } catch (err) {
        if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err
        return { mod: evaluateModuleInVm(), mode: 'vm-mock' }
      }
    })()
  }
  return pluginPromise
}

/** 在 vm 中求值模块源码：先剥离类型（原生类型剥离契约），再移除 import/export，注入 mock z 与 defineTool。 */
function evaluateModuleInVm() {
  let src = SRC
  src = stripTypeScriptTypes(src) // throws on non-erasable syntax — keeps the source portable
  src = src.replace("import z from 'schemastery'", '')
  src = src.replace("import { defineTool } from '@deepseek-ai/dsh-tools'", '')
  src = src.replaceAll(/\bexport\s+/g, '')
  src += '\n;globalThis.__inspectExports = { name, inject, Config, apply, CHECKUP_SCRIPT, FIX_SCRIPT, REVIEW_SCRIPT }\n'
  const defs = []
  // schemastery 链式 mock：Config 只在模块加载时构造，行为不被测试使用。
  // 自引用代理：z.natural() 的返回值也必须是同一代理（.min 等链式调用才能命中 trap）。
  const zChain = new Proxy(() => undefined, { get: () => zChain, apply: () => zChain })
  const context = vm.createContext({
    z: new Proxy(zChain, { get: () => zChain, apply: () => zChain }),
    // 镜像真实 defineTool（dsh-tools schema.ts）：编译参数/输出 schema +
    // execute 包装层对参数做 schema 校验（缺必填/类型错 → 抛错，不进入执行体）。
    defineTool: (def) => {
      const parameters = compileParameterSchema(def.parameters)
      const outputSchema = compileOutputSchema(def.output.schema)
      const compiled = {
        ...def,
        parameters,
        output: { ...def.output, schema: outputSchema },
        execute: async (args, exec) => {
          const violations = validateJsonSchemaValue(parameters, args, '')
          if (violations.length > 0) {
            throw new Error('INVALID_ARGS: ' + violations.join('; '))
          }
          return def.execute(args, exec)
        },
      }
      defs.push(compiled)
      return compiled
    },
  })
  new vm.Script(src, { filename: 'dsh-inspect-lib' }).runInContext(context)
  return { ...context.__inspectExports, __defs: defs }
}

// ── 移植自 @deepseek-ai/dsh-tools（packages/core/tools/src/schema.ts + json-schema.ts）──
// 覆盖 dsh-inspect 所用子集：type/properties/required/additionalProperties/items/enum/const + 注解。
// 与引擎一致：DSL 编译（逐属性 required: true → 顶层 required 数组）→ 受支持子集断言 → 值校验。

const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const SCHEMA_ANNOTATIONS = ['description', 'title', 'default', 'examples']

function isSchemaRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function authorError(message) {
  throw new Error('unsupported schema: ' + message)
}

function assertAuthorKeys(source, path, allowed) {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`)
  }
}

function compileValueSchema(input, path, allowRequired) {
  if (!isSchemaRecord(input)) authorError(`${path} must be a value schema object`)
  const authorKeys = [...SCHEMA_ANNOTATIONS, ...(allowRequired ? ['required'] : [])]
  const node = {}
  const inputType = Object.hasOwn(input, 'type') ? input.type : undefined
  switch (inputType) {
    case 'json':
      assertAuthorKeys(input, path, [...authorKeys, 'type'])
      break
    case 'object': {
      assertAuthorKeys(input, path, [...authorKeys, 'type', 'properties', 'additionalProperties'])
      if (!Object.hasOwn(input, 'additionalProperties') || typeof input.additionalProperties !== 'boolean') {
        authorError(`${path}.additionalProperties must be explicitly true or false`)
      }
      node.type = 'object'
      node.additionalProperties = input.additionalProperties
      if (Object.hasOwn(input, 'properties')) {
        const compiled = compilePropertyMap(input.properties, `${path}.properties`)
        node.properties = compiled.properties
        if (compiled.required.length > 0) node.required = compiled.required
      }
      break
    }
    case 'array': {
      assertAuthorKeys(input, path, [...authorKeys, 'type', 'items'])
      node.type = 'array'
      if (Object.hasOwn(input, 'items')) node.items = compileValueSchema(input.items, `${path}.items`, false)
      break
    }
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null': {
      assertAuthorKeys(input, path, [...authorKeys, 'type', 'enum', 'const'])
      node.type = inputType
      if (Object.hasOwn(input, 'enum')) {
        if (!Array.isArray(input.enum) || input.enum.length === 0) {
          authorError(`${path}.enum must be a non-empty array of scalar values`)
        }
        node.enum = input.enum
      }
      if (Object.hasOwn(input, 'const')) node.const = input.const
      break
    }
    default:
      authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json`)
  }
  return node
}

function compilePropertyMap(input, path) {
  if (!isSchemaRecord(input)) authorError(`${path} must be an object of value schemas`)
  const properties = {}
  const required = []
  for (const [key, prop] of Object.entries(input)) {
    const p = `${path}.${key}`
    if (!isSchemaRecord(prop)) authorError(`${p} must be a value schema object`)
    if (Object.hasOwn(prop, 'required')) {
      if (prop.required !== true) authorError(`${p}.required must be true when present`)
      required.push(key)
    }
    properties[key] = compileValueSchema(prop, p, true)
  }
  return { properties, required }
}

/** 镜像 valueSchemaSpecToJsonSchema：DSL → 原始子集 schema。 */
function compileOutputSchema(spec) {
  const schema = compileValueSchema(spec, 'schema', false)
  assertSupportedJsonSchema(schema)
  return schema
}

/** 镜像 parameterSchemaSpecToJsonSchema：隐式根对象 + 逐属性 required。 */
function compileParameterSchema(spec) {
  const compiled = compilePropertyMap(spec, 'parameters')
  const schema = { type: 'object', properties: compiled.properties }
  if (compiled.required.length > 0) schema.required = compiled.required
  assertSupportedJsonSchema(schema)
  return schema
}

/** 镜像 assertSupportedJsonSchema：引擎受支持子集断言（编译后 schema 必须通过）。 */
function assertSupportedJsonSchema(schema) {
  const violations = []
  checkSchemaNode(schema, 'schema', violations)
  if (violations.length > 0) {
    throw new Error('unsupported JSON schema: ' + violations.join('; '))
  }
}

/** 镜像 assertObjectJsonSchema：agent() 结构化输出的 object 根约束。 */
function assertObjectJsonSchema(schema) {
  const violations = []
  checkSchemaNode(schema, 'schema', violations)
  if (violations.length === 0 && (!isSchemaRecord(schema) || schema.type !== 'object')) {
    violations.push('schema.type must be "object" (structured output is object-rooted)')
  }
  if (violations.length > 0) {
    throw new Error('unsupported JSON schema: ' + violations.join('; '))
  }
}

function checkSchemaNode(node, path, violations) {
  if (!isSchemaRecord(node)) {
    violations.push(`${path} must be a schema object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'].includes(key)) continue
    if (SCHEMA_ANNOTATIONS.includes(key)) continue
    violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`)
  }
  if (Object.hasOwn(node, 'oneOf')) {
    const oneOf = node.oneOf
    if (!Array.isArray(oneOf) || oneOf.length < 2) {
      violations.push(`${path}.oneOf must be an array of at least two schemas`)
    } else {
      for (const [index, branch] of oneOf.entries()) {
        checkSchemaNode(branch, `${path}.oneOf[${index}]`, violations)
      }
    }
    for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
      if (Object.hasOwn(node, key)) violations.push(`${path}.${key} is not supported beside oneOf`)
    }
    return
  }
  if (!Object.hasOwn(node, 'type')) {
    for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
      if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type`)
    }
    return
  }
  const type = node.type
  if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
    violations.push(`${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
    return
  }
  if (type === 'object') {
    if (Object.hasOwn(node, 'properties')) {
      if (!isSchemaRecord(node.properties)) {
        violations.push(`${path}.properties must be an object of schemas`)
      } else {
        for (const [key, child] of Object.entries(node.properties)) {
          checkSchemaNode(child, `${path}.properties.${key}`, violations)
        }
      }
    }
    if (Object.hasOwn(node, 'required')) {
      const required = node.required
      if (!Array.isArray(required) || required.some((x) => typeof x !== 'string')) {
        violations.push(`${path}.required must be an array of strings`)
      } else {
        for (const key of required) {
          if (!Object.hasOwn(node.properties ?? {}, key)) {
            violations.push(`${path}.required names "${key}" which is not in properties`)
          }
        }
      }
    }
    if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
      violations.push(`${path}.additionalProperties must be a boolean`)
    }
  } else if (type === 'array') {
    if (Object.hasOwn(node, 'items')) checkSchemaNode(node.items, `${path}.items`, violations)
  } else if (!Object.hasOwn(node, 'enum') && !Object.hasOwn(node, 'const')) {
    // 纯标量：无额外约束
  }
  if (type !== 'object' && (Object.hasOwn(node, 'properties') || Object.hasOwn(node, 'required') || Object.hasOwn(node, 'additionalProperties'))) {
    violations.push(`${path}.properties/required/additionalProperties is not supported on type "${type}"`)
  }
  if (type !== 'array' && Object.hasOwn(node, 'items')) {
    violations.push(`${path}.items is not supported on type "${type}"`)
  }
  if (['string', 'number', 'integer', 'boolean', 'null'].includes(type)) {
    let enumValid = true
    if (Object.hasOwn(node, 'enum')) {
      enumValid = Array.isArray(node.enum) && node.enum.length > 0 && node.enum.every((x) => scalarMatches(type, x))
      if (!enumValid) violations.push(`${path}.enum must be a non-empty array of ${type} values`)
    }
    if (Object.hasOwn(node, 'const')) {
      if (!scalarMatches(type, node.const)) {
        violations.push(`${path}.const must be a ${type} value`)
      } else if (enumValid && Array.isArray(node.enum) && !node.enum.includes(node.const)) {
        violations.push(`${path}.const must be one of ${path}.enum when both are declared`)
      }
    }
  }
}

function scalarMatches(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
    default: return false
  }
}

/** 镜像 validateJsonSchemaValue：编译后 schema 对值的校验。 */
function validateJsonSchemaValue(schema, value, path = 'value') {
  const violations = []
  checkValue(schema, value, path, violations)
  return violations
}

function checkValue(node, value, path, violations) {
  if (!Object.hasOwn(node, 'type')) return // 注解型：任意 JSON
  switch (node.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        violations.push(`"${path}" must be an object`)
        return
      }
      const properties = node.properties ?? {}
      for (const key of node.required ?? []) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) {
          violations.push(`missing required property "${path}.${key}"`)
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) continue
        checkValue(child, value[key], `${path}.${key}`, violations)
      }
      if (node.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(properties, key)) {
            violations.push(`"${path}.${key}" is not a declared property (additionalProperties: false)`)
          }
        }
      }
      break
    }
    case 'array': {
      if (!Array.isArray(value)) {
        violations.push(`"${path}" must be an array`)
        return
      }
      if (node.items !== undefined) {
        value.forEach((item, i) => checkValue(node.items, item, `${path}[${i}]`, violations))
      }
      break
    }
    default: {
      if (!scalarMatches(node.type, value)) {
        violations.push(`"${path}" must be a ${node.type}`)
        return
      }
      if (node.enum !== undefined && !node.enum.includes(value)) {
        violations.push(`"${path}" must be one of ${JSON.stringify(node.enum)}`)
      }
      if (Object.hasOwn(node, 'const') && value !== node.const) {
        violations.push(`"${path}" must be ${JSON.stringify(node.const)}`)
      }
    }
  }
}

/** stub ctx + stub workflows.start；valueByMeta 按 meta.name 返回脚本返回值。 */
function stubContext(valueByMeta) {
  const defs = []
  const requests = []
  const ctx = {
    tools: { register: (def) => defs.push(def) },
    workflows: {
      start: (request) => {
        requests.push(request)
        const value = valueByMeta(request.meta.name)
        return {
          result: Promise.resolve({ stopReason: 'completed', value }),
          cancel: () => {},
          dispose: async () => {},
          id: 'run-1',
        }
      },
    },
  }
  return { ctx, defs, requests }
}

// ════════════════════════════════════════════════════════════════════════════
// ⑧ runWorkflow 透传 issues/rounds/passed
// ════════════════════════════════════════════════════════════════════════════
test('⑧ runWorkflow 透传 issues/rounds/passed', async () => {
  const { mod } = await loadPlugin()
  const { ctx, defs, requests } = stubContext((name) => ({
    report: 'mock report',
    ...(name === 'inspect-checkup' ? { issues: [{ level: '一般', issue: 'C' }] } : {}),
    ...(name === 'inspect-fix' ? { rounds: 2 } : {}),
    ...(name === 'inspect-review' ? { issues: [{ level: '严重', issue: 'R' }], passed: true } : {}),
  }))
  mod.apply(ctx, {})
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]))
  const parent = { id: 'parent' }
  const signal = new EventTarget()
  const exec = { agent: parent, signal }

  const checkup = await byName.checkup.execute({ target: 'T' }, exec)
  assert.deepEqual(Object.keys(checkup).sort(), ['issues', 'ok', 'report'], 'checkup 透传 issues，无 rounds/passed')
  assert.deepEqual(checkup.issues, [{ level: '一般', issue: 'C' }])

  const fix = await byName.fix.execute({ task: 'T', issues: '[{"level":"一般","issue":"X"}]' }, exec)
  assert.deepEqual(Object.keys(fix).sort(), ['ok', 'report', 'rounds'], 'fix 透传 rounds，无 issues/passed')
  assert.strictEqual(fix.rounds, 2)

  const review = await byName.review.execute({ target: 'T' }, exec)
  assert.deepEqual(Object.keys(review).sort(), ['issues', 'ok', 'passed', 'report'], 'review 透传 issues+passed')
  assert.strictEqual(review.passed, true)

  // workflows.start 请求形状：脚本、meta、args、parent、signal
  assert.strictEqual(requests.length, 3)
  const fixReq = requests[1]
  assert.strictEqual(fixReq.script, SCRIPTS.fix, '透传的脚本与模块中的 FIX_SCRIPT 一致')
  assert.strictEqual(fixReq.meta.name, 'inspect-fix')
  assert.strictEqual(fixReq.parent, parent, 'parent 透传给引擎')
  assert.strictEqual(fixReq.signal, signal, 'signal 透传给引擎')
  assert.deepEqual(plain(fixReq.args.issues), [{ level: '一般', issue: 'X' }], 'issues 以解析后的数组透传')
  assert.ok(!('subagentProvider' in fixReq), '未配置时不传 subagentProvider')
})

// ════════════════════════════════════════════════════════════════════════════
// ⑨ 参数校验抛错：非数组 / 条目非对象 绝不静默降级
// ════════════════════════════════════════════════════════════════════════════
test('⑨ 参数校验抛错（非数组/条目非对象）', async () => {
  const { mod } = await loadPlugin()
  const { ctx, defs, requests } = stubContext(() => ({ report: 'r' }))
  mod.apply(ctx, {})
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]))
  const exec = { agent: { id: 'parent' }, signal: new EventTarget() }
  const started = () => requests.length

  // fix.issues
  await assert.rejects(byName.fix.execute({ task: 'T', issues: '{"a":1}' }, exec), /必须是 JSON 数组/, '非数组 JSON 抛错')
  await assert.rejects(byName.fix.execute({ task: 'T', issues: 'not json' }, exec), /必须是 JSON 数组/, '解析失败抛错')
  await assert.rejects(byName.fix.execute({ task: 'T', issues: '[1,2]' }, exec), /每个条目必须是对象/, '条目非对象抛错')
  await assert.rejects(byName.fix.execute({ task: 'T', issues: '[null]' }, exec), /每个条目必须是对象/, '条目 null 抛错')
  await assert.rejects(byName.fix.execute({ task: 'T', issues: '[[1]]' }, exec), /每个条目必须是对象/, '条目是数组抛错')
  assert.strictEqual(started(), 0, '抛错时不进入 workflows.start')

  const fixOk = await byName.fix.execute({ task: 'T', issues: '[{"level":"一般","issue":"X"}]' }, exec)
  assert.strictEqual(fixOk.ok, true)
  assert.deepEqual(plain(requests[0].args.issues), [{ level: '一般', issue: 'X' }], '合法 issues 以解析后的数组透传')

  await byName.fix.execute({ task: 'T', issues: '' }, exec)
  assert.ok(!('issues' in requests[1].args), '空串按未提供处理（不传 issues 键）')

  // review.fixed_issues
  await assert.rejects(byName.review.execute({ target: 'T', fixed_issues: '{"a":1}' }, exec), /必须是 JSON 数组/, '非数组 JSON 抛错')
  await assert.rejects(byName.review.execute({ target: 'T', fixed_issues: '[1]' }, exec), /每个条目必须是对象/, '条目非对象抛错')
  await assert.rejects(byName.review.execute({ target: 'T', fixed_issues: '[null]' }, exec), /每个条目必须是对象/, '条目 null 抛错')
  await byName.review.execute({ target: 'T', fixed_issues: '[{"level":"一般","issue":"Y"}]' }, exec)
  assert.deepEqual(plain(requests[2].args.fixed_issues), [{ level: '一般', issue: 'Y' }], '合法 fixed_issues 透传')
})

// ════════════════════════════════════════════════════════════════════════════
// ⑩ 输出 schema 编译通过 + 值校验
// ════════════════════════════════════════════════════════════════════════════
test('⑩ 输出 schema 编译通过（引擎受支持子集 + 值校验）', async () => {
  const { mod, mode } = await loadPlugin()
  const { ctx, defs } = stubContext(() => ({ report: 'r' }))
  // 注册即编译：schema 若不在引擎子集内，defineTool（真实或 mock）会抛错
  assert.doesNotThrow(() => mod.apply(ctx, {}), `${mode} 路径下三个工具注册/编译应通过`)
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]))
  for (const name of ['checkup', 'fix', 'review']) {
    const def = byName[name]
    assert.ok(def, `${name} 已注册`)
    assert.doesNotThrow(() => assertSupportedJsonSchema(def.output.schema), `${name} output.schema 应在引擎受支持子集内`)
    assert.doesNotThrow(() => assertSupportedJsonSchema(def.parameters), `${name} parameters 应编译为受支持的对象 schema`)
  }

  const checkupOut = { ok: true, report: '# r', issues: [{ level: '严重', issue: 'a', evidence: 'e' }] }
  assert.deepEqual(validateJsonSchemaValue(byName.checkup.output.schema, checkupOut), [], '合法 checkup 输出通过')
  assert.deepEqual(validateJsonSchemaValue(byName.checkup.output.schema, { ok: true, report: '# r', issues: [] }), [], '空 issues 通过')
  assert.ok(validateJsonSchemaValue(byName.checkup.output.schema, { ok: true, report: 'x', issues: [{ level: '错误', issue: 'a' }] }).length > 0, '非法 level 被拒')
  assert.ok(validateJsonSchemaValue(byName.checkup.output.schema, { ok: true, report: 'x', issues: [{ level: '严重', issue: 'a', bogus: 1 }] }).length > 0, '条目多余键被拒')
  assert.ok(validateJsonSchemaValue(byName.checkup.output.schema, { ok: true, report: 'x', extra: 1 }).length > 0, '顶层多余键被拒')
  assert.ok(validateJsonSchemaValue(byName.checkup.output.schema, { ok: true }).length > 0, '缺 report 被拒')
  assert.ok(validateJsonSchemaValue(byName.checkup.output.schema, { ok: true, report: 'x', issues: 'not-array' }).length > 0, '非数组 issues 被拒')

  assert.deepEqual(validateJsonSchemaValue(byName.fix.output.schema, { ok: true, report: 'x', rounds: 2 }), [], 'fix 输出通过')
  assert.ok(validateJsonSchemaValue(byName.fix.output.schema, { ok: true, report: 'x', rounds: '2' }).length > 0, 'rounds 非数字被拒')

  assert.deepEqual(validateJsonSchemaValue(byName.review.output.schema, { ok: true, report: 'x', issues: [], passed: true }), [], 'review 输出通过')
  assert.ok(validateJsonSchemaValue(byName.review.output.schema, { ok: true, report: 'x', issues: [], passed: 'yes' }).length > 0, 'passed 非布尔被拒')
})

// ════════════════════════════════════════════════════════════════════════════
// 模型接线：args.models 透传到 agent opts.model（角色级模型分层不被静默丢弃）
// ════════════════════════════════════════════════════════════════════════════
test('模型接线：args.models 透传到各角色 agent opts.model', async () => {
  const { prompts } = await runScript(SCRIPTS.fix, {
    task: 'T',
    issues: [{ level: '严重', issue: 'X1' }],
    models: { checker: 'cm', worker: 'wm' },
  }, {
    worker: ['impl'],
    checker: [mk([])],
  })
  const workerCall = prompts.find((p) => p.label.startsWith('实现'))
  const checkerCall = prompts.find((p) => p.label.startsWith('检查·'))
  assert.strictEqual(workerCall.opts.model, 'wm', 'worker 调用应带 models.worker')
  assert.strictEqual(checkerCall.opts.model, 'cm', 'checker 调用应带 models.checker')

  const checkup = await runScript(SCRIPTS.checkup, {
    target: 'T',
    models: { redteam: 'rm', merger: 'mm', checker: 'cm2' },
  }, {
    checker: [mk([{ level: '严重', issue: 'W' }]), mk([]), mk([])],
    redteam: [() => ({ survived: [{ level: '严重', issue: 'W' }], refuted: [], reasoning: '' })],
    merger: [echoMerger],
  })
  assert.strictEqual(checkup.prompts.find((p) => p.label === '红队').opts.model, 'rm', '红队调用应带 models.redteam')
  assert.strictEqual(checkup.prompts.find((p) => p.label === '汇总').opts.model, 'mm', '汇总调用应带 models.merger')

  const noModels = await runScript(SCRIPTS.fix, { task: 'T', issues: [{ level: '一般', issue: 'X2' }] }, {
    worker: ['impl'],
    checker: [mk([])],
  })
  assert.ok(!('model' in noModels.prompts.find((p) => p.label.startsWith('检查·')).opts), '未配置 models 时不带 model 键')
})
