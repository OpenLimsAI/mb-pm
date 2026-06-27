// 首页 —— CTO 项目组合总览（进展 + 风险一屏掌控）
//
// 四段式：
//   §1 组合 KPI —— 在研项目 / 总进度 / 待达里程碑 / 风险项 / 关键路径 / 预算执行
//   §2 风险预警 —— 逾期·临期里程碑 + 延迟/阻塞任务（跨全部项目聚合）
//   §3 项目健康度 —— 红/黄/绿 分组卡片，每卡展示最近里程碑倒计时
//   §4 组合预算 —— 预算执行 + 成本结构 + 超支项目
//
// 数据：直接读 mock 运行时数组（已含用户新建项目），CTO 视角全量可见。

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  FolderKanban, TrendingUp, Diamond, AlertTriangle, Flame, Wallet,
  AlertOctagon, BadgeCheck, ArrowRight, CheckCircle2, ShieldAlert, Clock, Users,
} from 'lucide-react'
import { differenceInCalendarDays, parseISO } from 'date-fns'
import {
  projects, tasks, subProjects, findUser, TODAY, users, calcWorkload,
  summarizeFinances, projectFinances, executionRate, isOverBudget,
} from '../mock'
import { roleLabels } from '../lib/permissions'
import { useAuth } from '../store/auth'
import { useDataStore } from '../store/data'
import { analyzePortfolioRisk, type RiskItem, type QualitySourceStatus } from '../lib/risk'
import type { Health, Project, Task } from '../types'
import { Card, CardHeader, CardBody, Tag, Avatar, HealthTag } from '../components/ui'
import { cn } from '../lib/cn'

// 与 mock 数据共用同一「今日」锚点，保证状态/进度/风险判定确定且自洽。
const today = TODAY
const todayStr = today.toISOString().slice(0, 10)

const isDone = (t: Task) => t.status === '已完成' || t.status === '已验证'

export default function Home() {
  const user = useAuth((s) => s.currentUser)
  // 订阅数据版本号：创建/进展录入后回到首页即反映最新数据
  const version = useDataStore((s) => s.version)

  const data = useMemo(() => {
    const active = projects.filter((p) => p.status === '活跃')
    const byId = new Map(active.map((p) => [p.id, p]))

    // 在 memo 内重建「子项目→项目」映射：随 version 变化纳入新建项目
    // （模块级 Map 在启动期 hydrate 之前就已固化，会漏掉新建项目的任务）。
    const subToProject = new Map(subProjects.map((s) => [s.id, s.projectId]))
    const projectOf = (t: Task): string | undefined => subToProject.get(t.subProjectId)

    const greens = active.filter((p) => p.health === 'green').length
    const yellows = active.filter((p) => p.health === 'yellow').length
    const reds = active.filter((p) => p.health === 'red').length
    const avgProgress = active.length
      ? Math.round(active.reduce((s, p) => s + p.progress, 0) / active.length)
      : 0

    const activeTasks = tasks.filter((t) => {
      const pid = projectOf(t)
      return pid && byId.has(pid)
    })

    const incompleteMilestones = activeTasks.filter((t) => t.isMilestone && !isDone(t))
    const criticalActive = activeTasks.filter((t) => t.isCriticalPath && !isDone(t))

    // —— 风险聚合：进度族 + 质量族（口径与注入点见 lib/risk.ts）——
    const risk = analyzePortfolioRisk({ activeProjects: active, activeTasks, projectOf, byId, today })

    // —— 预算 —— //
    const activeIds = active.map((p) => p.id)
    const finance = summarizeFinances(activeIds)
    const overBudget = projectFinances
      .filter((f) => activeIds.includes(f.projectId) && isOverBudget(f))
      .map((f) => ({ f, project: byId.get(f.projectId), rate: executionRate(f) }))
      .sort((a, b) => b.rate - a.rate)

    // —— 健康度分组 —— //
    const buckets: Record<Health, Project[]> = { red: [], yellow: [], green: [] }
    active.forEach((p) => buckets[p.health].push(p))
    buckets.red.sort((a, b) => a.progress - b.progress)
    buckets.yellow.sort((a, b) => a.progress - b.progress)
    buckets.green.sort((a, b) => b.progress - a.progress)

    const riskCount = risk.totalCount

    // —— 组织 —— //
    const activeUsers = users.filter((u) => u.isActive !== false)
    const inactiveCount = users.length - activeUsers.length
    const bySpecialty = new Map<string, number>()
    activeUsers.forEach((u) => {
      const g = u.specialtyGroup || '未分组'
      bySpecialty.set(g, (bySpecialty.get(g) ?? 0) + 1)
    })
    const specialties = [...bySpecialty.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
    const overloaded = activeUsers.filter((u) => calcWorkload(u.id).rate > 90).length
    const org = { total: activeUsers.length, inactiveCount, specialties, overloaded }

    return {
      active, greens, yellows, reds, avgProgress,
      milestoneCount: incompleteMilestones.length,
      criticalCount: criticalActive.length,
      risk, riskCount,
      finance, overBudget, buckets, org,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-6">
      {/* 顶部欢迎条 */}
      <div>
        <h1 className="text-2xl font-semibold text-ink-900">项目组合总览</h1>
        <p className="text-sm text-ink-500 mt-1">
          {user.displayName}（{roleLabels[user.role]}），今日 {todayStr} —— 全部 {data.active.length} 个在研项目的进展与风险一屏掌控。
        </p>
      </div>

      {/* §1 KPI */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi tone="blue" icon={<FolderKanban className="w-5 h-5" />} label="在研项目" value={data.active.length}
             sub={`${data.greens} 绿 / ${data.yellows} 黄 / ${data.reds} 红`} />
        <Kpi tone="indigo" icon={<TrendingUp className="w-5 h-5" />} label="组合总进度" value={`${data.avgProgress}%`}
             sub="活跃项目平均" />
        <Kpi tone="amber" icon={<Diamond className="w-5 h-5" />} label="待达成里程碑" value={data.milestoneCount} />
        <Kpi tone={data.riskCount > 0 ? 'red' : 'emerald'} icon={<ShieldAlert className="w-5 h-5" />}
             label="风险项" value={data.riskCount} sub={data.riskCount > 0 ? '需关注' : '组合健康'} pulse={data.riskCount > 4} />
        <Kpi tone="rose" icon={<Flame className="w-5 h-5" />} label="关键路径任务" value={data.criticalCount} />
        <Kpi tone={data.overBudget.length > 0 ? 'red' : 'emerald'} icon={<Wallet className="w-5 h-5" />}
             label="预算执行率" value={`${data.finance.executionRate}%`}
             sub={data.overBudget.length > 0 ? `${data.overBudget.length} 超支` : '健康'} />
      </div>

      {/* §2 风险预警 —— 进度族 + 质量族 */}
      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-amber-600" />风险预警</span>}
          subtitle="跨全部在研项目聚合 —— 进度风险 + 质量与合规风险"
          action={
            <span className="flex items-center gap-1.5">
              <Tag tone={data.risk.scheduleCount > 0 ? 'red' : 'green'}>进度 {data.risk.scheduleCount}</Tag>
              <Tag tone={data.risk.qualityCount > 0 ? 'red' : 'green'}>质量 {data.risk.qualityCount}</Tag>
            </span>
          }
        />
        <CardBody>
          {data.riskCount === 0 ? (
            <div className="flex items-center gap-2 text-sm text-emerald-700 py-4 justify-center">
              <CheckCircle2 className="w-5 h-5" /> 组合当前无进度风险，亦无质量门风险，整体按计划推进。
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-5">
              {/* 进度风险 */}
              <RiskFamily
                icon={<Clock className="w-3.5 h-3.5" />}
                title="进度风险" count={data.risk.scheduleCount}
                items={data.risk.schedule} emptyText="无进度风险，里程碑与任务按计划推进。"
              />

              {/* 质量与合规风险 */}
              <div>
                <RiskFamily
                  icon={<ShieldAlert className="w-3.5 h-3.5" />}
                  title="质量与合规风险" count={data.risk.qualityCount}
                  items={data.risk.quality} emptyText="当前无质量门里程碑逾期/临期。"
                />
                <QualitySources sources={data.risk.qualitySources} />
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      {/* §3 项目健康度 */}
      <Card>
        <CardHeader
          title="项目健康度"
          subtitle="按红 / 黄 / 绿分组 —— 每个项目展示最近的关键里程碑"
          action={<Link to="/projects" className="text-sm text-brand-600 hover:text-brand-700 flex items-center gap-1">进入项目列表 <ArrowRight className="w-3.5 h-3.5" /></Link>}
        />
        <CardBody className="space-y-5">
          <HealthBucket label="风险 — 立即关注" health="red" icon={<AlertOctagon className="w-4 h-4" />}
                        projects={data.buckets.red} emptyMsg="✓ 当前没有红色项目" />
          <HealthBucket label="关注 — 监控中" health="yellow" icon={<AlertTriangle className="w-4 h-4" />}
                        projects={data.buckets.yellow} emptyMsg="✓ 当前没有黄色项目" />
          <HealthBucket label="健康 — 按计划" health="green" icon={<BadgeCheck className="w-4 h-4" />}
                        projects={data.buckets.green} emptyMsg="—" />
        </CardBody>
      </Card>

      {/* §4 财务总览 + 组织总览 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <FinanceOverview finance={data.finance} overBudgetCount={data.overBudget.length} />
        <OrgOverview org={data.org} />
      </div>

    </div>
  )
}

// ============= 风险族 =============

function RiskFamily({ icon, title, count, items, emptyText }: {
  icon: React.ReactNode; title: string; count: number; items: RiskItem[]; emptyText: string
}) {
  const shown = items.slice(0, 8)
  const more = items.length - shown.length
  return (
    <div>
      <div className="text-xs font-medium text-ink-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
        {icon} {title}（{count}）
      </div>
      {items.length === 0 ? (
        <div className="text-sm text-ink-500 italic py-2">{emptyText}</div>
      ) : (
        <ul className="space-y-1.5">
          {shown.map((it) => <RiskRow key={it.id} item={it} />)}
          {more > 0 && <li className="text-[11px] text-ink-400 pl-2.5">还有 {more} 项…</li>}
        </ul>
      )}
    </div>
  )
}

const riskSevColor: Record<RiskItem['severity'], string> = {
  high: 'text-red-600', medium: 'text-amber-600', low: 'text-ink-500',
}

function RiskRow({ item }: { item: RiskItem }) {
  const owner = item.ownerId ? findUser(item.ownerId) : undefined
  const isMilestoneKind = item.kind.startsWith('milestone') || item.kind.startsWith('quality-gate')
  const Icon = item.family === 'quality' ? ShieldAlert : isMilestoneKind ? Diamond : Clock
  return (
    <li>
      <Link to={`/projects/${item.projectId}`}
            className="flex items-center gap-2 px-2.5 py-2 rounded-md hover:bg-ink-100 transition-colors">
        <Icon className={cn('w-3.5 h-3.5 shrink-0', riskSevColor[item.severity])} />
        <span className="text-xs font-mono text-ink-500 shrink-0">{item.projectCode}</span>
        <span className={cn('text-sm truncate flex-1', item.isCriticalPath && 'font-semibold')}>{item.title}</span>
        {item.isCriticalPath && <Flame className="w-3.5 h-3.5 text-rose-500 shrink-0" />}
        {owner && <Avatar user={owner} size="sm" />}
        <span className={cn('text-xs font-medium shrink-0 tabular-nums', riskSevColor[item.severity])}>{item.detail}</span>
      </Link>
    </li>
  )
}

/** 质量风险数据源状态：已接入(质量门里程碑) + 待接入占位(偏差/CAPA/批次)。 */
function QualitySources({ sources }: { sources: QualitySourceStatus[] }) {
  return (
    <div className="mt-3 pt-3 border-t border-ink-300/40">
      <div className="text-[10px] text-ink-400 uppercase tracking-wider mb-1.5">质量风险数据源</div>
      <div className="flex flex-wrap gap-1.5">
        {sources.map((s) => (
          <span key={s.key}
            title={s.note}
            className={cn('inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border',
              s.connected ? 'bg-white border-ink-300 text-ink-700' : 'bg-ink-100/50 border-dashed border-ink-300 text-ink-400')}>
            {s.label}
            <b className={cn(s.connected && s.count > 0 ? 'text-red-600' : 'text-ink-500')}>{s.count}</b>
            {!s.connected && <span className="text-[10px]">· 待接入</span>}
          </span>
        ))}
      </div>
    </div>
  )
}

// ============= KPI 卡片 =============

type KpiTone = 'blue' | 'indigo' | 'amber' | 'red' | 'emerald' | 'rose'
const kpiTones: Record<KpiTone, { bg: string; icon: string; text: string }> = {
  blue:    { bg: 'bg-brand-50',   icon: 'bg-brand-100 text-brand-700',   text: 'text-brand-700' },
  indigo:  { bg: 'bg-indigo-50',  icon: 'bg-indigo-100 text-indigo-700', text: 'text-indigo-700' },
  amber:   { bg: 'bg-amber-50',   icon: 'bg-amber-100 text-amber-700',   text: 'text-amber-700' },
  red:     { bg: 'bg-red-50',     icon: 'bg-red-100 text-red-700',       text: 'text-red-700' },
  emerald: { bg: 'bg-emerald-50', icon: 'bg-emerald-100 text-emerald-700', text: 'text-emerald-700' },
  rose:    { bg: 'bg-rose-50',    icon: 'bg-rose-100 text-rose-700',     text: 'text-rose-700' },
}

function Kpi({ label, value, sub, tone, icon, pulse }: {
  label: string; value: React.ReactNode; sub?: string; tone: KpiTone; icon: React.ReactNode; pulse?: boolean
}) {
  const c = kpiTones[tone]
  return (
    <div className={cn('card p-3.5 flex flex-col gap-2', pulse && 'animate-pulse')}>
      <div className={cn('w-9 h-9 rounded-lg flex items-center justify-center', c.icon)}>{icon}</div>
      <div>
        <div className={cn('text-2xl font-semibold leading-none', c.text)}>{value}</div>
        <div className="text-xs text-ink-700 mt-1.5">{label}</div>
        {sub && <div className="text-[11px] text-ink-500 mt-0.5">{sub}</div>}
      </div>
    </div>
  )
}

// ============= 健康度分组 =============

const healthBucketTone: Record<Health, { border: string; iconBg: string; text: string; bar: string }> = {
  red:    { border: 'border-red-200',     iconBg: 'bg-red-100 text-red-700',         text: 'text-red-700',     bar: 'bg-red-500' },
  yellow: { border: 'border-amber-200',   iconBg: 'bg-amber-100 text-amber-700',     text: 'text-amber-700',   bar: 'bg-amber-500' },
  green:  { border: 'border-emerald-200', iconBg: 'bg-emerald-100 text-emerald-700', text: 'text-emerald-700', bar: 'bg-emerald-500' },
}

function HealthBucket({ label, health, projects, icon, emptyMsg }: {
  label: string; health: Health; projects: Project[]; icon: React.ReactNode; emptyMsg: string
}) {
  const c = healthBucketTone[health]
  return (
    <div>
      <div className="flex items-center gap-2 mb-2.5">
        <div className={cn('w-6 h-6 rounded flex items-center justify-center', c.iconBg)}>{icon}</div>
        <span className={cn('text-sm font-medium', c.text)}>{label}</span>
        <Tag tone={health === 'red' ? 'red' : health === 'yellow' ? 'yellow' : 'green'}>{projects.length}</Tag>
      </div>
      {projects.length === 0 ? (
        <div className="text-sm text-ink-500 italic pl-8">{emptyMsg}</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {projects.map((p) => <ProjectCardWithMilestones key={p.id} project={p} bar={c.bar} />)}
        </div>
      )}
    </div>
  )
}

function ProjectCardWithMilestones({ project, bar }: { project: Project; bar: string }) {
  const milestones = useMemo(() => {
    const subIds = new Set(subProjects.filter((s) => s.projectId === project.id).map((s) => s.id))
    return tasks
      .filter((t) => subIds.has(t.subProjectId) && t.isMilestone && !isDone(t))
      .sort((a, b) => a.plannedEnd.localeCompare(b.plannedEnd))
      .slice(0, 3)
  }, [project.id])
  const owner = findUser(project.ownerId)

  return (
    <Link to={`/projects/${project.id}`}
          className={cn('block rounded-lg border bg-white p-3 hover:shadow-card-hover transition-shadow', healthBucketTone[project.health].border)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-mono text-ink-500">{project.code}</span>
        <HealthTag health={project.health} />
      </div>
      <div className="text-sm font-medium text-ink-900 mt-1 line-clamp-1">{project.name}</div>
      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
        <Tag tone="gray">{project.productType}</Tag>
        <Tag tone="blue">{project.currentStage}</Tag>
        <span className="text-[11px] text-ink-500">→ {project.targetStage}</span>
      </div>
      {/* 进度条 */}
      <div className="mt-2.5">
        <div className="flex items-center justify-between text-[11px] text-ink-500 mb-1">
          <span>整体进度</span><span className="font-medium text-ink-700">{project.progress}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-ink-100 overflow-hidden">
          <div className={cn('h-full rounded-full', bar)} style={{ width: `${project.progress}%` }} />
        </div>
      </div>
      {/* 里程碑倒计时 */}
      <div className="mt-2.5 pt-2.5 border-t border-ink-300/40 space-y-1">
        <div className="text-[10px] text-ink-500 uppercase tracking-wider">关键里程碑</div>
        {milestones.length === 0 ? (
          <div className="text-[11px] text-ink-500 italic">暂无未完成里程碑</div>
        ) : milestones.map((m) => {
          const days = differenceInCalendarDays(parseISO(m.plannedEnd), today)
          const overdue = days < 0
          const urgent = !overdue && days <= 14
          return (
            <div key={m.id} className="flex items-center gap-1.5">
              <Diamond className={cn('w-3 h-3 shrink-0', overdue ? 'text-red-600' : urgent ? 'text-amber-600' : 'text-ink-500')} />
              <span className={cn('text-[11px] truncate flex-1', m.isCriticalPath && 'font-semibold')}>{m.name}</span>
              {m.isCriticalPath && <Flame className="w-3 h-3 text-rose-500 shrink-0" />}
              <span className={cn('text-[11px] font-medium shrink-0 tabular-nums',
                overdue ? 'text-red-600' : urgent ? 'text-amber-600' : 'text-ink-500')}>
                {overdue ? `逾期 ${-days}d` : days === 0 ? '今日' : `${days}d`}
              </span>
            </div>
          )
        })}
      </div>
      {/* 负责人 */}
      {owner && (
        <div className="mt-2.5 flex items-center gap-1.5">
          <Avatar user={owner} size="sm" />
          <span className="text-[11px] text-ink-500">{owner.displayName}</span>
        </div>
      )}
    </Link>
  )
}

// ============= 财务总览 / 组织总览 =============

const fmt = (v: number) => `¥${Math.round(v).toLocaleString('zh-CN')}万`

function FinanceOverview({ finance, overBudgetCount }: {
  finance: ReturnType<typeof summarizeFinances>
  overBudgetCount: number
}) {
  const spentPct = finance.totalBudget ? (finance.totalSpent / finance.totalBudget) * 100 : 0
  const commitPct = finance.totalBudget ? (finance.totalCommitted / finance.totalBudget) * 100 : 0
  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2"><Wallet className="w-4 h-4 text-brand-600" />财务总览</span>}
        subtitle="在研项目组合预算执行"
        action={<Link to="/finance" className="text-sm text-brand-600 hover:text-brand-700 flex items-center gap-1">进入财务 <ArrowRight className="w-3.5 h-3.5" /></Link>}
      />
      <CardBody>
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-xs text-ink-500">组合总预算</div>
            <div className="text-2xl font-semibold text-ink-900">{fmt(finance.totalBudget)}</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-ink-500">执行率</div>
            <div className={cn('text-xl font-semibold', overBudgetCount > 0 ? 'text-red-600' : 'text-ink-900')}>{finance.executionRate}%</div>
          </div>
        </div>
        <div className="mt-3 h-2.5 rounded-full bg-ink-100 overflow-hidden flex">
          <div className="h-full bg-brand-600" style={{ width: `${Math.min(100, spentPct)}%` }} title="已花费" />
          <div className="h-full bg-amber-400" style={{ width: `${Math.min(100 - Math.min(100, spentPct), commitPct)}%` }} title="已承诺" />
        </div>
        <div className="flex items-center gap-3 mt-2 text-[11px] text-ink-500 flex-wrap">
          <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm bg-brand-600 inline-block" />已花费 {fmt(finance.totalSpent)}</span>
          <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm bg-amber-400 inline-block" />已承诺 {fmt(finance.totalCommitted)}</span>
          <span className="flex items-center gap-1"><i className="w-2 h-2 rounded-sm bg-emerald-400 inline-block" />剩余 {fmt(finance.remaining)}</span>
          <span className="ml-auto">{overBudgetCount > 0 ? <Tag tone="red">{overBudgetCount} 超支</Tag> : <Tag tone="green">无超支</Tag>}</span>
        </div>
      </CardBody>
    </Card>
  )
}

function OrgOverview({ org }: {
  org: { total: number; inactiveCount: number; specialties: { name: string; count: number }[]; overloaded: number }
}) {
  const maxCount = Math.max(1, ...org.specialties.map((s) => s.count))
  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2"><Users className="w-4 h-4 text-brand-600" />组织总览</span>}
        subtitle="成员与专业组分布"
        action={<Link to="/org" className="text-sm text-brand-600 hover:text-brand-700 flex items-center gap-1">进入组织 <ArrowRight className="w-3.5 h-3.5" /></Link>}
      />
      <CardBody>
        <div className="flex items-center gap-6">
          <div>
            <div className="text-xs text-ink-500">在册成员</div>
            <div className="text-2xl font-semibold text-ink-900">{org.total}<span className="text-sm text-ink-400 font-normal"> 人</span></div>
          </div>
          {org.inactiveCount > 0 && (
            <div>
              <div className="text-xs text-ink-500">停用</div>
              <div className="text-lg font-medium text-ink-500">{org.inactiveCount}</div>
            </div>
          )}
          <div className="ml-auto">
            {org.overloaded > 0 ? <Tag tone="red">{org.overloaded} 人高负荷</Tag> : <Tag tone="green">负荷正常</Tag>}
          </div>
        </div>
        <div className="mt-3">
          <div className="text-xs text-ink-500 mb-1.5">专业组分布</div>
          <div className="space-y-1.5">
            {org.specialties.slice(0, 6).map((s) => (
              <div key={s.name} className="flex items-center gap-2">
                <span className="text-xs text-ink-700 w-16 shrink-0 truncate" title={s.name}>{s.name}</span>
                <div className="flex-1 h-1.5 rounded-full bg-ink-100 overflow-hidden">
                  <div className="h-full bg-brand-500 rounded-full" style={{ width: `${(s.count / maxCount) * 100}%` }} />
                </div>
                <span className="text-[11px] text-ink-500 w-8 text-right shrink-0">{s.count}</span>
              </div>
            ))}
          </div>
        </div>
      </CardBody>
    </Card>
  )
}

