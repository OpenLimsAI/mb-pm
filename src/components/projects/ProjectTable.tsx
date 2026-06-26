import { Link } from 'react-router-dom'
import type { Project } from '../../types'
import { Table, THead, TR, TH, TD, EmptyRow, HealthTag, Tag, Avatar, Card } from '../ui'
import { findUser } from '../../mock'
import { getProjectSummary } from '../../lib/analytics'
import { cn } from '../../lib/cn'

export function ProjectTable({ projects }: { projects: Project[] }) {
  return (
    <Card>
      <Table>
        <THead>
          <TR>
            <TH>编号</TH>
            <TH>项目名称</TH>
            <TH>产品 / 阶段</TH>
            <TH>负责人</TH>
            <TH className="text-right">总任务</TH>
            <TH className="text-right">已完成</TH>
            <TH className="text-right">延迟</TH>
            <TH className="w-[180px]">总进度</TH>
            <TH>健康度</TH>
            <TH>状态</TH>
            <TH>计划完成</TH>
          </TR>
        </THead>
        <tbody>
          {projects.length === 0 ? (
            <EmptyRow colSpan={11} message="没有匹配的项目" />
          ) : (
            projects.map((p) => {
              const s = getProjectSummary(p)
              const owner = findUser(p.ownerId)
              return (
                <TR key={p.id}>
                  <TD className="font-mono text-xs text-ink-500">{p.code}</TD>
                  <TD>
                    <Link to={`/projects/${p.id}`} className="font-medium text-ink-900 hover:text-brand-600">
                      {p.name}
                    </Link>
                  </TD>
                  <TD>
                    <div className="flex flex-wrap gap-1">
                      <Tag tone="gray">{p.productType}</Tag>
                      <Tag tone="blue">{p.currentStage}</Tag>
                    </div>
                  </TD>
                  <TD>
                    <div className="flex items-center gap-2">
                      {owner && <Avatar user={owner} size="sm" />}
                      <span className="text-xs">{owner?.displayName}</span>
                    </div>
                  </TD>
                  <TD className="text-right text-xs font-mono">{s.taskCount}</TD>
                  <TD className="text-right text-xs font-mono text-emerald-600">{s.doneCount}</TD>
                  <TD className="text-right text-xs font-mono">
                    {s.delayedCount > 0 ? <span className="text-red-600">{s.delayedCount}</span> : '0'}
                  </TD>
                  <TD>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 bg-ink-100 rounded overflow-hidden min-w-[80px]">
                        <div
                          className={cn(
                            'h-full',
                            p.health === 'red' && 'bg-red-500',
                            p.health === 'yellow' && 'bg-amber-500',
                            p.health === 'green' && 'bg-emerald-500'
                          )}
                          style={{ width: `${p.progress}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono w-9 text-right">{p.progress}%</span>
                    </div>
                  </TD>
                  <TD><HealthTag health={p.health} /></TD>
                  <TD>
                    <Tag tone={p.status === '活跃' ? 'green' : 'gray'}>{p.status}</Tag>
                  </TD>
                  <TD className="text-xs text-ink-500">{p.plannedEnd}</TD>
                </TR>
              )
            })
          )}
        </tbody>
      </Table>
    </Card>
  )
}
