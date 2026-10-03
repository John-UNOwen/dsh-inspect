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
import type { Context } from 'cordis';
export declare const name = "dsh-inspect";
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
export declare const inject: string[];
/** Loader-validated plugin config (all keys optional: z.object keys default to optional). */
export interface Config {
    /** Child-provider override passed to every workflow run. */
    subagentProvider?: string;
    /** Per-run total-child ceiling for every workflow run. */
    maxTotalAgents?: number;
    /** Role-level model overrides, one per checkup/fix/review role. */
    plannerModel?: string;
    workerModel?: string;
    checkerModel?: string;
    reviewerModel?: string;
    mergerModel?: string;
    redteamModel?: string;
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
export declare const Config: z<Config>;
export declare function apply(ctx: Context, config?: Config): void;
/**
 * Split a list argument into items. Separators are tiered and only the
 * strongest one present outside brackets is used: newline > `;`/`；` >
 * `,`/`，`/`、`. Separators inside brackets never split.
 */
export declare function splitList(raw: string | undefined): string[];
//# sourceMappingURL=index.d.ts.map