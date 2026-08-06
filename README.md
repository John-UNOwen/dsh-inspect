# @dsh-external/dsh-inspect

**发现问题 → 修复交付 → 质量复查** 的简单闭环插件。

三个朴素工具，共享同一套"对抗式检查"机制：


| 工具        | 干什么  | 核心机制                                                                                 |
| --------- | ---- | ------------------------------------------------------------------------------------ |
| `checkup` | 找问题  | 对抗式检查员（各看一个角度）→ **红队攻击验证**（尝试推翻问题声明，推不翻的才保留）→ 汇总分级（严重/一般/建议）                         |
| `fix`     | 修复交付 | 拆解 → 并行实现（每个实现员按**找根因**（沿数据流找偏离源头）→ 实施 → **重跑复现验证**（反馈闭合））→ **对抗式检查** → 修复轮收敛 → 交付报告 |
| `review`  | 质量复查 | 对抗式审查员（各看一个角度）→ 汇总分级；可传 `fixed_issues` 逐条**重跑复现确认问题真的消失**                            |


## 理论内核：控制论的反馈机制

- **发现是怀疑，验证是定罪**：检查员/审查员一律对抗式（默认怀疑、找反例、只认可当场验证的证据）；
checkup 的红队环节就是负反馈——问题声明必须经受住攻击，推不翻才成立。
- **根据数据流定向判断状态**：判断问题前先按数据流理清系统（输入 → 处理 → 存储 → 输出，
谁写谁读）；**问题 = 数据流某处状态偏离预期**，而不是静态读代码猜。
- **互相校验**：每个问题必须给出可互相校验的验证方式（重跑复现 / 日志对照 / 输入输出对照 /
双路径对照），并写明预期状态与实际观测——**无法通过系统反馈验证的，不许报**。
- **修复要证伪**：先沿数据流找到状态偏离的**源头**（不许修表面）；修复后重跑原复现，
观测输出与预期比较（反馈闭合）——问题没消失 = 根因没找对，重新分析。
- **根据数据判断直接定方案**：根因找到后，方案由数据自然决定——实现员按"找根因 → 实施 → 验证"
三步直接做（根据数据判断选择最合理的方案，不空谈不犹豫，实施保持改动最小）。
- **闭环**：checkup 的问题清单 → fix 修复任务 → review 把关（可逐条验证修复是否真消失）；
复查不通过或人的反馈重新进入 fix。三个工具可单独用，也可串起来。

## 结构

```
dsh-inspect/
├── package.json    # @dsh-external/dsh-inspect (MIT)
├── lib/index.js    # cordis 插件：注册 checkup/fix/review 三个工具（官方 workflow 引擎）
├── test/
│   └── regression.test.mjs  # 回归测试：前两轮 10 项修复固化为可重跑用例（node:test）
└── README.md
```

## 测试（回归）

```bash
cd plugins/dsh-inspect && node --test        # 零依赖，纯 node + node:test
# 或：node --test test/（Node ≤20 支持目录参数；Node 22+ 把位置参数当 glob，请用
#     node --test 或 node --test 'test/**'，见 nodejs/node 测试运行器 glob 语义）
```

`test/regression.test.mjs` 用与引擎相同的 `vm.Script '(async () => { body })()'` 包装 +
全局钩子（`agent`/`parallel`/`phase`/`log`/`args`，agent 按 label 出 mock 队列）求值
`lib/index.js` 里真实的三个脚本，把前两轮的 10 项修复固化为可重跑断言：

① 转义无字面 `'\n'`（提示词/报告用真实换行）；② 红队五态（有效/空数组/null/部分覆盖/
幻觉剔除）；③ 子代理失败（checker/reviewer/merger/worker）如实标注不假干净；④ passed
诚实三态；⑤ fix 假收敛防护（checker null、worker null 均不产生假「通过」）；⑥ 4 个问题
全部重修；⑦ 未收敛明细；⑧ runWorkflow 透传 issues/rounds/passed；⑨ 参数校验抛错
（非数组/条目非对象）；⑩ 输出 schema 编译通过（移植 dsh-tools 的 DSL 编译 + 受支持子集
断言 + 值校验）。

工具注册层（⑧⑨⑩）优先动态 import 真实模块（tsx/DSH 环境），纯 node 下依赖不可解析时
退化为 vm 求值模块源码（mock schemastery/defineTool），两条路径断言一致。

改动任何脚本行为后跑 `node --test`，回归立刻可见。

## 安装（挂载）

`~/.dsh/config.yaml` 追加（本机已挂载）：

```yaml
- insert:
    - id: dsh-inspect
      name: /path/to/dsh-inspect/lib/index.js   # 换成你的克隆/检出路径
```

重启 `dsh` 生效。绝对路径加载，不需要 pnpm link，不触碰源码 checkout。
卸载：删除上述 insert 块即可。

## 工具参数

**checkup**：`target`（必填，检查目标）+ `angles`（可选，检查角度，逗号分隔，1 个起，数量不限，
建议 2-6 个，引擎 `maxTotalAgents`/`maxItemsPerCall` 兜底）+
`context`（可选背景）。输出问题清单（严重/一般/建议，含证据与验证方式）。

**fix**：`task`（必填）+ `issues`（可选，checkup 的问题 JSON 数组，作为修复任务）+
`acceptance`（可选验收标准）。
输出交付报告（完成情况 + 检查记录 + 交付说明）。

**review**：`target`（必填）+ `dimensions`（可选复查角度）+ `context` + `fixed_issues`
（可选，需要验证的修复清单 JSON）。输出分级复查报告 + `passed`。

## 配置（可选）


| Key                                                                                                | 默认           | 说明                                        |
| -------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------- |
| `subagentProvider`                                                                                 | 引擎默认 `spawn` | 子代理 provider                              |
| `maxTotalAgents`                                                                                   | 引擎上限         | 整次运行子代理总数上限                               |
| `plannerModel` / `workerModel` / `checkerModel` / `reviewerModel` / `mergerModel` / `redteamModel` | 继承父配置        | 角色级模型分层（规划/实现/检查/复查/汇总/红队建议用不同模型，异源对抗更有效） |


## 设计说明

- **plugin ≠ skill**：不注册进 `ctx.skills`；触发靠工具描述（找茬/审计/体检/交付/复查等）。
- **复用官方能力**：编排走官方 workflow 引擎；检查/实现/审查代理复用内置工具
（bash/fs/glob/…）检查真实产物。
- **简单优先**：用直白的"检查/问题/修复"语言，不堆砌术语；技能的价值在于激活正确的行为。
但对抗式、根因验证、反馈校验是硬要求，简化的是表达不是机制。
- **不碰 TUI**；取消传播（`exec.signal` 传入 workflow）；单点失败只在该处标注。

