// 项目编辑页与财务页共用预算字段；本组件只维护草稿，不直接保存。
import { Coins } from 'lucide-react'
import { Field } from '../ui'
import { FINANCE_CATEGORIES } from '../../mock/finance'
import { financeDraftState, formatFinance as fmt, type FinanceDraft } from '../../lib/financeDraft'

export function FinanceFields({ draft, onChange, spent, taskBudget, disabled = false, showRequiredError = true }: {
  draft: FinanceDraft
  onChange: (draft: FinanceDraft) => void
  spent: number
  taskBudget: number
  disabled?: boolean
  showRequiredError?: boolean
}) {
  const { total, committed, parts, partsInvalid, partsTotal, totalMissing, remaining } = financeDraftState(draft, spent)
  const set = (patch: Partial<FinanceDraft>) => onChange({ ...draft, ...patch })
  return (
    <fieldset disabled={disabled} className="space-y-5 min-w-0">
      <div className="grid sm:grid-cols-2 gap-4">
        <Field label="项目总预算（万元）" error={totalMissing && showRequiredError ? '请填写总预算' : total === null ? '请输入 0–99,999,999 之间的金额' : null}>
          <input className="input tabular-nums" inputMode="decimal" aria-label="项目总预算（万元）" value={draft.totalBudget} onChange={(e) => set({ totalBudget: e.target.value })} />
        </Field>
        <Field label="已承诺（万元）" hint="已签合同 / 已下单、尚未支付的金额" error={committed === null ? '请输入 0–99,999,999 之间的金额' : null}>
          <input className="input tabular-nums" inputMode="decimal" aria-label="已承诺（万元）" value={draft.committed} onChange={(e) => set({ committed: e.target.value })} placeholder="0" />
        </Field>
      </div>

      <div className="rounded-lg bg-ink-100/70 p-3 text-sm grid sm:grid-cols-3 gap-3">
        <div>
          <div className="text-xs text-ink-500">已花费（自动）</div>
          <div className="font-semibold text-ink-900 tabular-nums">{fmt(spent)}</div>
          <div className="text-[11px] text-ink-500 mt-0.5">任务实际花费合计</div>
        </div>
        <div>
          <div className="text-xs text-ink-500 flex items-center gap-1"><Coins className="w-3 h-3 text-amber-500" />任务预算合计</div>
          <div className="font-semibold text-ink-900 tabular-nums">{fmt(taskBudget)}</div>
          {taskBudget > 0 && total !== taskBudget && (
            <button type="button" className="text-[11px] text-brand-700 hover:underline mt-0.5" onClick={() => set({ totalBudget: String(taskBudget) })}>填入为总预算</button>
          )}
        </div>
        <div>
          <div className="text-xs text-ink-500">剩余（保存后）</div>
          <div className={`font-semibold tabular-nums ${remaining < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{total === null || committed === null ? '—' : fmt(remaining)}</div>
          <div className="text-[11px] text-ink-500 mt-0.5">总预算 − 已花费 − 已承诺</div>
        </div>
      </div>
      <p className="text-[11px] text-ink-500 -mt-2">任务成本只含外包、耗材、CRO 等，不含内部人力；总预算口径建议与之一致，便于对比执行率。</p>

      <div>
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-sm font-medium text-ink-900">成本结构（可选，手工填报）</span>
          <span className="text-xs text-ink-500 tabular-nums">合计 {fmt(partsTotal)}</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {FINANCE_CATEGORIES.map((c) => (
            <label key={c} className="text-xs text-ink-600 space-y-1">
              <span>{c}</span>
              <input
                className={`input tabular-nums ${parts[c] === null ? 'border-red-400' : ''}`}
                inputMode="decimal"
                aria-label={`成本结构：${c}（万元）`}
                value={draft.breakdown[c] ?? ''}
                placeholder="0"
                onChange={(e) => set({ breakdown: { ...draft.breakdown, [c]: e.target.value } })}
              />
            </label>
          ))}
        </div>
        {partsInvalid && <p className="text-xs text-red-600 mt-1">请输入 0–99,999,999 之间的金额</p>}
      </div>

      <div className="grid sm:grid-cols-[160px_1fr] gap-4">
        <Field label="财年" error={draft.fiscalYear.trim().length > 20 ? '最多 20 个字符' : null}>
          <input className="input" aria-label="财年" value={draft.fiscalYear} onChange={(e) => set({ fiscalYear: e.target.value })} placeholder="如 2026-2028" maxLength={20} />
        </Field>
        <Field label="备注" error={draft.notes.trim().length > 200 ? '最多 200 个字符' : null}>
          <input className="input" aria-label="预算备注" value={draft.notes} onChange={(e) => set({ notes: e.target.value })} maxLength={200} />
        </Field>
      </div>
    </fieldset>
  )
}
