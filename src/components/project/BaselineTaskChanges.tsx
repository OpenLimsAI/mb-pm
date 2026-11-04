import { taskDependencies, findProject } from '../../mock'
import type { Task } from '../../types'
import { fullPlanDifferences, type FullPlanSnapshot } from '../../lib/fullPlanBaseline'
import { getWorkingCalendar } from '../../lib/workingCalendar'
import type { WorkingCalendar } from '../../api/planning'

export function BaselineTaskChanges({ snapshot, currentTasks, projectId }: { snapshot: FullPlanSnapshot; currentTasks: Task[]; projectId: string }) {
  if (!snapshot.tasks) return <p className="text-xs text-amber-800 bg-amber-50 p-3 rounded">此历史基线只保存了项目汇总和里程碑。新设立的基线会保存全部任务、前置依赖与工作日历。</p>
  const ids = new Set(currentTasks.map(task => task.id))
  const rows = fullPlanDifferences(snapshot, currentTasks, taskDependencies.filter(edge => ids.has(edge.predecessorId) && ids.has(edge.successorId)))
  const currentCalendar = getWorkingCalendar(projectId)
  const method = findProject(projectId)?.progressMethod ?? 'equal'
  const methodNames = { equal: '任务等权', effort: '预计工时加权', custom: '自定义权重' }
  const calendarChanges = (['weekdays', 'holidays', 'workingDates'] as const).filter(key => snapshot.calendar && JSON.stringify(snapshot.calendar[key]) !== JSON.stringify(currentCalendar[key]))
  const calendarValue = (calendar: WorkingCalendar, key: 'weekdays' | 'holidays' | 'workingDates') => key === 'weekdays' ? calendar.weekdays.map(day => `周${['一', '二', '三', '四', '五', '六', '日'][day - 1]}`).join('、') : (calendar[key].join('、') || '无')
  return <section className="space-y-2"><h3 className="text-sm font-medium">完整计划差异 · {rows.length} 项任务变化</h3>
    {!snapshot.progressMethod && <p className="text-xs text-ink-500">此历史基线未保存进度计算规则与权重；新基线会记录，不推断历史值。</p>}
    {snapshot.progressMethod && snapshot.progressMethod !== method && <p className="text-xs text-amber-800 bg-amber-50 p-3 rounded">进度计算规则：{methodNames[snapshot.progressMethod]} → {methodNames[method]}</p>}
    {!!calendarChanges.length && snapshot.calendar && <div className="text-xs text-amber-800 bg-amber-50 p-3 rounded"><p className="font-medium mb-1">工作日历变化</p>{calendarChanges.map(key => <p key={key}>{({ weekdays: '工作周', holidays: '节假日', workingDates: '例外工作日' })[key]}：{calendarValue(snapshot.calendar!, key)} → {calendarValue(currentCalendar, key)}</p>)}</div>}
    {!rows.length ? <p className="text-xs text-ink-500">全部任务计划、负责人、工时、预算及依赖与基线一致。</p> : <div className="max-h-96 overflow-auto rounded border divide-y">{rows.map(row => <div className="p-3 text-xs" key={row.id}>
      <div className="font-medium flex gap-2"><span className="text-brand-700">{row.kind}</span><span title={row.name}>{row.name}</span></div>
      <ul className="mt-1 space-y-1 text-ink-600">{row.changes.map((change, i) => <li className="break-words" key={i}>{change}</li>)}</ul>
    </div>)}</div>}
  </section>
}
