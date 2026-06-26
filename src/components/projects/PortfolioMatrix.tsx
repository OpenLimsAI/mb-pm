import { Link } from 'react-router-dom'
import type { Project } from '../../types'
import { stages } from '../../mock/dictionaries'
import { findUser } from '../../mock'
import { Card, CardHeader, CardBody, HealthTag, Tag } from '../ui'
import { cn } from '../../lib/cn'

const healthBg: Record<Project['health'], string> = {
  green: 'bg-emerald-50 hover:bg-emerald-100 border-emerald-200',
  yellow: 'bg-amber-50 hover:bg-amber-100 border-amber-200',
  red: 'bg-red-50 hover:bg-red-100 border-red-200',
}

export function PortfolioMatrix({ projects }: { projects: Project[] }) {
  // 行 = 项目；列 = 阶段。每个 cell 显示该项目当前阶段所在位置 + 进度。
  return (
    <Card>
      <CardHeader
        title="项目组合矩阵"
        subtitle="行 = 项目，列 = 阶段；项目当前所处阶段以彩色卡片标记"
      />
      <CardBody className="p-0 overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-ink-100 text-xs uppercase tracking-wider text-ink-700">
              <th className="text-left px-4 py-2 sticky left-0 bg-ink-100 z-10 min-w-[260px]">项目</th>
              {stages.map((s) => (
                <th key={s} className="text-center px-2 py-2 min-w-[110px]">{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => {
              const owner = findUser(p.ownerId)
              const currentIdx = stages.indexOf(p.currentStage)
              const targetIdx = stages.indexOf(p.targetStage)
              return (
                <tr key={p.id} className="border-t border-ink-300/40">
                  {/* 项目列 */}
                  <td className="px-4 py-3 sticky left-0 bg-white z-10 align-top">
                    <Link to={`/projects/${p.id}`} className="block hover:text-brand-600">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-mono text-ink-500">{p.code}</span>
                        <HealthTag health={p.health} />
                      </div>
                      <div className="text-sm font-medium" title={p.name}>{p.name}</div>
                      <div className="text-[11px] text-ink-500 mt-0.5">
                        {owner?.displayName} · {p.productType}
                      </div>
                    </Link>
                  </td>
                  {/* 阶段列 */}
                  {stages.map((s, i) => {
                    const isCurrent = i === currentIdx
                    const isPassed = i < currentIdx
                    const isTarget = i === targetIdx
                    const isInRange = i >= currentIdx && i <= targetIdx
                    return (
                      <td key={s} className="px-1.5 py-2 align-middle text-center">
                        {isCurrent ? (
                          <Link
                            to={`/projects/${p.id}`}
                            className={cn(
                              'block rounded-md p-2 border transition-colors',
                              healthBg[p.health]
                            )}
                            title={`当前阶段：${s}`}
                          >
                            <div className="text-[10px] text-ink-500 mb-0.5">当前</div>
                            <div className="text-sm font-semibold leading-none">{p.progress}%</div>
                            {isTarget && <div className="text-[10px] text-ink-500 mt-1">= 目标</div>}
                          </Link>
                        ) : isPassed ? (
                          <div className="h-12 flex items-center justify-center text-emerald-600">
                            <CheckMark />
                          </div>
                        ) : isInRange ? (
                          <div className="h-12 flex items-center justify-center">
                            <div className={cn(
                              'h-1 w-full rounded-full',
                              isTarget ? 'bg-brand-300' : 'bg-ink-300'
                            )} />
                            {isTarget && <Tag tone="blue" className="absolute mt-6 text-[10px]">目标</Tag>}
                          </div>
                        ) : (
                          <div className="h-12" />
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </CardBody>
    </Card>
  )
}

function CheckMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="6" fill="currentColor" opacity="0.15" />
      <path d="M4 7l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
