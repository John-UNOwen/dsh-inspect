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
// The dsh fork of schemastery: its `.volatile()` fields are what dsh settings
// and the Plugins page can edit, and what the loader updates without a restart.
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
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
/** Red-team cap unless configured; criticals are always attacked. */
const REDTEAM_MAX_DEFAULT = 6;
/** Fix rounds unless configured. */
const FIX_ROUNDS_DEFAULT = 3;
/** Upper bound for fixMaxRounds: every round is declared as two workflow phases up front. */
const FIX_ROUNDS_MAX = 20;
/**
 * Config schema. Every field is `.volatile()`, so dsh offers it for editing
 * and the loader hands `apply` a live reference instead of a fixed value:
 * an edit applies to the next tool call, without remounting the plugin.
 * The loader validates against this schema; `resolveSettings` re-checks each
 * read, so programmatic callers that skip the loader still fail loud.
 */
export const Config = z.object({
    redteamMinLevel: z.union(['critical', 'major', 'minor'])
        .default('major')
        .description('Lowest level the red team attacks: critical, major (critical and major) or minor (every claim).')
        .volatile(),
    redteamMaxClaims: z.natural()
        .max(Number.MAX_SAFE_INTEGER)
        .default(REDTEAM_MAX_DEFAULT)
        .description('Most claims the red team attacks per checkup/review run; criticals are always attacked. 0 = no limit.')
        .volatile(),
    fixMaxRounds: z.natural()
        .min(1)
        .max(FIX_ROUNDS_MAX)
        .default(FIX_ROUNDS_DEFAULT)
        .description('Fix rounds before fix stops and reports the problems that remain.')
        .volatile(),
    maxTotalAgents: z.natural()
        .min(1)
        .max(Number.MAX_SAFE_INTEGER)
        .description('Total sub-agents one checkup/fix/review run may start; empty = the workflow engine\'s ceiling.')
        .volatile(),
    subagentProvider: z.string()
        .description('Sub-agent provider for every run; empty = the workflow engine default.')
        .volatile(),
    plannerModel: z.string().description('Model for the fix planner; empty = inherit.').volatile(),
    workerModel: z.string().description('Model for fix implementers; empty = inherit.').volatile(),
    checkerModel: z.string().description('Model for checkup checkers and the fix checker; empty = inherit.').volatile(),
    reviewerModel: z.string().description('Model for review reviewers and fix verifiers; empty = inherit.').volatile(),
    mergerModel: z.string().description('Model for merging findings; empty = inherit.').volatile(),
    redteamModel: z.string().description('Model for red-team attackers; empty = inherit.').volatile(),
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
// ── Shared prompt text and schemas (workflow-engine subset: type / properties / required / additionalProperties / items / enum / const + annotations) ──
/** Severity levels, strongest first. */
const LEVELS = ['critical', 'major', 'minor'];
/** Pre-fork (Chinese) level names → English, accepted on input for issue lists produced by older versions. */
const LEGACY_LEVELS = { '严重': 'critical', '一般': 'major', '建议': 'minor' };
/** Red-team tags on a returned issue (issues below redteamMinLevel are not attacked and carry none). */
const VERDICT_TAGS = ['confirmed', 'downgraded', 'unverified', 'not attacked'];
/** Concrete severity rubric, shared by every prompt that grades a problem. */
const RUBRIC = 'Levels: critical = data loss or corruption, a security hole, a crash or hang on a common path, or the feature does not work at all; '
    + 'major = wrong results or broken behavior for realistic inputs or settings, a resource leak, or an error a real caller can hit; '
    + 'minor = style, naming, docs, unlikely edge cases, or improvements that do not change behavior. If unsure between two levels, pick the lower one.';
/**
 * How a structured child returns its result. The engine records it only from
 * the structured-output tool call (the spawn driver's `structured_output`); a
 * child that prints JSON as plain text produces no result and agent() returns
 * null, so no prompt may ask for "JSON only" output.
 */
const STRUCTURED = 'When you are done, report your result by calling the structured output tool with arguments that match its schema; a plain-text answer is not recorded.';
/** The checker/reviewer brief. How to verify depends on whether the target is code or a document. */
function adversarialBrief(role) {
    return `You are an adversarial ${role}. Distrust everything by default: look for counterexamples, and do not take code comments, the README or anyone's claims at face value. `
        + 'Report only problems you checked yourself; a false report costs more than a missed one. '
        + 'Before judging, follow the data: where the input comes from, how it is processed and stored, and where it ends up; a problem is a point where the actual state differs from what is expected. '
        + 'How to check depends on the target. For code or a running system, reproduce it (run it, compare input with output, compare logs or two code paths) and state the expected and the actual result. '
        + 'For a design or a document, quote the exact passage and show the concrete case where it fails, contradicts itself or another source, or leaves a requirement unmet. '
        + 'Do not report anything you could not check one of these ways.';
}
/** Findings from checkers and reviewers: evidence is required. */
const FINDINGS_SCHEMA = {
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
                    issue: { type: 'string', description: 'What is wrong, in one or two sentences.' },
                    evidence: { type: 'string', description: 'File and line, quoted passage, or observed output that shows the problem.' },
                    reproduce: { type: 'string', description: 'How to reproduce or check it (a command, a test, or steps), if you have one.' },
                },
                required: ['level', 'issue', 'evidence'],
            },
        },
    },
    required: ['issues'],
};
/** One red-team verdict on one claim. */
const VERDICT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        verdict: { type: 'string', enum: ['confirmed', 'refuted', 'downgraded', 'unverified'] },
        level: { type: 'string', enum: [...LEVELS], description: 'The lower level, for a downgraded verdict.' },
        checked: { type: 'string', description: 'Every file you read and command you ran.' },
        evidence: { type: 'string', description: 'The output or file:line that decides the verdict.' },
        reason: { type: 'string' },
    },
    required: ['verdict', 'checked', 'evidence', 'reason'],
};
/** One fix verification (review's fixed_issues). */
const VERIFY_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        status: { type: 'string', enum: ['gone', 'still present', 'unverified'] },
        checked: { type: 'string', description: 'Every file you read and command you ran.' },
        evidence: { type: 'string', description: 'The output that decides the status.' },
    },
    required: ['status', 'checked', 'evidence'],
};
// Shape of an issue in the tool output schemas (DSL form: nested value nodes
// cannot use a `required` array, only per-property `required: true`).
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
            reproduce: { type: 'string' },
            verdict: { type: 'string', enum: ['confirmed', 'downgraded', 'unverified', 'not attacked'] },
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
// ── Script-side helpers shared by checkup and review ────────────────────────
//
// Merge: findings are numbered (F1, F2, …) and the merger returns, for each
// merged item, the ids it combines (schema enum = the real ids, so it cannot
// invent one). The script then enforces what the merger may not do: an item
// takes the highest level of its sources (the merger never grades), a finding
// left out is added back unmerged, and an item that cites no finding is
// dropped. Dedup can therefore never lose or re-grade a problem.
//
// Red team: one attacker per claim, after the merge, criticals first. Each gets
// the target and one claim, and must try to break it with tools before
// returning a verdict. The script applies verdicts by position, never by text:
// a decisive verdict without what was checked and the evidence counts as
// unverified; a downgrade must lower the level; an unverified critical drops
// to major; refuted claims are removed but listed in the report with their
// counter-evidence. No model runs after the red team, so nothing undoes it.
const SHARED_SCRIPT = String.raw `const RANK = { minor: 0, major: 1, critical: 2 }
const RUBRIC = ${JSON.stringify(RUBRIC)}
const STRUCTURED = ${JSON.stringify(STRUCTURED)}
const VERDICT_SCHEMA = ${JSON.stringify(VERDICT_SCHEMA)}
const VERDICTS = ['confirmed', 'refuted', 'downgraded', 'unverified']
const isLevel = (l) => l === 'critical' || l === 'major' || l === 'minor'
const filled = (s) => typeof s === 'string' && s.trim().length > 0
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const plainIssue = (x) => ({
  level: x.level,
  issue: x.issue,
  ...(filled(x.evidence) ? { evidence: x.evidence } : {}),
  ...(filled(x.reproduce) ? { reproduce: x.reproduce } : {}),
})
const issueLine = (x, i) => (i + 1) + '. [' + x.level + (x.verdict ? ' · ' + x.verdict : '') + '] ' + x.issue
  + (filled(x.evidence) ? ' (evidence: ' + x.evidence + ')' : '')

function collectFindings(results) {
  const out = []
  for (const r of results) {
    if (!r || !Array.isArray(r.issues)) continue
    for (const it of r.issues) {
      if (!it || !isLevel(it.level) || !filled(it.issue)) continue
      out.push({ id: 'F' + (out.length + 1), ...plainIssue(it) })
    }
  }
  return out
}

async function mergeFindings(cands, phaseTitle, model) {
  const solo = (c) => ({ ...plainIssue(c), sources: [c.id] })
  if (cands.length < 2) return { items: cands.map(solo), failed: false, readded: 0, invented: 0 }
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      issues: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            issue: { type: 'string' },
            evidence: { type: 'string' },
            sources: { type: 'array', items: { type: 'string', enum: cands.map((c) => c.id) } },
          },
          required: ['issue', 'sources'],
        },
      },
    },
    required: ['issues'],
  }
  const merged = await agent(
    'You are the merger. Several agents examined the same target; merge their findings below into one list.\n'
    + '- Combine findings that describe the same underlying problem into one item, keeping the clearest description and the most precise evidence;\n'
    + '- In sources, list the ids of every finding an item combines; every id below must appear in the sources of some item;\n'
    + '- Do not drop a finding because you doubt it, and do not add problems that are not below. Levels come from the sources, so you do not set them;\n'
    + '- ' + STRUCTURED + '\n\nFindings:\n' + JSON.stringify(cands),
    { label: 'Merge', phase: phaseTitle, schema, ...(model ? { model } : {}) },
  )
  if (!merged || !Array.isArray(merged.issues)) return { items: cands.map(solo), failed: true, readded: 0, invented: 0 }
  const byId = new Map(cands.map((c) => [c.id, c]))
  const covered = new Set()
  const items = []
  let invented = 0
  for (const m of merged.issues) {
    const sources = [...new Set(Array.isArray(m.sources) ? m.sources : [])].filter((id) => byId.has(id))
    if (sources.length === 0 || !filled(m.issue)) {
      invented += 1
      continue
    }
    for (const id of sources) covered.add(id)
    const src = sources.map((id) => byId.get(id))
    const top = src.reduce((a, b) => (RANK[b.level] > RANK[a.level] ? b : a))
    const withRepro = src.find((s) => filled(s.reproduce))
    items.push({
      level: top.level,
      issue: m.issue,
      ...(filled(m.evidence) ? { evidence: m.evidence } : (filled(top.evidence) ? { evidence: top.evidence } : {})),
      ...(withRepro ? { reproduce: withRepro.reproduce } : {}),
      sources,
    })
  }
  const missing = cands.filter((c) => !covered.has(c.id))
  for (const c of missing) items.push(solo(c))
  return { items, failed: false, readded: missing.length, invented }
}

function mergeNotes(m) {
  const notes = []
  if (m.failed) notes.push('the merger returned no result (all findings kept, not deduplicated)')
  if (m.readded > 0) notes.push('the merger left out ' + m.readded + ' finding(s); they were added back unmerged')
  if (m.invented > 0) notes.push(m.invented + ' merged item(s) cited no finding and were dropped')
  return notes
}

function attackPrompt(it, opts) {
  return 'You are the red team for one problem claim about this target: ' + opts.target
    + (opts.context ? '\nContext: ' + opts.context : '')
    + '\n\nClaim (' + it.level + '): ' + it.issue
    + '\nEvidence given: ' + (filled(it.evidence) ? it.evidence : '(none)')
    + (filled(it.reproduce) ? '\nHow to reproduce, according to the checker: ' + it.reproduce : '')
    + '\n\nYour job is to show this claim is wrong. You succeed by finding why it does not hold; confirming it is what is left when every attack fails. '
    + 'Use your tools: read the code, search it, and run commands or tests in the working directory. '
    + 'Do not edit project files; build any reproduction in a temporary folder and delete it afterwards.\n\n'
    + 'Try each attack and note what you did:\n'
    + '1. Does the cited code (or passage) exist and do what the claim says?\n'
    + '2. Can a real caller reach the failing path with realistic input?\n'
    + '3. Does a guard (validation, a type, an upstream check, an invariant) prevent it?\n'
    + '4. Do tests, docs or comments show the behavior is intended?\n'
    + '5. Can you reproduce it? Record the exact command and its output.\n'
    + '6. If it is real, is the level right? ' + RUBRIC + '\n\n'
    + 'Verdict:\n'
    + '- confirmed: you reproduced it, or traced the path end to end and found no guard;\n'
    + '- refuted: you have concrete counter-evidence (the guard\'s file:line, a passing test, the real output);\n'
    + '- downgraded: it is real but less severe; give the lower level;\n'
    + '- unverified: you could neither confirm nor refute it.\n'
    + 'checked = every file you read and command you ran; evidence = the output or file:line that decides the verdict. '
    + 'A confirmed, refuted or downgraded verdict without both is counted as unverified. ' + STRUCTURED
}

// opts.minLevel: the lowest level attacked ('critical' | 'major' | 'minor').
// opts.max: most claims attacked, criticals always included; 0 = no limit.
async function redTeam(items, opts) {
  const floor = RANK[opts.minLevel] ?? RANK.major
  const eligible = items.map((it, i) => ({ it, i }))
    .filter(({ it }) => RANK[it.level] >= floor)
    .sort((a, b) => RANK[b.it.level] - RANK[a.it.level] || a.i - b.i)
  const critical = eligible.filter(({ it }) => it.level === 'critical')
  const others = eligible.filter(({ it }) => it.level !== 'critical')
  const room = opts.max > 0 ? Math.max(0, opts.max - critical.length) : others.length
  const selected = [...critical, ...others.slice(0, room)]
  let results = []
  if (selected.length > 0) {
    phase(opts.phaseTitle)
    results = await parallel(selected.map(({ it }) => () => agent(attackPrompt(it, opts), {
      label: 'Red team · ' + clip(it.issue, 60),
      phase: opts.phaseTitle,
      schema: VERDICT_SCHEMA,
      ...(opts.model ? { model: opts.model } : {}),
    })))
  }
  const verdictAt = new Map(selected.map(({ i }, k) => [i, results[k]]))
  const kept = []
  const records = []
  let failed = 0
  items.forEach((it, i) => {
    const base = plainIssue(it)
    if (!verdictAt.has(i)) {
      // Below the attacked levels: no verdict. Eligible but over the cap: "not attacked".
      kept.push(RANK[it.level] < floor ? base : { ...base, verdict: 'not attacked' })
      return
    }
    const v = verdictAt.get(i)
    if (!v || !VERDICTS.includes(v.verdict)) {
      failed += 1
      kept.push({ ...base, verdict: 'not attacked' })
      records.push({ issue: it.issue, verdict: 'no result' })
      return
    }
    let verdict = v.verdict
    if (verdict !== 'unverified' && !(filled(v.checked) && filled(v.evidence))) verdict = 'unverified'
    if (verdict === 'downgraded' && !(isLevel(v.level) && RANK[v.level] < RANK[it.level])) verdict = 'confirmed'
    let level = it.level
    if (verdict === 'downgraded') level = v.level
    if (verdict === 'unverified' && level === 'critical') level = 'major'
    records.push({
      issue: it.issue,
      from: it.level,
      to: level,
      verdict,
      checked: filled(v.checked) ? v.checked : '',
      evidence: filled(v.evidence) ? v.evidence : '',
      reason: filled(v.reason) ? v.reason : '',
    })
    if (verdict !== 'refuted') kept.push({ ...base, level, verdict })
  })
  const scope = floor === RANK.critical ? 'critical' : floor === RANK.major ? 'critical/major' : ''
  return { kept, records, failed, eligible: eligible.length, attacked: selected.length, scope }
}

function redTeamSection(rt) {
  const lines = ['## Red team']
  if (rt.eligible === 0) {
    lines.push(rt.scope ? '(No ' + rt.scope.replace('/', ' or ') + ' problems to attack.)' : '(No problems to attack.)')
    return lines
  }
  const count = (v) => rt.records.filter((r) => r.verdict === v).length
  const skipped = rt.eligible - rt.attacked
  lines.push('Attacked ' + rt.attacked + ' of ' + rt.eligible + (rt.scope ? ' ' + rt.scope : '') + ' claim(s).'
    + (skipped > 0 ? ' ' + skipped + ' were over the redteamMaxClaims limit and are marked "not attacked".' : '')
    + (rt.failed > 0 ? ' ' + rt.failed + ' attacker(s) returned no result; those claims are kept and marked "not attacked".' : ''))
  lines.push('confirmed: ' + count('confirmed') + ' · downgraded: ' + count('downgraded')
    + ' · unverified: ' + count('unverified') + ' (an unverified critical drops to major) · refuted: ' + count('refuted'))
  for (const r of rt.records) {
    if (r.verdict === 'no result') {
      lines.push('- [no result] ' + r.issue)
      continue
    }
    const change = r.verdict === 'refuted' ? 'removed' : (r.to !== r.from ? r.from + ' → ' + r.to : r.from)
    lines.push('- [' + r.verdict + ', ' + change + '] ' + r.issue)
    if (r.checked) lines.push('  checked: ' + clip(r.checked, 300))
    if (r.evidence) lines.push('  evidence: ' + clip(r.evidence, 300))
    if (r.reason) lines.push('  reason: ' + clip(r.reason, 300))
  }
  return lines
}
`;
/** Finding requirements shared by checker and reviewer prompts. */
const FINDING_RULES = '\n\nRequirements:\n'
    + '- For each problem give its level, a description, the evidence (file and line, quoted passage, or observed output) and, if you have one, how to reproduce it;\n'
    + '- ' + RUBRIC + '\n'
    + '- If there are no problems, issues is an empty array;\n'
    + '- ' + STRUCTURED;
// ── checkup: find problems ──────────────────────────────────────────────────
export const CHECKUP_SCRIPT = String.raw `${SHARED_SCRIPT}
const FINDINGS_SCHEMA = ${JSON.stringify(FINDINGS_SCHEMA)}
const { target, angles, context, models, redteamMax, redteamMinLevel } = args
const M = models ?? {}
const ANGLES = Array.isArray(angles) && angles.length > 0 ? angles : ['implementation quality', 'edge cases and error handling', 'security and resources']
const REDTEAM_MAX = typeof redteamMax === 'number' ? redteamMax : ${REDTEAM_MAX_DEFAULT}
const REDTEAM_MIN = typeof redteamMinLevel === 'string' ? redteamMinLevel : 'major'
const ADVERSARIAL = ${JSON.stringify(adversarialBrief('checker'))}

phase('Check')
const findings = await parallel(ANGLES.map((a) => () => agent(
  ADVERSARIAL + '\n\n'
  + 'Target: ' + target
  + (context ? '\nContext: ' + context : '')
  + '\n\nYour angle: ' + a
  + ${JSON.stringify(FINDING_RULES)},
  {
    label: 'Check · ' + a,
    phase: 'Check',
    schema: FINDINGS_SCHEMA,
    ...(M.checker ? { model: M.checker } : {}),
  },
)))

// Engine contract: a child that stops without a result makes agent() resolve
// to null (a child whose run rejects fails the whole run instead). Count the
// checkers that returned nothing and say so: never pass a failure off as
// "no problems".
const failedCheckers = findings.filter((f) => !f || !Array.isArray(f.issues)).length
const merge = await mergeFindings(collectFindings(findings), 'Check', M.merger)
const rt = await redTeam(merge.items, { target, context, max: REDTEAM_MAX, minLevel: REDTEAM_MIN, model: M.redteam, phaseTitle: 'Red team' })
const issues = rt.kept

const notes = []
if (failedCheckers > 0) notes.push(failedCheckers + ' checker(s) returned no result')
notes.push(...mergeNotes(merge))
const report = [
  '# Checkup report',
  '',
  'Target: ' + target,
  'Angles: ' + ANGLES.join(', '),
  '',
  '## Problems found (' + issues.length + ')',
  ...(issues.length === 0
    ? [(failedCheckers > 0 ? '(Some agents returned no result, so "no problems" cannot be confirmed.)' : '(No problems found.)')]
    : issues.map(issueLine)),
  '',
  '## Counts',
  'critical: ' + issues.filter((x) => x.level === 'critical').length,
  'major: ' + issues.filter((x) => x.level === 'major').length,
  'minor: ' + issues.filter((x) => x.level === 'minor').length,
  ...(notes.length > 0 ? ['', '## Run log', notes.join('; ')] : []),
  '',
  ...redTeamSection(rt),
].join('\n')
return { issues, report }
`;
// ── fix: repair and deliver ─────────────────────────────────────────────────
export const FIX_SCRIPT = String.raw `const PLAN_SCHEMA = ${JSON.stringify(PLAN_SCHEMA)}
const FINDINGS_SCHEMA = ${JSON.stringify(FINDINGS_SCHEMA)}
const RUBRIC = ${JSON.stringify(RUBRIC)}
const STRUCTURED = ${JSON.stringify(STRUCTURED)}
const { task, issues, acceptance, models, maxRounds } = args
const M = models ?? {}
const MAX_ROUNDS = typeof maxRounds === 'number' && maxRounds >= 1 ? maxRounds : ${FIX_ROUNDS_DEFAULT}
const filled = (s) => typeof s === 'string' && s.trim().length > 0
// Every worker and checker prompt carries the overall task, from round 1 on.
const TASK_LINES = 'Overall task: ' + task + (acceptance ? '\nOverall acceptance criteria: ' + acceptance : '')

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
      reproduce: it.reproduce ?? '',
      level: it.level,
    }
  })
} else {
  const plan = await agent(
    'You are the planner. Break the task below into 3-6 small steps that can each be completed and accepted independently.\n\n'
    + 'Task: ' + task
    + (acceptance ? '\nAcceptance criteria: ' + acceptance : '')
    + '\n\nFor each step give a title and acceptance (what counts as done, and how it can be verified). ' + STRUCTURED,
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

// ── 2. Implement (root cause → implement → verify) → check → fix, until clean ──
// Implementers run one at a time: they share one working tree, so concurrent
// edits to the same files could collide whatever the engine's concurrency.
// A step keeps its output across rounds: when an implementer returns nothing,
// only that step is implemented again next round; when the checker returns
// nothing, the next round re-checks the same work without re-implementing it.
// history accumulates length-capped excerpts of earlier rounds' work, so a
// later worker or checker does not start again from scratch.
const done = []
const checkLogs = []
let round = 0
let history = ''
let pending = steps.map((s) => ({ ...s, output: undefined }))

const workerPrompt = (s) => 'You are the implementer. Work in three steps: find the root cause, implement, verify.\n\n'
  + TASK_LINES
  + '\n\nProblem: ' + s.problem
  + (s.acceptance ? '\nAcceptance criteria: ' + s.acceptance : '')
  + (filled(s.evidence) ? '\nKnown evidence: ' + s.evidence : '')
  + (filled(s.reproduce) ? '\nHow to reproduce: ' + s.reproduce : '')
  + (s.fix ? '\nAdditional requirement: ' + s.fix : '')
  + (history ? '\n\nPrevious round output (the object being checked, excerpt):\n' + history : '')
  + '\n\nStep 1 [Root cause]: do not patch the symptom. Follow the data (input → processing → storage → output, who writes and who reads) '
  + 'and find where the state first goes wrong. Support it with evidence (file and line, the chain of logic, or reproduced behavior). '
  + 'If the cause is unclear, build a minimal reproduction first; do not guess.\n'
  + 'Step 2 [Implement]: fix the root cause with the smallest change that does it. Other steps run one after another in the same working tree, so change only what your step needs.\n'
  + 'Step 3 [Verify]: re-run the original reproduction and compare the output with what is expected, to confirm the problem is really gone; '
  + 'also check that nothing else broke. If the problem is still there, say "verification failed" plainly; never claim a success you did not see.\n'
  + '\nReply in Markdown: the root cause (with evidence), what you changed, and the verification result (commands and output).'

while (pending.length > 0 && round < MAX_ROUNDS) {
  round += 1
  const toImplement = pending.filter((s) => s.output == null)
  if (toImplement.length > 0) {
    phase('Implement · round ' + round)
    for (const [i, s] of toImplement.entries()) {
      s.output = await agent(workerPrompt(s), {
        label: 'Implement ' + (i + 1) + ' · round ' + round,
        phase: 'Implement · round ' + round,
        ...(M.worker ? { model: M.worker } : {}),
      })
    }
  }
  const artifact = pending.map((s) => '[Task] ' + s.title + '\n' + (s.output ?? '(no result returned)')).join('\n\n')
  const archive = () => {
    if (toImplement.length === 0) return
    history = (history ? history + '\n\n' : '') + 'Round ' + round + ' output (excerpt):\n' + artifact.slice(0, 1200)
    if (history.length > 3600) history = history.slice(-3600)
  }

  // A failed implementer means there is nothing complete to check: skip the
  // check (it could not pass) and implement only the missing step next round.
  if (pending.some((s) => s.output == null)) {
    checkLogs.push({ round, problems: [], verified: false, workerFailed: true })
    archive()
    continue
  }

  phase('Check · round ' + round)
  const checked = await agent(
    'You are an adversarial checker. Distrust everything by default and accept only evidence you verify yourself. '
    + 'Check the work below against the task and find the problems that must be fixed.\n\n'
    + TASK_LINES
    + '\n\nWork to check:\n' + artifact
    + (history ? '\n\nPrevious round output (the object being checked, excerpt):\n' + history : '')
    + '\n\nCheck three things, following the data (input → processing → storage → output: is the state back to what is expected?):\n'
    + '1. Does each change fix the root cause? A workaround, or a change that only hides the symptom, is a "major" problem.\n'
    + '2. Is the problem really gone? Re-run the reproduction yourself. If the verification output looks wrong, or an implementer reported "verification failed", report "critical".\n'
    + '3. Did a change break something else, or miss the overall acceptance criteria?\n'
    + '\nReport only critical and major problems. ' + RUBRIC + ' Give the evidence for each. If there are none, issues is an empty array. ' + STRUCTURED,
    {
      label: 'Check · round ' + round,
      phase: 'Check · round ' + round,
      schema: FINDINGS_SCHEMA,
      ...(M.checker ? { model: M.checker } : {}),
    },
  )
  // A round only counts as verified if the checker returned a valid result;
  // otherwise it is logged as unverified and never taken as "passed".
  const verified = !!checked && Array.isArray(checked.issues)
  const problems = verified ? checked.issues.filter((x) => x.level === 'critical' || x.level === 'major') : []
  checkLogs.push({ round, problems, verified, workerFailed: false })
  archive()
  if (!verified) continue

  if (problems.length === 0) {
    for (const s of pending) done.push({ step: s, output: s.output })
    pending = []
    break
  }

  for (const s of pending) done.push({ step: s, output: s.output, hadProblems: true })
  // Every problem goes into the next round, never sliced away. MAX_ROUNDS is
  // the backstop; what is left is listed under "Conclusion" and returned.
  pending = problems.map((p) => ({
    title: 'Fix: ' + p.issue.slice(0, 50),
    acceptance: 'Fix ' + p.issue,
    problem: p.issue,
    evidence: p.evidence ?? '',
    reproduce: p.reproduce ?? '',
    level: p.level,
    fix: p.issue + (p.evidence ? ' (evidence: ' + p.evidence + ')' : ''),
    output: undefined,
  }))
}

// Work that was done but never passed a check (the run ended first) is still
// shown, marked as unchecked, rather than vanishing from the report.
for (const s of pending) if (s.output != null) done.push({ step: s, output: s.output, unchecked: true })

const remaining = pending.map((s) => ({
  level: s.level === 'critical' || s.level === 'major' || s.level === 'minor' ? s.level : 'major',
  issue: s.problem,
  ...(filled(s.evidence) ? { evidence: s.evidence } : {}),
  ...(filled(s.reproduce) ? { reproduce: s.reproduce } : {}),
}))

const parts = ['# Delivery report', '', 'Task: ' + task, 'Rounds: ' + round, '', '## Work done']
for (const d of done) {
  parts.push('### ' + d.step.title + (d.hadProblems
    ? ' (the check found problems this round; they went into the fix loop)'
    : (d.unchecked ? ' (not checked: the run ended before a check passed)' : '')))
  parts.push((d.output ?? '(no output)').slice(0, 1200))
}
parts.push('', '## Check log')
for (const c of checkLogs) {
  if (!c.verified) {
    parts.push('Round ' + c.round + ': ' + (c.workerFailed
      ? 'an implementer returned no result — unverified (only that step is implemented again)'
      : 'the checker returned no result — unverified (the same work is re-checked)'))
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
  parts.push('Feed the remaining problems back into fix to continue. The tool result also lists them as "remaining".')
}
return { report: parts.join('\n'), rounds: round, converged: pending.length === 0, remaining }
`;
// ── review: quality review ──────────────────────────────────────────────────
export const REVIEW_SCRIPT = String.raw `${SHARED_SCRIPT}
const FINDINGS_SCHEMA = ${JSON.stringify(FINDINGS_SCHEMA)}
const VERIFY_SCHEMA = ${JSON.stringify(VERIFY_SCHEMA)}
const { target, dimensions, context, fixed_issues, models, redteamMax, redteamMinLevel } = args
const M = models ?? {}
const DIMS = Array.isArray(dimensions) && dimensions.length > 0 ? dimensions : ['implementation quality', 'edge cases and error handling', 'security and resources']
const REDTEAM_MAX = typeof redteamMax === 'number' ? redteamMax : ${REDTEAM_MAX_DEFAULT}
const REDTEAM_MIN = typeof redteamMinLevel === 'string' ? redteamMinLevel : 'major'
const FIXES = Array.isArray(fixed_issues) ? fixed_issues : []
const ADVERSARIAL = ${JSON.stringify(adversarialBrief('reviewer'))}

phase('Review')
const reviews = await parallel(DIMS.map((d) => () => agent(
  ADVERSARIAL + '\n\n'
  + 'Deliverable: ' + target
  + (context ? '\nContext: ' + context : '')
  + '\n\nYour angle: ' + d
  + ${JSON.stringify(FINDING_RULES)},
  {
    label: 'Review · ' + d,
    phase: 'Review',
    schema: FINDINGS_SCHEMA,
    ...(M.reviewer ? { model: M.reviewer } : {}),
  },
)))

// Same failure standard as checkup: a reviewer that returned nothing is
// reported, and the delivery verdict is then unconfirmed.
const failedReviewers = reviews.filter((r) => !r || !Array.isArray(r.issues)).length
const merge = await mergeFindings(collectFindings(reviews), 'Review', M.merger)
const rt = await redTeam(merge.items, { target, context, max: REDTEAM_MAX, minLevel: REDTEAM_MIN, model: M.redteam, phaseTitle: 'Red team' })

// Each fix to verify gets its own verifier, so every fix ends with a recorded
// status. A status without what was checked and the evidence is unverified.
let fixChecks = []
if (FIXES.length > 0) {
  phase('Verify fixes')
  const results = await parallel(FIXES.map((f) => () => agent(
    'You are verifying one fix in: ' + target
    + (context ? '\nContext: ' + context : '')
    + '\n\nThe problem that was fixed (' + f.level + '): ' + f.issue
    + (filled(f.evidence) ? '\nEvidence from before the fix: ' + f.evidence : '')
    + (filled(f.reproduce) ? '\nHow it was reproduced: ' + f.reproduce : '')
    + '\n\nCheck whether the problem is really gone: re-run the original reproduction, or the check that showed the problem, and compare the result with what is expected. '
    + 'Do not edit project files; build any reproduction in a temporary folder and delete it afterwards.\n'
    + 'status: gone = you re-ran a check and the problem no longer occurs; still present = it still occurs; unverified = you could not run a check that decides it.\n'
    + 'checked = every file you read and command you ran; evidence = the output that decides the status. '
    + 'A gone or still-present status without both is counted as unverified. ' + STRUCTURED,
    {
      label: 'Verify · ' + clip(String(f.issue), 60),
      phase: 'Verify fixes',
      schema: VERIFY_SCHEMA,
      ...(M.reviewer ? { model: M.reviewer } : {}),
    },
  )))
  fixChecks = FIXES.map((f, i) => {
    const v = results[i]
    if (!v || !['gone', 'still present', 'unverified'].includes(v.status)) return { fix: f, status: 'unverified', checked: '', evidence: '', noResult: true }
    const backed = filled(v.checked) && filled(v.evidence)
    return {
      fix: f,
      status: v.status !== 'unverified' && !backed ? 'unverified' : v.status,
      checked: filled(v.checked) ? v.checked : '',
      evidence: filled(v.evidence) ? v.evidence : '',
    }
  })
}
const notHeld = fixChecks.filter((c) => c.status === 'still present').map((c) => ({
  level: 'critical',
  issue: 'Fix did not hold: ' + c.fix.issue,
  ...(c.evidence ? { evidence: c.evidence } : {}),
  verdict: 'confirmed',
}))
const unverifiedFixes = fixChecks.filter((c) => c.status === 'unverified').length
const issues = [...notHeld, ...rt.kept]
const blocking = issues.filter((x) => x.level !== 'minor').length

const notes = []
if (failedReviewers > 0) notes.push(failedReviewers + ' reviewer(s) returned no result')
notes.push(...mergeNotes(merge))
const verdictOpen = failedReviewers > 0 || merge.failed
const report = [
  '# Review report',
  '',
  'Deliverable: ' + target,
  'Angles: ' + DIMS.join(', '),
  '',
  '## Problems (' + issues.length + ')',
  ...(issues.length === 0
    ? [(failedReviewers > 0 ? '(Some agents returned no result, so "no problems" cannot be confirmed.)' : '(No problems found.)')]
    : issues.map(issueLine)),
  '',
  '## Conclusion',
  'critical/major problems: ' + blocking
    + (blocking > 0
      ? ' — fix these before delivering.'
      : (verdictOpen
        ? ' — some agents returned no result; the delivery verdict is unconfirmed.'
        : (unverifiedFixes > 0
          ? ' — ' + unverifiedFixes + ' fix(es) could not be verified; the delivery verdict is unconfirmed.'
          : ' — ready to deliver; minor items are optional follow-ups.'))),
  ...(notes.length > 0 ? ['', '## Run log', notes.join('; ')] : []),
  ...(fixChecks.length > 0
    ? ['', '## Fix verification', ...fixChecks.map((c) => '- [' + c.status + '] ' + c.fix.issue
      + (c.noResult ? ' (the verifier returned no result)' : (c.evidence ? ' — evidence: ' + clip(c.evidence, 300) : '')))]
    : []),
  '',
  ...redTeamSection(rt),
].join('\n')
return {
  report,
  issues,
  // passed is true only when nothing blocks delivery and every part of the
  // review actually ran: no failed reviewer or merger, every fix verified gone.
  passed: blocking === 0 && !verdictOpen && unverifiedFixes === 0,
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
            + 'the official workflow engine (@deepseek-ai/dsh-workflow). This bundle re-enables the host '
            + '`workflow-ptc` row; if it is disabled in your profile\'s cordis.patch.yml, enable it again.');
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
/** The value of a config field: a volatile reference is read, a plain value is used as is. */
function readLive(raw) {
    if (typeof raw === 'object' && raw !== null && typeof raw.get === 'function') {
        return raw.get();
    }
    return raw;
}
/**
 * A getter for one config field, re-read on every call so edits from dsh
 * settings apply without a restart. `check` validates and normalizes (and
 * throws on a bad value): the first read must pass, so misconfiguration
 * fails loud in `apply`; a later bad value keeps the last good one.
 */
function liveField(raw, check) {
    let last = check(readLive(raw));
    return () => {
        try {
            last = check(readLive(raw));
        }
        catch {
            // Keep the last good value. The loader validates edits against the
            // schema first, so this only guards programmatic callers.
        }
        return last;
    };
}
/** Trimmed string, or undefined for absent/empty (empty = inherit / engine default). */
function optionalText(label) {
    return (value) => {
        const text = optionalString(value, label);
        return text === undefined || text.trim() === '' ? undefined : text.trim();
    };
}
/** Positive integer up to max, or undefined when absent. */
function optionalPositiveInt(label, max = Number.MAX_SAFE_INTEGER) {
    return (value) => {
        if (value === undefined || value === null)
            return undefined;
        const n = positiveInt(value, 0, label);
        if (n > max)
            throw new Error(`dsh-inspect: ${label} must be at most ${max}`);
        return n;
    };
}
/** Live getters for every setting; `current()` reads them all for one tool call. */
function resolveSettings(config) {
    const subagentProvider = liveField(config.subagentProvider, optionalText('subagentProvider'));
    // null/undefined both mean "leave the engine default": the key is omitted, never sent as 0.
    const maxTotalAgents = liveField(config.maxTotalAgents, optionalPositiveInt('maxTotalAgents'));
    const models = MODEL_KEYS.map(([key, field]) => [field, liveField(config[key], optionalText(key))]);
    const redteamMax = liveField(config.redteamMaxClaims, (value) => value === undefined || value === null ? undefined : nonNegativeInt(value, 'redteamMaxClaims'));
    const redteamMinLevel = liveField(config.redteamMinLevel, (value) => {
        if (value === undefined || value === null)
            return undefined;
        if (value === 'critical' || value === 'major' || value === 'minor')
            return value;
        throw new Error(`dsh-inspect: redteamMinLevel must be 'critical', 'major' or 'minor', got: ${JSON.stringify(value)}`);
    });
    const fixMaxRounds = liveField(config.fixMaxRounds, optionalPositiveInt('fixMaxRounds', FIX_ROUNDS_MAX));
    return () => {
        const provider = subagentProvider();
        const total = maxTotalAgents();
        const max = redteamMax();
        const minLevel = redteamMinLevel();
        const rounds = fixMaxRounds();
        const roleModels = {};
        for (const [field, read] of models) {
            const model = read();
            if (model !== undefined)
                roleModels[field] = model;
        }
        return {
            common: {
                ...(provider !== undefined ? { subagentProvider: provider } : {}),
                ...(total !== undefined ? { maxTotalAgents: total } : {}),
            },
            models: roleModels,
            redteam: {
                ...(max !== undefined ? { redteamMax: max } : {}),
                ...(minLevel !== undefined ? { redteamMinLevel: minLevel } : {}),
            },
            ...(rounds !== undefined ? { fixMaxRounds: rounds } : {}),
        };
    };
}
/**
 * The settings form lives on the Plugins page (client/index.js), so ask dsh
 * settings not to generate one from the schema: `configure({ auto: false },
 * fiber)` inside an optional `settings` child, as dsh-settings documents.
 * Without the settings service this does nothing.
 */
function ownSettingsPage(ctx) {
    if (typeof ctx.inject !== 'function')
        return;
    const fiber = ctx.fiber;
    ctx.inject(['settings'], (scope) => {
        const service = scope.settings;
        if (typeof service?.configure !== 'function')
            return;
        scope.effect(() => service.configure?.({ auto: false }, fiber) ?? (() => { }), 'dsh-inspect: own settings page');
    });
}
/** The fix workflow's phases: every round's titles are declared up front (the engine matches phase() by exact title). */
function fixPhases(rounds) {
    const implement = Array.from({ length: rounds }, (_, i) => ({
        title: 'Implement · round ' + (i + 1),
        detail: 'Root cause → implement → verify via repro',
    }));
    const check = Array.from({ length: rounds }, (_, i) => ({
        title: 'Check · round ' + (i + 1),
        detail: 'Adversarial check, fix loop',
    }));
    return [{ title: 'Plan', detail: 'Steps with acceptance (or checkup issues)' }, ...implement, ...check];
}
export function apply(ctx, config = {}) {
    // Deliberately NOT checking the workflows dependency here: see
    // requireWorkflows — an apply-time failure hangs the whole loader group.
    // The exported Config schema validates at load; resolveSettings re-checks
    // (fail loud here for programmatic callers that skip the loader) and
    // re-reads every field per tool call, so edits in dsh settings apply live.
    const settings = resolveSettings(config);
    const workflowChildren = trackWorkflowChildren(ctx);
    // Slash commands (/checkup, /fix, /inspect-review). Registered in a child
    // fiber that waits for the `commands` service, so profiles without a
    // command UI still load the tools; see registerCommands.
    if (typeof ctx.inject === 'function')
        ctx.inject(['commands'], (cctx) => registerCommands(cctx));
    ownSettingsPage(ctx);
    ctx.tools.register(defineTool({
        name: 'checkup',
        description: 'Problem-finding tool: sends several adversarial checker agents to examine the target (code / system / design) from different angles, '
            + 'merges and deduplicates their findings, then a red team attacks each claim with tools (critical and major by default; one attacker per claim: '
            + 'refuted claims are removed, unproven ones are marked unverified) — finding is suspicion, verification is conviction. '
            + 'Returns a problem list (critical / major / minor, with evidence and a red-team verdict). '
            + 'The problems found can be passed straight to the fix tool as repair tasks. '
            + 'Use for: fault-finding, audits, health checks, investigating suspicious behavior, verifying whether a problem is real.',
        parameters: {
            target: { type: 'string', required: true, description: 'What to check (a path or a description; the checker agents look at it themselves).' },
            angles: { type: 'string', description: 'Optional: the angles to check from — one per line, or separated by semicolons or commas (not both on one line); separators inside brackets do not split. One or more, no fixed limit (2-6 recommended; the engine\'s maxTotalAgents is the backstop). Default: implementation quality / edge cases and error handling / security and resources. One checker agent runs per angle.' },
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
            const angles = splitList(args.angles, 'checkup: angles');
            const run = settings();
            return runWorkflow(ctx, run.common, exec, {
                script: CHECKUP_SCRIPT,
                meta: {
                    name: 'inspect-checkup',
                    description: 'Parallel problem finding with deduped, graded issues.',
                    phases: [
                        { title: 'Check', detail: 'Parallel checkers + merge' },
                        { title: 'Red team', detail: 'One attacker per claim' },
                    ],
                },
                args: {
                    target,
                    ...(angles.length > 0 ? { angles } : {}),
                    ...run.redteam,
                    ...(args.context !== undefined ? { context: String(args.context) } : {}),
                    ...(Object.keys(run.models).length > 0 ? { models: run.models } : {}),
                },
            }, parent, exec.signal);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'fix',
        description: 'Repair-and-deliver tool: breaks the task down (or takes checkup\'s problem list) → implements the steps one at a time (they share the working tree), each implementer working in three '
            + 'steps, "root cause → implement → verify" (trace the data flow to where state starts to deviate, implement directly based on the data, '
            + 're-run the reproduction afterwards to confirm the problem is really gone; a failed verification means the root cause or approach is wrong '
            + 'and is reported explicitly, never faked) → adversarial check (surface-only fixes / is the problem really gone / new problems) → '
            + 'critical or major problems trigger another fix round and re-check, until it converges → delivery report (with the check log and '
            + 'delivery notes: show the user the actual result; anything they are unhappy with goes back into the loop). '
            + 'Returns converged and, if not converged, the remaining problems as an issue list that can be passed back in. '
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
                    converged: { type: 'boolean' },
                    remaining: ISSUES_OUTPUT_SCHEMA,
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
            const run = settings();
            return runWorkflow(ctx, run.common, exec, {
                script: FIX_SCRIPT,
                meta: {
                    name: 'inspect-fix',
                    description: 'Root cause (dataflow) → implement by data judgment → verify via repro → adversarial gate loop.',
                    phases: fixPhases(run.fixMaxRounds ?? FIX_ROUNDS_DEFAULT),
                },
                args: {
                    task,
                    ...(issues !== undefined ? { issues } : {}),
                    ...(args.acceptance !== undefined ? { acceptance: String(args.acceptance) } : {}),
                    ...(run.fixMaxRounds !== undefined ? { maxRounds: run.fixMaxRounds } : {}),
                    ...(Object.keys(run.models).length > 0 ? { models: run.models } : {}),
                },
            }, parent, exec.signal);
        },
    }));
    ctx.tools.register(defineTool({
        name: 'review',
        description: 'Quality-review tool: sends several adversarial reviewer agents to review a deliverable (code / design / docs) from different angles, '
            + 'merges and deduplicates their findings, and has a red team attack each claim (critical and major by default), giving a graded problem report (critical / major / minor). '
            + 'Pass fixed_issues (a list of fixes to verify) and each fix gets its own verifier that re-runs the reproduction; the report records '
            + 'every fix as gone / still present / unverified, and a fix that did not hold is a critical problem. '
            + 'Use for: quality gates after a task, review before commit/delivery, design reviews.',
        parameters: {
            target: { type: 'string', required: true, description: 'The deliverable to review (a path or a description).' },
            dimensions: { type: 'string', description: 'Optional: the angles to review from — one per line, or separated by semicolons or commas (not both on one line); separators inside brackets do not split. One or more, no fixed limit (2-6 recommended; the engine\'s maxTotalAgents is the backstop). Default: implementation quality / edge cases and error handling / security and resources. One reviewer agent runs per angle.' },
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
            const dims = splitList(args.dimensions, 'review: dimensions');
            const fixedIssues = parseIssueList(args.fixed_issues, 'review: fixed_issues');
            const run = settings();
            return runWorkflow(ctx, run.common, exec, {
                script: REVIEW_SCRIPT,
                meta: {
                    name: 'inspect-review',
                    description: 'Parallel multi-angle quality review with deduped graded issues.',
                    phases: [
                        { title: 'Review', detail: 'Parallel reviewers + merge' },
                        { title: 'Red team', detail: 'One attacker per claim' },
                        { title: 'Verify fixes', detail: 'One verifier per fixed issue' },
                    ],
                },
                args: {
                    target,
                    ...(dims.length > 0 ? { dimensions: dims } : {}),
                    ...run.redteam,
                    ...(args.context !== undefined ? { context: String(args.context) } : {}),
                    ...(fixedIssues !== undefined ? { fixed_issues: fixedIssues } : {}),
                    ...(Object.keys(run.models).length > 0 ? { models: run.models } : {}),
                },
            }, parent, exec.signal);
        },
    }));
}
/** Message source for requests submitted by the slash commands. */
const commandSource = { kind: 'dsh-inspect' };
/**
 * The slash commands. Each hands the request to the current agent as a
 * follow-up user message that asks it to call the matching tool — the agent
 * fills in target/angles itself, so the commands take free-form input.
 * `/review` belongs to other review plugins (e.g. @michengai/dsh-code-review),
 * so dsh-inspect's review command is `/inspect-review`.
 */
export const COMMANDS = [
    {
        name: 'checkup',
        description: 'Find problems: adversarial checkers + red team (dsh-inspect)',
        hint: 'What to check, optionally with angles — leave empty to check this project',
        ack: 'Checkup request sent to the agent.',
        empty: 'Run a dsh-inspect checkup of this project: call the `checkup` tool with the current working directory as the target and 2-6 angles that fit this codebase.',
        withInput: (input) => 'Run a dsh-inspect checkup: call the `checkup` tool for the request below, taking the target, the angles (one per line) and any context from it.\n\nRequest:\n' + input,
    },
    {
        name: 'fix',
        description: 'Fix and deliver: root cause → fix → verify loop (dsh-inspect)',
        hint: 'What to fix — leave empty to fix the latest checkup/review findings',
        ack: 'Fix request sent to the agent.',
        empty: 'Call the dsh-inspect `fix` tool on the problems found by the most recent checkup or review in this session: pass them as `issues` (a JSON array of {level, issue, evidence}) with a short task description. If this session has no such findings, ask me what to fix instead of calling the tool.',
        withInput: (input) => 'Call the dsh-inspect `fix` tool for the task below. If it refers to problems from an earlier checkup or review in this session, pass those as `issues` (a JSON array of {level, issue, evidence}).\n\nTask:\n' + input,
    },
    {
        name: 'inspect-review',
        description: 'Adversarial quality review of a deliverable (dsh-inspect)',
        hint: 'What to review — leave empty to review the current uncommitted changes',
        ack: 'Review request sent to the agent.',
        empty: 'Call the dsh-inspect `review` tool on the current uncommitted changes in this project: check `git status` and `git diff` first, describe the changed files as the target, and pick review angles that fit them.',
        withInput: (input) => 'Call the dsh-inspect `review` tool for the deliverable below, taking the target, the review angles (one per line) and any context from it.\n\nRequest:\n' + input,
    },
];
/**
 * Register the slash commands. A name already taken (another plugin's
 * command) is skipped with a warning — it must never stop the tools loading.
 */
export function registerCommands(ctx) {
    const commands = ctx.commands;
    if (!commands || typeof commands.register !== 'function')
        return;
    for (const spec of COMMANDS) {
        try {
            commands.register({
                name: spec.name,
                description: spec.description,
                input: { hint: spec.hint },
                handler({ agent, rawInput }) {
                    const input = String(rawInput ?? '').trim();
                    agent.followup(createUserMessage({
                        content: [{ type: 'text', text: input ? spec.withInput(input) : spec.empty }],
                        // A plugin-owned source kind; dsh's MessageSource union does not list plugin kinds.
                        source: commandSource,
                    }));
                    return { kind: 'success', text: spec.ack };
                },
            });
        }
        catch (error) {
            ctx.logger?.warn?.(`dsh-inspect: /${spec.name} not registered (${error instanceof Error ? error.message : String(error)})`);
        }
    }
}
// ── helpers ─────────────────────────────────────────────────────────────────
async function runWorkflow(ctx, common, exec, request, parent, signal) {
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
        // (checkup: issues / fix: rounds+converged+remaining / review: issues+passed); omit the rest.
        const out = { ok: true, report: record.report };
        if (record.issues !== undefined)
            out.issues = record.issues;
        if (record.rounds !== undefined)
            out.rounds = record.rounds;
        if (record.passed !== undefined)
            out.passed = record.passed;
        if (record.converged !== undefined)
            out.converged = record.converged;
        if (record.remaining !== undefined)
            out.remaining = record.remaining;
        return await compactReport(ctx, out, request.meta.name, parent, exec);
    }
    finally {
        signal.removeEventListener('abort', onAbort);
        // Always reach run quiescence — never leak a live script or children.
        await run.dispose();
    }
}
/**
 * Longest report returned inline. dsh's tool-result pruner (default
 * `thresholdChars` 8192) cuts the middle out of longer results once the
 * conversation nears compaction — for a long checkup that is exactly the
 * issue list. Reports above this size are saved in full through the spill
 * store and replaced by a compact result: summary, every issue on one line,
 * and the path to the full report.
 */
export const INLINE_REPORT_LIMIT = 6000;
/** Longest issue text kept on its one-line entry in a compact result. */
const COMPACT_ISSUE_CHARS = 240;
/**
 * Keep a long report readable after pruning: save the full text through the
 * spill store and return a compact report that stays under the pruner limit.
 * Without a spill store (or if saving fails) the full report is returned as
 * before — never lose content to make the result shorter.
 */
export async function compactReport(ctx, out, workflowName, parent, exec) {
    if (out.report.length <= INLINE_REPORT_LIMIT)
        return out;
    const store = ctx.get('spillStore');
    if (!store || typeof store.saveText !== 'function')
        return out;
    const toolName = workflowName.replace(/^inspect-/, '');
    let ref;
    try {
        ref = await store.saveText({
            owner: { sessionId: parent.id },
            source: { kind: 'tool', toolName, ...(exec.callId !== undefined ? { callId: exec.callId } : {}), label: 'full report' },
            suggestedName: `${toolName}-report.md`,
            content: out.report,
        });
    }
    catch {
        return out;
    }
    const lines = out.report.split('\n');
    const title = lines[0] ?? `# ${toolName} report`;
    const header = [title, ''];
    for (const line of lines.slice(1)) {
        if (line.startsWith('## '))
            break;
        if (line.trim())
            header.push(line);
    }
    const footer = `\nFull report (evidence, red-team notes, run log): ${ref.locator}`
        + `\n${ref.retrievalHint ?? 'Use read with offset/limit, or grep this path.'}`;
    const body = [];
    const issues = out.issues ?? [];
    if (issues.length > 0) {
        const counts = ['critical', 'major', 'minor'].map((lv) => `${lv}: ${issues.filter((x) => x.level === lv).length}`).join(' · ');
        body.push('', `## Problems (${issues.length}) — ${counts}`, '(One line each; evidence is in the full report.)');
        let used = header.join('\n').length + body.join('\n').length + footer.length + 200;
        for (const [i, x] of issues.entries()) {
            const text = x.issue.length > COMPACT_ISSUE_CHARS ? x.issue.slice(0, COMPACT_ISSUE_CHARS - 1) + '…' : x.issue;
            const line = `${i + 1}. [${x.level}${x.verdict ? ` · ${x.verdict}` : ''}] ${text}`;
            if (used + line.length + 1 > INLINE_REPORT_LIMIT) {
                body.push(`… ${issues.length - i} more — see the full report.`);
                break;
            }
            body.push(line);
            used += line.length + 1;
        }
    }
    else {
        // fix reports carry no issue list: keep as much of the start as fits.
        const room = INLINE_REPORT_LIMIT - header.join('\n').length - footer.length - 100;
        body.push('', out.report.slice(title.length, Math.max(0, room)).trim(), '…');
    }
    return { ...out, report: [...header, ...body].join('\n') + '\n' + footer };
}
/** Words whose trailing period is part of the word, not the end of a sentence. */
const ABBREVIATIONS = new Set(['etc', 'e.g', 'i.e', 'vs', 'cf', 'approx']);
/**
 * Split `text` on any character in `seps` that sits outside brackets.
 * Returns undefined when no such separator exists. If the brackets never
 * close, the bracket rule is dropped so the text still splits.
 */
function splitTopLevel(text, seps) {
    const scan = (useBrackets) => {
        const items = [];
        let depth = 0;
        let current = '';
        let found = false;
        for (const ch of text) {
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
        return { items, depth, found };
    };
    const bracketed = scan(true);
    const result = bracketed.depth !== 0 ? scan(false) : bracketed;
    return result.found ? result.items : undefined;
}
/** Trim one item: drop stray separator punctuation and a sentence-ending period. */
function cleanListItem(raw) {
    const text = raw.trim().replace(/[;；,，、]+$/, '').trim();
    const m = /^(.*?\S)[.。]+$/.exec(text);
    if (m) {
        const lastWord = m[1].split(/\s+/).pop().toLowerCase();
        if (!ABBREVIATIONS.has(lastWord))
            return m[1];
    }
    return text;
}
/**
 * Split a list argument (`angles`, `dimensions`) into items.
 *
 * Separators are tiered, and only the strongest one present at the top level
 * is used: newline > `;`/`；` > `,`/`，`/`、`. Separators inside (), （）, [],
 * 【】 or {} never split. So "a, b, c" gives 3 items, "x (p, q); y" gives 2, and
 * one-item-per-line text keeps each line's own `;`/`,` detail intact.
 *
 * Throws instead of guessing when the input is ambiguous or unusable:
 * - a non-string value (for example a JSON array),
 * - `;` and `,` both separating items on one line (which one was meant?),
 * - input that has text but no items once the separators are removed.
 * Blank or missing input is "not provided" and returns [].
 *
 * @param label names the parameter in error messages.
 */
export function splitList(raw, label = 'list') {
    if (raw === undefined || raw === null)
        return [];
    if (typeof raw !== 'string') {
        throw new Error(`${label} must be a string: one item per line, or separated by ";" or ","`);
    }
    if (raw.trim().length === 0)
        return [];
    const finish = (parts) => {
        const items = parts.map(cleanListItem).filter((s) => s.length > 0);
        if (items.length === 0)
            throw new Error(`${label} contains no items: "${raw.trim()}"`);
        return items;
    };
    const lines = splitTopLevel(raw, '\n');
    if (lines)
        return finish(lines);
    const semicolons = splitTopLevel(raw, ';；');
    if (semicolons) {
        for (const part of semicolons) {
            const commaParts = (splitTopLevel(part, ',，、') ?? [part]).filter((s) => s.trim().length > 0);
            if (commaParts.length > 1) {
                throw new Error(`${label}: ";" and "," both separate items on one line ("${part.trim()}"). `
                    + 'Put one item per line, or use only one of ";" and ","; separators inside brackets are fine.');
            }
        }
        return finish(semicolons);
    }
    return finish(splitTopLevel(raw, ',，、') ?? [raw]);
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
function nonNegativeInt(value, label) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) {
        throw new Error(`dsh-inspect: ${label} must be a non-negative integer`);
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