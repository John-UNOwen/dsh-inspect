// Browser half: dsh-inspect's settings form on the dsh Plugins page.
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory returning cordis-plugin exports), so there is no build step.
// The values are the host half's volatile Config fields: dsh's settings
// service validates each save against that schema and writes it to the
// profile's cordis.patch.yml, and the next checkup / fix / review call uses it.
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-inspect',
  factory: (require) => {
    var module = { exports: {} }

    // The Plugins page keys a bundle's configuration by npm package name.
    var PACKAGE_NAME = '@dsh-external/dsh-inspect'
    // The profile entry id the bundle patch inserts; the settings namespace.
    var ENTRY_ID = 'dsh-inspect'
    var NS = 'dshInspect'
    var LEVELS = ['critical', 'major', 'minor']
    var FIX_ROUNDS_MAX = 20

    var en = {
      summary: 'Red-team reach, fix rounds, run limits and per-role models for checkup, fix and review.',
      redteamTitle: 'Red team',
      redteamIntro:
        'After checkup or review merges its findings, one attacker per claim tries to disprove it with tools. Refuted claims are removed; unproven ones are marked unverified.',
      minLevel: 'Claims to attack',
      levelCritical: 'Critical only',
      levelMajor: 'Critical + major',
      levelMinor: 'Every claim',
      minLevelHint: 'Every claim includes minor ones. Each attacked claim is one more sub-agent.',
      maxClaims: 'Most claims attacked per run',
      maxClaimsHint:
        '0 = no limit. Criticals are always attacked, even over the limit; the rest go in order of level until the limit.',
      fixTitle: 'Fix',
      fixRounds: 'Fix rounds',
      fixRoundsHint: 'Implement-and-check rounds before fix stops and returns what is left (1–20).',
      runsTitle: 'Runs',
      maxTotal: 'Sub-agents per run',
      maxTotalHint:
        "Most sub-agents one checkup, fix or review run may start. Empty = the workflow engine's ceiling. Keep it at or below that ceiling (1000 unless workflow-ptc's maxTotalAgents is raised), or every run fails to start.",
      provider: 'Sub-agent provider',
      providerHint: 'Empty = the workflow engine default.',
      modelsTitle: 'Models',
      modelsIntro:
        'A model per role; empty inherits the calling agent\'s model. A red-team model different from the checker model gives a more independent attack.',
      checkerModel: 'Checkers',
      checkerModelHint: 'checkup checkers and the fix checker.',
      reviewerModel: 'Reviewers',
      reviewerModelHint: 'review reviewers and fix verifiers.',
      mergerModel: 'Merger',
      mergerModelHint: 'Merges and deduplicates findings.',
      redteamModel: 'Red team',
      redteamModelHint: 'The attackers.',
      plannerModel: 'Planner',
      plannerModelHint: 'Breaks a fix task into steps.',
      workerModel: 'Implementers',
      workerModelHint: 'Carry out each fix step.',
      invalidNonNegative: 'Enter a whole number of 0 or more.',
      invalidPositive: 'Enter a whole number of 1 or more.',
      invalidRounds: 'Enter a whole number from 1 to 20.',
      overridden: 'Changed',
      reset: 'Reset',
      unavailable: 'dsh-inspect is not running in the current profile.',
      readOnly: 'Settings are read-only in this deployment.',
      saveFailed: 'The save was not accepted.',
      save: 'Save',
      saving: 'Saving…',
    }

    var zh = {
      summary: '为 checkup、fix、review 设置红队范围、修复轮数、运行上限和各角色模型。',
      redteamTitle: '红队',
      redteamIntro: 'checkup 或 review 合并问题后，每个问题由一个攻击者用工具尝试推翻。被推翻的删除，无法证实的标为 unverified。',
      minLevel: '攻击哪些问题',
      levelCritical: '仅严重',
      levelMajor: '严重 + 一般',
      levelMinor: '全部问题',
      minLevelHint: '“全部问题”包括建议级。每攻击一个问题就多一个子代理。',
      maxClaims: '每次最多攻击的问题数',
      maxClaimsHint: '0 = 不限。严重问题总会被攻击（可超过上限）；其余按级别依次攻击直到上限。',
      fixTitle: '修复',
      fixRounds: '修复轮数',
      fixRoundsHint: 'fix 停止并返回剩余问题前的“实现 + 检查”轮数（1–20）。',
      runsTitle: '运行',
      maxTotal: '每次运行的子代理数',
      maxTotalHint:
        '一次 checkup、fix 或 review 最多启动的子代理数。留空 = 工作流引擎上限。不能超过该上限（默认 1000，除非调高 workflow-ptc 的 maxTotalAgents），否则每次运行都无法启动。',
      provider: '子代理 provider',
      providerHint: '留空 = 工作流引擎默认。',
      modelsTitle: '模型',
      modelsIntro: '为每个角色指定模型；留空则继承调用方的模型。红队用与检查员不同的模型，攻击更独立。',
      checkerModel: '检查员',
      checkerModelHint: 'checkup 检查员和 fix 检查员。',
      reviewerModel: '复查员',
      reviewerModelHint: 'review 复查员和修复验证员。',
      mergerModel: '汇总',
      mergerModelHint: '合并去重问题。',
      redteamModel: '红队',
      redteamModelHint: '攻击者。',
      plannerModel: '规划',
      plannerModelHint: '把修复任务拆成步骤。',
      workerModel: '实现员',
      workerModelHint: '执行每个修复步骤。',
      invalidNonNegative: '请输入 0 或更大的整数。',
      invalidPositive: '请输入 1 或更大的整数。',
      invalidRounds: '请输入 1 到 20 的整数。',
      overridden: '已修改',
      reset: '重置',
      unavailable: '当前 profile 未运行 dsh-inspect。',
      readOnly: '此部署的设置为只读。',
      saveFailed: '保存未被接受。',
      save: '保存',
      saving: '保存中…',
    }

    /** A whole-number field between minimum and maximum; empty clears it. */
    function integerField(field, minimum, maximum) {
      return {
        field: field,
        format: (value) => (typeof value === 'number' ? String(value) : ''),
        parse: (text) => {
          var trimmed = text.trim()
          if (trimmed === '') return { kind: 'clear' }
          if (!/^\d+$/.test(trimmed)) return undefined
          var value = Number(trimmed)
          return Number.isSafeInteger(value) && value >= minimum && value <= maximum
            ? { kind: 'set', value: value }
            : undefined
        },
      }
    }

    /** A free-text field; empty (or only spaces) clears it, so the setting inherits. */
    function textField(field) {
      return {
        field: field,
        format: (value) => (typeof value === 'string' ? value : ''),
        parse: (text) => (text.trim() === '' ? { kind: 'clear' } : { kind: 'set', value: text.trim() }),
      }
    }

    /** A field that takes one of a fixed set of strings. */
    function choiceField(field, choices) {
      return {
        field: field,
        format: (value) => (typeof value === 'string' ? value : ''),
        parse: (text) =>
          text === '' ? { kind: 'clear' } : choices.includes(text) ? { kind: 'set', value: text } : undefined,
      }
    }

    var MODEL_FIELDS = ['checkerModel', 'reviewerModel', 'mergerModel', 'redteamModel', 'plannerModel', 'workerModel']

    function createCard(react, ui, store, actions) {
      var h = react.createElement
      var section = { padding: '16px 0', display: 'grid', gap: '12px', minWidth: 0 }
      var heading = {
        margin: 0,
        fontSize: '13px',
        fontWeight: 600,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-primary)',
      }
      var label = { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' }
      var hint = { margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' }
      var row = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '16px' }
      var link = {
        background: 'none',
        border: 0,
        padding: 0,
        cursor: 'pointer',
        fontSize: '12px',
        color: 'var(--dsw-alias-brand-primary)',
      }

      return function DshInspectCard(props) {
        var t = props.t
        var state = react.useSyncExternalStore(store.subscribe, store.getSnapshot)
        if (props.view === 'summary') return t('summary')
        var disabled = !state.writable || state.saving

        function valueField(field, invalidKey, numeric) {
          return h(
            ui.SettingsValueField,
            Object.assign(
              {
                id: 'plugin-config-dsh-inspect-' + field,
                label: t(field),
                hint: t(field + 'Hint'),
                overriddenLabel: t('overridden'),
                resetLabel: t('reset'),
                invalidLabel: t(invalidKey || 'invalidPositive'),
                numeric: numeric,
                disabled: disabled,
              },
              state[field],
              {
                onEdit: (text) => actions.edit(field, text),
                onReset: () => actions.resetField(field),
              },
            ),
          )
        }

        function modelField(field) {
          return h(
            ui.SettingsValueField,
            Object.assign(
              {
                id: 'plugin-config-dsh-inspect-' + field,
                label: t(field),
                hint: t(field + 'Hint'),
                overriddenLabel: t('overridden'),
                resetLabel: t('reset'),
                invalidLabel: '',
                disabled: disabled,
              },
              state[field],
              {
                onEdit: (text) => actions.edit(field, text),
                onReset: () => actions.resetField(field),
              },
            ),
          )
        }

        var level = LEVELS.includes(state.redteamMinLevel.text) ? state.redteamMinLevel.text : 'major'

        return h(
          ui.SettingsForm,
          {
            labels: {
              unavailable: t('unavailable'),
              readOnly: t('readOnly'),
              saveFailed: t('saveFailed'),
              save: t('save'),
              saving: t('saving'),
            },
            state: state,
            onSave: actions.save,
            onDiscard: actions.discard,
          },
          h(
            'section',
            { style: section },
            h('h3', { style: heading }, t('redteamTitle')),
            h('p', { style: hint }, t('redteamIntro')),
            h(
              'div',
              { style: row },
              h('span', { style: label }, t('minLevel')),
              state.redteamMinLevel.overridden
                ? h(
                    'button',
                    {
                      type: 'button',
                      style: link,
                      disabled: disabled,
                      onClick: () => actions.resetField('redteamMinLevel'),
                    },
                    t('reset'),
                  )
                : null,
            ),
            h(ui.SegmentedControl, {
              id: 'plugin-config-dsh-inspect-redteamMinLevel',
              label: t('minLevel'),
              value: level,
              disabled: disabled,
              options: [
                { value: 'critical', label: t('levelCritical') },
                { value: 'major', label: t('levelMajor') },
                { value: 'minor', label: t('levelMinor') },
              ],
              onChange: (next) => actions.edit('redteamMinLevel', next),
            }),
            h('p', { style: hint }, t('minLevelHint')),
            valueField('maxClaims', 'invalidNonNegative', true),
          ),
          h(
            'section',
            { style: section },
            h('h3', { style: heading }, t('fixTitle')),
            valueField('fixRounds', 'invalidRounds', true),
          ),
          h(
            'section',
            { style: section },
            h('h3', { style: heading }, t('runsTitle')),
            valueField('maxTotal', 'invalidPositive', true),
            modelField('provider'),
          ),
          h(
            'section',
            { style: section },
            h('h3', { style: heading }, t('modelsTitle')),
            h('p', { style: hint }, t('modelsIntro')),
            MODEL_FIELDS.map((field) => h(react.Fragment, { key: field }, modelField(field))),
          ),
        )
      }
    }

    function apply(ctx) {
      var react = require('react')
      var ui = require('@deepseek-ai/dsh-client-ui-primitives')
      ctx.effect(() => ctx.locale.register(NS, { en: en, zh: zh }), 'dsh-inspect: dictionaries')

      // Each form field id is the Config key; the card addresses a few by a
      // shorter name (maxClaims → redteamMaxClaims, …) through FIELD_KEYS below.
      var specs = [
        choiceField('redteamMinLevel', LEVELS),
        integerField('redteamMaxClaims', 0, Number.MAX_SAFE_INTEGER),
        integerField('fixMaxRounds', 1, FIX_ROUNDS_MAX),
        integerField('maxTotalAgents', 1, Number.MAX_SAFE_INTEGER),
        textField('subagentProvider'),
      ].concat(MODEL_FIELDS.map(textField))
      var form = new ui.SettingsFormModel(ctx.configForms.get(ENTRY_ID), specs)
      var store = form.bind(() => {
        var shell = form.shell()
        var fields = {}
        for (var key in FIELD_KEYS) fields[key] = form.field(FIELD_KEYS[key])
        return Object.assign(shell, fields)
      })
      ctx.effect(() => () => form.dispose(), 'dsh-inspect: form subscription')
      var raw = form.actions()
      // Card names → Config keys for the actions too.
      var actions = Object.assign({}, raw, {
        edit: (field, text) => raw.edit(FIELD_KEYS[field] || field, text),
        resetField: (field) => raw.resetField(FIELD_KEYS[field] || field),
      })
      var Card = createCard(react, ui, store, actions)

      // Registered only while the Host serves the entry, so a profile that
      // switched the bundle off shows no form.
      ctx.effect(
        () =>
          ctx.configForms.whileServed([ENTRY_ID], () =>
            ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE_NAME, locale: NS }, Card),
            ),
          ),
        'dsh-inspect: settings page',
      )
    }

    /** Card field name → Config key. */
    var FIELD_KEYS = {
      redteamMinLevel: 'redteamMinLevel',
      maxClaims: 'redteamMaxClaims',
      fixRounds: 'fixMaxRounds',
      maxTotal: 'maxTotalAgents',
      provider: 'subagentProvider',
      checkerModel: 'checkerModel',
      reviewerModel: 'reviewerModel',
      mergerModel: 'mergerModel',
      redteamModel: 'redteamModel',
      plannerModel: 'plannerModel',
      workerModel: 'workerModel',
    }

    module.exports.apply = apply
    module.exports.inject = ['slots', 'locale', 'configForms']
    // Exposed for this repo's tests only; not part of the plugin contract.
    module.exports.__fields = { integerField: integerField, textField: textField, choiceField: choiceField, FIELD_KEYS: FIELD_KEYS }
    return module.exports
  },
})
