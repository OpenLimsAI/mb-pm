// 任务属性在线编辑面板（FR-TE-002）
// 11 个字段：任务名称 / 所属阶段 / 所属模块 / 默认工期 / 默认预估工时 /
//            前置任务 / 依赖类型 / 延迟天数 / 是否里程碑 / 默认负责角色 / 备注

import { useState } from 'react'
import { Diamond, Trash2, Plus, FolderTree } from 'lucide-react'
import type { TemplateNode, DependencyType, Stage, Module, SpecialtyGroup } from '../../types'
import { stages, modules, specialtyGroups } from '../../mock/dictionaries'
import { Card, CardHeader, CardBody, Tag } from '../ui'
import { findNode } from '../../lib/template'

interface Props {
  root: TemplateNode
  selectedId: string | undefined
  onChange: (nodeId: string, patch: Partial<TemplateNode>) => void
  onAddPredecessor: (nodeId: string, taskCode: string) => void
  onRemovePredecessor: (nodeId: string, taskCode: string) => void
  onUpdatePredecessor: (nodeId: string, taskCode: string, patch: { type?: DependencyType; lagDays?: number }) => void
}

export function PropertyPanel({
  root, selectedId, onChange, onAddPredecessor, onRemovePredecessor, onUpdatePredecessor,
}: Props) {
  const node = selectedId ? findNode(root, selectedId) : undefined
  const isRoot = node?.id === root.id

  if (!node || isRoot) {
    return (
      <Card className="h-full flex flex-col">
        <CardHeader title="属性面板" subtitle="选中左侧的子项目或任务以编辑" />
        <div className="flex-1 flex items-center justify-center p-8 text-center text-sm text-ink-500">
          <div>
            <FolderTree className="w-10 h-10 mx-auto mb-2 text-ink-300" />
            <p>请在左侧选择节点</p>
            <p className="text-[11px] mt-1">支持双击节点 / 单击节点</p>
          </div>
        </div>
      </Card>
    )
  }

  const isSubProject = root.children?.some((c) => c.id === node.id) || false
  const isTask = !isSubProject

  return (
    <Card className="h-full flex flex-col overflow-hidden">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {isSubProject ? (
              <Tag tone="purple">Lv2 子项目</Tag>
            ) : (
              <Tag tone="green">Lv3 任务</Tag>
            )}
            <span>属性面板</span>
          </span>
        }
        subtitle={`所有变更在保存前可撤销 · ${node.taskCode || node.id.slice(0, 6)}`}
      />
      <CardBody className="overflow-y-auto flex-1">
        <div className="space-y-4">
          <Field label={isSubProject ? '子项目名称' : '任务名称'} required>
            <input
              className="input"
              value={node.name}
              onChange={(e) => onChange(node.id, { name: e.target.value })}
            />
          </Field>

          {isTask && (
            <Field label="任务编号">
              <input
                className="input font-mono"
                value={node.taskCode || ''}
                onChange={(e) => onChange(node.id, { taskCode: e.target.value })}
                placeholder="如：T001"
              />
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="所属阶段">
              <select
                className="input"
                value={node.stage || ''}
                onChange={(e) => onChange(node.id, { stage: e.target.value as Stage })}
              >
                <option value="">— 选择 —</option>
                {stages.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="所属模块">
              <select
                className="input"
                value={node.module || ''}
                onChange={(e) => onChange(node.id, { module: e.target.value as Module })}
              >
                <option value="">— 选择 —</option>
                {modules.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
          </div>

          {isTask && (
            <>
              {/* 是否里程碑 */}
              <Field label="是否里程碑" hint="里程碑不占工期，作为关键节点标识">
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!node.isMilestone}
                    onChange={(e) => onChange(node.id, { isMilestone: e.target.checked, ...(e.target.checked ? { defaultDuration: 0, defaultEffort: 0 } : {}) })}
                    className="w-4 h-4 accent-brand-600"
                  />
                  <span className="text-sm flex items-center gap-1">
                    <Diamond className="w-3.5 h-3.5 text-amber-600" />
                    标记为里程碑
                  </span>
                </label>
              </Field>

              {!node.isMilestone && (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="默认工期 (天)">
                    <input
                      type="number"
                      className="input"
                      value={node.defaultDuration ?? ''}
                      onChange={(e) => onChange(node.id, { defaultDuration: parseInt(e.target.value || '0', 10) })}
                    />
                  </Field>
                  <Field label="默认预估工时 (人天)" hint="用于人员负荷计算">
                    <input
                      type="number"
                      step="0.5"
                      className="input"
                      value={node.defaultEffort ?? ''}
                      onChange={(e) => onChange(node.id, { defaultEffort: parseFloat(e.target.value || '0') })}
                    />
                  </Field>
                </div>
              )}

              <Field label="默认负责角色" hint="便于人员推荐匹配">
                <select
                  className="input"
                  value={node.defaultRole || ''}
                  onChange={(e) => onChange(node.id, { defaultRole: e.target.value as SpecialtyGroup })}
                >
                  <option value="">— 不指定 —</option>
                  {specialtyGroups.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </Field>

              {/* 前置任务 */}
              <PredecessorEditor
                root={root}
                node={node}
                onAddPredecessor={onAddPredecessor}
                onRemovePredecessor={onRemovePredecessor}
                onUpdatePredecessor={onUpdatePredecessor}
              />
            </>
          )}

          <Field label="备注 / 操作要点">
            <textarea
              className="input min-h-[80px]"
              value={node.notes || ''}
              onChange={(e) => onChange(node.id, { notes: e.target.value })}
              placeholder="对该节点的标准操作说明、注意事项等"
            />
          </Field>

          {isTask && <DMPFieldsSection node={node} onChange={onChange} />}
        </div>
      </CardBody>
    </Card>
  )
}

// ============= DMP v3.6 扩展字段 =============

function DMPFieldsSection({
  node,
  onChange,
}: {
  node: TemplateNode
  onChange: (nodeId: string, patch: Partial<TemplateNode>) => void
}) {
  // 当任意一个 DMP 字段有值时默认展开；否则折叠以避免界面噪音
  const hasAnyDMPField = !!(
    node.ctdSection || node.description || node.output ||
    node.regulatoryRef || node.costBudget || node.collaborators?.length ||
    node.milestoneLabel || node.isCriticalPath
  )
  const [open, setOpen] = useState(hasAnyDMPField)

  return (
    <div className="border-t border-ink-300/40 pt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-xs font-medium text-ink-700 hover:text-ink-900 mb-2"
      >
        <span className="flex items-center gap-1.5">
          <Tag tone="blue">DMP v3.6</Tag>
          扩展信息
          {hasAnyDMPField && <span className="text-[10px] text-ink-500">（含数据）</span>}
        </span>
        <span className="text-[10px] text-ink-500">{open ? '收起' : '展开'}</span>
      </button>

      {open && (
        <div className="space-y-3">
          <Field label="任务描述" hint="任务输出 / 方法 / 范围">
            <textarea
              className="input min-h-[60px]"
              value={node.description || ''}
              onChange={(e) => onChange(node.id, { description: e.target.value })}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="CTD 章节" hint="对齐 ICH M4Q（治理性活动用 —）">
              <input
                className="input font-mono"
                value={node.ctdSection || ''}
                onChange={(e) => onChange(node.id, { ctdSection: e.target.value })}
                placeholder="如：3.2.S.2.6"
              />
            </Field>
            <Field label="成本预算 (万元)">
              <input
                type="number"
                className="input"
                value={node.costBudget ?? ''}
                onChange={(e) => onChange(node.id, { costBudget: parseFloat(e.target.value || '0') || undefined })}
              />
            </Field>
          </div>

          <Field label="输出物">
            <input
              className="input"
              value={node.output || ''}
              onChange={(e) => onChange(node.id, { output: e.target.value })}
              placeholder="如：Media screening report"
            />
          </Field>

          <Field label="监管依据">
            <input
              className="input"
              value={node.regulatoryRef || ''}
              onChange={(e) => onChange(node.id, { regulatoryRef: e.target.value })}
              placeholder="如：ICH Q11; FDA Process Validation Guidance 2011"
            />
          </Field>

          <Field label="协作部门" hint="多个用英文逗号分隔（如 AS, QC）">
            <input
              className="input"
              value={(node.collaborators || []).join(', ')}
              onChange={(e) => {
                const v = e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
                onChange(node.id, { collaborators: v.length ? v : undefined })
              }}
              placeholder="如：AS, QC"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="里程碑文字">
              <input
                className="input"
                value={node.milestoneLabel || ''}
                onChange={(e) => onChange(node.id, { milestoneLabel: e.target.value })}
                placeholder="如：上游工艺定型"
                disabled={!node.isMilestone}
              />
            </Field>
            <Field label="关键路径" hint="DMP W 列 ★ 标识">
              <label className="inline-flex items-center gap-2 cursor-pointer mt-1.5">
                <input
                  type="checkbox"
                  checked={!!node.isCriticalPath}
                  onChange={(e) => onChange(node.id, { isCriticalPath: e.target.checked || undefined })}
                  className="w-4 h-4 accent-red-600"
                />
                <span className="text-sm text-red-700">★ 关键路径</span>
              </label>
            </Field>
          </div>
        </div>
      )}
    </div>
  )
}

function PredecessorEditor({
  root, node, onAddPredecessor, onRemovePredecessor, onUpdatePredecessor,
}: {
  root: TemplateNode
  node: TemplateNode
  onAddPredecessor: (id: string, taskCode: string) => void
  onRemovePredecessor: (id: string, taskCode: string) => void
  onUpdatePredecessor: (id: string, taskCode: string, patch: { type?: DependencyType; lagDays?: number }) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)

  // 列出所有可作为前置的任务（同模板内 + 排除自己）
  const candidates: { taskCode: string; name: string; subName: string }[] = []
  root.children?.forEach((sub) => {
    sub.children?.forEach((t) => {
      if (t.id === node.id) return
      if (!t.taskCode) return
      // 不能选已经是前置的
      if (node.predecessors?.some((p) => p.taskCode === t.taskCode)) return
      candidates.push({ taskCode: t.taskCode, name: t.name, subName: sub.name })
    })
  })

  return (
    <Field label="前置任务（依赖关系）" hint="支持 FS / SS / FF / SF + 延迟天数">
      <div className="space-y-1.5">
        {(node.predecessors || []).map((p) => (
          <div key={p.taskCode} className="flex items-center gap-1.5 px-2 py-1.5 bg-ink-100 rounded-md">
            <span className="font-mono text-[10px] text-ink-700">{p.taskCode}</span>
            <select
              value={p.type}
              onChange={(e) => onUpdatePredecessor(node.id, p.taskCode, { type: e.target.value as DependencyType })}
              className="bg-white border border-ink-300 rounded px-1.5 py-0.5 text-xs"
            >
              <option value="FS">FS (完→开)</option>
              <option value="SS">SS (开→开)</option>
              <option value="FF">FF (完→完)</option>
              <option value="SF">SF (开→完)</option>
            </select>
            <input
              type="number"
              value={p.lagDays}
              onChange={(e) => onUpdatePredecessor(node.id, p.taskCode, { lagDays: parseInt(e.target.value || '0', 10) })}
              className="w-14 px-1.5 py-0.5 text-xs border border-ink-300 rounded bg-white"
              title="延迟天数"
            />
            <span className="text-[10px] text-ink-500">天</span>
            <button
              onClick={() => onRemovePredecessor(node.id, p.taskCode)}
              className="ml-auto p-0.5 rounded hover:bg-red-50 text-red-500"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        ))}

        {pickerOpen ? (
          <div className="border border-ink-300 rounded-md max-h-40 overflow-y-auto bg-white">
            {candidates.length === 0 ? (
              <div className="text-center py-3 text-xs text-ink-500">没有可选的任务</div>
            ) : (
              candidates.map((c) => (
                <button
                  key={c.taskCode}
                  onClick={() => { onAddPredecessor(node.id, c.taskCode); setPickerOpen(false) }}
                  className="w-full text-left px-2 py-1.5 hover:bg-brand-50 text-xs flex items-center gap-2"
                >
                  <span className="font-mono text-ink-500">{c.taskCode}</span>
                  <span className="flex-1 truncate">{c.name}</span>
                  <span className="text-ink-500 text-[10px]">{c.subName}</span>
                </button>
              ))
            )}
            <button
              onClick={() => setPickerOpen(false)}
              className="w-full text-center py-1 text-xs text-ink-500 hover:bg-ink-100 border-t border-ink-300/40"
            >
              取消
            </button>
          </div>
        ) : (
          <button
            onClick={() => setPickerOpen(true)}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-brand-700 hover:bg-brand-50 rounded"
            disabled={candidates.length === 0}
          >
            <Plus className="w-3.5 h-3.5" /> 添加前置任务
          </button>
        )}
      </div>
    </Field>
  )
}

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-ink-700 mb-1">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
      {hint && <p className="text-[11px] text-ink-500 mt-0.5">{hint}</p>}
    </div>
  )
}

