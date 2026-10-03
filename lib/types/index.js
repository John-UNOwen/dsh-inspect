/**
 * dsh-inspect — a simple find → fix → review loop.
 *
 * Merges the harness-fault-hunting / agent-deliver / agent-review skills into
 * one lightweight plugin; three plain tools share the same "check" mechanism:
 *
 *   checkup  find problems: a few checker agents each take one angle
 *            (quality / edge cases / security…) → merge and deduplicate → problem list
 *   fix      repair and deliver: break the task down (or take checkup's problems
 *            directly) → implement in parallel (each worker proves its own fix)
 *            → check once → if there are critical/major problems, fix another
 *            round → deliver once converged
 *   review   quality review: a few reviewer agents check the deliverable in
 *            parallel → merge and grade (critical / major / minor)
 *
 * The loop: checkup's problem list feeds straight into fix as repair tasks;
 * fix's output is gated by review; a failed review (or human feedback) goes
 * back into fix. Each tool works on its own or chained.
 *
 * Design principle: simplicity first — plain "check / problem / fix" language,
 * no piles of jargon; a skill's value is in triggering the right behavior, not
 * in an elaborate vocabulary. Built on the official workflow engine
 * (ctx.workflowEngine) and the built-in tools (bash/fs/glob…).
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
import z from 'schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'dsh-inspect';
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
export const inject = ['tools'];
/**
 * Plugin configuration, validated by the cordis loader against this
 * schemastery schema before `apply` runs (official annotation pattern:
 * packages/workflow/tool-workflow/src/index.ts). Values that are present but
 * type-invalid (or violate constraints) fail loud at load; missing keys are
 * treated as optional by schemastery (z.object keys default to optional) and
 * pass silently, so defaults are applied by `apply` via optionalString /
 * positiveInt.
 */
export const Config = z.object({
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
});
/** Config key → script-side role field for the role-level model overrides. */
const MODEL_KEYS = [
    ['plannerModel', 'planner'],
    ['workerModel', 'worker'],
    ['checkerModel', 'checker'],
    ['reviewerModel', 'reviewer'],
    ['mergerModel', 'merger'],
    ['redteamModel', 'redteam'],
];
// ── Shared schemas (workflow-engine subset: top-level and nested `required` arrays are supported and used) ──
/** Severity levels, strongest first: critical = breaks or unusable / major = should fix / minor = could be better. */
const LEVELS = ['critical', 'major', 'minor'];
/** Pre-fork (Chinese) level names → English, accepted on input for issue lists produced by older versions. */
const LEGACY_LEVELS = { '严重': 'critical', '一般': 'major', '建议': 'minor' };
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
                    level: { type: 'string', enum: [...LEVELS] },
                    issue: { type: 'string' },
                    evidence: { type: 'string' },
                },
                required: ['level', 'issue'],
            },
        },
    },
    required: ['issues'],
};
// Shape of `issues` in the tool output schema (DSL form: nested value nodes
// cannot use a `required` array, only per-property `required: true`; keeps
// the same level/issue-required semantics as ISSUES_SCHEMA).
// `as const` keeps the DSL literal types (type/enum/required) for defineTool's
// inference — runtime behavior is identical.
const ISSUES_OUTPUT_SCHEMA = {
    type: 'array',
    items: {
        type: 'object',
        additionalProperties: false,
        properties: {
            level: { type: 'string', enum: ['critical', 'major', 'minor'], required: true },
            issue: { type: 'string', required: true },
            evidence: { type: 'string' },
        },
    },
};
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
};
// ── checkup: find problems ──────────────────────────────────────────────────
const CHECKUP_SCRIPT = String.raw `const ISSUES_SCHEMA = ${JSON.stringify(ISSUES_SCHEMA)}
const { target, angles, context, models } = args
const M = models ?? {}
const ANGLES = Array.isArray(angles) && angles.length > 0 ? angles : ['implementation quality', 'edge cases and error handling', 'security and resources']

const ADVERSARIAL = 'You are an adversarial checker. Distrust everything by default: actively look for counterexamples and try to overturn conclusions; '
  + 'do not take code comments, the README or a model\'s own claims at face value; accept only evidence you can verify on the spot; '
  + 'better to miss a problem than to report a false one — do not report anything without evidence. '
  + 'Before judging a problem, trace the system along its data flow: input → processing → storage → output, and who writes and who reads at each step; '
  + 'system state is determined by the data flow — a problem is a point where state deviates from what is expected. '
  + 'Every problem must come with a way to verify it that can be cross-checked (re-run the reproduction / compare logs / compare input and output / compare two paths), '
  + 'stating the expected state and the actual observation; do not report anything that cannot be verified through feedback from the system.'

phase('Check')
const findings = await parallel(ANGLES.map((a, i) => () => agent(
  ADVERSARIAL + '\n\n'
  + 'Target: ' + target
  + (context ? '\nContext: ' + context : '')
  + '\n\nYour angle: ' + a + '\n\nRequirements:\n'
  + '- For each problem give: level (critical = breaks or unusable / major = should fix / minor = could be better), a description, and evidence (file / line / observed behavior);\n'
  + '- If there are no problems, issues is an empty array;\n'
  + '- Output JSON only.',
  {
    label: 'Check · ' + a,
    phase: 'Check',
    schema: ISSUES_SCHEMA,
    ...(M.checker ? { model: M.checker } : {}),
  },
)))

// Engine contract: a failed child makes agent() resolve to null. Count the
// checkers that returned nothing and say so in the report — same standard as a
// null red team: never drop silently, never pass a failure off as "no problems".
const failedCheckers = findings.filter((f) => !f || !Array.isArray(f.issues)).length

// Red team: attack the strongest problem claims and try to overturn them (adversarial verification, mandatory).
phase('Red team')
const flat = []
for (const f of findings) {
  if (f && Array.isArray(f.issues)) for (const it of f.issues) flat.push(it)
}
const top = flat.filter((x) => x.level !== 'minor').slice(0, 5)
let redteamResult = null
if (top.length > 0) {
  const red = await agent(
    'You are the attacker. Attack each of the problem claims below and try to overturn it: look for counterexamples, look for simpler explanations, '
    + 'and check whether the evidence is real and verifiable. Keep only the claims you cannot overturn.\n\n'
    + 'Problem claims:\n' + JSON.stringify(top)
    + '\n\nOutput JSON only (survived = problems that still hold after the attack, refuted = the issue text of problems you overturned, reasoning = your reasons).',
    {
      label: 'Red team',
      phase: 'Red team',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          survived: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { level: { type: 'string', enum: ['critical', 'major', 'minor'] }, issue: { type: 'string' }, evidence: { type: 'string' } }, required: ['level', 'issue'] } },
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

// Merge: the red team only reviews top (the first 5 non-minor items). Refuted
// items are dropped; survivors flow back together with everything the red
// team did not review (all minor items + critical/major beyond the top 5 + top
// items the red team did not mention), so the merger always sees the full list
// — red-team success and failure behave the same.
// "Reviewed" counts only items the red team actually mentioned (survived issue
// + refuted issue): survived/refuted are selective verdict lists, so when the
// red-team output is partial or contradictory (a top item in neither list)
// that item is treated as unreviewed and flows back in full — never dropped
// silently.
// Effective red-team success = at least one survived or refuted entry; all-
// empty arrays are schema-valid but degenerate (nothing reviewed), so they are
// handled as a red-team failure: everything flows back, nothing is dropped.
// A null red team (child failed / no result) is likewise a failure: everything
// flows back and the report says so.
// Survivor membership check: the red team only received the top claims, so a
// survived entry's issue text must match the checkers' actual findings (flat).
// The red-team output is free-form and may contain hallucinated or new claims;
// merging them would inject hallucinations into the final list (contrary to
// "better to miss than to report falsely"). Non-matching entries are dropped
// and noted in the red-team record, never injected into candidates.
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
  'You are the merger. Merge the check results below and deduplicate them, removing duplicates and keeping the most accurate description. '
  + 'Problems refuted by the red team have already been removed; items the red team did not review (including minor ones) have all been kept.\n'
  + 'Levels: critical = breaks or unusable / major = should fix / minor = could be better.\n'
  + 'Output JSON only (issues = the merged list).\n\nCheck results:\n' + JSON.stringify(candidates),
  {
    label: 'Merge',
    phase: 'Check',
    schema: ISSUES_SCHEMA,
    ...(M.merger ? { model: M.merger } : {}),
  },
)

// A failed merger (null / no issues) must not silently zero the list: same
// standard as a null red team — keep every candidate (not deduplicated) and say
// so in the report; never pass a failure off as "no problems found".
const mergerFailed = !merged || !Array.isArray(merged.issues)
const issues = mergerFailed ? candidates : merged.issues

const noteParts = []
if (failedCheckers > 0) noteParts.push(failedCheckers + ' checker(s) returned no result')
if (mergerFailed) noteParts.push('the merger returned no result (all candidate problems kept, not deduplicated)')
const failNote = noteParts.join('; ')
const report = [
  '# Checkup report',
  '',
  'Target: ' + target,
  'Angles: ' + ANGLES.join(', '),
  '',
  '## Problems found (' + issues.length + ')',
  ...(issues.length === 0
    ? [(failNote ? '(Some agents returned no result, so "no problems" cannot be confirmed.)' : '(No problems found.)')]
    : issues.map((x, i) => (i + 1) + '. [' + x.level + '] ' + x.issue + (x.evidence ? ' (evidence: ' + x.evidence + ')' : ''))),
  '',
  '## Counts',
  'critical: ' + issues.filter((x) => x.level === 'critical').length,
  'major: ' + issues.filter((x) => x.level === 'major').length,
  'minor: ' + issues.filter((x) => x.level === 'minor').length,
  ...(failNote ? ['', '## Run log', failNote] : []),
  '',
  '## Red team',
  (redteamValid
    ? (redteamRefuted.length > 0
      ? 'Refuted: ' + redteamRefuted.join('; ')
      : 'The problem claims still hold after the attack.')
    + (unreviewedCount > 0 ? '\n' + unreviewedCount + ' item(s) not mentioned were kept (treated as unreviewed).' : '')
    + (droppedSurvived > 0 ? '\n' + droppedSurvived + ' new claim(s) from the red team did not match any finding and were dropped.' : '')
    + (redteamResult.reasoning ? '\nReasoning: ' + redteamResult.reasoning : '')
    : (redteamResult
      ? '(The red team returned no valid result; treated as unreviewed, all problems kept.)'
      : (top.length > 0
        ? '(The red team returned no result; treated as unreviewed, all problems kept.)'
        : '(No high-priority problems to attack.)'))),
].join('\n')
return { issues, report }
`;
// ── fix: repair and deliver ─────────────────────────────────────────────────
const FIX_SCRIPT = String.raw `const PLAN_SCHEMA = ${JSON.stringify(PLAN_SCHEMA)}
const ISSUES_SCHEMA = ${JSON.stringify(ISSUES_SCHEMA)}
const { task, issues, acceptance, models } = args
const M = models ?? {}
const MAX_ROUNDS = 3

// ── 1. Break down: use the issue list directly, or plan sub-tasks ──────────
phase('Plan')
let steps = null
if (Array.isArray(issues) && issues.length > 0) {
  steps = issues.map((it, i) => {
    const problem = it.issue ?? it.title ?? ('Problem ' + (i + 1))
    return {
      title: 'Fix: ' + problem,
      acceptance: 'Fix ' + problem + (it.evidence ? ' (evidence: ' + it.evidence + ')' : ''),
      problem,
      evidence: it.evidence ?? '',
    }
  })
} else {
  const plan = await agent(
    'You are the planner. Break the task below into 3-6 small steps that can each be completed and accepted independently.\n\n'
    + 'Task: ' + task
    + (acceptance ? '\nAcceptance criteria: ' + acceptance : '')
    + '\n\nFor each step give a title and acceptance (what counts as done, and how it can be verified). Output JSON only.',
    {
      label: 'Planner',
      phase: 'Plan',
      schema: PLAN_SCHEMA,
      ...(M.planner ? { model: M.planner } : {}),
    },
  )
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    throw new Error('the planner returned no valid steps')
  }
  steps = plan.steps.map((s) => ({ title: s.title, acceptance: s.acceptance ?? '', problem: s.title, evidence: '' }))
}

// ── 2. Implement (data-driven: root cause → implement → verify) → check → fix, until clean ──
const done = []
const checkLogs = []
let round = 0
// Cross-round context: the original task/acceptance are always in scope (args
// task/acceptance); roundExcerpt accumulates excerpts of earlier rounds'
// output (length-capped per round and in total). From round 2 the worker and
// checker prompts carry it, so a worker does not re-investigate from scratch
// detached from the thing being checked.
let roundExcerpt = ''
let pending = steps.slice()
while (pending.length > 0 && round < MAX_ROUNDS) {
  round += 1
  phase('Implement · round ' + round)
  const outputs = await parallel(pending.map((s, i) => () => agent(
    'You are the implementer. Work in three steps: find the root cause → implement → verify.\n\n'
    + 'Problem: ' + s.problem
    + (s.acceptance ? '\nAcceptance criteria: ' + s.acceptance : '')
    + (s.evidence ? '\nKnown evidence: ' + s.evidence : '')
    + (s.fix ? '\nAdditional requirement: ' + s.fix : '')
    + (round > 1
      ? '\n\nOriginal task: ' + task
        + (acceptance ? '\nOriginal acceptance criteria: ' + acceptance : '')
        + '\nPrevious round output (the object being checked, excerpt):\n' + roundExcerpt
      : '')
    + '\n\nStep 1 [Root cause]: do not patch the surface. Trace the data flow: input → processing → storage → output — '
    + 'at which step the data starts to deviate, who writes and who reads, where the state first goes wrong — find the source of the deviation (the root cause) '
    + 'and support it with evidence (file / line / chain of logic / reproduced behavior). If the source is unclear, build a minimal reproduction to confirm it first; do not guess.\n'
    + 'Step 2 [Implement]: based on the data, pick the most reasonable approach and implement it directly (the root cause determines the approach — no idle talk, no hesitation), '
    + 'keeping the change as small as possible.\n'
    + 'Step 3 [Verify]: re-run the original reproduction of the problem (closing the feedback loop: compare observed output with what is expected) '
    + 'to confirm the data-flow state is restored and the problem is really gone; also confirm no new problem was introduced. '
    + 'If verification fails (the problem is still there), the root cause or the approach is wrong — report "verification failed" explicitly; do not pretend it succeeded.\n'
    + '\nOutput (Markdown): root cause (with evidence), what was implemented, verification result (reproduction / verification output).',
    {
      label: 'Implement ' + (i + 1) + ' · round ' + round,
      phase: 'Implement · round ' + round,
      ...(M.worker ? { model: M.worker } : {}),
    },
  )))

  const artifact = pending.map((s, i) => '[Task] ' + s.title + '\n' + (outputs[i] ?? '(no result returned)')).join('\n\n')
  const checked = await agent(
    'You are an adversarial checker. Distrust everything by default: actively look for counterexamples and try to overturn conclusions; accept only evidence you can verify on the spot. '
    + 'Check the output below and find the problems that must be fixed.\n\n'
    + 'Output:\n' + artifact
    + (round > 1
      ? '\n\nOriginal task: ' + task
        + (acceptance ? '\nOriginal acceptance criteria: ' + acceptance : '')
        + '\nPrevious round output (the object being checked, excerpt):\n' + roundExcerpt
      : '')
    + '\n\nFocus on three things (check each along the data flow: input → processing → storage → output — is the state back to what is expected?):\n'
    + '1. Does the fix address the root cause? (If it only works around the symptom or changes the surface, report a "major" problem and explain.)\n'
    + '2. Is the problem really gone? (Re-run the reproduction to verify; if the verification output is suspicious or the implementer reported "verification failed", report "critical".)\n'
    + '3. Was a new problem introduced?\n'
    + '\nReport only "critical" (breaks or unusable) and "major" (should fix) problems; '
    + 'if there are none, issues is an empty array. Give evidence for each. Output JSON only.',
    {
      label: 'Check · round ' + round,
      phase: 'Check · round ' + round,
      schema: ISSUES_SCHEMA,
      ...(M.checker ? { model: M.checker } : {}),
    },
  )
  // A round only counts as "verified" if the checker returned a valid result:
  // when checked is null (child failed / no result) or structurally invalid,
  // the round is marked "unverified" and never takes the convergence branch —
  // otherwise a broken gate would be reported as "passed" (false convergence).
  // Unverified rounds keep the steps pending for a re-check next round (using
  // up a round); when rounds run out, "not converged" is reported honestly.
  // A failed implementer (agent() resolved to null) gets the same guard as a
  // failed checker: any null implementer output makes the round "unverified" —
  // otherwise, when the checker returns empty issues, the failed implementation
  // would count as "passed" in done and show "(no output)" in the report (the
  // same false-convergence path as checker null → false "passed").
  const workerFailed = outputs.some((o) => o == null)
  const verified = !workerFailed && !!checked && Array.isArray(checked.issues)
  const problems = verified ? checked.issues.filter((x) => x.level === 'critical' || x.level === 'major') : []
  checkLogs.push({ round, problems, verified, workerFailed })

  // Archive this round's output into the cross-round context (length-capped
  // per round and in total) for the next round's worker/checker.
  roundExcerpt = (roundExcerpt ? roundExcerpt + '\n\n' : '')
    + 'Round ' + round + ' output (excerpt):\n' + artifact.slice(0, 1200)
  if (roundExcerpt.length > 3600) roundExcerpt = roundExcerpt.slice(-3600)

  if (!verified) continue

  if (problems.length === 0) {
    pending.forEach((s, i) => { done.push({ step: s, output: outputs[i] }) })
    pending = []
    break
  }

  pending.forEach((s, i) => { done.push({ step: s, output: outputs[i], hadProblems: true }) })
  // Every problem goes into the next round — never sliced away: each problem
  // the checker found must get a fix attempt. MAX_ROUNDS is the backstop; when
  // rounds run out, the remaining problems are listed under "Conclusion".
  pending = problems.map((p) => ({
    title: 'Fix: ' + p.issue.slice(0, 50),
    acceptance: 'Fix ' + p.issue,
    problem: p.issue,
    evidence: p.evidence ?? '',
    fix: p.issue + (p.evidence ? ' (evidence: ' + p.evidence + ')' : ''),
  }))
}

const parts = ['# Delivery report', '', 'Task: ' + task, 'Rounds: ' + round, '', '## Work done']
for (const d of done) {
  parts.push('### ' + d.step.title + (d.hadProblems ? ' (the check found problems this round; they went into the fix loop)' : ''))
  parts.push((d.output ?? '(no output)').slice(0, 1200))
}
parts.push('', '## Check log')
for (const c of checkLogs) {
  if (!c.verified) {
    parts.push('Round ' + c.round + ': ' + (c.workerFailed ? 'an implementer returned no result — unverified' : 'the checker returned no result — unverified'))
    continue
  }
  parts.push('Round ' + c.round + ': ' + (c.problems.length === 0 ? 'passed' : c.problems.length + ' problem(s)'))
  for (const p of c.problems) parts.push('- [' + p.level + '] ' + p.issue)
}
parts.push('', '## Delivery notes')
parts.push('- Show the user the actual result (run it / demo it / show the output) and let the data speak;')
parts.push('- Anything the user is not satisfied with goes back into the fix loop as a new problem.')
if (pending.length > 0) {
  parts.push('', '## Conclusion')
  parts.push('Not converged: ' + pending.length + ' problem(s) remain (exceeded the ' + MAX_ROUNDS + '-round limit):')
  for (const p of pending) parts.push('- ' + p.problem)
  parts.push('Feed the remaining problems back into fix to continue.')
}
return { report: parts.join('\n'), rounds: round }
`;
// ── review: quality review ──────────────────────────────────────────────────
const REVIEW_SCRIPT = String.raw `const ISSUES_SCHEMA = ${JSON.stringify(ISSUES_SCHEMA)}
const { target, dimensions, context, fixed_issues, models } = args
const M = models ?? {}
const DIMS = Array.isArray(dimensions) && dimensions.length > 0 ? dimensions : ['implementation quality', 'edge cases and error handling', 'security and resources']

const ADVERSARIAL = 'You are an adversarial reviewer. Distrust everything by default: actively look for counterexamples and try to overturn conclusions; '
  + 'do not take code comments, the README or a model\'s own claims at face value; accept only evidence you can verify on the spot; '
  + 'better to miss a problem than to report a false one — do not report anything without evidence. '
  + 'Before judging a problem, trace the system along its data flow: input → processing → storage → output, and who writes and who reads at each step; '
  + 'system state is determined by the data flow — a problem is a point where state deviates from what is expected. '
  + 'Every problem must come with a way to verify it that can be cross-checked (re-run the reproduction / compare logs / compare input and output / compare two paths), '
  + 'stating the expected state and the actual observation; do not report anything that cannot be verified through feedback from the system.'

phase('Review')
const reviews = await parallel(DIMS.map((d, i) => () => agent(
  ADVERSARIAL + '\n\n'
  + 'Deliverable: ' + target
  + (context ? '\nContext: ' + context : '')
  + (fixed_issues ? '\n\nFixes to verify (re-run the reproduction / check each one and confirm the problem is really gone; if it is not, report "critical"):\n' + JSON.stringify(fixed_issues) : '')
  + '\n\nYour angle: ' + d + '\n\nRequirements:\n'
  + '- For each problem give: level (critical = breaks or unusable / major = should fix / minor = could be better), a description, and evidence;\n'
  + '- If there are no problems, issues is an empty array;\n'
  + '- Output JSON only.',
  {
    label: 'Review · ' + d,
    phase: 'Review',
    schema: ISSUES_SCHEMA,
    ...(M.reviewer ? { model: M.reviewer } : {}),
  },
)))

// Engine contract: a failed child makes agent() resolve to null. Count the
// reviewers that returned nothing and say so in the report — same standard as
// a null red team: never drop silently, never pass a failure off as "no problems".
const failedReviewers = reviews.filter((r) => !r || !Array.isArray(r.issues)).length

const merged = await agent(
  'You are the merger. Merge the review results below and deduplicate them.\n'
  + 'Levels: critical = breaks or unusable / major = should fix / minor = could be better.\n'
  + 'Output JSON only.\n\nReview results:\n' + JSON.stringify(reviews.filter(Boolean)),
  {
    label: 'Merge',
    phase: 'Review',
    schema: ISSUES_SCHEMA,
    ...(M.merger ? { model: M.merger } : {}),
  },
)

// A failed merger (null / no issues) must not silently zero the list: same
// standard as a null red team — keep every review result (not deduplicated)
// and say so in the report; never pass a failure off as "no problems".
const mergerFailed = !merged || !Array.isArray(merged.issues)
const issues = mergerFailed
  ? reviews.filter((r) => r && Array.isArray(r.issues)).flatMap((r) => r.issues)
  : merged.issues

const noteParts = []
if (failedReviewers > 0) noteParts.push(failedReviewers + ' reviewer(s) returned no result')
if (mergerFailed) noteParts.push('the merger returned no result (all review results kept, not deduplicated)')
const failNote = noteParts.join('; ')
const report = [
  '# Review report',
  '',
  'Deliverable: ' + target,
  'Angles: ' + DIMS.join(', '),
  '',
  '## Problems (' + issues.length + ')',
  ...(issues.length === 0
    ? [(failNote ? '(Some agents returned no result, so "no problems" cannot be confirmed.)' : '(No problems found.)')]
    : issues.map((x, i) => (i + 1) + '. [' + x.level + '] ' + x.issue + (x.evidence ? ' (evidence: ' + x.evidence + ')' : ''))),
  '',
  '## Conclusion',
  'critical/major problems: ' + issues.filter((x) => x.level !== 'minor').length
    + (issues.some((x) => x.level !== 'minor')
      ? ' — fix these before delivering.'
      : (failNote ? ' — some agents returned no result; the delivery verdict is unconfirmed.' : ' — ready to deliver; minor items are optional follow-ups.')),
  ...(failNote ? ['', '## Run log', failNote] : []),
].join('\n')
return {
  report,
  issues,
  // When an agent returned nothing or the merger failed, passed must not be
  // true: downgrade honestly to "unconfirmed".
  passed: !issues.some((x) => x.level !== 'minor') && !mergerFailed && failedReviewers === 0,
}
`;
// ── Tool registration ────────────────────────────────────────────────────────────────
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
function requireWorkflows(ctx) {
    // The official engine (@deepseek-ai/dsh-workflow, dsh ≥0.1.6) registers as
    // `workflowEngine`; `workflows` is the pre-0.1.6 name, kept as a fallback.
    const workflows = ctx.get('workflowEngine') ?? ctx.get('workflows');
    if (workflows === void 0) {
        throw new Error('dsh-inspect: no "workflowEngine" service in this scope — checkup/fix/review all run on '
            + 'the official workflow engine (@deepseek-ai/dsh-workflow). On the dsh web app the engine '
            + 'lives inside each agent preset: use the "Standard + inspect" preset this bundle adds, '
            + 'or mount dsh-inspect next to `workflow-ptc` in your own preset.');
    }
    return workflows;
}
/**
 * Session ids of agents currently running as workflow sub-agents (any run on
 * this engine), fed by the engine's `workflow/agent-start` / `agent-end`
 * events. Workflow sub-agents mount the same preset as their parent, so they
 * see checkup/fix/review too; without this guard a sub-agent could start a
 * nested workflow, and so on without bound (subagent `maxDepth` does not
 * apply: the engine starts its children directly).
 */
function trackWorkflowChildren(ctx) {
    const children = new Set();
    if (typeof ctx.on !== 'function')
        return children;
    ctx.on('workflow/agent-start', (_info, agent) => { children.add(String(agent.childId)); });
    ctx.on('workflow/agent-end', (_info, agent) => { children.delete(String(agent.childId)); });
    return children;
}
/** Refuse to start a workflow from inside a workflow sub-agent (see trackWorkflowChildren). */
function assertNotWorkflowChild(children, parent, tool) {
    if (children.has(String(parent.id))) {
        throw new Error(`dsh-inspect: ${tool} cannot be started from inside a workflow sub-agent `
            + '(nested checkup/fix/review runs are refused to prevent unbounded recursion). '
            + 'Do the requested work directly and report the result.');
    }
}
/** Script-side role overrides from the validated config (omitted keys stay absent). */
function modelsFrom(config) {
    const models = {};
    for (const [key, field] of MODEL_KEYS) {
        const value = config[key];
        if (value !== undefined)
            models[field] = value;
    }
    return models;
}
export function apply(ctx, config = {}) {
    // Deliberately NOT checking the workflows dependency here: see
    // requireWorkflows — an apply-time failure hangs the whole loader group.
    // The exported Config schema validates at load; these checks keep
    // misconfiguration loud for programmatic callers that skip the loader.
    const subagentProvider = optionalString(config.subagentProvider, 'subagentProvider');
    for (const [key] of MODEL_KEYS)
        optionalString(config[key], key);
    // null/undefined both mean "leave the engine default" (old JS contract:
    // positiveInt(..., undefined, ...) omitted the key — keep it omitted).
    const maxTotalAgents = config.maxTotalAgents === undefined || config.maxTotalAgents === null
        ? undefined
        : positiveInt(config.maxTotalAgents, 0, 'maxTotalAgents');
    const models = modelsFrom(config);
    const workflowChildren = trackWorkflowChildren(ctx);
    const common = {
        ...(subagentProvider !== undefined ? { subagentProvider } : {}),
        ...(maxTotalAgents !== undefined ? { maxTotalAgents } : {}),
    };
    ctx.tools.register(defineTool({
        name: 'checkup',
        description: 'Problem-finding tool: sends several adversarial checker agents to examine the target (code / system / design) from different angles, '
            + 'then a red team attacks the findings (trying to overturn each claim; only claims that survive are kept — finding is suspicion, '
            + 'verification is conviction), and merges and deduplicates them into a problem list (critical / major / minor, with evidence). '
            + 'The problems found can be passed straight to the fix tool as repair tasks. '
            + 'Use for: fault-finding, audits, health checks, investigating suspicious behavior, verifying whether a problem is real.',
        parameters: {
            target: { type: 'string', required: true, description: 'What to check (a path or a description; the checker agents look at it themselves).' },
            angles: { type: 'string', description: 'Optional: the angles to check from — one per line, or separated by semicolons or commas; separators inside brackets do not split. One or more, no fixed limit (2-6 recommended; the engine\'s maxTotalAgents is the backstop). Default: implementation quality / edge cases and error handling / security and resources. One checker agent runs per angle.' },
            context: { type: 'string', description: 'Optional: background (scope, known limitations, what to compare against).' },
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
                    text: value.ok ? value.report : `checkup could not complete: ${value.report}`,
                }],
        },
        async execute(args, exec) {
            const parent = exec.agent;
            if (!parent)
                throw new Error('checkup requires a calling agent (exec.agent was undefined)');
            assertNotWorkflowChild(workflowChildren, parent, 'checkup');
            const target = String(args.target).trim();
            if (target.length === 0)
                throw new Error('checkup: target must not be empty');
            const angles = splitList(args.angles);
            return runWorkflow(ctx, common, {
                script: CHECKUP_SCRIPT,
                meta: {
                    name: 'inspect-checkup',
                    description: 'Parallel problem finding with deduped, graded issues.',
                    phases: [
                        { title: 'Check', detail: 'Parallel checkers + merge' },
                        { title: 'Red team', detail: 'Adversarial red-team attack on top claims' },
                    ],
                },
                args: {
                    target,
                    ...(angles.length > 0 ? { angles } : {}),
                    ...(args.context !== undefined ? { context: String(args.context) } : {}),
                    ...(Object.keys(models).length > 0 ? { models } : {}),
                },
            }, parent, exec.signal);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'fix',
        description: 'Repair-and-deliver tool: breaks the task down (or takes checkup\'s problem list) → implements in parallel, each implementer working in three '
            + 'steps, "root cause → implement → verify" (trace the data flow to where state starts to deviate, implement directly based on the data, '
            + 're-run the reproduction afterwards to confirm the problem is really gone; a failed verification means the root cause or approach is wrong '
            + 'and is reported explicitly, never faked) → adversarial check (surface-only fixes / is the problem really gone / new problems) → '
            + 'critical or major problems trigger another fix round and re-check, until it converges → delivery report (with the check log and '
            + 'delivery notes: show the user the actual result; anything they are unhappy with goes back into the loop). '
            + 'Use for: autonomous implementation, engineering delivery, fixing problems found by checkup.',
        parameters: {
            task: { type: 'string', required: true, description: 'Description of the task to complete (or what to fix).' },
            issues: { type: 'string', description: 'Optional: checkup\'s problem list (JSON array text: [{level, issue, evidence}]) to use as the repair tasks.' },
            acceptance: { type: 'string', description: 'Optional: overall acceptance criteria.' },
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
                    text: value.ok ? value.report : `fix could not complete: ${value.report}`,
                }],
        },
        async execute(args, exec) {
            const parent = exec.agent;
            if (!parent)
                throw new Error('fix requires a calling agent (exec.agent was undefined)');
            assertNotWorkflowChild(workflowChildren, parent, 'fix');
            const task = String(args.task).trim();
            if (task.length === 0)
                throw new Error('fix: task must not be empty');
            const issues = parseIssueList(args.issues, 'fix: issues');
            return runWorkflow(ctx, common, {
                script: FIX_SCRIPT,
                meta: {
                    name: 'inspect-fix',
                    description: 'Root cause (dataflow) → implement by data judgment → verify via repro → adversarial gate loop.',
                    phases: [
                        { title: 'Plan', detail: 'Steps with acceptance (or checkup issues)' },
                        // The engine matches phase() calls by exact title (workflow/types.ts), so each
                        // concrete round is declared — MAX_ROUNDS is 3 in the script.
                        { title: 'Implement · round 1', detail: 'Root cause → implement → verify via repro' },
                        { title: 'Implement · round 2', detail: 'Root cause → implement → verify via repro' },
                        { title: 'Implement · round 3', detail: 'Root cause → implement → verify via repro' },
                        { title: 'Check · round 1', detail: 'Adversarial check, fix loop' },
                        { title: 'Check · round 2', detail: 'Adversarial check, fix loop' },
                        { title: 'Check · round 3', detail: 'Adversarial check, fix loop' },
                    ],
                },
                args: {
                    task,
                    ...(issues !== undefined ? { issues } : {}),
                    ...(args.acceptance !== undefined ? { acceptance: String(args.acceptance) } : {}),
                    ...(Object.keys(models).length > 0 ? { models } : {}),
                },
            }, parent, exec.signal);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'review',
        description: 'Quality-review tool: sends several adversarial reviewer agents to review a deliverable (code / design / docs) from different angles, '
            + 'then merges and deduplicates into a graded problem report (critical / major / minor). Pass fixed_issues (a list of fixes to verify) '
            + 'and the reviewers re-run each reproduction to confirm the problem is really gone (reporting "critical" if not). '
            + 'Use for: quality gates after a task, review before commit/delivery, design reviews.',
        parameters: {
            target: { type: 'string', required: true, description: 'The deliverable to review (a path or a description).' },
            dimensions: { type: 'string', description: 'Optional: the angles to review from — one per line, or separated by semicolons or commas; separators inside brackets do not split. One or more, no fixed limit (2-6 recommended; the engine\'s maxTotalAgents is the backstop). Default: implementation quality / edge cases and error handling / security and resources. One reviewer agent runs per angle.' },
            context: { type: 'string', description: 'Optional: background (requirements, acceptance criteria).' },
            fixed_issues: { type: 'string', description: 'Optional: fixes to verify (JSON array text: [{level, issue, evidence}]); the reviewers confirm one by one whether each problem is really gone.' },
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
                    text: value.ok ? value.report : `review could not complete: ${value.report}`,
                }],
        },
        async execute(args, exec) {
            const parent = exec.agent;
            if (!parent)
                throw new Error('review requires a calling agent (exec.agent was undefined)');
            assertNotWorkflowChild(workflowChildren, parent, 'review');
            const target = String(args.target).trim();
            if (target.length === 0)
                throw new Error('review: target must not be empty');
            const dims = splitList(args.dimensions);
            const fixedIssues = parseIssueList(args.fixed_issues, 'review: fixed_issues');
            return runWorkflow(ctx, common, {
                script: REVIEW_SCRIPT,
                meta: {
                    name: 'inspect-review',
                    description: 'Parallel multi-angle quality review with deduped graded issues.',
                    phases: [{ title: 'Review', detail: 'Parallel reviewers + merge' }],
                },
                args: {
                    target,
                    ...(dims.length > 0 ? { dimensions: dims } : {}),
                    ...(args.context !== undefined ? { context: String(args.context) } : {}),
                    ...(fixedIssues !== undefined ? { fixed_issues: fixedIssues } : {}),
                    ...(Object.keys(models).length > 0 ? { models } : {}),
                },
            }, parent, exec.signal);
        },
    }));
}
// ── helpers ─────────────────────────────────────────────────────────────────
async function runWorkflow(ctx, common, request, parent, signal) {
    // Covers both a provider that was never there and one revoked mid-session —
    // same clear error instead of a TypeError on `.start`.
    const workflows = requireWorkflows(ctx);
    const run = workflows.start({ ...request, ...common, parent, signal });
    // Bridge the tool's abort signal to the run: if the parent step is aborted
    // while the script is in flight, cancel the whole run. The signal also
    // enters the engine directly, but this local bridge preserves the tool
    // contract even if an implementation ignores it (official tool-workflow:
    // packages/workflow/tool-workflow/src/index.ts:199-222).
    const onAbort = () => { run.cancel('parent step aborted'); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        const result = await run.result;
        if (result.stopReason !== 'completed') {
            throw new Error(`workflow run ${result.stopReason}${result.error !== undefined ? ` (${result.error})` : ''}`);
        }
        const raw = result.value;
        if (raw === null || typeof raw !== 'object') {
            throw new Error('workflow returned no report');
        }
        const record = raw;
        if (typeof record.report !== 'string') {
            throw new Error('workflow returned no report');
        }
        // Pass through the structured fields each script actually returned
        // (checkup: issues / fix: rounds / review: issues+passed); omit the rest.
        const out = { ok: true, report: record.report };
        if (record.issues !== undefined)
            out.issues = record.issues;
        if (record.rounds !== undefined)
            out.rounds = record.rounds;
        if (record.passed !== undefined)
            out.passed = record.passed;
        return out;
    }
    finally {
        signal.removeEventListener('abort', onAbort);
        // Always reach run quiescence — never leak a live script or children.
        await run.dispose();
    }
}
/**
 * Split a list argument into items. Separators are tiered and only the
 * strongest one present outside brackets is used: newline > `;`/`；` >
 * `,`/`，`/`、`. So "a, b, c" gives 3 items, "x (p, q); y" gives 2, and
 * one-item-per-line text keeps each line's own `;`/`,` detail intact.
 * Separators inside (), （）, [], 【】 or {} never split; with unbalanced
 * brackets the bracket rule is dropped for that tier.
 */
export function splitList(raw) {
    if (typeof raw !== 'string')
        return [];
    const topLevel = (seps, useBrackets) => {
        const items = [];
        let depth = 0;
        let current = '';
        let found = false;
        for (const ch of raw) {
            if (useBrackets && '(（[【{'.includes(ch))
                depth += 1;
            else if (useBrackets && ')）]】}'.includes(ch))
                depth = Math.max(0, depth - 1);
            if (depth === 0 && seps.includes(ch)) {
                items.push(current);
                current = '';
                found = true;
            }
            else {
                current += ch;
            }
        }
        items.push(current);
        if (useBrackets && depth !== 0)
            return topLevel(seps, false);
        return found ? items : undefined;
    };
    let parts = [raw];
    for (const seps of ['\n', ';；', ',，、']) {
        const split = topLevel(seps, true);
        if (split !== undefined) {
            parts = split;
            break;
        }
    }
    return parts.map((s) => s.trim().replace(/[.。;；,，]$/, '').trim()).filter((s) => s.length > 0);
}
/**
 * Parse the issues/fixed_issues JSON-array text parameter (declared shape
 * [{level, issue, evidence}]). Missing/empty text means "not provided"; a parse
 * failure, a non-array result, or an entry that is not an object (null / array
 * / other primitive) throws — never a silent downgrade. Levels from the
 * pre-fork Chinese version (严重/一般/建议) are mapped to critical/major/minor.
 * @returns parsed array of issue objects, or undefined when not provided.
 */
function parseIssueList(raw, label) {
    if (raw === undefined || raw === null)
        return undefined;
    const shape = `${label} must be a JSON array ([{level, issue, evidence}])`;
    if (typeof raw !== 'string')
        throw new Error(shape);
    const text = raw.trim();
    if (text.length === 0)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new Error(shape);
    }
    if (!Array.isArray(parsed))
        throw new Error(shape);
    return parsed.map((item) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`${label}: every entry must be an object ({level, issue, evidence}), got: ${JSON.stringify(item)}`);
        }
        // The contract (type Issue and the tool descriptions) requires level +
        // issue: an entry missing either would silently degrade the script's level
        // filter / problem text, so fail loud here and never pass it through.
        const record = item;
        if (typeof record.issue !== 'string' || record.issue.trim().length === 0) {
            throw new Error(`${label}: every entry needs a string issue, got: ${JSON.stringify(item)}`);
        }
        if (typeof record.level !== 'string' || record.level.trim().length === 0) {
            throw new Error(`${label}: every entry needs a string level, got: ${JSON.stringify(item)}`);
        }
        const level = LEGACY_LEVELS[record.level.trim()] ?? record.level.trim();
        return { ...record, level };
    });
}
function positiveInt(value, fallback, label) {
    if (value === undefined || value === null)
        return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
        throw new Error(`dsh-inspect: ${label} must be a positive integer`);
    }
    return n;
}
function optionalString(value, label) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string') {
        throw new Error(`dsh-inspect: ${label} must be a string`);
    }
    return value;
}
//# sourceMappingURL=index.js.map