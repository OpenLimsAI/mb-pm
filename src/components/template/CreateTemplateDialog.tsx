// 创建研发流程模板对话框。
//
// 两种起步方式：
//   · 空白：生成仅含根节点的空模板（之后可导出格式 / Excel 导入补充结构）。
//   · 复制现有模板：深拷贝来源模板当前版本的结构作为起点（立即得到可用的完整 WBS）。
// 写入走 data/bootstrap.createTemplateEntry（API：POST /templates + 重新同步；离线 mock：写模板 store）。

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, FileText, Loader2, FilePlus2, Copy, Diamond, AlertTriangle } from 'lucide-react'
import type { ProductType, TemplateNode } from '../../types'
import { Button, Tag } from '../ui'
import { productTypes } from '../../mock'
import { useTemplatesStore } from '../../store/templates'
import { useDataStore } from '../../store/data'
import { createTemplateEntry } from '../../data/bootstrap'
import { computeStats } from '../../lib/template'
import { cn } from '../../lib/cn'

type StartMode = 'blank' | 'clone'

export function CreateTemplateDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const mode = useDataStore((s) => s.mode)
  const templates = useTemplatesStore((s) => s.templates)

  const [name, setName] = useState('')
  const [productType, setProductType] = useState<ProductType>('单抗')
  const [description, setDescription] = useState('')
  const [startMode, setStartMode] = useState<StartMode>(templates.length > 0 ? 'clone' : 'blank')
  const [sourceId, setSourceId] = useState(templates[0]?.id ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const source = templates.find((t) => t.id === sourceId)
  const sourceVersion = source?.versions.find((v) => v.isCurrent)
  const sourceStats = useMemo(
    () => (sourceVersion ? computeStats(sourceVersion.structureJson) : null),
    [sourceVersion],
  )

  const nameInvalid = !name.trim()
  const canCreate = !nameInvalid && (startMode === 'blank' || !!sourceVersion)

  const buildStructure = (): TemplateNode => {
    if (startMode === 'clone' && sourceVersion) {
      const cloned = JSON.parse(JSON.stringify(sourceVersion.structureJson)) as TemplateNode
      cloned.name = name.trim() // 根节点名同步为新模板名
      return cloned
    }
    return { id: 'root', name: name.trim() || '新模板', children: [] }
  }

  const create = async () => {
    if (!canCreate) {
      setError(nameInvalid ? '请填写模板名称。' : '请选择要复制的来源模板。')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const id = await createTemplateEntry({
        name: name.trim(),
        productType,
        description: description.trim(),
        initialStructure: buildStructure(),
      })
      onClose()
      // 空白模板直接进入结构编辑器（否则是一张空详情页）；复制模板已有完整结构 → 详情页
      navigate(startMode === 'blank' ? `/templates/${id}/edit` : `/templates/${id}`)
    } catch (e) {
      console.error(e)
      setError('创建失败，请确认后端已启动后重试。')
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-[560px] max-h-[90vh] bg-white rounded-xl shadow-2xl overflow-y-auto flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-ink-300/40 sticky top-0 bg-white">
          <div className="w-8 h-8 rounded-md bg-brand-600 text-white flex items-center justify-center">
            <FileText className="w-4 h-4" />
          </div>
          <h2 className="text-lg font-semibold text-ink-900 flex-1">创建研发流程模板</h2>
          {mode === 'mock' && (
            <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
              离线模式 · 不持久化
            </span>
          )}
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-ink-100 text-ink-500" aria-label="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          <label className="block">
            <span className="text-[11px] text-ink-500">模板名称 <span className="text-red-500">*</span></span>
            <input
              className={cn('input mt-1', nameInvalid && 'border-red-400')}
              value={name} onChange={(e) => setName(e.target.value)}
              placeholder="如：双特异性抗体工艺开发模板"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] text-ink-500">产品类型</span>
              <select className="input mt-1" value={productType} onChange={(e) => setProductType(e.target.value as ProductType)}>
                {productTypes.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="text-[11px] text-ink-500">描述</span>
            <textarea
              className="input mt-1 min-h-[56px] resize-y" value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="一句话说明此流程模板的适用范围（可选）"
            />
          </label>

          {/* 起步方式 */}
          <div>
            <span className="text-[11px] text-ink-500 uppercase tracking-wider">起步方式</span>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <StartOption
                active={startMode === 'clone'} onClick={() => setStartMode('clone')}
                disabled={templates.length === 0}
                icon={<Copy className="w-4 h-4" />} title="复制现有模板"
                desc="深拷贝来源结构作为起点，立即可用"
              />
              <StartOption
                active={startMode === 'blank'} onClick={() => setStartMode('blank')}
                icon={<FilePlus2 className="w-4 h-4" />} title="空白起步"
                desc="仅含根节点，之后通过 Excel 导入补充"
              />
            </div>

            {startMode === 'clone' && (
              <div className="mt-2.5">
                <select className="input" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}（{t.currentVersion}）</option>)}
                </select>
                {sourceStats && (
                  <div className="mt-2 flex items-center gap-3 text-[11px] text-ink-500">
                    <Tag tone="gray">{sourceStats.subProjects} 子项目</Tag>
                    <Tag tone="gray">{sourceStats.tasks} 任务</Tag>
                    <span className="inline-flex items-center gap-1"><Diamond className="w-3 h-3 text-amber-600" />{sourceStats.milestones} 里程碑</span>
                    <span>将完整复制为新模板的 V1.0</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {error && (
            <div className="text-xs text-red-600 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />{error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-ink-300/40 sticky bottom-0 bg-white flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" disabled={saving} onClick={onClose}>取消</Button>
          <Button
            variant="primary" size="sm"
            icon={saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />}
            disabled={saving || !canCreate}
            onClick={create}
          >
            {saving ? '创建中…' : '创建模板'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function StartOption({ active, disabled, icon, title, desc, onClick }: {
  active: boolean
  disabled?: boolean
  icon: React.ReactNode
  title: string
  desc: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'text-left p-3 rounded-lg border transition-colors',
        disabled ? 'opacity-40 cursor-not-allowed border-ink-300' :
        active ? 'border-brand-500 bg-brand-50/60 ring-1 ring-brand-200' : 'border-ink-300 hover:bg-ink-100/60',
      )}
    >
      <div className={cn('flex items-center gap-1.5 text-sm font-medium', active ? 'text-brand-700' : 'text-ink-800')}>
        {icon}{title}
      </div>
      <p className="text-[11px] text-ink-500 mt-1">{desc}</p>
    </button>
  )
}
