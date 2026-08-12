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
import z from 'schemastery';
import type { Context } from 'cordis';
export declare const name = "dsh-inspect";
/** Activate once the tool registry and the official workflow service are available. */
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
//# sourceMappingURL=index.d.ts.map