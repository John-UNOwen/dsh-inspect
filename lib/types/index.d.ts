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
 * Build: the package entry is the compiled lib/types/index.js, committed with
 * the source — dsh loads that, not this file. After changing this file run
 * `pnpm run build` and commit lib/ too; the regression suite fails when lib/
 * no longer matches src/. Syntax must stay erasable-only (no enums /
 * namespaces / parameter properties): the tests strip types with
 * node:module's stripTypeScriptTypes.
 *
 * @module @dsh-external/dsh-inspect
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
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
/** A config value as written, or the live reference the loader passes for a volatile field. */
export type Live<T> = T | {
    get(): T | undefined;
};
/** The lowest level the red team attacks. */
export type RedteamMinLevel = 'critical' | 'major' | 'minor';
/**
 * Plugin configuration. Every field is volatile: it can be edited in dsh
 * (the Plugins page, or the profile's cordis.patch.yml) and applies to the
 * next tool call without a restart.
 */
export interface Config {
    /** Child-provider override passed to every workflow run. */
    subagentProvider?: Live<string>;
    /** Per-run total-child ceiling for every workflow run. */
    maxTotalAgents?: Live<number>;
    /** Role-level model overrides, one per checkup/fix/review role. */
    plannerModel?: Live<string>;
    workerModel?: Live<string>;
    checkerModel?: Live<string>;
    reviewerModel?: Live<string>;
    mergerModel?: Live<string>;
    redteamModel?: Live<string>;
    /** The lowest level the red team attacks: critical, major (critical and major) or minor (every claim). */
    redteamMinLevel?: Live<RedteamMinLevel>;
    /** Claims the red team attacks per checkup/review run; criticals are always attacked; 0 = no limit. */
    redteamMaxClaims?: Live<number>;
    /** Fix rounds before fix stops and reports what is left. */
    fixMaxRounds?: Live<number>;
}
/**
 * Config schema. Every field is `.volatile()`, so dsh offers it for editing
 * and the loader hands `apply` a live reference instead of a fixed value:
 * an edit applies to the next tool call, without remounting the plugin.
 * The loader validates against this schema; `resolveSettings` re-checks each
 * read, so programmatic callers that skip the loader still fail loud.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    redteamMinLevel: z<"critical" | "major" | "minor", "critical" | "major" | "minor", "volatile-defined">;
    redteamMaxClaims: z<number, number, "volatile-defined">;
    fixMaxRounds: z<number, number, "volatile-defined">;
    maxTotalAgents: z<number, number, "volatile">;
    subagentProvider: z<string, string, "volatile">;
    plannerModel: z<string, string, "volatile">;
    workerModel: z<string, string, "volatile">;
    checkerModel: z<string, string, "volatile">;
    reviewerModel: z<string, string, "volatile">;
    mergerModel: z<string, string, "volatile">;
    redteamModel: z<string, string, "volatile">;
}>>, Schemastery.ObjectT<NoInfer<{
    redteamMinLevel: z<"critical" | "major" | "minor", "critical" | "major" | "minor", "volatile-defined">;
    redteamMaxClaims: z<number, number, "volatile-defined">;
    fixMaxRounds: z<number, number, "volatile-defined">;
    maxTotalAgents: z<number, number, "volatile">;
    subagentProvider: z<string, string, "volatile">;
    plannerModel: z<string, string, "volatile">;
    workerModel: z<string, string, "volatile">;
    checkerModel: z<string, string, "volatile">;
    reviewerModel: z<string, string, "volatile">;
    mergerModel: z<string, string, "volatile">;
    redteamModel: z<string, string, "volatile">;
}>>, "plain">;
/** Severity levels, strongest first. */
declare const LEVELS: readonly ["critical", "major", "minor"];
/** Red-team tags on a returned issue (issues below redteamMinLevel are not attacked and carry none). */
declare const VERDICT_TAGS: readonly ["confirmed", "downgraded", "unverified", "not attacked"];
/** One graded issue as produced by the checkup/review pipelines. */
type Issue = {
    level: typeof LEVELS[number];
    issue: string;
    evidence?: string;
    reproduce?: string;
    verdict?: typeof VERDICT_TAGS[number];
};
export declare const CHECKUP_SCRIPT: string;
export declare const FIX_SCRIPT: string;
export declare const REVIEW_SCRIPT: string;
/** The tool result shape all three tools share (script-owned fields pass through). */
type ToolResult = {
    ok: boolean;
    report: string;
    issues?: Issue[];
    rounds?: number;
    passed?: boolean;
    converged?: boolean;
    remaining?: Issue[];
};
export declare function apply(ctx: Context, config?: Config): void;
/** One slash command: its prompt for empty input and for a free-form request. */
interface CommandSpec {
    name: string;
    description: string;
    hint: string;
    ack: string;
    empty: string;
    withInput: (input: string) => string;
}
/**
 * The slash commands. Each hands the request to the current agent as a
 * follow-up user message that asks it to call the matching tool — the agent
 * fills in target/angles itself, so the commands take free-form input.
 * `/review` belongs to other review plugins (e.g. @michengai/dsh-code-review),
 * so dsh-inspect's review command is `/inspect-review`.
 */
export declare const COMMANDS: readonly CommandSpec[];
/**
 * Register the slash commands. A name already taken (another plugin's
 * command) is skipped with a warning — it must never stop the tools loading.
 */
export declare function registerCommands(ctx: Context): void;
/**
 * Longest report returned inline. dsh's tool-result pruner (default
 * `thresholdChars` 8192) cuts the middle out of longer results once the
 * conversation nears compaction — for a long checkup that is exactly the
 * issue list. Reports above this size are saved in full through the spill
 * store and replaced by a compact result: the summary, one line per issue
 * (shortened so as many fit as possible; past that, a count), and the path
 * to the full report.
 */
export declare const INLINE_REPORT_LIMIT = 6000;
/**
 * Keep a long report readable after pruning: save the full text through the
 * spill store and return a compact report that stays under the pruner limit.
 * Without a spill store (or if saving fails) the full report is returned as
 * before — never lose content to make the result shorter.
 */
export declare function compactReport(ctx: Context, out: ToolResult, workflowName: string, parent: Agent, exec: {
    readonly callId?: unknown;
}): Promise<ToolResult>;
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
export declare function splitList(raw: unknown, label?: string): string[];
export {};
//# sourceMappingURL=index.d.ts.map