/**
 * dsh-inspect regression tests.
 *
 * Run: node --test (zero dependencies: plain node + node:test/node:vm).
 *
 * Mechanism (mirrors the engine):
 * - The three workflow scripts (CHECKUP_SCRIPT / FIX_SCRIPT / REVIEW_SCRIPT)
 *   are taken from the loaded module — a real import where the dependencies
 *   resolve (tsx / dsh), otherwise the module source evaluated in vm after
 *   type stripping — so the tests run exactly what the tools ship.
 * - Each script runs in vm wrapped as '(async () => { body })()' with the
 *   engine's globals phase / log / args / agent / parallel. agent() answers
 *   from per-role mocks picked by label (null = a child that returned no
 *   result); structured calls must carry a schema in the engine's subset.
 * - The tool layer (⑧⑨⑩ and later) runs against a stub context.
 *
 * Scenarios: ① escaping and structured-output wording; ② red team (per-claim
 * verdicts, enforcement, cap, failures); ③ failed agents are reported, never
 * passed off as clean; ④ review passed states; ⑤–⑦ fix convergence; ⑪ fix
 * context; ⑧–⑩ tool layer; ⑫–⑱ engine wiring, guards, parsing, reports,
 * commands; ⑲ merge accountability; ⑳ fix verification in review; ㉑ live
 * settings; ㉒ the Plugins-page settings form (client/index.js).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'

const LIB_URL = new URL('../src/index.ts', import.meta.url)
const SRC = readFileSync(LIB_URL, 'utf8')

/** Script names as exported by the module. */
const SCRIPTS = { checkup: 'CHECKUP_SCRIPT', fix: 'FIX_SCRIPT', review: 'REVIEW_SCRIPT' }

const mk = (issues) => ({ issues })
/** The findings a merger prompt carries (the JSON after "Findings:"). */
const mergerInput = (prompt) => JSON.parse(prompt.slice(prompt.lastIndexOf('Findings:\n') + 'Findings:\n'.length))
/** Merger mock that merges nothing: one item per finding, citing its own id. */
const echoMerger = (prompt) => mk(mergerInput(prompt).map((c) => ({ issue: c.issue, ...(c.evidence ? { evidence: c.evidence } : {}), sources: [c.id] })))
/** The claim an attacker prompt is about. */
const claimOf = (prompt) => prompt.match(/\nClaim \((?:critical|major|minor)\): (.*)\n/)?.[1]
/** A red-team verdict backed by what was checked and evidence. */
const V = (verdict, extra = {}) => ({ verdict, checked: 'read src/a.ts; ran npm test', evidence: 'src/a.ts:10', reason: 'r', ...extra })
/** Red-team mock answering by claim text; an unexpected claim fails loudly. */
const attackers = (byClaim) => (prompt) => {
  const claim = claimOf(prompt)
  if (!Object.hasOwn(byClaim, claim)) throw new Error('unexpected red-team claim: ' + claim)
  const v = byClaim[claim]
  return typeof v === 'function' ? v(prompt) : v
}

/**
 * Run a workflow script in vm. roles maps a role to a mock queue (array: one
 * entry per call; null = the child returned no result; a function is called
 * as (prompt, opts)) or to a single function answering every call. Running
 * out of a queue, or an unexpected label, throws.
 * @returns {Promise<{result: any, prompts: Array<{label: string, prompt: string, opts: object}>}>}
 */
async function runScript(name, args, roles = {}) {
  const { mod } = await loadPlugin()
  const body = mod[name]
  if (typeof body !== 'string') throw new Error('script not exported by the module: ' + name)
  const state = { idx: {}, prompts: [] }
  const take = (key) => {
    const queue = roles[key]
    if (typeof queue === 'function') return queue
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
    const role = label.startsWith('Check · ') ? 'checker'
      : label.startsWith('Review · ') ? 'reviewer'
        : label.startsWith('Implement ') ? 'worker'
          : label.startsWith('Red team · ') ? 'redteam'
            : label.startsWith('Verify · ') ? 'verifier'
              : label === 'Merge' ? 'merger'
                : label === 'Planner' ? 'planner'
                  : null
    if (!role) throw new Error('unexpected agent label: ' + label)
    // Engine contract (runtime.ts asserts every agent() schema): structured
    // calls must carry a schema in the supported, object-rooted subset.
    if (role !== 'worker') {
      if (!opts.schema) throw new Error(`${label} call has no opts.schema (structured agent contract)`)
      assertObjectJsonSchema(opts.schema)
    }
    const value = take(role)
    return typeof value === 'function' ? value(prompt, opts) : value
  })
  const script = new vm.Script(`(async () => {\n${body}\n})()`, { filename: 'workflow:inspect-test' })
  const result = await Promise.resolve(script.runInContext(context))
  return { result, prompts: state.prompts }
}

const issueNames = (issues) => plain(issues).map((x) => x.issue).sort()
const promptsOf = (prompts, prefix) => prompts.filter((p) => p.label.startsWith(prefix)).map((p) => p.prompt)
/** vm values belong to another realm; a JSON round trip makes them comparable with deepEqual. */
const plain = (value) => JSON.parse(JSON.stringify(value))
const byIssue = (issues) => Object.fromEntries(plain(issues).map((x) => [x.issue, x]))

// ════════════════════════════════════════════════════════════════════════════
// ① Escaping and wording: real newlines (no literal '\n'), and structured
//    calls are told to use the structured output tool — never "JSON only",
//    which makes a child answer in plain text and lose its result.
// ════════════════════════════════════════════════════════════════════════════
test('① real newlines, structured-output wording, no "JSON only"', async () => {
  const { result, prompts } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: [
      mk([{ level: 'critical', issue: 'S1', evidence: 'e1' }, { level: 'critical', issue: 'S2', evidence: 'e2' }]),
      mk([{ level: 'major', issue: 'M1', evidence: 'e3' }]),
      mk([{ level: 'minor', issue: 'A1', evidence: 'e4' }]),
    ],
    merger: [echoMerger],
    redteam: attackers({ S1: V('confirmed'), S2: V('refuted'), M1: V('confirmed') }),
  })
  const fix = await runScript(SCRIPTS.fix, { task: 'T', issues: [{ level: 'critical', issue: 'X1' }] }, {
    worker: ['## Root cause\nx\n## Change\ny\n## Verification\nz'],
    checker: [mk([])],
  })
  const plan = await runScript(SCRIPTS.fix, { task: 'T' }, {
    planner: [{ steps: [{ title: 'S' }] }],
    worker: ['done'],
    checker: [mk([])],
  })
  const review = await runScript(SCRIPTS.review, { target: 'T', fixed_issues: [{ level: 'major', issue: 'F' }] }, {
    reviewer: [mk([]), mk([]), mk([])],
    verifier: [{ status: 'gone', checked: 'ran it', evidence: 'ok' }],
  })
  const all = [...prompts, ...fix.prompts, ...plan.prompts, ...review.prompts]
  assert.ok(all.length >= 12, `expected every role to run, got ${all.length} calls`)
  for (const { label, prompt, opts } of all) {
    assert.ok(prompt.includes('\n'), `${label}: real newlines`)
    assert.ok(!prompt.includes('\\n'), `${label}: no literal '\\n'`)
    assert.ok(!/JSON only/i.test(prompt), `${label}: must not ask for "JSON only"`)
    if (opts.schema) assert.ok(prompt.includes('structured output tool'), `${label}: points to the structured output tool`)
  }
  for (const r of [result, fix.result, review.result]) {
    assert.ok(r.report.includes('\n') && !r.report.includes('\\n'), 'reports use real newlines')
  }
})

// ════════════════════════════════════════════════════════════════════════════
// ② Red team: one attacker per critical/major claim, after the merge, with the
//    target in hand; verdicts are applied by position, never by text.
// ════════════════════════════════════════════════════════════════════════════
test('② red team: per-claim verdicts applied, refuted removed but reported', async () => {
  const { result, prompts } = await runScript(SCRIPTS.checkup, { target: 'src/', context: 'CTX' }, {
    checker: [
      mk([{ level: 'critical', issue: 'S1', evidence: 'e1', reproduce: 'npm test -- s1' }, { level: 'critical', issue: 'S2', evidence: 'e2' }]),
      mk([{ level: 'major', issue: 'M1', evidence: 'e3' }, { level: 'major', issue: 'M2', evidence: 'e4' }]),
      mk([{ level: 'minor', issue: 'A1', evidence: 'e5' }]),
    ],
    merger: [echoMerger],
    redteam: attackers({
      S1: V('confirmed'),
      S2: V('refuted', { evidence: 'guard at src/b.ts:5' }),
      M1: V('downgraded', { level: 'minor' }),
      M2: V('unverified', { checked: '', evidence: '' }),
    }),
  })
  const got = byIssue(result.issues)
  assert.deepEqual(Object.keys(got).sort(), ['A1', 'M1', 'M2', 'S1'], 'S2 refuted and removed')
  assert.deepEqual([got.S1.level, got.S1.verdict], ['critical', 'confirmed'])
  assert.deepEqual([got.M1.level, got.M1.verdict], ['minor', 'downgraded'])
  assert.deepEqual([got.M2.level, got.M2.verdict], ['major', 'unverified'])
  assert.ok(!('verdict' in got.A1), 'minor claims are not attacked and carry no verdict')

  assert.ok(result.report.includes('Attacked 4 of 4 critical/major claim(s).'))
  assert.ok(result.report.includes('confirmed: 1 · downgraded: 1 · unverified: 1'))
  assert.ok(result.report.includes('refuted: 1'))
  assert.ok(result.report.includes('- [refuted, removed] S2'), 'refuted claims stay visible')
  assert.ok(result.report.includes('evidence: guard at src/b.ts:5'), 'with their counter-evidence')
  assert.ok(result.report.includes('- [downgraded, major → minor] M1'))

  const s1 = promptsOf(prompts, 'Red team · ').find((p) => claimOf(p) === 'S1')
  assert.ok(s1.includes('this target: src/') && s1.includes('Context: CTX'), 'the attacker gets the target and context')
  assert.ok(s1.includes('Evidence given: e1') && s1.includes('npm test -- s1'), 'and the claim evidence and reproduction')
  assert.ok(s1.includes('Use your tools') && s1.includes('Do not edit project files'), 'and is told to use tools without editing the project')
  assert.ok(!s1.includes('S2') && !s1.includes('M1'), 'an attacker sees only its own claim')
})

test('② red team: a decisive verdict without checked/evidence counts as unverified; an unverified critical drops to major', async () => {
  const { result } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: [mk([{ level: 'critical', issue: 'X', evidence: 'e' }, { level: 'critical', issue: 'Y', evidence: 'e' }]), mk([]), mk([])],
    merger: [echoMerger],
    redteam: attackers({
      X: { verdict: 'refuted', checked: '', evidence: '', reason: 'looks fine to me' },
      Y: { verdict: 'confirmed', checked: 'read a.ts', evidence: '  ', reason: 'r' },
    }),
  })
  const got = byIssue(result.issues)
  assert.deepEqual([got.X.level, got.X.verdict], ['major', 'unverified'], 'an unbacked refutation does not remove the claim')
  assert.deepEqual([got.Y.level, got.Y.verdict], ['major', 'unverified'], 'an unbacked confirmation is not a confirmation')
  assert.ok(result.report.includes('- [unverified, critical → major] X'))
})

test('② red team: a "downgrade" can never raise a level', async () => {
  const { result } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: [mk([{ level: 'major', issue: 'Y', evidence: 'e' }]), mk([]), mk([])],
    redteam: attackers({ Y: V('downgraded', { level: 'critical' }) }),
  })
  assert.deepEqual(plain(result.issues), [{ level: 'major', issue: 'Y', evidence: 'e', verdict: 'confirmed' }])
})

test('② red team: an attacker that returns nothing leaves its claim kept and marked "not attacked"', async () => {
  const { result } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: [mk([{ level: 'critical', issue: 'X', evidence: 'e' }, { level: 'major', issue: 'Y', evidence: 'e' }]), mk([]), mk([])],
    merger: [echoMerger],
    redteam: attackers({ X: null, Y: V('confirmed') }),
  })
  const got = byIssue(result.issues)
  assert.deepEqual([got.X.level, got.X.verdict], ['critical', 'not attacked'])
  assert.ok(result.report.includes('1 attacker(s) returned no result'))
  assert.ok(result.report.includes('- [no result] X'))
})

test('② red team: criticals first and always; the cap applies to the rest', async () => {
  const C = (i) => ({ level: 'critical', issue: 'C' + i, evidence: 'e' })
  const J = (i) => ({ level: 'major', issue: 'J' + i, evidence: 'e' })
  const { result, prompts } = await runScript(SCRIPTS.checkup, { target: 'T', redteamMax: 4 }, {
    checker: [mk([J(1), C(1), J(2)]), mk([C(2), J(3)]), mk([C(3), J(4)])],
    merger: [echoMerger],
    redteam: attackers({ C1: V('confirmed'), C2: V('confirmed'), C3: V('confirmed'), J1: V('confirmed') }),
  })
  assert.deepEqual(promptsOf(prompts, 'Red team · ').map(claimOf), ['C1', 'C2', 'C3', 'J1'], 'criticals first, then majors in order')
  const got = byIssue(result.issues)
  for (const k of ['J2', 'J3', 'J4']) assert.equal(got[k].verdict, 'not attacked')
  assert.ok(result.report.includes('Attacked 4 of 7'))
  assert.ok(result.report.includes('3 were over the redteamMaxClaims limit'))

  const one = await runScript(SCRIPTS.checkup, { target: 'T', redteamMax: 1 }, {
    checker: [mk([C(1), C(2), J(1)]), mk([]), mk([])],
    merger: [echoMerger],
    redteam: attackers({ C1: V('confirmed'), C2: V('confirmed') }),
  })
  assert.deepEqual(promptsOf(one.prompts, 'Red team · ').map(claimOf), ['C1', 'C2'], 'a cap below the critical count still attacks every critical')

  const J5 = [1, 2, 3, 4, 5].map(J)
  const zero = await runScript(SCRIPTS.checkup, { target: 'T', redteamMax: 0 }, {
    checker: [mk([C(1), ...J5]), mk([]), mk([])],
    merger: [echoMerger],
    redteam: () => V('confirmed'),
  })
  assert.equal(promptsOf(zero.prompts, 'Red team · ').length, 6, 'a cap of 0 means no limit')
  assert.ok(zero.result.report.includes('Attacked 6 of 6 critical/major claim(s).'))
})

test('② red team: redteamMinLevel picks the attacked levels', async () => {
  const C = { level: 'critical', issue: 'C1', evidence: 'e' }
  const J = { level: 'major', issue: 'J1', evidence: 'e' }
  const N = (i) => ({ level: 'minor', issue: 'N' + i, evidence: 'e' })

  // minor: every claim, minors last; a refuted minor is removed like any other.
  const all = await runScript(SCRIPTS.checkup, { target: 'T', redteamMinLevel: 'minor', redteamMax: 0 }, {
    checker: [mk([N(1), J, C, N(2)]), mk([]), mk([])],
    merger: [echoMerger],
    redteam: attackers({ C1: V('confirmed'), J1: V('confirmed'), N1: V('refuted'), N2: V('unverified') }),
  })
  assert.deepEqual(promptsOf(all.prompts, 'Red team · ').map(claimOf), ['C1', 'J1', 'N1', 'N2'])
  const got = byIssue(all.result.issues)
  assert.ok(!('N1' in got), 'refuted minor removed')
  assert.equal(got.N2.verdict, 'unverified')
  assert.equal(got.N2.level, 'minor')
  assert.ok(all.result.report.includes('Attacked 4 of 4 claim(s).'))

  // minor with a cap: minors over the cap are marked "not attacked".
  const capped = await runScript(SCRIPTS.checkup, { target: 'T', redteamMinLevel: 'minor', redteamMax: 2 }, {
    checker: [mk([N(1), J, C]), mk([]), mk([])],
    merger: [echoMerger],
    redteam: attackers({ C1: V('confirmed'), J1: V('confirmed') }),
  })
  assert.equal(byIssue(capped.result.issues).N1.verdict, 'not attacked')

  // critical: majors and minors are not attacked and carry no verdict.
  const crit = await runScript(SCRIPTS.review, { target: 'T', redteamMinLevel: 'critical' }, {
    reviewer: [mk([J, C, N(1)]), mk([]), mk([])],
    merger: [echoMerger],
    redteam: attackers({ C1: V('confirmed') }),
  })
  assert.deepEqual(promptsOf(crit.prompts, 'Red team · ').map(claimOf), ['C1'])
  const cg = byIssue(crit.result.issues)
  assert.ok(!('verdict' in cg.J1) && !('verdict' in cg.N1), 'below the level: no verdict')
  assert.ok(crit.result.report.includes('Attacked 1 of 1 critical claim(s).'))

  const none = await runScript(SCRIPTS.checkup, { target: 'T', redteamMinLevel: 'critical' }, {
    checker: [mk([J]), mk([]), mk([])],
  })
  assert.ok(none.result.report.includes('(No critical problems to attack.)'))
})

test('② red team: nothing critical or major → no attacker runs', async () => {
  const { result, prompts } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: [mk([{ level: 'minor', issue: 'A1', evidence: 'e' }]), mk([]), mk([])],
  })
  assert.deepEqual(issueNames(result.issues), ['A1'])
  assert.ok(!prompts.some((p) => p.label.startsWith('Red team')), 'no attacker for minor-only findings')
  assert.ok(result.report.includes('(No critical or major problems to attack.)'))
})

// ════════════════════════════════════════════════════════════════════════════
// ③ Failed agents (checker / reviewer / merger / worker) are reported, never
//    passed off as "no problems".
// ════════════════════════════════════════════════════════════════════════════
test('③ checkup: every checker failed → reported, "no problems" not claimed', async () => {
  const { result, prompts } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: [null, null, null],
  })
  assert.deepEqual(plain(result.issues), [])
  assert.ok(!prompts.some((p) => p.label === 'Merge'), 'nothing to merge')
  assert.ok(result.report.includes('3 checker(s) returned no result'))
  assert.ok(result.report.includes('"no problems" cannot be confirmed'))
  assert.ok(!result.report.includes('(No problems found.)'))
})

test('③ checkup: some checkers failed → counted, the rest still processed', async () => {
  const { result } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: [
      mk([{ level: 'critical', issue: 'S1', evidence: 'e1' }, { level: 'major', issue: 'M1', evidence: 'e5' }]),
      mk([{ level: 'minor', issue: 'A1', evidence: 'e7' }]),
      null,
    ],
    merger: [echoMerger],
    redteam: attackers({ S1: V('confirmed'), M1: V('confirmed') }),
  })
  assert.deepEqual(issueNames(result.issues), ['A1', 'M1', 'S1'])
  assert.ok(result.report.includes('1 checker(s) returned no result'))
})

test('③ checkup: merger failed → every finding kept, not deduplicated', async () => {
  const { result } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: [
      mk([{ level: 'critical', issue: 'S1', evidence: 'e1' }]),
      mk([{ level: 'critical', issue: 'S1', evidence: 'e1' }, { level: 'minor', issue: 'A1', evidence: 'e7' }]),
      mk([]),
    ],
    merger: [null],
    redteam: attackers({ S1: V('confirmed') }),
  })
  assert.deepEqual(issueNames(result.issues), ['A1', 'S1', 'S1'], 'duplicates kept rather than anything lost')
  assert.ok(result.report.includes('the merger returned no result (all findings kept, not deduplicated)'))
})

test('③ review: every reviewer failed → passed=false, verdict unconfirmed', async () => {
  const { result } = await runScript(SCRIPTS.review, { target: 'T' }, {
    reviewer: [null, null, null],
  })
  assert.deepEqual(plain(result.issues), [])
  assert.strictEqual(result.passed, false)
  assert.ok(result.report.includes('3 reviewer(s) returned no result'))
  assert.ok(result.report.includes('the delivery verdict is unconfirmed'))
  assert.ok(!result.report.includes('(No problems found.)'))
  assert.ok(!result.report.includes('ready to deliver'))
})

test('③ review: merger failed → every finding kept + passed=false', async () => {
  const { result } = await runScript(SCRIPTS.review, { target: 'T' }, {
    reviewer: [
      mk([{ level: 'critical', issue: 'R1', evidence: 'e1' }, { level: 'minor', issue: 'R2', evidence: 'e2' }]),
      mk([{ level: 'major', issue: 'R3', evidence: 'e3' }]),
      mk([]),
    ],
    merger: [null],
    redteam: attackers({ R1: V('confirmed'), R3: V('confirmed') }),
  })
  assert.strictEqual(result.issues.length, 3)
  assert.strictEqual(result.passed, false)
  assert.ok(result.report.includes('the merger returned no result (all findings kept, not deduplicated)'))
})

test('③ fix: an implementer returned nothing → no check that round, only that step is implemented again', async () => {
  const { result, prompts } = await runScript(SCRIPTS.fix, {
    task: 'T',
    issues: [{ level: 'critical', issue: 'A' }, { level: 'major', issue: 'B' }],
  }, {
    worker: ['impl A', null, 'impl B'],
    checker: [mk([])],
  })
  assert.strictEqual(result.rounds, 2)
  const workers = promptsOf(prompts, 'Implement ')
  assert.strictEqual(workers.length, 3, 'A once, B twice')
  assert.ok(workers[2].includes('Problem: B') && !workers[2].includes('Problem: A'), 'round 2 re-runs only the failed step')
  assert.strictEqual(promptsOf(prompts, 'Check · ').length, 1, 'no check while a step has no output')
  assert.ok(result.report.includes('Round 1: an implementer returned no result — unverified'))
  assert.ok(result.report.includes('Round 2: passed'))
  assert.strictEqual((result.report.match(/Round \d+: passed/g) ?? []).length, 1)
  assert.ok(result.report.includes('impl A') && result.report.includes('impl B'))
  assert.strictEqual(result.converged, true)
})

test('③ fix: implementers run one at a time (shared working tree)', async () => {
  let active = 0
  let peak = 0
  const slow = (out) => async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((r) => setTimeout(r, 5))
    active -= 1
    return out
  }
  const { result } = await runScript(SCRIPTS.fix, {
    task: 'T',
    issues: [{ level: 'major', issue: 'A' }, { level: 'major', issue: 'B' }, { level: 'major', issue: 'C' }],
  }, {
    worker: [slow('a'), slow('b'), slow('c')],
    checker: [mk([])],
  })
  assert.strictEqual(peak, 1, 'never two implementers at once')
  assert.strictEqual(result.converged, true)
})

// ════════════════════════════════════════════════════════════════════════════
// ④ review passed: true only when clean and fully run
// ════════════════════════════════════════════════════════════════════════════
test('④ review passed states', async (t) => {
  await t.test('clean → passed=true', async () => {
    const { result } = await runScript(SCRIPTS.review, { target: 'T' }, {
      reviewer: [mk([]), mk([]), mk([])],
    })
    assert.strictEqual(result.passed, true)
    assert.ok(result.report.includes('(No problems found.)'))
    assert.ok(result.report.includes('ready to deliver'))
  })

  await t.test('minor only → passed=true', async () => {
    const { result } = await runScript(SCRIPTS.review, { target: 'T' }, {
      reviewer: [mk([{ level: 'minor', issue: 'A', evidence: 'e' }]), mk([]), mk([])],
    })
    assert.strictEqual(result.passed, true)
  })

  await t.test('a confirmed major → passed=false', async () => {
    const { result } = await runScript(SCRIPTS.review, { target: 'T' }, {
      reviewer: [mk([{ level: 'major', issue: 'R1', evidence: 'e' }]), mk([]), mk([])],
      redteam: attackers({ R1: V('confirmed') }),
    })
    assert.strictEqual(result.passed, false)
    assert.ok(result.report.includes('critical/major problems: 1'))
    assert.ok(result.report.includes('fix these before delivering'))
  })

  await t.test('a refuted major → passed=true', async () => {
    const { result } = await runScript(SCRIPTS.review, { target: 'T' }, {
      reviewer: [mk([{ level: 'major', issue: 'R1', evidence: 'e' }]), mk([]), mk([])],
      redteam: attackers({ R1: V('refuted') }),
    })
    assert.strictEqual(result.passed, true)
    assert.ok(result.report.includes('- [refuted, removed] R1'))
  })

  await t.test('a reviewer returned nothing → passed=false (unconfirmed)', async () => {
    const { result } = await runScript(SCRIPTS.review, { target: 'T' }, {
      reviewer: [mk([]), mk([]), null],
    })
    assert.strictEqual(result.passed, false)
    assert.ok(result.report.includes('1 reviewer(s) returned no result'))
    assert.ok(result.report.includes('the delivery verdict is unconfirmed'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ⑤ fix: a failed checker is never taken as "passed"
// ════════════════════════════════════════════════════════════════════════════
test('⑤ fix: checker null ×3 → unverified rounds, no false pass, honest "not converged"', async () => {
  const { result, prompts } = await runScript(SCRIPTS.fix, { task: 'T', issues: [{ level: 'critical', issue: 'X1', evidence: 'ev' }] }, {
    worker: ['fix attempt 1'],
    checker: [null, null, null],
  })
  assert.strictEqual(result.rounds, 3)
  assert.strictEqual(promptsOf(prompts, 'Implement ').length, 1, 'the work is re-checked, not re-implemented')
  const unverified = result.report.match(/Round \d+: the checker returned no result — unverified/g) ?? []
  assert.strictEqual(unverified.length, 3)
  assert.strictEqual((result.report.match(/Round \d+: passed/g) ?? []).length, 0)
  assert.ok(result.report.includes('Not converged'))
  assert.ok(result.report.slice(result.report.indexOf('## Conclusion')).includes('X1'))
  assert.strictEqual(result.converged, false)
  assert.deepEqual(plain(result.remaining), [{ level: 'critical', issue: 'X1', evidence: 'ev' }])
  assert.ok(result.report.includes('### Fix: X1 (not checked: the run ended before a check passed)\nfix attempt 1'), 'unchecked work is still shown')
})

test('⑤ fix: checker null, then a pass → the unverified round is recorded', async () => {
  const { result, prompts } = await runScript(SCRIPTS.fix, { task: 'T', issues: [{ level: 'critical', issue: 'X1' }] }, {
    worker: ['impl 1'],
    checker: [null, mk([])],
  })
  assert.strictEqual(result.rounds, 2)
  assert.strictEqual(promptsOf(prompts, 'Implement ').length, 1, 'no re-implementation after a failed check')
  assert.ok(result.report.includes('Round 1: the checker returned no result — unverified'))
  assert.ok(result.report.includes('Round 2: passed'))
  assert.ok(!result.report.includes('Not converged'))
  assert.strictEqual(result.converged, true)
  assert.deepEqual(plain(result.remaining), [])
})

// ════════════════════════════════════════════════════════════════════════════
// ⑥ Every problem the checker finds goes into the next round (none sliced away)
// ════════════════════════════════════════════════════════════════════════════
test('⑥ all 4 problems go into the next round', async () => {
  const P = (i) => ({ level: 'major', issue: 'P' + i, evidence: 'e' })
  const issues4 = [P(1), P(2), P(3), P(4)]
  const { result } = await runScript(SCRIPTS.fix, { task: 'T', issues: issues4 }, {
    worker: ['impl P1', 'impl P2', 'impl P3', 'impl P4', 're-impl P1', 're-impl P2', 're-impl P3', 're-impl P4'],
    checker: [mk([P(1), P(2), P(3), P(4)]), mk([])],
  })
  assert.strictEqual(result.rounds, 2)
  assert.ok(result.report.includes('Round 1: 4 problem(s)'))
  assert.ok(result.report.includes('Round 2: passed'))
  assert.ok(result.report.includes('re-impl P4'))
  assert.strictEqual((result.report.match(/^### .*$/gm) ?? []).length, 8, '4 original + 4 follow-up steps')
  assert.ok(!result.report.includes('Not converged'))
})

// ════════════════════════════════════════════════════════════════════════════
// ⑦ Rounds exhausted: the remaining problems are listed and returned
// ════════════════════════════════════════════════════════════════════════════
test('⑦ rounds exhausted → remaining problems listed and returned', async () => {
  const P = (i) => ({ level: 'critical', issue: '问题P' + i, evidence: '证据' + i })
  const issues4 = [P(1), P(2), P(3), P(4)]
  const { result } = await runScript(SCRIPTS.fix, { task: 'T', issues: issues4 }, {
    worker: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w10', 'w11', 'w12'],
    checker: [mk([P(1), P(2), P(3), P(4)]), mk([P(1), P(2), P(3), P(4)]), mk([P(1), P(2), P(3), P(4)])],
  })
  assert.strictEqual(result.rounds, 3)
  const conclusion = result.report.slice(result.report.indexOf('## Conclusion'))
  assert.ok(conclusion.includes('exceeded the 3-round limit'))
  for (const p of issues4) assert.ok(conclusion.includes(p.issue))
  assert.ok(conclusion.includes('Feed the remaining problems back into fix to continue.'))
  assert.strictEqual(result.converged, false)
  assert.deepEqual(plain(result.remaining), issues4, 'remaining is a valid issue list for the next fix call')

  // maxRounds (the fixMaxRounds setting) moves the limit.
  const one = await runScript(SCRIPTS.fix, { task: 'T', issues: [P(1)], maxRounds: 1 }, {
    worker: ['w1'],
    checker: [mk([P(1)])],
  })
  assert.strictEqual(one.result.rounds, 1)
  assert.ok(one.result.report.includes('exceeded the 1-round limit'))
})

// ════════════════════════════════════════════════════════════════════════════
// ⑪ fix context: every round carries the overall task and acceptance; from
//    round 2 on, also length-capped excerpts of earlier rounds.
// ════════════════════════════════════════════════════════════════════════════
test('⑪ fix: round 1 already sees the task; round 2 adds the round-1 excerpt', async () => {
  const LONG = 'y'.repeat(2000)
  const { result, prompts } = await runScript(SCRIPTS.fix, {
    task: '原始任务T',
    acceptance: '原始验收标准A',
    issues: [{ level: 'critical', issue: 'X1', evidence: 'ev1', reproduce: 'run x1' }],
  }, {
    worker: ['round 1 output: ' + LONG, 'round 2 output: fixed C1'],
    checker: [mk([{ level: 'critical', issue: 'C1', evidence: 'e1', reproduce: 'run c1' }]), mk([])],
  })
  assert.strictEqual(result.rounds, 2)
  const [w1, w2] = promptsOf(prompts, 'Implement ')
  const [c1, c2] = promptsOf(prompts, 'Check · ')
  for (const p of [w1, c1, w2, c2]) {
    assert.ok(p.includes('Overall task: 原始任务T'), 'every prompt carries the task')
    assert.ok(p.includes('Overall acceptance criteria: 原始验收标准A'), 'and the acceptance criteria')
  }
  assert.ok(w1.includes('How to reproduce: run x1'), 'the reproduction reaches the implementer')
  assert.ok(!w1.includes('Previous round output') && !c1.includes('Previous round output'), 'no history in round 1')
  for (const p of [w2, c2]) {
    assert.ok(p.includes('Previous round output (the object being checked, excerpt)'))
    assert.ok(p.includes('Round 1 output (excerpt):'))
    assert.ok(p.includes('[Task] Fix: X1'))
    assert.ok(p.includes('y'.repeat(1000)))
    assert.ok(!p.includes(LONG), 'excerpts are length-capped')
  }
  assert.ok(w2.includes('Problem: C1') && w2.includes('How to reproduce: run c1'))
})

test('⑪ fix: round 3 carries excerpts of both earlier rounds', async () => {
  const { result, prompts } = await runScript(SCRIPTS.fix, {
    task: '原始任务T',
    acceptance: '原始验收标准A',
    issues: [{ level: 'critical', issue: 'X1' }],
  }, {
    worker: ['w1', 'w2', 'w3'],
    checker: [mk([{ level: 'major', issue: 'C1', evidence: 'e' }]), mk([{ level: 'major', issue: 'C2', evidence: 'e' }]), mk([])],
  })
  assert.strictEqual(result.rounds, 3)
  const [w3] = promptsOf(prompts, 'Implement ').slice(2)
  const [c3] = promptsOf(prompts, 'Check · ').slice(2)
  for (const p of [w3, c3]) {
    assert.ok(p.includes('Round 1 output (excerpt):') && p.includes('Round 2 output (excerpt):'))
    assert.ok(p.includes('Overall task: 原始任务T'))
    assert.ok(p.includes('w1') && p.includes('w2'))
    assert.ok(p.includes('[Task] Fix: X1'))
  }
})

// ════════════════════════════════════════════════════════════════════════════
// ⑲ Merge accountability: the merger only deduplicates. Levels come from the
//    sources, a finding it leaves out comes back, an item citing no finding is
//    dropped — so a merger cannot lose, invent or re-grade a problem.
// ════════════════════════════════════════════════════════════════════════════
test('⑲ merge: levels from sources, omissions re-added, uncited items dropped', async () => {
  const { result, prompts } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: [
      mk([{ level: 'major', issue: 'leak in pool', evidence: 'pool.ts:3' }]),
      mk([{ level: 'critical', issue: 'pool never frees', evidence: 'pool.ts:9', reproduce: 'run soak' }]),
      mk([{ level: 'minor', issue: 'typo', evidence: 'README:1' }]),
    ],
    merger: [(prompt) => {
      const ids = mergerInput(prompt).map((c) => c.id)
      assert.deepEqual(ids, ['F1', 'F2', 'F3'], 'findings are numbered')
      return mk([
        { issue: 'Pool leaks connections', sources: ['F1', 'F2'] },
        { issue: 'Something the merger made up', sources: [] },
        { issue: 'Bogus id', sources: ['F99'] },
      ])
    }],
    redteam: attackers({ 'Pool leaks connections': V('confirmed') }),
  })
  const got = byIssue(result.issues)
  assert.deepEqual(Object.keys(got).sort(), ['Pool leaks connections', 'typo'])
  assert.strictEqual(got['Pool leaks connections'].level, 'critical', 'the highest source level, not the merger\'s')
  assert.strictEqual(got['Pool leaks connections'].evidence, 'pool.ts:9', 'evidence from the strongest source when the merger gives none')
  assert.strictEqual(got['Pool leaks connections'].reproduce, 'run soak')
  assert.strictEqual(got.typo.level, 'minor', 'F3 was left out and is added back')
  assert.ok(result.report.includes('the merger left out 1 finding(s); they were added back unmerged'))
  assert.ok(result.report.includes('2 merged item(s) cited no finding and were dropped'))
  const mergeCall = prompts.find((p) => p.label === 'Merge')
  assert.deepEqual(plain(mergeCall.opts.schema.properties.issues.items.properties.sources.items.enum), ['F1', 'F2', 'F3'], 'ids are limited to real findings')
  assert.ok(!('level' in mergeCall.opts.schema.properties.issues.items.properties), 'the merger does not set levels')
})

test('⑲ merge: a single finding skips the merger', async () => {
  const { prompts } = await runScript(SCRIPTS.checkup, { target: 'T' }, {
    checker: [mk([{ level: 'minor', issue: 'A', evidence: 'e' }]), mk([]), mk([])],
  })
  assert.ok(!prompts.some((p) => p.label === 'Merge'))
})

test('⑲ review: a merger that drops a critical cannot make the review pass', async () => {
  const { result } = await runScript(SCRIPTS.review, { target: 'T' }, {
    reviewer: [mk([{ level: 'critical', issue: 'R1', evidence: 'e1' }]), mk([{ level: 'minor', issue: 'R2', evidence: 'e2' }]), mk([])],
    merger: [mk([{ issue: 'R2', sources: ['F2'] }])],
    redteam: attackers({ R1: V('confirmed') }),
  })
  assert.strictEqual(result.passed, false)
  assert.strictEqual(byIssue(result.issues).R1.level, 'critical')
  assert.ok(result.report.includes('the merger left out 1 finding(s)'))
})

// ════════════════════════════════════════════════════════════════════════════
// ⑳ review fixed_issues: one verifier per fix, a recorded status for each
// ════════════════════════════════════════════════════════════════════════════
test('⑳ review: each fix verified separately with a recorded status', async () => {
  const fixes = [
    { level: 'critical', issue: 'F-gone', evidence: 'before', reproduce: 'run a' },
    { level: 'major', issue: 'F-still' },
    { level: 'major', issue: 'F-unbacked' },
    { level: 'minor', issue: 'F-null' },
  ]
  const { result, prompts } = await runScript(SCRIPTS.review, { target: 'T', fixed_issues: fixes }, {
    reviewer: [mk([]), mk([]), mk([])],
    verifier: [
      { status: 'gone', checked: 'ran a', evidence: 'exit 0' },
      { status: 'still present', checked: 'ran b', evidence: 'still fails: E42' },
      { status: 'gone', checked: '', evidence: '' },
      null,
    ],
  })
  const reviewers = promptsOf(prompts, 'Review · ')
  assert.ok(reviewers.every((p) => !p.includes('F-gone')), 'reviewers no longer each re-verify every fix')
  const verifiers = promptsOf(prompts, 'Verify · ')
  assert.strictEqual(verifiers.length, 4)
  assert.ok(verifiers[0].includes('Evidence from before the fix: before') && verifiers[0].includes('How it was reproduced: run a'))
  assert.ok(result.report.includes('## Fix verification'))
  assert.ok(result.report.includes('- [gone] F-gone — evidence: exit 0'))
  assert.ok(result.report.includes('- [still present] F-still — evidence: still fails: E42'))
  assert.ok(result.report.includes('- [unverified] F-unbacked'), 'a status without evidence is unverified')
  assert.ok(result.report.includes('- [unverified] F-null (the verifier returned no result)'))
  const got = byIssue(result.issues)
  assert.deepEqual([got['Fix did not hold: F-still'].level, got['Fix did not hold: F-still'].evidence], ['critical', 'still fails: E42'])
  assert.strictEqual(result.passed, false)

  const ok = await runScript(SCRIPTS.review, { target: 'T', fixed_issues: [fixes[0]] }, {
    reviewer: [mk([]), mk([]), mk([])],
    verifier: [{ status: 'gone', checked: 'ran a', evidence: 'exit 0' }],
  })
  assert.strictEqual(ok.result.passed, true, 'every fix verified gone and nothing else open')

  const open = await runScript(SCRIPTS.review, { target: 'T', fixed_issues: [fixes[2]] }, {
    reviewer: [mk([]), mk([]), mk([])],
    verifier: [{ status: 'unverified', checked: 'tried', evidence: 'no test env' }],
  })
  assert.strictEqual(open.result.passed, false, 'an unverified fix leaves the verdict open')
  assert.ok(open.result.report.includes('1 fix(es) could not be verified; the delivery verdict is unconfirmed.'))
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
// source: the TS source (types stripped first) or the compiled lib/types/index.js.
function evaluateModuleInVm(source = SRC, { typescript = true } = {}) {
  let src = source
  if (typescript) src = stripTypeScriptTypes(src) // throws on non-erasable syntax — keeps the source portable
  // Every import is replaced by an injected mock (z, defineTool, createUserMessage) or is type-only.
  src = src.replaceAll(/^import [^\n]*$/gm, '')
  src = src.replaceAll(/\bexport\s+/g, '')
  src += '\n;globalThis.__inspectExports = { name, inject, Config, apply, splitList, compactReport, INLINE_REPORT_LIMIT, COMMANDS, registerCommands, CHECKUP_SCRIPT, FIX_SCRIPT, REVIEW_SCRIPT }\n'
  const defs = []
  // schemastery 链式 mock：Config 只在模块加载时构造，行为不被测试使用。
  // 自引用代理：z.natural() 的返回值也必须是同一代理（.min 等链式调用才能命中 trap）。
  const zChain = new Proxy(() => undefined, { get: () => zChain, apply: () => zChain })
  const context = vm.createContext({
    createUserMessage: (input) => ({ ...input, id: 'msg-1', role: 'user' }),
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
  // 模拟 cordis 的宽松读取：ctx.get(name) 不做 inject 检查，缺服务返回 undefined。
  ctx.get = (name) => ctx[name]
  return { ctx, defs, requests }
}

// ════════════════════════════════════════════════════════════════════════════
// ⑧ runWorkflow 透传 issues/rounds/passed
// ════════════════════════════════════════════════════════════════════════════
test('⑧ runWorkflow 透传 issues/rounds/passed', async () => {
  const { mod } = await loadPlugin()
  const { ctx, defs, requests } = stubContext((name) => ({
    report: 'mock report',
    ...(name === 'inspect-checkup' ? { issues: [{ level: 'major', issue: 'C' }] } : {}),
    ...(name === 'inspect-fix' ? { rounds: 2, converged: false, remaining: [{ level: 'major', issue: 'left' }] } : {}),
    ...(name === 'inspect-review' ? { issues: [{ level: 'critical', issue: 'R' }], passed: true } : {}),
  }))
  mod.apply(ctx, {})
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]))
  const parent = { id: 'parent' }
  const signal = new EventTarget()
  const exec = { agent: parent, signal }

  const checkup = await byName.checkup.execute({ target: 'T' }, exec)
  assert.deepEqual(Object.keys(checkup).sort(), ['issues', 'ok', 'report'], 'checkup 透传 issues，无 rounds/passed')
  assert.deepEqual(checkup.issues, [{ level: 'major', issue: 'C' }])

  const fix = await byName.fix.execute({ task: 'T', issues: '[{"level":"major","issue":"X"}]' }, exec)
  assert.deepEqual(Object.keys(fix).sort(), ['converged', 'ok', 'remaining', 'report', 'rounds'], 'fix passes rounds, converged and remaining through')
  assert.strictEqual(fix.rounds, 2)
  assert.strictEqual(fix.converged, false)
  assert.deepEqual(fix.remaining, [{ level: 'major', issue: 'left' }])

  const review = await byName.review.execute({ target: 'T' }, exec)
  assert.deepEqual(Object.keys(review).sort(), ['issues', 'ok', 'passed', 'report'], 'review 透传 issues+passed')
  assert.strictEqual(review.passed, true)

  // workflows.start 请求形状：脚本、meta、args、parent、signal
  assert.strictEqual(requests.length, 3)
  const fixReq = requests[1]
  assert.strictEqual(fixReq.script, mod.FIX_SCRIPT, '透传的脚本与模块中的 FIX_SCRIPT 一致')
  assert.strictEqual(fixReq.meta.name, 'inspect-fix')
  assert.strictEqual(fixReq.parent, parent, 'parent 透传给引擎')
  assert.strictEqual(fixReq.signal, signal, 'signal 透传给引擎')
  assert.deepEqual(plain(fixReq.args.issues), [{ level: 'major', issue: 'X' }], 'issues 以解析后的数组透传')
  assert.ok(!('subagentProvider' in fixReq), '未配置时不传 subagentProvider')

  // 配置语义：maxTotalAgents 为 null/undefined 时请求省略该键（引擎用默认上限），
  // 绝不写入 0；0 在 apply 时即被正数校验拒绝（fail loud，与旧 JS 一致）。
  const { ctx: nullCtx, defs: nullDefs, requests: nullReqs } = stubContext(() => ({ report: 'r' }))
  mod.apply(nullCtx, { maxTotalAgents: null })
  const nullExec = { agent: parent, signal }
  await nullDefs[0].execute({ target: 'T' }, nullExec)
  assert.strictEqual(nullReqs.length, 1)
  assert.ok(!('maxTotalAgents' in nullReqs[0]), 'maxTotalAgents: null 不写入请求（引擎默认）')
  const zeroCtx = stubContext(() => ({ report: 'r' })).ctx
  assert.throws(() => mod.apply(zeroCtx, { maxTotalAgents: 0 }), /positive integer/, 'maxTotalAgents: 0 在 apply 即拒绝')

  // redteamMaxClaims reaches checkup and review (not fix); omitted, the script default applies.
  const rt = stubContext(() => ({ report: 'r' }))
  mod.apply(rt.ctx, { redteamMaxClaims: 2 })
  const rtByName = Object.fromEntries(rt.defs.map((d) => [d.name, d]))
  await rtByName.checkup.execute({ target: 'T' }, exec)
  await rtByName.fix.execute({ task: 'T' }, exec)
  await rtByName.review.execute({ target: 'T' }, exec)
  assert.deepEqual(rt.requests.map((r) => r.args.redteamMax ?? null), [2, null, 2])
  assert.ok(!('redteamMax' in requests[0].args), 'not configured → not sent')
  assert.throws(() => mod.apply(stubContext(() => ({})).ctx, { redteamMaxClaims: -1 }), /non-negative integer/)
  assert.deepEqual(plain(requests[2].meta.phases).map((p) => p.title), ['Review', 'Red team', 'Verify fixes'], 'review declares every phase it enters')
  assert.equal(plain(requests[1].meta.phases).length, 7, 'fix declares Plan + 3 implement + 3 check rounds by default')
  assert.ok(!('maxRounds' in requests[1].args), 'fixMaxRounds not configured → not sent')
})

// ════════════════════════════════════════════════════════════════════════════
// ㉑ Settings are volatile: edits in dsh settings apply to the next call
// ════════════════════════════════════════════════════════════════════════════
test('㉑ settings: live references are re-read on every call', async () => {
  const { mod } = await loadPlugin()
  const live = (value) => ({ value, get() { return this.value } })
  const cfg = {
    redteamMaxClaims: live(6),
    redteamMinLevel: live('major'),
    fixMaxRounds: live(undefined),
    maxTotalAgents: live(undefined),
    checkerModel: live(undefined),
    subagentProvider: live(''),
  }
  const { ctx, defs, requests } = stubContext(() => ({ report: 'r' }))
  mod.apply(ctx, cfg)
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]))
  const exec = { agent: { id: 'parent' }, signal: new EventTarget() }

  await byName.checkup.execute({ target: 'T' }, exec)
  assert.equal(requests[0].args.redteamMax, 6)
  assert.equal(requests[0].args.redteamMinLevel, 'major')
  assert.ok(!('models' in requests[0].args) && !('maxTotalAgents' in requests[0]) && !('subagentProvider' in requests[0]),
    'empty settings are not sent')

  // Edit everything, as a save on the Plugins page would.
  cfg.redteamMaxClaims.value = 0
  cfg.redteamMinLevel.value = 'minor'
  cfg.fixMaxRounds.value = 5
  cfg.maxTotalAgents.value = 200
  cfg.checkerModel.value = 'deepseek-reasoner'
  cfg.subagentProvider.value = 'spawn'
  await byName.checkup.execute({ target: 'T' }, exec)
  await byName.fix.execute({ task: 'T' }, exec)
  assert.equal(requests[1].args.redteamMax, 0)
  assert.equal(requests[1].args.redteamMinLevel, 'minor')
  assert.equal(requests[1].maxTotalAgents, 200)
  assert.equal(requests[1].subagentProvider, 'spawn')
  assert.deepEqual(plain(requests[1].args.models), { checker: 'deepseek-reasoner' })
  assert.equal(requests[2].args.maxRounds, 5)
  assert.deepEqual(plain(requests[2].meta.phases).map((p) => p.title), [
    'Plan',
    ...[1, 2, 3, 4, 5].map((i) => 'Implement · round ' + i),
    ...[1, 2, 3, 4, 5].map((i) => 'Check · round ' + i),
  ], 'every configured round is declared as a phase')

  // A later bad value keeps the last good one (the loader validates first; this guards programmatic callers).
  cfg.redteamMinLevel.value = 'everything'
  cfg.fixMaxRounds.value = 0
  await byName.checkup.execute({ target: 'T' }, exec)
  await byName.fix.execute({ task: 'T' }, exec)
  assert.equal(requests[3].args.redteamMinLevel, 'minor')
  assert.equal(requests[4].args.maxRounds, 5)

  // A bad first value fails loud in apply.
  assert.throws(() => mod.apply(stubContext(() => ({})).ctx, { redteamMinLevel: 'all' }), /redteamMinLevel/)
  assert.throws(() => mod.apply(stubContext(() => ({})).ctx, { fixMaxRounds: 21 }), /at most 20/)
  assert.throws(() => mod.apply(stubContext(() => ({})).ctx, { fixMaxRounds: live(0) }), /positive integer/)
})

// ════════════════════════════════════════════════════════════════════════════
// ⑨ 参数校验抛错：非数组 / 条目非对象 / 缺必填字段 绝不静默降级
// ════════════════════════════════════════════════════════════════════════════
test('⑨ 参数校验抛错（非数组/条目非对象/缺必填字段）', async () => {
  const { mod } = await loadPlugin()
  const { ctx, defs, requests } = stubContext(() => ({ report: 'r' }))
  mod.apply(ctx, {})
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]))
  const exec = { agent: { id: 'parent' }, signal: new EventTarget() }
  const started = () => requests.length

  // fix.issues
  await assert.rejects(byName.fix.execute({ task: 'T', issues: '{"a":1}' }, exec), /must be a JSON array/, '非数组 JSON 抛错')
  await assert.rejects(byName.fix.execute({ task: 'T', issues: 'not json' }, exec), /must be a JSON array/, '解析失败抛错')
  await assert.rejects(byName.fix.execute({ task: 'T', issues: '[1,2]' }, exec), /every entry must be an object/, '条目非对象抛错')
  await assert.rejects(byName.fix.execute({ task: 'T', issues: '[null]' }, exec), /every entry must be an object/, '条目 null 抛错')
  await assert.rejects(byName.fix.execute({ task: 'T', issues: '[[1]]' }, exec), /every entry must be an object/, '条目是数组抛错')
  await assert.rejects(byName.fix.execute({ task: 'T', issues: '[{"level":"major"}]' }, exec), /needs a string issue/, '缺 issue 抛错')
  await assert.rejects(byName.fix.execute({ task: 'T', issues: '[{"issue":"X"}]' }, exec), /needs a string level/, '缺 level 抛错')
  assert.strictEqual(started(), 0, '抛错时不进入 workflows.start')

  const fixOk = await byName.fix.execute({ task: 'T', issues: '[{"level":"major","issue":"X"}]' }, exec)
  assert.strictEqual(fixOk.ok, true)
  assert.deepEqual(plain(requests[0].args.issues), [{ level: 'major', issue: 'X' }], '合法 issues 以解析后的数组透传')

  await byName.fix.execute({ task: 'T', issues: '' }, exec)
  assert.ok(!('issues' in requests[1].args), '空串按未提供处理（不传 issues 键）')

  // review.fixed_issues
  await assert.rejects(byName.review.execute({ target: 'T', fixed_issues: '{"a":1}' }, exec), /must be a JSON array/, '非数组 JSON 抛错')
  await assert.rejects(byName.review.execute({ target: 'T', fixed_issues: '[1]' }, exec), /every entry must be an object/, '条目非对象抛错')
  await assert.rejects(byName.review.execute({ target: 'T', fixed_issues: '[null]' }, exec), /every entry must be an object/, '条目 null 抛错')
  await byName.review.execute({ target: 'T', fixed_issues: '[{"level":"major","issue":"Y"}]' }, exec)
  assert.deepEqual(plain(requests[2].args.fixed_issues), [{ level: 'major', issue: 'Y' }], '合法 fixed_issues 透传')
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

  const checkupOut = { ok: true, report: '# r', issues: [{ level: 'critical', issue: 'a', evidence: 'e' }] }
  assert.deepEqual(validateJsonSchemaValue(byName.checkup.output.schema, checkupOut), [], '合法 checkup 输出通过')
  assert.deepEqual(validateJsonSchemaValue(byName.checkup.output.schema, { ok: true, report: '# r', issues: [] }), [], '空 issues 通过')
  assert.ok(validateJsonSchemaValue(byName.checkup.output.schema, { ok: true, report: 'x', issues: [{ level: '错误', issue: 'a' }] }).length > 0, '非法 level 被拒')
  assert.ok(validateJsonSchemaValue(byName.checkup.output.schema, { ok: true, report: 'x', issues: [{ level: 'critical', issue: 'a', bogus: 1 }] }).length > 0, '条目多余键被拒')
  assert.ok(validateJsonSchemaValue(byName.checkup.output.schema, { ok: true, report: 'x', extra: 1 }).length > 0, '顶层多余键被拒')
  assert.ok(validateJsonSchemaValue(byName.checkup.output.schema, { ok: true }).length > 0, '缺 report 被拒')
  assert.ok(validateJsonSchemaValue(byName.checkup.output.schema, { ok: true, report: 'x', issues: 'not-array' }).length > 0, '非数组 issues 被拒')

  assert.deepEqual(validateJsonSchemaValue(byName.fix.output.schema, { ok: true, report: 'x', rounds: 2 }), [], 'fix 输出通过')
  assert.deepEqual(validateJsonSchemaValue(byName.fix.output.schema, { ok: true, report: 'x', rounds: 3, converged: false, remaining: [{ level: 'major', issue: 'a', evidence: 'e' }] }), [], 'fix converged/remaining pass')
  assert.ok(validateJsonSchemaValue(byName.fix.output.schema, { ok: true, report: 'x', converged: 'no' }).length > 0, 'converged must be boolean')
  assert.deepEqual(validateJsonSchemaValue(byName.checkup.output.schema, { ok: true, report: 'x', issues: [{ level: 'major', issue: 'a', reproduce: 'r', verdict: 'unverified' }] }), [], 'verdict and reproduce are allowed')
  assert.ok(validateJsonSchemaValue(byName.checkup.output.schema, { ok: true, report: 'x', issues: [{ level: 'major', issue: 'a', verdict: 'refuted' }] }).length > 0, 'refuted claims are never returned as issues')
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
    issues: [{ level: 'critical', issue: 'X1' }],
    models: { checker: 'cm', worker: 'wm' },
  }, {
    worker: ['impl'],
    checker: [mk([])],
  })
  const workerCall = prompts.find((p) => p.label.startsWith('Implement '))
  const checkerCall = prompts.find((p) => p.label.startsWith('Check · '))
  assert.strictEqual(workerCall.opts.model, 'wm', 'worker 调用应带 models.worker')
  assert.strictEqual(checkerCall.opts.model, 'cm', 'checker 调用应带 models.checker')

  const checkup = await runScript(SCRIPTS.checkup, {
    target: 'T',
    models: { redteam: 'rm', merger: 'mm', checker: 'cm2' },
  }, {
    checker: [mk([{ level: 'critical', issue: 'W', evidence: 'e' }]), mk([{ level: 'major', issue: 'Z', evidence: 'e' }]), mk([])],
    redteam: attackers({ W: V('confirmed'), Z: V('confirmed') }),
    merger: [echoMerger],
  })
  assert.strictEqual(checkup.prompts.find((p) => p.label.startsWith('Red team · ')).opts.model, 'rm', '红队调用应带 models.redteam')
  assert.strictEqual(checkup.prompts.find((p) => p.label.startsWith('Check · ')).opts.model, 'cm2')
  assert.strictEqual(checkup.prompts.find((p) => p.label === 'Merge').opts.model, 'mm', '汇总调用应带 models.merger')

  const noModels = await runScript(SCRIPTS.fix, { task: 'T', issues: [{ level: 'major', issue: 'X2' }] }, {
    worker: ['impl'],
    checker: [mk([])],
  })
  assert.ok(!('model' in noModels.prompts.find((p) => p.label.startsWith('Check · ')).opts), '未配置 models 时不带 model 键')
})

// ════════════════════════════════════════════════════════════════════════════
// ⑫ workflows 缺失快速失败：静态注入 workflows 在无 provider 的 profile（如
//    标准 web 组合）里让条目永久 pending（waiting for service: workflows），
//    挂死整个插件树直到宿主静默退出。修复后 inject 只含 tools，apply 与工具
//    execute 对缺失服务报清晰错误（fail loud，绝不无声挂起）。
// ════════════════════════════════════════════════════════════════════════════
test('⑫ workflows 缺失：inject 不含 workflows；apply 照常、execute 清晰报错', async () => {
  const { mod } = await loadPlugin()

  // 回归锚点：workflows 绝不回到静态 inject（那会恢复永久 pending 挂死行为）。
  // （Array.from 把 vm realm 的数组归一到 host realm，deepEqual 才不因原型不同误报。）
  assert.deepEqual(Array.from(mod.inject), ['tools'], 'inject 只含 tools（workflows 由运行时守卫覆盖）')

  // apply：无 workflows 服务也照常注册工具——apply 期抛错会挂死整个 loader
  // 组（见 requireWorkflows 注释），profile 必须保持可启动。
  const registered = []
  const bareCtx = { tools: { register: (d) => registered.push(d) }, get: () => undefined }
  mod.apply(bareCtx, {})
  assert.ok(registered.some((d) => d.name === 'checkup'), 'workflows 缺失时 apply 仍注册工具')

  // execute：服务缺失（从未存在）→ 清晰错误而非 TypeError。
  const exec = { agent: { id: 'parent' }, signal: new EventTarget() }
  await assert.rejects(registered.find((d) => d.name === 'checkup').execute({ target: 'T' }, exec),
    /no "workflowEngine" service.*workflow engine/s, '服务缺失时 execute 报清晰错误（不是 TypeError）')

  // execute：apply 成功后服务中途消失（provider 停止）→ 同样清晰错误。
  const { ctx, defs } = stubContext(() => ({ report: 'r' }))
  mod.apply(ctx, {})
  delete ctx.workflows
  const exec2 = { agent: { id: 'parent' }, signal: new EventTarget() }
  await assert.rejects(defs.find((d) => d.name === 'checkup').execute({ target: 'T' }, exec2),
    /no "workflowEngine" service.*workflow engine/s, '服务消失后 execute 报清晰错误（不是 TypeError）')
})

// ════════════════════════════════════════════════════════════════════════════
// ⑬ 引擎服务名：dsh ≥0.1.6 的官方引擎注册为 workflowEngine；旧名 workflows 作后备。
// ════════════════════════════════════════════════════════════════════════════
test('⑬ 引擎服务名：优先 workflowEngine，workflows 作后备', async () => {
  const { mod } = await loadPlugin()
  for (const key of ['workflowEngine', 'workflows']) {
    const { ctx, defs, requests } = stubContext(() => ({ report: 'r' }))
    if (key === 'workflowEngine') { ctx.workflowEngine = ctx.workflows; delete ctx.workflows }
    mod.apply(ctx, {})
    const exec = { agent: { id: 'parent' }, signal: new EventTarget() }
    await defs.find((d) => d.name === 'checkup').execute({ target: 'T' }, exec)
    assert.equal(requests.length, 1, `${key} 服务被调用`)
  }
})

// ════════════════════════════════════════════════════════════════════════════
// ⑭ 递归守卫：工作流子代理（同一 preset，同样能看到 checkup/fix/review）调用
//    这三个工具时直接拒绝，防止无界嵌套；子代理结束后同一会话恢复可用。
// ════════════════════════════════════════════════════════════════════════════
test('⑭ 递归守卫：工作流子代理内调用被拒绝，结束后恢复', async () => {
  const { mod } = await loadPlugin()
  const { ctx, defs, requests } = stubContext(() => ({ report: 'r' }))
  const listeners = {}
  ctx.on = (event, fn) => { (listeners[event] ??= []).push(fn) }
  mod.apply(ctx, {})
  const emit = (event, ...args) => (listeners[event] ?? []).forEach((fn) => fn(...args))
  const info = { id: 'run-x', meta: { name: 'm', description: 'd' } }
  emit('workflow/agent-start', info, { seq: 1, label: 'checker', childId: 'child-1' })
  for (const name of ['checkup', 'fix', 'review']) {
    const args = name === 'fix' ? { task: 'T' } : { target: 'T' }
    await assert.rejects(defs.find((d) => d.name === name).execute(args, { agent: { id: 'child-1' }, signal: new EventTarget() }),
      /cannot be started from inside a workflow sub-agent/, `${name} 在子代理内被拒绝`)
  }
  assert.equal(requests.length, 0, '被拒绝时不启动任何工作流')
  // 顶层会话不受影响
  await defs.find((d) => d.name === 'checkup').execute({ target: 'T' }, { agent: { id: 'top' }, signal: new EventTarget() })
  assert.equal(requests.length, 1)
  // 子代理结束 → 解除
  emit('workflow/agent-end', info, { seq: 1, label: 'checker', childId: 'child-1' }, { outcome: 'completed' })
  await defs.find((d) => d.name === 'checkup').execute({ target: 'T' }, { agent: { id: 'child-1' }, signal: new EventTarget() })
  assert.equal(requests.length, 2)
})

// ════════════════════════════════════════════════════════════════════════════
// ⑮ angles/dimensions 拆分：分层分隔符（换行 > 分号 > 逗号），括号内不拆分。
// ════════════════════════════════════════════════════════════════════════════
test('⑮ splitList：分层分隔符与括号保护', async () => {
  const { mod } = await loadPlugin()
  const split = (s) => Array.from(mod.splitList(s))
  assert.deepEqual(split('实现质量，边界与错误处理，安全与资源'), ['实现质量', '边界与错误处理', '安全与资源'])
  assert.deepEqual(split('a, b, c'), ['a', 'b', 'c'])
  assert.deepEqual(split('accounting (cash, fees); data (panel, dates).'), ['accounting (cash, fees)', 'data (panel, dates)'])
  assert.deepEqual(split('accounting (cash; fees), data integrity, lookahead'), ['accounting (cash; fees)', 'data integrity', 'lookahead'])
  assert.deepEqual(split('Engine; cash; fees\nData; panel (hfq; splits); dates\nTests; coverage'),
    ['Engine; cash; fees', 'Data; panel (hfq; splits); dates', 'Tests; coverage'])
  assert.deepEqual(split('a (b, c, d'), ['a (b', 'c', 'd'])
  assert.deepEqual(split('a (b\nc; d'), ['a (b', 'c; d'])
  assert.deepEqual(split('x [y, z] {p; q} 【m，n】'), ['x [y, z] {p; q} 【m，n】'])
  assert.deepEqual(split('a、b、c'), ['a', 'b', 'c'])
  assert.deepEqual(split('a；b'), ['a', 'b'])
  assert.deepEqual(split(''), [])
  assert.deepEqual(split('  \n '), [])
  assert.deepEqual(split(undefined), [])
  assert.deepEqual(split(null), [])
})

test('⑮b splitList：标点清理保留缩写与小数，去掉句末句号', async () => {
  const { mod } = await loadPlugin()
  const split = (s) => Array.from(mod.splitList(s))
  assert.deepEqual(split('version 1.0, etc.'), ['version 1.0', 'etc.'])
  assert.deepEqual(split('e.g. latency, throughput'), ['e.g. latency', 'throughput'])
  assert.deepEqual(split('Node.js, Deno.'), ['Node.js', 'Deno'])
  assert.deepEqual(split('a..'), ['a'])
  assert.deepEqual(split('one line only.'), ['one line only'])
  assert.deepEqual(split('a; b,'), ['a', 'b'], '尾随分隔符不产生空项，也不被当作逗号歧义')
  assert.deepEqual(split('a\r\nb\r\n'), ['a', 'b'])
})

test('⑮c splitList：歧义与无效输入明确报错，不静默回退', async () => {
  const { mod } = await loadPlugin()
  // 同一行里 ";" 与 "," 都是分隔符：不猜意图，要求改写
  assert.throws(() => mod.splitList('security, edge cases; performance'), /both separate items on one line/)
  assert.throws(() => mod.splitList('security; edge cases, performance'), /both separate items on one line/)
  // 换行分隔时，每行内部的 ";"/"," 属于该行细节，不报错
  assert.deepEqual(Array.from(mod.splitList('security, edge cases\nperformance; latency')), ['security, edge cases', 'performance; latency'])
  // 有文字但切完无项
  assert.throws(() => mod.splitList(';'), /contains no items/)
  assert.throws(() => mod.splitList(' , , '), /contains no items/)
  // 非字符串（如 JSON 数组）不再静默变成默认角度
  assert.throws(() => mod.splitList(['a', 'b']), /must be a string/)
  assert.throws(() => mod.splitList(42), /must be a string/)
  // 错误信息带上参数名
  assert.throws(() => mod.splitList(';', 'checkup: angles'), /^Error: checkup: angles contains no items/)
})

test('⑮d checkup/review 拒绝歧义角度，且不启动工作流', async () => {
  const { mod } = await loadPlugin()
  const { ctx, defs, requests } = stubContext(() => ({ report: 'r' }))
  ctx.on = () => {}
  mod.apply(ctx, {})
  const exec = { agent: { id: 'top' }, signal: new EventTarget() }
  await assert.rejects(defs.find((d) => d.name === 'checkup').execute({ target: 'T', angles: 'a, b; c' }, exec),
    /checkup: angles: ";" and "," both separate/)
  await assert.rejects(defs.find((d) => d.name === 'review').execute({ target: 'T', dimensions: 'x; y, z' }, exec),
    /review: dimensions: ";" and "," both separate/)
  assert.equal(requests.length, 0, '参数错误时不启动任何工作流')
})

// ════════════════════════════════════════════════════════════════════════════
// ⑯ Legacy levels: issue lists from the pre-fork Chinese version (严重/一般/建议)
//    are accepted by fix/review and mapped to critical/major/minor.
// ════════════════════════════════════════════════════════════════════════════
test('⑯ legacy Chinese levels map to critical/major/minor', async () => {
  const { mod } = await loadPlugin()
  const { ctx, defs, requests } = stubContext(() => ({ report: 'r' }))
  mod.apply(ctx, {})
  const exec = { agent: { id: 'parent' }, signal: new EventTarget() }
  await defs.find((d) => d.name === 'fix').execute({
    task: 'T',
    issues: JSON.stringify([{ level: '严重', issue: 'A' }, { level: '一般', issue: 'B' }, { level: '建议', issue: 'C' }, { level: 'major', issue: 'D' }]),
  }, exec)
  assert.deepEqual(Array.from(requests[0].args.issues, (x) => x.level), ['critical', 'major', 'minor', 'major'])
})

// ════════════════════════════════════════════════════════════════════════════
// ⑰ Long reports: saved in full through the spill store; the inline result stays
//    under the limit (so dsh's tool-result pruner never cuts the issue list) and
//    still names every issue. No store / failed save → full report unchanged.
// ════════════════════════════════════════════════════════════════════════════
test('⑰ long report → spilled in full, compact result lists the issues', async () => {
  const { mod } = await loadPlugin()
  const issues = Array.from({ length: 20 }, (_, i) => ({
    level: ['critical', 'major', 'minor'][i % 3],
    issue: `Issue ${i + 1}: ` + 'cash accounting drifts when a halted symbol resumes; '.repeat(3),
    evidence: 'engine.py:120-180 ' + 'x'.repeat(400),
  }))
  const report = ['# Checkup report', '', 'Target: T', 'Angles: a, b', '', `## Problems found (${issues.length})`,
    ...issues.map((x, i) => `${i + 1}. [${x.level}] ${x.issue} (evidence: ${x.evidence})`), '', '## Red team', 'notes'].join('\n')
  assert.ok(report.length > mod.INLINE_REPORT_LIMIT)
  const saved = []
  const ctx = { get: (n) => n === 'spillStore' ? { saveText: async (input) => { saved.push(input); return { locator: '/spill/s1/checkup-report.md', bytes: input.content.length, retrievalHint: 'Use read with offset/limit.' } } } : undefined }
  const out = await mod.compactReport(ctx, { ok: true, report, issues }, 'inspect-checkup', { id: 'sess-1' }, { callId: 'c1' })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].content, report, 'the full report is saved verbatim')
  assert.equal(saved[0].owner.sessionId, 'sess-1')
  assert.ok(out.report.length <= mod.INLINE_REPORT_LIMIT, `compact report ${out.report.length} > limit`)
  for (let i = 1; i <= 20; i++) assert.ok(out.report.includes(`${i}. [`), `issue ${i} listed`)
  assert.ok(out.report.includes('/spill/s1/checkup-report.md'), 'points to the full report')
  assert.ok(!out.report.includes('xxxxxxxxxx'), 'evidence stays in the file')
  assert.equal(out.issues.length, 20, 'structured issues untouched')

  // short report: unchanged, nothing saved
  const short = await mod.compactReport(ctx, { ok: true, report: 'short' }, 'inspect-checkup', { id: 's' }, {})
  assert.equal(short.report, 'short'); assert.equal(saved.length, 1)
  // no spill store: full report kept
  const none = await mod.compactReport({ get: () => undefined }, { ok: true, report, issues }, 'inspect-checkup', { id: 's' }, {})
  assert.equal(none.report, report)
  // save fails: full report kept
  const failing = { get: () => ({ saveText: async () => { throw new Error('disk full') } }) }
  const kept = await mod.compactReport(failing, { ok: true, report, issues }, 'inspect-checkup', { id: 's' }, {})
  assert.equal(kept.report, report)
  // fix-style report without issues: head + locator, under the limit
  const fixOut = await mod.compactReport(ctx, { ok: true, report: '# Delivery report\n\nTask: T\n\n## Work done\n' + 'y'.repeat(9000), rounds: 2 }, 'inspect-fix', { id: 's' }, {})
  assert.ok(fixOut.report.length <= mod.INLINE_REPORT_LIMIT && fixOut.report.includes('/spill/s1/checkup-report.md'))
  assert.equal(fixOut.report.match(/^Task: T$/gm).length, 1, 'the header is not repeated in the body')
  assert.ok(fixOut.report.includes('## Work done'), 'the body starts at the first section')
})

test('⑰b compact result: issues shrink to fit, stay on one line, header capped', async () => {
  const { mod } = await loadPlugin()
  const ctx = { get: () => ({ saveText: async () => ({ locator: '/spill/r.md', bytes: 1 }) }) }
  const compact = (report, issues) => mod.compactReport(ctx, { ok: true, report, ...(issues ? { issues } : {}) }, 'inspect-checkup', { id: 's' }, {})
  const big = '\n## Problems\n' + 'x'.repeat(7000)
  const listed = (r) => (r.match(/^\d+\. \[/gm) || []).length

  // 40 long issues (a large checkup): every one is listed, text shortened to fit.
  const long40 = Array.from({ length: 40 }, (_, i) => ({ level: 'minor', issue: 'issue ' + i + ' ' + 'y'.repeat(300) }))
  const r40 = await compact('# Checkup report\n\nTarget: T' + big, long40)
  assert.equal(listed(r40.report), 40)
  assert.ok(r40.report.length <= mod.INLINE_REPORT_LIMIT)
  assert.ok(!r40.report.includes('more (problems'))

  // 400 issues cannot all fit at a readable length: the rest is counted, and the result stays under the limit.
  const many = Array.from({ length: 400 }, (_, i) => ({ level: 'major', issue: 'realistic issue text number ' + i + ' ' + 'z'.repeat(100) }))
  const r400 = await compact('# Checkup report\n\nTarget: T' + big, many)
  const n = listed(r400.report)
  assert.ok(n > 20 && n < 400, 'listed ' + n)
  assert.ok(r400.report.includes(`… ${400 - n} more (problems ${n + 1}–400)`))
  assert.ok(r400.report.length <= mod.INLINE_REPORT_LIMIT)
  assert.equal(r400.issues.length, 400, 'structured issues untouched')

  // Line breaks inside an issue are flattened, so each entry is one line.
  const nl = await compact('# Checkup report\n\nTarget: T' + big, [{ level: 'critical', issue: 'first line\nsecond line\n\n- bullet' }])
  assert.ok(nl.report.includes('1. [critical] first line second line - bullet'))

  // A huge caller-supplied target or angle list cannot blow the limit.
  const huge = await compact('# Checkup report\n\nTarget: ' + 't'.repeat(10000) + '\nAngles: ' + 'angle, '.repeat(2000) + '\nContext: c\n' + big,
    [{ level: 'major', issue: 'a' }])
  assert.ok(huge.report.length <= mod.INLINE_REPORT_LIMIT, 'compact length ' + huge.report.length)
  assert.ok(huge.report.includes('1. [major] a'), 'the issue list survives')
})

// ════════════════════════════════════════════════════════════════════════════
// ⑱ Slash commands: /checkup, /fix, /inspect-review hand a follow-up message to
//    the agent; a name already taken by another plugin is skipped without
//    breaking the others; apply waits for `commands` through ctx.inject.
// ════════════════════════════════════════════════════════════════════════════
test('⑱ slash commands register, submit follow-ups, and tolerate a taken name', async () => {
  const { mod } = await loadPlugin()
  assert.deepEqual(Array.from(mod.COMMANDS, (c) => c.name), ['checkup', 'fix', 'inspect-review'])
  const registered = []
  const warnings = []
  const ctx = {
    logger: { warn: (m) => warnings.push(m) },
    commands: { register: (def) => { if (def.name === 'fix') throw new Error('command "fix" already registered'); registered.push(def) } },
  }
  mod.registerCommands(ctx)
  assert.deepEqual(registered.map((d) => d.name), ['checkup', 'inspect-review'])
  assert.equal(warnings.length, 1); assert.match(warnings[0], /\/fix not registered/)

  const sent = []
  const agent = { followup: (m) => sent.push(m) }
  const checkup = registered.find((d) => d.name === 'checkup')
  const r1 = await checkup.handler({ agent, rawInput: '' })
  assert.equal(r1.kind, 'success')
  assert.match(sent[0].content[0].text, /call the `checkup` tool with the current working directory/)
  assert.equal(sent[0].source.kind, 'dsh-inspect')
  await checkup.handler({ agent, rawInput: '  src/engine.py\ncash accounting  ' })
  assert.match(sent[1].content[0].text, /Request:\nsrc\/engine\.py\ncash accounting$/)
  const review = registered.find((d) => d.name === 'inspect-review')
  await review.handler({ agent, rawInput: '' })
  assert.match(sent[2].content[0].text, /`review` tool on the current uncommitted changes/)

  // apply: commands come through ctx.inject; no commands service → no throw
  const { ctx: c2 } = stubContext(() => ({ report: 'r' }))
  const injected = []
  c2.inject = (deps, cb) => { injected.push(Array.from(deps)); cb({ commands: { register: (d) => injected.push(d.name) } }) }
  mod.apply(c2, {})
  assert.deepEqual(injected, [['commands'], 'checkup', 'fix', 'inspect-review', ['settings']], 'a settings scope without configure is ignored')
  mod.registerCommands({})

  // With the settings service, the plugin says it ships its own page (client/index.js).
  const { ctx: c3 } = stubContext(() => ({ report: 'r' }))
  c3.fiber = { id: 'fiber' }
  const policies = []
  c3.inject = (deps, cb) => {
    if (deps[0] !== 'settings') return
    cb({ settings: { configure: (policy, owner) => { policies.push([policy, owner]); return () => {} } }, effect: (fn) => fn() })
  }
  mod.apply(c3, {})
  assert.equal(policies.length, 1)
  assert.deepEqual(plain(policies[0][0]), { auto: false })
  assert.strictEqual(policies[0][1], c3.fiber, 'the policy names the plugin fiber')
})

// ════════════════════════════════════════════════════════════════════════════
// ㉒ The Plugins-page form (client/index.js) covers every setting and parses
//    drafts the way the Config schema accepts them.
// ════════════════════════════════════════════════════════════════════════════
test('㉒ settings form: a field for every Config key, drafts parsed like the schema', () => {
  let registration
  const sandbox = { window: { __ModuleLoader__: { load: (r) => { registration = r } } } }
  vm.runInNewContext(readFileSync(new URL('../client/index.js', import.meta.url), 'utf8'), sandbox)
  assert.equal(registration.id, '@dsh-external/dsh-inspect', 'registered under the package name')
  const client = registration.factory(() => { throw new Error('no require at load time') })
  assert.deepEqual(Array.from(client.inject), ['slots', 'locale', 'configForms'])
  const { integerField, textField, choiceField, FIELD_KEYS } = client.__fields

  // Every key of the Config interface has a form field, and nothing else does.
  const start = SRC.indexOf('export interface Config {')
  const iface = SRC.slice(start, SRC.indexOf('\n}\n', start))
  const configKeys = [...iface.matchAll(/^  (\w+)\?: Live</gm)].map((m) => m[1]).sort()
  assert.ok(configKeys.length >= 11)
  assert.deepEqual(Object.values(FIELD_KEYS).sort(), configKeys)

  const rounds = integerField('fixMaxRounds', 1, 20)
  assert.deepEqual(plain(rounds.parse('5')), { kind: 'set', value: 5 })
  assert.deepEqual(plain(rounds.parse(' ')), { kind: 'clear' })
  for (const bad of ['0', '21', '2.5', '-1', 'x']) assert.equal(rounds.parse(bad), undefined, bad)
  assert.deepEqual(plain(integerField('redteamMaxClaims', 0, Number.MAX_SAFE_INTEGER).parse('0')), { kind: 'set', value: 0 }, '0 = no limit is accepted')
  assert.deepEqual(plain(textField('checkerModel').parse('  m  ')), { kind: 'set', value: 'm' })
  assert.deepEqual(plain(textField('checkerModel').parse('   ')), { kind: 'clear' }, 'blank inherits')
  const level = choiceField('redteamMinLevel', ['critical', 'major', 'minor'])
  assert.deepEqual(plain(level.parse('minor')), { kind: 'set', value: 'minor' })
  assert.equal(level.parse('all'), undefined)
})

// ════════════════════════════════════════════════════════════════════════════
// ㉓ Input hardening: inherited Object.prototype names are not levels; an
//    implementer that finishes with no text counts as no result.
// ════════════════════════════════════════════════════════════════════════════
test('㉓ fix: a level named like an Object.prototype member stays a plain string', async () => {
  const { mod } = await loadPlugin()
  const { ctx, defs, requests } = stubContext(() => ({ report: 'r' }))
  mod.apply(ctx, {})
  const fix = defs.find((d) => d.name === 'fix')
  const exec = { agent: { id: 'p' }, signal: new EventTarget() }
  for (const level of ['toString', 'constructor', '__proto__', 'hasOwnProperty', '严重']) {
    await fix.execute({ task: 'T', issues: JSON.stringify([{ level, issue: 'x' }]) }, exec)
    const got = requests.at(-1).args.issues[0].level
    assert.equal(typeof got, 'string', level)
    assert.doesNotThrow(() => structuredClone(requests.at(-1).args), "args survive the engine's structuredClone: " + level)
  }
  assert.equal(requests.at(-1).args.issues[0].level, 'critical', 'legacy names still map')
  assert.equal(requests[0].args.issues[0].level, 'toString')
})

test('㉓ fix: an implementer that returns empty text is implemented again', async () => {
  const { result, prompts } = await runScript(SCRIPTS.fix, { task: 'T', issues: [{ level: 'critical', issue: 'X1' }] }, {
    worker: ['', '   ', 'fixed it'],
    checker: [mk([])],
  })
  assert.equal(promptsOf(prompts, 'Implement ').length, 3, 'blank output → the step runs again')
  assert.equal(promptsOf(prompts, 'Check ').length, 1, 'no check of a blank result')
  assert.strictEqual(result.converged, true)
  assert.strictEqual(result.rounds, 3)
})

// ════════════════════════════════════════════════════════════════════════════
// ㉔ dsh loads lib/types/index.js, not src/: the built output must match the
//    source (rebuild with `pnpm run build` after changing src/index.ts).
// ════════════════════════════════════════════════════════════════════════════
test('㉔ lib/types/index.js matches src/index.ts', async () => {
  const LIB = readFileSync(new URL('../lib/types/index.js', import.meta.url), 'utf8')
  const fromSrc = evaluateModuleInVm(SRC)
  const fromLib = evaluateModuleInVm(LIB, { typescript: false })
  const stale = 'lib/ is out of date with src/ — run `pnpm run build` and commit lib/'
  for (const key of ['CHECKUP_SCRIPT', 'FIX_SCRIPT', 'REVIEW_SCRIPT', 'INLINE_REPORT_LIMIT', 'name']) {
    assert.strictEqual(fromLib[key], fromSrc[key], `${key}: ${stale}`)
  }
  const commands = (mod) => plain(mod.COMMANDS.map(({ withInput, ...c }) => ({ ...c, sample: withInput('X') })))
  assert.deepEqual(commands(fromLib), commands(fromSrc), stale)

  // Same tools, and they send the same requests for the same calls and settings.
  const run = async (mod) => {
    const { ctx, defs, requests } = stubContext(() => ({ report: 'r' }))
    mod.apply(ctx, { redteamMinLevel: 'minor', redteamMaxClaims: 0, fixMaxRounds: 4, checkerModel: 'm' })
    const exec = { agent: { id: 'p' }, signal: new EventTarget() }
    for (const d of defs) {
      const args = d.name === 'fix' ? { task: 'T', issues: '[{"level":"major","issue":"X"}]' } : { target: 'T', angles: 'a; b' }
      await d.execute(args, exec)
    }
    return {
      tools: defs.map((d) => ({ name: d.name, description: d.description, parameters: d.parameters, output: d.output.schema })),
      requests: requests.map((r) => ({ script: r.script, meta: r.meta, args: r.args, maxTotalAgents: r.maxTotalAgents })),
    }
  }
  assert.deepEqual(plain(await run(fromLib)), plain(await run(fromSrc)), stale)

  // And the same compact report.
  const ctx = { get: () => ({ saveText: async () => ({ locator: '/spill/r.md', bytes: 1 }) }) }
  const sample = { ok: true, report: '# Checkup report\n\nTarget: T\n\n## Problems\n' + 'x'.repeat(7000), issues: [{ level: 'major', issue: 'a\nb' }] }
  assert.equal((await fromLib.compactReport(ctx, sample, 'inspect-checkup', { id: 's' }, {})).report,
    (await fromSrc.compactReport(ctx, sample, 'inspect-checkup', { id: 's' }, {})).report, stale)
})
