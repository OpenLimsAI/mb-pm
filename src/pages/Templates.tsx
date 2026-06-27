// 模板 —— 研发流程标准模板目录（CTO 视角）
//
// 模板封装了「一条药物研发流程所需的全部项目信息」：三级 WBS（子项目→任务）、
// 默认工期/工时、依赖、里程碑、关键路径，以及 CTD 章节 / 监管依据 / 成本预算 / 输出物。
// 创建新项目时即一键实例化为完整任务树。

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FileText, FileDown, Eye, Diamond, ListTree, ArrowRight, Plus, Trash2, Loader2, ArrowLeft } from 'lucide-react'
import { findUser, projects } from '../mock'
import type { Template } from '../types'
import { Card, CardBody, Button, Tag, Avatar, EmptyState } from '../components/ui'
import { computeStats, exportTemplateAsExcel, downloadBlob } from '../lib/template'
import { useTemplatesStore } from '../store/templates'
import { useDataStore } from '../store/data'
import { useAuth } from '../store/auth'
import { can } from '../lib/permissions'
import { deleteTemplateEntry } from '../data/bootstrap'
import { CreateTemplateDialog } from '../components/template/CreateTemplateDialog'

export default function Templates() {
  const navigate = useNavigate()
  // 订阅数据版本：删除模板（API 刷新）后列表与「在用项目数」同步刷新
  useDataStore((s) => s.version)
  const templates = useTemplatesStore((s) => s.templates)
  const role = useAuth((s) => s.currentUser?.role)
  const canManage = can(role, 'template.edit')
  const [createOpen, setCreateOpen] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const handleExport = (t: Template) => {
    const v = t.versions.find((vv) => vv.isCurrent)
    if (!v) return
    const blob = exportTemplateAsExcel(t, v)
    downloadBlob(blob, `${t.name}_${v.versionNumber}_${new Date().toISOString().slice(0, 10)}.csv`)
  }

  const del = async (id: string) => {
    setDeletingId(id)
    setDeleteError(null)
    try {
      await deleteTemplateEntry(id)
      setConfirmId(null)
    } catch (e) {
      console.error('删除模板失败:', e)
      setDeleteError(e instanceof Error ? `删除失败：${e.message}` : '删除失败，请确认后端已启动后重试。')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="p-6 max-w-[1600px] mx-auto">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <button
            onClick={() => navigate('/projects')}
            className="inline-flex items-center gap-1 text-xs text-ink-500 hover:text-brand-700 mb-1.5"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> 返回项目列表
          </button>
          <h1 className="text-2xl font-semibold text-ink-900">研发流程模板</h1>
          <p className="text-sm text-ink-500 mt-1">
            标准化封装一条药物研发流程的全部项目信息 —— 三级 WBS、默认工期/工时、依赖、里程碑、关键路径，
            含 CTD 章节 / 监管依据 / 成本预算。创建项目时一键实例化为完整任务树。
          </p>
        </div>
        {canManage && (
          <Button variant="primary" icon={<Plus className="w-4 h-4" />} onClick={() => setCreateOpen(true)} className="shrink-0">
            创建模板
          </Button>
        )}
      </div>

      {/* 模板列表 */}
      {templates.length === 0 ? (
        <Card><EmptyState title="暂无模板" /></Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {templates.map((t) => {
            const v = t.versions.find((vv) => vv.isCurrent)!
            const stats = computeStats(v.structureJson)
            const author = findUser(v.modifiedBy)
            return (
              <Card key={t.id} className="overflow-hidden flex flex-col">
                <div className="px-5 py-3 bg-gradient-to-r from-brand-50/60 to-transparent border-b border-ink-300/40 flex items-start gap-3">
                  <div className="w-10 h-10 rounded-md bg-brand-600 text-white flex items-center justify-center shrink-0">
                    <FileText className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                      <h3 className="text-base font-semibold text-ink-900">{t.name}</h3>
                      <Tag tone="blue">{t.currentVersion}</Tag>
                      <Tag tone="gray">{t.productType}</Tag>
                      {!t.isActive && <Tag tone="red">已停用</Tag>}
                    </div>
                    <p className="text-xs text-ink-500 line-clamp-2">{t.description}</p>
                  </div>
                  {canManage && (
                    <button
                      onClick={() => { setConfirmId(t.id); setDeleteError(null) }}
                      title="删除模板"
                      className="shrink-0 p-1.5 rounded-md text-ink-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>

                <CardBody className="flex-1 flex flex-col">
                  {/* 统计 */}
                  <div className="grid grid-cols-4 gap-2 mb-4 text-center">
                    <Stat label="子项目" value={stats.subProjects} />
                    <Stat label="任务" value={stats.tasks} />
                    <Stat label="里程碑" value={stats.milestones} icon={<Diamond className="w-3 h-3" />} />
                    <Stat label="总工时" value={`${stats.totalEffort}d`} />
                  </div>

                  {/* 最近版本信息 */}
                  <div className="flex items-center gap-3 text-xs text-ink-500 mb-4 pb-4 border-b border-ink-300/40">
                    {author && <Avatar user={author} size="sm" />}
                    <div className="flex-1">
                      <div className="text-ink-700">维护人：{author?.displayName || '—'}</div>
                      <div className="text-[11px]">
                        {v.modifiedAt.slice(0, 10)} · 共 {t.versions.length} 个版本 ·
                        {v.changeSource === 'visual_edit' ? ' 在线编辑' : ' Excel 导入'}
                      </div>
                    </div>
                  </div>

                  {/* 操作按钮 / 删除确认 */}
                  {confirmId === t.id ? (
                    <div className="mt-auto rounded-md border border-red-200 bg-red-50/60 p-3">
                      <div className="text-xs text-red-700">
                        确认删除模板「{t.name}」及其全部版本？此操作不可撤销。
                      </div>
                      {projects.filter((p) => p.templateId === t.id).length > 0 && (
                        <div className="text-[11px] text-amber-700 mt-1">
                          {projects.filter((p) => p.templateId === t.id).length} 个项目正在引用此模板 —— 删除仅断开关联，不影响已创建项目。
                        </div>
                      )}
                      {deleteError && <div className="text-xs text-red-700 mt-1.5">{deleteError}</div>}
                      <div className="flex items-center justify-end gap-2 mt-2.5">
                        <Button variant="ghost" size="sm" disabled={deletingId === t.id} onClick={() => { setConfirmId(null); setDeleteError(null) }}>取消</Button>
                        <Button
                          variant="danger" size="sm" disabled={deletingId === t.id}
                          icon={deletingId === t.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                          onClick={() => del(t.id)}
                        >
                          {deletingId === t.id ? '删除中…' : '确认删除'}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-2 mt-auto">
                      <Button variant="primary" size="sm" icon={<ListTree className="w-3.5 h-3.5" />}
                              onClick={() => navigate(`/templates/${t.id}`)}>
                        查看详情
                      </Button>
                      <Button variant="secondary" size="sm" icon={<Eye className="w-3.5 h-3.5" />}
                              onClick={() => navigate(`/templates/${t.id}/preview`)}>
                        甘特图预览
                      </Button>
                      <Button variant="ghost" size="sm" icon={<FileDown className="w-3.5 h-3.5" />}
                              onClick={() => handleExport(t)}>
                        导出 Excel
                      </Button>
                    </div>
                  )}
                </CardBody>
              </Card>
            )
          })}
        </div>
      )}

      {/* CTA：用模板创建项目 */}
      <Card className="mt-4 bg-gradient-to-r from-brand-50 to-transparent border-brand-200">
        <CardBody className="flex items-center justify-between gap-4">
          <div className="text-sm text-ink-700">
            选定流程模板后，可在「项目」模块一键实例化为完整三级任务树并纳入组合管理。
          </div>
          <Button variant="primary" icon={<ArrowRight className="w-4 h-4" />} onClick={() => navigate('/projects/new')}>
            用模板创建项目
          </Button>
        </CardBody>
      </Card>

      {createOpen && <CreateTemplateDialog onClose={() => setCreateOpen(false)} />}
    </div>
  )
}

function Stat({ label, value, icon }: { label: string; value: number | string; icon?: React.ReactNode }) {
  return (
    <div className="bg-ink-100/60 rounded-md py-2">
      <div className="text-base font-semibold text-ink-900 leading-none">{value}</div>
      <div className="text-[10px] text-ink-500 mt-1 flex items-center justify-center gap-1">
        {icon}{label}
      </div>
    </div>
  )
}
